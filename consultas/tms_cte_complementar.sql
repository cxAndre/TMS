-- CT-e COMPLEMENTAR (tpCTe = 1) recebido por SFTP (PVN, Quality).
--
-- O complementar cobra um valor a mais SOBRE outro CT-e: no XML ele não cita
-- NF-e, só a chave do CT-e original (infCteComp/chCTe). O ETL acha as NF-e
-- pelo CT-e original e grava aqui uma linha por (CT-e complementar, NF-e).
--
-- Fica numa tabela própria porque tms_monitoramento_entregas.xml_completo
-- guarda UM CT-e por NF-e (o original) e uma NF-e pode ter vários complementares.
-- Frete total de uma NF-e = vTPrest do xml_completo + soma de v_tprest daqui.
--
-- Rodar uma vez no SQL Editor do Supabase. Idempotente.

CREATE TABLE IF NOT EXISTS public.tms_cte_complementar (
    chave_cte           text        NOT NULL,  -- chave do CT-e complementar
    chave_nfe           text        NOT NULL,  -- NF-e do CT-e original
    chave_cte_original  text        NOT NULL,  -- CT-e que este complementa
    empresa_id          text,
    filial              text,
    cnpj_emitente       text,
    n_ct                text,
    dh_emi              timestamptz,
    v_tprest            numeric(14,2),
    xml                 text        NOT NULL,
    fonte               text,                  -- PVN | QEDB
    gravado_em          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chave_cte, chave_nfe)
);

CREATE INDEX IF NOT EXISTS tms_cte_complementar_nfe_idx      ON public.tms_cte_complementar (chave_nfe);
CREATE INDEX IF NOT EXISTS tms_cte_complementar_original_idx ON public.tms_cte_complementar (chave_cte_original);

-- Fechada para a chave pública (anon). O ETL grava com a chave de serviço, que
-- ignora RLS; quem for ler (ex.: Monitor de Frete) precisa da mesma política
-- de leitura que tms_monitoramento_entregas tem hoje.
ALTER TABLE public.tms_cte_complementar ENABLE ROW LEVEL SECURITY;
