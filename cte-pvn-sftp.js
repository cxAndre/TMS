// etl/cte-pvn-sftp.js
// Coleta o XML fiscal do CT-e que a PVN deposita por SFTP no VPS.
//
// Fluxo INVERTIDO em relação ao Brudam: lá partimos da chave da NF-e e
// perguntamos à API (pull); aqui o arquivo chega sem contexto (push), então
// extraímos as chaves de dentro do próprio XML e descobrimos a linha depois.
//
// Pastas na jaula do usuário pvn (chroot /home/pvn):
//   upload/     → PVN escreve
//   processado/ → gravado no banco com sucesso
//   erro/       → desistimos (ver TTLs abaixo)
'use strict';

const SftpClient = require('ssh2-sftp-client');
const { gravarXmlEmLote } = require('./xml-completo');

// Pasta lida pelo worker. A PVN exporta para /upload e, com a opção "Mover
// arquivos" no painel ESL Cloud, o sistema deles move o XML para a subpasta
// ESL dentro de /upload — é ali que os arquivos ficam. Configurável por env
// caso a PVN mude o destino.
const DIR_UPLOAD     = process.env.PVN_SFTP_DIR || 'upload/ESL';
const DIR_PROCESSADO = 'processado';
const DIR_ERRO       = 'erro';

// Idade mínima antes de tocar no arquivo: filtro barato contra upload em curso.
const IDADE_MIN_MS = parseInt(process.env.PVN_IDADE_MIN_MS || String(5 * 60 * 1000), 10);
// XML truncado/ilegível por mais que isto → erro/ (não vai se consertar sozinho).
const TTL_INVALIDO_MS = parseInt(process.env.PVN_TTL_INVALIDO_MS || String(60 * 60 * 1000), 10);
// CT-e válido cuja NF-e ainda não entrou no monitoramento → segura e tenta de novo.
// Passado o prazo, desiste. O CT-e pode legitimamente chegar antes da NF-e.
const TTL_SEM_LINHA_MS = parseInt(process.env.PVN_TTL_SEM_LINHA_MS || String(24 * 60 * 60 * 1000), 10);
// Teto por execução: uma carga histórica da PVN pode despejar milhares de
// arquivos de uma vez, e o job do Actions tem limite de tempo. Os mais antigos
// vão primeiro; o resto fica para o próximo run (de hora em hora).
const MAX_ARQUIVOS = parseInt(process.env.PVN_MAX_ARQUIVOS || '300', 10);

// ─── VALIDAÇÃO / EXTRAÇÃO ────────────────────────────────────────────────────
// Um XML cortado no meio do upload não tem a tag de fechamento. É verificação
// mais confiável que adivinhar por tempo, e não exige nada da PVN.
function xmlCompleto(xml) {
  return /<\/cteProc>\s*$/.test(xml.trim()) || /<\/CTe>\s*$/.test(xml.trim());
}

function ehCte(xml) {
  return xml.includes('<CTe') || xml.includes('cteProc');
}

// As chaves de NF-e que o CT-e transporta. Um CT-e consolida várias.
// Mesma tag usada em cte-brudam.js.
function extrairChavesNfe(xml) {
  const achadas = xml.match(/<chave>(\d{44})<\/chave>/g) || [];
  return [...new Set(achadas.map(t => t.replace(/\D/g, '')))];
}

// ─── LOOKUP ──────────────────────────────────────────────────────────────────
// gravarXmlEmLote exige empresa_id + filial + chave_nfe, mas do arquivo só sai
// a chave. A mesma NF-e pode existir em mais de uma empresa/filial, então
// devolvemos todas as linhas que casarem.
async function resolverLinhas(supabase, chaves, lote = 100) {
  const linhas = [];
  for (let i = 0; i < chaves.length; i += lote) {
    const { data, error } = await supabase
      .from('tms_monitoramento_entregas')
      .select('empresa_id, filial, chave_nfe')
      .in('chave_nfe', chaves.slice(i, i + lote));
    if (error) throw new Error(`Lookup PVN: ${error.message}`);
    if (data) linhas.push(...data);
  }
  const mapa = new Map(); // chave_nfe -> [{empresa_id, filial}]
  for (const l of linhas) {
    if (!mapa.has(l.chave_nfe)) mapa.set(l.chave_nfe, []);
    mapa.get(l.chave_nfe).push({ empresa_id: l.empresa_id, filial: l.filial });
  }
  return mapa;
}

// ─── MOVIMENTAÇÃO ────────────────────────────────────────────────────────────
// rename do SFTP FALHA se o destino já existir (por isso a lib expõe um
// posixRename à parte). A PVN pode reenviar o mesmo nome — sem tratar, o arquivo
// nunca sai da upload/ e volta a ser processado em todo run, para sempre.
// Preserva os dois: o reenvio ganha sufixo em vez de sobrescrever o original.
async function moverArquivo(sftp, origem, destinoDir, nome, logger) {
  try {
    await sftp.rename(origem, `/${destinoDir}/${nome}`);
    return true;
  } catch {
    const alt = nome.replace(/(\.[^.]*)?$/, `-${Date.now()}$1`);
    try {
      await sftp.rename(origem, `/${destinoDir}/${alt}`);
      logger.info({ nome, renomeado_para: alt }, 'PVN: nome já existia no destino, movido com sufixo');
      return true;
    } catch (err) {
      logger.warn({ nome, destino: destinoDir, err: err.message }, 'PVN: falha ao mover');
      return false;
    }
  }
}

// ─── FLUXO ───────────────────────────────────────────────────────────────────
// O ssh2 rejeita a chave ("Unsupported key format") por detalhes que a viagem
// terminal → área de transferência → secret costuma introduzir: CR do Windows,
// espaço nas pontas, e principalmente a falta da quebra de linha final.
// Aceita também a chave em base64, que imuniza contra mangling de quebra.
function normalizarChave(bruta) {
  let k = bruta.trim();
  if (!k.includes('-----BEGIN')) {
    try {
      const decodificada = Buffer.from(k, 'base64').toString('utf8');
      if (decodificada.includes('-----BEGIN')) k = decodificada.trim();
    } catch { /* não era base64; segue com o valor original */ }
  }
  return k.replace(/\r/g, '') + '\n';
}

// Só a forma da chave, nunca o conteúdo — serve para diagnosticar sem vazar.
function formaDaChave(k) {
  return {
    linhas: k.split('\n').filter(Boolean).length,
    comeca_ok: k.startsWith('-----BEGIN'),
    termina_ok: /-----END [^\n]*-----\n$/.test(k),
    bytes: k.length,
  };
}

function configPvn(logger) {
  const host = process.env.PVN_SFTP_HOST;
  const bruta = process.env.PVN_SFTP_KEY;
  if (!host || !bruta) return null; // etapa opcional: sem config, não roda

  const privateKey = normalizarChave(bruta);
  const forma = formaDaChave(privateKey);
  if (!forma.comeca_ok || !forma.termina_ok || forma.linhas < 3) {
    logger.error(forma, 'PVN: chave malformada — o secret PVN_SFTP_KEY não tem a cara de uma chave OpenSSH');
  } else {
    logger.info(forma, 'PVN: chave carregada');
  }

  return {
    host,
    port: parseInt(process.env.PVN_SFTP_PORT || '22', 10),
    username: process.env.PVN_SFTP_USER || 'pvn',
    privateKey,
    readyTimeout: parseInt(process.env.PVN_SFTP_TIMEOUT || '20000', 10),
  };
}

async function processarPastaPvn(supabase, logger) {
  const cfg = configPvn(logger);
  if (!cfg) { logger.info('PVN: sem PVN_SFTP_HOST/PVN_SFTP_KEY — etapa pulada'); return 0; }

  const sftp = new SftpClient();
  const agora = Date.now();
  let gravados = 0;

  try {
    await sftp.connect(cfg);

    // A subpasta ESL só nasce quando a PVN faz o primeiro envio com "Mover".
    // Antes disso, listar dá erro — tratamos como pasta vazia, sem quebrar.
    if (!(await sftp.exists(`/${DIR_UPLOAD}`))) {
      logger.info({ dir: DIR_UPLOAD }, 'PVN: pasta ainda não existe (sem envios) — etapa sem trabalho');
      return 0;
    }

    const todos = await sftp.list(`/${DIR_UPLOAD}`);
    const xmls = todos.filter(f => f.type === '-' && /\.xml$/i.test(f.name));
    const elegiveis = xmls
      .filter(f => (agora - f.modifyTime) >= IDADE_MIN_MS)
      .sort((a, b) => a.modifyTime - b.modifyTime); // mais antigos primeiro: ninguém fica para trás
    const candidatos = elegiveis.slice(0, MAX_ARQUIVOS);

    // Relógio do VPS adiantado faria idade negativa e nada seria elegível, em
    // silêncio. Melhor gritar do que estagnar sem explicação.
    const futuros = xmls.filter(f => f.modifyTime > agora).length;
    if (futuros) logger.warn({ arquivos: futuros }, 'PVN: arquivos com data no futuro — relógio do VPS fora de sincronia?');

    logger.info({ na_pasta: todos.length, xml: xmls.length, elegiveis: elegiveis.length, nesta_rodada: candidatos.length }, 'PVN: pasta lida');
    if (elegiveis.length > MAX_ARQUIVOS) logger.info({ restam: elegiveis.length - MAX_ARQUIVOS }, 'PVN: teto por execução atingido, resto fica para o próximo run');
    if (!candidatos.length) return 0;

    // 1ª passada: baixa, valida, extrai chaves.
    const arquivos = [];
    for (const f of candidatos) {
      const caminho = `/${DIR_UPLOAD}/${f.name}`;
      let xml;
      try { xml = (await sftp.get(caminho)).toString('utf8'); }
      catch (err) { logger.warn({ arquivo: f.name, err: err.message }, 'PVN: falha ao baixar'); continue; }

      const idade = agora - f.modifyTime;
      if (!ehCte(xml) || !xmlCompleto(xml)) {
        // Provável upload ainda em curso. Só desiste depois do TTL.
        if (idade > TTL_INVALIDO_MS) {
          await moverArquivo(sftp, caminho, DIR_ERRO, f.name, logger);
          logger.warn({ arquivo: f.name }, 'PVN: XML inválido/truncado além do prazo → erro/');
        }
        continue;
      }

      const chaves = extrairChavesNfe(xml);
      if (!chaves.length) {
        await moverArquivo(sftp, caminho, DIR_ERRO, f.name, logger);
        logger.warn({ arquivo: f.name }, 'PVN: CT-e sem chave de NF-e → erro/');
        continue;
      }
      arquivos.push({ nome: f.name, caminho, xml, chaves, idade });
    }
    if (!arquivos.length) return 0;

    // 2ª passada: um único lookup para todas as chaves de todos os arquivos.
    const todasChaves = [...new Set(arquivos.flatMap(a => a.chaves))];
    const mapa = await resolverLinhas(supabase, todasChaves);

    // 3ª passada: monta os itens e grava.
    const itens = [];
    const casados = [];
    for (const a of arquivos) {
      const destinos = a.chaves.flatMap(c => (mapa.get(c) || []).map(d => ({ ...d, chave_nfe: c })));
      if (!destinos.length) {
        // CT-e pode ter chegado antes da NF-e entrar no monitoramento.
        if (a.idade > TTL_SEM_LINHA_MS) {
          await moverArquivo(sftp, a.caminho, DIR_ERRO, a.nome, logger);
          logger.warn({ arquivo: a.nome, chaves: a.chaves.length }, 'PVN: sem linha correspondente além do prazo → erro/');
        }
        continue;
      }
      for (const d of destinos) itens.push({ ...d, xml: a.xml });
      casados.push(a);
    }

    if (itens.length) gravados = await gravarXmlEmLote(supabase, itens, logger);

    // Só sai da upload/ o que realmente casou — o resto reprocessa no próximo run.
    for (const a of casados) await moverArquivo(sftp, a.caminho, DIR_PROCESSADO, a.nome, logger);

    logger.info({ arquivos: casados.length, linhas_gravadas: gravados }, 'PVN: finalizada');
    return gravados;
  } finally {
    await sftp.end().catch(() => {});
  }
}

module.exports = { processarPastaPvn, extrairChavesNfe, xmlCompleto, ehCte, resolverLinhas, normalizarChave, formaDaChave };
