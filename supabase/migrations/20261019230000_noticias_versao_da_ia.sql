-- Aplicada em 19/10/2026 (projeto vldiylyynkgprpfxyyej) como "noticias_versao_da_ia".
-- Versão das instruções da IA que classificou cada notícia (0 = classificada pelas regras).
-- Quando as instruções melhoram (AI_VERSION na função news-refresh), o agendamento relê aos
-- poucos as notícias dos últimos 10 dias com versão menor. Precisa existir ANTES da função nova.
alter table public.ticker_news add column if not exists ai_version smallint not null default 0
  constraint ticker_news_ai_version_chk check (ai_version between 0 and 1000);
-- o que a IA já tinha lido até aqui foi com a primeira versão das instruções
update public.ticker_news set ai_version = 1 where classified_by = 'ia' and ai_version = 0;
