'use strict';

const axios = require('axios');
const pino = require('pino');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

async function buscarOcorrenciasQedb({ clientId, token, baseUrl }) {
  let paginaAtual = 1;
  const PAGE_SIZE = 50;
  let todosRegistros = [];
  let totalEsperado = null;

  logger.info('QEDB: Iniciando extração incremental via paginação nativa.');

  // Calcula a janela dinâmica de 30 dias (Formato YYYY-MM-DD exigido pelo payload)
  const dtCorte = new Date();
  dtCorte.setDate(dtCorte.getDate() - 30);
  const dataI = dtCorte.toISOString().split('T')[0];
  const dataF = new Date().toISOString().split('T')[0]; // Hoje

  do {
    // Monta a URL garantindo que não há duplicidade de barras
    const urlBaseLimpa = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const url = `${urlBaseLimpa}?page=${paginaAtual}&pageSize=${PAGE_SIZE}`;
    
    try {
      // CORREÇÃO: Utilizando POST e enviando o JSON no body, idêntico ao seu script de sucesso
      const response = await axios.post(url, {
        clientId: clientId,
        nfNumber: "",
        outputFormat: "json",
        layoutedi: "5.0",
        dataI: dataI,
        dataF: dataF,
        page: paginaAtual,
        pageSize: PAGE_SIZE,
        ftp: 0
      }, {
        headers: { 
          'Authorization': token, // Envia o token exatamente como configurado no .env
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 45000
      });

      const payload = response.data;
      
      // --- FUNÇÃO DE VARREDURA PROFUNDA (Ignora wrappers da API) ---
      let registrosEncontrados = [];
      let proximaPaginaFlag = null;

      function varrerObjeto(atual) {
          if (!atual || typeof atual !== 'object') return;
          if (Array.isArray(atual)) {
              for (let elemento of atual) varrerObjeto(elemento);
              return;
          }
          // Captura dados
          if (Array.isArray(atual.ocorrencias)) registrosEncontrados = atual.ocorrencias;
          if (atual.header?.totalRegistros !== undefined) totalEsperado = atual.header.totalRegistros;
          if (atual.pagination) {
              if (atual.pagination.totalRecords !== undefined) totalEsperado = atual.pagination.totalRecords;
              if (atual.pagination.hasNextPage !== undefined) proximaPaginaFlag = atual.pagination.hasNextPage;
          }
          // Recursão
          for (let chave in atual) {
              if (atual.hasOwnProperty(chave)) varrerObjeto(atual[chave]);
          }
      }

      varrerObjeto(payload);

      if (registrosEncontrados.length === 0) {
          logger.info(`QEDB: Página ${paginaAtual} retornou vazia. Encerrando paginação.`);
          break;
      }

      todosRegistros = todosRegistros.concat(registrosEncontrados);
      
      const indicadorTotal = totalEsperado ? ` / ${totalEsperado}` : "";
      logger.info(`QEDB: Página ${paginaAtual} processada. Acumulado: ${todosRegistros.length}${indicadorTotal}`);
      
      // --- VALIDAÇÃO DINÂMICA DE PRÓXIMA PÁGINA ---
      let temMaisPaginas = false;
      if (proximaPaginaFlag !== null) {
          temMaisPaginas = proximaPaginaFlag && registrosEncontrados.length > 0;
      } else if (totalEsperado !== null) {
          temMaisPaginas = todosRegistros.length < totalEsperado && registrosEncontrados.length > 0;
      } else {
          temMaisPaginas = registrosEncontrados.length === PAGE_SIZE;
      }

      if (!temMaisPaginas) break;
      
      paginaAtual++;

    } catch (err) {
      logger.error({ 
        err: err.message, 
        status: err.response?.status,
        pagina: paginaAtual 
      }, 'QEDB: Erro ao extrair página de ocorrências.');
      throw err;
    }
  } while (true);

  logger.info({ totalConsolidado: todosRegistros.length }, 'QEDB: Extração concluída com sucesso.');
  return todosRegistros;
}

module.exports = { buscarOcorrenciasQedb };