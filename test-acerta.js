// test-acerta.js - Script de Inspeção de Payload Brudam ACERTA (v2 corrigida)
'use strict';

const path = require('path');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ──────────────────────────────────────────────────────────────
// 🛠️ CONFIGURAÇÃO DO SEU TESTE
// Coloque aqui 1 ou mais chaves de acesso reais de notas da ACERTA para testar
// ──────────────────────────────────────────────────────────────
const CHAVES_TESTE = [
    '32260661183729000801550010000100771550270486'
];

function tryDecodeBase64Json(value) {
    if (typeof value !== 'string' || value.trim() === '') return value;
    try {
        const decoded = Buffer.from(value, 'base64').toString('utf-8').trim();
        if (decoded.startsWith('{') || decoded.startsWith('[')) return JSON.parse(decoded);
        return decoded;
    } catch {
        return value;
    }
}

async function obterToken(account, authUrl) {
    const payload = { usuario: account.user, senha: account.pass };
    let resp;

    try {
        console.log(`🔑 Tentando autenticar via JSON: [${account.user}]...`);
        resp = await axios.post(authUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });
    } catch (err) {
        try {
            console.log(`⚠️ Falha no JSON, tentando via URL-Encoded...`);
            const form = new URLSearchParams(payload);
            resp = await axios.post(authUrl, form, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 15000
            });
        } catch (fallbackErr) {
            console.error('❌ Erro crítico: Ambos os formatos de autenticação falharam.');
            console.error('Erro JSON:', err.message, '| Erro Form:', fallbackErr.message);
            return null;
        }
    }

    // Copiado exatamente igual ao seu worker.js para não perder nenhuma possibilidade
    const token =
        resp?.data?.token        ||
        resp?.data?.tokenjwt     ||
        resp?.data?.data?.token  ||
        resp?.data?.access_token ||
        resp?.data?.data?.access_key; // <─ O que estava faltando!

    if (!token && resp?.data) {
        console.log('\n⚠️ ATENÇÃO: Resposta de login recebida, mas nenhuma chave de token conhecida foi achada.');
        console.log('Estrutura retornada pelo login:', JSON.stringify(resp.data, null, 2), '\n');
    }

    return token;
}

async function rodarTeste() {
    console.log('🚀 Iniciando teste de leitura da API ACERTA...\n');

    if (CHAVES_TESTE[0].includes('COLOQUE_UMA_CHAVE_REAL')) {
        console.error('❌ ERRO: Substitua o valor de CHAVES_TESTE por uma chave de nota fiscal real da ACERTA.');
        process.exit(1);
    }

    const configPath = path.resolve(__dirname, 'transportadoras.json');
    if (!fs.existsSync(configPath)) {
        console.error(`❌ ERRO: Arquivo ${configPath} não encontrado.`);
        process.exit(1);
    }

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const t = (raw?.transportadoras || []).find(item => item.name.toUpperCase().includes('ACERTA'));

    if (!t) {
        console.error('❌ ERRO: Nenhuma transportadora com o nome "ACERTA" foi encontrada no seu transportadoras.json.');
        process.exit(1);
    }

    console.log(`🎯 Transportadora encontrada: ${t.name}`);
    const account = t.accounts[0];
    
    try {
        const token = await obterToken(account, t.auth_url);
        if (!token) {
            console.error('❌ ERRO: Não foi possível extrair o Token da resposta de autenticação.');
            process.exit(1);
        }
        console.log('✅ Token obtido com sucesso!');

        const chavesQuery = CHAVES_TESTE.join(',');
        const url = `${t.base}/api/v1/tracking/ocorrencias/nfe?chave=${encodeURIComponent(chavesQuery)}&comprovante=1`;
        
        console.log(`🌐 Chamando API Brudam: ${url}\n`);
        const { data: apiData } = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 30000
        });

        console.log('=== [1] PAYLOAD TOTAL BRUTO DA API ===');
        console.log(JSON.stringify(apiData, null, 2));
        console.log('======================================\n');

        let payloadProcessado = apiData;
        for (const campo of ['dados', 'conteudo', 'xml', 'tracking']) {
            if (typeof apiData[campo] === 'string') {
                const decoded = tryDecodeBase64Json(apiData[campo]);
                if (decoded !== apiData[campo]) {
                    payloadProcessado = { ...payloadProcessado, [campo]: decoded };
                    console.log(`🔓 Campo Base64 [${campo}] detectado e decodificado.`);
                }
            }
        }

        console.log('\n=== [2] PAYLOAD COMPLETO DECODIFICADO (Estrutura Interna) ===');
        console.dir(payloadProcessado, { depth: null, colors: true });
        console.log('============================================================\n');

        console.log('=== [3] ANÁLISE DE CAMPOS DISPONÍVEIS ===');
        const dadosNotas = payloadProcessado.dados || payloadProcessado.data || payloadProcessado.conteudo || (Array.isArray(payloadProcessado) ? payloadProcessado : [payloadProcessado]);
        
        if (Array.isArray(dadosNotas) && dadosNotas.length > 0) {
            const notaExemplo = dadosNotas[0];
            console.log('Chaves da Nota:', Object.keys(notaExemplo));
            
            const ocorrencias = notaExemplo.ocorrencias || notaExemplo.tracking || notaExemplo.dados;
            if (Array.isArray(ocorrencias) && ocorrencias.length > 0) {
                console.log('📌 Ocorrência exemplo encontrada!');
                console.log('Campos disponíveis dentro de cada ocorrência:', Object.keys(ocorrencias[0]));
                console.log('Valores da última ocorrência:', ocorrencias[ocorrencias.length - 1]);
            } else {
                console.log('⚠️ Nenhuma lista de sub-ocorrências/tracking aninhada foi detectada para esta nota.');
            }
        } else {
            console.log('❌ Nenhuma nota retornada no array principal.');
        }
        console.log('=========================================');

    } catch (err) {
        console.error('❌ Falha na execução do teste:', err.message);
        if (err.response) {
            console.error('Resposta do Servidor:', err.response.status, err.response.data);
        }
    }
}

rodarTeste();