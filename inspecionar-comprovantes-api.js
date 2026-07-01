// Inspeciona todos os valores de comprovante/documento que chegam das APIs
// Roda: node inspecionar-comprovantes-api.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { buscarOcorrenciasQedb } = require('./qedb');
const axios = require('axios');
const sql   = require('mssql');

const mssqlPool = new sql.ConnectionPool({
  user: process.env.MSSQL_USER, password: process.env.MSSQL_PASS,
  server: process.env.MSSQL_HOST, database: process.env.MSSQL_DB,
  options: { encrypt: false, trustServerCertificate: true }
});

// ─── ESL: ver todos os campos de comprovante ──────────────────
async function inspecionarEslComprovantes() {
  const tenant = process.env.ESL_TENANT;
  const tokens = [
    { nome: 'ATALANTA', token: process.env.ESL_TOKEN_ATALANTA },
    { nome: 'VILLE',    token: process.env.ESL_TOKEN_VILLE    },
  ];
  const since = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    .toISOString().split('.')[0] + '-03:00';

  for (const { nome, token } of tokens) {
    // invoice_occurrences — campo document_number e receiver
    const urlOc = `https://${tenant}.eslcloud.com.br/api/customer/invoice_occurrences?since=${since}`;
    const rOc = await fetch(urlOc, {
      headers: { Authorization: `Bearer ${token}`, tenant, Accept: 'application/json' }
    });
    if (!rOc.ok) { console.log(`ESL ${nome} OC: HTTP ${rOc.status}`); continue; }
    const jOc = await rOc.json();
    const ocs = (jOc.data || []);

    const docs = new Map();
    for (const oc of ocs) {
      const doc = oc.document_number ?? '(undefined)';
      const rec = oc.receiver ?? '(undefined)';
      const key = `doc="${doc}" | receiver="${rec}"`;
      docs.set(key, (docs.get(key) || 0) + 1);
    }

    console.log(`\nESL ${nome} — invoice_occurrences (${ocs.length} total):`);
    console.log('Valores únicos de document_number + receiver:');
    [...docs.entries()].sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
      console.log(`  ${v}x  ${k}`);
    });

    // freight_invoice_delivery_receipts — ver campos disponíveis
    const urlComp = `https://${tenant}.eslcloud.com.br/api/customer/freight_invoice_delivery_receipts?since=${since}`;
    const rComp = await fetch(urlComp, {
      headers: { Authorization: `Bearer ${token}`, tenant, Accept: 'application/json' }
    });
    if (!rComp.ok) { console.log(`ESL ${nome} COMP: HTTP ${rComp.status}`); continue; }
    const jComp = await rComp.json();
    const comps = (jComp.data || []).slice(0, 5);

    console.log(`\nESL ${nome} — freight_invoice_delivery_receipts (${jComp.data?.length} total) — amostra:`);
    for (const c of comps) {
      console.log('  Chaves disponíveis:', Object.keys(c).join(', '));
      console.log('  receiver:', c.receiver);
      console.log('  document_number:', c.document_number);
      // Mostrar todos os campos com valor não nulo
      const naoNulos = Object.entries(c).filter(([,v]) => v !== null && v !== undefined && v !== '');
      console.log('  Campos não nulos:', naoNulos.map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(' | '));
      console.log('');
    }
  }
}

// ─── QEDB: ver campos de comprovante ─────────────────────────
async function inspecionarQedbComprovantes() {
  const ocs = await buscarOcorrenciasQedb({
    clientId: process.env.QEDB_CLIENT_ID,
    token:    process.env.QEDB_TOKEN,
    baseUrl:  process.env.QEDB_BASE_URL,
  });

  console.log(`\nQEDB — ${ocs.length} ocorrências:`);

  // Campos que podem conter info de comprovante
  const camposComprovante = ['entregue','recebedor','receptor','cpf','cnpj','documento','nomeRecebedor','assinatura','comprovante'];
  const presentes = camposComprovante.filter(c => ocs.some(o => o[c] !== undefined));
  console.log('Campos de comprovante presentes:', presentes.length ? presentes.join(', ') : 'NENHUM');

  // Mostrar todas as chaves de 3 amostras
  const amostras = ocs.filter(o => o.codigoOcorrencia === '01' || o.codigoOcorrencia === '02').slice(0, 3);
  for (const oc of amostras) {
    console.log(`\n  OC cod=${oc.codigoOcorrencia} nf=${oc.numeroNF}:`);
    console.log('  Todas as chaves:', Object.keys(oc).join(', '));
    // Mostrar campos não nulos
    const naoNulos = Object.entries(oc).filter(([,v]) =>
      v !== null && v !== undefined && v !== '' &&
      typeof v !== 'object'
    );
    console.log('  Valores:', naoNulos.map(([k,v]) => `${k}=${v}`).join(' | '));
  }
}

// ─── BRUDAM: ver campos entrega_rg/nome das ocorrências ──────
async function inspecionarBrudamComprovantes() {
  await mssqlPool.connect();

  // Pegar algumas chaves recentes com entrega confirmada
  const result = await mssqlPool.request().query(`
    SELECT TOP 5 F2_CHVNFE FROM SF2030
    WHERE D_E_L_E_T_ = ''
      AND F2_EMISSAO >= CONVERT(VARCHAR(8), DATEADD(DAY, -5, GETDATE()), 112)
      AND LEN(LTRIM(RTRIM(F2_CHVNFE))) = 44
      AND F2_CHVNFE NOT LIKE '%[^0-9]%'
  `);
  const chaves = result.recordset.map(r => r.F2_CHVNFE);
  if (!chaves.length) { console.log('\nBrudam: sem chaves recentes'); return; }

  // Buscar na API Brudam
  const authUrl = process.env.BRUDAM_AUTH_URL || 'https://acertaexpress.brudam.com.br/api/v1/acesso/auth/login';
  const baseUrl = 'https://acertaexpress.brudam.com.br';
  const user = process.env.BRUDAM_ACERTA_USER1;
  const pass = process.env.BRUDAM_ACERTA_PASS1;

  const authResp = await axios.post(authUrl, { usuario: user, senha: pass },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
  const token = authResp.data?.token || authResp.data?.tokenjwt;
  if (!token) { console.log('Brudam: token não obtido'); return; }

  const url = `${baseUrl}/api/v1/tracking/ocorrencias/nfe?chave=${chaves.join(',')}&comprovante=1`;
  const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
  const itens = Array.isArray(resp.data?.dados) ? resp.data.dados :
                Array.isArray(resp.data?.data)  ? resp.data.data  :
                Array.isArray(resp.data)         ? resp.data       : [];

  console.log(`\nBrudam ACERTA — ${itens.length} itens retornados:`);
  const camposDoc = new Map();
  for (const item of itens) {
    const ocs = item.ocorrencias || item.tracking || item.dados || [];
    for (const oc of ocs) {
      const rg  = oc.entrega_rg  ?? oc.entregaRg  ?? '(ausente)';
      const nom = oc.entrega_nome ?? oc.entregaNome ?? '(ausente)';
      if (rg !== '(ausente)') {
        const k = `rg="${rg}"`;
        camposDoc.set(k, (camposDoc.get(k) || 0) + 1);
      }
    }
  }

  console.log('Valores únicos de entrega_rg:');
  [...camposDoc.entries()].sort((a,b) => b[1]-a[1]).slice(0, 30).forEach(([k,v]) => {
    console.log(`  ${v}x  ${k}`);
  });
}

async function main() {
  try { await inspecionarEslComprovantes(); } catch(e) { console.error('ESL erro:', e.message); }
  try { await inspecionarQedbComprovantes(); } catch(e) { console.error('QEDB erro:', e.message); }
  try { await inspecionarBrudamComprovantes(); } catch(e) { console.error('Brudam erro:', e.message); }
  await mssqlPool.close().catch(() => {});
}

main().catch(console.error);