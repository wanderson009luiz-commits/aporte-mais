// Testes das travas e correções da revisão independente (outubro/2026).
// Cada teste corresponde a um problema real encontrado — se algum voltar, o teste falha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAporte, applyPlan, revertAporte, fillLots, apportion, stateSignature, MIN_ORDER_CENTS, refineLots, lotsDeviation } from '../js/engine.js';
import {
  migrateState, defaultState, parseNum, toCents, toNumber, portfolioTotalBRL, assetPrice, cleanPrice, buyMode,
  nextAporteDate, todayISO, classValueNative, convertQty, TICKER_CHANGES,
} from '../js/model.js';
import { rng } from './gen.mjs';

const CASH = (pct = 0, v = 0) => ({ id: 'caixa', name: 'Caixa', type: 'valor', idealPct: pct, isCash: true, currentValue: v });
const st = (classes, extra = {}) => migrateState({ classes, ...extra });
const total = (s, quotes = {}, fx = {}) => portfolioTotalBRL(s, quotes, { auto: fx, manual: s.settings.fxManual });
const byTicker = (cls) => Object.fromEntries(cls.items.map((x) => [x.a.ticker, x]));
const APPLY = { date: '2026-10-18' };

// ---------------------------------------------------------------------------------------------
// Sobra em lotes: algoritmo rápido == "um lote por vez" (referência lenta, sem atalhos)
// ---------------------------------------------------------------------------------------------
function slowFill(entries, left) {
  const n = entries.map(() => 0);
  for (let guard = 0; guard < 3e6; guard++) {
    let best = -1, bu = 0, br = 0;
    entries.forEach((e, k) => {
      const inc = e.extra(n[k] + 1) - e.extra(n[k]);
      if (inc > left) return;
      const rem = e.rem - e.extra(n[k]);
      if (rem < 1) return;
      const u = e.u - e.extra(n[k]);
      if (best < 0 || u > bu || (u === bu && (rem > br || (rem === br && e.idx < entries[best].idx)))) { best = k; bu = u; br = rem; }
    });
    if (best < 0) return { lots: n, left };
    left -= entries[best].extra(n[best] + 1) - entries[best].extra(n[best]);
    n[best]++;
  }
  throw new Error('referência lenta não terminou');
}
const costCents = (p, q) => toCents(q * p);
function entry(r, idx, opts = {}) {
  const pick = r();
  const price = pick < 0.15 ? Math.round((0.01 + r() * 0.99) * 10000) / 10000 // centavos de dólar (sub-centavo)
    : pick < 0.3 ? Math.round((1 + r() * 50) * 1000) / 1000                     // 3 casas
      : Math.round((0.05 + r() * (opts.maxPrice || 300)) * 100) / 100;
  const m = r() < 0.2 ? 10 : r() < 0.1 ? 100 : 1;
  const lotExact = price * 100 * m;
  if (lotExact < 1) return entry(r, idx, opts);
  const q0 = Math.floor(r() * 5) * m;
  const v0 = costCents(price, q0);
  const tieU = [0, -5, 17, 100];
  const u = r() < 0.3 ? tieU[Math.floor(r() * tieU.length)] : Math.round((r() - 0.4) * lotExact * 3);
  const rem = r() < 0.2 ? 0.5 + r() : r() < 0.3 ? 400 : r() * (opts.maxRem || 20000);
  return { u, rem, idx, lotExact, extra: (j) => costCents(price, q0 + j * m) - v0 };
}

test('sobra em lotes: resultado idêntico ao "um lote por vez" em 3000 casos (com empates e preços quebrados)', () => {
  const r = rng(424242);
  for (let i = 0; i < 3000; i++) {
    const n = 1 + Math.floor(r() * 8);
    const es = Array.from({ length: n }, (_, k) => entry(r, k));
    const left = Math.floor(r() * 30000);
    const fast = fillLots(es, left);
    const slow = slowFill(es, left);
    assert.deepEqual(fast.lots, slow.lots, `caso ${i}: ${JSON.stringify(es.map((e) => [e.u, e.rem, e.lotExact]))} left=${left}`);
    assert.equal(fast.left, slow.left, `caso ${i}`);
  }
});

test('sobra em lotes: milhões de lotes baratos sem limite artificial e rápido', () => {
  // dois ativos de 1 centavo disputando R$ 50.000 (a versão antiga parava em 250 mil voltas)
  const es = [0, 1].map((idx) => ({ u: 0, rem: 4e6, idx, lotExact: 1, extra: (j) => j }));
  const t0 = Date.now();
  const res = fillLots(es, 5e6);
  assert.ok(Date.now() - t0 < 500, 'deveria ser rápido');
  assert.equal(res.lots[0] + res.lots[1], 5e6);
  assert.ok(Math.abs(res.lots[0] - res.lots[1]) <= 1, 'divide por igual: ' + res.lots);
  assert.equal(res.left, 0);
});

test('lote: centavo barato abaixo do alvo recebe toda a sobra (antes ia R$ 7.500 para o Caixa)', () => {
  const s = st([{ id: 'b', name: 'Ações', type: 'b3', idealPct: 100, assets: [
    { id: 'A', ticker: 'CARO3', idealPct: 45, price: 500, priceMode: 'manual', minQty: 100 },
    { id: 'B', ticker: 'PENY3', idealPct: 45, price: 0.01, priceMode: 'manual' },
    { id: 'C', ticker: 'GORD3', idealPct: 10, price: 10, priceMode: 'manual', qty: 10000 }] }, CASH(0)]);
  const p = planAporte(s, 20000, {});
  assert.ok(p.ok);
  const it = byTicker(p.classes[0]);
  assert.equal(it.PENY3.value, 2000000);
  assert.equal(p.toCash, 0);
  const { state: s2 } = applyPlan(s, p, {}, APPLY);
  assert.ok(Math.abs(total(s2) - total(s) - 20000) < 0.011);
});

test('lote com preço abaixo de R$ 1 em dólar (4 casas): custo real nunca passa do orçamento e o patrimônio fecha', () => {
  for (const price of [0.5123, 0.9999, 0.0137]) {
    const s = st([{ id: 'u', name: 'EUA', type: 'exterior', fractional: false, idealPct: 100, assets: [
      { id: 'x', ticker: 'PENY', idealPct: 60, price, priceMode: 'manual' },
      { id: 'y', ticker: 'MIDY', idealPct: 40, price: 3.21, priceMode: 'manual', minQty: 1 }] }, CASH(0)], { settings: { fxManual: { USD: 5.4321 } } });
    assert.equal(buyMode(s.classes[0]), 'lote');
    const p = planAporte(s, 12345.67, {});
    assert.ok(p.ok, JSON.stringify(p.errors));
    const cls = p.classes[0];
    const real = cls.items.reduce((acc, it) => acc + Math.round(it.qty * it.price * 100), 0);
    assert.ok(real <= cls.budgetNative, `preço ${price}: custo real ${real} > orçamento ${cls.budgetNative}`);
    cls.items.forEach((it) => assert.equal(it.value, costCents(it.price, it.qty)));
    const { state: s2 } = applyPlan(s, p, {}, APPLY);
    const delta = total(s2) - total(s);
    assert.ok(Math.abs(delta - 12345.67) <= 0.12, `preço ${price}: patrimônio subiu ${delta}`);
  }
});

test('B3: preço com 3 casas ou "sujeira" da fonte é tratado em centavos (como a bolsa negocia)', () => {
  const s = st([{ id: 'b', name: 'FIIs', type: 'b3', idealPct: 100, assets: [{ id: 'f', ticker: 'XXXX11', idealPct: 100, price: 9.714, priceMode: 'manual' }] }, CASH(0)]);
  const p = planAporte(s, 100000, {});
  const it = p.classes[0].items[0];
  assert.equal(it.price, 9.71);
  assert.ok(it.qty * 971 <= 10000000);
  const { state: s2 } = applyPlan(s, p, {}, APPLY);
  assert.ok(Math.abs(total(s2) - total(s) - 100000) <= 0.011);
  assert.equal(cleanPrice(s.classes[0], 37.150001525878906), 37.15);
  assert.equal(cleanPrice({ type: 'cripto' }, 0.000123456789), 0.00012346);
  assert.equal(cleanPrice({ type: 'b3' }, 0.004), 0, 'abaixo de 1 centavo na B3 = sem preço');
});

test('B3 compra sempre cotas inteiras, mesmo com "fracionado" marcado numa versão antiga', () => {
  const s = st([{ id: 'b', name: 'Ações', type: 'b3', fractional: true, idealPct: 100, assets: [{ id: 'w', ticker: 'WEGE3', idealPct: 100, price: 47.99, priceMode: 'manual' }] }, CASH(0)]);
  assert.equal(buyMode(s.classes[0]), 'lote');
  const p = planAporte(s, 100, {});
  assert.equal(p.classes[0].items[0].qty, 2);
  assert.equal(p.toCash, 10000 - 9598);
});

// ---------------------------------------------------------------------------------------------
// Mínimos em fração/valor: exclui um de cada vez
// ---------------------------------------------------------------------------------------------
test('mínimo de aplicação: só o pior sai; o outro recebe tudo (antes os dois saíam e R$ 1.000 ia para o Caixa)', () => {
  const s = st([{ id: 'rf', name: 'RF', type: 'rendafixa', idealPct: 100, assets: [
    { id: 'a', ticker: 'POUP', idealPct: 20, currentValue: 10000 },
    { id: 'b', ticker: 'CDB B', idealPct: 40, minAmount: 600 },
    { id: 'c', ticker: 'CDB C', idealPct: 40, minAmount: 600 }] }, CASH(0)]);
  const p = planAporte(s, 1000, {});
  const it = byTicker(p.classes[0]);
  assert.equal(it['CDB B'].value + it['CDB C'].value, 100000);
  assert.equal([it['CDB B'].status, it['CDB C'].status].sort().join(), 'abaixo_minimo,ok');
  assert.equal(p.toCash, 0);
});

test('cripto: com R$ 150 e mínimo de R$ 100 cada, um ativo recebe os R$ 150 (se o alvo dele comporta)', () => {
  // BTC já está acima do alvo; ETH e SOL estão R$ 287,50 abaixo cada — partes de R$ 75 não atingem o mínimo
  const s = st([{ id: 'c', name: 'Cripto', type: 'cripto', idealPct: 100, assets: [
    { id: 'b', ticker: 'BTC', idealPct: 50, currentValue: 1000 },
    { id: 'e', ticker: 'ETH', idealPct: 25, minAmount: 100 }, { id: 's', ticker: 'SOL', idealPct: 25, minAmount: 100 }] }, CASH(0)]);
  const quotes = { 'CRYPTO:BTC': { price: 400000, currency: 'BRL' }, 'CRYPTO:ETH': { price: 12000, currency: 'BRL' }, 'CRYPTO:SOL': { price: 900, currency: 'BRL' } };
  const p = planAporte(s, 150, { quotes });
  const it = byTicker(p.classes[0]);
  assert.equal(it.ETH.value + it.SOL.value, 15000);
  assert.ok([it.ETH.value, it.SOL.value].includes(0));
  assert.equal(p.toCash, 0);
  // sem espaço no alvo de nenhum (classe vazia: alvo de R$ 75 cada), ninguém compra abaixo do mínimo
  const s2 = st([{ id: 'c', name: 'Cripto', type: 'cripto', idealPct: 100, assets: [
    { id: 'e', ticker: 'ETH', idealPct: 50, minAmount: 100 }, { id: 's', ticker: 'SOL', idealPct: 50, minAmount: 100 }] }, CASH(0)]);
  const p2 = planAporte(s2, 150, { quotes });
  assert.equal(p2.toCash, 15000);
  assert.ok(p2.warnings.some((w) => w.code === 'abaixo_minimo'));
});

test('mínimo de R$ 1,00 por compra em fração/valor (nada de ordens de R$ 0,04)', () => {
  const s = st([{ id: 'c', name: 'Cripto', type: 'cripto', idealPct: 100, assets: [
    { id: 'b', ticker: 'BTC', idealPct: 99, qty: 0 }, { id: 'e', ticker: 'ETH', idealPct: 1 }] }, CASH(0)]);
  const quotes = { 'CRYPTO:BTC': { price: 400000, currency: 'BRL' }, 'CRYPTO:ETH': { price: 12000, currency: 'BRL' } };
  const p = planAporte(s, 50, { quotes });
  const it = byTicker(p.classes[0]);
  assert.equal(it.ETH.status, 'abaixo_minimo');
  assert.equal(it.ETH.value, 0);
  assert.equal(it.BTC.value, 4950);
  assert.ok(p.orders.every((o) => o.mode === 'lote' || o.valueNative >= MIN_ORDER_CENTS));
});

test('fração/valor: quando o orçamento cobre os déficits, nenhum centavo se perde no arredondamento', () => {
  // déficits 41,15 + 41,15 + 41,15 = 123,45 exatos (antes: R$ 123,44 investidos e 1 centavo no Caixa)
  const s = st([{ id: 'r', name: 'RF', type: 'rendafixa', idealPct: 50, assets: [
    { id: 'a', ticker: 'A', idealPct: 33.33 }, { id: 'b', ticker: 'B', idealPct: 33.33 }, { id: 'c', ticker: 'C', idealPct: 33.34 }] }, CASH(50, 123.45)]);
  const p = planAporte(s, 123.45, {});
  assert.equal(p.classes[0].investedBRL, 12345);
  assert.equal(p.toCash, 0);
});

// ---------------------------------------------------------------------------------------------
// Registrar e desfazer
// ---------------------------------------------------------------------------------------------
function demo() {
  const s = st([
    { id: 'b', name: 'Ações', type: 'b3', idealPct: 60, assets: [
      { id: 'w', ticker: 'WEGE3', idealPct: 50, qty: 10, price: 47.99, priceMode: 'manual' },
      { id: 'v', ticker: 'VALE3', idealPct: 50, price: 61.2, priceMode: 'manual' }] },
    { id: 'r', name: 'RF', type: 'rendafixa', idealPct: 30, assets: [{ id: 't', ticker: 'TESOURO SELIC', idealPct: 100, currentValue: 300 }] },
    CASH(10, 50)]);
  return s;
}

test('registrar recusa ordem velha: carteira ou cotação mudou depois do cálculo', () => {
  const s = demo();
  const p = planAporte(s, 1000, {});
  const s2 = JSON.parse(JSON.stringify(s));
  s2.classes[0].assets[1].price = 70; // a pessoa mudou o preço depois de calcular
  assert.throws(() => applyPlan(s2, p, {}, APPLY), /mudaram depois do cálculo/);
  const s3 = JSON.parse(JSON.stringify(s));
  s3.classes[0].idealPct = 50; s3.classes[1].idealPct = 40;
  assert.throws(() => applyPlan(s3, p, {}, APPLY), /mudaram depois do cálculo/);
  // cotação nova para um ativo em modo automático
  const sa = demo(); sa.classes[0].assets[1].priceMode = 'auto';
  const q1 = { VALE3: { price: 61.2, currency: 'BRL' } };
  const pa = planAporte(sa, 1000, { quotes: q1 });
  assert.throws(() => applyPlan(sa, pa, { quotes: { VALE3: { price: 66, currency: 'BRL' } } }, APPLY), /mudaram/);
  // mesma cotação atualizada (sem mudar o preço): continua valendo
  assert.doesNotThrow(() => applyPlan(sa, pa, { quotes: { VALE3: { price: 61.2, currency: 'BRL', updated_at: 'x' } } }, APPLY));
  // edições que não afetam o cálculo não invalidam
  const s4 = JSON.parse(JSON.stringify(s)); s4.agenda.customNote = 'oi';
  assert.equal(stateSignature(s4, {}), stateSignature(s, {}));
});

test('registrar recusa id duplicado em vez de creditar o ativo errado', () => {
  const s = demo();
  const p = planAporte(s, 1000, {});
  const bad = JSON.parse(JSON.stringify(s));
  bad.classes[0].assets.push({ ...bad.classes[0].assets[1] }); // mesmo id duas vezes (backup adulterado)
  assert.throws(() => applyPlan(bad, { ...p, sig: stateSignature(bad, {}) }, {}, APPLY), /duplicado/);
});

test('registrar grava Caixa total, compras e o que somou; desfazer tira só aquilo e mantém o que veio depois', () => {
  const s = demo();
  const p = planAporte(s, 1000, {});
  const { state: s2, record } = applyPlan(s, p, {}, { ...APPLY, obs: 'salário' });
  assert.equal(record.caixa, (p.toCash + p.cashDirect) / 100);
  assert.equal(record.observacao, 'salário');
  assert.ok(record.deltas.length > 0);
  assert.ok(Math.abs(total(s2) - total(s) - 1000) <= 0.011);
  // depois do aporte: a pessoa ajusta a renda fixa e a quantidade de WEGE3 (vendeu 2)
  const s3 = JSON.parse(JSON.stringify(s2));
  s3.classes[1].assets[0].currentValue += 25.5;
  s3.classes[0].assets[0].qty -= 2;
  s3.dividendos.push({ id: 'd1', date: '2026-10-19', ticker: 'WEGE3', tipo: 'Dividendo', valor: 3.2 });
  const { state: s4, missing, clamped } = revertAporte(s3, record.id);
  assert.deepEqual(missing, []); assert.deepEqual(clamped, []);
  assert.equal(s4.aportes.length, 0);
  assert.equal(s4.timeline.filter((t) => t.aporteId === record.id).length, 0);
  assert.equal(s4.agenda.lastAporteDate, null);
  // o que veio depois continua
  assert.equal(s4.classes[1].assets[0].currentValue, 300 + 25.5);
  assert.equal(s4.classes[0].assets[0].qty, 10 - 2);
  assert.equal(s4.dividendos.length, 1);
  assert.equal(s4.classes[2].currentValue, 50);
  // sem as edições, desfazer volta exatamente ao início
  const back = revertAporte(s2, record.id).state;
  assert.ok(Math.abs(total(back) - total(s)) < 1e-9);
  back.classes.forEach((c, k) => {
    assert.equal(c.currentValue, s.classes[k].currentValue);
    c.assets.forEach((a, j) => { assert.equal(a.qty, s.classes[k].assets[j].qty); assert.equal(a.currentValue, s.classes[k].assets[j].currentValue); });
  });
});

test('desfazer avisa quando o ativo foi apagado ou já tinha menos do que o aporte somou', () => {
  const s = demo();
  const p = planAporte(s, 1000, {});
  const { state: s2, record } = applyPlan(s, p, {}, APPLY);
  const s3 = JSON.parse(JSON.stringify(s2));
  s3.classes[0].assets = s3.classes[0].assets.filter((a) => a.ticker !== 'VALE3');
  s3.classes[1].assets[0].currentValue = 0;
  const res = revertAporte(s3, record.id);
  assert.ok(res.missing.includes('VALE3'));
  assert.ok(res.clamped.includes('TESOURO SELIC'));
  assert.ok(res.state.classes[1].assets[0].currentValue === 0);
  assert.throws(() => revertAporte(s2, 'nao-existe'), /não encontrado/);
  const legacy = JSON.parse(JSON.stringify(s2)); delete legacy.aportes[0].deltas;
  assert.throws(() => revertAporte(legacy, record.id), /versão antiga/);
});

test('mercado nulo ou ausente não quebra o motor', () => {
  const s = demo();
  const p = planAporte(s, 100, null);
  assert.ok(p.ok);
  assert.doesNotThrow(() => applyPlan(s, p, null, APPLY));
});

test('carteira vazia: não inventa alinhamento "antes" de 50%', () => {
  const s = migrateState(defaultState());
  const p = planAporte(s, 1000, {});
  assert.equal(p.before, null);
  assert.ok(p.after >= 0 && p.after <= 100);
});

// ---------------------------------------------------------------------------------------------
// Migração: nunca esconder patrimônio, ler formatos antigos, ids únicos
// ---------------------------------------------------------------------------------------------
test('migração: classe com ativos marcada como Caixa continua com os ativos; cria-se um Caixa vazio', () => {
  const old = { classes: [
    { id: 'acoes', name: 'Ações', type: 'b3', idealPct: 90, isCash: true, assets: [{ id: 'y', ticker: 'VALE3', idealPct: 100, qty: 100, lastQuotePrice: 60 }] },
    { id: 'rf', name: 'RF', idealPct: 10, hasAssets: true, assets: [{ id: 'r', ticker: 'TESOURO SELIC', idealPct: 100, currentValue: 5000 }] },
  ] };
  const m = migrateState(old);
  const acoes = m.classes.find((c) => c.id === 'acoes');
  assert.equal(acoes.type, 'b3');
  assert.equal(acoes.isCash, false);
  assert.equal(classValueNative(acoes, {}), 6000);
  const cash = m.classes.filter((c) => c.isCash);
  assert.equal(cash.length, 1);
  assert.equal(cash[0].type, 'valor'); assert.equal(cash[0].idealPct, 0);
  assert.equal(total(m), 11000, 'nenhum real some');
  assert.equal(m.migrationNotes.length, 1);
  assert.deepEqual(migrateState(m), m, 'idempotente: não cria outro Caixa nem repete o aviso');
  // legado: "Caixa" com hasAssets e um título dentro
  const leg = migrateState({ classes: [{ id: 'caixa', name: 'Caixa', idealPct: 100, hasAssets: true, assets: [{ ticker: 'TESOURO SELIC', idealPct: 100, currentValue: 5000 }] }] });
  assert.equal(total(leg), 5000);
  assert.equal(leg.classes.filter((c) => c.isCash).length, 1);
  // Caixa num tipo com ativos mas sem nenhum ativo: vira valor direto e mantém o valor
  const empty = migrateState({ classes: [{ id: 'caixa', name: 'Caixa', idealPct: 100, hasAssets: true, assets: [], currentValue: 321 }] });
  assert.equal(empty.classes.length, 1);
  assert.equal(empty.classes[0].type, 'valor');
  assert.equal(total(empty), 321);
  // classe com ativos sem "type" nem "hasAssets": tem ativos, então não é "valor direto"
  const noFlag = migrateState({ classes: [{ id: 'x', name: 'Ações', idealPct: 100, assets: [{ id: 'a', ticker: 'ITSA4', idealPct: 100, currentValue: 1500 }] }] });
  assert.equal(noFlag.classes[0].type, 'b3');
  assert.equal(total(noFlag), 1500);
});

test('migração: números salvos como texto no formato brasileiro', () => {
  const m = migrateState({ classes: [
    { id: 'r', name: 'RF', type: 'rendafixa', idealPct: '90', assets: [{ id: 'a', ticker: 'CDB', idealPct: '100', currentValue: '1.234,56' }] },
    { id: 'caixa', name: 'Caixa', type: 'valor', idealPct: '10,0', isCash: true, currentValue: 'R$ 1.500,00' },
    { id: 'c', name: 'Cripto', type: 'cripto', idealPct: 0, assets: [{ id: 'b', ticker: 'BTC', idealPct: 100, qty: '0,5', lastQuotePrice: '400000.5' }] },
  ], settings: { fxManual: { USD: '5,43' } } });
  assert.equal(m.classes[0].assets[0].currentValue, 1234.56);
  assert.equal(m.classes[1].currentValue, 1500);
  assert.equal(m.classes[1].idealPct, 10);
  assert.equal(m.classes[2].assets[0].qty, 0.5);
  assert.equal(m.classes[2].assets[0].lastQuotePrice, 400000.5);
  assert.equal(m.settings.fxManual.USD, 5.43);
  assert.equal(toNumber('1234.56'), 1234.56);
  assert.equal(toNumber('1e3'), 1000);
  assert.equal(toNumber(Infinity), 0);
  assert.equal(toNumber({}), 0);
});

test('migração: ids duplicados ou inválidos ganham ids novos e estáveis', () => {
  const m = migrateState({ classes: [
    { id: 'b', name: 'Ações', type: 'b3', idealPct: 50, assets: [{ id: 'dup', ticker: 'WEGE3', idealPct: 50 }, { id: 'dup', ticker: 'VALE3', idealPct: 50 }, { id: [], ticker: 'ITSA4', idealPct: 0 }] },
    { id: 'b', name: 'Outra', type: 'valor', idealPct: 40 },
    CASH(10)] });
  const cids = m.classes.map((c) => c.id);
  assert.equal(new Set(cids).size, cids.length);
  const aids = m.classes[0].assets.map((a) => a.id);
  assert.equal(new Set(aids).size, 3);
  assert.ok(aids.every((x) => typeof x === 'string' && x.length >= 1));
  assert.equal(aids[0], 'dup', 'o primeiro mantém o id');
  assert.deepEqual(migrateState(m), m, 'idempotente');
  const p = planAporte(m, 1000, { quotes: { WEGE3: { price: 50, currency: 'BRL' }, VALE3: { price: 60, currency: 'BRL' } } });
  const { state: s2 } = applyPlan(m, p, { quotes: { WEGE3: { price: 50, currency: 'BRL' }, VALE3: { price: 60, currency: 'BRL' } } }, APPLY);
  const q = { WEGE3: { price: 50, currency: 'BRL' }, VALE3: { price: 60, currency: 'BRL' } };
  assert.ok(Math.abs(total(s2, q) - total(m, q) - 1000) <= 0.011);
});

test('migração: entrada inválida dá a carteira padrão, e migrar de novo não muda nada', () => {
  for (const bad of [null, undefined, 42, 'x', [], { classes: 'x' }]) {
    const m = migrateState(bad);
    assert.equal(m.version, 4);
    assert.ok(m.classes.length > 0);
    const again = migrateState(m);
    assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(m)));
  }
});

test('migração: agenda com dia da semana 7 vira domingo; data inválida é descartada; desfazer antigo sai', () => {
  const m = migrateState({ classes: [CASH(100)], agenda: { frequency: 'semanal', weekday: 7, lastAporteDate: '01/10/2026' }, undo: { prev: { classes: [] } } });
  assert.equal(m.agenda.weekday, 0);
  assert.equal(m.agenda.lastAporteDate, null);
  assert.equal(m.undo, undefined);
});

// ---------------------------------------------------------------------------------------------
// Números e datas
// ---------------------------------------------------------------------------------------------
test('parseNum: casos novos (grupos, notação científica)', () => {
  const cases = { '1.000.50': 1000.5, '1,234,56': 1234.56, '1.234.567': 1234567, '1,234,567': 1234567, '1e5': 100000, '1.5e-7': 1.5e-7,
    '-2e3': -2000, '1.234,56': 1234.56, '0,5': 0.5, '(1.500,00)': -1500, 'US$ 3.21': 3.21 };
  for (const [k, v] of Object.entries(cases)) assert.equal(parseNum(k), v, k);
});

test('agenda: data salva inválida não gera "NaN dias"; dia da semana 7 é domingo', () => {
  const today = new Date(2026, 9, 18); // domingo
  for (const bad of ['2026-10-18T10:00:00Z', '01/10/2026', 'abc', 123]) {
    const d = nextAporteDate({ frequency: 'semanal', weekday: 1, lastAporteDate: bad }, today);
    assert.ok(d instanceof Date && !Number.isNaN(d.getTime()), String(bad));
  }
  assert.equal(todayISO(nextAporteDate({ frequency: 'semanal', weekday: 7 }, today)), '2026-10-18');
  assert.equal(todayISO(nextAporteDate({ frequency: 'semanal', weekday: 8 }, today)), '2026-10-19');
});

test('apportion: pesos infinitos ou inválidos não geram NaN', () => {
  const out = apportion(100, [Infinity, 1, NaN, -3]);
  assert.ok(out.every((x) => Number.isInteger(x) && x >= 0));
  assert.equal(out.reduce((a, b) => a + b, 0), 100);
});

test('preço: modo manual sem preço digitado segue a regra do automático (cotação → última conhecida)', () => {
  const s = demo();
  const c = s.classes[0]; const a = c.assets[1];
  a.priceMode = 'manual'; a.price = 0; a.lastQuotePrice = 59.9;
  assert.deepEqual([assetPrice(c, a, {}).price, assetPrice(c, a, {}).source], [59.9, 'cache']);
  assert.equal(assetPrice(c, a, { VALE3: { price: 61, currency: 'BRL' } }).price, 61);
});

test('cotação velha (fonte parada ou ticker que sumiu) não vale como preço atual, mas é o último preço real — nunca vira zero', () => {
  const s = demo();
  const c = s.classes[0]; const a = c.assets[1]; // VALE3
  a.priceMode = 'auto'; a.lastQuotePrice = 0; a.qty = 10;
  const stale = { VALE3: { price: 80, currency: 'BRL', stale: true } };
  assert.deepEqual([assetPrice(c, a, stale).price, assetPrice(c, a, stale).source], [80, 'cache'], 'velha, mas é o último preço real');
  a.lastQuotePrice = 66.21; // preço do último aporte (mais antigo que a última cotação vista)
  assert.equal(assetPrice(c, a, stale).price, 80, 'a última cotação vista é mais recente que a do último aporte');
  assert.equal(assetPrice(c, a, { VALE3: { price: 0, currency: 'BRL', stale: true } }).price, 66.21, 'sem preço na cotação: usa o do último aporte');
  assert.equal(assetPrice(c, a, { VALE3: { price: 61, currency: 'BRL' } }).source, 'auto');
  a.lastQuotePrice = 0;
  assert.equal(assetPrice(c, a, {}).price, 0);
});

test('posição com cotas e nenhum preço conhecido bloqueia o cálculo (senão a carteira valeria R$ 0)', () => {
  const s = demo();
  s.classes[0].assets[1].priceMode = 'auto'; s.classes[0].assets[1].price = 0; s.classes[0].assets[1].qty = 100;
  const p = planAporte(s, 1000, {});
  assert.equal(p.ok, false);
  assert.ok(p.errors.some((e) => e.code === 'posicao_sem_preco' && e.tickers.includes('VALE3')));
  // com o último preço conhecido (mesmo velho) volta a calcular
  const p2 = planAporte(s, 1000, { quotes: { VALE3: { price: 61.2, currency: 'BRL', stale: true } } });
  assert.ok(p2.ok, JSON.stringify(p2.errors));
});

test('desfazer depois de mudar o tipo da classe tira o valor que o aporte somou', () => {
  const s = demo();
  const p = planAporte(s, 1000, {});
  const { state: s2, record } = applyPlan(s, p, {}, APPLY);
  // a pessoa muda Ações (cotas) para Renda fixa (valor): cada ativo guarda o valor de hoje e as cotas zeram
  const s3 = JSON.parse(JSON.stringify(s2));
  const c = s3.classes[0];
  c.assets.forEach((a) => { a.currentValue = Math.round(a.qty * a.price * 100) / 100 + (Number(a.currentValue) || 0) * 0; a.qty = 0; });
  c.type = 'rendafixa';
  const before = total(s);
  const res = revertAporte(s3, record.id, {});
  assert.deepEqual(res.manual, []);
  assert.ok(Math.abs(total(res.state) - before) < 0.011, `voltou a ${total(res.state)} (antes ${before})`);
});

test('desfazer com câmbio: aporte em classe em US$ que virou R$ é convertido; sem câmbio vai para conferência manual', () => {
  const s = st([{ id: 'u', name: 'EUA', type: 'exterior', idealPct: 90, assets: [{ id: 'x', ticker: 'AAPL', idealPct: 100, price: 200, priceMode: 'manual' }] }, CASH(10)], { settings: { fxManual: { USD: 5 } } });
  const p = planAporte(s, 1000, {});
  const { state: s2, record } = applyPlan(s, p, {}, APPLY);
  const s3 = JSON.parse(JSON.stringify(s2));
  const c = s3.classes[0];
  c.assets[0].currentValue = Math.round(c.assets[0].qty * 200 * 5 * 100) / 100; c.assets[0].qty = 0; c.type = 'rendafixa'; c.currency = 'BRL';
  const res = revertAporte(s3, record.id, {});
  assert.deepEqual(res.manual, []);
  assert.ok(Math.abs(res.state.classes[0].assets[0].currentValue) < 0.011, 'tirou o valor convertido para R$');
  const s4 = JSON.parse(JSON.stringify(s3)); s4.settings.fxManual.USD = null;
  const res2 = revertAporte(s4, record.id, {});
  assert.equal(res2.manual.length, 1, 'sem câmbio: pede conferência em vez de chutar');
});

test('desfazer vários aportes do mesmo dia volta a data da agenda para antes deles', () => {
  let s = demo();
  s.agenda.lastAporteDate = '2026-10-01';
  const ids = [];
  for (let k = 0; k < 3; k++) { const p = planAporte(s, 100, {}); const r = applyPlan(s, p, {}, APPLY); s = r.state; ids.push(r.record.id); }
  assert.equal(s.agenda.lastAporteDate, '2026-10-18');
  for (const id of ids) s = revertAporte(s, id, {}).state; // do mais antigo para o mais novo
  assert.equal(s.agenda.lastAporteDate, null, 'os três eram do mesmo dia: não sobra data de hoje');
  let t = demo(); t.agenda.lastAporteDate = '2026-10-01';
  const p1 = planAporte(t, 100, {}); const r1 = applyPlan(t, p1, {}, APPLY); t = r1.state;
  t = revertAporte(t, r1.record.id, {}).state;
  assert.equal(t.agenda.lastAporteDate, '2026-10-01', 'aporte único: volta a data anterior');
});

// ---------------------------------------------------------------------------------------------
// Troca de ticker (incorporação/mudança de código) com conversão de cotas
// ---------------------------------------------------------------------------------------------
test('troca de ticker: BCFF11 → BTHF11 converte 10 cotas em 8; fração vira dinheiro', () => {
  assert.deepEqual(TICKER_CHANGES.BCFF11.to, 'BTHF11');
  assert.equal(TICKER_CHANGES.BCFF11.factor, 0.8);
  assert.equal(TICKER_CHANGES.MALL11.to, 'PMLL11');
  assert.equal(TICKER_CHANGES.MALL11.factor, 1);
  assert.deepEqual(convertQty(10, 0.8, 'lote'), { qty: 8, fraction: 0 });
  assert.deepEqual(convertQty(13, 0.8, 'lote'), { qty: 10, fraction: 0.4 });
  assert.deepEqual(convertQty(7, 0.8, 'lote'), { qty: 5, fraction: 0.6 });
  assert.deepEqual(convertQty(15, 0.8, 'lote'), { qty: 12, fraction: 0 });
  assert.deepEqual(convertQty(1, 0.8, 'lote'), { qty: 0, fraction: 0.8 });
  assert.deepEqual(convertQty(3, 1 / 3, 'lote'), { qty: 1, fraction: 0 }, '3 × 1/3 é 1 cota, não 0,999…');
  assert.deepEqual(convertQty(250, 1, 'lote'), { qty: 250, fraction: 0 });
  assert.deepEqual(convertQty(0.5, 2, 'fracao'), { qty: 1, fraction: 0 });
  for (let q = 0; q <= 2000; q++) { // nunca cria cota do nada nem perde mais que uma
    const r = convertQty(q, 0.8, 'lote');
    assert.ok(Number.isInteger(r.qty) && r.qty <= q * 0.8 + 1e-9 && q * 0.8 - r.qty < 1 - 1e-12, `q=${q}`);
    assert.ok(Math.abs(r.qty + r.fraction - q * 0.8) < 1e-6, `q=${q}: soma volta ao total`);
  }
});

test('troca de ticker: migração guarda a época das cotas e o histórico da troca; aporte antigo vai para conferência', () => {
  const s = st([{ id: 'f', name: 'FIIs', type: 'b3', idealPct: 90, assets: [{ id: 'b', ticker: 'BCFF11', idealPct: 100, qty: 13, price: 8, priceMode: 'manual' }] }, CASH(10)]);
  const p = planAporte(s, 1000, {});
  assert.ok(p.ok);
  const { state: s2, record } = applyPlan(s, p, {}, APPLY);
  const bought = s2.classes[0].assets[0].qty - 13;
  assert.ok(bought > 0);
  assert.equal(record.deltas.find((d) => d.field === 'qty').epoch, undefined, 'sem troca, aporte não carrega época');
  // a pessoa troca para BTHF11 (o app converte as cotas e sobe a época)
  const s3 = JSON.parse(JSON.stringify(s2));
  const a = s3.classes[0].assets[0];
  const conv = convertQty(a.qty, 0.8, 'lote');
  Object.assign(a, { ticker: 'BTHF11', qty: conv.qty, qtyEpoch: 1, price: 0, priceMode: 'auto', lastQuotePrice: 0,
    swaps: [{ from: 'BCFF11', to: 'BTHF11', factor: 0.8, date: '2024-10-18' }] });
  const m = migrateState(s3).state || migrateState(s3);
  const am = m.classes[0].assets[0];
  assert.equal(am.qtyEpoch, 1);
  assert.deepEqual(am.swaps, [{ from: 'BCFF11', to: 'BTHF11', factor: 0.8, date: '2024-10-18' }]);
  const mm = migrateState(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(mm.state || mm, m, 'migrar de novo não muda nada');
  // desfazer o aporte feito antes da troca: não tira cotas de BCFF11 de BTHF11 — pede conferência
  const res = revertAporte(m, record.id, { quotes: { BTHF11: { price: 9, currency: 'BRL' } } });
  assert.equal(res.state.classes[0].assets[0].qty, conv.qty, 'quantidade não mexida');
  assert.equal(res.manual.length, 1);
  assert.equal(res.manual[0].swapped, true);
  assert.equal(res.manual[0].qty, bought);
  // aporte feito DEPOIS da troca guarda a época e desfaz normalmente
  m.classes[0].assets[0].price = 9; m.classes[0].assets[0].priceMode = 'manual';
  const p2 = planAporte(m, 500, {});
  const r2 = applyPlan(m, p2, {}, APPLY);
  const d2 = r2.record.deltas.find((d) => d.field === 'qty');
  assert.equal(d2.epoch, 1);
  const back = revertAporte(r2.state, r2.record.id, {});
  assert.deepEqual(back.manual, []);
  assert.equal(back.state.classes[0].assets[0].qty, conv.qty);
  // registro com época sobrevive à migração
  const m2 = migrateState(JSON.parse(JSON.stringify(r2.state)));
  assert.equal((m2.state || m2).aportes.at(-1).deltas.find((d) => d.field === 'qty').epoch, 1);
});

// ---------------------------------------------------------------------------------------------
// Refinamento dos lotes: a combinação de cotas inteiras mais perto do plano
// ---------------------------------------------------------------------------------------------
test('lotes: cota cara com o maior alvo entra quando cabe (caso real: IVVB11 com R$ 750 em ETFs)', () => {
  const s = st([{ id: 'e', name: 'ETFs', type: 'b3', idealPct: 100, assets: [
    { id: 'i', ticker: 'IVVB11', idealPct: 40, price: 441.23, priceMode: 'manual' },
    { id: 'n', ticker: 'NASD11', idealPct: 30, price: 20.93, priceMode: 'manual' },
    { id: 'w', ticker: 'WRLD11', idealPct: 20, price: 144.52, priceMode: 'manual' },
    { id: 'd', ticker: 'DIVO11', idealPct: 10, price: 144.31, priceMode: 'manual' }] }, CASH(0)]);
  const p = planAporte(s, 750, {});
  assert.ok(p.ok);
  const it = byTicker(p.classes[0]);
  assert.equal(it.IVVB11.qty, 1, 'IVVB11 entra');
  assert.ok(p.toCash < 2000, `sobra pequena para o Caixa (${p.toCash / 100})`);
  // antes: NASD11 11, WRLD11 2, DIVO11 1, IVVB11 0 e R$ 86,42 para o Caixa
  const items = p.classes[0].items.map((x) => ({ v: 0, target: (x.ideal / 100) * 75000, price: x.price, minQty: 1 }));
  const old = [0, 11, 2, 1];
  const now = p.classes[0].items.map((x) => x.qty);
  assert.ok(lotsDeviation(items, now, 75000) < lotsDeviation(items, old, 75000) / 2, 'desvio menor que a metade do de antes');
});

test('lotes: refinamento nunca passa do orçamento, nunca piora e não perde centavos (aleatório)', () => {
  const R = rng(20261019);
  for (let k = 0; k < 400; k++) {
    const n = 1 + Math.floor(R() * 7);
    const budget = 100 + Math.floor(R() * 300000);
    const items = Array.from({ length: n }, () => {
      const price = [0.37, 3.62, 9.36, 20.93, 47.84, 100.16, 144.52, 441.23, 1999.9][Math.floor(R() * 9)];
      return { v: Math.floor(R() * 40000), target: 0, price, minQty: R() < 0.1 ? 100 : 1 };
    });
    const V = items.reduce((s2, it) => s2 + it.v, 0);
    const w = items.map(() => R());
    const W = w.reduce((a, b) => a + b, 0);
    items.forEach((it, i) => { it.target = (w[i] / W) * (V + budget); });
    const start = items.map((it) => (R() < 0.5 ? 0 : it.minQty * Math.floor(R() * 3)));
    if (lotsDeviation(items, start, budget) === Infinity) continue;
    const xs = refineLots(items, budget, start);
    const spent = xs.reduce((s2, q, i) => s2 + Math.round(q * items[i].price * 100), 0);
    assert.ok(spent <= budget, `caso ${k}: gastou ${spent} de ${budget}`);
    assert.ok(xs.every((q, i) => q >= 0 && q % items[i].minQty === 0), `caso ${k}: lotes inteiros`);
    assert.ok(lotsDeviation(items, xs, budget) <= lotsDeviation(items, start, budget), `caso ${k}: não piorou`);
  }
});

test('lotes: classe grande (300 ativos) refina rápido', () => {
  const assets = Array.from({ length: 300 }, (_, i) => ({ id: 'a' + i, ticker: 'T' + String(i).padStart(3, '0') + '3', idealPct: 100 / 300, price: 5 + (i % 37) * 3.17, priceMode: 'manual' }));
  assets[299].idealPct = 100 - (100 / 300) * 299;
  const s = st([{ id: 'b', name: 'Ações', type: 'b3', idealPct: 100, assets }, CASH(0)]);
  const t0 = Date.now();
  const p = planAporte(s, 25000, {});
  assert.ok(p.ok, JSON.stringify(p.errors));
  assert.ok(Date.now() - t0 < 3000, `levou ${Date.now() - t0} ms`);
  assert.ok(p.toCash < 2000, 'quase tudo investido');
});
