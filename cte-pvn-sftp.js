// etl/cte-pvn-sftp.js
// Coleta o XML fiscal do CT-e que uma transportadora deposita por SFTP no VPS.
// Genérico: serve PVN e QEDB (Quality) — cada fonte tem seu usuário/chave/pasta
// e sua prioridade de precedência (ver CNPJ_PRIORIDADE em xml-completo.js).
//
// Fluxo INVERTIDO em relação ao Brudam: lá partimos da chave da NF-e e
// perguntamos à API (pull); aqui o arquivo chega sem contexto (push), então
// extraímos as chaves de dentro do próprio XML e descobrimos a linha depois.
//
// Pastas na jaula (chroot /home/<user>):
//   upload/upload → transportadora escreve (Raiz + Pasta do painel ESL Cloud)
//   processado/   → gravado no banco com sucesso
//   erro/         → desistimos (ver TTLs abaixo)
'use strict';

const SftpClient = require('ssh2-sftp-client');
const { gravarXmlEmLote } = require('./xml-completo');

const DIR_PROCESSADO = 'processado';
const DIR_ERRO       = 'erro';

// Parâmetros operacionais, compartilhados entre as fontes (mesmos valores).
const IDADE_MIN_MS     = parseInt(process.env.SFTP_IDADE_MIN_MS   || process.env.PVN_IDADE_MIN_MS   || String(5 * 60 * 1000),  10);
const TTL_INVALIDO_MS  = parseInt(process.env.SFTP_TTL_INVALIDO_MS|| process.env.PVN_TTL_INVALIDO_MS|| String(60 * 60 * 1000), 10);
const TTL_SEM_LINHA_MS = parseInt(process.env.SFTP_TTL_SEM_LINHA  || process.env.PVN_TTL_SEM_LINHA_MS|| String(24 * 60 * 60 * 1000), 10);
const MAX_ARQUIVOS     = parseInt(process.env.SFTP_MAX_ARQUIVOS   || process.env.PVN_MAX_ARQUIVOS   || '300', 10);

// Fontes SFTP: env prefix, usuário padrão e CNPJ raiz (marca de precedência).
const FONTES = {
  PVN:  { tag: 'PVN',  envPrefix: 'PVN_SFTP',  userPadrao: 'pvn',  cnpj: '12270745' },
  QEDB: { tag: 'QEDB', envPrefix: 'QEDB_SFTP', userPadrao: 'qedb', cnpj: '26510120' },
};

// ─── VALIDAÇÃO / EXTRAÇÃO ────────────────────────────────────────────────────
function xmlCompleto(xml) {
  return /<\/cteProc>\s*$/.test(xml.trim()) || /<\/CTe>\s*$/.test(xml.trim());
}
function ehCte(xml) {
  return xml.includes('<CTe') || xml.includes('cteProc');
}
// As chaves de NF-e que o CT-e transporta. Um CT-e consolida várias.
function extrairChavesNfe(xml) {
  const achadas = xml.match(/<chave>(\d{44})<\/chave>/g) || [];
  return [...new Set(achadas.map(t => t.replace(/\D/g, '')))];
}

// ─── LOOKUP ──────────────────────────────────────────────────────────────────
// gravarXmlEmLote exige empresa_id + filial + chave_nfe, mas do arquivo só sai
// a chave. A mesma NF-e pode existir em mais de uma empresa/filial.
async function resolverLinhas(supabase, chaves, lote = 100) {
  const linhas = [];
  for (let i = 0; i < chaves.length; i += lote) {
    const { data, error } = await supabase
      .from('tms_monitoramento_entregas')
      .select('empresa_id, filial, chave_nfe')
      .in('chave_nfe', chaves.slice(i, i + lote));
    if (error) throw new Error(`Lookup SFTP: ${error.message}`);
    if (data) linhas.push(...data);
  }
  const mapa = new Map();
  for (const l of linhas) {
    if (!mapa.has(l.chave_nfe)) mapa.set(l.chave_nfe, []);
    mapa.get(l.chave_nfe).push({ empresa_id: l.empresa_id, filial: l.filial });
  }
  return mapa;
}

// ─── MOVIMENTAÇÃO ────────────────────────────────────────────────────────────
// rename do SFTP FALHA se o destino já existir; um reenvio de mesmo nome ficaria
// preso na upload/ para sempre. Preserva os dois: reenvio ganha sufixo.
async function moverArquivo(sftp, origem, destinoDir, nome, logger, tag) {
  try {
    await sftp.rename(origem, `/${destinoDir}/${nome}`);
    return true;
  } catch {
    const alt = nome.replace(/(\.[^.]*)?$/, `-${Date.now()}$1`);
    try {
      await sftp.rename(origem, `/${destinoDir}/${alt}`);
      logger.info({ nome, renomeado_para: alt }, `${tag}: nome já existia no destino, movido com sufixo`);
      return true;
    } catch (err) {
      logger.warn({ nome, destino: destinoDir, err: err.message }, `${tag}: falha ao mover`);
      return false;
    }
  }
}

// ─── CHAVE ───────────────────────────────────────────────────────────────────
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
function formaDaChave(k) {
  return {
    linhas: k.split('\n').filter(Boolean).length,
    comeca_ok: k.startsWith('-----BEGIN'),
    termina_ok: /-----END [^\n]*-----\n$/.test(k),
    bytes: k.length,
  };
}

function montarConfig(fonte, logger) {
  const P = fonte.envPrefix;
  const host = process.env[`${P}_HOST`];
  const bruta = process.env[`${P}_KEY`];
  if (!host || !bruta) return null; // etapa opcional: sem config, não roda

  const privateKey = normalizarChave(bruta);
  const forma = formaDaChave(privateKey);
  if (!forma.comeca_ok || !forma.termina_ok || forma.linhas < 3) {
    logger.error(forma, `${fonte.tag}: chave malformada — o secret ${P}_KEY não tem a cara de uma chave OpenSSH`);
  } else {
    logger.info(forma, `${fonte.tag}: chave carregada`);
  }
  return {
    host,
    port: parseInt(process.env[`${P}_PORT`] || '22', 10),
    username: process.env[`${P}_USER`] || fonte.userPadrao,
    privateKey,
    readyTimeout: parseInt(process.env[`${P}_TIMEOUT`] || '20000', 10),
    // Raiz + Pasta do painel ESL Cloud = /upload/upload. Override por env.
    dir: process.env[`${P}_DIR`] || 'upload/upload',
    cnpj: fonte.cnpj,
    tag: fonte.tag,
  };
}

// ─── FLUXO GENÉRICO ──────────────────────────────────────────────────────────
async function processarPastaSftp(supabase, logger, fonte) {
  const cfg = montarConfig(fonte, logger);
  const tag = fonte.tag;
  if (!cfg) { logger.info(`${tag}: sem ${fonte.envPrefix}_HOST/${fonte.envPrefix}_KEY — etapa pulada`); return 0; }

  const DIR_UPLOAD = cfg.dir;
  const sftp = new SftpClient();
  const agora = Date.now();
  let gravados = 0;

  try {
    await sftp.connect(cfg);

    if (!(await sftp.exists(`/${DIR_UPLOAD}`))) {
      logger.info({ dir: DIR_UPLOAD }, `${tag}: pasta ainda não existe (sem envios) — etapa sem trabalho`);
      return 0;
    }

    const todos = await sftp.list(`/${DIR_UPLOAD}`);
    const xmls = todos.filter(f => f.type === '-' && /\.xml$/i.test(f.name));
    const elegiveis = xmls
      .filter(f => (agora - f.modifyTime) >= IDADE_MIN_MS)
      .sort((a, b) => a.modifyTime - b.modifyTime);
    const candidatos = elegiveis.slice(0, MAX_ARQUIVOS);

    const futuros = xmls.filter(f => f.modifyTime > agora).length;
    if (futuros) logger.warn({ arquivos: futuros }, `${tag}: arquivos com data no futuro — relógio do VPS fora de sincronia?`);

    logger.info({ na_pasta: todos.length, xml: xmls.length, elegiveis: elegiveis.length, nesta_rodada: candidatos.length }, `${tag}: pasta lida`);
    if (elegiveis.length > MAX_ARQUIVOS) logger.info({ restam: elegiveis.length - MAX_ARQUIVOS }, `${tag}: teto por execução atingido, resto fica para o próximo run`);
    if (!candidatos.length) return 0;

    // 1ª passada: baixa, valida, extrai chaves.
    const arquivos = [];
    for (const f of candidatos) {
      const caminho = `/${DIR_UPLOAD}/${f.name}`;
      let xml;
      try { xml = (await sftp.get(caminho)).toString('utf8'); }
      catch (err) { logger.warn({ arquivo: f.name, err: err.message }, `${tag}: falha ao baixar`); continue; }

      const idade = agora - f.modifyTime;
      if (!ehCte(xml) || !xmlCompleto(xml)) {
        if (idade > TTL_INVALIDO_MS) {
          await moverArquivo(sftp, caminho, DIR_ERRO, f.name, logger, tag);
          logger.warn({ arquivo: f.name }, `${tag}: XML inválido/truncado além do prazo → erro/`);
        }
        continue;
      }
      const chaves = extrairChavesNfe(xml);
      if (!chaves.length) {
        await moverArquivo(sftp, caminho, DIR_ERRO, f.name, logger, tag);
        logger.warn({ arquivo: f.name }, `${tag}: CT-e sem chave de NF-e → erro/`);
        continue;
      }
      arquivos.push({ nome: f.name, caminho, xml, chaves, idade });
    }
    if (!arquivos.length) return 0;

    // 2ª passada: um único lookup para todas as chaves.
    const todasChaves = [...new Set(arquivos.flatMap(a => a.chaves))];
    const mapa = await resolverLinhas(supabase, todasChaves);

    // 3ª passada: monta os itens e grava.
    const itens = [];
    const casados = [];
    for (const a of arquivos) {
      const destinos = a.chaves.flatMap(c => (mapa.get(c) || []).map(d => ({ ...d, chave_nfe: c })));
      if (!destinos.length) {
        if (a.idade > TTL_SEM_LINHA_MS) {
          await moverArquivo(sftp, a.caminho, DIR_ERRO, a.nome, logger, tag);
          logger.warn({ arquivo: a.nome, chaves: a.chaves.length }, `${tag}: sem linha correspondente além do prazo → erro/`);
        }
        continue;
      }
      for (const d of destinos) itens.push({ ...d, xml: a.xml });
      casados.push(a);
    }

    // Grava respeitando a precedência (PVN=DDM > QEDB > ACERTA), via CNPJ da fonte.
    if (itens.length) gravados = await gravarXmlEmLote(supabase, itens, logger, 10, { cnpjProprio: cfg.cnpj });

    for (const a of casados) await moverArquivo(sftp, a.caminho, DIR_PROCESSADO, a.nome, logger, tag);

    logger.info({ arquivos: casados.length, linhas_gravadas: gravados }, `${tag}: finalizada`);
    return gravados;
  } finally {
    await sftp.end().catch(() => {});
  }
}

// Wrappers finos por fonte.
const processarPastaPvn  = (supabase, logger) => processarPastaSftp(supabase, logger, FONTES.PVN);
const processarPastaQedb = (supabase, logger) => processarPastaSftp(supabase, logger, FONTES.QEDB);

module.exports = {
  processarPastaPvn, processarPastaQedb, processarPastaSftp, FONTES,
  extrairChavesNfe, xmlCompleto, ehCte, resolverLinhas, normalizarChave, formaDaChave,
};
