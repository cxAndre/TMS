// etl/diagnostico-cte.js
// Diagnóstico SOMENTE LEITURA do CT-e (nada é gravado no banco nem movido no SFTP):
//   1) Brudam (DDM e ACERTA): pergunta à API (/dfe/cte/nota), conta a conta, se o
//      XML do CT-e das NF-e está sendo liberado; simula a regra de contas antiga
//      e a nova; e compara NF-e a NF-e com o que temos no banco.
//   2) Todas as transportadoras: valida o xml_completo gravado (CT-e completo,
//      autorizado, chave, frete, emissão e se a NF-e da linha está no CT-e).
// Não imprime credenciais nem XML — a saída pode ser compartilhada.
// Uso: node diagnostico-cte.js                (tudo, 500 NF-e por transportadora)
//      node diagnostico-cte.js ddm [qtd]      (só DDM na API)
//      node diagnostico-cte.js acerta [qtd]   (só ACERTA na API)
//      node diagnostico-cte.js brudam [qtd]   (DDM e ACERTA na API)
//      node diagnostico-cte.js xml            (só a validação do banco)
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { buscarLoteCteBrudam, mapearCtePorNota, LIMITE_CHAVES } = require('./cte-brudam');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const NOME_CNPJ = { '12270745': 'PVN', '19355089': 'DDM', '26510120': 'QUALITY', '28486039': 'ACERTA' };
const EXEMPLOS = 3;          // chaves de exemplo por tipo de problema

const tag = (xml, nome) => (xml.match(new RegExp(`<${nome}>([^<]+)</${nome}>`)) || [])[1] || null;
const fmt = d => d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-';
const mes = d => d ? String(d).slice(0, 7) : '?';
const contar = lista => { const c = {}; for (const k of lista) c[k] = (c[k] || 0) + 1; return c; };
const ordenarObj = o => Object.fromEntries(Object.entries(o).sort());

function fonteDoXml(xml) {
  const emit = (xml.match(/<emit>[\s\S]*?<CNPJ>(\d{14})<\/CNPJ>/) || [])[1];
  if (emit && NOME_CNPJ[emit.slice(0, 8)]) return NOME_CNPJ[emit.slice(0, 8)];
  const achou = Object.keys(NOME_CNPJ).find(c => xml.includes(c));
  return achou ? NOME_CNPJ[achou] : '(outro)';
}

// Mesmas regras usadas na ingestão + o que o Monitor de Frete precisa ler.
function validarXml(xml, chaveNfe) {
  const x = (xml || '').trim();
  const p = [];
  const ehCte = x.includes('<CTe') || x.includes('cteProc');
  if (!ehCte) { p.push('nao_e_cte'); return { problemas: p }; }
  if (!/<\/cteProc>\s*$/.test(x) && !/<\/CTe>\s*$/.test(x)) p.push('xml_truncado');
  const cStat = (x.match(/<infProt[\s\S]*?<cStat>(\d+)<\/cStat>/) || [])[1] || null;
  if (!x.includes('<protCTe')) p.push('sem_protocolo');
  else if (cStat !== '100') p.push(`cStat_${cStat || '?'}`);
  const chCte = tag(x, 'chCTe') || ((x.match(/<infCte[^>]*Id="CTe(\d{44})"/) || [])[1] || null);
  if (!chCte || !/^\d{44}$/.test(chCte)) p.push('sem_chave_cte');
  const vTPrest = parseFloat(tag(x, 'vTPrest'));
  if (!(vTPrest > 0)) p.push('sem_valor_frete');
  const dhEmi = tag(x, 'dhEmi');
  if (!dhEmi) p.push('sem_emissao');
  if (chaveNfe && !x.includes(chaveNfe)) p.push('nfe_da_linha_nao_esta_no_cte');
  const tpCTe = tag(x, 'tpCTe');
  return { problemas: p, chCte, vTPrest, dhEmi, nCT: tag(x, 'nCT'), tpCTe, fonte: fonteDoXml(x) };
}

// ─── PARTE 1: BRUDAM × BANCO ─────────────────────────────────────────────────
async function autenticar(authUrl, user, pass) {
  const extrair = d => d?.data?.access_key || d?.token || d?.tokenjwt || d?.access_token || d?.data?.token || null;
  const cred = { usuario: user, senha: pass };
  let r = await axios.post(authUrl, cred, { headers: { 'Content-Type': 'application/json' }, timeout: 60000, validateStatus: () => true });
  let token = r.status < 400 ? extrair(r.data) : null;
  if (!token) {
    r = await axios.post(authUrl, new URLSearchParams(cred), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 60000, validateStatus: () => true });
    token = r.status < 400 ? extrair(r.data) : null;
  }
  return { token, http: r.status, msg: token ? null : (r.data?.message || r.data?.mensagem || null) };
}

// Consulta uma conta em lotes de 50 (mesmo endpoint e retry do ETL) e guarda,
// por lote, os itens crus — para simular as regras antiga e nova depois.
async function consultarConta(cfg, chaves, token) {
  const lotes = [];
  const httpErros = {};
  for (let j = 0; j < chaves.length; j += LIMITE_CHAVES) {
    const lote = chaves.slice(j, j + LIMITE_CHAVES);
    try { lotes.push({ chaves: lote, itens: await buscarLoteCteBrudam(lote, cfg.base, token) }); }
    catch (e) { httpErros[e.status || e.message] = (httpErros[e.status || e.message] || 0) + 1; lotes.push({ chaves: lote, itens: null }); }
  }
  return { lotes, httpErros };
}

async function diagnosticoBrudam(cfg, maxNotas) {
  const nome = /DDM/i.test(cfg.name) ? 'DDM' : /ACERTA/i.test(cfg.name) ? 'ACERTA' : cfg.name;
  console.log(`════ PARTE 1 — ${nome}: o XML do CT-e está vindo da API Brudam? ════\n`);

  // NF-e da transportadora no banco (mais recentes primeiro).
  const linhas = [];
  for (let from = 0; linhas.length < maxNotas; from += 500) {
    const { data, error } = await sb.from('tms_monitoramento_entregas')
      .select('chave_nfe, xml_completo, ultima_ocorrencia_data, ultima_ocorrencia_descricao')
      .eq('ingest_source', cfg.name)
      .order('ultima_ocorrencia_data', { ascending: false, nullsFirst: false })
      .range(from, Math.min(from + 499, maxNotas - 1));
    if (error) throw new Error(error.message);
    linhas.push(...data);
    if (data.length < 500) break;
  }
  const porChave = new Map(linhas.map(l => [l.chave_nfe, l]));
  const chaves = linhas.map(l => l.chave_nfe).filter(c => /^\d{44}$/.test(c));
  console.log(`NF-e no banco (ingest_source=${cfg.name}): ${linhas.length} mais recentes (máx. ${maxNotas})`);
  const situ = contar(linhas.map(l => !l.xml_completo ? 'sem XML' : fonteDoXml(l.xml_completo) === nome ? `XML da ${nome}` : 'XML de outra transp.'));
  console.log(`  hoje no banco: ${JSON.stringify(situ)}\n`);
  if (!chaves.length) return;

  // 1) Cada conta, isoladamente.
  const contas = [];
  for (const [i, acc] of cfg.accounts.entries()) {
    const rot = `Conta ${i + 1} (${acc.user_env})`;
    const user = process.env[acc.user_env], pass = process.env[acc.pass_env];
    if (!user || !pass) { console.log(`${rot}: credencial ausente no .env`); continue; }
    const auth = await autenticar(cfg.auth_url, user, pass);
    if (!auth.token) { console.log(`${rot}: LOGIN FALHOU (HTTP ${auth.http}${auth.msg ? ' — ' + auth.msg : ''})`); continue; }
    const { lotes, httpErros } = await consultarConta(cfg, chaves, auth.token);
    const itens = lotes.flatMap(l => l.itens || []);
    const mapa = new Map();
    for (const l of lotes) if (l.itens) for (const [k, v] of mapearCtePorNota(l.chaves, l.itens)) mapa.set(k, v);
    const msgs = contar(itens.filter(it => it.status !== 1).map(it => it.message || it.mensagem || it.msg || `status ${it.status}`));
    console.log(`${rot}: login OK`);
    console.log(`  itens por status: ${JSON.stringify(contar(itens.map(it => it.status)))}  (1 = XML liberado)`);
    if (Object.keys(msgs).length) console.log(`  motivos sem XML: ${JSON.stringify(msgs)}`);
    if (Object.keys(httpErros).length) console.log(`  lotes com erro HTTP (após 3 tentativas): ${JSON.stringify(httpErros)}`);
    console.log(`  NF-e com CT-e liberado por esta conta: ${mapa.size} de ${chaves.length}\n`);
    contas.push({ rot, lotes, mapa });
  }
  if (!contas.length) return;

  // 2) Regra ANTIGA (até 21/10): por lote, a 1ª conta que liberasse QUALQUER XML
  //    era usada sozinha. Regra NOVA: NF-e não cobertas seguem para a próxima conta.
  let cobertasAntiga = 0, lotesPerdidos = 0;
  for (let b = 0; b < contas[0].lotes.length; b++) {
    const escolhida = contas.find(c => (c.lotes[b].itens || []).some(it => it.status === 1 && it.xml)) || contas[contas.length - 1];
    const mapaLote = escolhida.lotes[b].itens ? mapearCtePorNota(escolhida.lotes[b].chaves, escolhida.lotes[b].itens) : new Map();
    const melhor = new Set(contas.flatMap(c => c.lotes[b].chaves.filter(k => c.mapa.has(k))));
    cobertasAntiga += mapaLote.size;
    if (melhor.size > mapaLote.size) lotesPerdidos++;
  }
  const mapaNovo = new Map();
  for (const c of contas) for (const [k, v] of c.mapa) if (!mapaNovo.has(k)) mapaNovo.set(k, v);
  const soNaConta = contar([...mapaNovo.keys()].map(k => contas.filter(c => c.mapa.has(k)).map(c => c.rot.split(' (')[0]).join(' + ')));
  console.log('Regra de contas:');
  console.log(`  ANTIGA (só 1 conta por lote): ${cobertasAntiga} NF-e com XML | lotes que perdiam NF-e: ${lotesPerdidos} de ${contas[0].lotes.length}`);
  console.log(`  NOVA (junta as contas):       ${mapaNovo.size} NF-e com XML`);
  console.log(`  quem libera: ${JSON.stringify(soNaConta)}\n`);

  // 3) NF-e a NF-e: o que a API tem × o que está no banco.
  const cmp = { igual: [], outro_cte_mesma_transp: [], outra_transp_no_banco: [], falta_no_banco: [] };
  const apiPorMes = {}, bancoPorMes = {};
  const ctesApi = new Map();
  for (const [k, { xml }] of mapaNovo) {
    const api = validarXml(xml, k);
    ctesApi.set(api.chCte, api);
    const l = porChave.get(k);
    if (!l?.xml_completo) cmp.falta_no_banco.push({ k, api });
    else {
      const db = validarXml(l.xml_completo, k);
      if (db.fonte !== nome) cmp.outra_transp_no_banco.push({ k, api, db });
      else if (db.chCte === api.chCte) cmp.igual.push({ k, api });
      else cmp.outro_cte_mesma_transp.push({ k, api, db });
    }
  }
  for (const l of linhas) if (l.xml_completo && fonteDoXml(l.xml_completo) === nome) {
    const v = validarXml(l.xml_completo);
    if (v.chCte) bancoPorMes[v.chCte] = mes(v.dhEmi);
  }
  for (const v of ctesApi.values()) apiPorMes[mes(v.dhEmi)] = (apiPorMes[mes(v.dhEmi)] || 0) + 1;
  const ruins = [...ctesApi.values()].filter(v => v.problemas.filter(p => p !== 'nfe_da_linha_nao_esta_no_cte').length);
  const emis = [...ctesApi.values()].map(v => v.dhEmi).filter(Boolean).sort();

  console.log('API × banco, NF-e a NF-e (regra nova):');
  console.log(`  CT-e distintos na API: ${ctesApi.size} | emissão de ${fmt(emis[0])} até ${fmt(emis[emis.length - 1])}`);
  console.log(`  CT-e por mês de emissão — API: ${JSON.stringify(ordenarObj(apiPorMes))}`);
  console.log(`                          banco: ${JSON.stringify(ordenarObj(contar(Object.values(bancoPorMes))))}`);
  console.log(`  XML da API com defeito: ${ruins.length}` + (ruins.length ? ` → ${JSON.stringify(contar(ruins.flatMap(v => v.problemas)))}` : ' (todos completos, autorizados, com chave, frete e emissão)'));
  console.log(`  ✓ banco já tem o MESMO CT-e da API:          ${cmp.igual.length}`);
  console.log(`  ✗ FALTA no banco (API tem, banco sem XML):    ${cmp.falta_no_banco.length}`);
  console.log(`  ! banco tem outro CT-e da ${nome} (≠ da API): ${cmp.outro_cte_mesma_transp.length}`);
  console.log(`  ~ banco tem XML de outra transp. (precedência): ${cmp.outra_transp_no_banco.length}` +
    (cmp.outra_transp_no_banco.length ? ` ${JSON.stringify(contar(cmp.outra_transp_no_banco.map(x => x.db.fonte)))}` : ''));
  if (cmp.falta_no_banco.length) {
    console.log(`  faltando por mês de emissão: ${JSON.stringify(ordenarObj(contar(cmp.falta_no_banco.map(x => mes(x.api.dhEmi)))))}`);
    console.log('  exemplos (NF-e → CT-e nº, emissão):');
    for (const x of cmp.falta_no_banco.slice(0, 5)) console.log(`    ${x.k} → ${x.api.nCT}, ${fmt(x.api.dhEmi)}`);
  }
  if (cmp.outro_cte_mesma_transp.length) {
    console.log('  exemplos de CT-e diferente (banco → API):');
    for (const x of cmp.outro_cte_mesma_transp.slice(0, 3)) console.log(`    ${x.k}: ${x.db.nCT} (${fmt(x.db.dhEmi)}) → ${x.api.nCT} (${fmt(x.api.dhEmi)})`);
  }

  // 4) NF-e sem CT-e em NENHUMA conta: são recentes (CT-e ainda não emitido)?
  const semCte = linhas.filter(l => !mapaNovo.has(l.chave_nfe));
  const idade = l => {
    if (!l.ultima_ocorrencia_data) return 'sem ocorrência';
    const d = (Date.now() - new Date(l.ultima_ocorrencia_data)) / 864e5;
    return d <= 3 ? 'até 3 dias' : d <= 15 ? '4 a 15 dias' : d <= 60 ? '16 a 60 dias' : 'mais de 60 dias';
  };
  console.log(`\nNF-e sem CT-e em nenhuma conta: ${semCte.length}`);
  if (semCte.length) {
    console.log(`  última ocorrência há: ${JSON.stringify(contar(semCte.map(idade)))}`);
    const top = Object.entries(contar(semCte.map(l => (l.ultima_ocorrencia_descricao || '(sem descrição)').slice(0, 40))))
      .sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  últimas ocorrências mais comuns: ${top.map(([d, q]) => `${d}=${q}`).join(' | ')}`);
    console.log(`  exemplos: ${semCte.slice(0, EXEMPLOS).map(l => l.chave_nfe).join(', ')}`);
  }
  console.log('');
}

// ─── PARTE 2: VALIDAÇÃO DO xml_completo DE TODAS ─────────────────────────────
async function diagnosticoXml() {
  console.log('════ PARTE 2 — xml_completo no banco: está correto? ════\n');
  const por = {};
  let from = 0;
  while (true) {
    const { data, error } = await sb.from('tms_monitoramento_entregas')
      .select('chave_nfe, ingest_source, xml_completo')
      .not('xml_completo', 'is', null)
      .range(from, from + 499);
    if (error) throw new Error(error.message);
    if (!data.length) break;
    for (const r of data) {
      const v = validarXml(r.xml_completo, r.chave_nfe);
      const f = v.fonte || '(nao_cte)';
      const s = por[f] || (por[f] = { linhas: 0, ok: 0, ctes: new Set(), problemas: {}, exemplos: {}, tipos: {}, meses: {}, origem: {} });
      s.linhas++;
      if (v.chCte) s.ctes.add(v.chCte);
      if (!v.problemas.length) s.ok++;
      for (const p of v.problemas) {
        s.problemas[p] = (s.problemas[p] || 0) + 1;
        const ex = s.exemplos[p] || (s.exemplos[p] = []);
        if (ex.length < EXEMPLOS) ex.push(r.chave_nfe);
      }
      if (v.tpCTe != null) s.tipos[v.tpCTe] = (s.tipos[v.tpCTe] || 0) + 1;
      if (v.dhEmi) s.meses[mes(v.dhEmi)] = (s.meses[mes(v.dhEmi)] || 0) + 1;
      s.origem[r.ingest_source || '-'] = (s.origem[r.ingest_source || '-'] || 0) + 1;
    }
    if (data.length < 500) break;
    from += 500;
  }

  const TIPO = { 0: 'normal', 1: 'complementar', 2: 'anulação', 3: 'substituto' };
  for (const n of ['PVN', 'DDM', 'QUALITY', 'ACERTA', '(outro)', '(nao_cte)'].filter(k => por[k])) {
    const s = por[n];
    const pct = (100 * s.ok / s.linhas).toFixed(1);
    console.log(`${n}: ${s.linhas} linhas | ${s.ctes.size} CT-e distintos | ${s.ok} OK (${pct}%)`);
    const meses = Object.entries(s.meses).sort().slice(-4).map(([m, q]) => `${m}=${q}`).join('  ');
    console.log(`  linhas por mês de emissão (últimos 4): ${meses || '-'}`);
    console.log(`  tipo de CT-e: ${Object.entries(s.tipos).map(([t, q]) => `${TIPO[t] || t}=${q}`).join('  ') || '-'}`);
    console.log(`  ingest_source da linha: ${JSON.stringify(s.origem)}`);
    if (Object.keys(s.problemas).length) {
      for (const [p, q] of Object.entries(s.problemas).sort((a, b) => b[1] - a[1])) {
        console.log(`  ✗ ${p}: ${q}   ex.: ${s.exemplos[p].join(', ')}`);
      }
    } else console.log('  ✓ nenhum problema encontrado');
    console.log('');
  }
  console.log('Legenda: nfe_da_linha_nao_esta_no_cte = o CT-e gravado não cita a NF-e da própria linha');
  console.log('(XML na linha errada); cStat_X = CT-e não autorizado (100 = autorizado);');
  console.log('xml_truncado = arquivo cortado; sem_valor_frete = sem vTPrest (o Monitor não consegue comparar).');
}

(async () => {
  const modo = (process.argv[2] || '').toLowerCase();
  const qtd = parseInt(process.argv[3] || '500', 10);
  const brudam = require('./transportadoras.json').transportadoras;
  const alvos = modo === 'ddm' ? brudam.filter(t => /DDM/i.test(t.name))
    : modo === 'acerta' ? brudam.filter(t => /ACERTA/i.test(t.name))
    : modo === 'xml' ? [] : brudam;
  for (const t of alvos) await diagnosticoBrudam(t, qtd);
  if (!['ddm', 'acerta', 'brudam'].includes(modo)) await diagnosticoXml();
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
