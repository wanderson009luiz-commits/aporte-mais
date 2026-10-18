// ============================================================
// Aporte+ — price-refresh (v4)
// Cotações automáticas SEM chave e SEM custo:
//   - Ações, FIIs, ETFs e BDRs da B3 → Yahoo Finance (TICKER.SA)
//   - Ações/ETFs dos EUA             → Yahoo Finance (TICKER), em US$
//   - Criptomoedas                    → CoinGecko (em R$); reserva: Yahoo (TICKER-USD) × dólar
//   - Câmbio USD-BRL e EUR-BRL         → Yahoo Finance (USDBRL=X, EURBRL=X)
// Se o segredo BRAPI_TOKEN existir, a brapi.dev vira reserva para a B3.
//
// Dois modos:
//   - Agendado (cron, corpo vazio): atualiza todos os tickers de todas as carteiras.
//     Em tracked_tickers e ticker_quotes a fonte vai no próprio ticker:
//     "WEGE3" (B3), "US:AAPL" (EUA), "CRYPTO:BTC" (cripto) — sem precisar mudar o banco.
//   - Sob demanda (app, corpo {items:[{ticker,source}]}): atualiza só esses, se estiverem
//     com mais de 3 minutos, e devolve as cotações na resposta.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BRAPI_TOKEN = Deno.env.get("BRAPI_TOKEN") ?? "";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,14}$/;
const SOURCES = ["b3", "us", "crypto"] as const;
type Source = typeof SOURCES[number];
type Item = { ticker: string; source: Source };
type QuoteRow = { ticker: string; price: number; currency: string; change_percent: number | null; updated_at: string };
const FRESH_MS = 3 * 60 * 1000;
const MAX_ITEMS = 150;
const CONCURRENCY = 4;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

export function quoteKey(source: Source, ticker: string) {
  if (source === "us") return "US:" + ticker;
  if (source === "crypto") return "CRYPTO:" + ticker;
  return ticker;
}

async function get(url: string, ms = 8000) {
  return await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: AbortSignal.timeout(ms) });
}

type Yq = { price: number; currency: string; changePct: number | null; name: string | null; time: string | null };
async function yahoo(symbol: string): Promise<Yq | null> {
  for (const host of ["query1", "query2"]) {
    try {
      const r = await get(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
      if (r.status === 404) return null; // ticker não existe
      if (!r.ok) { await r.body?.cancel(); continue; }
      const j = await r.json();
      const m = j?.chart?.result?.[0]?.meta;
      const price = Number(m?.regularMarketPrice);
      if (!m || !(price > 0)) return null;
      const prev = Number(m.chartPreviousClose ?? m.previousClose);
      const chg = Number.isFinite(m.regularMarketChangePercent) ? Number(m.regularMarketChangePercent)
        : (prev > 0 ? (price / prev - 1) * 100 : null);
      return {
        price, currency: String(m.currency || "").toUpperCase(), changePct: chg,
        name: (m.longName || m.shortName || null) && String(m.longName || m.shortName).replace(/\s+/g, " ").trim(),
        time: m.regularMarketTime ? new Date(Number(m.regularMarketTime) * 1000).toISOString() : null,
      };
    } catch { /* tenta o outro servidor */ }
  }
  return null;
}

async function brapi(ticker: string): Promise<Yq | null> {
  if (!BRAPI_TOKEN) return null;
  try {
    const r = await get(`https://brapi.dev/api/quote/${encodeURIComponent(ticker)}`, 8000);
    if (!r.ok) { await r.body?.cancel(); return null; }
    const j = await r.json();
    const q = j?.results?.[0];
    const price = Number(q?.regularMarketPrice);
    if (!(price > 0)) return null;
    return { price, currency: String(q.currency || "BRL").toUpperCase(), changePct: Number.isFinite(q.regularMarketChangePercent) ? q.regularMarketChangePercent : null,
      name: q.longName || q.shortName || null, time: q.regularMarketTime || null };
  } catch { return null; }
}

// símbolo → id do CoinGecko (os mais comuns; os demais são procurados na hora)
const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin", XRP: "ripple", ADA: "cardano", DOGE: "dogecoin",
  DOT: "polkadot", AVAX: "avalanche-2", LINK: "chainlink", POL: "polygon-ecosystem-token", MATIC: "matic-network", LTC: "litecoin",
  TRX: "tron", TON: "the-open-network", SHIB: "shiba-inu", UNI: "uniswap", ATOM: "cosmos", XLM: "stellar", NEAR: "near",
  ARB: "arbitrum", OP: "optimism", USDT: "tether", USDC: "usd-coin", DAI: "dai", BCH: "bitcoin-cash", ETC: "ethereum-classic",
  APT: "aptos", SUI: "sui", PEPE: "pepe", HBAR: "hedera-hashgraph", FIL: "filecoin", ICP: "internet-computer", AAVE: "aave",
  RENDER: "render-token", INJ: "injective-protocol", ALGO: "algorand", XMR: "monero", VET: "vechain", SAND: "the-sandbox",
  MANA: "decentraland", AXS: "axie-infinity", GRT: "the-graph", CRV: "curve-dao-token", LDO: "lido-dao", KAS: "kaspa",
  TAO: "bittensor", HYPE: "hyperliquid", WLD: "worldcoin-wld", PAXG: "pax-gold", XAUT: "tether-gold",
};

async function coingeckoId(symbol: string): Promise<string | null> {
  if (COINGECKO_IDS[symbol]) return COINGECKO_IDS[symbol];
  try {
    const r = await get(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`);
    if (!r.ok) { await r.body?.cancel(); return null; }
    const j = await r.json();
    const hit = (j?.coins ?? []).find((c: any) => String(c.symbol).toUpperCase() === symbol);
    return hit?.id ?? null;
  } catch { return null; }
}

async function cryptoQuotes(symbols: string[], usdBrl: number | null): Promise<Map<string, Yq>> {
  const out = new Map<string, Yq>();
  const ids = new Map<string, string>(); // id → símbolo
  for (const s of symbols) { const id = await coingeckoId(s); if (id) ids.set(id, s); }
  if (ids.size > 0) {
    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${[...ids.keys()].join(",")}&vs_currencies=brl&include_24hr_change=true&include_last_updated_at=true`;
      const r = await get(url, 10000);
      if (r.ok) {
        const j = await r.json();
        for (const [id, sym] of ids) {
          const v = j?.[id];
          const price = Number(v?.brl);
          if (price > 0) out.set(sym, { price, currency: "BRL", changePct: Number.isFinite(v?.brl_24h_change) ? v.brl_24h_change : null, name: id, time: v?.last_updated_at ? new Date(v.last_updated_at * 1000).toISOString() : null });
        }
      } else await r.body?.cancel();
    } catch { /* cai para a reserva */ }
  }
  // reserva: Yahoo em dólar convertido para real
  for (const s of symbols) {
    if (out.has(s) || !(usdBrl && usdBrl > 0)) continue;
    const y = await yahoo(`${s}-USD`);
    if (y && y.currency === "USD") out.set(s, { ...y, price: y.price * usdBrl, currency: "BRL" });
  }
  return out;
}

async function pool<T>(items: T[], worker: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) { const k = i++; await worker(items[k]); }
  }));
}

function b3Symbol(t: string) { return (/^[A-Z]{4}\d{1,2}F$/.test(t) ? t.slice(0, -1) : t) + ".SA"; }

async function refreshFx(supabase: any): Promise<{ usd: number | null; rows: any[]; errors: string[] }> {
  const errors: string[] = [];
  const rows: any[] = [];
  let usd: number | null = null;
  for (const [pair, sym] of [["USD-BRL", "USDBRL=X"], ["EUR-BRL", "EURBRL=X"]] as const) {
    const y = await yahoo(sym);
    if (y && y.currency === "BRL" && y.price > 0) {
      rows.push({ pair, bid_price: y.price, ask_price: y.price, updated_at: new Date().toISOString() });
      if (pair === "USD-BRL") usd = y.price;
    } else errors.push(`Câmbio ${pair} indisponível`);
  }
  if (rows.length) { const { error } = await supabase.from("exchange_rates").upsert(rows); if (error) errors.push(error.message); }
  if (usd === null) { // usa o último conhecido
    const { data } = await supabase.from("exchange_rates").select("ask_price").eq("pair", "USD-BRL").maybeSingle();
    if (data?.ask_price) usd = Number(data.ask_price);
  }
  return { usd, rows, errors };
}

async function fetchItems(items: Item[], usdBrl: number | null): Promise<{ rows: QuoteRow[]; failed: string[] }> {
  const now = new Date().toISOString();
  const rows: QuoteRow[] = [];
  const failed: string[] = [];
  const push = (it: Item, q: Yq | null, expected: string) => {
    if (q && q.price > 0 && q.currency === expected) {
      rows.push({ ticker: quoteKey(it.source, it.ticker), price: Math.round(q.price * 1e6) / 1e6, currency: q.currency,
        change_percent: q.changePct === null ? null : Math.round(q.changePct * 1000) / 1000, updated_at: now });
    } else failed.push(`${it.source}:${it.ticker}`);
  };
  const stocks = items.filter((x) => x.source !== "crypto");
  await pool(stocks, async (it) => {
    if (it.source === "b3") push(it, (await yahoo(b3Symbol(it.ticker))) ?? (await brapi(it.ticker)), "BRL");
    else push(it, await yahoo(it.ticker.replace(".", "-")), "USD");
  });
  const cryptos = items.filter((x) => x.source === "crypto");
  if (cryptos.length) {
    const m = await cryptoQuotes(cryptos.map((c) => c.ticker), usdBrl);
    cryptos.forEach((it) => push(it, m.get(it.ticker) ?? null, "BRL"));
  }
  return { rows, failed };
}

/** "US:AAPL" → {AAPL, us}; "CRYPTO:BTC" → {BTC, crypto}; "WEGE3" → {WEGE3, b3}. */
function fromKey(raw: string): Item | null {
  const s = String(raw ?? "").trim().toUpperCase();
  let source: Source = "b3", ticker = s;
  if (s.startsWith("US:")) { source = "us"; ticker = s.slice(3); }
  else if (s.startsWith("CRYPTO:")) { source = "crypto"; ticker = s.slice(7); }
  else if (!/\d/.test(s) && COINGECKO_IDS[s]) source = "crypto"; // versões antigas gravavam BTC/ETH sem prefixo
  return TICKER_RE.test(ticker) ? { ticker, source } : null;
}

function cleanItems(raw: unknown, cap = MAX_ITEMS): Item[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const x of raw) {
    const ticker = String((x as any)?.ticker ?? "").trim().toUpperCase();
    const source = String((x as any)?.source ?? "b3") as Source;
    if (!TICKER_RE.test(ticker) || !SOURCES.includes(source)) continue;
    const k = source + "|" + ticker;
    if (seen.has(k)) continue;
    seen.add(k); out.push({ ticker, source });
    if (out.length >= cap) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  let body: any = null;
  try { const t = await req.text(); body = t ? JSON.parse(t) : null; } catch { body = null; }

  // ---------- sob demanda (app) ----------
  if (body && Array.isArray(body.items)) {
    const items = cleanItems(body.items);
    const keys = items.map((it) => quoteKey(it.source, it.ticker));
    const { data: existing } = keys.length ? await supabase.from("ticker_quotes").select("*").in("ticker", keys) : { data: [] };
    const byKey = new Map((existing ?? []).map((r: any) => [r.ticker, r]));
    const stale = items.filter((it) => {
      const r: any = byKey.get(quoteKey(it.source, it.ticker));
      return !r || Date.now() - new Date(r.updated_at).getTime() > FRESH_MS;
    });
    const { data: fxRows } = await supabase.from("exchange_rates").select("*");
    const fxFresh = (fxRows ?? []).length >= 2 && (fxRows ?? []).every((r: any) => Date.now() - new Date(r.updated_at).getTime() < FRESH_MS);
    const fx = fxFresh ? { usd: Number((fxRows ?? []).find((r: any) => r.pair === "USD-BRL")?.ask_price) || null, rows: fxRows ?? [], errors: [] } : await refreshFx(supabase);
    const { rows, failed } = await fetchItems(stale, fx.usd);
    if (rows.length) { const { error } = await supabase.from("ticker_quotes").upsert(rows); if (error) return json({ ok: false, error: error.message }, 500); }
    rows.forEach((r) => byKey.set(r.ticker, r));
    const { data: fxAll } = await supabase.from("exchange_rates").select("*");
    return json({ ok: true, requested: items.length, refreshed: rows.length, failed, quotes: keys.map((k) => byKey.get(k)).filter(Boolean), fx: fxAll ?? [] });
  }

  // ---------- agendado (cron) ----------
  const fx = await refreshFx(supabase);
  const { data: tracked, error } = await supabase.from("tracked_tickers").select("ticker");
  if (error) return json({ ok: false, error: error.message }, 500);
  const items = cleanItems((tracked ?? []).map((r: any) => fromKey(r.ticker)).filter(Boolean), 5000);
  const { rows, failed } = await fetchItems(items, fx.usd);
  if (rows.length) { const { error: e2 } = await supabase.from("ticker_quotes").upsert(rows); if (e2) return json({ ok: false, error: e2.message }, 500); }
  return json({ ok: true, total: items.length, processed: rows.length, failed, fx: fx.rows.map((r: any) => `${r.pair}=${r.ask_price}`), fx_errors: fx.errors });
});
