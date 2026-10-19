-- =====================================================================
-- Aporte+ — reforço do banco de dados (PROPOSTA: aplicar só com aprovação do dono)
-- Projeto Supabase vldiylyynkgprpfxyyej. Tudo numa transação: se um comando falhar, nada muda.
-- O app atual (v4.1) funciona igual antes e depois — isto só fecha portas e cria uma rede de segurança.
--
-- 1. Histórico automático da carteira (até 200 versões, no máximo 1 a cada 10 min): qualquer gravação
--    ruim (conflito entre aparelhos, importação errada, bug futuro) pode ser desfeita no servidor.
-- 2. Tickers acompanhados: só no formato que o app grava e no máximo 300 por carteira.
-- 3. Uma carteira por pessoa (hoje já é assim).
-- 4. O documento da carteira precisa ter a forma certa e no máximo 10 MB.
-- 5. Permissões mínimas: cada papel só faz o que o app usa (nada de TRUNCATE/DELETE desnecessário;
--    tabelas antigas e vazias da v1 ficam sem acesso pela API).
-- 6. Regras de acesso (RLS) só para quem está logado, no formato recomendado pela Supabase
--    (resolve os 13 avisos "auth_rls_initplan" de desempenho).
-- =====================================================================
begin;

-- 1) Histórico de versões ------------------------------------------------
create table if not exists public.portfolio_state_history (
  id bigint generated always as identity primary key,
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  state jsonb not null,
  state_updated_at timestamptz,
  archived_at timestamptz not null default now()
);
create index if not exists portfolio_state_history_pf_idx on public.portfolio_state_history (portfolio_id, id desc);
alter table public.portfolio_state_history enable row level security;
drop policy if exists "own history (read)" on public.portfolio_state_history;
create policy "own history (read)" on public.portfolio_state_history for select to authenticated
  using (portfolio_id in (select p.id from public.portfolios p where p.user_id = (select auth.uid())));

create or replace function public.archive_portfolio_state() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.state is distinct from new.state and not exists (
       select 1 from public.portfolio_state_history h
        where h.portfolio_id = old.portfolio_id and h.archived_at > now() - interval '10 minutes') then
    insert into public.portfolio_state_history (portfolio_id, state, state_updated_at)
      values (old.portfolio_id, old.state, old.updated_at);
    delete from public.portfolio_state_history h
     where h.portfolio_id = old.portfolio_id
       and h.id not in (select k.id from public.portfolio_state_history k
                         where k.portfolio_id = old.portfolio_id order by k.id desc limit 200);
  end if;
  return new;
end $$;
revoke execute on function public.archive_portfolio_state() from public, anon, authenticated;
drop trigger if exists trg_archive_portfolio_state on public.portfolio_state;
create trigger trg_archive_portfolio_state before update on public.portfolio_state
  for each row execute function public.archive_portfolio_state();

-- 2) Tickers acompanhados: formato e limite -------------------------------
alter table public.tracked_tickers drop constraint if exists tracked_tickers_ticker_format;
alter table public.tracked_tickers add constraint tracked_tickers_ticker_format
  check (ticker ~ '^((US|CRYPTO):)?[A-Z0-9][A-Z0-9.-]{0,14}$') not valid; -- linhas antigas são reescritas pelo app ao salvar

create or replace function public.enforce_tracked_tickers_cap() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.tracked_tickers t where t.portfolio_id = new.portfolio_id) >= 300 then
    raise exception 'limite de 300 tickers por carteira' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.enforce_tracked_tickers_cap() from public, anon, authenticated;
drop trigger if exists trg_tracked_tickers_cap on public.tracked_tickers;
create trigger trg_tracked_tickers_cap before insert on public.tracked_tickers
  for each row execute function public.enforce_tracked_tickers_cap();

-- 3) Uma carteira por pessoa ----------------------------------------------
create unique index if not exists portfolios_user_id_key on public.portfolios (user_id);

-- 4) Forma e tamanho do documento ------------------------------------------
alter table public.portfolio_state drop constraint if exists portfolio_state_shape;
alter table public.portfolio_state add constraint portfolio_state_shape
  check (jsonb_typeof(state) = 'object' and jsonb_typeof(state -> 'classes') = 'array');
alter table public.portfolio_state drop constraint if exists portfolio_state_size;
alter table public.portfolio_state add constraint portfolio_state_size
  check (octet_length(state::text) <= 10000000);

-- 5) Permissões mínimas (conferidas contra todas as chamadas do app) --------
revoke all on all tables in schema public from anon, authenticated;
grant select, insert         on public.portfolios      to authenticated;
grant select, insert, update on public.portfolio_state to authenticated;
grant select, insert, delete on public.tracked_tickers to authenticated;
grant select, insert, update on public.profiles        to authenticated;
grant select on public.ticker_quotes, public.exchange_rates, public.ticker_sentiment,
                public.portfolio_state_history to authenticated;

-- 6) Regras de acesso só para usuários logados ------------------------------
alter policy "own portfolios" on public.portfolios to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
alter policy "own state" on public.portfolio_state to authenticated
  using      (portfolio_id in (select p.id from public.portfolios p where p.user_id = (select auth.uid())))
  with check (portfolio_id in (select p.id from public.portfolios p where p.user_id = (select auth.uid())));
alter policy "own tracked tickers" on public.tracked_tickers to authenticated
  using      (portfolio_id in (select p.id from public.portfolios p where p.user_id = (select auth.uid())))
  with check (portfolio_id in (select p.id from public.portfolios p where p.user_id = (select auth.uid())));
alter policy "own profile" on public.profiles to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
alter policy "read quotes"    on public.ticker_quotes    to authenticated using (true);
alter policy "read rates"     on public.exchange_rates   to authenticated using (true);
alter policy "read sentiment" on public.ticker_sentiment to authenticated using (true);

commit;
