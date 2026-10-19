// =====================================================================
// Aporte+ — notícias da carteira: quais ativos olhar, o que precisa de atenção e em que ordem.
// Funções puras (testadas em tests/news.test.mjs); a tela fica em app.js.
// =====================================================================
import { hasAssets, quoteSource, quoteKey, normTicker, isQuotableTicker, assetValue, fxRate, classCurrency, portfolioTotalBRL } from './model.js?v=dev';

export const NEWS_WINDOW_DAYS = 10;
export const ATTENTION_DAYS = 7;
const DAY = 864e5;
const IMPACT = { alto: 3, medio: 2, baixo: 1 };
const URL_OK = /^https:\/\/[^\s"'<>]+$/i;
// mesmo filtro do servidor (segunda trava: notícias gravadas antes de o filtro existir também somem)
const JUNK = /\b(?:indicadores e cotac\w*|acoes e cotac\w*|cotac\w* e indicadores|dividendos cotac\w*|forum|tempo real|lista de participac\w*|veja precos|cotac\w* (?:fii|hoje|de hoje|em tempo|atual)|historico de (?:dividendos|cotac\w*)|preco (?:hoje|atual) (?:de|do|da))\b/;
const TICKERS_IN = /\b[A-Z]{4}\d{1,2}\b/g;
export function normTitle(t) {
  return String(t).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9%$&.]+/g, ' ').replace(/(\D)\.|\.(\D)/g, '$1 $2').replace(/\s+/g, ' ').trim();
}
export function tickersInTitle(title) { return new Set(String(title).match(TICKERS_IN) || []).size; }
/** Não é notícia: página de cotação, fórum, vídeo replicado com código aleatório, lista enorme de tickers. */
export function isJunkTitle(title) {
  const t = String(title);
  const n = normTitle(t);
  if (JUNK.test(n)) return true;
  const tail = t.match(/\(([A-Za-z0-9_-]{6,14})\)?\s*$/);
  if (tail && /[a-z]/.test(tail[1]) && /[A-Z]/.test(tail[1]) && /\d/.test(tail[1])) return true;
  if (/#[A-Z]{4}\d{1,2}\b/.test(t)) return true;
  if (tickersInTitle(t) >= 7) return true;
  if (n.split(' ').length <= 5 && /\([A-Z]{4}\d{1,2}\)\s*$/.test(t)) return true;
  return false;
}

/**
 * Ativos da carteira que têm notícias (B3, EUA e cripto), pela chave da cotação ("WEGE3",
 * "US:AAPL", "CRYPTO:BTC"), com o peso de cada um na carteira (ou o alvo, se ainda está zerada).
 */
export function newsAssets(state, quotes = {}, fx = {}) {
  const map = new Map();
  if (!state || !Array.isArray(state.classes)) return map;
  const total = portfolioTotalBRL(state, quotes, fx);
  state.classes.forEach((c) => {
    const src = quoteSource(c);
    if (!hasAssets(c) || src === 'none') return;
    const rate = fxRate(classCurrency(c), fx) ?? 0;
    (c.assets || []).forEach((a) => {
      const t = normTicker(a.ticker);
      if (!t || !isQuotableTicker(t)) return;
      const key = quoteKey(src, t);
      const prev = map.get(key);
      const value = (prev ? prev.value : 0) + assetValue(c, a, quotes) * rate;
      const target = (prev ? prev.target : 0) + ((Number(c.idealPct) || 0) * (Number(a.idealPct) || 0)) / 100;
      map.set(key, { key, ticker: t, cls: prev ? prev.cls : c.name, value, target, weight: null });
    });
  });
  map.forEach((x) => { x.weight = total > 0 ? (x.value / total) * 100 : null; });
  return map;
}

/** Só linhas bem formadas (o banco já valida; aqui é a segunda trava antes de ir para a tela). */
export function cleanNewsRows(rows) {
  const out = [];
  const seen = new Set();
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    if (!r || typeof r !== 'object') return;
    const id = String(r.id || '');
    if (!id || seen.has(id)) return;
    const url = String(r.url || '');
    const t = Date.parse(r.published_at);
    if (!URL_OK.test(url) || !Number.isFinite(t) || typeof r.title !== 'string' || !r.title.trim() || isJunkTitle(r.title)) return;
    seen.add(id);
    out.push({
      id, ticker: String(r.ticker || ''), title: r.title.slice(0, 300), url, source: typeof r.source === 'string' ? r.source.slice(0, 80) : '',
      published: t, impact: IMPACT[r.impact] ? r.impact : 'baixo', direction: ['positivo', 'negativo', 'neutro'].includes(r.direction) ? r.direction : 'neutro',
      relevant: r.relevant !== false && tickersInTitle(r.title) < 4, summary: typeof r.summary === 'string' ? r.summary.slice(0, 300) : '', byAi: r.classified_by === 'ia',
    });
  });
  return out;
}

/** Peso de uma notícia para ordenar: impacto primeiro, ruim antes de boa, depois a mais recente. */
export function severity(n) { return (IMPACT[n.impact] || 0) * 10 + (n.direction === 'negativo' ? 2 : n.direction === 'positivo' ? 1 : 0); }
export function bySeverity(a, b) { return severity(b) - severity(a) || b.published - a.published; }

/** Precisa de atenção: impacto alto (bom ou ruim) ou médio ruim, dos últimos 7 dias, sobre o próprio ativo. */
export function isAttention(n, now = Date.now()) {
  return n.relevant && now - n.published <= ATTENTION_DAYS * DAY && (n.impact === 'alto' || (n.impact === 'medio' && n.direction === 'negativo'));
}

export function filterNews(rows, assets, { filter = 'todas', asset = '' } = {}) {
  return rows.filter((n) => assets.has(n.ticker)
    && (!asset || n.ticker === asset)
    && (filter === 'todas' || (filter === 'alto' && n.impact === 'alto') || (filter === 'ruins' && n.direction === 'negativo') || (filter === 'boas' && n.direction === 'positivo')));
}

/** Notícias por ativo: os ativos com algo grave primeiro; dentro de cada um, as mais importantes. */
export function groupByAsset(rows, assets) {
  const groups = new Map();
  rows.forEach((n) => {
    if (!n.relevant || !assets.has(n.ticker)) return;
    if (!groups.has(n.ticker)) groups.set(n.ticker, { asset: assets.get(n.ticker), items: [] });
    groups.get(n.ticker).items.push(n);
  });
  const list = [...groups.values()];
  list.forEach((g) => {
    g.items.sort(bySeverity);
    g.top = severity(g.items[0]);
    g.bad = g.items.filter((n) => n.direction === 'negativo').length;
    g.good = g.items.filter((n) => n.direction === 'positivo').length;
    g.latest = Math.max(...g.items.map((n) => n.published));
  });
  return list.sort((a, b) => b.top - a.top || b.bad - a.bad || (b.asset.weight ?? b.asset.target) - (a.asset.weight ?? a.asset.target) || b.latest - a.latest);
}

export function newsCounts(rows) {
  const c = { alto: 0, medio: 0, baixo: 0, positivo: 0, negativo: 0, neutro: 0, total: 0 };
  rows.forEach((n) => { if (!n.relevant) return; c[n.impact]++; c[n.direction]++; c.total++; });
  return c;
}
