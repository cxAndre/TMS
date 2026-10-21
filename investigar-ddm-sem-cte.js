// etl/investigar-ddm-sem-cte.js
// Diagnóstico SOMENTE LEITURA: as NF-e da DDM que estão no banco SEM CT-e
// pertencem a outra transportadora? Para cada uma, cruza:
//   1) Protheus (SF2 + SA4): transportadora e redespacho da nota hoje, e se a
//      nota foi cancelada/excluída (D_E_L_E_T_ ou SF3.F3_DTCANC);
//   2) banco: algum CT-e de outra transportadora (xml_completo de qualquer linha)
//      cita essa NF-e? e as pernas em tms_ctes;
//   3) API Brudam da ACERTA: tem CT-e para a nota?
// Não grava nada. Uso: node investigar-ddm-sem-cte.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const { criarClienteCteBrudam, LIMITE_CHAVES } = require('./cte-brudam');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const NOME_CNPJ = { '12270745': 'PVN', '19355089': 'DDM', '26510120': 'QUALITY', '28486039': 'ACERTA' };
const EMPRESAS = [{ sufixo: '030', empresa_id: 'VILLE' }, { sufixo: '010', empresa_id: 'ATALANTA' }];
const DDM = 'BRUDAM-DDMLOG';
const EXEMPLOS = 5;

const nomeCnpj = c => NOME_CNPJ[String(c || '').replace(/\D/g, '').slice(0, 8)] || null;
const contar = l => { const c = {}; for (const k of l) c[k] = (c[k] || 0) + 1; return c; };
const mes = chave => `${chave.slice(4, 6)}/20${chave.slice(2, 4)}`;

async function paginar(montar) {
  const tudo = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await montar().range(from, from + 499);
    if (error) throw new Error(error.message);
    tudo.push(...data);
    if (data.length < 500) return tudo;
  }
}

async function consultarProtheus(chaves) {
  const pool = await new sql.ConnectionPool({
    user: process.env.MSSQL_USER, password: process.env.MSSQL_PASS,
    server: process.env.MSSQL_HOST, database: process.env.MSSQL_DB,
    port: parseInt(process.env.MSSQL_PORT || '1433', 10),
    connectionTimeout: 30000, requestTimeout: 300000,
    options: { encrypt: false, trustServerCertificate: true },
  }).connect();
  const notas = new Map(), canceladas = new Set();
  try {
    for (let i = 0; i < chaves.length; i += 200) {
      const lista = chaves.slice(i, i + 200).map(c => `'${c}'`).join(',');
      for (const { sufixo, empresa_id } of EMPRESAS) {
        const r = await pool.request().query(`
          SELECT f.F2_CHVNFE AS chave, f.D_E_L_E_T_ AS del, f.R_E_C_N_O_ AS recno, f.F2_EMISSAO AS emissao,
                 LTRIM(RTRIM(f.F2_TRANSP)) AS transp, LTRIM(RTRIM(f.F2_REDESP)) AS redesp,
                 LTRIM(RTRIM(t.A4_NOME)) AS nome_transp, LTRIM(RTRIM(t.A4_CGC)) AS cgc_transp,
                 LTRIM(RTRIM(r.A4_NOME)) AS nome_redesp, LTRIM(RTRIM(r.A4_CGC)) AS cgc_redesp
          FROM SF2${sufixo} f
          OUTER APPLY (SELECT TOP 1 A4_NOME, A4_CGC FROM SA4${sufixo} WHERE A4_COD = f.F2_TRANSP AND D_E_L_E_T_ = '') t
          OUTER APPLY (SELECT TOP 1 A4_NOME, A4_CGC FROM SA4${sufixo} WHERE A4_COD = f.F2_REDESP AND D_E_L_E_T_ = '') r
          WHERE f.F2_CHVNFE IN (${lista})`);
        for (const n of r.recordset) {
          const k = String(n.chave).trim();
          const atual = notas.get(k);
          // prefere o registro ativo; entre iguais, o mais recente
          if (!atual || (atual.del && !n.del.trim()) || (!!atual.del === !!n.del.trim() && n.recno > atual.recno)) {
            notas.set(k, { ...n, del: n.del.trim(), empresa_id });
          }
        }
        try {
          const c = await pool.request().query(`
            SELECT DISTINCT F3_CHVNFE AS chave FROM SF3${sufixo}
            WHERE F3_CHVNFE IN (${lista}) AND D_E_L_E_T_ = '' AND LTRIM(RTRIM(F3_DTCANC)) <> ''`);
          for (const x of c.recordset) canceladas.add(String(x.chave).trim());
        } catch { /* SF3 sem F3_CHVNFE nesta base: segue só com o SF2 */ }
      }
    }
  } finally { await pool.close(); }
  return { notas, canceladas };
}

async function consultarAcerta(chaves) {
  const cfg = require('./transportadoras.json').transportadoras.find(t => /ACERTA/i.test(t.name));
  const accounts = (cfg?.accounts || [])
    .map(a => ({ user: process.env[a.user_env], pass: process.env[a.pass_env] })).filter(a => a.user && a.pass);
  if (!accounts.length) return null;
  const cli = criarClienteCteBrudam({ base: cfg.base, authUrl: cfg.auth_url, accounts });
  const achadas = new Map();
  for (let i = 0; i < chaves.length; i += LIMITE_CHAVES) {
    try { for (const [k, v] of await cli.buscar(chaves.slice(i, i + LIMITE_CHAVES))) achadas.set(k, v); }
    catch { /* lote falhou: conta como não encontrado */ }
  }
  return achadas;
}

(async () => {
  console.log('Investigando NF-e da DDM sem CT-e...\n');
  const alvos = await paginar(() => sb.from('tms_monitoramento_entregas')
    .select('chave_nfe, empresa_id, filial, ultima_ocorrencia_descricao, ultima_ocorrencia_data')
    .eq('ingest_source', DDM).is('xml_completo', null));
  const chaves = [...new Set(alvos.map(a => a.chave_nfe).filter(c => /^\d{44}$/.test(c)))];
  const alvo = new Set(chaves);
  console.log(`NF-e da DDM sem CT-e no banco: ${chaves.length}`);
  console.log(`  por mês de emissão: ${JSON.stringify(contar(chaves.map(mes)))}`);
  console.log(`  última ocorrência: ${JSON.stringify(contar(alvos.map(a => (a.ultima_ocorrencia_descricao || '-').slice(0, 40))))}\n`);
  if (!chaves.length) process.exit(0);

  // 1) Protheus
  process.stdout.write('1/3 Protheus... ');
  const { notas, canceladas } = await consultarProtheus(chaves);
  console.log('ok');

  // 2) CT-e de outra transportadora no banco que cite a nota + pernas em tms_ctes
  process.stdout.write('2/3 CT-e no banco... ');
  const cteOutra = new Map();
  for (let from = 0; ; from += 500) {
    const { data, error } = await sb.from('tms_monitoramento_entregas').select('xml_completo')
      .not('xml_completo', 'is', null).range(from, from + 499);
    if (error) throw new Error(error.message);
    for (const { xml_completo: x } of data) {
      const emit = nomeCnpj((x.match(/<emit>[\s\S]*?<CNPJ>(\d{14})<\/CNPJ>/) || [])[1]) || '(outro)';
      for (const m of x.matchAll(/<chave>(\d{44})<\/chave>/g)) {
        if (alvo.has(m[1])) (cteOutra.get(m[1]) || cteOutra.set(m[1], new Set()).get(m[1])).add(emit);
      }
    }
    if (data.length < 500) break;
  }
  const pernas = new Map();
  for (let i = 0; i < chaves.length; i += 100) {
    const { data, error } = await sb.from('tms_ctes').select('chave_nfe, cnpj_transportador, papel, ingest_source')
      .in('chave_nfe', chaves.slice(i, i + 100));
    if (error) { console.log(`(tms_ctes indisponível: ${error.message}) `); break; }
    for (const p of data) {
      const n = nomeCnpj(p.cnpj_transportador) || p.ingest_source || '?';
      if (n !== 'DDM') (pernas.get(p.chave_nfe) || pernas.set(p.chave_nfe, new Set()).get(p.chave_nfe)).add(`${n}/${p.papel}`);
    }
  }
  console.log('ok');

  // 3) ACERTA na Brudam
  process.stdout.write('3/3 API Brudam ACERTA... ');
  const acerta = await consultarAcerta(chaves);
  console.log(acerta ? 'ok\n' : 'sem credencial da ACERTA no .env\n');

  // Classificação: a primeira razão que se aplica.
  const motivo = {}, exemplos = {}, transpProtheus = [];
  for (const k of chaves) {
    const n = notas.get(k);
    const transp = n ? (nomeCnpj(n.cgc_transp) || n.nome_transp || n.transp || '(vazio)') : null;
    const redesp = n && n.redesp ? (nomeCnpj(n.cgc_redesp) || n.nome_redesp || n.redesp) : null;
    if (n) transpProtheus.push(`${transp}${redesp ? ' → redespacho ' + redesp : ''}`);
    let m;
    if (!n) m = 'nota não encontrada no Protheus';
    else if (n.del || canceladas.has(k)) m = 'nota cancelada/excluída no Protheus';
    else if (cteOutra.has(k)) m = `CT-e de outra transportadora no banco: ${[...cteOutra.get(k)].join('+')}`;
    else if (acerta?.has(k)) m = 'ACERTA tem CT-e na Brudam (ainda não gravado)';
    else if (transp !== 'DDM') m = `Protheus aponta outra transportadora hoje: ${transp}`;
    else if (redesp && redesp !== 'DDM') m = `DDM com redespacho para ${redesp}`;
    else if (pernas.has(k)) m = `outra perna em tms_ctes: ${[...pernas.get(k)].join('+')}`;
    else m = 'só DDM: nenhuma outra transportadora em lugar nenhum';
    motivo[m] = (motivo[m] || 0) + 1;
    (exemplos[m] || (exemplos[m] = [])).length < EXEMPLOS && exemplos[m].push(k);
  }

  console.log('Transportadora no Protheus (F2_TRANSP → redespacho):');
  for (const [t, q] of Object.entries(contar(transpProtheus)).sort((a, b) => b[1] - a[1])) console.log(`  ${String(q).padStart(4)}× ${t}`);
  console.log('\nResultado por nota:');
  for (const [m, q] of Object.entries(motivo).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(q).padStart(4)}× ${m}`);
    console.log(`        ex.: ${exemplos[m].join(', ')}`);
  }
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
