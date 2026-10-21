// etl/verificar-ingestao.js
// Diagnóstico SOMENTE LEITURA da ingestão de CT-e (xml_completo) por transportadora:
// quantos CT-e, emissão do mais recente e última gravação no banco.
// Não imprime credenciais — a saída pode ser compartilhada. Uso: node verificar-ingestao.js
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const NOME_CNPJ = { '12270745': 'PVN', '19355089': 'DDM', '26510120': 'QUALITY', '28486039': 'ACERTA' };
const DIAS_RECENTES = 10;

const tag = (xml, nome) => (xml.match(new RegExp(`<${nome}>([^<]+)</${nome}>`)) || [])[1] || null;

// Transportadora pelo CNPJ do emitente; se não achar, pelo CNPJ em qualquer parte do XML.
function fonteDoXml(xml) {
  const emit = (xml.match(/<emit>[\s\S]*?<CNPJ>(\d{14})<\/CNPJ>/) || [])[1];
  if (emit && NOME_CNPJ[emit.slice(0, 8)]) return NOME_CNPJ[emit.slice(0, 8)];
  const achou = Object.keys(NOME_CNPJ).find(c => xml.includes(c));
  return achou ? NOME_CNPJ[achou] : '(outro)';
}

// atualizado_em pode não existir em todo ambiente: tenta com ela, cai para sem.
async function buscarPagina(from, comData) {
  const cols = comData ? 'chave_nfe, xml_completo, atualizado_em' : 'chave_nfe, xml_completo';
  return sb.from('tms_monitoramento_entregas').select(cols)
    .not('xml_completo', 'is', null).range(from, from + 499);
}

const fmt = d => d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-';
const dia = d => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

(async () => {
  console.log('Verificando ingestão de CT-e (xml_completo)...\n');
  let comData = true, from = 0;
  const por = {};
  const corte = Date.now() - DIAS_RECENTES * 864e5;

  while (true) {
    let { data, error } = await buscarPagina(from, comData);
    if (error && comData && /atualizado_em/.test(error.message)) {
      comData = false;
      ({ data, error } = await buscarPagina(from, comData));
    }
    if (error) throw new Error(error.message);
    if (!data.length) break;

    for (const r of data) {
      const x = r.xml_completo || '';
      const f = fonteDoXml(x);
      const s = por[f] || (por[f] = { linhas: 0, ctes: new Set(), ultEmi: null, ultEmiNct: null, ultGrav: null, porDia: {} });
      s.linhas++;
      const chCte = tag(x, 'chCTe');
      const nct = tag(x, 'nCT');
      if (chCte || nct) s.ctes.add(chCte || nct);
      const emi = tag(x, 'dhEmi');
      if (emi && (!s.ultEmi || new Date(emi) > new Date(s.ultEmi))) { s.ultEmi = emi; s.ultEmiNct = nct; }
      if (r.atualizado_em) {
        if (!s.ultGrav || new Date(r.atualizado_em) > new Date(s.ultGrav)) s.ultGrav = r.atualizado_em;
        if (new Date(r.atualizado_em).getTime() >= corte) {
          const k = dia(r.atualizado_em);
          s.porDia[k] = (s.porDia[k] || 0) + 1;
        }
      }
    }
    if (data.length < 500) break;
    from += 500;
  }

  const ordem = ['PVN', 'DDM', 'QUALITY', 'ACERTA', '(outro)'].filter(n => por[n]);
  for (const n of Object.values(NOME_CNPJ)) if (!por[n]) console.log(`${n.padEnd(8)} SEM NENHUM CT-e no banco`);

  console.log('\nTransp.   linhas  CT-e   emissão do CT-e mais recente (nCT)      última gravação da linha');
  for (const n of ordem) {
    const s = por[n];
    console.log(
      n.padEnd(8),
      String(s.linhas).padStart(6),
      String(s.ctes.size).padStart(6),
      ' ', (fmt(s.ultEmi) + (s.ultEmiNct ? ` (${s.ultEmiNct})` : '')).padEnd(38),
      comData ? fmt(s.ultGrav) : '(coluna atualizado_em ausente)'
    );
  }

  if (comData) {
    console.log(`\nLinhas com CT-e gravadas/atualizadas por dia (últimos ${DIAS_RECENTES} dias):`);
    for (const n of ordem) {
      const dias = Object.entries(por[n].porDia).sort((a, b) =>
        a[0].split('/').reverse().join('').localeCompare(b[0].split('/').reverse().join('')));
      console.log('  ' + n.padEnd(8), dias.length ? dias.map(([d, q]) => `${d.slice(0, 5)}=${q}`).join('  ') : 'nenhuma');
    }
    console.log('\nObs.: ACERTA/DDM têm a linha atualizada a cada execução do ETL (rastreio), então');
    console.log('"última gravação" delas não significa CT-e novo. Para PVN/QUALITY (SFTP) significa.');
  }
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
