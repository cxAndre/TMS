-- CT-e POR PERNA: todo CT-e recebido, de toda transportadora.
--
-- tms_monitoramento_entregas.xml_completo guarda UM CT-e por NF-e, escolhido
-- por precedência (PVN = DDM > QUALITY > ACERTA). Numa NF-e com redespacho
-- (ex.: ACERTA leva ES→CD SP e a DDM ou a PVN entrega) o CT-e da outra perna
-- se perdia. Aqui fica cada CT-e uma vez (tms_cte_xml) e as NF-e que ele
-- transporta (tms_cte_nfe). xml_completo continua como está.
--
-- Frete de uma NF-e = soma de v_tprest dos CT-e normais dela (um por perna)
-- + complementares (tms_cte_complementar). Um CT-e que cobre várias NF-e
-- entra uma vez por CT-e, não por NF-e.
--
-- Rodar uma vez no SQL Editor do Supabase. Idempotente.

CREATE TABLE IF NOT EXISTS public.tms_cte_xml (
    chave_cte       text        PRIMARY KEY,
    transportadora  text,                  -- PVN | DDM | QUALITY | ACERTA (pela raiz do CNPJ)
    cnpj_emitente   text,
    papel           text,                  -- CHEGADA (ACERTA) | ENTREGA (DDM, PVN, QUALITY)
    tp_cte          text,                  -- 0 normal, 1 complementar, 2 anulação, 3 substituto
    n_ct            text,
    dh_emi          timestamptz,
    v_tprest        numeric(14,2),
    c_stat          text,                  -- 100 = autorizado
    xml             text        NOT NULL,
    fonte           text,                  -- BRUDAM-ACERTA-EXPRESS | BRUDAM-DDMLOG | PVN | QEDB
    gravado_em      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tms_cte_nfe (
    chave_cte   text NOT NULL REFERENCES public.tms_cte_xml (chave_cte) ON DELETE CASCADE,
    chave_nfe   text NOT NULL,
    empresa_id  text,
    filial      text,
    PRIMARY KEY (chave_cte, chave_nfe)
);

CREATE INDEX IF NOT EXISTS tms_cte_nfe_nfe_idx        ON public.tms_cte_nfe (chave_nfe);
CREATE INDEX IF NOT EXISTS tms_cte_xml_transp_emi_idx ON public.tms_cte_xml (transportadora, dh_emi);

-- Fechadas para a chave pública (anon); o ETL grava com a chave de serviço.
-- Quem for ler (ex.: Monitor de Frete) precisa da mesma política de leitura
-- que tms_monitoramento_entregas tem hoje.
ALTER TABLE public.tms_cte_xml ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tms_cte_nfe ENABLE ROW LEVEL SECURITY;
