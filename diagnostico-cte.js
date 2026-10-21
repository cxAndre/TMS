// etl/diagnostico-cte.js
// Diagnóstico SOMENTE LEITURA do CT-e (nada é gravado no banco nem movido no SFTP):
//   1) DDM: pergunta à API Brudam (/dfe/cte/nota), conta a conta, se o XML do CT-e
//      das NF-e da DDM está sendo liberado, e compara com o que temos no banco.
//   2) Todas as transportadoras: valida o xml_completo gravado (CT-e completo,
//      autorizado, chave, frete, emissão e se a NF-e da linha está no CT-e).
// Não imprime credenciais nem XML — a saída pode ser compartilhada.
// Uso: node diagnostico-cte.js            (tudo)
//      node diagnostico-cte.js ddm        (só a parte 1)
//      node diagnostico-cte.js xml        (só a parte 2)
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const NOME_CNPJ = { '12270745': 'PVN', '19355089': 'DDM', '26510120': 'QUALITY', '28486039': 'ACERTA' };
const DDM_MAX_NOTAS = 500;   // NF-e mais recentes da DDM consultadas na API
const EXEMPLOS = 3;          // chaves de exemplo por tipo de problema

const tag = (xml, nome) => (xml.match(new RegExp(`<${nome}>([^<]+)</${nome}>`)) || [])[1] || null;
const fmt = d => d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-';
const mes = d => d ? String(d).slice(0, 7) : '?';

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

// ─── PARTE 1: DDM × API BRUDAM ───────────────────────────────────────────────
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

async function diagnosticoDdm() {
  console.log('════ PARTE 1 — DDM: o XML do CT-e está vindo da API Brudam? ════\n');
  const cfg = require('./transportadoras.json').transportadoras.find(t => /DDM/i.test(t.name));
  if (!cfg) { console.log('DDM não encontrada em transportadoras.json'); return; }

  // NF-e da DDM no banco (mais recentes primeiro).
  const { data: linhas, error } = await sb.from('tms_monitoramento_entregas')
    .select('chave_nfe, xml_completo, ultima_ocorrencia_data')
    .eq('ingest_source', cfg.name)
    .order('ultima_ocorrencia_data', { ascending: false, nullsFirst: false })
    .limit(DDM_MAX_NOTAS);
  if (error) throw new Error(error.message);
  console.log(`NF-e da DDM no banco (ingest_source=${cfg.name}): ${linhas.length} (as ${DDM_MAX_NOTAS} mais recentes no máx.)`);
  if (!linhas.length) return;

  const noBanco = { DDM: 0, outra: 0, vazio: 0 };
  for (const l of linhas) {
    if (!l.xml_completo) noBanco.vazio++;
    else if (fonteDoXml(l.xml_completo) === 'DDM') noBanco.DDM++;
    else noBanco.outra++;
  }
  console.log(`  no banco: ${noBanco.DDM} com XML da DDM | ${noBanco.outra} com XML de outra transp. | ${noBanco.vazio} SEM XML\n`);

  const chaves = linhas.map(l => l.chave_nfe).filter(c => /^\d{44}$/.test(c));
  for (const [i, acc] of cfg.accounts.entries()) {
    const user = process.env[acc.user_env], pass = process.env[acc.pass_env];
    const rot = `Conta ${i + 1} (${acc.user_env})`;
    if (!user || !pass) { console.log(`${rot}: credencial ausente no .env`); continue; }
    const auth = await autenticar(cfg.auth_url, user, pass);
    if (!auth.token) { console.log(`${rot}: LOGIN FALHOU (HTTP ${auth.http}${auth.msg ? ' — ' + auth.msg : ''})`); continue; }

    const status = {}, msgs = {}, httpErros = {};
    const xmlsApi = [];
    for (let j = 0; j < chaves.length; j += 50) {
      const lote = chaves.slice(j, j + 50);
      const r = await axios.get(`${cfg.base}/api/v1/dfe/cte/nota?chave_nfe=${lote.join(',')}`, {
        headers: { Authorization: `Bearer ${auth.token}` }, timeout: 60000, validateStatus: () => true,
      });
      if (r.status >= 400) { httpErros[r.status] = (httpErros[r.status] || 0) + 1; continue; }
      const itens = Array.isArray(r.data?.data) ? r.data.data : [];
      if (!itens.length && r.data?.message) msgs[r.data.message] = (msgs[r.data.message] || 0) + 1;
      for (const it of itens) {
        status[it.status] = (status[it.status] || 0) + 1;
        const m = it.message || it.mensagem || it.msg;
        if (it.status !== 1 && m) msgs[m] = (msgs[m] || 0) + 1;
        if (it.status === 1 && it.xml) {
          try { xmlsApi.push(Buffer.from(it.xml, 'base64').toString('utf-8')); } catch {}
        }
      }
    }

    // Quais NF-e a API cobre, e o que temos no banco para elas.
    const cobertas = new Set(chaves.filter(c => xmlsApi.some(x => x.includes(c))));
    const faltandoNoBanco = linhas.filter(l => cobertas.has(l.chave_nfe) && (!l.xml_completo || fonteDoXml(l.xml_completo) !== 'DDM'));
    const validos = xmlsApi.map(x => validarXml(x));
    const emis = validos.map(v => v.dhEmi).filter(Boolean).sort();
    const porMes = {};
    for (const v of validos) porMes[mes(v.dhEmi)] = (porMes[mes(v.dhEmi)] || 0) + 1;
    const ruins = validos.filter(v => v.problemas.length);
    const emitentes = {};
    for (const v of validos) emitentes[v.fonte] = (emitentes[v.fonte] || 0) + 1;

    console.log(`${rot}: login OK`);
    console.log(`  itens por status da API: ${JSON.stringify(status)}  (1 = XML liberado)`);
    if (Object.keys(httpErros).length) console.log(`  erros HTTP por lote: ${JSON.stringify(httpErros)}`);
    if (Object.keys(msgs).length) console.log(`  mensagens da API: ${JSON.stringify(msgs)}`);
    console.log(`  CT-e com XML recebidos: ${xmlsApi.length} | NF-e cobertas: ${cobertas.size} de ${chaves.length}`);
    if (xmlsApi.length) {
      console.log(`  emitente dos XML: ${JSON.stringify(emitentes)}`);
      console.log(`  emissão: de ${fmt(emis[0])} até ${fmt(emis[emis.length - 1])} | por mês: ${JSON.stringify(porMes)}`);
      console.log(`  XML da API com problema: ${ruins.length}` + (ruins.length ? ` → ${JSON.stringify(contar(ruins.flatMap(v => v.problemas)))}` : ''));
      console.log(`  NF-e com XML na API mas NÃO gravado como DDM no banco: ${faltandoNoBanco.length}` +
        (faltandoNoBanco.length ? `  ex.: ${faltandoNoBanco.slice(0, EXEMPLOS).map(l => l.chave_nfe).join(', ')}` : ''));
    }
    console.log('');
  }
}

// ─── PARTE 2: VALIDAÇÃO DO xml_completo DE TODAS ─────────────────────────────
function contar(lista) { const c = {}; for (const k of lista) c[k] = (c[k] || 0) + 1; return c; }

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
      const s = por[f] || (por[f] = { linhas: 0, ok: 0, ctes: new Set(), problemas: {}, exemplos: {}, tipos: {}, meses: {}, origem: {}, frete: 0 });
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
      if (v.vTPrest > 0) s.frete += v.vTPrest;
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
  if (modo !== 'xml') await diagnosticoDdm();
  if (modo !== 'ddm') await diagnosticoXml();
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
