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

// CNPJ raiz (8 primeiros dígitos) da PVN, presente no <emit><CNPJ> do XML dela.
// Serve de marca de origem SEM coluna extra: quando o xml_completo já contém
// este CNPJ, foi a PVN que gravou — e a PVN faz a entrega ao cliente final,
// então prevalece. Outras fontes (Brudam) não devem sobrescrever.
const PVN_CNPJ_RAIZ = '12270745';

// ─── GRAVAÇÃO EM LOTE DA COLUNA xml_completo ────────────────────────────────
/**
 * Atualiza a coluna xml_completo para uma lista de chaves já existentes.
 * Cada item: { empresa_id, filial, chave_nfe, xml }.
 * Falhas individuais são logadas mas não interrompem o fluxo.
 * @param {object} [opts]
 * @param {boolean} [opts.protegerPvn] Quando true (fontes que NÃO são a PVN),
 *        só grava se o xml_completo atual for NULL ou não for um CT-e da PVN.
 *        Impede que o Brudam sobrescreva o CT-e da PVN nos runs seguintes.
 * @returns {number} quantidade de linhas atualizadas com sucesso
 */
async function gravarXmlEmLote(supabase, itens, logger, concorrencia = 10, opts = {}) {
  if (!itens?.length) return 0;
  const validos = itens.filter(i => i && i.empresa_id && i.filial && i.chave_nfe && i.xml);
  let ok = 0;

  for (let i = 0; i < validos.length; i += concorrencia) {
    const bloco = validos.slice(i, i + concorrencia);
    const resultados = await Promise.allSettled(bloco.map(async it => {
      let q = supabase
        .from('tms_monitoramento_entregas')
        .update({ xml_completo: it.xml })
        .eq('empresa_id', it.empresa_id)
        .eq('filial', it.filial)
        .eq('chave_nfe', it.chave_nfe);
      // Trava: não sobrescreve um CT-e já gravado pela PVN. Casa quando o
      // valor atual é NULL ou não contém o CNPJ raiz da PVN. (No PostgREST o
      // curinga do ilike dentro de .or() é o asterisco.)
      if (opts.protegerPvn) {
        q = q.or(`xml_completo.is.null,xml_completo.not.ilike.*${PVN_CNPJ_RAIZ}*`);
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

module.exports = { jsonParaXml, gravarXmlEmLote, escaparXml, nomeTagValido, PVN_CNPJ_RAIZ };
