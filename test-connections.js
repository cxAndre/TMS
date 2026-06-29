// test-connections.js
require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MSSQL_CONFIG = {
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASS,
  server: process.env.MSSQL_HOST,
  database: process.env.MSSQL_DB,
  options: { encrypt: false, trustServerCertificate: true }
};

async function runDiagnostics() {
  console.log('\n========= 🔍 INICIANDO DIAGNÓSTICO DE CONEXÕES =========\n');

  // ----------------------------------------------------
  // TESTE 1: SUPABASE
  // ----------------------------------------------------
  try {
    console.log('🔄 [Supabase] Tentando conectar e ler a tabela sync_execucoes...');
    
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      throw new Error('Variáveis SUPABASE_URL ou SUPABASE_KEY não foram encontradas no .env');
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    
    // Faz uma query boba que traz apenas 1 registro para testar a comunicação
    const { data, error } = await supabase
      .from('sync_execucoes')
      .select('execucao_id')
      .limit(1);

    if (error) throw error;

    console.log('✅ [Supabase] Conexão bem-sucedida! Autenticação e tabelas OK.');
  } catch (err) {
    console.error('❌ [Supabase] ERRO DE CONEXÃO:', err.message);
  }

  console.log('\n----------------------------------------------------\n');

  // ----------------------------------------------------
  // TESTE 2: SQL SERVER (PROTHEUS)
  // ----------------------------------------------------
  try {
    console.log('🔄 [SQL Server] Tentando conectar e rodar um SELECT básico...');
    
    if (!MSSQL_CONFIG.server || !MSSQL_CONFIG.user) {
      throw new Error('Configurações do MSSQL estão incompletas no arquivo .env');
    }

    const pool = await sql.connect(MSSQL_CONFIG);
    
    // Pede o horário atual do servidor para validar que a query executa
    const result = await pool.request().query('SELECT GETDATE() AS logon_time');
    
    console.log('✅ [SQL Server] Conexão bem-sucedida!');
    console.log(`ℹ️ [SQL Server] Hora atual no servidor PAYOT: ${result.recordset[0].logon_time}`);
    
    await pool.close();
  } catch (err) {
    console.error('❌ [SQL Server] ERRO DE CONEXÃO:', err.message);
  }

  console.log('\n========================================================\n');
}

runDiagnostics();