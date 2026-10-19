// Testes da função news-refresh com Google Notícias, IA e banco falsos (sem rede). Rodar: npm run test:functions
Deno.env.set("SUPABASE_URL", "https://x.supabase.co"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "svc");
const handlers: ((req: Request) => Promise<Response>)[] = [];
(Deno as any).serve = (h: any) => { handlers.push(h); return { finished: Promise.resolve() }; };
const g = globalThis as any;
g.__CALLS = []; g.__FAIL = new Set();

const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3600e3).toISOString();
const rfc = (h: number) => new Date(NOW - h * 3600e3).toUTCString();
type FakeItem = { title: string; source?: string; h?: number; link?: string };
/** RSS no formato do Google Notícias (título "… - Fonte", CDATA/entidades, <source>). */
function rss(items: FakeItem[]) {
  const body = items.map((x, k) => `<item><title>${x.title}${x.source ? " - " + x.source : ""}</title><link>${x.link ?? `https://news.google.com/rss/articles/ART${k}${x.title.length}?oc=5`}</link><guid isPermaLink="false">G${k}</guid><pubDate>${rfc(x.h ?? k + 1)}</pubDate><description>&lt;a href="x"&gt;${x.title}&lt;/a&gt;</description>${x.source ? `<source url="https://fonte.com.br">${x.source}</source>` : ""}</item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0"><channel><title>t</title>${body}</channel></rss>`;
}
const FEEDS: Record<string, string | number> = {};   // termo buscado → xml | status
let rssCalls: string[] = [];
let aiBodies: any[] = [];
let aiMode: "ok" | "bad" | "down" = "ok";
g.fetch = async (url: string, init?: any) => {
  const u = new URL(url);
  if (u.host === "news.google.com") {
    const q = (u.searchParams.get("q") || "").replace(/ when:7d$/, "").replace(/ stock$/, "").replace(/"/g, "");
    rssCalls.push(q);
    const v = FEEDS[q];
    if (typeof v === "number") return new Response("err", { status: v });
    return new Response(v ?? rss([]), { headers: { "content-type": "application/xml" } });
  }
  if (u.host === "api.anthropic.com" || u.host === "generativelanguage.googleapis.com") {
    const body = JSON.parse(init.body);
    aiBodies.push({ host: u.host, path: u.pathname, body, headers: init.headers });
    if (aiMode === "down") return new Response("err", { status: 529 });
    if (u.host === "generativelanguage.googleapis.com" && u.pathname.includes("gemini-flash-latest")) return new Response("not found", { status: 404 });
    const text = u.host === "api.anthropic.com" ? body.messages[0].content : body.contents[0].parts[0].text;
    const items = JSON.parse(text.replace(/^Itens:\n/, ""));
    const itens = items.map((x: any) => ({
      i: x.i, relevante: !/lista/i.test(x.titulo), impacto: /\(baixo\)/i.test(x.titulo) ? "baixo" : /alto/i.test(x.titulo) ? "alto" : "medio", direcao: /ruim|corta/i.test(x.titulo) ? "negativo" : "positivo",
      resumo: `Resumo de teste para ${x.ativo}: o que aconteceu e por que importa.`,
    }));
    if (aiMode === "bad" && itens.length) itens[0].impacto = "enorme"; // item inválido: fica com as regras
    if (u.host === "api.anthropic.com") return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "classificar_noticias", input: { itens } }] }));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ itens }) }] } }] }));
  }
  throw new Error("fetch inesperado: " + url);
};
function reset(tables: any = {}) {
  g.__DB = { ticker_news: [], ticker_news_checks: [], tracked_tickers: [], portfolios: [{ id: "p1", user_id: "u1" }, { id: "p2", user_id: "u2" }], ...tables };
  g.__CALLS = []; rssCalls = []; aiBodies = [];
}
let fails = 0, ok = 0;
const check = (c: boolean, m: string) => { if (c) { ok++; console.log("  ✓", m); } else { fails++; console.log("  ✗", m); } };

// sem chave de IA
const M = await import("../../supabase/functions/news-refresh/index.ts");
const plain = handlers[handlers.length - 1];
const call = (h: any, body: any, token?: string) => h(new Request("https://x/functions/v1/news-refresh", { method: "POST", headers: token ? { authorization: "Bearer " + token, origin: "https://wanderson009luiz-commits.github.io" } : {}, body: body === undefined ? undefined : JSON.stringify(body) }));
const news = (t?: string) => g.__DB.ticker_news.filter((r: any) => !t || r.ticker === t);

console.log("1) leitura do RSS do Google Notícias");
{
  const xml = rss([
    { title: "MXRF11 aumenta lucro em 25,7% e dividendos entregam retorno de 1,08%", source: "Suno - Investimentos Inteligentes", h: 2 },
    { title: "Fundo &amp; cotas: &lt;b&gt;alta&lt;/b&gt; &#233; destaque <![CDATA[com CDATA]]>", source: "Fonte X", h: 3 },
    { title: "Link inseguro não entra", link: "http://inseguro.com/x", h: 4 },
    { title: "Script não entra", link: "javascript:alert(1)", h: 5 },
  ]);
  const items = M.parseRss(xml);
  check(items.length === 2, `só itens com link https (${items.length})`);
  check(items[0].title === "MXRF11 aumenta lucro em 25,7% e dividendos entregam retorno de 1,08%" && items[0].source === "Suno - Investimentos Inteligentes", "tira o \" - Fonte\" do título e guarda a fonte");
  check(items[1].title === "Fundo & cotas: alta é destaque com CDATA", `entidades, tags e CDATA limpos ("${items[1].title}")`);
  check(!items.some((x) => /<|>/.test(x.title)), "nenhum título com tag HTML");
}

console.log("2b) lixo fora: página de cotação, fórum, vídeo replicado, lista enorme");
{
  const junk = ["Ambev (ABEV3)", "FII Cshg Log (HGLG11)", "Fleury | FLRY3 - Ações e cotações", "Irani | RANI3 - Indicadores e cotações", "SOJA3 Fórum | Ações Boa Safra ON",
    "Cotação FII VINCI LGCI (VILG11) hoje: veja preços, gráficos e notícias em Tempo Real", "Lista de Participações do ETF DIVO11 — BMFBOVESPA: DIVO11",
    "VALE3 - Vale - Resultados, Dividendos, Cotação e Indicadores", "Sinal De Reversão Com CANDLES MÁGICOS | 19/01/2025 | BRKM5 SAPR11 CPLE6 JALL3 LJQQ3 Claude Down (94Fq3VNYVo)",
    "4 AÇÕES DO SETOR DE AGRONEGÓCIO: #AGRO3 #SLCE3 #SOJA3 #KELP3 Vincenzo Nibali (4QyVtEdeMY)",
    "QUA PETR4 CEBR6 TASA4 CXSE3 CMIN3 CVCB3 BBAS3 ITUB4 SAUD3 KEPL3 WEGE3 PFRM3 ALOS3 B3SA3 JALL3 VULC3 Jacob Misiorowski (f"];
  const good = ["Taesa anuncia saída de diretor e define substituto interino", "XPML11 vende Cidade Jardim e compra fatias de shoppings", "Petrobras (PETR4) sobe 4% com petróleo",
    "BBAS3, ITUB4 e BBDC4 caem juntas na Bolsa: o que está acontecendo com os três maiores bancos?", "TRXF11, HGLG11 e MXRF11 pagam dividendos nesta quinta (15); veja valores"];
  const badKept = junk.filter((x) => !M.isJunk(x));
  check(badKept.length === 0, `todo o lixo sai (${badKept.join(" | ") || "ok"})`);
  const goodLost = good.filter((x) => M.isJunk(x));
  check(goodLost.length === 0, `notícia de verdade fica (${goodLost.join(" | ") || "ok"})`);
}

console.log("2) escolha: sem repetição da mesma história, só os últimos 10 dias, no máximo 8");
{
  const raw = [
    { title: "Vale anuncia dividendos de R$ 2,10 por ação", url: "https://a/1", source: "A", published: ago(1) },
    { title: "Vale anuncia dividendos de R$ 2,10 por ação; veja datas", url: "https://a/2", source: "B", published: ago(2) },
    { title: "Notícia velha da Vale", url: "https://a/3", source: "C", published: ago(24 * 15) },
    ...["Minério de ferro sobe na China", "Governo discute royalties", "Ibovespa fecha em alta", "Dólar recua com exterior", "Analistas revisam projeções do setor",
      "Siderúrgicas pedem tarifa", "Porto de Tubarão bate recorde", "Nova ferrovia é aprovada", "Chuvas afetam embarques", "Conselho elege diretor",
      "Investidores estrangeiros voltam", "Exportações crescem em setembro"].map((title, k) => ({ title, url: `https://b/${k}`, source: "D", published: ago(3 + k) })),
  ];
  const sel = M.selectNews(raw, NOW);
  check(sel.length === 8, `no máximo 8 (${sel.length})`);
  check(sel[0].url === "https://a/1" && !sel.some((x) => x.url === "https://a/2"), "a mesma história de dois sites aparece uma vez (a mais recente)");
  check(!sel.some((x) => x.url === "https://a/3"), "notícia com mais de 10 dias fica de fora");
}

console.log("3) classificação por regras (sem chave de IA)");
{
  const A = (k: string) => M.fromKey(k)!;
  const cases: [string, string, string, string, boolean][] = [
    ["MXRF11", "MXRF11 suspende distribuição de rendimentos após inadimplência de CRI", "alto", "negativo", true],
    ["VALE3", "Vale tem rompimento de barragem em Minas Gerais", "alto", "negativo", true],
    ["BBAS3", "Banco do Brasil: lucro cai 20% no trimestre e banco corta projeções", "medio", "negativo", true],
    ["WEGE3", "WEG tem lucro recorde no 3º trimestre e supera estimativas", "medio", "positivo", true],
    ["HGLG11", "HGLG11 anuncia aumento nos dividendos para R$ 1,30 por cota", "medio", "positivo", true],
    ["XPML11", "XPML11 anuncia 9ª emissão de cotas", "medio", "neutro", true],
    ["BCFF11", "BCFF11 será incorporado pelo BTHF11", "alto", "neutro", true],
    ["KNRI11", "KNRI11: inquilino devolve galpão e vacância sobe", "medio", "negativo", true],
    ["VISC11", "VISC11 reduz vacância e fecha novo contrato de locação", "medio", "positivo", true],
    ["ITSA4", "Itaúsa anuncia JCP de R$ 0,02 por ação; veja data-com", "baixo", "positivo", true],
    ["PETR4", "Petrobras recebe recomendação de compra do BTG", "medio", "positivo", true],
    ["ABEV3", "Ambev é rebaixada pelo Itaú BBA; recomendação de venda", "medio", "negativo", true],
    ["TOTS3", "TOTS3 dispara 8% após resultado", "baixo", "positivo", true],
    ["CYRE3", "Cyrela, maior incorporadora do país, lança empreendimento", "baixo", "neutro", true],
    ["BBAS3", "Banco do Brasil confirma suspensão dos dividendos", "alto", "negativo", true],
    ["MXRF11", "MXRF11 divulga fato relevante sobre CRI", "medio", "neutro", true],
    // títulos reais (19/10/2026)
    ["BBAS3", "BBAS3 cai e acende alerta: Banco do Brasil pode enfrentar nova pressão, mas queda abre oportunidade?", "baixo", "negativo", true],
    ["BBAS3", "BBAS3: analistas recomendam compra, mas até quando?", "medio", "positivo", true],
    ["VALE3", "Vale (VALE3) tem preço-alvo elevado e dado se mostra promissor", "medio", "positivo", true],
    ["VALE3", "Vale fica fora do rali eleitoral e opera no menor nível do ano; é hora de investir?", "baixo", "negativo", true],
    ["BBSE3", "BB Seguridade (BBSE3): dividendos superam 10% ao ano, mas lucro menor coloca rendimento em discussão", "medio", "negativo", true],
    ["HGLG11", "HGLG11 muda condições de emissão e abre prazo para desistência de investidores", "medio", "neutro", true],
    ["XPML11", "XPML11 vende Cidade Jardim: ganho de R$ 2,07 por cota não vira dividendo", "medio", "positivo", true],
    ["XPML11", "XPML11 vende fatia de shopping em São Paulo por R$ 456 milhões", "medio", "neutro", true],
    ["CPTS11", "CPTS11 define dividendo de R$ 0,09 por cota para outubro", "baixo", "positivo", true],
    ["CRYPTO:BTC", "Bitcoin hoje: BTC recupera US$ 82.500 com tech nos EUA", "baixo", "positivo", true],
    ["BBAS3", "BBAS3, ITUB4, BBDC4 e SANB11 caem juntas na Bolsa", "baixo", "negativo", false],
    ["RANI3", "Irani cai 5% na bolsa hoje", "baixo", "negativo", true],
    ["IVVB11", "10 ETFs para investir em 2026: IVVB11, BOVA11 e outros", "baixo", "neutro", true],
    ["MXRF11", "FII de logística toma calotes da Casas Bahia e cotas caem quase 4%", "baixo", "negativo", false],
    ["CRYPTO:BTC", "Bitcoin sobe 5% e renova máxima", "baixo", "positivo", true],
    ["US:AAPL", "Apple raises dividend and announces $110 billion buyback", "medio", "positivo", true],
    ["US:NVDA", "Nvidia stock plunges 9% after export probe", "medio", "negativo", true],
    ["HGRU11", "Gestora do HGRU11 é substituída: Pátria assume o fundo", "medio", "neutro", true],
  ];
  for (const [t, title, imp, dir, rel] of cases) {
    const c = M.classifyRules(title, A(t));
    check(c.impact === imp && c.direction === dir && c.relevant === rel && c.by === "regras", `${t}: "${title}" → ${imp}/${dir}${rel ? "" : " (menção indireta)"} (obtido ${c.impact}/${c.direction}${c.relevant ? "" : " indireta"})`);
  }
}

console.log("4) sob demanda: exige login e só busca tickers da carteira de quem chamou");
reset({ tracked_tickers: [{ portfolio_id: "p1", ticker: "MXRF11" }, { portfolio_id: "p1", ticker: "VALE3" }, { portfolio_id: "p1", ticker: "US:AAPL" }, { portfolio_id: "p2", ticker: "PETR4" }] });
Object.assign(FEEDS, {
  MXRF11: rss([{ title: "MXRF11 anuncia dividendos de R$ 0,10 por cota", source: "FIIs", h: 3 }, { title: "MXRF11 suspende distribuição após inadimplência", source: "Suno", h: 5 }]),
  VALE3: rss([{ title: "Vale tem lucro recorde e supera estimativas", source: "InfoMoney", h: 1 }]),
  AAPL: rss([{ title: "Apple raises dividend", source: "Reuters", h: 2 }]),
  PETR4: rss([{ title: "Petrobras corta dividendos", source: "X", h: 2 }]),
});
let r = await call(plain, { tickers: ["MXRF11"] });
check(r.status === 401 && rssCalls.length === 0, "sem login → 401, nenhuma busca");
r = await call(plain, { tickers: ["MXRF11", "VALE3", "US:AAPL", "PETR4", "<bad>", "#NEWS"] }, "USER-TOKEN");
let j = await r.json();
check(r.status === 200 && j.ok && j.mode === "app" && j.ai === false, `200 ok, sem IA (${JSON.stringify(j)})`);
check(r.headers.get("access-control-allow-origin") === "https://wanderson009luiz-commits.github.io", "CORS só para o endereço do app");
check(!rssCalls.includes("PETR4") && j.allowed === 3, "PETR4 (de outra pessoa) não é buscado");
check(news("MXRF11").length === 2 && news("VALE3").length === 1 && news("US:AAPL").length === 1, "grava as notícias de cada ativo com a chave do app (US:AAPL)");
const susp = news("MXRF11").find((x: any) => /suspende/.test(x.title));
check(susp?.impact === "alto" && susp?.direction === "negativo" && susp?.classified_by === "regras" && susp?.summary === null, "suspensão de rendimentos → alto/ruim, por regras");
check(g.__DB.ticker_news_checks.length === 3, "três tickers marcados como verificados");
rssCalls = [];
r = await call(plain, { tickers: ["MXRF11", "VALE3"] }, "USER-TOKEN");
j = await r.json();
check(rssCalls.length === 0 && j.due === 0, "verificados há menos de 2 h não são buscados de novo");
g.__DB.ticker_news_checks.forEach((c: any) => { c.checked_at = ago(3); });
FEEDS.MXRF11 = rss([{ title: "MXRF11 anuncia dividendos de R$ 0,10 por cota", source: "FIIs", h: 3 }, { title: "MXRF11 suspende distribuição após inadimplência", source: "Suno", h: 5 }, { title: "MXRF11 compra novos CRIs", source: "Clube FII", h: 1 }]);
r = await call(plain, { tickers: ["MXRF11"] }, "USER-TOKEN");
j = await r.json();
check(news("MXRF11").length === 3 && j.inserted === 1, "na próxima verificação, só a notícia nova é gravada (sem duplicar)");

console.log("5) fonte fora do ar: não marca como verificado e para de insistir");
reset({ tracked_tickers: ["AAAA3", "BBBB3", "CCCC3", "DDDD3", "EEEE3", "FFFF3"].map((t) => ({ portfolio_id: "p1", ticker: t })) });
["AAAA3", "BBBB3", "CCCC3", "DDDD3", "EEEE3", "FFFF3"].forEach((t) => { FEEDS[t] = 503; });
r = await call(plain, { tickers: ["AAAA3", "BBBB3", "CCCC3", "DDDD3", "EEEE3", "FFFF3"] }, "USER-TOKEN");
j = await r.json();
check(j.ok && g.__DB.ticker_news_checks.length === 0, "nada marcado como verificado quando a fonte falha");
check(rssCalls.length <= 7, `para depois de falhas seguidas (${rssCalls.length} buscas)`);

console.log("6) agendado: trava de 50 min, mais antigos primeiro, limpeza de 30 dias, só contagens");
reset({
  tracked_tickers: [{ portfolio_id: "p1", ticker: "MXRF11" }, { portfolio_id: "p2", ticker: "VALE3" }, { portfolio_id: "p2", ticker: "MXRF11" }],
  ticker_news_checks: [{ ticker: "VALE3", checked_at: ago(30 / 60), found: 1, ok: true }],
  ticker_news: [{ id: "velha", ticker: "VALE3", title: "velha", url: "https://x", source: null, published_at: ago(24 * 40), impact: "baixo", direction: "neutro", relevant: true, summary: null, classified_by: "regras", fetched_at: ago(24 * 40) }],
});
r = await call(plain, undefined);
j = await r.json();
check(j.ok && j.mode === "cron" && !j.skipped && j.tickers === 2, "processa os tickers acompanhados (sem repetir)");
check(rssCalls.includes("MXRF11") && !rssCalls.includes("VALE3"), "VALE3 verificado há 30 min não é buscado");
check(!g.__DB.ticker_news.some((x: any) => x.id === "velha"), "notícia com mais de 30 dias apagada");
check(!("items" in j) && !JSON.stringify(j).includes("MXRF11"), "resposta só com contagens");
rssCalls = [];
r = await call(plain, undefined);
j = await r.json();
check(j.skipped === true && rssCalls.length === 0, "segunda chamada em menos de 50 min não faz nada");
g.__DB.ticker_news_checks.find((c: any) => c.ticker === "#NEWS").checked_at = ago(1);
r = await call(plain, undefined);
check((await r.json()).skipped !== true, "depois de 50 min roda de novo");

console.log("7) com chave do Claude: IA classifica, valida a resposta e cai nas regras se vier algo errado");
Deno.env.set("ANTHROPIC_API_KEY", "sk-test");
const MA = await import("../../supabase/functions/news-refresh/index.ts?claude");
const withClaude = handlers[handlers.length - 1];
check(MA.aiProvider() === "anthropic", "provedor: Claude");
reset({ tracked_tickers: [{ portfolio_id: "p1", ticker: "MXRF11" }, { portfolio_id: "p1", ticker: "VALE3" }] });
FEEDS.MXRF11 = rss([{ title: "MXRF11 corta rendimentos (alto)", source: "Suno", h: 1 }, { title: "Lista de FIIs com MXRF11", source: "Y", h: 2 }]);
FEEDS.VALE3 = rss([{ title: "Vale tem lucro recorde", source: "InfoMoney", h: 1 }]);
aiMode = "bad";
r = await call(withClaude, { tickers: ["MXRF11", "VALE3"] }, "USER-TOKEN");
j = await r.json();
check(j.ok && j.ai === true && aiBodies.length === 1, `uma chamada à IA para as notícias novas (${aiBodies.length}; ${JSON.stringify(j)})`);
const req0 = aiBodies[0];
check(req0.body.model === "claude-haiku-5-5" && req0.headers["x-api-key"] === "sk-test" && req0.body.tool_choice?.name === "classificar_noticias", "Claude Haiku com saída estruturada (ferramenta)");
check(/não instruções/.test(req0.body.system) && /Não recomende comprar, vender ou manter/.test(req0.body.system), "instruções: títulos são dados e sem recomendação de compra/venda");
const all = news();
const byIa = all.filter((x: any) => x.classified_by === "ia");
check(byIa.length === all.length - 1 && all.length === 3, `item com resposta inválida fica com as regras (${byIa.length} por IA de ${all.length})`);
check(byIa.every((x: any) => typeof x.summary === "string" && x.summary.length > 10), "resumo da IA gravado");
check(all.find((x: any) => /Lista/.test(x.title))?.relevant === false, "menção em lista marcada como indireta");
// atualização: notícia antiga por regras ganha a leitura da IA no modo agendado
aiMode = "ok";
const reg = all.find((x: any) => x.classified_by === "regras");
g.__DB.ticker_news_checks = g.__DB.ticker_news_checks.filter((c: any) => c.ticker !== "#NEWS").map((c: any) => ({ ...c, checked_at: ago(0.1) }));
r = await call(withClaude, undefined);
j = await r.json();
check(j.upgraded >= 1 && news().find((x: any) => x.id === reg.id)?.classified_by === "ia", "agendado: notícia classificada por regras é reclassificada pela IA");
aiMode = "down";
reset({ tracked_tickers: [{ portfolio_id: "p1", ticker: "VALE3" }] });
FEEDS.VALE3 = rss([{ title: "Vale corta dividendos (ruim)", source: "X", h: 1 }]);
r = await call(withClaude, { tickers: ["VALE3"] }, "USER-TOKEN");
j = await r.json();
check(j.ok && news("VALE3")[0]?.classified_by === "regras" && news("VALE3")[0]?.impact === "alto", "IA fora do ar: grava com as regras, sem erro");

console.log("8) com chave do Google (Gemini): tenta o próximo modelo se o primeiro não existir");
Deno.env.delete("ANTHROPIC_API_KEY"); Deno.env.set("GEMINI_API_KEY", "gm-test");
const MG = await import("../../supabase/functions/news-refresh/index.ts?gemini");
const withGemini = handlers[handlers.length - 1];
check(MG.aiProvider() === "gemini", "provedor: Gemini");
aiMode = "ok";
reset({ tracked_tickers: [{ portfolio_id: "p1", ticker: "VALE3" }] });
FEEDS.VALE3 = rss([{ title: "Vale tem lucro recorde", source: "InfoMoney", h: 1 }]);
r = await call(withGemini, { tickers: ["VALE3"] }, "USER-TOKEN");
j = await r.json();
check(aiBodies.length === 2 && aiBodies[0].path.includes("gemini-flash-latest") && aiBodies[1].path.includes("gemini-3.5-flash-lite"), "primeiro modelo 404 → usa o seguinte");
check(aiBodies[1].headers["x-goog-api-key"] === "gm-test" && aiBodies[1].body.generationConfig.responseMimeType === "application/json", "chave no cabeçalho e resposta em JSON");
check(news("VALE3")[0]?.classified_by === "ia" && news("VALE3")[0]?.direction === "positivo", "notícia classificada pela IA do Google");

console.log("10) limites: por pessoa por hora, no total, e no máximo 150 tickers por pessoa");
{
  const many = Array.from({ length: 100 }, (_, k) => "T" + String(k).padStart(3, "0") + "3");
  reset({ tracked_tickers: many.map((t2) => ({ portfolio_id: "p1", ticker: t2 })) });
  const fetchedPer: number[] = [];
  for (let c = 0; c < 4; c++) { rssCalls = []; const rr = await call(withGemini, { tickers: many }, "USER-TOKEN"); const jj = await rr.json(); fetchedPer.push(rssCalls.length); if (c === 3) check(jj.throttled === true, "4ª chamada na hora: limite de 60 buscas por pessoa atingido"); }
  check(fetchedPer.slice(0, 3).every((n) => n === 20) && fetchedPer[3] === 0, `buscas por chamada: ${fetchedPer.join(", ")}`);
  const ub = g.__DB.news_demand.find((r: any) => r.user_id === "u1");
  const gb = g.__DB.news_demand.find((r: any) => r.user_id === "00000000-0000-0000-0000-000000000000");
  check(ub?.fetched === 60 && ub?.calls === 3 && gb?.fetched === 60, "uso da hora registrado por pessoa e no total");
  // a janela vira depois de 1 hora
  ub.window_start = new Date(Date.now() - 61 * 60e3).toISOString();
  rssCalls = [];
  await call(withGemini, { tickers: many }, "USER-TOKEN");
  check(rssCalls.length === 20, "na hora seguinte volta a buscar");
  // no máximo 6 chamadas que buscam por hora, mesmo com poucos tickers por chamada
  reset({ tracked_tickers: many.slice(0, 10).map((t2) => ({ portfolio_id: "p1", ticker: t2 })) });
  let thr = false;
  for (let c = 0; c < 7; c++) { const jj = await (await call(withGemini, { tickers: [many[c]] }, "USER-TOKEN")).json(); if (c === 6) thr = jj.throttled === true; }
  check(thr, "7ª chamada na hora: limite de 6 por pessoa");
  // no máximo 150 tickers por pessoa
  const huge = Array.from({ length: 200 }, (_, k) => "Z" + String(k).padStart(3, "0") + "3");
  reset({ tracked_tickers: huge.map((t2) => ({ portfolio_id: "p1", ticker: t2 })) });
  const jj = await (await call(withGemini, { tickers: huge.slice(180) }, "USER-TOKEN")).json();
  check(jj.allowed === 0, "tickers além dos 150 primeiros da pessoa não são buscados");
  // IA: orçamento total da hora esgotado → regras
  aiBodies = [];
  reset({ tracked_tickers: [{ portfolio_id: "p1", ticker: "VALE3" }], news_demand: [{ user_id: "00000000-0000-0000-0000-000000000000", window_start: new Date().toISOString(), calls: 0, fetched: 0, ai_calls: 30 }] });
  FEEDS.VALE3 = rss([{ title: "Vale tem lucro recorde", source: "InfoMoney", h: 1 }]);
  await call(withGemini, { tickers: ["VALE3"] }, "USER-TOKEN");
  check(aiBodies.length === 0 && news("VALE3")[0]?.classified_by === "regras", "orçamento de IA da hora esgotado: classifica por regras, sem chamar a IA");
}

console.log("11) texto malformado, linha recusada e rede de segurança da IA");
{
  const longo = "MXRF11 " + "a".repeat(292) + "😀 fim";
  const it = M.parseRss(rss([{ title: longo, source: "X", h: 1 }]))[0];
  check(it.title.isWellFormed() && Array.from(it.title).length === 300, `título cortado sem quebrar o emoji (${Array.from(it.title).length} caracteres)`);
  check(M.cut("ab😀cd", 3) === "ab😀" && M.wellFormed("x" + String.fromCharCode(0xd83d)) === "x" + String.fromCharCode(0xfffd), "corte por caractere e metade solta trocada");
  reset({ tracked_tickers: [{ portfolio_id: "p1", ticker: "MXRF11" }] });
  FEEDS.MXRF11 = rss([{ title: "MXRF11 notícia boa de rendimentos", source: "A", h: 1 }, { title: "MXRF11 REJEITAR esta linha do banco", source: "B", h: 2 }, { title: "MXRF11 anuncia dividendos de R$ 0,10", source: "C", h: 3 }]);
  const jj = await (await call(plain, { tickers: ["MXRF11"] }, "USER-TOKEN")).json();
  check(jj.ok && news("MXRF11").length === 2 && jj.inserted === 2 && jj.checked === 1, "linha recusada pelo banco não derruba as outras nem a verificação");
  const merged = MA.mergeAi({ impact: "baixo", direction: "neutro", relevant: false, summary: "resumo manipulado do título", by: "ia" }, MA.classifyRules("MXRF11 suspende distribuição de rendimentos", MA.fromKey("MXRF11")!));
  check(merged.impact === "alto" && merged.relevant === true && merged.by === "ia", "IA não rebaixa um alerta grave que as regras acharam no título do ativo");
  Deno.env.set("ANTHROPIC_API_KEY", "sk-test");
  aiBodies = [];
  const r0 = await MA.classifyAi([{ asset: MA.fromKey("VALE3")!, news: { title: "Vale tem lucro recorde", url: "https://x", source: "A", published: new Date().toISOString() } }], 3, Date.now() - 1);
  check(r0.calls === 0 && aiBodies.length === 0, "sem tempo na rodada: não chama a IA");
}

console.log("9) métodos e corpo inválidos");
r = await plain(new Request("https://x/functions/v1/news-refresh", { method: "GET" }));
check(r.status === 405, "GET → 405");
r = await plain(new Request("https://x/functions/v1/news-refresh", { method: "POST", body: "{x" }));
check(r.status === 400, "JSON inválido → 400");

console.log(`\n${ok} ok, ${fails} falha(s)`);
if (fails) Deno.exit(1);
