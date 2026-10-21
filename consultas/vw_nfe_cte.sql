-- Para TODA NF-e do banco: os CT-e emitidos para ela por QUALQUER transportadora,
-- com o XML de cada um. Base para o Monitor de Frete.
--
--   vw_nfe_cte        uma linha por (NF-e, CT-e); NF-e sem CT-e aparece com tipo 'sem_cte'
--   vw_nfe_resumo_cte uma linha por NF-e: tem CT-e? quantos? de quais transportadoras?
--
-- Depende de tms_cte_xml / tms_cte_nfe (consultas/tms_cte_xml.sql) e
-- tms_cte_complementar (consultas/tms_cte_complementar.sql).
-- security_invoker: a view respeita o RLS de quem consulta.
-- Rodar no SQL Editor do Supabase. Idempotente.

CREATE OR REPLACE VIEW public.vw_nfe_cte WITH (security_invoker = true) AS
-- CT-e normais (um por perna: ACERTA, DDM, PVN, QUALITY)
SELECT e.empresa_id, e.filial, e.chave_nfe, e.ingest_source AS origem_linha,
       'normal'::text      AS tipo,
       x.chave_cte, x.transportadora, x.papel, x.tp_cte, x.n_ct, x.dh_emi, x.v_tprest, x.c_stat,
       NULL::text          AS chave_cte_original,
       x.xml               AS xml_cte
FROM public.tms_monitoramento_entregas e
JOIN public.tms_cte_nfe n ON n.chave_nfe = e.chave_nfe
JOIN public.tms_cte_xml x ON x.chave_cte = n.chave_cte
UNION ALL
-- CT-e complementares (valor a mais sobre um CT-e normal)
SELECT e.empresa_id, e.filial, e.chave_nfe, e.ingest_source,
       'complementar',
       c.chave_cte,
       CASE left(c.cnpj_emitente, 8) WHEN '12270745' THEN 'PVN' WHEN '19355089' THEN 'DDM'
                                     WHEN '26510120' THEN 'QUALITY' WHEN '28486039' THEN 'ACERTA' END,
       'ENTREGA', '1', c.n_ct, c.dh_emi, c.v_tprest, NULL,
       c.chave_cte_original,
       c.xml
FROM public.tms_monitoramento_entregas e
JOIN public.tms_cte_complementar c ON c.chave_nfe = e.chave_nfe
UNION ALL
-- NF-e sem nenhum CT-e
SELECT e.empresa_id, e.filial, e.chave_nfe, e.ingest_source,
       'sem_cte', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM public.tms_monitoramento_entregas e
WHERE NOT EXISTS (SELECT 1 FROM public.tms_cte_nfe n WHERE n.chave_nfe = e.chave_nfe)
  AND NOT EXISTS (SELECT 1 FROM public.tms_cte_complementar c WHERE c.chave_nfe = e.chave_nfe);

CREATE OR REPLACE VIEW public.vw_nfe_resumo_cte WITH (security_invoker = true) AS
SELECT empresa_id, filial, chave_nfe,
       bool_or(tipo <> 'sem_cte')                                AS tem_cte,
       count(*) FILTER (WHERE tipo = 'normal')                   AS qtd_cte,
       count(*) FILTER (WHERE tipo = 'complementar')             AS qtd_complementar,
       string_agg(DISTINCT transportadora, ' + ' ORDER BY transportadora) AS transportadoras,
       max(dh_emi)                                               AS ultima_emissao_cte
FROM public.vw_nfe_cte
GROUP BY empresa_id, filial, chave_nfe;

-- Exemplos:
--   CT-e de uma NF-e, com o XML:
--     select * from vw_nfe_cte where chave_nfe = '<chave>';
--   NF-e de outubro sem CT-e:
--     select * from vw_nfe_resumo_cte where not tem_cte and substring(chave_nfe, 3, 4) = '2610';
--   NF-e com mais de uma transportadora:
--     select transportadoras, count(*) from vw_nfe_resumo_cte group by 1 order by 2 desc;
