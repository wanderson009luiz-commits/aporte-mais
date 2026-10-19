// =====================================================================
// Aporte+ — motor de cálculo do aporte (puro: sem DOM, sem rede).
//
// Regras (em ordem):
//  1. Validação: classes somam 100%, ativos de cada classe com peso somam 100%,
//     existe um Caixa (valor direto, em R$), toda moeda estrangeira em uso tem cotação.
//  2. Entre classes: cada classe tem um alvo = % ideal × (patrimônio + aporte).
//     O aporte é dividido proporcionalmente à distância de cada classe até o alvo.
//  3. Dentro da classe, o mesmo critério entre os ativos (nunca passando do alvo do ativo).
//     - lote:   compra cotas inteiras; a sobra compra mais cotas de quem ainda está abaixo
//               do alvo, um lote por vez para quem ficou mais longe da sua parte (no máximo
//               uma cota além do alvo por ativo). Sem limite artificial de quantidade.
//     - fracao: compra o valor exato (cripto, exterior), mínimo de 1,00 por compra.
//     - valor:  aplica o valor em R$ (renda fixa), mínimo de 1,00 por aplicação.
//     Quem não alcança o mínimo sai — um de cada vez — e a parte dele vai para os demais.
//  4. Tudo que não puder ser investido vai para o Caixa de Oportunidade.
//
// Todas as contas internas são em CENTAVOS inteiros. O custo de uma compra em lote é
// arredondado ao centavo exatamente como a corretora cobra (quantidade × preço).
// O motor confere no fim que investido + direto + caixa = aporte, ao centavo; ao registrar,
// confere que o patrimônio subiu o valor do aporte. Se não fechar, ele se recusa a responder.
// =====================================================================
import {
  classType, classCurrency, buyMode, hasAssets, assetPrice, assetValue, isAutoValued,
  classValueNative, fxRate, sumIdeal, isHundred, normTicker, toCents, todayISO, uid, toNumber,
} from './model.js?v=dev';

const num = toNumber;

/** Menor compra em valor (cripto, exterior, renda fixa): 1,00. Nenhuma corretora aceita R$ 0,04. */
export const MIN_ORDER_CENTS = 100;
function fmtPctTxt(v) { return (Math.round(v * 100) / 100).toString().replace('.', ','); }
function brl(cents) { return 'R$ ' + (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

/** Custo em centavos de `qty` cotas a `price` (moeda da classe), arredondado ao centavo. */
function costCents(price, qty) { return toCents(qty * price); }

/**
 * Divide `total` centavos em partes inteiras proporcionais a `weights`
 * (método do maior resto). A soma das partes é exatamente `total` (se houver peso > 0).
 */
export function apportion(total, weights) {
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const W = w.reduce((s, x) => s + x, 0);
  const out = w.map(() => 0);
  if (!(total > 0) || !(W > 0) || !Number.isFinite(W)) return out;
  const raw = w.map((x) => (total * x) / W);
  let used = 0;
  raw.forEach((r, i) => { out[i] = Math.floor(r + 1e-9); used += out[i]; });
  let rest = total - used;
  if (rest < 0) { // proteção contra erro de ponto flutuante: devolve o excesso de quem passou mais
    const over = raw.map((r, i) => ({ i, d: out[i] - r })).filter((x) => out[x.i] > 0).sort((a, b) => (b.d - a.d) || (b.i - a.i));
    for (let k = 0; rest < 0 && over.length; k = (k + 1) % over.length) { if (out[over[k].i] > 0) { out[over[k].i] -= 1; rest += 1; } }
  }
  const order = raw.map((r, i) => ({ i, frac: r - out[i] })).filter((x) => w[x.i] > 0)
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  for (let k = 0; rest > 0 && order.length > 0; k = (k + 1) % order.length) { out[order[k].i] += 1; rest -= 1; }
  return out;
}

/**
 * Parte de `budget` para cada item, proporcional ao déficit e nunca acima dele (ao centavo).
 * Se o orçamento for maior ou igual à soma dos déficits, cada um recebe o seu déficit — e os
 * centavos fecham exatamente (nenhum centavo se perde por arredondar todos para baixo).
 */
function cappedShares(budget, deficits) {
  const D = deficits.reduce((s, d) => s + (d > 0 ? d : 0), 0);
  if (!(D > 0) || !(budget > 0)) return deficits.map(() => 0);
  return apportion(Math.min(budget, Math.round(D)), deficits);
}

/**
 * Distribui a sobra em lotes inteiros (modo lote). Resultado idêntico a comprar UM lote por vez,
 * sempre para quem tem a maior parte ainda não gasta (empate: quem está mais longe do alvo, depois
 * a ordem da lista), só enquanto o ativo está abaixo do alvo e o lote cabe no que sobrou — mas
 * calculado por "nível" (busca binária), então funciona com milhões de lotes sem limite artificial.
 *
 * entries[k] = { u: parte não gasta (centavos, pode ser negativa), rem: quanto falta para o alvo
 *   (centavos), idx: posição na lista, lotExact: custo exato de um lote em centavos (≥ 1),
 *   extra: (j) => custo inteiro (centavos) de j lotes a mais — crescente }
 * @returns {{ lots: number[], left: number }}
 */
export function fillLots(entries, left) {
  const xs = entries.map((e) => {
    let cap = 0; // quantas compras são permitidas: a compra j só acontece se rem − extra(j) ≥ 1
    if (e.rem >= 1) {
      cap = Math.max(1, Math.floor((e.rem - 1) / e.lotExact + 1e-9) + 1);
      while (cap > 0 && e.extra(cap - 1) > e.rem - 1) cap--;
      while (e.extra(cap) <= e.rem - 1) cap++;
    }
    return { e, n: 0, cap };
  });
  const level = (x, j) => x.e.u - x.e.extra(j); // parte não gasta antes da compra j
  const nAbove = (x, th) => {                    // nº de compras com nível > th (até o teto)
    const D = x.e.u - th;                        // compra j tem nível > th ⇔ extra(j) < D
    if (D <= 0) return 0;
    let n = Math.max(0, Math.ceil(D / x.e.lotExact - 1e-9));
    while (n > 0 && x.e.extra(n - 1) >= D) n--;
    while (x.e.extra(n) < D) n++;
    return Math.min(n, x.cap);
  };
  const limit = entries.length * 3 + 10; // cada volta tira ao menos um ativo da disputa
  for (let guard = 0; ; guard++) {
    if (guard > limit) throw new Error('Motor: a distribuição da sobra não fechou. Cálculo cancelado por segurança.');
    const E = xs.filter((x) => x.n < x.cap && x.e.extra(x.n + 1) - x.e.extra(x.n) <= left);
    if (!E.length) break;
    const addCost = (th) => E.reduce((s, x) => s + (x.e.extra(Math.max(x.n, nAbove(x, th))) - x.e.extra(x.n)), 0);
    const top = Math.max(...E.map((x) => level(x, x.n)));
    const bottom = Math.min(...E.map((x) => level(x, x.cap - 1))) - 1;
    let th;
    if (addCost(bottom) <= left) th = bottom; // cabe tudo até o alvo de cada um
    else {
      let lo = bottom, hi = top;              // lo: não cabe · hi: cabe (custo zero)
      while (hi - lo > 1) { const mid = lo + Math.floor((hi - lo) / 2); if (addCost(mid) <= left) hi = mid; else lo = mid; }
      th = hi;
    }
    E.forEach((x) => { const n2 = Math.max(x.n, nAbove(x, th)); left -= x.e.extra(n2) - x.e.extra(x.n); x.n = n2; });
    // empatados exatamente no nível th: um lote para cada, na ordem do critério, enquanto couber
    const ties = E.filter((x) => x.n < x.cap && level(x, x.n) === th)
      .sort((a, b) => ((b.e.rem - b.e.extra(b.n)) - (a.e.rem - a.e.extra(a.n))) || (a.e.idx - b.e.idx));
    for (const x of ties) {
      const inc = x.e.extra(x.n + 1) - x.e.extra(x.n);
      if (inc <= left) { x.n += 1; left -= inc; }
    }
  }
  return { lots: xs.map((x) => x.n), left };
}

/** 100 = carteira exatamente no plano; cai conforme as classes se afastam do % ideal. */
export function alignmentScore(rows) {
  const dev = rows.reduce((s, r) => s + Math.abs(r.idealPct - r.currentPct), 0);
  return Math.max(0, Math.min(100, 100 - dev / 2));
}

/** Validação da carteira antes de calcular. Retorna lista de erros (vazia = pode calcular). */
export function validateForPlan(state, market) {
  const errors = [];
  const fx = { auto: market?.fx?.auto || {}, manual: state.settings?.fxManual || {} };
  const quotes = market?.quotes || {};
  const classes = state.classes || [];
  if (classes.length === 0) errors.push({ code: 'sem_classes', msg: 'Cadastre pelo menos uma classe em Configuração.' });
  const sumC = sumIdeal(classes);
  if (classes.length && !isHundred(sumC)) {
    errors.push({ code: 'soma_classes', msg: `A soma dos percentuais das classes está em ${fmtPctTxt(sumC)}%, não 100%. Ajuste em Configuração.` });
  }
  const cashes = classes.filter((c) => c.isCash);
  if (cashes.length === 0) {
    errors.push({ code: 'sem_caixa', msg: 'Nenhuma classe está marcada como Caixa de Oportunidade. Marque uma em Configuração — é para lá que vão as sobras.' });
  } else if (cashes.length > 1) {
    errors.push({ code: 'caixa_duplo', msg: 'Mais de uma classe está marcada como Caixa. Deixe só uma em Configuração.' });
  } else if (hasAssets(cashes[0])) {
    errors.push({ code: 'caixa_com_ativos', msg: `O Caixa ("${cashes[0].name}") precisa ser do tipo "Valor direto".` });
  } else if (classCurrency(cashes[0]) !== 'BRL') {
    errors.push({ code: 'caixa_moeda', msg: `O Caixa ("${cashes[0].name}") precisa estar em R$.` });
  }
  const ids = new Set();
  classes.forEach((c) => {
    if (hasAssets(c) && buyMode(c) !== 'valor') {
      const semValor = (c.assets || []).filter((a) => num(a.qty) > 0 && !(assetPrice(c, a, quotes).price > 0) && !(num(a.currentValue) > 0))
        .map((a) => normTicker(a.ticker) || '(sem ticker)');
      if (semValor.length) errors.push({ code: 'posicao_sem_preco', classId: c.id, tickers: semValor,
        msg: `${c.name}: ${semValor.join(', ')} ${semValor.length === 1 ? 'tem cotas, mas nenhum preço conhecido' : 'têm cotas, mas nenhum preço conhecido'} — o valor da carteira ficaria errado e o cálculo também. Atualize as cotações ou digite o preço em Ativos.` });
    }
    if (ids.has(c.id)) errors.push({ code: 'id_duplicado', classId: c.id, msg: `Há duas classes com o mesmo identificador ("${c.name}"). Recarregue a página para o app corrigir.` });
    ids.add(c.id);
    const aids = new Set();
    (c.assets || []).forEach((a) => {
      if (aids.has(a.id)) errors.push({ code: 'id_duplicado', classId: c.id, msg: `Há dois ativos com o mesmo identificador em "${c.name}". Recarregue a página para o app corrigir.` });
      aids.add(a.id);
    });
    const ideal = num(c.idealPct);
    if (hasAssets(c) && ideal > 0) {
      const assets = c.assets || [];
      if (assets.length === 0) {
        errors.push({ code: 'classe_vazia', classId: c.id, msg: `A classe "${c.name}" tem ${fmtPctTxt(ideal)}% do plano, mas nenhum ativo cadastrado.` });
      } else {
        const s = sumIdeal(assets);
        if (!isHundred(s)) errors.push({ code: 'soma_ativos', classId: c.id, msg: `Os ativos de "${c.name}" somam ${fmtPctTxt(s)}% — precisam somar 100%. Ajuste em Ativos.` });
      }
    }
    const cur = classCurrency(c);
    if (cur !== 'BRL' && fxRate(cur, fx) === null && (ideal > 0 || classValueNative(c, quotes) > 0)) {
      errors.push({ code: 'sem_cambio', classId: c.id, msg: `Sem cotação de ${cur} para a classe "${c.name}". Aguarde a atualização automática ou informe o câmbio em Configuração.` });
    }
  });
  return errors;
}

/** Planeja a compra de uma classe com ativos. Valores em centavos. */
function planClass(c, budgetBRL, rate, quotes) {
  const mode = buyMode(c);
  // orçamento na moeda da classe (centavos), nunca acima do disponível
  const budget = rate === 1 ? budgetBRL : Math.floor(budgetBRL / rate + 1e-9);
  const items = (c.assets || []).map((a, idx) => {
    const p = assetPrice(c, a, quotes);
    const minQty = mode === 'lote' ? Math.max(1, Math.round(num(a.minQty)) || 1) : 1;
    return {
      a, idx, mode,
      ideal: num(a.idealPct),
      v: toCents(assetValue(c, a, quotes)),
      price: p.price, priceSource: p.source, minQty,
      lotCost: mode === 'lote' && p.price > 0 ? costCents(p.price, minQty) : 0,
      minAmount: mode === 'lote' ? 0 : Math.max(MIN_ORDER_CENTS, toCents(a.minAmount || 0)),
      share: 0, value: 0, qty: 0, status: 'ok', complemento: false,
    };
  });
  const Vc = items.reduce((s, it) => s + it.v, 0);
  const Nc = Vc + budget;
  items.forEach((it) => { it.target = (it.ideal / 100) * Nc; it.deficit = Math.max(0, it.target - it.v); });
  const maxDef = Math.max(0, ...items.map((it) => it.deficit));
  items.forEach((it) => {
    it.priority = it.deficit > 0 && maxDef > 0 ? Math.max(1, Math.round((100 * it.deficit) / maxDef)) : 0;
    it.currentPct = Vc > 0 ? (it.v / Vc) * 100 : 0;
    if (it.deficit < 0.5) it.status = 'na_meta';
    else if (mode !== 'valor' && !(it.price > 0)) it.status = 'sem_preco';
    else if (mode === 'lote' && it.price * 100 * it.minQty < 1) it.status = 'preco_invalido'; // lote abaixo de 1 centavo
  });

  const active = () => items.filter((it) => it.status === 'ok');

  if (mode === 'lote') {
    // 1) parte proporcional de cada ativo e compra das cotas inteiras que cabem nela
    const act = active();
    const shares = cappedShares(budget, act.map((it) => it.deficit));
    act.forEach((it, k) => {
      it.share = shares[k];
      const lotExact = it.price * 100 * it.minQty;
      let lots = Math.max(0, Math.floor(it.share / lotExact + 1e-9));
      while (lots > 0 && costCents(it.price, lots * it.minQty) > it.share) lots--;
      while (costCents(it.price, (lots + 1) * it.minQty) <= it.share) lots++;
      it.qty = lots * it.minQty;
      it.value = costCents(it.price, it.qty);
    });
    // 2) sobra: mais cotas de quem AINDA está abaixo do alvo (ver fillLots). O que não paga
    //    nenhuma cota vai para o Caixa.
    const left = budget - items.reduce((s, it) => s + it.value, 0);
    const res = fillLots(act.map((it) => ({
      u: it.share - it.value, rem: it.target - it.v - it.value, idx: it.idx,
      lotExact: it.price * 100 * it.minQty,
      extra: (j) => costCents(it.price, it.qty + j * it.minQty) - it.value,
    })), left);
    act.forEach((it, k) => {
      const n = res.lots[k];
      if (n > 0) {
        if (it.share < it.lotCost) it.complemento = true; // a parte dele não pagava uma cota: veio da sobra
        it.qty += n * it.minQty;
        it.value = costCents(it.price, it.qty);
      }
    });
    items.forEach((it) => { if (it.status === 'ok' && it.value === 0) it.status = 'lote_caro'; });
  } else {
    // fração / valor: valor exato, com mínimo por compra. Quem não alcança o mínimo sai — UM de cada
    // vez (o mais longe do mínimo) — e a parte dele vai para os demais antes de excluir mais alguém.
    // Se no fim sobrar dinheiro (os outros já chegaram ao alvo), quem saiu é reavaliado só com a sobra.
    const excludedEver = new Set();
    let pool = active();
    let budgetLeft = budget;
    for (let pass = 0; pool.length && budgetLeft > 0 && pass <= items.length; pass++) {
      const excluded = [];
      // quem não alcança o mínimo nem com todo o dinheiro que resta (ou sem passar do alvo) sai antes
      const hopeless = pool.filter((it) => Math.min(budgetLeft, Math.round(it.deficit)) < it.minAmount);
      hopeless.forEach((it) => { it.share = 0; excluded.push(it); excludedEver.add(it); });
      pool = pool.filter((it) => !hopeless.includes(it));
      for (;;) {
        const shares = cappedShares(budgetLeft, pool.map((it) => it.deficit));
        pool.forEach((it, k) => { it.share = shares[k]; });
        const below = pool.filter((it) => it.share > 0 && it.share < it.minAmount);
        if (!below.length) break;
        below.sort((x, y) => (x.share / x.minAmount - y.share / y.minAmount) || (x.deficit - y.deficit) || (y.idx - x.idx));
        const out = below[0];
        out.share = 0; excluded.push(out); excludedEver.add(out);
        pool = pool.filter((it) => it !== out);
      }
      pool.forEach((it) => {
        it.value = it.share;
        it.qty = mode === 'fracao' && it.price > 0 ? it.value / 100 / it.price : 0;
      });
      const spentNow = pool.reduce((s, it) => s + it.value, 0);
      if (spentNow === 0) break;
      budgetLeft -= spentNow;
      pool = excluded; // próxima volta: só quem saiu, só com o que sobrou
    }
    items.forEach((it) => { if (excludedEver.has(it) && it.value === 0) { it.status = 'abaixo_minimo'; it.share = 0; it.qty = 0; } });
  }

  const investedNative = items.reduce((s, it) => s + it.value, 0);
  if (investedNative > budget) throw new Error('Motor: compra acima do orçamento da classe ' + c.name);
  const investedBRL = rate === 1 ? investedNative : Math.min(budgetBRL, Math.round(investedNative * rate));
  return { mode, budgetNative: budget, items, investedNative, investedBRL, leftoverBRL: budgetBRL - investedBRL, currentNative: Vc };
}

/**
 * Monta a ordem de compra.
 * @param {object} state  carteira já migrada (model.migrateState)
 * @param {number} aporteReais valor disponível, em R$
 * @param {{quotes?:object, fx?:{auto?:{USD?:number,EUR?:number}}}} market cotações e câmbio automáticos
 */
export function planAporte(state, aporteReais, market = {}) {
  market = market || {};
  const quotes = market.quotes || {};
  const fx = { auto: market.fx?.auto || {}, manual: state.settings?.fxManual || {} };
  const A = toCents(aporteReais);
  const errors = A > 0 ? [] : [{ code: 'aporte', msg: 'Informe um valor de aporte maior que zero.' }];
  errors.push(...validateForPlan(state, market));
  if (errors.length) return { ok: false, errors, warnings: [] };

  const warnings = [];
  const cash = state.classes.find((c) => c.isCash);
  const rows = state.classes.map((c, idx) => {
    const cur = classCurrency(c);
    const rate = fxRate(cur, fx) ?? 1; // só chega aqui sem cotação se a classe não tem valor nem %
    const native = classValueNative(c, quotes);
    return { c, idx, cur, rate, ideal: num(c.idealPct), vBRL: toCents(native * rate), nativeCents: toCents(native) };
  });
  const T = rows.reduce((s, r) => s + r.vBRL, 0);
  const N = T + A;
  rows.forEach((r) => { r.target = (r.ideal / 100) * N; r.deficit = Math.max(0, r.target - r.vBRL); });
  const allocs = apportion(A, rows.map((r) => r.deficit));
  if (allocs.reduce((s, x) => s + x, 0) !== A) { // impossível com as validações acima; proteção extra
    allocs.fill(0); allocs[rows.findIndex((r) => r.c.isCash)] = A;
  }

  let toCash = 0;
  const classResults = rows.map((r, k) => {
    const alloc = allocs[k];
    const res = { classId: r.c.id, name: r.c.name, type: classType(r.c), currency: r.cur, rate: r.rate, idealPct: r.ideal,
      currentBRL: r.vBRL, currentPct: T > 0 ? (r.vBRL / T) * 100 : 0, allocBRL: alloc, investedBRL: 0, directBRL: 0, directNative: 0,
      leftoverBRL: 0, mode: buyMode(r.c), items: [], isCash: !!r.c.isCash };
    if (alloc <= 0) return res;
    if (!hasAssets(r.c)) {
      const nat = r.rate === 1 ? alloc : Math.floor(alloc / r.rate + 1e-9);
      const brlEq = r.rate === 1 ? nat : Math.min(alloc, Math.round(nat * r.rate));
      res.directNative = nat; res.directBRL = brlEq; res.leftoverBRL = alloc - brlEq;
    } else {
      const pc = planClass(r.c, alloc, r.rate, quotes);
      res.items = pc.items; res.investedBRL = pc.investedBRL; res.leftoverBRL = pc.leftoverBRL; res.budgetNative = pc.budgetNative;
      res.investedNative = pc.investedNative;
      // valor em R$ de cada compra, distribuído para fechar exatamente com o total da classe
      const brlParts = r.rate === 1 ? pc.items.map((it) => it.value) : apportion(pc.investedBRL, pc.items.map((it) => it.value));
      pc.items.forEach((it, j) => { it.valueBRL = brlParts[j] || 0; });
      const semPreco = pc.items.filter((it) => it.status === 'sem_preco').map((it) => normTicker(it.a.ticker) || '(sem ticker)');
      if (semPreco.length) warnings.push({ code: 'sem_preco', classId: r.c.id, tickers: semPreco,
        msg: `${r.c.name}: ${semPreco.length === 1 ? 'ficou fora por estar sem preço' : 'ficaram fora por estarem sem preço'} — ${semPreco.join(', ')}. Atualize as cotações ou digite o preço em Ativos.` });
      const invalido = pc.items.filter((it) => it.status === 'preco_invalido').map((it) => normTicker(it.a.ticker));
      if (invalido.length) warnings.push({ code: 'preco_invalido', classId: r.c.id, tickers: invalido,
        msg: `${r.c.name}: ${invalido.join(', ')} — o lote custa menos de 1 centavo e ficou fora. Confira o preço ou ative a compra fracionada desta classe.` });
      const abaixo = pc.items.filter((it) => it.status === 'abaixo_minimo').map((it) => normTicker(it.a.ticker));
      if (abaixo.length) warnings.push({ code: 'abaixo_minimo', classId: r.c.id, tickers: abaixo,
        msg: `${r.c.name}: a parte de ${abaixo.join(', ')} ficou abaixo do mínimo de compra e foi para os outros ativos (ou para o Caixa).` });
      if (pc.leftoverBRL >= Math.max(1000, Math.round(alloc * 0.05))) { // sobras pequenas são normais com cotas inteiras
        warnings.push({ code: 'sobra_classe', classId: r.c.id,
          msg: `${brl(pc.leftoverBRL)} da parte de "${r.c.name}" foi para o Caixa (${pc.mode === 'lote' ? 'as cotas que faltam custam mais que a sobra' : 'os ativos já chegaram ao alvo ou ficaram abaixo do mínimo'}).` });
      }
    }
    toCash += res.leftoverBRL;
    return res;
  });

  const investedBRL = classResults.reduce((s, r) => s + r.investedBRL, 0);
  const directBRL = classResults.reduce((s, r) => s + r.directBRL, 0);
  if (investedBRL + directBRL + toCash !== A) {
    throw new Error(`Motor: conta não fecha (${investedBRL}+${directBRL}+${toCash}≠${A}). Cálculo cancelado por segurança.`);
  }

  const orders = [];
  classResults.forEach((r) => r.items.forEach((it) => {
    if (it.value > 0) {
      orders.push({ classId: r.classId, className: r.name, classType: r.type, assetId: it.a.id, ticker: normTicker(it.a.ticker), mode: it.mode,
        qty: it.qty, price: it.price, priceSource: it.priceSource, currency: r.currency, valueNative: it.value,
        valueBRL: it.valueBRL, priority: it.priority, complemento: it.complemento });
    }
  }));
  orders.sort((x, y) => (y.priority - x.priority) || (y.valueBRL - x.valueBRL) || x.ticker.localeCompare(y.ticker));

  // alinhamento: só faz sentido se já existe patrimônio (carteira vazia não tem "antes")
  const before = T > 0 ? alignmentScore(classResults.map((r) => ({ idealPct: r.idealPct, currentPct: r.currentPct }))) : null;
  const afterVals = classResults.map((r) => r.currentBRL + r.investedBRL + r.directBRL + (r.isCash ? toCash : 0));
  const after = alignmentScore(classResults.map((r, k) => ({ idealPct: r.idealPct, currentPct: N > 0 ? (afterVals[k] / N) * 100 : 0 })));
  const cashRow = classResults.find((r) => r.isCash);
  if (before !== null && after < before - 2) {
    warnings.push({ code: 'alinhamento', msg: `Com estes preços, a compra deixa a carteira menos alinhada ao plano (${fmtPctTxt(Math.round(before * 10) / 10)}% → ${fmtPctTxt(Math.round(after * 10) / 10)}%). Normalmente é falta de preço em algum ativo — confira antes de registrar.` });
  }

  return {
    ok: true, errors: [], warnings, sig: stateSignature(state, market),
    aporte: A, totalBefore: T, totalAfter: N,
    investedBRL, directBRL, toCash, cashDirect: cashRow ? cashRow.directBRL : 0, cashClassId: cash.id,
    classes: classResults, orders, before, after,
  };
}

/**
 * "Impressão digital" de tudo que influencia o cálculo: classes, ativos, preços efetivos e câmbio.
 * Se mudar entre calcular e registrar, o registro é recusado (a ordem estaria velha).
 */
export function stateSignature(state, market = {}) {
  market = market || {};
  const quotes = market.quotes || {};
  const fx = { auto: market.fx?.auto || {}, manual: state.settings?.fxManual || {} };
  return JSON.stringify(state.classes.map((c) => [c.id, classType(c), num(c.idealPct), !!c.isCash, classCurrency(c), buyMode(c),
    fxRate(classCurrency(c), fx), toCents(classValueNative(c, quotes)),
    (c.assets || []).map((a) => [a.id, normTicker(a.ticker), num(a.idealPct), num(a.qty), toCents(assetValue(c, a, quotes)),
      assetPrice(c, a, quotes).price, num(a.minQty), num(a.minAmount)])]));
}

/**
 * Registra o aporte planejado: devolve uma NOVA carteira (a original não é alterada) e o registro.
 * Travas: recusa se a carteira/cotações mudaram desde o cálculo, e confere no fim que o patrimônio
 * subiu exatamente o valor do aporte — senão nada é registrado.
 */
export function applyPlan(state, plan, market = {}, opts = {}) {
  market = market || {}; opts = opts || {};
  if (!plan || !plan.ok) throw new Error('Plano inválido.');
  if (plan.sig !== stateSignature(state, market)) {
    throw new Error('A carteira ou as cotações mudaram depois do cálculo. Calcule de novo antes de registrar.');
  }
  const quotes = market.quotes || {};
  const fx = { auto: market.fx?.auto || {}, manual: state.settings?.fxManual || {} };
  const s = JSON.parse(JSON.stringify(state));
  const date = opts.date || todayISO();
  const totalBefore = portfolioBRL(s, quotes, fx);
  const compras = [];
  const deltas = []; // o que foi somado, para poder desfazer só este aporte
  const addValue = (c, a, cents, label) => {
    const target = a || c;
    target.currentValue = Math.round(num(target.currentValue) * 100 + cents) / 100;
    deltas.push({ classId: c.id, assetId: a ? a.id : null, field: 'currentValue', amount: cents / 100, currency: classCurrency(c), label });
  };
  const one = (list, id, what) => {
    const found = list.filter((x) => x.id === id);
    if (found.length !== 1) throw new Error(found.length ? `${what} aparece duplicado na carteira. Recarregue a página.` : `${what} não existe mais. Calcule de novo.`);
    return found[0];
  };
  plan.classes.forEach((r) => {
    const c = one(s.classes, r.classId, `A classe "${r.name}"`);
    if (!hasAssets(c)) {
      if (r.items.some((it) => it.value > 0)) throw new Error(`A classe "${r.name}" mudou de tipo. Calcule de novo.`);
      if (r.directNative > 0) addValue(c, null, r.directNative, c.name);
      return;
    }
    r.items.forEach((it) => {
      if (!(it.value > 0)) return;
      const a = one(c.assets || [], it.a.id, `O ativo ${normTicker(it.a.ticker)}`);
      const mode = buyMode(c);
      if (mode !== it.mode) throw new Error(`A classe "${r.name}" mudou o jeito de comprar. Calcule de novo.`);
      if (mode === 'valor') addValue(c, a, it.value, normTicker(a.ticker));
      else {
        const qtyMode = isAutoValued(c, a, quotes) || (num(a.qty) <= 0 && toCents(a.currentValue) === 0);
        if (qtyMode) {
          a.qty = num(a.qty) + it.qty; // soma exata: nunca arredonda o que a pessoa já tinha
          deltas.push({ classId: c.id, assetId: a.id, field: 'qty', amount: it.qty, value: it.value / 100, currency: r.currency, label: normTicker(a.ticker),
            ...(num(a.qtyEpoch) > 0 ? { epoch: num(a.qtyEpoch) } : {}) });
          if (it.priceSource === 'auto' && it.price > 0) a.lastQuotePrice = it.price; // garante valor mesmo se a cotação sumir
          if (!(num(a.price) > 0) && it.price > 0 && it.priceSource !== 'auto') a.price = it.price;
        } else addValue(c, a, it.value, normTicker(a.ticker));
      }
      compras.push({ classId: c.id, ticker: normTicker(a.ticker), qty: it.qty, price: it.price, valor: it.value / 100,
        valorBRL: (it.valueBRL ?? it.value) / 100, currency: r.currency, modo: mode });
    });
  });
  const cashes = s.classes.filter((c) => c.isCash);
  if (cashes.length !== 1 || hasAssets(cashes[0])) throw new Error('O Caixa de Oportunidade mudou. Calcule de novo.');
  const cash = cashes[0];
  if (plan.toCash > 0) addValue(cash, null, plan.toCash, cash.name + ' (sobras)');

  const totalAfter = portfolioBRL(s, quotes, fx);
  // trava final: o patrimônio precisa subir o valor do aporte. Tolerância só para o arredondamento
  // de cada ativo ao centavo (1 centavo por compra, convertido pelo câmbio).
  // (mais o erro de ponto flutuante de somar patrimônios gigantes)
  let tol = 0.011 + 1e-12 * Math.max(Math.abs(totalBefore), Math.abs(totalAfter));
  plan.orders.forEach((o) => { const r = o.currency === 'BRL' ? 1 : (fxRate(o.currency, fx) || 1); tol += 0.011 * r + (r !== 1 ? 0.006 : 0); });
  plan.classes.forEach((r) => { if (r.directNative > 0 && r.currency !== 'BRL') tol += 0.006; });
  if (!(Math.abs(totalAfter - totalBefore - plan.aporte / 100) <= tol + 1e-9)) {
    throw new Error(`Conferência falhou: o patrimônio subiria ${brl(Math.round((totalAfter - totalBefore) * 100))} em vez de ${brl(plan.aporte)}. Nada foi registrado — calcule de novo.`);
  }

  const obs = String(opts.obs || '').slice(0, 300);
  const id = uid();
  const caixaTotal = plan.toCash + (plan.cashDirect || 0);
  const record = {
    id, date, disponivel: plan.aporte / 100, investido: plan.investedBRL / 100, direto: plan.directBRL / 100,
    sobra: plan.toCash / 100, caixa: caixaTotal / 100, caixaPlano: (plan.cashDirect || 0) / 100,
    compras, observacao: obs, patrimonioAntes: totalBefore, patrimonioDepois: totalAfter,
    deltas, prevLastAporteDate: state.agenda?.lastAporteDate ?? null,
  };
  s.aportes = [...(s.aportes || []), record];
  s.agenda = { ...(s.agenda || {}), lastAporteDate: date };
  const comprasTxt = compras.filter((x) => x.modo !== 'valor').map((x) => (x.modo === 'lote' ? x.qty + 'x ' : '') + x.ticker).join(', ');
  const aplicTxt = compras.filter((x) => x.modo === 'valor').map((x) => x.ticker).join(', ');
  const caixaTxt = `Caixa: +${brl(caixaTotal)}${plan.cashDirect && plan.toCash ? ` (${brl(plan.cashDirect)} do plano + ${brl(plan.toCash)} de sobras)` : ''}`;
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  // o detalhe completo fica em aportes[].compras; aqui um resumo de até 600 caracteres
  const detail = clip([comprasTxt && clip('Comprado: ' + comprasTxt, 360), aplicTxt && clip('Aplicado em: ' + aplicTxt, 120), caixaTxt]
    .filter(Boolean).join('. ') + (obs ? ' — ' + obs : ''), 600);
  s.timeline = [...(s.timeline || []), { id: uid(), aporteId: id, date, type: 'aporte', title: 'Aporte de ' + brl(plan.aporte), detail }];
  [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2000000, 5000000].forEach((m) => {
    if (totalBefore < m && totalAfter >= m) s.timeline.push({ id: uid(), aporteId: id, date, type: 'marco', title: 'Carteira atingiu R$ ' + m.toLocaleString('pt-BR'), detail: '' });
  });
  return { state: s, record };
}

/**
 * Desfaz SÓ um aporte: tira da carteira exatamente o que ele somou (cotas e valores), apaga o registro
 * e as entradas dele no histórico. Alterações feitas depois (proventos, outras edições) continuam.
 * Se depois do aporte a classe mudou de tipo (cotas ↔ valor, R$ ↔ US$), tira o VALOR que o aporte
 * somou, convertido pelo câmbio quando preciso; o que não der para tirar com segurança volta em `manual`.
 * @returns {{state, record, missing: string[], clamped: string[], manual: {label:string, amount:number, currency:string}[]}}
 *   missing = itens que não existem mais; clamped = itens que já tinham menos do que o aporte somou
 *   (ficaram em zero); manual = o que a pessoa precisa conferir à mão.
 */
export function revertAporte(state, aporteId, market = {}) {
  market = market || {};
  const fx = { auto: market.fx?.auto || {}, manual: state.settings?.fxManual || {} };
  const s = JSON.parse(JSON.stringify(state));
  const rec = (s.aportes || []).find((a) => a.id === aporteId);
  if (!rec) throw new Error('Aporte não encontrado.');
  if (!Array.isArray(rec.deltas)) throw new Error('Este aporte é de uma versão antiga e não pode ser desfeito automaticamente.');
  const missing = [];
  const clamped = [];
  const manual = [];
  const convert = (amount, from, to) => {
    if (!from || from === to) return amount;
    const a = fxRate(from, fx), b = fxRate(to, fx);
    return a && b ? Math.round((amount * a / b) * 100) / 100 : null;
  };
  rec.deltas.forEach((d) => {
    const c = s.classes.find((x) => x.id === d.classId);
    const asset = c && d.assetId ? (c.assets || []).find((a) => a.id === d.assetId) : null;
    const label = d.label || d.assetId || d.classId;
    if (!c || (d.assetId && !asset)) { missing.push(label); return; }
    const cur = classCurrency(c);
    // cotas compradas antes de uma troca de ticker com conversão (ex.: 10 BCFF11 → 8 BTHF11):
    // tirar a mesma quantidade agora seria errado — a pessoa confere à mão
    if (d.field === 'qty' && asset && (num(asset.qtyEpoch) || 0) !== (num(d.epoch) || 0)) {
      manual.push({ label, amount: d.value == null ? 0 : num(d.value), currency: d.currency || cur, qty: num(d.amount), swapped: true });
      return;
    }
    const qtyBased = !!asset && buyMode(c) !== 'valor' && num(asset.qty) > 0; // valor vem de cotas × preço
    if (d.field === 'qty' && qtyBased) {
      const q = num(asset.qty) - num(d.amount);
      if (q < -1e-9) clamped.push(label);
      asset.qty = Math.abs(q) < 1e-9 || q < 0 ? 0 : q;
      return;
    }
    // tirar em dinheiro: o valor pago (compra por cotas) ou o valor aplicado
    const amount = d.field === 'qty' ? (d.value == null ? null : num(d.value)) : num(d.amount);
    const v = amount === null ? null : convert(amount, d.currency || cur, cur);
    const target = asset || c;
    const valueBased = asset ? (buyMode(c) === 'valor' || !(num(asset.qty) > 0)) : !hasAssets(c);
    if (v === null || !valueBased) { manual.push({ label, amount: amount ?? 0, currency: d.currency || cur }); return; }
    const nv = Math.round((num(target.currentValue) - v) * 100) / 100;
    if (nv < 0) clamped.push(label);
    target.currentValue = Math.max(0, nv);
  });
  s.aportes = s.aportes.filter((a) => a.id !== aporteId);
  s.timeline = (s.timeline || []).filter((t) => t.aporteId !== aporteId);
  if (s.agenda && s.agenda.lastAporteDate === rec.date) {
    // a data do último aporte volta a ser a do aporte mais recente que ainda existe (ou a de antes, se for anterior)
    const remaining = s.aportes.map((a) => a.date).filter(Boolean).sort();
    const before = rec.prevLastAporteDate && rec.prevLastAporteDate < rec.date ? rec.prevLastAporteDate : null;
    s.agenda.lastAporteDate = remaining.length ? remaining[remaining.length - 1] : before;
  }
  return { state: s, record: rec, missing, clamped, manual };
}

function portfolioBRL(s, quotes, fx) {
  return s.classes.reduce((sum, c) => {
    const r = fxRate(classCurrency(c), fx);
    return sum + classValueNative(c, quotes) * (r ?? 0);
  }, 0);
}
