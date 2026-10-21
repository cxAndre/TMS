// etl/contar-ddm-api.js
// Contagem SOMENTE LEITURA: quantas NF-e do mês a DDM tem na API Brudam, contra
// o que o Protheus e o nosso banco têm. Pergunta à DDM por TODAS as NF-e
// emitidas no mês (não só as que o Protheus marca como DDM), separadas pelos
// CNPJs emitentes, e lista os cadastros da DDM na SA4 (um CNPJ da DDM fora de
// transportadoras.json não é puxado pelo ETL).
// Uso: node contar-ddm-api.js            (mês atual)
//      node contar-ddm-api.js 2026-10    (mês informado)
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const { criarClienteCteBrudam, LIMITE_CHAVES } = require('./cte-brudam');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EMPRESAS = [{ sufixo: '030', empresa_id: 'VILLE' }, { sufixo: '010', empresa_id: 'ATALANTA' }];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const contar = l => { const c = {}; for (const k of l) c[k] = (c[k] || 0) + 1; return c; };
const tabela = (titulo, obj) => {
  console.log(titulo);
  for (const [k, q] of Object.entries(obj).sort((a, b) => b[1] - a[1])) console.log(`  ${String(q).padStart(6)}  ${k}`);
};

const mesArg = process.argv[2] || new Date().toISOString().slice(0, 7);
if (!/^\d{4}-\d{2}$/.test(mesArg)) { console.error('Use: node contar-ddm-api.js AAAA-MM'); process.exit(1); }
const [ano, mes] = mesArg.split('-');
const ini = `${ano}${mes}01`;
const fim = `${ano}${mes}${String(new Date(+ano, +mes, 0).getDate()).padStart(2, '0')}`;

async function autenticar(authUrl, user, pass) {
  const extrair = d => d?.data?.access_key || d?.token || d?.tokenjwt || d?.access_token || d?.data?.token || null;
  const cred = { usuario: user, senha: pass };
  let r = await axios.post(authUrl, cred, { headers: { 'Content-Type': 'application/json' }, timeout: 60000, validateStatus: () => true });
  let token = r.status < 400 ? extrair(r.data) : null;
  if (!token) {
    r = await axios.post(authUrl, new URLSearchParams(cred), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 60000, validateStatus: () => true });
    token = r.status < 400 ? extrair(r.data) : null;
  }
  return token;
}

// Leitura do payload igual à do ETL (normalizarPayloadBrudam): base64 opcional,
// lista em data/dados, um item por NF-e em documento/chave.
function decodificar(v) {
  if (typeof v !== 'string' || !v.trim()) return v;
  try { const d = Buffer.from(v, 'base64').toString('utf-8').trim(); return d.startsWith('{') || d.startsWith('[') ? JSON.parse(d) : v; } catch { return v; }
}
function itensDoPayload(p) {
  p = decodificar(p);
  if (!p || typeof p !== 'object') return [];
  for (const campo of ['dados', 'conteudo', 'xml', 'tracking']) {
    const d = typeof p[campo] === 'string' ? decodificar(p[campo]) : null;
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.data)) return d.data;
    if (Array.isArray(d?.dados)) return d.dados;
  }
  if (Array.isArray(p)) return p;
  if (Array.isArray(p.data)) return p.data;
  if (Array.isArray(p.dados)) return p.dados;
  return p.documento || p.chave ? [p] : [];
}

// Rastreio (mesmo endpoint do ETL): a NF-e "existe na DDM" se vem com ao
// menos uma ocorrência (descrição, data ou status), como o ETL exige.
async function rastreio(base, token, chaves, tent = 0) {
  const r = await axios.get(`${base}/api/v1/tracking/ocorrencias/nfe?chave=${chaves.join(',')}&comprovante=1`, {
    headers: { Authorization: `Bearer ${token}` }, timeout: 60000, validateStatus: () => true,
  });
  if (r.status === 429 && tent < 5) { await sleep(2500 * (tent + 1)); return rastreio(base, token, chaves, tent + 1); }
  if (r.status >= 400) return new Set();
  const achadas = new Set();
  for (const item of itensDoPayload(r.data)) {
    const doc = String(item?.documento ?? item?.chave ?? '').trim();
    const ocs = Array.isArray(item.ocorrencias) ? item.ocorrencias : Array.isArray(item.tracking) ? item.tracking
      : Array.isArray(item.dados) ? item.dados : [item];
    if (doc && ocs.some(o => o?.descricao || o?.data || o?.status)) achadas.add(doc);
  }
  return achadas;
}

(async () => {
  console.log(`Contagem DDM — NF-e emitidas em ${mes}/${ano}\n`);
  const cfg = require('./transportadoras.json').transportadoras.find(t => /DDM/i.test(t.name));
  const cnpjsEtl = new Set(cfg.cnpjs.map(c => c.replace(/\D/g, '')));

  // 1) Protheus: todas as NF-e do mês + cadastros da DDM na SA4
  const pool = await new sql.ConnectionPool({
    user: process.env.MSSQL_USER, password: process.env.MSSQL_PASS,
    server: process.env.MSSQL_HOST, database: process.env.MSSQL_DB,
    port: parseInt(process.env.MSSQL_PORT || '1433', 10),
    connectionTimeout: 30000, requestTimeout: 300000,
    options: { encrypt: false, trustServerCertificate: true },
  }).connect();
  const notas = [], cadastrosDdm = [];
  for (const { sufixo, empresa_id } of EMPRESAS) {
    const r = await pool.request().query(`
      SELECT DISTINCT LTRIM(RTRIM(f.F2_CHVNFE)) AS chave, LTRIM(RTRIM(f.F2_TRANSP)) AS transp,
             LTRIM(RTRIM(t.A4_NOME)) AS nome, LTRIM(RTRIM(t.A4_CGC)) AS cgc
      FROM SF2${sufixo} f
      OUTER APPLY (SELECT TOP 1 A4_NOME, A4_CGC FROM SA4${sufixo} WHERE A4_COD = f.F2_TRANSP AND D_E_L_E_T_ = '') t
      WHERE f.D_E_L_E_T_ = '' AND f.F2_EMISSAO BETWEEN '${ini}' AND '${fim}'
        AND LEN(LTRIM(RTRIM(f.F2_CHVNFE))) = 44`);
    notas.push(...r.recordset.map(n => ({ ...n, empresa_id })));
    const c = await pool.request().query(`
      SELECT DISTINCT LTRIM(RTRIM(A4_COD)) AS cod, LTRIM(RTRIM(A4_NOME)) AS nome, LTRIM(RTRIM(A4_CGC)) AS cgc
      FROM SA4${sufixo}
      WHERE D_E_L_E_T_ = '' AND (A4_NOME LIKE '%DDM%' OR A4_CGC LIKE '19355089%')`);
    cadastrosDdm.push(...c.recordset.map(x => ({ ...x, empresa_id })));
  }
  await pool.close();
  const chaves = [...new Set(notas.map(n => n.chave))];
  const porChave = new Map(notas.map(n => [n.chave, n]));
  const ehDdmProtheus = n => (n.cgc || '').startsWith('19355089') || /DDM/i.test(n.nome || '');

  console.log(`Protheus: ${chaves.length} NF-e emitidas no mês`);
  tabela('  por CNPJ emitente (Payot):', contar(chaves.map(c => c.slice(6, 20))));
  console.log('Cadastros da DDM na SA4 (transportadora):');
  for (const c of cadastrosDdm) {
    const noEtl = cnpjsEtl.has(c.cgc) ? 'no ETL' : 'FORA do ETL (transportadoras.json)';
    console.log(`  ${c.empresa_id.padEnd(8)} cód ${c.cod.padEnd(8)} ${c.cgc.padEnd(15)} ${c.nome}  → ${noEtl}`);
  }
  const ddmProtheus = chaves.filter(c => ehDdmProtheus(porChave.get(c)));
  console.log(`NF-e com a DDM como transportadora no Protheus: ${ddmProtheus.length}`);
  tabela('  por CNPJ da DDM na nota:', contar(ddmProtheus.map(c => porChave.get(c).cgc || '(sem CNPJ)')));
  console.log('');

  // 2) API DDM: rastreio e CT-e para TODAS as NF-e do mês, conta a conta
  const contas = cfg.accounts.map(a => ({ user: process.env[a.user_env], pass: process.env[a.pass_env] })).filter(a => a.user && a.pass);
  const comRastreio = new Set();
  for (const [i, conta] of contas.entries()) {
    const token = await autenticar(cfg.auth_url, conta.user, conta.pass);
    if (!token) { console.log(`Conta ${i + 1}: login falhou`); continue; }
    for (let j = 0; j < chaves.length; j += 50) {
      for (const k of await rastreio(cfg.base, token, chaves.slice(j, j + 50))) comRastreio.add(k);
      process.stdout.write(`\rAPI DDM rastreio, conta ${i + 1}: ${Math.min(j + 50, chaves.length)}/${chaves.length}`);
    }
    console.log('');
  }
  const cliente = criarClienteCteBrudam({ base: cfg.base, authUrl: cfg.auth_url, accounts: contas });
  const comCte = new Set();
  for (let j = 0; j < chaves.length; j += LIMITE_CHAVES) {
    try { for (const k of (await cliente.buscar(chaves.slice(j, j + LIMITE_CHAVES))).keys()) comCte.add(k); } catch {}
    process.stdout.write(`\rAPI DDM CT-e: ${Math.min(j + LIMITE_CHAVES, chaves.length)}/${chaves.length}`);
  }
  console.log('\n');

  // 3) Nosso banco
  const noBanco = new Map();
  for (let j = 0; j < chaves.length; j += 100) {
    const { data, error } = await sb.from('tms_monitoramento_entregas')
      .select('chave_nfe, ingest_source').in('chave_nfe', chaves.slice(j, j + 100));
    if (error) throw new Error(error.message);
    for (const d of data) noBanco.set(d.chave_nfe, d.ingest_source);
  }

  const naDdm = chaves.filter(c => comRastreio.has(c) || comCte.has(c));
  console.log(`API DDM: ${naDdm.length} NF-e do mês existem na DDM (${comRastreio.size} com rastreio, ${comCte.size} com CT-e)`);
  tabela('  por CNPJ emitente (Payot):', contar(naDdm.map(c => c.slice(6, 20))));
  tabela('  transportadora dessas notas no Protheus:', contar(naDdm.map(c => {
    const n = porChave.get(c); return ehDdmProtheus(n) ? `DDM (${n.cgc})` : `${n.nome || n.transp || '(vazio)'} (${n.cgc || '-'})`;
  })));
  tabela('  no nosso banco (ingest_source da linha):', contar(naDdm.map(c => noBanco.get(c) || 'NÃO ESTÁ NO BANCO')));
  const faltam = naDdm.filter(c => !noBanco.has(c));
  if (faltam.length) console.log(`  exemplos que faltam no banco: ${faltam.slice(0, 5).join(', ')}`);
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
