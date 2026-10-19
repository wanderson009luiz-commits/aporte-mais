-- Aplicada em 19/10/2026 como "noticias_limite_por_hora".
-- Uso do modo "sob demanda" da função news-refresh na última hora: por pessoa e no total
-- (linha 00000000-0000-0000-0000-000000000000). Só a função (service role) lê e grava.
create table if not exists public.news_demand (
  user_id uuid primary key,
  window_start timestamptz not null default now(),
  calls integer not null default 0 check (calls >= 0),
  fetched integer not null default 0 check (fetched >= 0),
  ai_calls integer not null default 0 check (ai_calls >= 0)
);
alter table public.news_demand enable row level security;
revoke all on public.news_demand from anon, authenticated;
