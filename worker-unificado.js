// etl/worker-unificado.js — TMS ETL Unificado v4
// Schema reestruturado: nomes de colunas alinhados + bug timezone corrigido
// + municipio_destino/uf_destino + valor_nf + QEDB CT-e de todas as ocorrências
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { buscarOcorrenciasQedb } = require('./qedb');

const VARS_OBRIGATORIAS = [
  'SUPABASE_URL', 'SUPABASE_KEY',
  'MSSQL_USER', 'MSSQL_PASS', 'MSSQL_HOST', 'MSSQL_DB'
];
const varsFaltando = VARS_OBRIGATORIAS.filter(v => !process.env[v]);
if (varsFaltando.length > 0) { console.error(`ERRO FATAL: Variáveis ausentes: ${varsFaltando.join(', ')}`); process.exit(1); }

const axios  = require('axios');
const sql    = require('mssql');
const pino   = require('pino');
const fs     = require('fs');
const { createClient } = require('@supabase/supabase-js');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } }
  })
});

const BRUDAM_BATCH_SIZE    = parseInt(process.env.BATCH_SIZE  || '50',  10);
const BRUDAM_MAX_GW_ERROS  = parseInt(process.env.MAX_GW_ERRS || '5',   10);
const JANELA_DIAS_PROTHEUS = parseInt(process.env.JANELA_DIAS || '30',  10);
const ESL_JANELA_DIAS      = parseInt(process.env.ESL_JANELA  || '5',   10);
const TOKEN_TTL_MS         = 55 * 60 * 1000;
const SLEEP_ENTRE_LOTES_MS = parseInt(process.env.SLEEP_LOTES || '1000',10);
const BATCH_SIZE_DB        = parseInt(process.env.BATCH_DB    || '50',  10);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(90_000) }) },
});

const mssqlPool = new sql.ConnectionPool({
  user: process.env.MSSQL_USER, password: process.env.MSSQL_PASS,
  server: process.env.MSSQL_HOST, database: process.env.MSSQL_DB,
  pool: { max: 5, min: 1, idleTimeoutMillis: 30000 },
  options: { encrypt: false, trustServerCertificate: true }
});

// ─── UTILITÁRIOS ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizarDataBrasil(data) {
  if (!data) return null;
  try {
    if (data instanceof Date) return isNaN(data.getTime()) ? null : data.toISOString();
    if (typeof data !== 'string') return null;
    const v = data.trim();
    if (!v) return null;
    if (/\d{4}-\d{2}-\d{2}T.+(Z|[+-]\d{2}:\d{2})$/.test(v)) { const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) { const d = new Date(v + '-03:00'); return isNaN(d.getTime()) ? null : d.toISOString(); }
    if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/.test(v))   { const d = new Date(v.replace(' ', 'T') + '-03:00'); return isNaN(d.getTime()) ? null : d.toISOString(); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(v))                        { const d = new Date(v + 'T00:00:00-03:00'); return isNaN(d.getTime()) ? null : d.toISOString(); }
    const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString();
  } catch { return null; }
}

function sanitizar(val) {
  if (typeof val === 'string') return val.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();
  if (Array.isArray(val)) return val.map(sanitizar);
  if (val && typeof val === 'object') return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, sanitizar(v)]));
  return val;
}

function calcBackoff(tentativa, baseMs = 1500) { return Math.floor(baseMs * Math.pow(2, Math.min(tentativa, 6) - 1) + Math.random() * 500); }

function tryDecodeBase64Json(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  try { const d = Buffer.from(value, 'base64').toString('utf-8').trim(); if (d.startsWith('{') || d.startsWith('[')) return JSON.parse(d); return d; } catch { return value; }
}

function parseDataProtheusYYYYMMDD(data) {
  if (!data) return null;
  const v = String(data).trim();
  if (!/^\d{8}$/.test(v)) return null;
  return `${v.substring(0,4)}-${v.substring(4,6)}-${v.substring(6,8)}T00:00:00-03:00`;
}

// ─── EMPRESAS ─────────────────────────────────────────────────────────────────
const EMPRESAS_PROTHEUS = [
  { sufixo: '030', empresa_id: 'VILLE'    },
  { sufixo: '010', empresa_id: 'ATALANTA' },
];
const CNPJ_EMPRESA_QEDB = { '02167473000294': { sufixo: '030', empresa_id: 'VILLE' } };
const CAMPOS_HERDAR_CABECALHO = ['cte_numero','cteNumero','nf_numero','nfNumero','numero_nf','notafiscal','razao_destinatario','razaoDestinatario','destinatario','cnpj_destinatario','cnpjDestinatario'];

// ─── QUERIES PROTHEUS ─────────────────────────────────────────────────────────
function buildQueryBrudam(sufixo, empresaId, inListCnpj, janela) {
  return `
    SELECT
        '${empresaId}' AS empresa_id,
        LTRIM(RTRIM(f.F2_FILIAL))  AS filial,
        LTRIM(RTRIM(a.A4_CGC))     AS cnpj_transportador,
        f.F2_CHVNFE                AS f2_chvnfe,
        LTRIM(RTRIM(vend.A3_COD))  AS codigo_representante,
        f.F2_TRANSP, f.F2_REDESP,
        CAST(f.F2_VALBRUT AS DECIMAL(15,2)) AS valor_nf
    FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY F2_CHVNFE ORDER BY R_E_C_N_O_ DESC) AS rn
        FROM SF2${sufixo} WHERE D_E_L_E_T_ = ''
    ) f
    INNER JOIN SA4${sufixo} a  ON a.A4_COD = COALESCE(f.F2_TRANSP, f.F2_REDESP) AND a.D_E_L_E_T_ = ''
    LEFT  JOIN SA3${sufixo} vend ON vend.A3_COD = f.F2_VEND1 AND vend.A3_FILIAL = '00' AND vend.D_E_L_E_T_ = ''
    WHERE f.rn = 1
      AND f.F2_EMISSAO >= CONVERT(VARCHAR(8), DATEADD(DAY, -${janela}, GETDATE()), 112)
      AND LEN(LTRIM(RTRIM(f.F2_CHVNFE))) = 44
      AND f.F2_CHVNFE NOT LIKE '%[^0-9]%'
      AND LTRIM(RTRIM(a.A4_CGC)) IN (${inListCnpj})
  `;
}

function buildQueryEsl(sufixo, empresaId, inListChaves) {
  return `
    SELECT DISTINCT
        '${empresaId}'                       AS empresa_id,
        LTRIM(RTRIM(f.F2_FILIAL))            AS filial,
        LTRIM(RTRIM(COALESCE(a.A4_CGC,''))) AS cnpj_transportador_protheus,
        f.F2_CHVNFE                          AS f2_chvnfe,
        LTRIM(RTRIM(vend.A3_COD))            AS codigo_representante,
        LTRIM(RTRIM(cli.A1_NOME))            AS razao_destinatario,
        LTRIM(RTRIM(cli.A1_CGC))             AS cnpj_destinatario,
        LTRIM(RTRIM(cli.A1_MUN))             AS municipio_destino,
        LTRIM(RTRIM(cli.A1_EST))             AS uf_destino,
        CAST(f.F2_VALBRUT AS DECIMAL(15,2))  AS valor_nf
    FROM SF2${sufixo} f
    LEFT JOIN SA4${sufixo} a   ON a.A4_COD   = f.F2_TRANSP AND a.D_E_L_E_T_   = ''
    LEFT JOIN SA3${sufixo} vend ON vend.A3_COD = f.F2_VEND1 AND vend.A3_FILIAL = '00' AND vend.D_E_L_E_T_ = ''
    LEFT JOIN SA1${sufixo} cli ON cli.A1_FILIAL = f.F2_FILIAL AND cli.A1_COD = f.F2_CLIENTE AND cli.A1_LOJA = f.F2_LOJA AND cli.D_E_L_E_T_ = ''
    WHERE f.D_E_L_E_T_ = ''
      AND f.F2_CHVNFE IN (${inListChaves})
  `;
}

function buildQueryQedb(sufixo, empresaId, inListNf, inListSerie) {
  const dt = new Date(); dt.setDate(dt.getDate() - 60);
  const dataCorte = dt.toISOString().split('T')[0].replace(/-/g, '');
  const fmtNfs    = inListNf.split(',').map(nf => `'${nf.trim().replace(/'/g,'').padStart(9,'0')}'`).join(',');
  const fmtSeries = inListSerie.split(',').map(s => `'${s.trim().replace(/'/g,'')}'`).join(',');
  return `
    SELECT
      '${empresaId}' AS empresa_id,
      f.F2_FILIAL_LTRIM AS filial,
      f.F2_CHVNFE AS f2_chvnfe,
      f.F2_DOC AS nf_numero,
      f.F2_SERIE_LTRIM AS serie,
      f.cnpj_transportador_protheus,
      f.codigo_representante,
      f.valor_nf,
      dest.razao_destinatario,
      dest.cnpj_destinatario,
      dest.municipio_destino,
      dest.uf_destino,
      dest.previsao_entrega
    FROM (
      SELECT DISTINCT
        LTRIM(RTRIM(f.F2_FILIAL)) AS F2_FILIAL_LTRIM,
        f.F2_CHVNFE,
        LTRIM(RTRIM(f.F2_DOC))   AS F2_DOC,
        LTRIM(RTRIM(f.F2_SERIE)) AS F2_SERIE_LTRIM,
        f.F2_CLIENTE, f.F2_LOJA,
        LTRIM(RTRIM(COALESCE(a.A4_CGC,'')))     AS cnpj_transportador_protheus,
        LTRIM(RTRIM(vend.A3_COD))               AS codigo_representante,
        CAST(f.F2_VALBRUT AS DECIMAL(15,2))     AS valor_nf
      FROM SF2${sufixo} f
      LEFT JOIN SA4${sufixo} a    ON a.A4_COD    = f.F2_TRANSP AND a.D_E_L_E_T_    = ''
      LEFT JOIN SA3${sufixo} vend ON vend.A3_COD = f.F2_VEND1  AND vend.A3_FILIAL  = '00' AND vend.D_E_L_E_T_ = ''
      WHERE f.D_E_L_E_T_ = ''
        AND f.F2_EMISSAO >= '${dataCorte}'
        AND LTRIM(RTRIM(f.F2_DOC))   IN (${fmtNfs})
        AND LTRIM(RTRIM(f.F2_SERIE)) IN (${fmtSeries})
    ) f
    LEFT JOIN (
      SELECT
        d.D2_FILIAL, d.D2_CLIENTE, d.D2_LOJA, d.D2_DOC, d.D2_SERIE,
        MAX(LTRIM(RTRIM(c.A1_NOME))) AS razao_destinatario,
        MAX(LTRIM(RTRIM(c.A1_CGC)))  AS cnpj_destinatario,
        MAX(LTRIM(RTRIM(c.A1_MUN)))  AS municipio_destino,
        MAX(LTRIM(RTRIM(c.A1_EST)))  AS uf_destino,
        MIN(ped.C5_XENTREG)          AS previsao_entrega
      FROM SD2${sufixo} d
      LEFT JOIN SA1${sufixo} c   ON c.A1_FILIAL  = d.D2_FILIAL AND c.A1_COD   = d.D2_CLIENTE AND c.A1_LOJA = d.D2_LOJA AND c.D_E_L_E_T_ = ''
      LEFT JOIN SC5${sufixo} ped ON ped.C5_FILIAL = d.D2_FILIAL AND ped.C5_NUM = d.D2_PEDIDO AND ped.D_E_L_E_T_ = ''
      WHERE d.D_E_L_E_T_ = ''
        AND LTRIM(RTRIM(d.D2_DOC))   IN (${fmtNfs})
        AND LTRIM(RTRIM(d.D2_SERIE)) IN (${fmtSeries})
      GROUP BY d.D2_FILIAL, d.D2_CLIENTE, d.D2_LOJA, d.D2_DOC, d.D2_SERIE
    ) dest
      ON dest.D2_FILIAL  = f.F2_FILIAL_LTRIM AND dest.D2_CLIENTE = f.F2_CLIENTE AND dest.D2_LOJA = f.F2_LOJA
     AND LTRIM(RTRIM(dest.D2_DOC)) = f.F2_DOC AND LTRIM(RTRIM(dest.D2_SERIE)) = f.F2_SERIE_LTRIM
  `;
}

async function buscarChavesProtheus_EslMultiEmpresa(chaves) {
  if (!chaves?.length) return [];
  const filtradas = chaves.filter(c => /^\d{44}$/.test(c));
  if (!filtradas.length) return [];
  const inList = filtradas.map(c => `'${c}'`).join(',');
  const blocks = EMPRESAS_PROTHEUS.map(({ sufixo, empresa_id }) => buildQueryEsl(sufixo, empresa_id, inList));
  return (await mssqlPool.request().query(blocks.join('\nUNION ALL\n'))).recordset;
}

async function buscarChavesProtheus_Brudam(cnpjs, nome) {
  if (!cnpjs?.length) return [];
  const limpos = cnpjs.map(c => c.replace(/\D/g, '')).filter(c => /^\d{14}$/.test(c));
  if (!limpos.length) { logger.warn({ transportadora: nome }, 'Nenhum CNPJ válido'); return []; }
  const inList = limpos.map(c => `'${c}'`).join(',');
  const blocks = EMPRESAS_PROTHEUS.map(({ sufixo, empresa_id }) => buildQueryBrudam(sufixo, empresa_id, inList, JANELA_DIAS_PROTHEUS));
  logger.info({ transportadora: nome, cnpjs: limpos.length }, 'Brudam: consultando Protheus');
  const result = await mssqlPool.request().query(blocks.join('\nUNION ALL\n'));
  logger.info({ transportadora: nome, total: result.recordset.length }, 'Brudam: NF-es encontradas');
  return result.recordset;
}

// ─── TOKEN BRUDAM ─────────────────────────────────────────────────────────────
const tokenCache = new Map(), tokenInFlight = new Map();

function extrairToken(data) { return data?.token || data?.tokenjwt || data?.data?.token || data?.access_token || data?.data?.access_key || null; }

async function getBrudamToken(account, authUrl) {
  const url = sanitizar(authUrl), key = `${account.user}@${url}`;
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  if (tokenInFlight.has(key)) return tokenInFlight.get(key);
  const promise = (async () => {
    try {
      logger.info({ conta: account.user }, 'Renovando token Brudam');
      const cred = { usuario: account.user, senha: account.pass };
      let token = null;
      try { const r = await axios.post(url, cred, { headers: { 'Content-Type': 'application/json' }, timeout: 120_000, validateStatus: () => true }); if (r.status < 400 && r.data?.status !== 0) token = extrairToken(r.data); } catch {}
      if (!token) { try { const r = await axios.post(url, new URLSearchParams(cred), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 120_000, validateStatus: () => true }); if (r.status < 400) token = extrairToken(r.data); } catch {} }
      if (!token || typeof token !== 'string') throw new Error(`Token não obtido (${account.user})`);
      tokenCache.set(key, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
      logger.info({ conta: account.user }, 'Token obtido');
      return token;
    } finally { tokenInFlight.delete(key); }
  })();
  tokenInFlight.set(key, promise);
  return promise;
}

function invalidarToken(account, authUrl) { tokenCache.delete(`${sanitizar(account.user)}@${sanitizar(authUrl)}`); }
setInterval(() => { const now = Date.now(); for (const [k, v] of tokenCache.entries()) if (now >= v.expiresAt) tokenCache.delete(k); }, 10 * 60 * 1000).unref();

// ─── API BRUDAM ───────────────────────────────────────────────────────────────
async function consultarBrudamLote(chaves, config, account, isRetry = false, t429 = 0) {
  const token = await getBrudamToken(account, config.auth_url);
  const url   = `${config.base}/api/v1/tracking/ocorrencias/nfe?chave=${encodeURIComponent(chaves.join(','))}&comprovante=1`;
  try {
    const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 45000 });
    if (typeof data === 'string') return tryDecodeBase64Json(data) ?? { conteudo: data };
    return data;
  } catch (err) {
    const s = err.response?.status;
    if (s === 429 && t429 < 5) { await sleep(calcBackoff(t429 + 1, 2500)); return consultarBrudamLote(chaves, config, account, isRetry, t429 + 1); }
    if (s === 404) { if (typeof err.response?.data === 'string' && err.response.data.includes('<html')) throw err; return { _is404: true }; }
    if (s === 401 && !isRetry) { invalidarToken(account, config.auth_url); await sleep(1000); return consultarBrudamLote(chaves, config, account, true, t429); }
    throw err;
  }
}

// ─── API ESL ──────────────────────────────────────────────────────────────────
async function buscarDadosEsl(endpoint, credencial, dataSince, startId = null) {
  const { tenant, token } = credencial;
  let url = `https://${tenant}.eslcloud.com.br/api/customer/${endpoint}?since=${dataSince}`;
  if (startId) url += `&start=${startId}`;
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, tenant, Accept: 'application/json' } });
    if (response.status === 429) { await sleep(4000); return buscarDadosEsl(endpoint, credencial, dataSince, startId); }
    if (!response.ok) { logger.warn({ endpoint, status: response.status }, 'ESL: não-OK'); return []; }
    const json = await response.json();
    let registros = json.data || [];
    if (json.paging?.next_id) { await sleep(2000); registros = registros.concat(await buscarDadosEsl(endpoint, credencial, dataSince, json.paging.next_id)); }
    return registros;
  } catch (err) { logger.error({ endpoint, err: err.message }, 'ESL: erro'); return []; }
}

// ─── NORMALIZAÇÃO BRUDAM ──────────────────────────────────────────────────────
function normalizarPayloadBrudam(apiData) {
  if (!apiData || apiData._is404) return [];
  for (const campo of ['dados','conteudo','xml','tracking']) {
    if (typeof apiData[campo] === 'string') {
      const decoded = tryDecodeBase64Json(apiData[campo]);
      if (decoded !== apiData[campo]) {
        apiData = { ...apiData, [campo]: decoded };
        if (Array.isArray(decoded)) return decoded;
        if (Array.isArray(decoded?.data)) return decoded.data;
        if (Array.isArray(decoded?.dados)) return decoded.dados;
      }
    }
  }
  if (Array.isArray(apiData)) return apiData;
  if (Array.isArray(apiData?.data)) return apiData.data;
  if (Array.isArray(apiData?.dados)) return apiData.dados;
  if (apiData?.documento || apiData?.chave) return [apiData];
  return [];
}

// ─── CONSOLIDAÇÃO DE DATAS REAIS ──────────────────────────────────────────────
// CORREÇÃO TIMEZONE: todas as datas passam por normalizarDataBrasil()
// para garantir offset -03:00 antes de chegar na RPC do Supabase
function extrairDatasConsolidadas(ocorrencias) {
  const datas = {
    dt_coleta: null, dt_emissao_edi: null, dt_cte_sefaz: null,
    dt_hub_conferido: null, dt_saida_efetiva: null, dt_em_transito: null,
    dt_entregue: null, dt_canhoto: null, dt_devolucao: null,
  };
  const ordenadas = ocorrencias
    .map(o => ({ ...o, _date: o.data ? new Date(normalizarDataBrasil(o.data) || '') : null }))
    .filter(o => o._date && !isNaN(o._date))
    .sort((a, b) => a._date - b._date);

  for (const oc of ordenadas) {
    const status = String(oc.status || '').trim();
    const desc   = String(oc.descricao || '').toUpperCase().trim();
    const data   = normalizarDataBrasil(oc.data); // FIX: normalizar aqui
    const temCod = status !== '';

    if (status === '147' || (!temCod && desc.includes('COLETA REALIZADA')))                                                    datas.dt_coleta        = data;
    if (status === '125' || (!temCod && desc.includes('CTE AUTORIZADO')))                                                      datas.dt_cte_sefaz     = data;
    if (status === '123' || status === '100' || (!temCod && desc.includes('EMISSAO REALIZADA')))                               datas.dt_emissao_edi   = data;
    if (status === '111' || (!temCod && desc.includes('HUB DA TRANSPORTADORA')))                                               datas.dt_hub_conferido = data;
    if (status === '103' || (!temCod && desc.includes('SAIDA EFETIVA')))                                                       datas.dt_saida_efetiva = data;
    if (status === '165' || status === '99' || (!temCod && (desc.includes('MANIFESTADO') || desc.includes('TRANSFERENCIA') || desc.includes('EM TRANSFERENCIA'))))  datas.dt_em_transito   = data;
    if (status === '1'   || status === '02' || (!temCod && desc.includes('ENTREGA REALIZADA')))                               datas.dt_entregue      = data;
    if (status === '105' || (!temCod && desc.includes('COMPROVANTE DE ENTREGA')))                                             datas.dt_canhoto       = data;
    if (status === '199' || status === '07' || status === '25' || (!temCod && (desc.includes('DEVOLVIDA') || desc.includes('DEVOLUCAO'))))  datas.dt_devolucao     = data;
  }
  return datas;
}

// ─── MAPEAMENTO CANÔNICO (nomes alinhados com novo schema) ────────────────────
function montarRegistro({
  empresa_id, filial, chave_nfe, cnpj_transportador, nf_numero, cte_numero,
  razao_destinatario, cnpj_destinatario, municipio_destino, uf_destino,
  codigo_representante, modal_transporte, valor_nf, previsao_entrega,
  execucao_id, ingest_source,
  ultima_ocorrencia_codigo, ultima_ocorrencia_data, ultima_ocorrencia_descricao,
  entrega_nome, entrega_documento,
  dt_coleta, dt_emissao_edi, dt_cte_sefaz, dt_hub_conferido,
  dt_saida_efetiva, dt_em_transito, dt_entregue, dt_canhoto, dt_devolucao,
}) {
  return {
    empresa_id:                empresa_id               || null,
    filial:                    filial                   ? String(filial).trim() : null,
    cnpj_transportador:        cnpj_transportador       || null,
    chave_nfe:                 chave_nfe                || null,
    nf_numero:                 nf_numero                ? String(nf_numero)    : null,
    cte_numero:                cte_numero               ? String(cte_numero)   : null,
    razao_destinatario:        razao_destinatario       || null,
    cnpj_destinatario:         cnpj_destinatario        || null,
    municipio_destino:         municipio_destino        ? String(municipio_destino).trim() : null,
    uf_destino:                uf_destino               ? String(uf_destino).trim().substring(0,2).toUpperCase() : null,
    codigo_representante:      codigo_representante     ? String(codigo_representante).trim() : null,
    modal_transporte:          modal_transporte         || 'RODOVIARIO',
    valor_nf:                  valor_nf                 ? Number(valor_nf) || null : null,
    previsao_entrega:          normalizarDataBrasil(previsao_entrega),
    execucao_id:               execucao_id              || null,
    ingest_source:             ingest_source            || null,
    ultima_ocorrencia_codigo:  ultima_ocorrencia_codigo ? String(ultima_ocorrencia_codigo) : null,
    ultima_ocorrencia_data:    normalizarDataBrasil(ultima_ocorrencia_data),
    ultima_ocorrencia_descricao: sanitizar(ultima_ocorrencia_descricao) || null,
    entrega_nome:              entrega_nome             ? String(entrega_nome).trim()     : null,
    entrega_documento:         entrega_documento        ? String(entrega_documento).trim() : null,
    dt_coleta:                 dt_coleta                || null,
    dt_emissao_edi:            dt_emissao_edi           || null,
    dt_cte_sefaz:              dt_cte_sefaz             || null,
    dt_hub_conferido:          dt_hub_conferido         || null,
    dt_saida_efetiva:          dt_saida_efetiva         || null,
    dt_em_transito:            dt_em_transito           || null,
    dt_entregue:               dt_entregue              || null,
    dt_canhoto:                dt_canhoto               || null,
    dt_devolucao:              dt_devolucao             || null,
  };
}

// ─── UPSERT ───────────────────────────────────────────────────────────────────
async function upsertComRetry(registros) {
  let tentativa = 1;
  while (tentativa <= 5) {
    try {
      const { data, error } = await supabase.rpc('upsert_lote_tms', { registros });
      if (!error) { logger.debug({ processed: data?.processed ?? registros.length }, 'RPC: ok'); return; }
      if (['42883','42703','42P01','42501'].includes(error.code)) { logger.error({ erro: error.message }, 'Erro schema'); throw error; }
      if (!(!error.code || error.code.startsWith('PGRST') || error.code === '40001')) { throw error; }
      await sleep(calcBackoff(tentativa));
    } catch (err) {
      const isTimeout = err.name === 'AbortError' || err.name === 'TimeoutError' || err.message?.toLowerCase().includes('timeout');
      const isRede    = err.message?.toLowerCase().includes('fetch failed') || err.message?.toLowerCase().includes('network');
      if ((isTimeout || isRede) && tentativa < 5) { await sleep(calcBackoff(tentativa, 3000)); }
      else { throw err; }
    }
    tentativa++;
  }
  throw new Error('Falha após 5 tentativas');
}

async function salvarRegistros(registros) {
  if (!registros?.length) return 0;
  const validos = registros.filter(r => r.empresa_id && r.filial && r.chave_nfe);
  if (validos.length < registros.length) logger.warn({ descartados: registros.length - validos.length }, 'Descartados sem PK');
  for (let i = 0; i < validos.length; i += BATCH_SIZE_DB) await upsertComRetry(validos.slice(i, i + BATCH_SIZE_DB));
  return validos.length;
}

async function gravarErroNaEntrega(loteRows, mensagemErro) {
  if (!loteRows?.length) return;
  const grupos = new Map();
  for (const row of loteRows) {
    const k = `${row.empresa_id}||${row.filial}`;
    if (!grupos.has(k)) grupos.set(k, { empresa_id: row.empresa_id, filial: row.filial, chaves: [] });
    grupos.get(k).chaves.push(row.f2_chvnfe);
  }
  const agora = new Date().toISOString(), msg = mensagemErro.substring(0, 500);
  for (const { empresa_id, filial, chaves } of grupos.values()) {
    try { await supabase.from('tms_monitoramento_entregas').update({ ultimo_erro_descricao: msg, dt_ultimo_erro: agora }).eq('empresa_id', empresa_id).eq('filial', filial).in('chave_nfe', chaves); }
    catch (err) { logger.warn({ err: err.message }, 'gravarErroNaEntrega: silenciado'); }
  }
}

// ─── CREDENCIAIS ──────────────────────────────────────────────────────────────
function resolverCredenciaisBrudam(transportadoras) {
  return transportadoras.map(t => {
    const accounts = (t.accounts || []).map(acc => {
      if (acc.user && acc.pass) { logger.warn({ transportadora: t.name }, 'Credencial em texto puro'); return { user: acc.user, pass: acc.pass }; }
      const user = process.env[acc.user_env], pass = process.env[acc.pass_env];
      if (!user || !pass) { logger.error({ transportadora: t.name }, 'Credencial ausente'); return null; }
      return { user, pass };
    }).filter(Boolean);
    return { ...t, accounts };
  }).filter(t => { if (!t.accounts.length) { logger.error({ transportadora: t.name }, 'Sem contas'); return false; } return true; });
}

// ─── FLUXO BRUDAM ─────────────────────────────────────────────────────────────
async function processarTransportadoraBrudam(t, execucao_id) {
  if (['name','base','auth_url','cnpjs','accounts'].some(c => !t[c])) {
    logger.error({ transportadora: t.name }, 'Config inválida'); return { notas_lidas: 0, consultadas: 0, novas: 0, erros: 0 };
  }
  const stats = { notas_lidas: 0, consultadas: 0, novas: 0, erros: 0 };
  const config = { base: t.base, auth_url: t.auth_url };
  const [keys] = await Promise.all([
    buscarChavesProtheus_Brudam(t.cnpjs, t.name),
    Promise.allSettled(t.accounts.map(acc => getBrudamToken(acc, config.auth_url))),
  ]);
  if (!keys.length) { logger.info({ transportadora: t.name }, 'Nenhuma NF-e'); return stats; }
  stats.notas_lidas = keys.length;
  let errosGw = 0;

  for (let i = 0; i < keys.length; i += BRUDAM_BATCH_SIZE) {
    if (errosGw >= BRUDAM_MAX_GW_ERROS) { stats.erros += keys.length - i; break; }
    const loteRows = keys.slice(i, i + BRUDAM_BATCH_SIZE);
    const loteChaves = loteRows.map(r => r.f2_chvnfe);
    stats.consultadas += loteChaves.length;
    let processado = false, ultimoErro = null;

    for (const account of t.accounts) {
      try {
        const payload = await consultarBrudamLote(loteChaves, config, account);
        errosGw = 0;
        const listaItens = normalizarPayloadBrudam(payload);
        const mapaOc = new Map();

        for (const item of listaItens) {
          const docItem = String(item?.documento ?? item?.chave ?? '').trim();
          if (!docItem) continue;
          if (!mapaOc.has(docItem)) mapaOc.set(docItem, []);
          const ocArray = Array.isArray(item.ocorrencias) ? item.ocorrencias : Array.isArray(item.tracking) ? item.tracking : Array.isArray(item.dados) ? item.dados : null;
          if (ocArray) {
            const cab = { ...item }; delete cab.ocorrencias; delete cab.tracking; delete cab.dados;
            for (const oc of ocArray) {
              const merged = { ...cab, ...oc };
              for (const campo of CAMPOS_HERDAR_CABECALHO) { if (!merged[campo] && cab[campo]) merged[campo] = cab[campo]; }
              mapaOc.get(docItem).push(merged);
            }
          } else { mapaOc.get(docItem).push(item); }
        }

        const registros = [];
        for (const row of loteRows) {
          const chave = String(row.f2_chvnfe).trim();
          const ocs   = mapaOc.get(chave) || [];
          const datas = extrairDatasConsolidadas(ocs);

          for (const item of ocs) {
            if (!item.descricao && !item.data && !item.status) continue;
            const previsao = item.prev_entrega || item.previsao_entrega || item.previsaoEntrega || null;
            registros.push(montarRegistro({
              empresa_id: row.empresa_id, filial: row.filial, cnpj_transportador: row.cnpj_transportador,
              chave_nfe: chave,
              nf_numero: item.nf_numero || item.nfNumero || item.numero_nf || item.notafiscal || null,
              cte_numero: item.cte_numero || item.cteNumero || null,
              razao_destinatario: item.razao_destinatario || item.razaoDestinatario || item.destinatario || null,
              cnpj_destinatario: item.cnpj_destinatario || item.cnpjDestinatario || null,
              municipio_destino: null, uf_destino: null, // Brudam não fornece endereço
              codigo_representante: row.codigo_representante,
              modal_transporte: item.servico || item.modal || null,
              valor_nf: row.valor_nf || null,
              previsao_entrega: previsao, execucao_id, ingest_source: t.name,
              ultima_ocorrencia_codigo: String(item.status ?? item.api_status ?? item.codigo ?? '').trim() || null,
              ultima_ocorrencia_data: item.data || item.dataOcorrencia || null,
              ultima_ocorrencia_descricao: item.descricao || item.ocorrencia || null,
              entrega_nome: item.entrega_nome || item.entregaNome || null,
              entrega_documento: item.entrega_rg || item.entregaRg || null,
              ...datas,
            }));
          }
        }

        stats.novas += await salvarRegistros(registros);
        processado = true; break;

      } catch (err) {
        const hs = err.response?.status; ultimoErro = err;
        if ([502,503,504].includes(hs)) { errosGw++; await sleep(calcBackoff(errosGw)); break; }
        if (hs === 429) await sleep(3500);
        if (['42883','42703','42P01','42501'].includes(err.code)) { stats.erros += loteChaves.length; processado = true; break; }
        logger.warn({ err: err.message, conta: account.user }, 'Falha conta — próxima');
        await sleep(1000);
      }
    }

    if (!processado) {
      stats.erros += loteChaves.length;
      const msg = `Brudam: todas as contas falharam — ${t.name}${ultimoErro ? ` (${ultimoErro.message})` : ''}`;
      logger.error({ transportadora: t.name }, msg);
      await gravarErroNaEntrega(loteRows, msg);
    }
    await sleep(SLEEP_ENTRE_LOTES_MS);
  }

  logger.info({ transportadora: t.name, ...stats }, 'Brudam finalizada');
  return stats;
}

// ─── FLUXO ESL ────────────────────────────────────────────────────────────────
function normalizarOcsEslParaDatas(ocs) {
  return ocs.map(oc => ({ status: oc.occurrence?.code ? String(oc.occurrence.code) : null, descricao: oc.occurrence?.description || null, data: oc.occurrence_at || oc.created_at || null }));
}

async function processarEmpresaEsl(origemNome, credencial, sinceFormatted, execucao_id = null) {
  logger.info({ empresa: origemNome }, 'ESL: iniciando');
  const [apiOcs, apiComps] = await Promise.all([
    buscarDadosEsl('invoice_occurrences', credencial, sinceFormatted),
    sleep(500).then(() => buscarDadosEsl('freight_invoice_delivery_receipts', credencial, sinceFormatted)),
  ]);
  logger.info({ empresa: origemNome, ocorrencias: apiOcs.length, comprovantes: apiComps.length }, 'ESL: coletado');

  const chavesUnicas = [...new Set([...apiOcs.map(o => o.invoice?.key), ...apiComps.map(c => c.invoice?.key)].filter(k => k && /^\d{44}$/.test(k)))];
  if (!chavesUnicas.length) { logger.info({ empresa: origemNome }, 'ESL: sem chaves'); return 0; }

  const dadosProt = await buscarChavesProtheus_EslMultiEmpresa(chavesUnicas);
  const mapaProt  = new Map(dadosProt.map(r => [r.f2_chvnfe.trim(), r]));
  logger.info({ empresa: origemNome, total: dadosProt.length }, 'ESL: Protheus ok');

  let div = 0; for (const k of chavesUnicas) { const r = mapaProt.get(k); if (r && r.empresa_id !== credencial.empresa_id) div++; }
  if (div > 0) logger.warn({ empresa_credencial: origemNome, total_divergentes: div }, 'ESL: divergência empresa');

  const mapaOcPorChave = new Map();
  for (const oc of apiOcs) { const k = oc.invoice?.key; if (!k) continue; if (!mapaOcPorChave.has(k)) mapaOcPorChave.set(k, []); mapaOcPorChave.get(k).push(oc); }

  const registros = [];
  for (const oc of apiOcs) {
    const chave = oc.invoice?.key, rowProt = mapaProt.get(chave);
    if (!rowProt) continue;
    const datas = extrairDatasConsolidadas(normalizarOcsEslParaDatas(mapaOcPorChave.get(chave) || []));
    registros.push(montarRegistro({
      empresa_id: rowProt.empresa_id, filial: rowProt.filial,
      cnpj_transportador: oc.freight?.corporation?.document?.replace(/\D/g,'') || rowProt.cnpj_transportador_protheus || null,
      chave_nfe: chave,
      nf_numero: oc.invoice?.number ? String(oc.invoice.number) : null,
      cte_numero: oc.freight?.cte_number ? String(oc.freight.cte_number) : null,
      razao_destinatario: rowProt.razao_destinatario || null,
      cnpj_destinatario: rowProt.cnpj_destinatario || null,
      municipio_destino: rowProt.municipio_destino || null,
      uf_destino: rowProt.uf_destino || null,
      codigo_representante: rowProt.codigo_representante || null,
      modal_transporte: 'RODOVIARIO',
      valor_nf: rowProt.valor_nf || null,
      previsao_entrega: oc.freight?.delivery_prediction_at || null,
      execucao_id, ingest_source: 'API_ESL_PVN_OCORRENCIA',
      ultima_ocorrencia_codigo: oc.occurrence?.code ? String(oc.occurrence.code) : null,
      ultima_ocorrencia_data: oc.occurrence_at || oc.created_at || null,
      ultima_ocorrencia_descricao: oc.occurrence?.description || null,
      entrega_nome: oc.receiver ? String(oc.receiver).trim() : null,
      entrega_documento: oc.document_number || null,
      ...datas,
    }));
  }
  for (const comp of apiComps) {
    const chave = comp.invoice?.key, rowProt = mapaProt.get(chave);
    if (!rowProt) continue;
    registros.push(montarRegistro({
      empresa_id: rowProt.empresa_id, filial: rowProt.filial,
      cnpj_transportador: rowProt.cnpj_transportador_protheus || null,
      chave_nfe: chave,
      nf_numero: comp.invoice?.number ? String(comp.invoice.number) : null,
      cte_numero: comp.freight?.cte_number ? String(comp.freight.cte_number) : null,
      razao_destinatario: rowProt.razao_destinatario || null, cnpj_destinatario: rowProt.cnpj_destinatario || null,
      municipio_destino: rowProt.municipio_destino || null, uf_destino: rowProt.uf_destino || null,
      codigo_representante: rowProt.codigo_representante || null, modal_transporte: 'RODOVIARIO',
      valor_nf: rowProt.valor_nf || null, previsao_entrega: null,
      execucao_id, ingest_source: 'API_ESL_PVN_CANHOTO',
      ultima_ocorrencia_codigo: '105',
      ultima_ocorrencia_data: comp.created_at || null,
      ultima_ocorrencia_descricao: 'COMPROVANTE DE ENTREGA - RECEBIDO',
      entrega_nome: null, entrega_documento: null,
      dt_coleta: null, dt_emissao_edi: null, dt_cte_sefaz: null,
      dt_hub_conferido: null, dt_saida_efetiva: null, dt_em_transito: null,
      dt_entregue: null, dt_canhoto: normalizarDataBrasil(comp.created_at), dt_devolucao: null,
    }));
  }

  const inseridos = await salvarRegistros(registros);
  logger.info({ empresa: origemNome, inseridos }, 'ESL: finalizada');
  return inseridos;
}

// ─── FLUXO QEDB ───────────────────────────────────────────────────────────────
function parseDataHoraQedb(data, hora) {
  if (!data) return null;
  const dl = String(data).replace(/\D/g,'').trim();
  if (dl.length !== 8) return null;
  const dia = dl.substring(0,2), mes = dl.substring(2,4), ano = dl.substring(4,8);
  let hl = hora ? String(hora).replace(/\D/g,'').trim() : '000000';
  if (hl.length === 4) hl += '00'; else if (hl.length !== 6) hl = '000000';
  return `${ano}-${mes}-${dia}T${hl.substring(0,2)}:${hl.substring(2,4)}:${hl.substring(4,6)}-03:00`;
}

function normalizarOcsQedbParaDatas(ocs) {
  return ocs.map(oc => {
    // Prioridade: chegadaDestino (data de chegada ao destino)
    // Fallback: dataOcorrencia + horaOcorrencia (data do evento em si)
    const dtChegada = parseDataHoraQedb(oc.chegadaDestino?.data, oc.chegadaDestino?.hora);
    const dtEvento  = parseDataHoraQedb(oc.dataOcorrencia, oc.horaOcorrencia);
    return {
      status:    oc.codigoOcorrencia ? String(oc.codigoOcorrencia) : null,
      descricao: oc.textoLivre?.texto1 || oc.observacao || null,
      data:      dtChegada || dtEvento || null,
    };
  });
}

// FIX: buscar CT-e de todas as ocorrências (não só a última) e normalizar número-série
function extrairCteQedb(ocs) {
  for (const oc of ocs) {
    if (oc.cte?.numero) {
      const num  = String(oc.cte.numero).trim();
      const serie = oc.cte.serie ? String(oc.cte.serie).trim() : null;
      return serie ? `${num}-${serie}` : num;
    }
  }
  return null;
}

async function processarFluxoQedb(execucao_id) {
  let total = 0;
  const ocsBrutas = await buscarOcorrenciasQedb({ clientId: process.env.QEDB_CLIENT_ID, token: process.env.QEDB_TOKEN, baseUrl: process.env.QEDB_BASE_URL });
  const nfsPorEmpresa = new Map();
  for (const oc of ocsBrutas) {
    const cnpj = String(oc.cnpjEmpresa || '').replace(/\D/g,'');
    const cfg  = CNPJ_EMPRESA_QEDB[cnpj] || { sufixo: '030', empresa_id: 'VILLE' };
    if (!nfsPorEmpresa.has(cfg.empresa_id)) nfsPorEmpresa.set(cfg.empresa_id, { ocs: [], config: cfg });
    nfsPorEmpresa.get(cfg.empresa_id).ocs.push(oc);
  }

  for (const [empresaId, dados] of nfsPorEmpresa.entries()) {
    const listNf    = [...new Set(dados.ocs.map(o => `'${o.numeroNF}'`))].join(',');
    const listSerie = [...new Set(dados.ocs.map(o => { const s = String(o.serieNF).replace(/^0+/,''); return `'${s || '0'}'`; }))].join(',');
    const result    = await mssqlPool.request().query(buildQueryQedb(dados.config.sufixo, empresaId, listNf, listSerie));
    const protheus  = result.recordset;
    logger.info({ empresa: empresaId, totalApi: dados.ocs.length, totalProtheus: protheus.length }, 'QEDB: cruzamento');

    const mapaProt = new Map(protheus.filter(r => r.f2_chvnfe && r.nf_numero).map(r => {
      const nfL = String(r.nf_numero || '').replace(/^0+/,''), sL = String(r.serie || '').trim();
      return [`${nfL}|${sL}`, r];
    }));

    const ocsPorChave = new Map(), metaPorChave = new Map();
    for (const oc of dados.ocs) {
      const nfL = String(oc.numeroNF).replace(/^0+/,''), sL = String(oc.serieNF).replace(/^0+/,'').trim();
      const row = mapaProt.get(`${nfL}|${sL}`);
      if (!row) { logger.warn(`QEDB: NF ${nfL} série ${sL} não encontrada`); continue; }
      const chave = row.f2_chvnfe || `SEM_CHAVE_${nfL}`;
      if (!ocsPorChave.has(chave)) ocsPorChave.set(chave, []);
      ocsPorChave.get(chave).push(oc);
      metaPorChave.set(chave, { row });
    }

    const regs = [];
    for (const [chave, ocs] of ocsPorChave.entries()) {
      const { row } = metaPorChave.get(chave);
      const datas   = extrairDatasConsolidadas(normalizarOcsQedbParaDatas(ocs));
      const ultimaOc = ocs[ocs.length - 1];
      const cteNum   = extrairCteQedb(ocs); // FIX: busca em todas as ocs

      // FIX: quando chegadaDestino vem vazio, extrairDatasConsolidadas descarta
      // a ocorrência e a data não é gravada — mesmo que o status indique entrega.
      // Usar ultima_ocorrencia_data como fallback para a data correspondente ao status.
      const codUltima = ultimaOc.codigoOcorrencia ? String(ultimaOc.codigoOcorrencia).trim() : '';
      const dtFallback = parseDataHoraQedb(ultimaOc.chegadaDestino?.data, ultimaOc.chegadaDestino?.hora)
                      || parseDataHoraQedb(ultimaOc.dataOcorrencia, ultimaOc.horaOcorrencia)
                      || null;
      if (dtFallback) {
        if ((codUltima === '01' || codUltima === '02') && !datas.dt_entregue)   datas.dt_entregue  = dtFallback;
        if ((codUltima === '07' || codUltima === '25') && !datas.dt_devolucao)  datas.dt_devolucao = dtFallback;
        if (codUltima === '99' && !datas.dt_em_transito)                        datas.dt_em_transito = dtFallback;
      }

      regs.push(montarRegistro({
        empresa_id: row.empresa_id, filial: row.filial, chave_nfe: chave,
        cnpj_transportador: (() => {
          // 1º: CNPJ do transportador desta ocorrência (mais preciso)
          const cnpjOc = ultimaOc.transportadorOcorrencia?.cnpj?.replace(/\D/g,'');
          if (cnpjOc?.length === 14) return cnpjOc;
          // 2º: CNPJ do Protheus
          const cnpjProt = row.cnpj_transportador_protheus?.replace(/\D/g,'');
          if (cnpjProt?.length === 14) return cnpjProt;
          // 3º: fallback hardcoded (QEDB padrão)
          return '26510120000122';
        })(),
        nf_numero: row.nf_numero, cte_numero: cteNum,
        razao_destinatario: row.razao_destinatario || null,
        cnpj_destinatario: row.cnpj_destinatario ? String(row.cnpj_destinatario).replace(/\D/g,'') : null,
        municipio_destino: row.municipio_destino || null,
        uf_destino: row.uf_destino || null,
        codigo_representante: row.codigo_representante || null,
        modal_transporte: 'RODOVIARIO',
        valor_nf: row.valor_nf || null,
        previsao_entrega: parseDataProtheusYYYYMMDD(row.previsao_entrega),
        execucao_id, ingest_source: 'API_QEDB',
        ultima_ocorrencia_codigo: ultimaOc.codigoOcorrencia ? String(ultimaOc.codigoOcorrencia) : null,
        ultima_ocorrencia_data: parseDataHoraQedb(ultimaOc.chegadaDestino?.data, ultimaOc.chegadaDestino?.hora)
                             || parseDataHoraQedb(ultimaOc.dataOcorrencia, ultimaOc.horaOcorrencia) || null,
        ultima_ocorrencia_descricao: ultimaOc.textoLivre?.texto1 || ultimaOc.observacao || null,
        entrega_nome: null, entrega_documento: null,
        ...datas,
      }));
    }

    if (regs.length > 0) { await salvarRegistros(regs); total += regs.length; }
  }
  return total;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const configPath = path.resolve(__dirname, process.env.TRANSPORTADORAS_CONFIG ? path.basename(process.env.TRANSPORTADORAS_CONFIG) : 'transportadoras.json');
  let transportadoras;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    transportadoras = resolverCredenciaisBrudam(sanitizar(raw?.transportadoras ?? []));
    if (!transportadoras.length) throw new Error('Sem transportadoras válidas');
  } catch (err) { logger.error({ err: err.message }, 'Falha transportadoras.json'); process.exit(1); }

  const EMPRESAS_ESL = [
    { nome: 'SF2010 (ATALANTA)', tenant: process.env.ESL_TENANT, token: process.env.ESL_TOKEN_ATALANTA, sufixo: '010', empresa_id: 'ATALANTA' },
    { nome: 'SF2030 (VILLE)',    tenant: process.env.ESL_TENANT, token: process.env.ESL_TOKEN_VILLE,    sufixo: '030', empresa_id: 'VILLE'    },
  ];

  try { await mssqlPool.connect(); logger.info('MSSQL conectado'); }
  catch (err) { logger.error({ err: err.message }, 'Falha MSSQL'); process.exit(1); }

  const { data: execData, error: execErr } = await supabase.from('sync_execucoes').insert([{ empresa_id: 'MULTI', status_execucao: 'PROCESSANDO' }]).select().single();
  if (execErr) {
    if (execErr.code === '23505') { logger.warn('Já em execução'); await mssqlPool.close().catch(() => {}); return; }
    throw new Error(`Falha execução: ${execErr.message}`);
  }

  const execucao_id = execData.execucao_id;
  const stats = { total_notas_lidas: 0, total_notas_consultadas: 0, total_novas: 0, total_erros: 0 };

  async function finalizar(status) {
    if (mssqlPool.connected) await mssqlPool.close().catch(() => {});
    const { error } = await supabase.from('sync_execucoes').update({ fim_em: new Date().toISOString(), ...stats, status_execucao: status }).eq('execucao_id', execucao_id);
    if (error) logger.error({ err: error.message }, 'Falha status final');
    else       logger.info({ ...stats, status }, '✅ ETL finalizado');
  }

  for (const sig of ['SIGTERM','SIGINT']) process.once(sig, () => finalizar('ABORTADO').finally(() => process.exit(0)));

  try {
    logger.info({ total: transportadoras.length }, '── Brudam ──');
    for (const t of transportadoras) {
      try { const s = await processarTransportadoraBrudam(t, execucao_id); stats.total_notas_lidas += s.notas_lidas; stats.total_notas_consultadas += s.consultadas; stats.total_novas += s.novas; stats.total_erros += s.erros; }
      catch (err) { logger.error({ transportadora: t.name, err: err.message }, 'Brudam: erro'); }
    }

    const dataCorte = new Date(); dataCorte.setDate(dataCorte.getDate() - ESL_JANELA_DIAS);
    const since = dataCorte.toISOString().split('.')[0] + '-03:00';
    logger.info({ total: EMPRESAS_ESL.length, since }, '── ESL ──');
    for (const emp of EMPRESAS_ESL) {
      try { stats.total_novas += await processarEmpresaEsl(emp.nome, emp, since, execucao_id); }
      catch (err) { logger.error({ empresa: emp.nome, err: err.message }, 'ESL: erro'); }
    }

    logger.info('── QEDB ──');
    try { const n = await processarFluxoQedb(execucao_id); stats.total_novas += n; logger.info({ inseridos: n }, 'QEDB ok'); }
    catch (err) { logger.error({ err: err.message }, 'QEDB: erro'); }

    await finalizar('FINALIZADO');
  } catch (err) { logger.error({ err: err.message }, 'Erro crítico'); await finalizar('ERRO'); throw err; }
}

if (require.main === module) main().catch(err => { logger.error({ err: err.message }, 'Fatal'); process.exit(1); });
module.exports = { main };