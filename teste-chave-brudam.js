'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const CHAVE = '35260602167473000103550010001939281644864581';

async function getToken(account, authUrl) {
  const payload = {
    usuario: account.user,
    senha: account.pass
  };

  try {
    const resp = await axios.post(
      authUrl,
      payload,
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    return (
      resp.data?.token ||
      resp.data?.tokenjwt ||
      resp.data?.data?.token ||
      resp.data?.access_token ||
      resp.data?.data?.access_key
    );
  } catch {

    const resp = await axios.post(
      authUrl,
      new URLSearchParams(payload),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 15000
      }
    );

    return (
      resp.data?.token ||
      resp.data?.tokenjwt ||
      resp.data?.data?.token ||
      resp.data?.access_token ||
      resp.data?.data?.access_key
    );
  }
}

async function main() {

  const configPath = path.join(__dirname, 'transportadoras.json');

  const cfg = JSON.parse(
    fs.readFileSync(configPath, 'utf8')
  );

  const transportadora = cfg.transportadoras.find(
    t => t.name.toUpperCase().includes('BRUDAM')
  );

  if (!transportadora) {
    throw new Error('Transportadora BRUDAM não encontrada');
  }

  const conta = transportadora.accounts[0];

  console.log('Transportadora:', transportadora.name);
  console.log('Conta:', conta.user);

  const token = await getToken(
    conta,
    transportadora.auth_url
  );

  console.log('Token obtido');

  const url =
    `${transportadora.base}` +
    `/api/v1/tracking/ocorrencias/nfe` +
    `?chave=${CHAVE}&comprovante=1`;

  console.log('\nConsultando:\n');
  console.log(url);

  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`
    },
    timeout: 60000
  });

  console.log('\n===== RETORNO COMPLETO =====\n');

  console.log(
    JSON.stringify(resp.data, null, 2)
  );
}

main().catch(err => {

  console.error('\nERRO:\n');

  console.error(
    err.response?.data ||
    err.message ||
    err
  );

});