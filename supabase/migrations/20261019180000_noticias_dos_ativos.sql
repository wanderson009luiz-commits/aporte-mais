-- Aplicada em 19/10/2026 (projeto vldiylyynkgprpfxyyej) como "noticias_dos_ativos".
-- Notícias dos ativos acompanhados. Só a função news-refresh (service role) escreve; quem está logado só lê.
create table if not exists public.ticker_news (
  id text primary key,
  ticker text not null,
  title text not null,
  url text not null,
  source text,
  published_at timestamptz not null,
  impact text not null default 'baixo',
  direction text not null default 'neutro',
  relevant boolean not null default true,
  summary text,
  classified_by text not null default 'regras',
  fetched_at timestamptz not null default now(),
  constraint ticker_news_id_chk check (id ~ '^[0-9a-f]{40}$'),
  constraint ticker_news_ticker_chk check (ticker ~ '^(US:|CRYPTO:)?[A-Z0-9][A-Z0-9.\-]{0,14}$'),
  constraint ticker_news_title_chk check (char_length(title) between 1 and 300),
  constraint ticker_news_url_chk check (url ~ '^https://' and char_length(url) <= 2000),
  constraint ticker_news_source_chk check (source is null or char_length(source) <= 80),
  constraint ticker_news_impact_chk check (impact in ('baixo', 'medio', 'alto')),
  constraint ticker_news_direction_chk check (direction in ('positivo', 'negativo', 'neutro')),
  constraint ticker_news_summary_chk check (summary is null or char_length(summary) <= 400),
  constraint ticker_news_by_chk check (classified_by in ('ia', 'regras'))
);
create index if not exists ticker_news_ticker_pub_idx on public.ticker_news (ticker, published_at desc);
create index if not exists ticker_news_regras_idx on public.ticker_news (published_at desc) where classified_by = 'regras';

create table if not exists public.ticker_news_checks (
  ticker text primary key,
  checked_at timestamptz not null default now(),
  found integer not null default 0,
  ok boolean not null default true,
  constraint ticker_news_checks_ticker_chk check (ticker = '#NEWS' or ticker ~ '^(US:|CRYPTO:)?[A-Z0-9][A-Z0-9.\-]{0,14}$')
);

alter table public.ticker_news enable row level security;
alter table public.ticker_news_checks enable row level security;
create policy "ticker_news: leitura por quem está logado" on public.ticker_news for select to authenticated using (true);
create policy "ticker_news_checks: leitura por quem está logado" on public.ticker_news_checks for select to authenticated using (true);
revoke all on public.ticker_news, public.ticker_news_checks from anon;
revoke insert, update, delete, truncate, references, trigger on public.ticker_news, public.ticker_news_checks from authenticated;
grant select on public.ticker_news, public.ticker_news_checks to authenticated;

-- Agendamento (job 4, criado com cron.schedule e depois alterado para de hora em hora):
-- select cron.schedule('news-refresh', '7 10-23 * * *', $job$
--   select net.http_post(url := 'https://vldiylyynkgprpfxyyej.supabase.co/functions/v1/news-refresh',
--     headers := jsonb_build_object('Authorization', 'Bearer <chave pública anon>', 'Content-Type', 'application/json'),
--     body := '{}'::jsonb, timeout_milliseconds := 120000);
-- $job$);
