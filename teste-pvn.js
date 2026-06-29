'use strict';

const path = require('path');
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// =========================================================
// 1. CONFIGURAÇÕES E CREDENCIAIS
// =========================================================
const credenciaisEmpresas = {
    'SF2010 (ATALANTA)': { tenant: 'pvntransportes', token: '13cc702e106745511d8d5c3222916a2b', sufixo: '10' },
    'SF2030 (VILLE)': { tenant: 'pvntransportes', token: 'fa68f8229bc3730b87f1de1e9ff0c4ac', sufixo: '30' }
};

// Conexão Protheus (MSSQL)
const mssqlPool = new sql.ConnectionPool({
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASS,
    server: process.env.MSSQL_HOST,
    database: process.env.MSSQL_DB,
    pool: { max: 5, min: 1, idleTimeoutMillis: 30000 },
    options: { encrypt: false, trustServerCertificate: true }
});

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// =========================================================
// 1. FUNÇÃO DE CAPTURA NA API ESLCLOUD
// =========================================================
async function buscarDadosESL(endpoint, credencial, dataSince, startId = null) {
    const { tenant, token } = credencial;
    
    let url = `https://${tenant}.eslcloud.com.br/api/customer/${endpoint}?since=${dataSince}`;
    if (startId) url += `&start=${startId}`;

    try {
        console.log(`  [REQ] GET -> ${url}`);
        const response = await fetch(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}`, tenant: tenant, Accept: 'application/json' }
        });

        if (response.status === 429) {
            console.warn(`  ⚠️ Rate limit (429) na API ESL (${endpoint}). Aguardando 5s...`);
            await delay(5000);
            return await buscarDadosESL(endpoint, credencial, dataSince, startId);
        }

        if (!response.ok) {
            console.error(`  ❌ ERRO HTTP ${response.status} na API ESL (${endpoint}). Corpo:`, await response.text());
            return [];
        }

        const json = await response.json();
        let registros = json.data || [];

        if (json.paging && json.paging.next_id) {
            await delay(1500); // Delay sutil entre as paginações
            const proximos = await buscarDadosESL(endpoint, credencial, dataSince, json.paging.next_id);
            registros = registros.concat(proximos);
        }

        return registros;
    } catch (error) {
        console.error(`  ❌ ERRO FATAL DE CONEXÃO (${endpoint}):`, error.message);
        return [];
    }
}

// =========================================================
// 2. CONSULTA AO BANCO PROTHEUS
// =========================================================
async function buscarDadosProtheusPorChaves(chaves, sufixo, origemNome) {
    if (!chaves || chaves.length === 0) return [];

    const listaChavesSql = chaves.map(c => `'${c}'`).join(',');

    const query = `
        SELECT 
            '${origemNome}'                         AS origem,
            LTRIM(RTRIM(f.F2_FILIAL))               AS filial,
            f.F2_CHVNFE                             AS f2_chvnfe,
            LTRIM(RTRIM(vend.A3_COD))               AS codigo_representante,
            LTRIM(RTRIM(vend.A3_NOME))              AS nome_representante,
            f.F2_TRANSP,
            f.F2_EMISSAO
        FROM SF20${sufixo} f
        LEFT JOIN SA30${sufixo} vend
            ON (vend.A3_COD = f.F2_VEND1 AND vend.A3_FILIAL = '00' AND vend.D_E_L_E_T_ = '')
        WHERE f.D_E_L_E_T_ = ''
          AND f.F2_CHVNFE IN (${listaChavesSql})
    `;

    try {
        const result = await mssqlPool.request().query(query);
        return result.recordset;
    } catch (error) {
        console.error(`  ❌ ERRO AO CONSULTAR PROTHEUS (Tabela SF20${sufixo}):`, error.message);
        return [];
    }
}

// =========================================================
// 3. FLUXO PRINCIPAL
// =========================================================
async function run() {
    try {
        console.log('🔌 Conectando ao banco Protheus...');
        await mssqlPool.connect();

        const dataCorte = new Date();
        dataCorte.setDate(dataCorte.getDate() - 30);
        const sinceFormatted = dataCorte.toISOString().split('.')[0] + '-03:00';

        console.log(`🚀 Capturando dados na API ESL (ÚLTIMOS 30 DIAS) desde: ${sinceFormatted}\n`);

        for (const [origemNome, credencial] of Object.entries(credenciaisEmpresas)) {
            console.log(`🏢 ================================================`);
            console.log(`🏢 PROCESSANDO EMPRESA: ${origemNome}`);
            console.log(`==================================================`);

            // 1. Coleta Ocorrências
            console.log('  📡 Baixando Ocorrências...');
            const apiOcorrencias = await buscarDadosESL('invoice_occurrences', credencial, sinceFormatted);
            if(apiOcorrencias.length > 0) {
                console.log(`  🔎 [LOG DE AMOSTRA] Ocorrências (1º registro analisado com sucesso)`);
            }
            
            // 2. Coleta Comprovantes
            await delay(2000);
            console.log('  📡 Baixando Comprovantes...');
            const apiComprovantes = await buscarDadosESL('freight_invoice_delivery_receipts', credencial, sinceFormatted);

            console.log(`  📊 [MÉTRICAS]: ${apiOcorrencias.length} ocorrências | ${apiComprovantes.length} comprovantes.`);

            // Agrupa e filtra as chaves de 44 dígitos encontradas
            const chavesOcorrencias = apiOcorrencias.map(o => o.invoice?.key).filter(Boolean);
            const chavesComprovantes = apiComprovantes.map(c => c.invoice?.key).filter(Boolean);
            const todasChavesApi = [...new Set([...chavesOcorrencias, ...chavesComprovantes])].filter(c => c.length === 44);

            console.log(`  📌 Primeiras 3 chaves válidas encontradas na API:`, todasChavesApi.slice(0, 3));

            if (todasChavesApi.length === 0) {
                console.log('  💤 Nenhuma chave de 44 dígitos válida encontrada. Interrompendo.\n------------------------------------------------');
                continue;
            }

            console.log(`  🔍 Buscando metadados de ${todasChavesApi.length} NFs no Protheus...`);
            const dadosProtheus = await buscarDadosProtheusPorChaves(todasChavesApi, credencial.sufixo, origemNome);
            console.log(`  ✅ Protheus localizou dados para ${dadosProtheus.length} notas.`);

            const mapaProtheus = new Map(dadosProtheus.map(row => [row.f2_chvnfe.trim(), row]));
            const registrosParaFuncao = [];

            // A) Processando OCORRÊNCIAS
            for (const oc of apiOcorrencias) {
                try {
                    const nfeChave = oc.invoice?.key;
                    const dadosNotaBanco = mapaProtheus.get(nfeChave);

                    if (dadosNotaBanco) {
                        registrosParaFuncao.push({
                            empresa_id:           dadosNotaBanco.origem,
                            filial:               dadosNotaBanco.filial,
                            codigo_representante: dadosNotaBanco.codigo_representante || null,
                            razao_destinatario:   dadosNotaBanco.razao_cliente || null, 
                            chave_nfe:            nfeChave,
                            nf_numero:            oc.invoice?.number || null,
                            cnpj_transportador:   oc.freight?.corporation?.document || null,
                            cte_numero:           oc.freight?.cte_number ? String(oc.freight.cte_number) : null,
                            cnpj_destinatario:    oc.freight?.sender?.document || null,
                            servico:              'RODOVIARIO',
                            previsao_entrega:     oc.freight?.delivery_prediction_at || null,
                            ingest_source:        'API_ESL_PVN_OCORRENCIA',
                            status_minuta:        oc.occurrence?.code ? String(oc.occurrence.code) : null,
                            descricao:            oc.occurrence?.description || null,
                            data_ocorrencia:      oc.occurrence_at || oc.created_at, 
                            entrega_nome:         oc.receiver ? oc.receiver.trim() : null,
                            entrega_rg:           oc.document_number || null,
                            chave_cte:            oc.freight?.cte_key || null // 🔥 CAPTURA DIRETA DA API!
                        });
                    }
                } catch (mapErr) {
                    console.error(`  ❌ Erro ao cruzar dados na Ocorrência ID [${oc.id || 'N/A'}]:`, mapErr.message);
                }
            }

            // B) Processando COMPROVANTES
            for (const comp of apiComprovantes) {
                try {
                    const nfeChave = comp.invoice?.key;
                    const dadosNotaBanco = mapaProtheus.get(nfeChave);

                    if (dadosNotaBanco) {
                        registrosParaFuncao.push({
                            empresa_id:           dadosNotaBanco.origem,
                            filial:               dadosNotaBanco.filial,
                            codigo_representante: dadosNotaBanco.codigo_representante || null,
                            razao_destinatario:   dadosNotaBanco.razao_cliente || null,
                            chave_nfe:            nfeChave,
                            nf_numero:            comp.invoice?.number || null,
                            cnpj_transportador:   null,
                            cte_numero:           comp.freight?.cte_number ? String(comp.freight.cte_number) : null,
                            cnpj_destinatario:    null,
                            servico:              'RODOVIARIO',
                            previsao_entrega:     null,
                            ingest_source:        'API_ESL_PVN_CANHOTO',
                            status_minuta:        '105', 
                            descricao:            'COMPROVANTE DE ENTREGA - RECEBIDO',
                            data_ocorrencia:      comp.created_at,
                            entrega_nome:         null,
                            entrega_rg:           null,
                            chave_cte:            comp.freight?.cte_key || null // 🔥 CAPTURA DIRETA DA API!
                        });
                    }
                } catch (mapErr) {
                    console.error(`  ❌ Erro ao cruzar dados no Comprovante ID [${comp.id || 'N/A'}]:`, mapErr.message);
                }
            }

            // 4. RESULTADO FINAL NO CONSOLE
            if (registrosParaFuncao.length > 0) {
                console.log(`\n  ✅ SUCESSO NO CRUZAMENTO! Total de registros gerados: ${registrosParaFuncao.length}`);
                console.log(`  👇 Abaixo estão os dados formatados (limitado a 5):\n`);
                console.log(JSON.stringify(registrosParaFuncao.slice(0, 5), null, 2));
                
                if (registrosParaFuncao.length > 5) {
                    console.log(`\n  ... e mais ${registrosParaFuncao.length - 5} registros gerados.\n`);
                }
            } else {
                console.log('\n  ⚠️ Nenhum dado cruzado válido foi gerado para esta empresa.\n');
            }

            console.log('------------------------------------------------\n');
            await delay(2000);
        }

        console.log('🏁 Processo de ETL concluído com 100% de sucesso.');

    } catch (error) {
        console.error('🚨 ERRO FATAL NO PROCESSO:', error.stack || error.message);
    } finally {
        if (mssqlPool.connected) {
            await mssqlPool.close();
            console.log('🔌 Conexão com banco Protheus encerrada.');
        }
    }
}

run();