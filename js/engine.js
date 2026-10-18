// =====================================================================
// Aporte+ — motor de cálculo do aporte (puro: sem DOM, sem rede).
//
// Regras (em ordem):
//  1. Validação: classes somam 100%, ativos de cada classe com peso somam 100%,
//     existe um Caixa, toda moeda estrangeira em uso tem cotação.
//  2. Entre classes: cada classe tem um alvo = % ideal × (patrimônio + aporte).
//     O aporte é dividido proporcionalmente à distância de cada classe até o alvo.
//  3. Dentro da classe, o mesmo critério entre os ativos (nunca passando do alvo do ativo).
//     - lote:   compra cotas inteiras; a sobra compra mais cotas de quem ainda está abaixo
//               do alvo (no máximo uma cota além do alvo por ativo).
//     - fracao: compra o valor exato (cripto, exterior).
//     - valor:  aplica o valor em R$ (renda fixa).
//  4. Tudo que não puder ser investido vai para o Caixa de Oportunidade.
//
// Todas as contas internas são em CENTAVOS inteiros, e o motor confere no fim que
// investido + direto + caixa = aporte, ao centavo. Se não fechar, ele se recusa a responder.
// =====================================================================
import {
  classType, classCurrency, buyMode, hasAssets, assetPrice, assetValue, isAutoValued,
  classValueNative, fxRate, sumIdeal, isHundred, normTicker, toCents, todayISO, uid,
} from './model.js';

function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; }
function fmtPctTxt(v) { return (Math.round(v * 100) / 100).toString().replace('.', ','); }
function brl(cents) { return 'R$ ' + (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

/**
 * Divide `total` centavos em partes inteiras proporcionais a `weights`
 * (método do maior resto). A soma das partes é exatamente `total` (se houver peso > 0).
 */
export function apportion(total, weights) {
  const W = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
  const out = weights.map(() => 0);
  if (!(total > 0) || !(W > 0)) return out;
  const raw = weights.map((w) => (w > 0 ? (total * w) / W : 0));
  let used = 0;
  raw.forEach((r, i) => { out[i] = Math.floor(r + 1e-9); used += out[i]; });
  let rest = total - used;
  const order = raw.map((r, i) => ({ i, frac: r - out[i] })).filter((x) => weights[x.i] > 0)
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  for (let k = 0; rest > 0 && order.length > 0; k = (k + 1) % order.length) { out[order[k].i] += 1; rest -= 1; }
  return out;
}

/**
 * Parte de `budget` para cada item, proporcional ao déficit e nunca acima dele.
 * Se o orçamento for maior que a soma dos déficits, cada um recebe só o seu déficit.
 */
function cappedShares(budget, deficits) {
  const D = deficits.reduce((s, d) => s + (d > 0 ? d : 0), 0);
  if (D <= 0 || budget <= 0) return deficits.map(() => 0);
  if (budget >= D) return deficits.map((d) => (d > 0 ? Math.floor(d + 1e-9) : 0));
  return apportion(budget, deficits);
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
  } else if (hasAssets(cashes[0])) {
    errors.push({ code: 'caixa_com_ativos', msg: `O Caixa ("${cashes[0].name}") precisa ser do tipo "Valor direto".` });
  } else if (classCurrency(cashes[0]) !== 'BRL') {
    errors.push({ code: 'caixa_moeda', msg: `O Caixa ("${cashes[0].name}") precisa estar em R$.` });
  }
  classes.forEach((c) => {
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
    const minQty = Math.max(1, Math.round(num(a.minQty)) || 1);
    const priceCents = mode === 'lote' ? toCents(p.price) : 0;
    return {
      a, idx, mode,
      ideal: num(a.idealPct),
      v: toCents(assetValue(c, a, quotes)),
      price: p.price, priceSource: p.source, priceCents, minQty,
      lotCost: mode === 'lote' ? priceCents * minQty : 0,
      minAmount: mode === 'lote' ? 0 : Math.max(0, toCents(a.minAmount || 0)),
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
  });

  const active = () => items.filter((it) => it.status === 'ok');

  if (mode === 'lote') {
    // 1) parte proporcional de cada ativo e compra das cotas inteiras que cabem nela
    const act = active();
    const shares = cappedShares(budget, act.map((it) => it.deficit));
    act.forEach((it, k) => {
      it.share = shares[k];
      const lots = it.lotCost > 0 ? Math.floor(it.share / it.lotCost) : 0;
      it.qty = lots * it.minQty;
      it.value = lots * it.lotCost;
    });
    // 2) sobra: mais cotas dos ativos que AINDA estão abaixo do alvo, começando por quem ficou
    //    mais longe da sua parte, enquanto houver dinheiro para uma cota. Cada ativo passa do
    //    alvo em no máximo uma cota. O que não paga nenhuma cota vai para o Caixa.
    let left = budget - items.reduce((s, it) => s + it.value, 0);
    let guard = 0;
    while (left > 0 && guard < 250000) {
      guard++;
      let best = null;
      for (const it of items) {
        if (it.status !== 'ok' || it.lotCost <= 0 || it.lotCost > left) continue;
        const remaining = it.target - it.v - it.value; // quanto ainda falta para o alvo
        if (remaining < 1) continue;                    // já chegou no alvo
        const unspent = it.share - it.value;
        if (!best || unspent > best.unspent || (unspent === best.unspent && (remaining > best.remaining || (remaining === best.remaining && it.idx < best.it.idx)))) {
          best = { it, unspent, remaining };
        }
      }
      if (!best) break;
      best.it.qty += best.it.minQty;
      best.it.value += best.it.lotCost;
      if (best.it.share < best.it.lotCost) best.it.complemento = true;
      left -= best.it.lotCost;
    }
    items.forEach((it) => { if (it.status === 'ok' && it.value === 0 && it.lotCost > 0) it.status = 'lote_caro'; });
  } else {
    // fração / valor: valor exato; quem fica abaixo do mínimo sai e a parte dele é redistribuída
    for (let round = 0; round <= items.length; round++) {
      const act = active();
      const shares = cappedShares(budget, act.map((it) => it.deficit));
      let changed = false;
      act.forEach((it, k) => {
        it.share = shares[k];
        if (it.share > 0 && it.minAmount > 0 && it.share < it.minAmount) { it.status = 'abaixo_minimo'; changed = true; }
      });
      if (!changed) {
        act.forEach((it) => {
          it.value = it.share;
          it.qty = mode === 'fracao' && it.price > 0 ? it.value / 100 / it.price : 0;
        });
        break;
      }
      items.forEach((it) => { if (it.status !== 'ok') { it.share = 0; it.value = 0; it.qty = 0; } });
    }
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
      pc.items.filter((it) => it.status === 'sem_preco').forEach((it) => warnings.push({ code: 'sem_preco', classId: r.c.id,
        msg: `${normTicker(it.a.ticker) || '(sem ticker)'} está sem preço — ficou fora desta compra. Atualize as cotações ou digite o preço em Ativos.` }));
      pc.items.filter((it) => it.status === 'abaixo_minimo').forEach((it) => warnings.push({ code: 'abaixo_minimo', classId: r.c.id,
        msg: `${normTicker(it.a.ticker)}: a parte dele ficou abaixo do mínimo de aplicação e foi redistribuída.` }));
      if (pc.leftoverBRL >= Math.max(1000, Math.round(alloc * 0.05))) { // sobras pequenas são normais com cotas inteiras
        warnings.push({ code: 'sobra_classe', classId: r.c.id,
          msg: `${brl(pc.leftoverBRL)} da parte de "${r.c.name}" foi para o Caixa (${pc.mode === 'lote' ? 'as cotas que faltam custam mais que a sobra' : 'os ativos já chegaram ao alvo'}).` });
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
      orders.push({ classId: r.classId, className: r.name, assetId: it.a.id, ticker: normTicker(it.a.ticker), mode: it.mode,
        qty: it.qty, price: it.price, priceSource: it.priceSource, currency: r.currency, valueNative: it.value,
        valueBRL: r.rate === 1 ? it.value : Math.round(it.value * r.rate), priority: it.priority, complemento: it.complemento });
    }
  }));
  orders.sort((x, y) => (y.priority - x.priority) || (y.valueBRL - x.valueBRL) || x.ticker.localeCompare(y.ticker));

  const before = alignmentScore(classResults.map((r) => ({ idealPct: r.idealPct, currentPct: r.currentPct })));
  const afterVals = classResults.map((r) => r.currentBRL + r.investedBRL + r.directBRL + (r.isCash ? toCash : 0));
  const after = alignmentScore(classResults.map((r, k) => ({ idealPct: r.idealPct, currentPct: N > 0 ? (afterVals[k] / N) * 100 : 0 })));
  const cashRow = classResults.find((r) => r.isCash);

  return {
    ok: true, errors: [], warnings,
    aporte: A, totalBefore: T, totalAfter: N,
    investedBRL, directBRL, toCash, cashDirect: cashRow ? cashRow.directBRL : 0, cashClassId: cash.id,
    classes: classResults, orders, before, after,
  };
}

/**
 * Registra o aporte planejado: devolve uma NOVA carteira (a original não é alterada)
 * e o registro do aporte. Usa as mesmas cotações do plano.
 */
export function applyPlan(state, plan, market = {}, opts = {}) {
  if (!plan || !plan.ok) throw new Error('Plano inválido.');
  const quotes = market.quotes || {};
  const fx = { auto: market.fx?.auto || {}, manual: state.settings?.fxManual || {} };
  const s = JSON.parse(JSON.stringify(state));
  const date = opts.date || todayISO();
  const totalBefore = portfolioBRL(s, quotes, fx);
  const compras = [];
  plan.classes.forEach((r) => {
    const c = s.classes.find((x) => x.id === r.classId);
    if (!c) throw new Error('Classe do plano não encontrada: ' + r.name);
    if (!hasAssets(c)) {
      if (r.directNative > 0) c.currentValue = Math.round((num(c.currentValue) * 100 + r.directNative)) / 100;
      return;
    }
    r.items.forEach((it) => {
      if (!(it.value > 0)) return;
      const a = c.assets.find((x) => x.id === it.a.id);
      if (!a) throw new Error('Ativo do plano não encontrado: ' + it.a.ticker);
      const mode = buyMode(c);
      if (mode === 'valor') {
        a.currentValue = Math.round(num(a.currentValue) * 100 + it.value) / 100;
      } else {
        const qtyMode = isAutoValued(c, a, quotes) || (num(a.qty) <= 0 && toCents(a.currentValue) === 0);
        if (qtyMode) {
          a.qty = num(a.qty) + it.qty; // soma exata: nunca arredonda o que a pessoa já tinha
          if (it.priceSource === 'auto' && it.price > 0) a.lastQuotePrice = it.price; // garante valor mesmo se a cotação sumir
          if (!(num(a.price) > 0) && it.price > 0 && it.priceSource !== 'auto') a.price = it.price;
        } else {
          a.currentValue = Math.round(num(a.currentValue) * 100 + it.value) / 100;
        }
      }
      compras.push({ classId: c.id, ticker: normTicker(a.ticker), qty: it.qty, price: it.price, valor: it.value / 100,
        valorBRL: (r.rate === 1 ? it.value : Math.round(it.value * r.rate)) / 100, currency: r.currency, modo: mode });
    });
  });
  const cash = s.classes.find((c) => c.isCash);
  if (plan.toCash > 0) cash.currentValue = Math.round(num(cash.currentValue) * 100 + plan.toCash) / 100;

  const totalAfter = portfolioBRL(s, quotes, fx);
  const obs = String(opts.obs || '').slice(0, 300);
  const record = {
    id: uid(), date, disponivel: plan.aporte / 100, investido: plan.investedBRL / 100, direto: plan.directBRL / 100,
    sobra: plan.toCash / 100, compras, observacao: obs, patrimonioAntes: totalBefore, patrimonioDepois: totalAfter,
  };
  s.aportes = [...(s.aportes || []), record];
  s.agenda = { ...(s.agenda || {}), lastAporteDate: date };
  const comprasTxt = compras.filter((x) => x.modo !== 'valor').map((x) => (x.modo === 'lote' ? x.qty + 'x ' : '') + x.ticker).join(', ');
  const aplicTxt = compras.filter((x) => x.modo === 'valor').map((x) => x.ticker).join(', ');
  s.timeline = [...(s.timeline || []), {
    id: uid(), date, type: 'aporte', title: 'Aporte de ' + brl(plan.aporte),
    detail: [comprasTxt && 'Comprado: ' + comprasTxt, aplicTxt && 'Aplicado em: ' + aplicTxt, 'Caixa: +' + brl(plan.toCash + plan.cashDirect)]
      .filter(Boolean).join('. ') + (obs ? ' — ' + obs : ''),
  }];
  [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2000000, 5000000].forEach((m) => {
    if (totalBefore < m && totalAfter >= m) s.timeline.push({ id: uid(), date, type: 'marco', title: 'Carteira atingiu R$ ' + m.toLocaleString('pt-BR'), detail: '' });
  });
  return { state: s, record };
}

function portfolioBRL(s, quotes, fx) {
  return s.classes.reduce((sum, c) => {
    const r = fxRate(classCurrency(c), fx);
    return sum + classValueNative(c, quotes) * (r ?? 0);
  }, 0);
}
