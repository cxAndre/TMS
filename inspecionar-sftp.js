// etl/inspecionar-sftp.js
// Inspeção SOMENTE LEITURA das pastas SFTP da PVN e da Quality (QEDB) no VPS:
// o que está esperando em upload/upload, o que já foi processado e o que foi
// para erro/ — e, para os arquivos de erro, o MOTIVO (lendo o próprio XML).
// Nada é movido, apagado ou gravado. Não imprime chave nem conteúdo do XML.
//
// Chave SSH: usa {PVN|QEDB}_SFTP_KEY do .env (texto ou base64) ou, se preferir,
// o caminho de um arquivo de chave em {PVN|QEDB}_SFTP_KEY_FILE.
// Uso: node inspecionar-sftp.js          (PVN e Quality)
//      node inspecionar-sftp.js pvn      (só PVN)
//      node inspecionar-sftp.js qedb     (só Quality)
'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const SftpClient = require('ssh2-sftp-client');
const { FONTES, extrairChavesNfe, xmlCompleto, ehCte, normalizarChave } = require('./cte-pvn-sftp');

const HOST_PADRAO = '31.97.23.238';
const PASTAS = ['upload/upload', 'processado', 'erro'];
const ULTIMOS = 5;           // arquivos mais recentes listados por pasta
const ANALISAR_ERROS = 30;   // arquivos de erro/ baixados para diagnóstico

const tag = (xml, nome) => (xml.match(new RegExp(`<${nome}>([^<]+)</${nome}>`)) || [])[1] || null;
const fmt = ms => new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

function carregarChave(P) {
  if (process.env[`${P}_KEY_FILE`]) return normalizarChave(fs.readFileSync(process.env[`${P}_KEY_FILE`], 'utf8'));
  if (process.env[`${P}_KEY`]) return normalizarChave(process.env[`${P}_KEY`]);
  return null;
}

// Por que o ETL recusaria este XML (mesmas regras do cte-pvn-sftp.js) + pistas.
function motivo(xml) {
  if (!ehCte(xml)) return 'não é CT-e';
  if (!xmlCompleto(xml)) return 'XML incompleto/truncado';
  if (!extrairChavesNfe(xml).length) {
    const TIPO = { 0: 'normal', 1: 'complementar', 2: 'anulação', 3: 'substituto' };
    const pistas = [];
    const tp = tag(xml, 'tpCTe');
    if (tp && tp !== '0') pistas.push(`CT-e ${TIPO[tp] || tp}`);
    if (xml.includes('<infCteComp')) pistas.push('complementa outro CT-e');
    if (xml.includes('<infNF>')) pistas.push('NF em papel (infNF, sem chave)');
    if (xml.includes('<infOutros')) pistas.push('outros documentos (infOutros)');
    if (/<chNFe>\d{44}<\/chNFe>/.test(xml)) pistas.push('chave em <chNFe> (tag que o ETL não lê)');
    if (/<[a-z]+:chave>/.test(xml)) pistas.push('tag <chave> com prefixo de namespace');
    return 'sem chave de NF-e' + (pistas.length ? ` → ${pistas.join('; ')}` : '');
  }
  return 'XML OK (provável: NF-e não existia no banco além do prazo de 24h)';
}

async function inspecionar(fonte) {
  const P = fonte.envPrefix;
  console.log(`════ ${fonte.tag === 'QEDB' ? 'QUALITY (QEDB)' : fonte.tag} — SFTP ════`);
  const privateKey = carregarChave(P);
  if (!privateKey) { console.log(`  sem chave: defina ${P}_KEY ou ${P}_KEY_FILE no .env\n`); return; }

  const cfg = {
    host: process.env[`${P}_HOST`] || HOST_PADRAO,
    port: parseInt(process.env[`${P}_PORT`] || '22', 10),
    username: process.env[`${P}_USER`] || fonte.userPadrao,
    privateKey,
    readyTimeout: 20000,
  };
  const sftp = new SftpClient();
  try {
    await sftp.connect(cfg);
    console.log(`  conectado em ${cfg.host}:${cfg.port} como ${cfg.username}`);

    for (const dir of PASTAS) {
      if (!(await sftp.exists(`/${dir}`))) { console.log(`\n  /${dir}: (pasta não existe)`); continue; }
      const xmls = (await sftp.list(`/${dir}`))
        .filter(f => f.type === '-' && /\.xml$/i.test(f.name))
        .sort((a, b) => b.modifyTime - a.modifyTime);
      const ultimo = xmls[0] ? fmt(xmls[0].modifyTime) : '-';
      console.log(`\n  /${dir}: ${xmls.length} XML | mais recente: ${ultimo}`);
      for (const f of xmls.slice(0, ULTIMOS)) console.log(`     ${fmt(f.modifyTime)}  ${f.name}`);

      if (dir === 'erro' && xmls.length) {
        const motivos = {};
        const exemplos = {};
        for (const f of xmls.slice(0, ANALISAR_ERROS)) {
          let m;
          try { m = motivo((await sftp.get(`/${dir}/${f.name}`)).toString('utf8')); }
          catch (e) { m = `falha ao ler: ${e.message}`; }
          motivos[m] = (motivos[m] || 0) + 1;
          if (!exemplos[m]) exemplos[m] = f.name;
        }
        console.log(`     motivo (nos ${Math.min(xmls.length, ANALISAR_ERROS)} mais recentes):`);
        for (const [m, q] of Object.entries(motivos)) console.log(`       ${String(q).padStart(3)}× ${m}   ex.: ${exemplos[m]}`);
      }
    }
  } catch (e) {
    console.log(`  ERRO de conexão/leitura: ${e.message}`);
  } finally {
    try { await sftp.end(); } catch {}
  }
  console.log('');
}

(async () => {
  const modo = (process.argv[2] || '').toLowerCase();
  if (modo !== 'qedb') await inspecionar(FONTES.PVN);
  if (modo !== 'pvn') await inspecionar(FONTES.QEDB);
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
