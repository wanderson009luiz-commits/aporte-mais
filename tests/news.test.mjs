// Notícias da carteira: quais ativos entram, o que pede atenção e em que ordem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newsAssets, cleanNewsRows, filterNews, groupByAsset, newsCounts, isAttention, bySeverity, isJunkTitle } from '../js/news.js';
import { migrateState } from '../js/model.js';

const H = 3600e3;
const NOW = Date.now();
const row = (o) => ({ id: o.id, ticker: o.ticker, title: o.title || 'Título de teste ' + o.id, url: o.url || 'https://news.google.com/rss/articles/' + o.id,
  source: 'Fonte', published_at: new Date(NOW - (o.h ?? 1) * H).toISOString(), impact: o.impact || 'baixo', direction: o.direction || 'neutro',
  relevant: o.relevant !== false, summary: o.summary ?? null, classified_by: o.by || 'regras' });
const state = () => migrateState({ classes: [
  { id: 'b', name: 'Ações', type: 'b3', idealPct: 50, assets: [{ id: 'v', ticker: 'VALE3', idealPct: 60, qty: 10, price: 60, priceMode: 'manual' }, { id: 'w', ticker: 'wege3', idealPct: 40 }] },
  { id: 'u', name: 'EUA', type: 'exterior', idealPct: 20, assets: [{ id: 'a', ticker: 'AAPL', idealPct: 100 }] },
  { id: 'c', name: 'Cripto', type: 'cripto', idealPct: 10, assets: [{ id: 'x', ticker: 'BTC', idealPct: 100 }] },
  { id: 'r', name: 'RF', type: 'rendafixa', idealPct: 10, assets: [{ id: 't', ticker: 'TESOURO SELIC', idealPct: 100, currentValue: 400 }] },
  { id: 'caixa', name: 'Caixa', type: 'valor', idealPct: 10, isCash: true, currentValue: 0 }] });

test('notícias: só ativos com ticker (B3, EUA, cripto), com peso na carteira ou alvo', () => {
  const m = newsAssets(state(), {}, { auto: { USD: 5 }, manual: {} });
  assert.deepEqual([...m.keys()].sort(), ['CRYPTO:BTC', 'US:AAPL', 'VALE3', 'WEGE3']);
  assert.ok(Math.abs(m.get('VALE3').weight - 60) < 1e-9, 'VALE3 = 600 de 1.000');
  assert.equal(m.get('WEGE3').weight, 0);
  assert.ok(Math.abs(m.get('WEGE3').target - 20) < 1e-9, '50% × 40%');
  const empty = migrateState({ classes: [{ id: 'b', name: 'Ações', type: 'b3', idealPct: 100, assets: [{ id: 'v', ticker: 'VALE3', idealPct: 100 }] }, { id: 'caixa', name: 'Caixa', type: 'valor', isCash: true }] });
  assert.equal(newsAssets(empty).get('VALE3').weight, null, 'carteira zerada: sem peso, usa o alvo');
});

test('notícias: linhas inválidas ou perigosas não chegam à tela', () => {
  const rows = cleanNewsRows([
    row({ id: '1', ticker: 'VALE3' }),
    row({ id: '1', ticker: 'VALE3' }), // repetida
    row({ id: '2', ticker: 'VALE3', url: 'javascript:alert(1)' }),
    row({ id: '3', ticker: 'VALE3', url: 'http://inseguro' }),
    { ...row({ id: '4', ticker: 'VALE3' }), published_at: 'ontem' },
    { ...row({ id: '5', ticker: 'VALE3' }), impact: 'gigante', direction: 'talvez' },
    null, 'x',
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['1', '5']);
  assert.equal(rows[1].impact, 'baixo');
  assert.equal(rows[1].direction, 'neutro');
});

test('notícias: atenção = impacto alto (boa ou ruim) ou médio ruim, dos últimos 7 dias, sobre o próprio ativo', () => {
  const [a, b, c, d, e, f] = cleanNewsRows([
    row({ id: 'a', ticker: 'VALE3', impact: 'alto', direction: 'negativo' }),
    row({ id: 'b', ticker: 'VALE3', impact: 'alto', direction: 'positivo' }),
    row({ id: 'c', ticker: 'VALE3', impact: 'medio', direction: 'negativo' }),
    row({ id: 'd', ticker: 'VALE3', impact: 'medio', direction: 'positivo' }),
    row({ id: 'e', ticker: 'VALE3', impact: 'alto', direction: 'negativo', h: 24 * 8 }),
    row({ id: 'f', ticker: 'VALE3', impact: 'alto', direction: 'negativo', relevant: false }),
  ]);
  assert.deepEqual([a, b, c, d, e, f].map((n) => isAttention(n, NOW)), [true, true, true, false, false, false]);
});

test('notícias: ordem por gravidade (alto ruim > alto bom > médio ruim …), depois a mais recente', () => {
  const rows = cleanNewsRows([
    row({ id: 'm', ticker: 'VALE3', impact: 'medio', direction: 'negativo', h: 1 }),
    row({ id: 'ab', ticker: 'VALE3', impact: 'alto', direction: 'positivo', h: 3 }),
    row({ id: 'ar', ticker: 'VALE3', impact: 'alto', direction: 'negativo', h: 5 }),
    row({ id: 'ar2', ticker: 'VALE3', impact: 'alto', direction: 'negativo', h: 2 }),
    row({ id: 'b', ticker: 'VALE3', impact: 'baixo', direction: 'negativo', h: 0.5 }),
  ]).sort(bySeverity);
  assert.deepEqual(rows.map((r) => r.id), ['ar2', 'ar', 'ab', 'm', 'b']);
});

test('notícias: filtros e grupos só com ativos da carteira; grupos com algo grave primeiro', () => {
  const assets = newsAssets(state(), {}, { auto: { USD: 5 }, manual: {} });
  const rows = cleanNewsRows([
    row({ id: '1', ticker: 'WEGE3', impact: 'medio', direction: 'positivo' }),
    row({ id: '2', ticker: 'VALE3', impact: 'alto', direction: 'negativo' }),
    row({ id: '3', ticker: 'PETR4', impact: 'alto', direction: 'negativo' }),
    row({ id: '4', ticker: 'US:AAPL', impact: 'baixo', direction: 'positivo' }),
    row({ id: '5', ticker: 'VALE3', impact: 'baixo', direction: 'neutro', relevant: false }),
  ]);
  assert.deepEqual(filterNews(rows, assets).map((r) => r.id), ['1', '2', '4', '5'], 'PETR4 não está na carteira');
  assert.deepEqual(filterNews(rows, assets, { filter: 'ruins' }).map((r) => r.id), ['2']);
  assert.deepEqual(filterNews(rows, assets, { filter: 'boas' }).map((r) => r.id), ['1', '4']);
  assert.deepEqual(filterNews(rows, assets, { filter: 'alto' }).map((r) => r.id), ['2']);
  assert.deepEqual(filterNews(rows, assets, { asset: 'US:AAPL' }).map((r) => r.id), ['4']);
  const groups = groupByAsset(filterNews(rows, assets), assets);
  assert.deepEqual(groups.map((g) => g.asset.key), ['VALE3', 'WEGE3', 'US:AAPL']);
  assert.equal(groups[0].items.length, 1, 'menção indireta fica fora do grupo');
  const c = newsCounts(filterNews(rows, assets));
  assert.deepEqual([c.total, c.alto, c.medio, c.baixo, c.negativo, c.positivo], [3, 1, 1, 1, 1, 2]);
});

test('notícias: páginas de cotação, fóruns e vídeos replicados não aparecem; lista de 4+ tickers é menção', () => {
  const junk = ['Ambev (ABEV3)', 'Fleury | FLRY3 - Ações e cotações', 'Irani | RANI3 - Indicadores e cotações', 'SOJA3 Fórum | Ações Boa Safra ON',
    'Cotação FII VINCI LGCI (VILG11) hoje: veja preços, gráficos e notícias em Tempo Real', 'VALE3 - Vale - Resultados, Dividendos, Cotação e Indicadores',
    'Sinal De Reversão Com CANDLES MÁGICOS | 19/01/2025 | BRKM5 SAPR11 CPLE6 JALL3 LJQQ3 Claude Down (94Fq3VNYVo)'];
  junk.forEach((x) => assert.equal(isJunkTitle(x), true, x));
  ['Taesa anuncia saída de diretor e define substituto interino', 'Petrobras (PETR4) sobe 4% com petróleo', 'XPML11 vende Cidade Jardim e compra fatias de shoppings']
    .forEach((x) => assert.equal(isJunkTitle(x), false, x));
  const rows = cleanNewsRows([row({ id: 'j', ticker: 'ABEV3', title: 'Ambev (ABEV3)' }), row({ id: 'l', ticker: 'HGLG11', title: 'FIIs da semana: HGLG11, XPML11, KNRI11 e BTLG11' }), row({ id: 'ok', ticker: 'VALE3', title: 'Vale anuncia dividendos de R$ 2 por ação' })]);
  assert.deepEqual(rows.map((r) => r.id), ['l', 'ok']);
  assert.equal(rows[0].relevant, false, 'lista com 4 tickers vira menção');
  assert.equal(rows[1].relevant, true);
});
