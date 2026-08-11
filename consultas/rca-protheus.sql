-- RCA / representantes (SA3) das duas empresas Protheus, com contato e localização.
--
-- Dois cuidados que a tabela exige:
--  1) SA3 repete o mesmo A3_COD por filial (00, 01, 02, 03) com dados iguais.
--     Sem deduplicar, cada representante sai 2 a 3 vezes. Deduplica por A3_COD
--     preferindo a filial '00' (a base), mas SEM descartar quem só existe em
--     outra filial — na SA3010 há 4 códigos nessa situação.
--  2) A3_TIPO é branco para todos e o cargo, quando existe, está embutido no
--     A3_NOME depois de uma '/'. Não há campo que separe RCA de diretor/gerente.
--
-- A3_MSBLQL: '1' = bloqueado, '2'/branco = ativo.
-- A3_CEL está vazio em 100% das linhas; o telefone útil é A3_DDDTEL + A3_TEL.

WITH rca AS (
    SELECT 'VILLE' AS empresa_id, * FROM SA3030 WHERE D_E_L_E_T_ = ''
    UNION ALL
    SELECT 'ATALANTA' AS empresa_id, * FROM SA3010 WHERE D_E_L_E_T_ = ''
),
dedup AS (
    SELECT *,
           ROW_NUMBER() OVER (
               PARTITION BY empresa_id, A3_COD
               ORDER BY CASE WHEN A3_FILIAL = '00' THEN 0 ELSE 1 END, A3_FILIAL
           ) AS rn
    FROM rca
)
SELECT
    d.empresa_id,
    LTRIM(RTRIM(d.A3_COD))                                   AS codigo,
    LTRIM(RTRIM(d.A3_NOME))                                  AS nome,
    LTRIM(RTRIM(d.A3_NREDUZ))                                AS nome_reduzido,
    LTRIM(RTRIM(d.A3_EMAIL))                                 AS email,
    LTRIM(RTRIM(d.A3_END))                                   AS endereco,
    LTRIM(RTRIM(d.A3_BAIRRO))                                AS bairro,
    LTRIM(RTRIM(d.A3_MUN))                                   AS municipio,
    LTRIM(RTRIM(d.A3_EST))                                   AS uf,
    LTRIM(RTRIM(d.A3_CEP))                                   AS cep,
    LTRIM(RTRIM(d.A3_DDDTEL)) + LTRIM(RTRIM(d.A3_TEL))       AS telefone,
    LTRIM(RTRIM(d.A3_CGC))                                   AS cpf_cnpj,
    LTRIM(RTRIM(d.A3_REGIAO))                                AS regiao,
    LTRIM(RTRIM(d.A3_SUPER))                                 AS cod_supervisor,
    LTRIM(RTRIM(sup.A3_NOME))                                AS nome_supervisor,
    LTRIM(RTRIM(d.A3_GEREN))                                 AS cod_gerente,
    LTRIM(RTRIM(ger.A3_NOME))                                AS nome_gerente,
    d.A3_COMIS                                               AS comissao_pct,
    CASE WHEN d.A3_MSBLQL = '1' THEN 'BLOQUEADO' ELSE 'ATIVO' END AS situacao,
    LTRIM(RTRIM(d.A3_ADMISS))                                AS admissao,
    d.A3_FILIAL                                              AS filial_origem
FROM dedup d
LEFT JOIN dedup sup ON sup.empresa_id = d.empresa_id AND sup.A3_COD = d.A3_SUPER  AND sup.rn = 1
LEFT JOIN dedup ger ON ger.empresa_id = d.empresa_id AND ger.A3_COD = d.A3_GEREN  AND ger.rn = 1
WHERE d.rn = 1
ORDER BY d.empresa_id, codigo;
