// Testes do motor de cálculo do Aporte+ (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAporte, applyPlan, apportion, validateForPlan, alignmentScore } from '../js/engine.js';
import {
  defaultState, migrateState, parseNum, toCents, portfolioTotalBRL, quoteKey, assetPrice, buyMode,
  classType, trackedTickers, nextAporteDate, todayISO,
} from '../js/model.js';

// ---------- utilidades ----------
function quotesFor(state, prices) {
  const q = {};
  state.classes.forEach((c) => {
    const src = { b3: 'b3', exterior: 'us', cripto: 'crypto' }[classType(c)];
    if (!src) return;
    c.assets.forEach((a) => {
      const p = prices[a.ticker];
      if (p) q[quoteKey(src, a.ticker)] = { price: p, currency: src === 'us' ? 'USD' : 'BRL', updated_at: new Date().toISOString() };
    });
  });
  return q;
}
const PRICES = {
  VALE3: 61.2, WEGE3: 47.99, EGIE3: 41.1, BBSE3: 35.4, TAEE11: 36.8, LEVE3: 29.9, TOTS3: 38.2, SAPR11: 27.5, BBAS3: 27.3,
  VIVA3: 24.6, FLRY3: 14.9, SOJA3: 9.8, ABEV3: 13.1, ITSA4: 10.4, RANI3: 7.2, GRND3: 5.6, KLBN4: 4.1,
  IVVB11: 372.5, NASD11: 14.9, WRLD11: 115.3, DIVO11: 98.2,
  XPLG11: 101.5, HGLG11: 156.42, VILG11: 89.9, XPML11: 105.2, VISC11: 109.3, MALL11: 98.1, KNRI11: 140.2, HGRE11: 120.0,
  BRCR11: 45.6, DEVA11: 33.2, CPTS11: 7.9, VRTA11: 80.4, BCFF11: 8.6, HGRU11: 121.7, MXRF11: 9.71,
  BTC: 409546, ETH: 11902.89,
};
function sumOrders(plan) { return plan.orders.reduce((s, o) => s + o.valueBRL, 0); }

// ---------- números ----------
test('parseNum entende os formatos brasileiros e americanos', () => {
  const cases = { '1.234,56': 1234.56, '1234,56': 1234.56, '1,234.56': 1234.56, '1234.56': 1234.56, '1.500': 1500,
    '0.500': 0.5, 'R$ 10,50': 10.5, '10.50': 10.5, '-5,2': -5.2, abc: 0, '': 0, '2,5': 2.5, '1.234.567,8': 1234567.8, '  300  ': 300 };
  for (const [k, v] of Object.entries(cases)) assert.equal(parseNum(k), v, k);
  assert.equal(parseNum(12.3), 12.3);
  assert.equal(parseNum(null), 0);
});

test('toCents arredonda corretamente', () => {
  assert.equal(toCents(1.005), 101);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents('x'), 0);
});

test('apportion divide sem perder nem criar centavos', () => {
  assert.deepEqual(apportion(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(apportion(0, [1, 2]), [0, 0]);
  assert.deepEqual(apportion(10, [0, 0]), [0, 0]);
  for (let i = 0; i < 500; i++) {
    const total = Math.floor(Math.random() * 1e7);
    const w = Array.from({ length: 1 + Math.floor(Math.random() * 20) }, () => (Math.random() < 0.2 ? 0 : Math.random() * 1e6));
    const out = apportion(total, w);
    if (w.some((x) => x > 0)) assert.equal(out.reduce((s, x) => s + x, 0), total);
    out.forEach((x, k) => { assert.ok(Number.isInteger(x) && x >= 0); if (!(w[k] > 0)) assert.equal(x, 0); });
  }
});

// ---------- validação ----------
test('validação bloqueia carteira inconsistente com mensagens claras', () => {
  const s = defaultState();
  s.classes[0].idealPct = 30; // soma 95
  let errs = validateForPlan(s, {});
  assert.ok(errs.some((e) => e.code === 'soma_classes'));
  s.classes[0].idealPct = 35;
  s.classes[0].assets[0].idealPct = 1; // ativos somam 95
  errs = validateForPlan(s, {});
  assert.ok(errs.some((e) => e.code === 'soma_ativos'));
  s.classes[0].assets[0].idealPct = 6;
  s.classes[1].isCash = false;
  errs = validateForPlan(s, {});
  assert.ok(errs.some((e) => e.code === 'sem_caixa'));
  s.classes[1].isCash = true;
  assert.deepEqual(validateForPlan(s, {}), []);
});

test('classe em dólar sem câmbio bloqueia; com câmbio manual libera', () => {
  const s = defaultState();
  s.classes.push({ id: 'eua', name: 'EUA', type: 'exterior', idealPct: 10, currency: 'USD', fractional: true, assets: [{ id: 'x', ticker: 'AAPL', idealPct: 100, qty: 0, price: 0, currentValue: 0, minQty: 1, priceMode: 'auto' }] });
  s.classes[0].idealPct = 25;
  const st = migrateState(s);
  assert.ok(validateForPlan(st, {}).some((e) => e.code === 'sem_cambio'));
  st.settings.fxManual.USD = 5.4;
  assert.ok(!validateForPlan(st, {}).some((e) => e.code === 'sem_cambio'));
});

// ---------- cenários ----------
test('carteira nova: divide o aporte pelos % ideais e fecha ao centavo', () => {
  const s = migrateState(defaultState());
  const quotes = quotesFor(s, PRICES);
  const plan = planAporte(s, 1000, { quotes });
  assert.ok(plan.ok, JSON.stringify(plan.errors));
  const byId = Object.fromEntries(plan.classes.map((c) => [c.classId, c]));
  assert.equal(byId.acoes.allocBRL, 35000);
  assert.equal(byId.caixa.allocBRL, 5000);
  assert.equal(byId.etfs.allocBRL, 25000);
  assert.equal(byId.fiis.allocBRL, 20000);
  assert.equal(byId.rendafixa.allocBRL, 10000);
  assert.equal(byId.cripto.allocBRL, 5000);
  assert.equal(plan.investedBRL + plan.directBRL + plan.toCash, 100000);
  // renda fixa por valor: 49/17/17/17 de R$ 100
  const rf = byId.rendafixa.items.map((it) => it.value);
  assert.deepEqual(rf, [4900, 1700, 1700, 1700]);
  // cripto: R$ 35 BTC e R$ 15 ETH, quantidade fracionada
  const cr = byId.cripto.items;
  assert.equal(cr[0].value, 3500); assert.equal(cr[1].value, 1500);
  assert.ok(Math.abs(cr[0].qty * PRICES.BTC - 35) < 1e-9);
  // ações compradas em cotas inteiras
  plan.orders.filter((o) => o.mode === 'lote').forEach((o) => assert.ok(Number.isInteger(o.qty) && o.qty > 0));
  assert.equal(sumOrders(plan) + plan.directBRL + plan.toCash, 100000);
});

test('sem cotação nenhuma: avisa ativo por ativo e manda o dinheiro da classe para o Caixa', () => {
  const s = migrateState(defaultState());
  const plan = planAporte(s, 1000, { quotes: {} });
  assert.ok(plan.ok);
  const semPreco = plan.warnings.filter((w) => w.code === 'sem_preco');
  assert.equal(semPreco.length, 17 + 4 + 15 + 2);
  // só renda fixa (por valor) e caixa recebem
  assert.equal(plan.investedBRL, 10000);
  assert.equal(plan.toCash + plan.cashDirect, 90000);
});

test('preço: automático usa só cotação real; preço digitado só quando fixado (manual)', () => {
  const s = migrateState(defaultState());
  const c = s.classes[0]; const a = c.assets[1]; // WEGE3
  a.price = 50; // digitado numa versão antiga, sem fixar
  assert.equal(assetPrice(c, a, {}).price, 0, 'preço antigo digitado não vale no automático');
  assert.equal(assetPrice(c, a, {}).source, 'none');
  const q = { WEGE3: { price: 47.99, currency: 'BRL' } };
  assert.equal(assetPrice(c, a, q).price, 47.99);
  a.priceMode = 'manual';
  assert.equal(assetPrice(c, a, q).price, 50, 'preço fixado vale mesmo com cotação');
  assert.equal(assetPrice(c, a, {}).source, 'manual');
  a.priceMode = 'auto'; a.lastQuotePrice = 48.5;
  assert.equal(assetPrice(c, a, {}).price, 48.5, 'sem cotação agora: última cotação conhecida');
  assert.equal(assetPrice(c, a, {}).source, 'cache');
});

test('carteira nova com R$ 1.000: a sobra compra cotas de quem ainda está abaixo do alvo', () => {
  const s = migrateState(defaultState());
  const quotes = quotesFor(s, PRICES);
  const plan = planAporte(s, 1000, { quotes });
  const etfs = plan.classes.find((c) => c.classId === 'etfs');
  // R$ 250 em ETFs: o motor não deixa a maior parte parada se uma cota de quem está abaixo do alvo cabe
  assert.ok(etfs.leftoverBRL < 12000, 'sobra de ETFs deveria ser pequena: ' + etfs.leftoverBRL);
  etfs.items.forEach((it) => assert.ok(it.value <= it.deficit + it.lotCost + 1));
});

test('lote caro: a sobra compra a cota do ativo mais longe da sua parte', () => {
  const s = migrateState({ classes: [
    { id: 'b', name: 'Ações', type: 'b3', idealPct: 95, assets: [
      { id: 'a1', ticker: 'CARO3', idealPct: 75, price: 100, priceMode: 'manual' },
      { id: 'a2', ticker: 'BARA3', idealPct: 25, price: 10, priceMode: 'manual' }] },
    { id: 'caixa', name: 'Caixa', type: 'valor', idealPct: 5, isCash: true },
  ] });
  const plan = planAporte(s, 105.27, {});
  assert.ok(plan.ok);
  const it = Object.fromEntries(plan.classes[0].items.map((x) => [x.a.ticker, x]));
  // parte: CARO3 75, BARA3 25 → base: 0 CARO3 + 2 BARA3; sobra 80 não compra CARO3 (100) → mais BARA3? Não: BARA3 já está perto do alvo
  assert.equal(plan.investedBRL + plan.directBRL + plan.toCash, 10527);
  assert.ok(it.BARA3.qty >= 2);
  assert.ok(it.BARA3.value <= it.BARA3.deficit + it.BARA3.lotCost);
  const plan2 = planAporte(s, 200, {});
  const it2 = Object.fromEntries(plan2.classes[0].items.map((x) => [x.a.ticker, x]));
  assert.equal(it2.CARO3.qty, 1, 'com R$ 190 na classe, compra 1 CARO3 (parte 142,50)');
  assert.equal(plan2.investedBRL + plan2.directBRL + plan2.toCash, 20000);
});

test('ativo acima do alvo não recebe nada', () => {
  const s = migrateState({ classes: [
    { id: 'b', name: 'Ações', type: 'b3', idealPct: 90, assets: [
      { id: 'a1', ticker: 'AAAA3', idealPct: 50, qty: 100, price: 10, priceMode: 'manual' },
      { id: 'a2', ticker: 'BBBB3', idealPct: 50, qty: 0, price: 10, priceMode: 'manual' }] },
    { id: 'caixa', name: 'Caixa', type: 'valor', idealPct: 10, isCash: true },
  ] });
  const plan = planAporte(s, 300, {});
  const it = Object.fromEntries(plan.classes[0].items.map((x) => [x.a.ticker, x]));
  assert.equal(it.AAAA3.value, 0);
  assert.equal(it.AAAA3.status, 'na_meta');
  assert.ok(it.BBBB3.value > 0);
});

test('classe em dólar: converte, compra fracionado e devolve a sobra em R$', () => {
  const s = migrateState({ settings: { fxManual: { USD: 5.4321 } }, classes: [
    { id: 'eua', name: 'EUA', type: 'exterior', idealPct: 50, assets: [
      { id: 'u1', ticker: 'AAPL', idealPct: 60, price: 0 }, { id: 'u2', ticker: 'VOO', idealPct: 40, price: 0 }] },
    { id: 'caixa', name: 'Caixa', type: 'valor', idealPct: 50, isCash: true },
  ] });
  const quotes = { 'US:AAPL': { price: 231.12, currency: 'USD' }, 'US:VOO': { price: 512.7, currency: 'USD' } };
  const plan = planAporte(s, 1000, { quotes });
  assert.ok(plan.ok, JSON.stringify(plan.errors));
  assert.equal(plan.investedBRL + plan.directBRL + plan.toCash, 100000);
  const eua = plan.classes[0];
  assert.equal(eua.budgetNative, Math.floor(50000 / 5.4321));
  assert.ok(eua.investedBRL <= eua.allocBRL);
});

test('registrar o aporte soma exatamente o valor na carteira (só R$)', () => {
  const s = migrateState(defaultState());
  const quotes = quotesFor(s, PRICES);
  const before = portfolioTotalBRL(s, quotes, {});
  const plan = planAporte(s, 2500, { quotes });
  const { state: s2, record } = applyPlan(s, plan, { quotes }, { date: '2026-10-18', obs: 'teste' });
  const after = portfolioTotalBRL(s2, quotes, {});
  assert.ok(Math.abs(after - before - 2500) <= 0.02, `${after} - ${before}`);
  assert.equal(record.disponivel, 2500);
  assert.equal(s2.aportes.length, 1);
  assert.equal(s2.agenda.lastAporteDate, '2026-10-18');
  assert.equal(s.aportes.length, 0, 'não altera a carteira original');
  // cotas registradas
  const wege = s2.classes[0].assets.find((a) => a.ticker === 'WEGE3');
  const ord = plan.orders.find((o) => o.ticker === 'WEGE3');
  if (ord) assert.equal(wege.qty, ord.qty);
});

test('aportes seguidos convergem para o plano (cotas inteiras causam só desvios pequenos)', () => {
  let s = migrateState(defaultState());
  const quotes = quotesFor(s, PRICES);
  const afters = [];
  for (let k = 0; k < 6; k++) {
    const p = planAporte(s, 3000, { quotes });
    assert.ok(p.ok);
    afters.push(p.after);
    s = applyPlan(s, p, { quotes }).state;
  }
  afters.forEach((a) => assert.ok(a >= 95, 'alinhamento nunca deveria cair abaixo de 95%: ' + afters.join(', ')));
  assert.ok(afters[afters.length - 1] >= 99, 'depois de 6 aportes a carteira deveria estar ≥ 99% alinhada: ' + afters.join(', '));
});

// ---------- migração ----------
test('migração de carteira antiga preserva dados e é idempotente', () => {
  const old = { classes: [
    { id: 'acoes', name: 'Ações', idealPct: 35, currentValue: 0, hasAssets: true, assets: [{ id: 'z', ticker: 'VALE3', idealPct: 100, currentValue: 1500, price: 60, minQty: 1, termometro: { nota: 80, motivos: ['ok'] } }] },
    { id: 'caixa', name: 'Caixa', idealPct: 5, currentValue: 200, hasAssets: false, assets: [] },
    { id: 'rendafixa', name: 'Renda Fixa', idealPct: 10, hasAssets: true, assets: [{ id: 'r', ticker: 'TESOURO IPCA+', idealPct: 100, currentValue: 900, price: 1 }] },
    { id: 'acoes-eua', name: 'Ações EUA (Avenue)', idealPct: 50, hasAssets: true, currency: 'USD', fractional: true, assets: [] },
  ], aportes: [{ id: 'x', date: '2026-09-01', disponivel: 100 }] };
  const frozen = JSON.stringify(old);
  const m = migrateState(old);
  assert.equal(JSON.stringify(old), frozen, 'não altera o objeto de entrada');
  assert.equal(m.version, 4);
  assert.deepEqual(m.classes.map((c) => c.type), ['b3', 'valor', 'rendafixa', 'exterior']);
  assert.equal(m.classes[0].assets[0].currentValue, 1500);
  assert.equal(m.classes[0].assets[0].termometro.nota, 80);
  assert.equal(m.classes[1].isCash, true);
  assert.equal(m.classes[3].currency, 'USD');
  assert.equal(buyMode(m.classes[2]), 'valor');
  assert.equal(m.aportes.length, 1);
  assert.deepEqual(migrateState(m), { ...m });
});

test('lista de tickers para cotação ignora renda fixa e valores sem ticker válido', () => {
  const s = migrateState(defaultState());
  const t = trackedTickers(s);
  assert.ok(t.some((x) => x.ticker === 'WEGE3' && x.source === 'b3'));
  assert.ok(t.some((x) => x.ticker === 'BTC' && x.source === 'crypto'));
  assert.ok(!t.some((x) => x.ticker.startsWith('TESOURO')));
});

test('agenda: próxima data', () => {
  const today = new Date(2026, 9, 18); // domingo
  assert.equal(todayISO(nextAporteDate({ frequency: 'semanal', weekday: 1 }, today)), '2026-10-19');
  assert.equal(todayISO(nextAporteDate({ frequency: 'mensal', dayOfMonth: 5 }, today)), '2026-11-05');
  assert.equal(todayISO(nextAporteDate({ frequency: 'mensal', dayOfMonth: 5, lastAporteDate: '2026-10-05' }, today)), '2026-11-05');
  assert.equal(todayISO(nextAporteDate({ frequency: 'quinzenal', weekday: 1, lastAporteDate: '2026-10-05' }, today)), '2026-10-19');
  assert.equal(todayISO(nextAporteDate({ frequency: 'diario', lastAporteDate: '2026-10-01' }, today)), '2026-10-18');
  assert.equal(nextAporteDate({ frequency: 'personalizado' }, today), null);
});

test('alinhamento: 100 no plano, menor longe dele', () => {
  assert.equal(alignmentScore([{ idealPct: 50, currentPct: 50 }, { idealPct: 50, currentPct: 50 }]), 100);
  assert.equal(alignmentScore([{ idealPct: 50, currentPct: 100 }, { idealPct: 50, currentPct: 0 }]), 50);
});
