// etl/cte-brudam.js
// Busca o XML fiscal do CT-e no Brudam a partir da chave da NF-e.
// Endpoint: GET {base}/api/v1/dfe/cte/nota?chave_nfe=<até 50 chaves>
// Resposta: { status, data: [ { chave, status, xml(base64) } ] }
'use strict';

const axios = require('axios');

const LIMITE_CHAVES = 50;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Faz uma chamada ao endpoint /dfe/cte/nota e devolve os itens crus.
// Repete em erros transitórios de gateway (502/503/504) e rate-limit (429).
async function buscarLoteCteBrudam(chaves, base, token, _tent = 0) {
  const url = `${base}/api/v1/dfe/cte/nota?chave_nfe=${chaves.join(',')}`;
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 45000,
    validateStatus: () => true,
  });
  if (r.status === 401) { const e = new Error('401 Brudam CT-e'); e.status = 401; throw e; }
  if ([429, 502, 503, 504].includes(r.status) && _tent < 3) {
    await sleep(1500 * Math.pow(2, _tent) + Math.random() * 500);
    return buscarLoteCteBrudam(chaves, base, token, _tent + 1);
  }
  if (r.status >= 400) { const e = new Error(`HTTP ${r.status} Brudam CT-e`); e.status = r.status; throw e; }
  return Array.isArray(r.data?.data) ? r.data.data : [];
}

// Decodifica os CT-es e mapeia cada NF-e pedida -> { cte_chave, xml }.
// Um CT-e pode consolidar várias NF-e; casamos pela chave da NF-e presente
// dentro do próprio XML. Em empate, escolhemos o CT-e mais específico
// (com menos NF-e).
function mapearCtePorNota(chavesPedidas, itens) {
  const decodificados = [];
  for (const it of itens) {
    if (it.status !== 1 || !it.xml) continue;
    let xml;
    try { xml = Buffer.from(it.xml, 'base64').toString('utf-8'); } catch { continue; }
    if (!xml.includes('<CTe') && !xml.includes('cteProc')) continue;
    const nNfe = (xml.match(/<chave>\d{44}<\/chave>/g) || []).length || 1;
    decodificados.push({ cte_chave: it.chave || null, xml, nNfe });
  }

  const mapa = new Map();
  for (const chave of chavesPedidas) {
    const candidatos = decodificados.filter(d => d.xml.includes(chave));
    if (!candidatos.length) continue;
    candidatos.sort((a, b) => a.nNfe - b.nNfe); // mais específico primeiro
    mapa.set(chave, { cte_chave: candidatos[0].cte_chave, xml: candidatos[0].xml });
  }
  return mapa;
}

// Cliente que tenta TODAS as contas e usa a que libera o XML.
// Motivo: em alguns Brudam (ex.: DDM) só uma das contas tem permissão de
// download de XML de CT-e; a outra devolve status 0 "Proibido".
function criarClienteCteBrudam({ base, authUrl, accounts, user, pass }) {
  // aceita accounts:[{user,pass}] ou o par avulso {user,pass} (compat)
  const contas = (accounts && accounts.length ? accounts : [{ user, pass }])
    .filter(a => a && a.user && a.pass);
  const tokens = new Map(); // user -> token

  async function autenticar(conta) {
    const r = await axios.post(authUrl, { usuario: conta.user, senha: conta.pass }, {
      headers: { 'Content-Type': 'application/json' }, timeout: 60000, validateStatus: () => true,
    });
    const token = r.data?.data?.access_key || r.data?.token || r.data?.tokenjwt || r.data?.access_token || r.data?.data?.token;
    if (!token) throw new Error('Token Brudam não obtido');
    tokens.set(conta.user, token);
    return token;
  }

  async function chamarConta(conta, chaves, _reauth = false) {
    const token = tokens.get(conta.user) || await autenticar(conta);
    try { return await buscarLoteCteBrudam(chaves, base, token); }
    catch (e) {
      if (e.status === 401 && !_reauth) { await autenticar(conta); return chamarConta(conta, chaves, true); }
      throw e;
    }
  }

  async function buscar(chaves) {
    let ultimoItens = [];
    for (const conta of contas) {
      let itens;
      try { itens = await chamarConta(conta, chaves); }
      catch { continue; } // conta falhou → tenta a próxima
      ultimoItens = itens;
      // se esta conta liberou algum XML, é a boa
      if (itens.some(it => it.status === 1 && it.xml)) return mapearCtePorNota(chaves, itens);
    }
    // nenhuma conta liberou XML (Proibido ou sem CT-e) → mapeia o que houver
    return mapearCtePorNota(chaves, ultimoItens);
  }

  return { buscar };
}

module.exports = { buscarLoteCteBrudam, mapearCtePorNota, criarClienteCteBrudam, LIMITE_CHAVES };
