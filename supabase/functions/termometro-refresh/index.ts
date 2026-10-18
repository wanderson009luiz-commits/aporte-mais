// ============================================================
// Aporte+ — termometro-refresh (v2)
// Roda via cron (10h e 17h30 de Brasília, dias úteis). Para cada ticker distinto
// cadastrado por qualquer carteira, busca notícias recentes e grava um score 0-100,
// um selo (alta/baixa/neutro/sem_novidade) e um resumo em `ticker_sentiment`.
// NUNCA recomenda compra ou venda — só descreve o que está acontecendo.
//
// Sem o segredo ANTHROPIC_API_KEY a função não faz nada (e não gera erro).
// Em tracked_tickers os tickers podem vir com prefixo de fonte ("US:AAPL", "CRYPTO:BTC");
// aqui o prefixo é removido para buscar notícias pelo código do ativo.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("TERMOMETRO_MODEL") ?? "claude-sonnet-5-5";
const BATCH_SIZE = 8;
const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,14}$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function plainTicker(raw: string): string | null {
  const s = String(raw ?? "").trim().toUpperCase().replace(/^(US|CRYPTO):/, "");
  return TICKER_RE.test(s) ? s : null;
}

function sessionNow(): { session_date: string; session: "abertura" | "fechamento" } {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return { session_date: brt.toISOString().slice(0, 10), session: brt.getUTCHours() < 14 ? "abertura" : "fechamento" };
}

async function analyzeBatch(tickers: string[]): Promise<Record<string, any>> {
  const prompt = `Você é um analista de mercado. Para cada um destes ativos: ${tickers.join(", ")} —
verifique se há notícia relevante nas últimas 24-48h que afete o ativo, priorizando fontes oficiais
(RI da empresa, CVM, B3, Banco Central) e complementando com veículos financeiros confiáveis.

Para CADA ativo, retorne um score de 0 a 100 (mercado reagindo bem = mais alto, mal = mais baixo,
sem novidade relevante = 50), um selo ("alta", "baixa", "neutro" ou "sem_novidade"), um resumo de
1-2 frases do motivo e as fontes usadas (título + url).

IMPORTANTE: você NUNCA recomenda comprar ou vender — apenas descreve o que está acontecendo.
Se não achar nada relevante, retorne score 50, selo "sem_novidade" e diga isso no resumo.

Responda APENAS em JSON, neste formato exato, sem texto antes ou depois:
{"TICKER": {"score": 0-100, "label": "alta|baixa|neutro|sem_novidade", "summary": "...", "sources": [{"title":"...","url":"..."}]}}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!resp.ok) throw new Error(`API respondeu ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return {}; }
}

Deno.serve(async () => {
  if (!ANTHROPIC_API_KEY) return json({ ok: true, skipped: true, reason: "ANTHROPIC_API_KEY não configurada — termômetro desligado" });
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: rows, error } = await supabase.from("tracked_tickers").select("ticker");
  if (error) return json({ ok: false, error: error.message }, 500);
  const tickers = [...new Set((rows ?? []).map((r: any) => plainTicker(r.ticker)).filter(Boolean) as string[])];
  if (!tickers.length) return json({ ok: true, processed: 0, message: "Nenhum ticker cadastrado." });

  const { session_date, session } = sessionNow();
  const { data: already } = await supabase.from("ticker_sentiment").select("ticker").eq("session_date", session_date).eq("session", session);
  const done = new Set((already ?? []).map((r: any) => r.ticker));
  const pending = tickers.filter((t) => !done.has(t));

  let processed = 0;
  const errors: string[] = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    try {
      const results = await analyzeBatch(batch);
      const out = batch.filter((t) => results[t]).map((t) => {
        const r = results[t];
        const sources = Array.isArray(r.sources) ? r.sources.filter((s: any) => /^https?:\/\//i.test(String(s?.url || ""))).slice(0, 5)
          .map((s: any) => ({ title: String(s.title || "").slice(0, 200), url: String(s.url).slice(0, 500) })) : [];
        return {
          ticker: t, session_date, session,
          score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 50))),
          label: ["alta", "baixa", "neutro", "sem_novidade"].includes(r.label) ? r.label : "sem_novidade",
          summary: String(r.summary ?? "Sem informação suficiente.").slice(0, 500),
          sources,
        };
      });
      if (out.length) {
        const { error: e2 } = await supabase.from("ticker_sentiment").upsert(out);
        if (e2) errors.push(e2.message); else processed += out.length;
      }
    } catch (e) { errors.push(String(e)); }
  }
  return json({ ok: true, session, session_date, total: tickers.length, processed, skipped_already_done: done.size, errors });
});
