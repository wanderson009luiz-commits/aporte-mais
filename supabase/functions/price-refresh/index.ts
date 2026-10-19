// ============================================================
// Aporte+ — price-refresh (v6, reforçada)
// Cotações automáticas SEM chave e SEM custo:
//   - Ações, FIIs, ETFs e BDRs da B3 → Yahoo Finance (TICKER.SA)
//   - Ações/ETFs dos EUA             → Yahoo Finance (TICKER), em US$
//   - Criptomoedas                    → CoinGecko (em R$); reserva: Yahoo (TICKER-USD) × dólar
//   - Câmbio USD-BRL e EUR-BRL         → Yahoo Finance (USDBRL=X, EURBRL=X)
// Se o segredo BRAPI_TOKEN existir, a brapi.dev vira reserva para a B3.
//
// Dois modos:
//   - Sob demanda (app logado, corpo {items:[{ticker,source}]}): exige o login da pessoa
//     (a chave pública sozinha é recusada com 401). Atualiza só os itens com mais de 3 min,
//     no máximo 100 por chamada e no máximo 25 tickers nunca vistos (proteção das fontes).
//   - Agendado (cron, corpo vazio): atualiza todos os tickers acompanhados, os mais antigos
//     primeiro, gravando de 25 em 25 e parando antes do limite de tempo. Roda no máximo uma vez
//     a cada 10 min (chamadas extras não fazem nada), e responde só contagens.
// Ticker que a fonte não reconhece fica marcado por 30 min (linha com moeda "ERR") para não insistir;
// uma cotação boa recente NUNCA é trocada por "ERR", e quando um ticker morre (5+ dias sem existir na
// fonte) a linha vira "ERR" mas GUARDA o último preço real (o app usa como último preço conhecido).
// Em tracked_tickers e ticker_quotes a fonte vai no próprio ticker: "WEGE3" (B3), "US:AAPL"
// (EUA), "CRYPTO:BTC" (cripto). Linhas que começam com "#" são controle interno.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BRAPI_TOKEN = Deno.env.get("BRAPI_TOKEN") ?? "";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,14}$/;
const SOURCES = ["b3", "us", "crypto"] as const;
type Source = typeof SOURCES[number];
type Item = { ticker: string; source: Source };
type QuoteRow = { ticker: string; price: number; currency: string; change_percent: number | null; updated_at: string };
const FRESH_MS = 3 * 60 * 1000;          // cotação com menos de 3 min não é buscada de novo
const ERR_TTL_MS = 30 * 60 * 1000;       // ticker desconhecido: tenta de novo depois de 30 min
const DEAD_AFTER_MS = 5 * 24 * 3600e3;   // cotação boa só vira "desconhecido" se a fonte diz que não existe E ela tem mais de 5 dias
const CRON_EVERY_MS = 10 * 60 * 1000;    // modo agendado roda no máximo 1x a cada 10 min
const CRON_BUDGET_MS = 110 * 1000;       // para de buscar antes do limite de 150 s da função
const MAX_ITEMS = 100;
const MAX_NEW_PER_CALL = 25;
const CONCURRENCY = 4;
const FETCH_MS = 5000;

const ALLOWED_ORIGINS = ["https://wanderson009luiz-commits.github.io"];
function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  const ok = ALLOWED_ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    "Access-Control-Allow-Origin": ok ? o : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "content-type": "application/json" } });
}

export function quoteKey(source: Source, ticker: string) {
  if (source === "us") return "US:" + ticker;
  if (source === "crypto") return "CRYPTO:" + ticker;
  return ticker;
}

async function get(url: string, ms = FETCH_MS) {
  return await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: AbortSignal.timeout(ms) });
}

type Yq = { price: number; currency: string; changePct: number | null; time: string | null };
/** Resultado de uma fonte: cotação, "não existe" (definitivo) ou erro (tentar de novo depois). */
type Res = Yq | "notfound" | null;

async function yahoo(symbol: string): Promise<Res> {
  for (const host of ["query1", "query2"]) {
    try {
      const r = await get(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
      if (r.status === 404) { await r.body?.cancel(); return "notfound"; }
      if (!r.ok) { await r.body?.cancel(); if (r.status >= 500 || r.status === 429) continue; return null; }
      const j = await r.json();
      if (j?.chart?.error?.code === "Not Found") return "notfound";
      const m = j?.chart?.result?.[0]?.meta;
      const price = Number(m?.regularMarketPrice);
      if (!m) return "notfound";
      if (!(price > 0)) return null;
      const prev = Number(m.chartPreviousClose ?? m.previousClose);
      const chg = Number.isFinite(m.regularMarketChangePercent) ? Number(m.regularMarketChangePercent)
        : (prev > 0 ? (price / prev - 1) * 100 : null);
      return { price, currency: String(m.currency || "").toUpperCase(), changePct: chg,
        time: m.regularMarketTime ? new Date(Number(m.regularMarketTime) * 1000).toISOString() : null };
    } catch { /* rede/tempo: tenta o outro servidor */ }
  }
  return null;
}

async function brapi(ticker: string): Promise<Res> {
  if (!BRAPI_TOKEN) return null;
  try {
    const r = await get(`https://brapi.dev/api/quote/${encodeURIComponent(ticker)}?token=${encodeURIComponent(BRAPI_TOKEN)}`);
    if (r.status === 404) { await r.body?.cancel(); return "notfound"; }
    if (!r.ok) { await r.body?.cancel(); return null; }
    const j = await r.json();
    const q = j?.results?.[0];
    const price = Number(q?.regularMarketPrice);
    if (!(price > 0)) return null;
    return { price, currency: String(q.currency || "BRL").toUpperCase(), changePct: Number.isFinite(q.regularMarketChangePercent) ? q.regularMarketChangePercent : null,
      time: q.regularMarketTime || null };
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

async function coingeckoId(symbol: string): Promise<string | "notfound" | null> {
  if (COINGECKO_IDS[symbol]) return COINGECKO_IDS[symbol];
  try {
    const r = await get(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`);
    if (!r.ok) { await r.body?.cancel(); return null; }
    const j = await r.json();
    const hit = (j?.coins ?? []).find((c: any) => String(c.symbol).toUpperCase() === symbol);
    return hit?.id ?? "notfound";
  } catch { return null; }
}

async function cryptoQuotes(symbols: string[], usdBrl: number | null): Promise<Map<string, Res>> {
  const out = new Map<string, Res>();
  const ids = new Map<string, string>(); // id → símbolo
  const unknown = new Set<string>();
  for (const s of symbols) { const id = await coingeckoId(s); if (id === "notfound") unknown.add(s); else if (id) ids.set(id, s); }
  if (ids.size > 0) {
    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${[...ids.keys()].join(",")}&vs_currencies=brl&include_24hr_change=true&include_last_updated_at=true`;
      const r = await get(url, 8000);
      if (r.ok) {
        const j = await r.json();
        for (const [id, sym] of ids) {
          const v = j?.[id];
          const price = Number(v?.brl);
          if (price > 0) out.set(sym, { price, currency: "BRL", changePct: Number.isFinite(v?.brl_24h_change) ? v.brl_24h_change : null, time: v?.last_updated_at ? new Date(v.last_updated_at * 1000).toISOString() : null });
        }
      } else await r.body?.cancel();
    } catch { /* cai para a reserva */ }
  }
  // reserva: Yahoo em dólar convertido para real
  for (const s of symbols) {
    if (out.has(s)) continue;
    if (!(usdBrl && usdBrl > 0)) { out.set(s, null); continue; }
    const y = await yahoo(`${s}-USD`);
    if (y && y !== "notfound" && y.currency === "USD") out.set(s, { ...y, price: y.price * usdBrl, currency: "BRL" });
    else out.set(s, y === "notfound" && unknown.has(s) ? "notfound" : null);
  }
  return out;
}

async function pool<T>(items: T[], worker: (x: T) => Promise<void>, deadline = Infinity) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length && Date.now() < deadline) { const k = i++; await worker(items[k]); }
  }));
}

function b3Symbol(t: string) { return (/^[A-Z]{4}\d{1,2}F$/.test(t) ? t.slice(0, -1) : t) + ".SA"; }

async function refreshFx(supabase: any): Promise<{ usd: number | null; ok: number }> {
  const rows: any[] = [];
  let usd: number | null = null;
  for (const [pair, sym] of [["USD-BRL", "USDBRL=X"], ["EUR-BRL", "EURBRL=X"]] as const) {
    const y = await yahoo(sym);
    if (y && y !== "notfound" && y.currency === "BRL" && y.price > 0) {
      rows.push({ pair, bid_price: y.price, ask_price: y.price, updated_at: new Date().toISOString() });
      if (pair === "USD-BRL") usd = y.price;
    }
  }
  if (rows.length) { const { error } = await supabase.from("exchange_rates").upsert(rows); if (error) console.error("exchange_rates upsert", error); }
  if (usd === null) { // usa o último conhecido
    const { data } = await supabase.from("exchange_rates").select("ask_price").eq("pair", "USD-BRL").maybeSingle();
    if (data?.ask_price) usd = Number(data.ask_price);
  }
  return { usd, ok: rows.length };
}

const expectedCurrency = (it: Item) => (it.source === "us" ? "USD" : "BRL");

/** Busca as cotações; cada resultado é gravado pelo `sink` assim que chega (nada se perde se o tempo acabar). */
async function fetchItems(items: Item[], usdBrl: number | null, sink: (it: Item, r: Res) => void, deadline = Infinity) {
  const stocks = items.filter((x) => x.source !== "crypto");
  await pool(stocks, async (it) => {
    if (it.source === "b3") {
      let r = await yahoo(b3Symbol(it.ticker));
      if (!r || r === "notfound") { const b = await brapi(it.ticker); if (b) r = b === "notfound" && r === null ? null : b; }
      sink(it, r);
    } else sink(it, await yahoo(it.ticker.replace(".", "-")));
  }, deadline);
  const cryptos = items.filter((x) => x.source === "crypto");
  if (cryptos.length && Date.now() < deadline) {
    const m = await cryptoQuotes(cryptos.map((c) => c.ticker), usdBrl);
    cryptos.forEach((it) => sink(it, m.get(it.ticker) ?? null));
  }
}

function toRow(it: Item, q: Yq, now: string): QuoteRow | null {
  if (!(q.price > 0) || q.currency !== expectedCurrency(it)) return null;
  return { ticker: quoteKey(it.source, it.ticker), price: Math.round(q.price * 1e6) / 1e6, currency: q.currency,
    change_percent: q.changePct === null || !Number.isFinite(q.changePct) ? null : Math.round(q.changePct * 1000) / 1000, updated_at: now };
}

/**
 * Grava cotações boas (upsert) e marca desconhecidos. Uma cotação boa recente NUNCA é trocada por
 * "desconhecido" (a fonte pode ter falhado só agora); só uma com mais de 5 dias, quando a fonte
 * diz que o ticker não existe mais (ex.: fundo incorporado) — senão o app usaria um preço velho.
 */
async function persist(supabase: any, good: QuoteRow[], notFound: string[], dead: string[] = []) {
  let errors = 0;
  if (dead.length) {
    const cutoff = new Date(Date.now() - DEAD_AFTER_MS).toISOString();
    // mantém o preço: é o último preço real conhecido desse ticker
    const { error } = await supabase.from("ticker_quotes").update({ currency: "ERR", change_percent: null, updated_at: new Date().toISOString() })
      .in("ticker", dead).neq("currency", "ERR").lt("updated_at", cutoff);
    if (error) { errors++; console.error("ticker_quotes dead", error); }
  }
  for (let i = 0; i < good.length; i += 25) {
    const { error } = await supabase.from("ticker_quotes").upsert(good.slice(i, i + 25));
    if (error) { errors++; console.error("ticker_quotes upsert", error); }
  }
  if (notFound.length) {
    const now = new Date().toISOString();
    // novos desconhecidos: só insere se ainda não existe linha (ignoreDuplicates não toca nas existentes)
    const { error: e1 } = await supabase.from("ticker_quotes")
      .upsert(notFound.map((t) => ({ ticker: t, price: 0, currency: "ERR", change_percent: null, updated_at: now })), { onConflict: "ticker", ignoreDuplicates: true });
    if (e1) { errors++; console.error("ticker_quotes ERR insert", e1); }
    // os que já estavam marcados como desconhecidos: renova a marcação (cotação boa nunca é tocada)
    const { error: e2 } = await supabase.from("ticker_quotes").update({ updated_at: now }).in("ticker", notFound).eq("currency", "ERR");
    if (e2) { errors++; console.error("ticker_quotes ERR touch", e2); }
  }
  return errors;
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

function cleanItems(raw: unknown, cap: number): Item[] {
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

async function rowsByKey(supabase: any, keys: string[]) {
  const map = new Map<string, any>();
  for (let i = 0; i < keys.length; i += 200) {
    const { data, error } = await supabase.from("ticker_quotes").select("ticker, price, currency, change_percent, updated_at").in("ticker", keys.slice(i, i + 200));
    if (error) throw error;
    (data ?? []).forEach((r: any) => map.set(r.ticker, r));
  }
  return map;
}
const age = (r: any) => (r ? Date.now() - new Date(r.updated_at).getTime() : Infinity);
const needsFetch = (r: any) => !r || (r.currency === "ERR" ? age(r) > ERR_TTL_MS : age(r) > FRESH_MS);

/** Trava do modo agendado: só um processamento a cada 10 min, mesmo que alguém chame a função várias vezes. */
async function claimCronSlot(supabase: any): Promise<boolean> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - CRON_EVERY_MS).toISOString();
  const { data, error } = await supabase.from("ticker_quotes").update({ updated_at: now.toISOString() })
    .eq("ticker", "#CRON").lt("updated_at", cutoff).select("ticker");
  if (error) { console.error("cron claim", error); return false; }
  if (data && data.length) return true;
  const { data: ins, error: e2 } = await supabase.from("ticker_quotes")
    .upsert([{ ticker: "#CRON", price: 0, currency: "SYS", change_percent: null, updated_at: now.toISOString() }], { onConflict: "ticker", ignoreDuplicates: true })
    .select("ticker");
  if (e2) { console.error("cron claim insert", e2); return false; }
  return !!(ins && ins.length); // só ganha a vez quem criou a linha
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "método não permitido" }, 405);
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let body: any = null;
  try { const t = await req.text(); body = t ? JSON.parse(t) : {}; } catch { return json(req, { ok: false, error: "json inválido" }, 400); }

  try {
    // ---------- sob demanda (app logado) ----------
    if (body && Array.isArray(body.items)) {
      const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: auth } = jwt ? await supabase.auth.getUser(jwt) : { data: null };
      if (!auth?.user) return json(req, { ok: false, error: "login necessário" }, 401);
      const items = cleanItems(body.items, MAX_ITEMS);
      const keys = items.map((it) => quoteKey(it.source, it.ticker));
      const byKey = await rowsByKey(supabase, keys);
      let fresh = 0;
      const toFetch = items.filter((it) => {
        const r = byKey.get(quoteKey(it.source, it.ticker));
        if (!needsFetch(r)) return false;
        if (!r) { fresh++; return fresh <= MAX_NEW_PER_CALL; } // nunca visto: limite por chamada
        return true;
      });
      const { data: fxRows } = await supabase.from("exchange_rates").select("*");
      const fxFresh = (fxRows ?? []).length >= 2 && (fxRows ?? []).every((r: any) => age(r) < FRESH_MS);
      const usd = fxFresh ? Number((fxRows ?? []).find((r: any) => r.pair === "USD-BRL")?.ask_price) || null : (await refreshFx(supabase)).usd;
      const now = new Date().toISOString();
      const good: QuoteRow[] = []; const notFound: string[] = []; const dead: string[] = []; const failed: string[] = [];
      await fetchItems(toFetch, usd, (it, r) => {
        const row = r && r !== "notfound" ? toRow(it, r, now) : null;
        if (row) good.push(row);
        else {
          failed.push(`${it.source}:${it.ticker}`);
          const k = quoteKey(it.source, it.ticker);
          const cur = byKey.get(k);
          if (r === "notfound") { if (!cur || cur.currency === "ERR") notFound.push(k); else if (age(cur) > DEAD_AFTER_MS) dead.push(k); }
        }
      });
      const errors = await persist(supabase, good, notFound, dead); // falha ao gravar o cache não impede de responder
      good.forEach((r) => byKey.set(r.ticker, r));
      notFound.forEach((k) => byKey.set(k, { ticker: k, price: Number(byKey.get(k)?.price) || 0, currency: "ERR", change_percent: null, updated_at: now }));
      dead.forEach((k) => byKey.set(k, { ...byKey.get(k), currency: "ERR", change_percent: null, updated_at: now }));
      // os que já estavam marcados como desconhecidos também voltam como falha (o app mostra o aviso)
      items.forEach((it) => { const r = byKey.get(quoteKey(it.source, it.ticker)); if (r?.currency === "ERR" && !failed.includes(`${it.source}:${it.ticker}`)) failed.push(`${it.source}:${it.ticker}`); });
      const { data: fxAll } = await supabase.from("exchange_rates").select("pair, bid_price, ask_price, updated_at");
      return json(req, { ok: true, requested: items.length, refreshed: good.length, failed,
        quotes: keys.map((k) => byKey.get(k)).filter(Boolean), fx: fxAll ?? [], ...(errors ? { warning: "cache não gravado" } : {}) });
    }

    // ---------- agendado (cron) ----------
    if (!(await claimCronSlot(supabase))) return json(req, { ok: true, skipped: true, reason: "atualizado há menos de 10 min" });
    const started = Date.now();
    const fx = await refreshFx(supabase);
    const keys = new Set<string>();
    for (let from = 0; ; from += 1000) { // paginado: nunca perde tickers por causa do limite de 1000 linhas
      const { data, error } = await supabase.from("tracked_tickers").select("ticker").order("ticker").range(from, from + 999);
      if (error) throw error;
      (data ?? []).forEach((r: any) => { const it = fromKey(r.ticker); if (it) keys.add(quoteKey(it.source, it.ticker)); });
      if (!data || data.length < 1000) break;
    }
    const all = [...keys].map((k) => fromKey(k)!).filter(Boolean);
    const byKey = await rowsByKey(supabase, [...keys]);
    // só o que precisa, os mais antigos primeiro
    const items = all.filter((it) => needsFetch(byKey.get(quoteKey(it.source, it.ticker))))
      .sort((a, b) => age(byKey.get(quoteKey(b.source, b.ticker))) - age(byKey.get(quoteKey(a.source, a.ticker))));
    const now = new Date().toISOString();
    let good: QuoteRow[] = []; let notFound: string[] = []; let dead: string[] = [];
    let processed = 0, unknown = 0, failedN = 0, errors = 0;
    const pending: Promise<void>[] = [];
    const flush = () => { const g = good, n = notFound, d = dead; good = []; notFound = []; dead = []; const p = persist(supabase, g, n, d).then((e) => { errors += e; }); pending.push(p); return p; };
    await fetchItems(items, fx.usd, (it, r) => {
      const row = r && r !== "notfound" ? toRow(it, r, now) : null;
      if (row) { good.push(row); processed++; }
      else {
        failedN++;
        const k = quoteKey(it.source, it.ticker); const cur = byKey.get(k);
        if (r === "notfound") { unknown++; if (!cur || cur.currency === "ERR") notFound.push(k); else if (age(cur) > DEAD_AFTER_MS) dead.push(k); }
      }
      if (good.length + notFound.length + dead.length >= 25) flush();
    }, started + CRON_BUDGET_MS);
    flush();
    await Promise.all(pending); // espera todas as gravações antes de responder
    return json(req, { ok: errors === 0, total: all.length, needed: items.length, processed, unknown, failed: failedN, fx: fx.ok, ms: Date.now() - started });
  } catch (e) {
    console.error("price-refresh", e);
    return json(req, { ok: false, error: "erro interno" }, 500);
  }
});
