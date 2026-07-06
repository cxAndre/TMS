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

// ─── GRAVAÇÃO EM LOTE DA COLUNA xml_completo ────────────────────────────────
/**
 * Atualiza a coluna xml_completo para uma lista de chaves já existentes.
 * Cada item: { empresa_id, filial, chave_nfe, xml }.
 * Falhas individuais são logadas mas não interrompem o fluxo.
 * @returns {number} quantidade de linhas atualizadas com sucesso
 */
async function gravarXmlEmLote(supabase, itens, logger, concorrencia = 10) {
  if (!itens?.length) return 0;
  const validos = itens.filter(i => i && i.empresa_id && i.filial && i.chave_nfe && i.xml);
  let ok = 0;

  for (let i = 0; i < validos.length; i += concorrencia) {
    const bloco = validos.slice(i, i + concorrencia);
    const resultados = await Promise.allSettled(bloco.map(async it => {
      const { error } = await supabase
        .from('tms_monitoramento_entregas')
        .update({ xml_completo: it.xml })
        .eq('empresa_id', it.empresa_id)
        .eq('filial', it.filial)
        .eq('chave_nfe', it.chave_nfe);
      if (error) throw error;
    }));
    for (const r of resultados) {
      if (r.status === 'fulfilled') ok++;
      else if (logger) logger.warn({ err: r.reason?.message }, 'xml_completo: falha ao atualizar linha');
    }
  }
  return ok;
}

module.exports = { jsonParaXml, gravarXmlEmLote, escaparXml, nomeTagValido };
