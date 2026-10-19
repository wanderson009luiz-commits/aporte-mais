// Testes da função price-refresh com fontes e banco falsos (sem rede). Rodar: npm run test:functions
Deno.env.set("SUPABASE_URL", "https://x.supabase.co"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "svc");
let handler: (req: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return { finished: Promise.resolve() }; };
const g = globalThis as any;
g.__CALLS = []; g.__FAIL = new Set();
const YAHOO: Record<string, any> = {};   // símbolo → {price, currency} | 404 | 500
let upstream = 0;
g.fetch = async (url: string) => {
  upstream++;
  const u = new URL(url);
  if (u.host.endsWith("finance.yahoo.com")) {
    const sym = decodeURIComponent(u.pathname.split("/").pop()!);
    const v = YAHOO[sym];
    if (v === 500) return new Response("err", { status: 500 });
    if (v === undefined || v === 404) return new Response(JSON.stringify({ chart: { result: null, error: { code: "Not Found" } } }), { status: 404 });
    return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: v.price, currency: v.currency, chartPreviousClose: v.price, regularMarketTime: 1790000000 } }] } }));
  }
  if (u.host === "api.coingecko.com") {
    if (u.pathname.endsWith("/search")) return new Response(JSON.stringify({ coins: [] }));
    const ids = (u.searchParams.get("ids") || "").split(",");
    const out: any = {}; ids.forEach((id) => { if (id === "bitcoin") out[id] = { brl: 400000, brl_24h_change: 1.2 }; });
    return new Response(JSON.stringify(out));
  }
  throw new Error("fetch inesperado: " + url);
};
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
function reset(tables: any = {}) { g.__DB = { ticker_quotes: [], exchange_rates: [], tracked_tickers: [], ...tables }; g.__CALLS = []; upstream = 0; }
await import("../../supabase/functions/price-refresh/index.ts");
const call = (body: any, token?: string) => handler(new Request("https://x/functions/v1/price-refresh", { method: "POST", headers: token ? { authorization: "Bearer " + token, origin: "https://wanderson009luiz-commits.github.io" } : {}, body: body === undefined ? undefined : JSON.stringify(body) }));
let fails = 0, ok = 0;
const check = (c: boolean, m: string) => { if (c) { ok++; console.log("  ✓", m); } else { fails++; console.log("  ✗", m); } };
const q = (t: string) => g.__DB.ticker_quotes.find((r: any) => r.ticker === t);

Object.assign(YAHOO, { "WEGE3.SA": { price: 47.99, currency: "BRL" }, "USDBRL=X": { price: 5.06, currency: "BRL" }, "EURBRL=X": { price: 5.66, currency: "BRL" }, "AAPL": { price: 231.12, currency: "USD" }, "VALE3.SA": { price: 61.2, currency: "BRL" }, "DOWN3.SA": 500 });

console.log("1) sob demanda exige login");
reset();
let r = await call({ items: [{ ticker: "WEGE3", source: "b3" }] });
check(r.status === 401, "sem token → 401");
r = await call({ items: [{ ticker: "WEGE3", source: "b3" }] }, "ANON-KEY");
check(r.status === 401, "só a chave pública → 401");
check(upstream === 0, "nenhuma busca nas fontes sem login");

console.log("2) sob demanda logado: cotações, desconhecido marcado, cotação boa nunca trocada por ERR");
reset({ ticker_quotes: [{ ticker: "VALE3", price: 60, currency: "BRL", change_percent: 0, updated_at: iso(10 * 60e3) }, { ticker: "OLD11", price: 9.9, currency: "BRL", change_percent: 0, updated_at: iso(60 * 60e3) }, { ticker: "GONE11", price: 7.28, currency: "BRL", change_percent: 0, updated_at: iso(6 * 24 * 3600e3) }] });
r = await call({ items: [{ ticker: "WEGE3", source: "b3" }, { ticker: "XXXX3", source: "b3" }, { ticker: "BTC", source: "crypto" }, { ticker: "AAPL", source: "us" }, { ticker: "OLD11", source: "b3" }, { ticker: "GONE11", source: "b3" }, { ticker: "DOWN3", source: "b3" }, { ticker: "<bad>", source: "b3" }, { ticker: "VALE3", source: "b3" }] }, "USER-TOKEN");
let j = await r.json();
check(r.status === 200 && j.ok === true, "200 ok");
check(r.headers.get("access-control-allow-origin") === "https://wanderson009luiz-commits.github.io", "CORS só para o endereço do app");
check(q("WEGE3")?.price === 47.99 && q("CRYPTO:BTC")?.price === 400000 && q("US:AAPL")?.currency === "USD", "grava B3, cripto e EUA com a moeda certa");
check(q("XXXX3")?.currency === "ERR" && q("XXXX3")?.price === 0, "ticker inexistente vira ERR (não insiste por 30 min)");
check(q("OLD11")?.currency === "BRL" && q("OLD11")?.price === 9.9, "cotação boa recente NÃO é apagada quando a fonte diz 'não existe'");
check(q("GONE11")?.currency === "ERR" && q("GONE11")?.price === 7.28, "ticker que a fonte não reconhece há 6 dias vira ERR, guardando o último preço real (7,28)");
check(!q("DOWN3"), "fonte fora do ar (500) não marca o ticker como desconhecido");
check(q("VALE3")?.price === 61.2, "cotação com mais de 3 min é atualizada");
check(j.failed.includes("b3:XXXX3") && j.failed.includes("b3:DOWN3") && !j.failed.includes("b3:WEGE3"), "lista de falhas certa para o app");
check(!j.quotes.some((x: any) => x.ticker === "<BAD>"), "ticker inválido ignorado");
check(j.fx.length === 2, "devolve o câmbio");

console.log("3) ERR dentro de 30 min não é buscado de novo; depois sim");
upstream = 0;
r = await call({ items: [{ ticker: "XXXX3", source: "b3" }] }, "USER-TOKEN"); j = await r.json();
check(upstream === 0 && j.failed.includes("b3:XXXX3") && j.quotes[0].currency === "ERR", "não busca de novo e avisa o app");
q("XXXX3").updated_at = iso(31 * 60e3);
YAHOO["XXXX3.SA"] = { price: 10, currency: "BRL" };
r = await call({ items: [{ ticker: "XXXX3", source: "b3" }] }, "USER-TOKEN"); j = await r.json();
check(q("XXXX3").currency === "BRL" && q("XXXX3").price === 10, "depois de 30 min tenta de novo e grava a cotação nova");

console.log("4) no máximo 25 tickers nunca vistos por chamada");
reset();
const many = Array.from({ length: 40 }, (_, i) => ({ ticker: `NEW${i}3`, source: "b3" }));
r = await call({ items: many }, "USER-TOKEN"); j = await r.json();
const yahooCalls = upstream - 4; // câmbio: 2 pares (até 2 hosts cada se faltar) — conta só aproximado
check(g.__DB.ticker_quotes.filter((x: any) => x.ticker.startsWith("NEW")).length === 25, `só 25 marcados/buscados (${g.__DB.ticker_quotes.filter((x: any) => x.ticker.startsWith("NEW")).length})`);

console.log("5) agendado: trava de 10 min, paginação, mais antigos primeiro, só contagens");
reset({ tracked_tickers: Array.from({ length: 1500 }, (_, i) => ({ portfolio_id: "p" + (i % 3), ticker: i % 2 ? "WEGE3" : `T${i}3` })) });
Object.keys(YAHOO).forEach((k) => { if (/^T\d+3\.SA$/.test(k)) delete YAHOO[k]; });
for (let i = 0; i < 1500; i += 2) YAHOO[`T${i}3.SA`] = { price: 1 + i / 100, currency: "BRL" };
r = await call({}); j = await r.json();
check(r.status === 200 && j.ok && !j.skipped, "primeira chamada processa");
check(j.total === 751, `lê todos os tickers apesar do limite de 1000 linhas (total ${j.total})`);
check(j.processed === 751 && g.__DB.ticker_quotes.filter((x: any) => /^T\d+3$/.test(x.ticker)).length === 750, `grava todas as cotações (${j.processed})`);
check(!("failedList" in j) && !Array.isArray(j.failed), "resposta só com contagens (não expõe tickers de ninguém)");
r = await call({}); j = await r.json();
check(j.skipped === true, "segunda chamada em menos de 10 min não faz nada");
q("#CRON").updated_at = iso(11 * 60e3);
upstream = 0;
r = await call({}); j = await r.json();
check(!j.skipped && j.needed === 0, "depois de 10 min roda de novo, mas não busca o que tem menos de 3 min");

console.log("6) falha ao gravar o cache não derruba a resposta do app");
reset(); g.__FAIL = new Set(["ticker_quotes.upsert"]);
r = await call({ items: [{ ticker: "WEGE3", source: "b3" }] }, "USER-TOKEN"); j = await r.json();
check(r.status === 200 && j.ok && j.quotes.some((x: any) => x.ticker === "WEGE3" && x.price === 47.99), "app recebe a cotação mesmo sem gravar no cache");
g.__FAIL = new Set();

console.log("7) métodos e corpo inválidos");
check((await handler(new Request("https://x", { method: "GET" }))).status === 405, "GET → 405");
check((await handler(new Request("https://x", { method: "POST", body: "{x" }))).status === 400, "JSON inválido → 400");

console.log(`\n${ok} ok, ${fails} falha(s)`);
Deno.exit(fails ? 1 : 0);
