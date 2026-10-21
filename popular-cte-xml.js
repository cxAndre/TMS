// etl/popular-cte-xml.js
// Preenche tms_cte_xml / tms_cte_nfe (um CT-e por perna) com o histórico.
// Não mexe em xml_completo nem na linha principal das NF-e.
//   1) banco: copia todo xml_completo existente (sem chamar API);
//   2) API Brudam: pergunta a cada transportadora (ACERTA, DDM) por TODAS as
//      NF-e do banco com CNPJ dela no Protheus (cnpj_transportador) — traz o
//      CT-e da ACERTA onde o da PVN tomou o xml_completo, e o da DDM nas NF-e
//      "ACERTA - DDMLOG" (28486039000341).
// Ao fim mostra quantas NF-e têm CT-e de mais de uma transportadora.
// Uso: node popular-cte-xml.js --simular      (só conta, NÃO grava nada)
//      node popular-cte-xml.js                (grava)
//      node popular-cte-xml.js --so-banco | --so-api | --so DDM
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const { criarClienteCteBrudam, LIMITE_CHAVES } = require('./cte-brudam');
const { gravarCteXml, dadosDoCte } = require('./xml-completo');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const args = process.argv.slice(2);
const SIMULAR = args.includes('--simular');
const SO_BANCO = args.includes('--so-banco');
const SO_API = args.includes('--so-api');
const SO = args.includes('--so') ? String(args[args.indexOf('--so') + 1] || '').toUpperCase() : null;
const logger = { warn: (o, m) => console.log(`\n  AVISO ${m}: ${o.err || ''}`) };

const transportadoras = require('./transportadoras.json').transportadoras;
const papelPorRaiz = Object.fromEntries(transportadoras.map(t => [t.cnpjs[0].slice(0, 8), t.papel || 'ENTREGA']));

// Estado para o resumo: NF-e → transportadoras com CT-e; CT-e já vistos.
const legsPorNfe = new Map();
const ctesVistos = new Set();
const resumo = { banco_linhas: 0, banco_ctes: 0 };
function registrar(itens) {
  let novos = 0;
  for (const it of itens) {
    const d = dadosDoCte(it.xml);
    if (!d.chave_cte) continue;
    if (!ctesVistos.has(d.chave_cte)) { ctesVistos.add(d.chave_cte); novos++; }
    (legsPorNfe.get(it.chave_nfe) || legsPorNfe.set(it.chave_nfe, new Set()).get(it.chave_nfe)).add(d.transportadora || '(outro)');
  }
  return novos;
}
async function gravar(itens) { if (!SIMULAR && itens.length) await gravarCteXml(sb, itens, logger); }

async function doBanco() {
  console.log('1) Banco: copiando xml_completo');
  for (let from = 0; ; from += 500) {
    const { data, error } = await sb.from('tms_monitoramento_entregas')
      .select('empresa_id, filial, chave_nfe, ingest_source, xml_completo')
      .not('xml_completo', 'is', null).order('chave_nfe').range(from, from + 499);
    if (error) throw new Error(error.message);
    const itens = data.map(r => {
      const d = dadosDoCte(r.xml_completo);
      const brudam = transportadoras.find(t => t.cnpjs[0].slice(0, 8) === String(d.cnpj_emitente || '').slice(0, 8));
      return { xml: r.xml_completo, empresa_id: r.empresa_id, filial: r.filial, chave_nfe: r.chave_nfe,
               papel: papelPorRaiz[String(d.cnpj_emitente || '').slice(0, 8)] || 'ENTREGA',
               fonte: brudam ? brudam.name : (d.transportadora === 'QUALITY' ? 'QEDB' : d.transportadora) };
    });
    resumo.banco_linhas += data.length;
    resumo.banco_ctes += registrar(itens);
    await gravar(itens);
    process.stdout.write(`\r   ${resumo.banco_linhas} linhas, ${resumo.banco_ctes} CT-e`);
    if (data.length < 500) break;
  }
  console.log('\n');
}

async function daApi(t) {
  const cnpjs = t.cnpjs.map(c => c.replace(/\D/g, ''));
  console.log(`2) API ${t.name}: NF-e do banco com CNPJ ${cnpjs.join(', ')} no Protheus`);
  const alvos = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('tms_monitoramento_entregas')
      .select('empresa_id, filial, chave_nfe').in('cnpj_transportador', cnpjs)
      .order('chave_nfe').range(from, from + 999);
    if (error) throw new Error(error.message);
    alvos.push(...data);
    if (data.length < 1000) break;
  }
  const accounts = t.accounts.map(a => ({ user: process.env[a.user_env], pass: process.env[a.pass_env] })).filter(a => a.user && a.pass);
  const cli = criarClienteCteBrudam({ base: t.base, authUrl: t.auth_url, accounts });
  let comCte = 0, novos = 0, falhas = 0;
  for (let i = 0; i < alvos.length; i += LIMITE_CHAVES) {
    const lote = alvos.slice(i, i + LIMITE_CHAVES);
    let mapa = new Map();
    try { mapa = await cli.buscar(lote.map(r => r.chave_nfe)); } catch { falhas++; }
    const itens = lote.filter(r => mapa.get(r.chave_nfe)?.xml).map(r => ({
      xml: mapa.get(r.chave_nfe).xml, empresa_id: r.empresa_id, filial: r.filial, chave_nfe: r.chave_nfe,
      papel: t.papel || 'ENTREGA', fonte: t.name,
    }));
    comCte += itens.length;
    novos += registrar(itens);
    await gravar(itens);
    process.stdout.write(`\r   ${Math.min(i + LIMITE_CHAVES, alvos.length)}/${alvos.length} NF-e | com CT-e: ${comCte} | CT-e novos (fora do xml_completo): ${novos}${falhas ? ` | lotes com falha: ${falhas}` : ''}`);
  }
  console.log('\n');
}

(async () => {
  console.log(SIMULAR ? '*** SIMULAÇÃO: nada será gravado ***\n' : '*** GRAVANDO em tms_cte_xml / tms_cte_nfe ***\n');
  if (!SO_API) await doBanco();
  if (!SO_BANCO) for (const t of transportadoras) if (!SO || t.name.toUpperCase().includes(SO)) await daApi(t);

  const combos = {};
  for (const s of legsPorNfe.values()) { const k = [...s].sort().join(' + '); combos[k] = (combos[k] || 0) + 1; }
  console.log(`Resumo: ${ctesVistos.size} CT-e distintos em ${legsPorNfe.size} NF-e`);
  console.log('NF-e por transportadoras com CT-e:');
  for (const [k, q] of Object.entries(combos).sort((a, b) => b[1] - a[1])) console.log(`  ${String(q).padStart(6)}  ${k}`);
  console.log('(linhas com "+" = NF-e com mais de uma perna; antes só uma delas ficava no banco)');
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
