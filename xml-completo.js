// etl/xml-completo.js
// Conversão JSON -> XML formatado (indentado) + gravação em lote da coluna
// tms_monitoramento_entregas.xml_completo
'use strict';

// ─── ESCAPE / NOMES DE TAG ──────────────────────────────────────────────────
function escaparXml(valor) {
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Nomes de tag XML válidos: começam com letra/underscore e só aceitam
// [A-Za-z0-9_.-]. Chaves inválidas (ex.: "0", "cnpj/cpf") são saneadas.
function nomeTagValido(nome) {
  let n = String(nome).replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!n) n = '_';
  if (!/^[A-Za-z_]/.test(n)) n = '_' + n;
  return n;
}

// ─── RENDER RECURSIVO ────────────────────────────────────────────────────────
function renderNode(nome, valor, indent) {
  const pad = '  '.repeat(indent);
  const tag = nomeTagValido(nome);

  if (valor === null || valor === undefined || valor === '') {
    return `${pad}<${tag}/>`;
  }

  if (Array.isArray(valor)) {
    if (!valor.length) return `${pad}<${tag}/>`;
    const filhos = valor.map(v => renderNode('item', v, indent + 1)).join('\n');
    return `${pad}<${tag}>\n${filhos}\n${pad}</${tag}>`;
  }

  if (typeof valor === 'object') {
    const chaves = Object.keys(valor);
    if (!chaves.length) return `${pad}<${tag}/>`;
    const filhos = chaves.map(k => renderNode(k, valor[k], indent + 1)).join('\n');
    return `${pad}<${tag}>\n${filhos}\n${pad}</${tag}>`;
  }

  return `${pad}<${tag}>${escaparXml(valor)}</${tag}>`;
}

/**
 * Converte qualquer valor JSON (objeto, array, primitivo) em XML formatado.
 * @param {*} valor
 * @param {string} nomeRaiz - tag raiz do documento
 * @returns {string} XML com header e indentação de 2 espaços
 */
function jsonParaXml(valor, nomeRaiz = 'root') {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + renderNode(nomeRaiz, valor, 0);
}

// ─── PRECEDÊNCIA DE FONTES DO CT-e ──────────────────────────────────────────
// Uma mesma NF-e pode ter CT-e de transportadoras diferentes. A "marca de
// origem" é o CNPJ raiz do emitente DENTRO do XML — sem coluna extra.
// Regra: uma gravação NÃO sobrescreve outra de prioridade MAIOR, nem um PAR
// (mesma prioridade, CNPJ diferente). Sobrescreve as MENORES e a si mesma.
//   PVN = DDM (entrega final, fluxos distintos, não se sobrescrevem)
//        > QEDB (Quality) > ACERTA (chegada)
const CNPJ_PRIORIDADE = {
  '12270745': 100, // PVN   ─┬─ pares: mesma prioridade, um não sobrescreve o outro
  '19355089': 100, // DDM   ─┘
  '26510120':  60, // QEDB (Quality)
  '28486039':  40, // ACERTA
};
const PVN_CNPJ_RAIZ = '12270745'; // mantido p/ compat de import
const prioridadeFonte = cnpjRaiz => CNPJ_PRIORIDADE[String(cnpjRaiz || '').slice(0, 8)] ?? 0;

// CNPJs que a fonte `cnpjProprio` NÃO deve sobrescrever: os de prioridade maior,
// mais os pares (prioridade igual, CNPJ diferente). Não inclui a si mesma.
function cnpjsProtegidos(cnpjProprio) {
  const meu = String(cnpjProprio || '').slice(0, 8);
  const minha = CNPJ_PRIORIDADE[meu] ?? 0;
  return Object.entries(CNPJ_PRIORIDADE)
    .filter(([c, p]) => p > minha || (p === minha && c !== meu))
    .map(([c]) => c);
}

// ─── GRAVAÇÃO EM LOTE DA COLUNA xml_completo ────────────────────────────────
/**
 * Atualiza a coluna xml_completo para uma lista de chaves já existentes.
 * Cada item: { empresa_id, filial, chave_nfe, xml }.
 * Falhas individuais são logadas mas não interrompem o fluxo.
 * @param {object} [opts]
 * @param {string} [opts.cnpjProprio] CNPJ raiz da fonte desta gravação. Só grava
 *        se o xml_completo atual for NULL ou não contiver o CNPJ de uma fonte
 *        mais forte ou par (ver cnpjsProtegidos). Impede que ACERTA sobrescreva
 *        PVN/DDM/QEDB, e que PVN e DDM se sobrescrevam entre si.
 * @returns {number} quantidade de linhas atualizadas com sucesso
 */
async function gravarXmlEmLote(supabase, itens, logger, concorrencia = 10, opts = {}) {
  if (!itens?.length) return 0;
  const validos = itens.filter(i => i && i.empresa_id && i.filial && i.chave_nfe && i.xml);
  let ok = 0;

  // CNPJs que esta gravação não pode sobrescrever (mais fortes + pares).
  const protegidos = opts.cnpjProprio != null ? cnpjsProtegidos(opts.cnpjProprio) : [];

  for (let i = 0; i < validos.length; i += concorrencia) {
    const bloco = validos.slice(i, i + concorrencia);
    const resultados = await Promise.allSettled(bloco.map(async it => {
      let q = supabase
        .from('tms_monitoramento_entregas')
        .update({ xml_completo: it.xml })
        .eq('empresa_id', it.empresa_id)
        .eq('filial', it.filial)
        .eq('chave_nfe', it.chave_nfe);
      // Trava de precedência: grava só se NULL ou não contiver CNPJ mais forte.
      // (No PostgREST o curinga do ilike dentro de .or()/and() é o asterisco.)
      if (protegidos.length === 1) {
        q = q.or(`xml_completo.is.null,xml_completo.not.ilike.*${protegidos[0]}*`);
      } else if (protegidos.length > 1) {
        const inner = protegidos.map(c => `xml_completo.not.ilike.*${c}*`).join(',');
        q = q.or(`xml_completo.is.null,and(${inner})`);
      }
      const { error } = await q;
      if (error) throw error;
    }));
    for (const r of resultados) {
      if (r.status === 'fulfilled') ok++;
      else if (logger) logger.warn({ err: r.reason?.message }, 'xml_completo: falha ao atualizar linha');
    }
  }
  return ok;
}

module.exports = { jsonParaXml, gravarXmlEmLote, escaparXml, nomeTagValido, PVN_CNPJ_RAIZ, CNPJ_PRIORIDADE, prioridadeFonte, cnpjsProtegidos };
