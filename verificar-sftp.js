// etl/verificar-sftp.js
// Verificador de saúde da ingestão SFTP (PVN e QEDB): conta CT-e por fonte no
// banco e confirma se o dado está entrando. Uso: node verificar-sftp.js
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { CNPJ_PRIORIDADE } = require('./xml-completo');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const NOME_CNPJ = { '12270745': 'PVN', '19355089': 'DDM', '26510120': 'QEDB', '28486039': 'ACERTA' };

// Varre em páginas (o ilike em coluna texto grande estoura o timeout do PostgREST).
async function contarPorCnpj() {
  const cont = {}; let comXml = 0, semMarca = 0, from = 0;
  const alvos = Object.keys(NOME_CNPJ);
  while (true) {
    const { data, error } = await sb
      .from('tms_monitoramento_entregas')
      .select('xml_completo')
      .not('xml_completo', 'is', null)
      .range(from, from + 499);
    if (error) throw new Error(error.message);
    if (!data.length) break;
    for (const r of data) {
      const x = r.xml_completo || '';
      comXml++;
      const achou = alvos.find(c => x.includes(c));
      if (achou) cont[achou] = (cont[achou] || 0) + 1; else semMarca++;
    }
    if (data.length < 500) break;
    from += 500;
  }
  return { cont, comXml, semMarca };
}

(async () => {
  console.log('Verificando ingestão de CT-e (xml_completo)...\n');
  const { cont, comXml, semMarca } = await contarPorCnpj();

  console.log('Linhas com xml_completo por fonte (CNPJ do emitente no XML):');
  for (const [cnpj, nome] of Object.entries(NOME_CNPJ)) {
    console.log('  ' + nome.padEnd(8), (cont[cnpj] || 0).toString().padStart(6), '  (CNPJ ' + cnpj + ')');
  }
  if (semMarca) console.log('  ' + '(outro)'.padEnd(8), semMarca.toString().padStart(6), '  CNPJ fora da lista de precedência');
  console.log('  ' + '-'.repeat(24));
  console.log('  ' + 'TOTAL'.padEnd(8), comXml.toString().padStart(6));

  console.log('\nPVN:', (cont['12270745'] || 0) > 0 ? 'RECEBENDO ✓' : 'sem dados ainda');
  console.log('QEDB:', (cont['26510120'] || 0) > 0 ? 'RECEBENDO ✓' : 'sem dados ainda (Quality não enviou)');
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
