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
const { gravarXmlEmLote, gravarCteXml } = require('./xml-completo');

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
// CT-e complementar (tpCTe=1) não cita NF-e: aponta para o CT-e original.
function chaveCteOriginal(xml) {
  return (xml.match(/<infCteComp>[\s\S]*?<chCTe>(\d{44})<\/chCTe>/) || [])[1] || null;
}
function chaveCteDoXml(xml) {
  return (xml.match(/<infCte[^>]*Id="CTe(\d{44})"/) || [])[1] || null;
}
const tagXml = (xml, nome) => (xml.match(new RegExp(`<${nome}>([^<]+)</${nome}>`)) || [])[1] || null;

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

// ─── EVENTOS (cancelamento) ──────────────────────────────────────────────────
// Evento do CT-e (procEventoCTe, arquivo "-eve.xml"). Só o cancelamento
// (tpEvento 110111) registrado na SEFAZ (cStat 135/136) muda algo no banco.
function lerEvento(xml) {
  if (!/<(procEventoCTe|eventoCTe)[\s>]/.test(xml)) return null;
  return {
    chCte: (xml.match(/<infEvento[\s\S]*?<chCTe>(\d{44})<\/chCTe>/) || [])[1] || null,
    tpEvento: tagXml(xml, 'tpEvento'),
    cStat: (xml.match(/<retEventoCTe[\s\S]*?<cStat>(\d+)<\/cStat>/) || [])[1] || null,
  };
}

// Aplica os cancelamentos: apaga o complementar cancelado e tira o XML do CT-e
// cancelado das linhas que o têm (a ACERTA ou o próprio ETL regravam depois o
// CT-e válido dessas notas). As NF-e do cancelado saem do XML dele em
// processado/. Devolve as chaves canceladas (desta rodada e de eventos já em
// processado/) para não gravar um CT-e cancelado que chegue depois.
async function processarEventos(sftp, supabase, logger, cfg, eventos) {
  const tag = cfg.tag;
  const canceladas = new Set();
  const temProcessado = await sftp.exists(`/${DIR_PROCESSADO}`);
  const processado = temProcessado ? (await sftp.list(`/${DIR_PROCESSADO}`)).filter(f => f.type === '-') : [];
  for (const f of processado) {
    const k = (f.name.match(/^(\d{44}).*-eve/i) || [])[1];
    if (k) canceladas.add(k);
  }

  for (const ev of eventos) {
    const cancela = ev.tpEvento === '110111' && ['135', '136'].includes(ev.cStat) && ev.chCte;
    if (cancela) {
      canceladas.add(ev.chCte);
      let complementares = 0, linhas = 0;
      const del = await supabase.from('tms_cte_complementar').delete({ count: 'exact' }).eq('chave_cte', ev.chCte);
      if (del.error) logger.warn({ err: del.error.message }, `${tag}: cancelamento — falha ao limpar complementar`);
      else complementares = del.count || 0;
      // tms_cte_nfe sai junto (on delete cascade)
      const delCte = await supabase.from('tms_cte_xml').delete().eq('chave_cte', ev.chCte);
      if (delCte.error) logger.warn({ err: delCte.error.message }, `${tag}: cancelamento — falha ao limpar tms_cte_xml`);

      const original = processado.find(f => f.name.startsWith(ev.chCte) && !/-eve/i.test(f.name));
      if (original) {
        let nfes = [];
        try { nfes = extrairChavesNfe((await sftp.get(`/${DIR_PROCESSADO}/${original.name}`)).toString('utf8')); }
        catch (err) { logger.warn({ arquivo: original.name, err: err.message }, `${tag}: cancelamento — falha ao ler CT-e`); }
        const mapa = nfes.length ? await resolverLinhas(supabase, nfes) : new Map();
        for (const [chave, destinos] of mapa) {
          for (const d of destinos) {
            const { error, count } = await supabase.from('tms_monitoramento_entregas')
              .update({ xml_completo: null }, { count: 'exact' })
              .eq('empresa_id', d.empresa_id).eq('filial', d.filial).eq('chave_nfe', chave)
              .like('xml_completo', `%${ev.chCte}%`);
            if (error) logger.warn({ err: error.message }, `${tag}: cancelamento — falha ao limpar xml_completo`);
            else linhas += count || 0;
          }
        }
      }
      logger.info({ cte: ev.chCte, complementares_apagados: complementares, linhas_limpas: linhas }, `${tag}: CT-e cancelado aplicado`);
    } else {
      logger.info({ arquivo: ev.nome, tpEvento: ev.tpEvento, cStat: ev.cStat }, `${tag}: evento sem efeito no banco`);
    }
    await moverArquivo(sftp, ev.caminho, DIR_PROCESSADO, ev.nome, logger, tag);
  }
  return canceladas;
}

// ─── CT-e COMPLEMENTAR ───────────────────────────────────────────────────────
// O complementar não cita NF-e, só o CT-e original: as NF-e saem do XML do
// original (desta rodada ou já em processado/, cujo nome começa pela chave).
// Grava em tms_cte_complementar (ver consultas/tms_cte_complementar.sql), não em
// xml_completo, que guarda o CT-e original. Se a gravação falhar (ex.: tabela
// ainda não criada), os arquivos ficam em upload/ e voltam na próxima rodada.
async function processarComplementares(sftp, supabase, logger, cfg, comps, arquivosDaRodada) {
  const tag = cfg.tag;
  const nfesPorCte = new Map();
  for (const a of arquivosDaRodada) { const k = chaveCteDoXml(a.xml); if (k) nfesPorCte.set(k, a.chaves); }

  const faltam = [...new Set(comps.map(c => c.original))].filter(k => !nfesPorCte.has(k));
  if (faltam.length && await sftp.exists(`/${DIR_PROCESSADO}`)) {
    const porChave = new Map();
    for (const f of await sftp.list(`/${DIR_PROCESSADO}`)) {
      const k = (f.name.match(/^(\d{44})/) || [])[1];
      if (f.type === '-' && k && !porChave.has(k)) porChave.set(k, f.name);
    }
    for (const k of faltam) {
      const nome = porChave.get(k);
      if (!nome) continue;
      try { nfesPorCte.set(k, extrairChavesNfe((await sftp.get(`/${DIR_PROCESSADO}/${nome}`)).toString('utf8'))); }
      catch (err) { logger.warn({ arquivo: nome, err: err.message }, `${tag}: falha ao ler CT-e original`); }
    }
  }

  const todasNfes = [...new Set(comps.flatMap(c => nfesPorCte.get(c.original) || []))];
  const mapa = todasNfes.length ? await resolverLinhas(supabase, todasNfes) : new Map();

  const linhas = new Map(); // chave_cte|chave_nfe -> linha (upsert não aceita PK repetida)
  const casados = [];
  for (const c of comps) {
    const nfes = nfesPorCte.get(c.original) || [];
    const destinos = nfes.flatMap(n => (mapa.get(n) || []).map(d => ({ ...d, chave_nfe: n })));
    const chaveCte = chaveCteDoXml(c.xml);
    if (!destinos.length || !chaveCte) {
      if (c.idade > TTL_SEM_LINHA_MS) {
        await moverArquivo(sftp, c.caminho, DIR_ERRO, c.nome, logger, tag);
        const motivo = !chaveCte ? 'sem chave do próprio CT-e' : !nfes.length ? 'CT-e original não encontrado' : 'NF-e do original fora do banco';
        logger.warn({ arquivo: c.nome, original: c.original, motivo }, `${tag}: complementar sem destino além do prazo → erro/`);
      }
      continue;
    }
    const vTPrest = parseFloat(tagXml(c.xml, 'vTPrest'));
    for (const d of destinos) {
      linhas.set(`${chaveCte}|${d.chave_nfe}`, {
        chave_cte: chaveCte, chave_nfe: d.chave_nfe, chave_cte_original: c.original,
        empresa_id: d.empresa_id, filial: d.filial,
        cnpj_emitente: (c.xml.match(/<emit>[\s\S]*?<CNPJ>(\d{14})<\/CNPJ>/) || [])[1] || null,
        n_ct: tagXml(c.xml, 'nCT'), dh_emi: tagXml(c.xml, 'dhEmi'),
        v_tprest: Number.isFinite(vTPrest) ? vTPrest : null,
        xml: c.xml, fonte: tag,
      });
    }
    casados.push(c);
  }
  if (!linhas.size) return 0;

  const todas = [...linhas.values()];
  for (let i = 0; i < todas.length; i += 100) {
    const { error } = await supabase.from('tms_cte_complementar').upsert(todas.slice(i, i + 100), { onConflict: 'chave_cte,chave_nfe' });
    if (error) {
      logger.warn({ err: error.message, arquivos: casados.length }, `${tag}: falha ao gravar complementares (ficam em upload/ para a próxima rodada)`);
      return 0;
    }
  }
  for (const c of casados) await moverArquivo(sftp, c.caminho, DIR_PROCESSADO, c.nome, logger, tag);
  logger.info({ arquivos: casados.length, linhas: linhas.size }, `${tag}: CT-e complementares gravados`);
  return linhas.size;
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
    let arquivos = [];
    let complementares = [];
    const eventos = [];
    for (const f of candidatos) {
      const caminho = `/${DIR_UPLOAD}/${f.name}`;
      let xml;
      try { xml = (await sftp.get(caminho)).toString('utf8'); }
      catch (err) { logger.warn({ arquivo: f.name, err: err.message }, `${tag}: falha ao baixar`); continue; }

      const idade = agora - f.modifyTime;
      const evento = lerEvento(xml);
      if (evento) { eventos.push({ nome: f.name, caminho, ...evento }); continue; }
      if (!ehCte(xml) || !xmlCompleto(xml)) {
        if (idade > TTL_INVALIDO_MS) {
          await moverArquivo(sftp, caminho, DIR_ERRO, f.name, logger, tag);
          logger.warn({ arquivo: f.name }, `${tag}: XML inválido/truncado além do prazo → erro/`);
        }
        continue;
      }
      const chaves = extrairChavesNfe(xml);
      if (!chaves.length) {
        const original = chaveCteOriginal(xml);
        if (original) { complementares.push({ nome: f.name, caminho, xml, original, idade }); continue; }
        await moverArquivo(sftp, caminho, DIR_ERRO, f.name, logger, tag);
        logger.warn({ arquivo: f.name }, `${tag}: CT-e sem chave de NF-e → erro/`);
        continue;
      }
      arquivos.push({ nome: f.name, caminho, xml, chaves, idade });
    }

    // Cancelamentos primeiro: limpa o que já está no banco e não grava CT-e
    // cancelado que chegue nesta rodada (ou depois do seu evento).
    const canceladas = await processarEventos(sftp, supabase, logger, cfg, eventos);
    const descartarCancelado = async a => {
      if (!canceladas.has(chaveCteDoXml(a.xml))) return true;
      await moverArquivo(sftp, a.caminho, DIR_PROCESSADO, a.nome, logger, tag);
      logger.info({ arquivo: a.nome }, `${tag}: CT-e cancelado — não gravado`);
      return false;
    };
    const filtrar = async lista => { const ok = []; for (const a of lista) if (await descartarCancelado(a)) ok.push(a); return ok; };
    arquivos = await filtrar(arquivos);
    complementares = await filtrar(complementares);

    if (complementares.length) await processarComplementares(sftp, supabase, logger, cfg, complementares, arquivos);
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
    // tms_cte_xml: o CT-e desta perna, mesmo quando a precedência não o pôs em xml_completo.
    if (itens.length) await gravarCteXml(supabase, itens.map(i => ({ ...i, papel: 'ENTREGA', fonte: tag })), logger);

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
  chaveCteOriginal, chaveCteDoXml,
};
