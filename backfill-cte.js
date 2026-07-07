// etl/backfill-cte.js
// Preenche tms_monitoramento_entregas.xml_completo com o XML FISCAL DO CT-e
// (Brudam /dfe/cte/nota), buscando pela chave da NF-e que já temos.
//
// - Linhas Brudam (Acerta/DDM): xml_completo = XML do CT-e (ou NULL se não achar).
// - Linhas QEDB/ESL (Fase 2): xml_completo = NULL (limpa o dado antigo).
//
// Uso:
//   node backfill-cte.js                 -> limpa não-Brudam + backfill Brudam
//   node backfill-cte.js --limit 20      -> só 20 linhas por transportadora (teste)
//   node backfill-cte.js --so-brudam     -> não mexe nas linhas QEDB/ESL
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const { criarClienteCteBrudam, LIMITE_CHAVES } = require('./cte-brudam');

const logger = pino({ level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty', options: { colorize: true } } : undefined });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const args = process.argv.slice(2);
const idxLimit = args.indexOf('--limit');
const LIMITE = idxLimit >= 0 ? parseInt(args[idxLimit + 1], 10) : null;
const SO_BRUDAM = args.includes('--so-brudam');
const SO_VAZIAS = args.includes('--so-vazias'); // só linhas Brudam com xml_completo null
const PAGINA = 1000;
const SLEEP_LOTE_MS = 400;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function resolverCarriers() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'transportadoras.json'), 'utf8'));
  return (raw.transportadoras || []).map(t => {
    const acc = (t.accounts || [])
      .map(a => ({ user: a.user || process.env[a.user_env], pass: a.pass || process.env[a.pass_env] }))
      .filter(a => a.user && a.pass);
    return { name: t.name, base: t.base, authUrl: t.auth_url, accounts: acc };
  }).filter(t => t.accounts.length && t.base && t.authUrl);
}

// Atualiza xml_completo (define o valor OU null) — usado tanto p/ gravar CT-e
// quanto p/ limpar linhas sem CT-e.
async function setXmlCompleto(itens, conc = 8) {
  let ok = 0;
  for (let i = 0; i < itens.length; i += conc) {
    const bloco = itens.slice(i, i + conc);
    const res = await Promise.allSettled(bloco.map(async it => {
      const { error } = await supabase.from('tms_monitoramento_entregas')
        .update({ xml_completo: it.xml ?? null })
        .eq('empresa_id', it.empresa_id).eq('filial', it.filial).eq('chave_nfe', it.chave_nfe);
      if (error) throw error;
    }));
    for (const r of res) { if (r.status === 'fulfilled') ok++; else logger.warn({ err: r.reason?.message }, 'falha ao atualizar xml_completo'); }
  }
  return ok;
}

async function limparNaoBrudam(nomesBrudam) {
  const inList = `(${nomesBrudam.map(n => `"${n}"`).join(',')})`;
  const { error, count } = await supabase.from('tms_monitoramento_entregas')
    .update({ xml_completo: null }, { count: 'exact' })
    .not('ingest_source', 'in', inList)
    .not('xml_completo', 'is', null);
  if (error) throw error;
  logger.info({ limpas: count }, 'Linhas não-Brudam (Fase 2): xml_completo limpo');
}

// Coleta (só leitura) todas as linhas-alvo da transportadora antes de processar,
// evitando interferência entre paginação e escrita (importante no --so-vazias).
async function coletarAlvos(carrier) {
  const alvos = [];
  let offset = 0;
  while (true) {
    let q = supabase.from('tms_monitoramento_entregas')
      .select('empresa_id, filial, chave_nfe')
      .eq('ingest_source', carrier.name)
      .order('chave_nfe', { ascending: true })
      .range(offset, offset + PAGINA - 1);
    if (SO_VAZIAS) q = q.is('xml_completo', null);
    const { data: rows, error } = await q;
    if (error) throw error;
    if (!rows.length) break;
    alvos.push(...rows);
    if (rows.length < PAGINA) break;
    offset += PAGINA;
    if (LIMITE != null && alvos.length >= LIMITE) break;
  }
  return LIMITE != null ? alvos.slice(0, LIMITE) : alvos;
}

async function backfillCarrier(carrier) {
  const cliente = criarClienteCteBrudam({ base: carrier.base, authUrl: carrier.authUrl, accounts: carrier.accounts });

  const alvos = await coletarAlvos(carrier);
  let processadas = 0, comCte = 0, semCte = 0;

  for (let i = 0; i < alvos.length; i += LIMITE_CHAVES) {
    const lote = alvos.slice(i, i + LIMITE_CHAVES);
    const chaves = lote.map(r => r.chave_nfe);
    let mapa = new Map();
    try { mapa = await cliente.buscar(chaves); }
    catch (e) { logger.warn({ carrier: carrier.name, err: e.message }, 'CT-e: lote falhou (linhas ficam null)'); }

    const upd = lote.map(r => {
      const cte = mapa.get(r.chave_nfe);
      if (cte?.xml) comCte++; else semCte++;
      return { empresa_id: r.empresa_id, filial: r.filial, chave_nfe: r.chave_nfe, xml: cte?.xml || null };
    });
    await setXmlCompleto(upd);
    processadas += lote.length;
    if (processadas % 1000 < LIMITE_CHAVES) logger.info({ carrier: carrier.name, processadas, comCte, semCte }, 'CT-e backfill: progresso');
    await sleep(SLEEP_LOTE_MS);
  }

  logger.info({ carrier: carrier.name, processadas, comCte, semCte }, `✅ ${carrier.name} concluído`);
  return { processadas, comCte, semCte };
}

async function main() {
  const carriers = resolverCarriers();
  if (!carriers.length) { logger.error('Nenhuma transportadora Brudam válida (cheque credenciais no .env)'); process.exitCode = 1; return; }
  const nomes = carriers.map(c => c.name);
  logger.info({ carriers: nomes, limite: LIMITE }, 'Backfill CT-e: iniciando');

  // preflight coluna
  const { error: preErr } = await supabase.from('tms_monitoramento_entregas').select('xml_completo', { head: true, count: 'exact' });
  if (preErr) { logger.error('Coluna xml_completo não existe.'); process.exitCode = 1; return; }

  if (!SO_BRUDAM) await limparNaoBrudam(nomes);

  const tot = { processadas: 0, comCte: 0, semCte: 0 };
  for (const c of carriers) {
    try { const s = await backfillCarrier(c); tot.processadas += s.processadas; tot.comCte += s.comCte; tot.semCte += s.semCte; }
    catch (e) { logger.error({ carrier: c.name, err: e.message }, 'Falha na transportadora'); }
  }
  logger.info({ ...tot }, '✅ Backfill CT-e concluído');
}

main().catch(err => { logger.error({ err: err.message }, 'Falha no backfill CT-e'); process.exitCode = 1; });
