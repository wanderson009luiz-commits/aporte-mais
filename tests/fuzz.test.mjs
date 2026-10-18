// Teste de estresse: milhares de carteiras aleatórias. Em TODAS, as regras abaixo precisam valer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAporte, applyPlan } from '../js/engine.js';
import { portfolioTotalBRL, quoteKey, classType } from '../js/model.js';

import { rng, randomPortfolio } from './gen.mjs';

test('estresse: 4000 carteiras aleatórias — a conta sempre fecha e nenhuma regra é violada', () => {
  const r = rng(20261018);
  let planned = 0;
  for (let i = 0; i < 4000; i++) {
    const s = randomPortfolio(r, i);
    const aporte = Math.round((r() < 0.1 ? r() * 50 : r() * 30000) * 100) / 100 + 0.01;
    const market = { quotes: {}, fx: { auto: {} } };
    const plan = planAporte(s, aporte, market);
    if (!plan.ok) { assert.ok(plan.errors.length > 0); continue; }
    planned++;
    const A = Math.round(aporte * 100);
    const ctx = `carteira #${i}, aporte ${aporte}`;
    // 1) conta fecha ao centavo
    assert.equal(plan.investedBRL + plan.directBRL + plan.toCash, A, ctx);
    assert.equal(plan.classes.reduce((s2, c) => s2 + c.allocBRL, 0), A, ctx);
    plan.classes.forEach((c) => {
      // 2) nenhuma classe gasta mais do que recebeu, nada negativo
      assert.ok(c.allocBRL >= 0 && c.investedBRL >= 0 && c.leftoverBRL >= 0, ctx);
      assert.equal(c.investedBRL + c.directBRL + c.leftoverBRL, c.allocBRL, ctx + ' ' + c.name);
      if (c.items.length) {
        const spent = c.items.reduce((s2, it) => s2 + it.value, 0);
        assert.ok(spent <= c.budgetNative, ctx + ' orçamento da classe');
      }
      // 3) classe com 0% não recebe nada
      if (c.idealPct === 0) assert.equal(c.allocBRL, 0, ctx);
      c.items.forEach((it) => {
        assert.ok(it.value >= 0 && Number.isInteger(it.value), ctx);
        if (it.status === 'na_meta' || it.status === 'sem_preco' || it.status === 'abaixo_minimo') assert.equal(it.value, 0, ctx + ' ' + it.status);
        if (it.mode === 'lote') {
          // 4) cotas inteiras, em múltiplos do lote, ao preço exato
          assert.ok(Number.isInteger(it.qty) && it.qty % it.minQty === 0, ctx);
          assert.equal(it.value, (it.qty / it.minQty) * it.lotCost, ctx);
          // 5) nunca passa do alvo do ativo em mais de 1 lote
          if (it.value > 0) assert.ok(it.value <= it.deficit + it.lotCost + 1, ctx + ` ${it.value} > ${it.deficit}+${it.lotCost}`);
        } else if (it.value > 0) {
          assert.ok(it.value <= Math.ceil(it.deficit) + 1, ctx);
          if (it.minAmount > 0) assert.ok(it.value >= it.minAmount, ctx + ' mínimo');
        }
      });
    });
    // 6) ordem de compra só tem itens com valor e soma o investido
    assert.ok(plan.orders.every((o) => o.valueNative > 0), ctx);
    // 7) determinístico
    assert.deepEqual(JSON.parse(JSON.stringify(planAporte(s, aporte, market).orders)), JSON.parse(JSON.stringify(plan.orders)), ctx);
    // 8) registrar soma o aporte no patrimônio (tolerância: 1 centavo por compra fracionada/exterior)
    const fx = { auto: {}, manual: s.settings.fxManual };
    const before = portfolioTotalBRL(s, {}, fx);
    const { state: s2 } = applyPlan(s, plan, market, { date: '2026-10-18' });
    const after = portfolioTotalBRL(s2, {}, fx);
    const usdItems = plan.orders.filter((o) => o.currency !== 'BRL').length;
    const fracItems = plan.orders.filter((o) => o.mode === 'fracao').length;
    const directUsd = plan.classes.filter((c) => c.directBRL > 0 && c.currency !== 'BRL').length;
    const tol = 0.011 * (1 + fracItems) + 0.06 * (usdItems + directUsd);
    assert.ok(Math.abs(after - before - aporte) <= tol + 1e-9, `${ctx}: depois-antes=${after - before}, tolerância ${tol}`);
  }
  assert.ok(planned > 2500, 'a maioria das carteiras deveria ser calculável: ' + planned);
});

test('estresse com cotações automáticas: cotação em moeda errada é ignorada', () => {
  const r = rng(7);
  for (let i = 0; i < 300; i++) {
    const s = randomPortfolio(r, i);
    const quotes = {};
    s.classes.forEach((c) => {
      const src = { b3: 'b3', exterior: 'us', cripto: 'crypto' }[classType(c)];
      if (!src) return;
      c.assets.forEach((a) => {
        a.priceMode = 'auto';
        // 10% das cotações vêm em moeda errada (devem ser ignoradas)
        quotes[quoteKey(src, a.ticker)] = { price: 1 + r() * 100, currency: r() < 0.1 ? 'EUR' : (src === 'us' ? 'USD' : 'BRL') };
      });
    });
    const plan = planAporte(s, 5000, { quotes });
    if (!plan.ok) continue;
    assert.equal(plan.investedBRL + plan.directBRL + plan.toCash, 500000);
    plan.orders.forEach((o) => {
      if (o.priceSource === 'auto') {
        const q = quotes[quoteKey({ BRL: o.mode === 'fracao' ? 'crypto' : 'b3', USD: 'us' }[o.currency] || 'b3', o.ticker)];
        if (q) assert.notEqual(q.currency, 'EUR');
      }
    });
  }
});
