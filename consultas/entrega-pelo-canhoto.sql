-- Nota com canhoto e sem data de entrega: a entrega passa a ser a data do canhoto.
--
-- O canhoto prova a entrega; a data dele é igual ou posterior à entrega real.
-- A regra fica no banco (trigger), não no ETL: só preenche dt_entregue quando
-- está NULL, então nunca troca uma data de entrega real, venha a gravação do
-- upsert_lote, do ESL, da QEDB ou da Brudam.
--
-- Rodar uma vez no SQL Editor do Supabase. Idempotente.

-- 1) Prévia: quantas linhas mudam, por origem
select ingest_source, count(*) as linhas
from tms_monitoramento_entregas
where dt_entregue is null and dt_canhoto is not null
group by 1 order by 2 desc;

-- 2) Regra para as gravações daqui em diante
create or replace function public.tms_entrega_pelo_canhoto()
returns trigger language plpgsql as $$
begin
  if new.dt_entregue is null and new.dt_canhoto is not null then
    new.dt_entregue := new.dt_canhoto;
  end if;
  return new;
end $$;

drop trigger if exists trg_entrega_pelo_canhoto on public.tms_monitoramento_entregas;
create trigger trg_entrega_pelo_canhoto
  before insert or update on public.tms_monitoramento_entregas
  for each row execute function public.tms_entrega_pelo_canhoto();

drop trigger if exists trg_entrega_pelo_canhoto on public.tms_ctes;
create trigger trg_entrega_pelo_canhoto
  before insert or update on public.tms_ctes
  for each row execute function public.tms_entrega_pelo_canhoto();

-- 3) Corrige as linhas que já existem
update tms_monitoramento_entregas
set dt_entregue = dt_canhoto
where dt_entregue is null and dt_canhoto is not null;

update tms_ctes
set dt_entregue = dt_canhoto
where dt_entregue is null and dt_canhoto is not null;
