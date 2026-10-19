// =====================================================================
// Aporte+ — modelo de dados (puro: sem DOM, sem rede).
// Define os tipos de classe, a carteira padrão, a migração de versões
// antigas e como cada ativo é avaliado (preço e valor atual).
// Testado em tests/*.test.mjs — qualquer mudança aqui deve passar nos testes.
// =====================================================================

export const STATE_VERSION = 4;

/**
 * Tipos de classe. O tipo define de onde vem a cotação e como a compra é montada:
 *  - lote:   cotas inteiras (múltiplos do lote mínimo) — ações, FIIs, ETFs na B3
 *  - fracao: valor exato, quantidade fracionada — cripto, ações no exterior
 *  - valor:  sem preço unitário, aplica-se um valor em R$ — renda fixa, Tesouro, CDB
 */
export const CLASS_TYPES = {
  b3:        { label: 'Bolsa Brasil (B3)',          hasAssets: true,  quote: 'b3',     currency: 'BRL', defaultBuy: 'lote'   },
  exterior:  { label: 'Exterior (US$)',             hasAssets: true,  quote: 'us',     currency: 'USD', defaultBuy: 'fracao' },
  cripto:    { label: 'Criptomoedas',               hasAssets: true,  quote: 'crypto', currency: 'BRL', defaultBuy: 'fracao' },
  rendafixa: { label: 'Renda fixa (por valor)',     hasAssets: true,  quote: 'none',   currency: 'BRL', defaultBuy: 'valor'  },
  valor:     { label: 'Valor direto (sem ativos)',  hasAssets: false, quote: 'none',   currency: 'BRL', defaultBuy: 'valor'  },
};
export const CURRENCIES = ['BRL', 'USD', 'EUR'];

/**
 * Códigos que mudaram na B3 (incorporação ou troca de código), conferidos em outubro/2026.
 * O app avisa e oferece a troca — nunca troca sozinho.
 */
/**
 * Tickers que deixaram de existir (incorporação, troca de gestão/código).
 * factor = quantas cotas novas para cada cota antiga.
 */
export const TICKER_CHANGES = {
  BCFF11: { to: 'BTHF11', factor: 0.8, date: '2024-10-18',
    note: 'foi incorporado pelo BTHF11: último pregão em 18/10/2024 e cada 10 cotas viraram 8 de BTHF11 (as frações foram vendidas em leilão e pagas em dinheiro)' },
  MALL11: { to: 'PMLL11', factor: 1, date: '2025-07-22',
    note: 'passou para a gestão da Pátria e virou PMLL11 em 22/07/2025, com a mesma quantidade de cotas' },
};

/**
 * Quantidade depois de uma troca de ticker. Na bolsa (lote) só existem cotas inteiras: a fração
 * vira dinheiro (a B3 junta as frações e vende em leilão). Conta em milionésimos para que
 * 13 × 0,8 dê exatamente 10,4.
 * @returns {{qty:number, fraction:number}}
 */
export function convertQty(qty, factor, mode) {
  const q = Math.max(0, toNumber(qty));
  const f = toNumber(factor);
  if (!(f > 0) || q === 0) return { qty: q, fraction: 0 };
  if (mode === 'lote') {
    const exact = Math.round(q * f * 1e6) / 1e6;
    const whole = Math.floor(exact + 1e-9);
    return { qty: whole, fraction: Math.max(0, Math.round((exact - whole) * 1e6) / 1e6) };
  }
  return { qty: Math.round(q * f * 1e8) / 1e8, fraction: 0 };
}

export function uid() { return Math.random().toString(36).slice(2, 10).padEnd(8, '0'); }

export function normTicker(t) { return String(t ?? '').trim().toUpperCase(); }

const JS_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
/**
 * Número de um campo salvo. Aceita números e textos ("1234.56" no formato do JavaScript ou
 * "1.234,56" / "R$ 1.500,00" no formato brasileiro). Qualquer coisa inválida vira 0.
 */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return 0;
    if (JS_NUMBER.test(t)) { const n = Number(t); return Number.isFinite(n) ? n : 0; }
    return parseNum(t);
  }
  return 0;
}
const num = toNumber;

/** Tipo da classe (deduz de versões antigas que não tinham o campo). */
export function classType(cls) {
  if (cls && typeof cls.type === 'string' && Object.prototype.hasOwnProperty.call(CLASS_TYPES, cls.type)) return cls.type;
  if (!cls || typeof cls !== 'object') return 'valor';
  // versões antigas: "hasAssets"; se o campo não existe, ter ativos cadastrados já diz que é classe com ativos
  const has = cls.hasAssets === true || (cls.hasAssets === undefined && Array.isArray(cls.assets) && cls.assets.length > 0);
  if (!has) return 'valor';
  const id = String(cls.id || '').toLowerCase();
  const name = String(cls.name || '').toLowerCase();
  if (id === 'cripto' || /cript|bitcoin/.test(name)) return 'cripto';
  if (id === 'rendafixa' || /renda\s*fixa|tesouro|cdb|lci|lca|deb[eê]nture/.test(name)) return 'rendafixa';
  if (cls.currency === 'USD' || /eua|exterior|avenue|nyse|nasdaq|stocks/.test(name)) return 'exterior';
  return 'b3';
}

/** Moeda efetiva: B3 e cripto sempre em R$; exterior sempre US$; as demais escolhidas pelo usuário. */
export function classCurrency(cls) {
  const t = classType(cls);
  if (t === 'b3' || t === 'cripto') return 'BRL';
  if (t === 'exterior') return 'USD';
  return CURRENCIES.includes(cls.currency) ? cls.currency : 'BRL';
}

/** Como a compra é montada nesta classe: 'lote' | 'fracao' | 'valor'. */
export function buyMode(cls) {
  const t = classType(cls);
  if (t === 'rendafixa' || t === 'valor') return 'valor';
  if (t === 'cripto') return 'fracao';
  if (t === 'exterior') return cls.fractional === false ? 'lote' : 'fracao';
  return 'lote'; // B3: sempre cotas inteiras (o "fracionário" da B3 também negocia cotas inteiras)
}

export function quoteSource(cls) { return CLASS_TYPES[classType(cls)].quote; }
export function hasAssets(cls) { return CLASS_TYPES[classType(cls)].hasAssets; }

/** Chave da cotação no cache global (evita colisão entre bolsas diferentes). */
export function quoteKey(source, ticker) {
  const t = normTicker(ticker);
  if (source === 'us') return 'US:' + t;
  if (source === 'crypto') return 'CRYPTO:' + t;
  return t; // b3
}

/** Ticker válido para busca de cotação (evita mandar lixo para as fontes). */
export function isQuotableTicker(t) { return /^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(normTicker(t)); }

/**
 * Preço "limpo": a B3 negocia em centavos (e as fontes às vezes mandam 37,150001525...);
 * de 1,00 para cima também vale o centavo; abaixo de 1,00 (cripto, centavos de dólar) guarda até 8 casas.
 */
export function cleanPrice(cls, p) {
  const n = num(p);
  if (!(n > 0)) return 0;
  if (classType(cls) === 'b3' || n >= 1) return Math.round(n * 100) / 100;
  return Math.round(n * 1e8) / 1e8;
}

/**
 * Preço efetivo de um ativo, na moeda da classe.
 * Modo automático (padrão): cotação atual → última cotação real conhecida.
 * Modo manual: preço digitado (se vazio, segue a mesma regra do automático).
 * @returns {{price:number, source:'auto'|'cache'|'manual'|'none', quote:object|null}}
 */
export function assetPrice(cls, a, quotes) {
  if (buyMode(cls) === 'valor') return { price: 0, source: 'none', quote: null };
  const src = quoteSource(cls);
  const q = quotes && src !== 'none' ? quotes[quoteKey(src, a.ticker)] : null;
  const qPrice = q ? cleanPrice(cls, q.price) : 0;
  const sameCur = !!q && (q.currency || 'BRL') === classCurrency(cls);
  // cotação marcada como velha (a fonte parou de atualizar há dias, ou não reconhece mais o ticker)
  // não vale como preço ATUAL — mas continua sendo o último preço real conhecido
  const qOk = sameCur && !q.stale && qPrice > 0;
  const qLast = sameCur && q.stale && qPrice > 0 ? qPrice : 0;
  const manual = cleanPrice(cls, a.price);
  const cached = cleanPrice(cls, a.lastQuotePrice);
  if (a.priceMode === 'manual' && manual > 0) return { price: manual, source: 'manual', quote: qOk ? q : null };
  if (qOk) return { price: qPrice, source: 'auto', quote: q };
  // sem cotação atual: o último preço real conhecido (o da fonte, mesmo velho, é o mais recente;
  // depois o gravado no último aporte). Um preço digitado em versões antigas NÃO é usado no
  // automático — pode estar velho. Para usar um preço digitado, fixe-o (modo manual).
  if (qLast > 0) return { price: qLast, source: 'cache', quote: q };
  if (cached > 0) return { price: cached, source: 'cache', quote: null };
  return { price: 0, source: 'none', quote: null };
}

/** O valor deste ativo é calculado sozinho (quantidade × preço)? */
export function isAutoValued(cls, a, quotes) {
  return buyMode(cls) !== 'valor' && num(a.qty) > 0 && assetPrice(cls, a, quotes).price > 0;
}

/** Valor atual do ativo na moeda da classe (em reais/dólares, não em centavos). */
export function assetValue(cls, a, quotes) {
  if (isAutoValued(cls, a, quotes)) return Math.round(num(a.qty) * assetPrice(cls, a, quotes).price * 100 + 1e-7) / 100;
  return Math.max(0, num(a.currentValue));
}

export function classValueNative(cls, quotes) {
  if (!hasAssets(cls)) return Math.max(0, num(cls.currentValue));
  return (cls.assets || []).reduce((s, a) => s + assetValue(cls, a, quotes), 0);
}

/** Cotação da moeda em R$. Manual (configurada pelo usuário) tem prioridade sobre a automática. */
export function fxRate(currency, fx) {
  if (!currency || currency === 'BRL') return 1;
  const manual = num(fx?.manual?.[currency]);
  if (manual > 0) return manual;
  const auto = num(fx?.auto?.[currency]);
  return auto > 0 ? auto : null;
}

/** Valor da classe em R$; null se a moeda não tiver cotação. */
export function classValueBRL(cls, quotes, fx) {
  const v = classValueNative(cls, quotes);
  const r = fxRate(classCurrency(cls), fx);
  if (r === null) return v > 0 ? null : 0;
  return v * r;
}

export function portfolioTotalBRL(state, quotes, fx) {
  return state.classes.reduce((s, c) => { const v = classValueBRL(c, quotes, fx); return s + (v || 0); }, 0);
}

/** Soma dos percentuais ideais (classes ou ativos). */
export function sumIdeal(list) { return (list || []).reduce((s, x) => s + num(x.idealPct), 0); }
export function isHundred(sum) { return Math.abs(sum - 100) < 0.005; }

// ---------------------------------------------------------------------
// Carteira padrão e migração
// ---------------------------------------------------------------------
function A(ticker, idealPct) {
  return { id: uid(), ticker, idealPct, qty: 0, price: 0, priceMode: 'auto', currentValue: 0, minQty: 1, minAmount: 0, lastQuotePrice: 0, termometro: { nota: null, motivos: [] } };
}

export function defaultState() {
  return {
    version: STATE_VERSION,
    classes: [
      { id: 'acoes', name: 'Ações', type: 'b3', idealPct: 35, isCash: false, currency: 'BRL', fractional: false, currentValue: 0,
        assets: [A('VALE3', 6), A('WEGE3', 8), A('EGIE3', 6), A('BBSE3', 5), A('TAEE11', 6), A('LEVE3', 5), A('TOTS3', 7), A('SAPR11', 5), A('BBAS3', 7), A('VIVA3', 6), A('FLRY3', 7), A('SOJA3', 5), A('ABEV3', 5), A('ITSA4', 7), A('RANI3', 5), A('GRND3', 5), A('KLBN4', 5)] },
      { id: 'caixa', name: 'Caixa', type: 'valor', idealPct: 5, isCash: true, currency: 'BRL', fractional: false, currentValue: 0, assets: [] },
      { id: 'etfs', name: 'ETFs', type: 'b3', idealPct: 25, isCash: false, currency: 'BRL', fractional: false, currentValue: 0,
        assets: [A('IVVB11', 40), A('NASD11', 30), A('WRLD11', 20), A('DIVO11', 10)] },
      { id: 'fiis', name: 'FIIs', type: 'b3', idealPct: 20, isCash: false, currency: 'BRL', fractional: false, currentValue: 0,
        assets: [A('XPLG11', 8), A('HGLG11', 8), A('VILG11', 6), A('XPML11', 7), A('VISC11', 7), A('PMLL11', 6), A('KNRI11', 6), A('HGRE11', 6), A('BRCR11', 5), A('DEVA11', 7), A('CPTS11', 6), A('VRTA11', 6), A('BTHF11', 6), A('HGRU11', 8), A('MXRF11', 8)] },
      { id: 'rendafixa', name: 'Renda Fixa', type: 'rendafixa', idealPct: 10, isCash: false, currency: 'BRL', fractional: false, currentValue: 0,
        assets: [A('TESOURO IPCA+', 49), A('TESOURO SELIC', 17), A('LCI/LCA', 17), A('LIQUIDEZ IMEDIATA', 17)] },
      { id: 'cripto', name: 'Criptomoedas', type: 'cripto', idealPct: 5, isCash: false, currency: 'BRL', fractional: true, currentValue: 0,
        assets: [A('BTC', 70), A('ETH', 30)] },
    ],
    agenda: { frequency: 'semanal', weekday: 1, dayOfMonth: 5, customNote: '', lastAporteDate: null },
    settings: { fxManual: { USD: null, EUR: null } },
    aportes: [],
    timeline: [],
    dividendos: [],
  };
}

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
/** Remove campos com valor `undefined` (assim a carteira em memória é igual à salva em JSON). */
const prune = (o) => { Object.keys(o).forEach((k) => { if (o[k] === undefined) delete o[k]; }); return o; };

/**
 * Atualiza uma carteira de qualquer versão anterior para a versão atual, sem perder dados.
 * Nunca altera o objeto recebido. Rodar duas vezes dá o mesmo resultado.
 * Avisos sobre mudanças que a pessoa precisa saber ficam em `migrationNotes`.
 */
export function migrateState(input) {
  if (!isObj(input) || !Array.isArray(input.classes)) return migrateState(defaultState());
  const d = defaultState();
  const s = JSON.parse(JSON.stringify(input)); // nunca altera o objeto recebido
  const oldVersion = num(s.version);
  const notes = [];
  const classIds = new Set();
  const assetIds = new Set();
  // identificador estável e único (duplicados ganham um novo — senão a compra iria para o ativo errado)
  const cleanId = (v, seen) => {
    const raw = typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, 64) : '';
    let id = raw && !seen.has(raw) ? raw : uid();
    while (seen.has(id)) id = uid();
    seen.add(id);
    return id;
  };
  s.classes = s.classes.filter(isObj).slice(0, 50);
  s.classes.forEach((c) => {
    c.id = cleanId(c.id, classIds);
    c.name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 40) : 'Classe';
    const t = classType(c);
    c.type = t;
    c.idealPct = Math.max(0, num(c.idealPct));
    c.isCash = c.isCash === true || (c.isCash === undefined && c.id === 'caixa');
    if (typeof c.fractional !== 'boolean') c.fractional = t === 'cripto' || t === 'exterior';
    c.currentValue = Math.max(0, num(c.currentValue));
    c.assets = (Array.isArray(c.assets) ? c.assets : []).filter(isObj).slice(0, 300);
    // Caixa marcado num tipo "com ativos" mas sem nenhum ativo: é valor direto (nada a esconder)
    if (c.isCash && CLASS_TYPES[c.type].hasAssets && c.assets.length === 0) c.type = 'valor';
    c.currency = classCurrency(c);
    c.hasAssets = CLASS_TYPES[c.type].hasAssets; // mantido só para versões antigas do app lerem a carteira
    c.assets.forEach((a) => {
      a.id = cleanId(a.id, assetIds);
      a.ticker = (typeof a.ticker === 'string' ? a.ticker : String(a.ticker ?? '')).slice(0, 40);
      a.idealPct = Math.max(0, num(a.idealPct));
      a.qty = Math.max(0, num(a.qty));
      a.price = Math.max(0, num(a.price));
      a.currentValue = Math.max(0, num(a.currentValue));
      a.minQty = Math.max(1, Math.round(num(a.minQty)) || 1);
      a.minAmount = Math.max(0, num(a.minAmount));
      a.lastQuotePrice = Math.max(0, num(a.lastQuotePrice));
      // trocas de ticker com conversão de cotas: aportes anteriores não podem ser desfeitos em cotas
      const epoch = Math.min(1e6, Math.round(num(a.qtyEpoch)));
      if (epoch > 0) a.qtyEpoch = epoch; else delete a.qtyEpoch;
      const swaps = (Array.isArray(a.swaps) ? a.swaps : []).filter(isObj).slice(-10).map((x) => ({
        from: String(x.from ?? '').slice(0, 40), to: String(x.to ?? '').slice(0, 40),
        factor: num(x.factor) > 0 ? num(x.factor) : 1, date: isISODate(x.date) ? x.date : null,
      }));
      if (swaps.length) a.swaps = swaps; else delete a.swaps;
      // Versões antigas nunca tiveram cotação automática funcionando: os preços digitados lá
      // viram apenas reserva; o preço automático (mais atual) passa a valer quando existir.
      if (a.priceMode !== 'manual' && a.priceMode !== 'auto') a.priceMode = 'auto';
      if (!isObj(a.termometro)) a.termometro = { nota: null, motivos: [] };
      const nota = a.termometro.nota === null || a.termometro.nota === '' || a.termometro.nota === undefined ? NaN : Number(a.termometro.nota);
      a.termometro.nota = Number.isFinite(nota) ? Math.max(0, Math.min(100, Math.round(nota))) : null;
      a.termometro.motivos = (Array.isArray(a.termometro.motivos) ? a.termometro.motivos : [])
        .filter((x) => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 200));
    });
  });
  // Caixa: exatamente um, do tipo "valor direto". NUNCA esconde patrimônio: uma classe com ativos
  // que estava marcada como Caixa continua com seus ativos e deixa de ser o Caixa; nesse caso um
  // Caixa de Oportunidade vazio é criado para receber as sobras (e a pessoa é avisada).
  const flagged = s.classes.filter((c) => c.isCash);
  const keep = flagged.find((c) => !CLASS_TYPES[c.type].hasAssets) || null;
  flagged.forEach((c) => { if (c !== keep) c.isCash = false; });
  if (!keep && flagged.length) {
    s.classes.push({ id: cleanId('caixa-oportunidade', classIds), name: 'Caixa de Oportunidade', type: 'valor', idealPct: 0, isCash: true,
      currency: 'BRL', fractional: false, currentValue: 0, assets: [], hasAssets: false });
    notes.push(`A classe "${flagged[0].name}" estava marcada como Caixa, mas tem ativos. Ela continua igual, com todos os ativos e valores, e foi criado um "Caixa de Oportunidade" para receber as sobras. Se preferir outra organização, ajuste em Configuração.`);
  }
  // agenda, ajustes e listas: só formatos válidos (um backup adulterado não pode injetar nada na tela)
  const g = isObj(s.agenda) ? s.agenda : d.agenda;
  s.agenda = {
    frequency: FREQS.includes(g.frequency) ? g.frequency : d.agenda.frequency,
    weekday: ((Math.round(num(g.weekday)) % 7) + 7) % 7, // 0 = domingo (7 também vira domingo)
    dayOfMonth: Math.max(1, Math.min(28, Math.round(num(g.dayOfMonth)) || 5)),
    customNote: String(g.customNote ?? '').slice(0, 120),
    lastAporteDate: isISODate(g.lastAporteDate) ? g.lastAporteDate : null,
  };
  const fxm = isObj(s.settings) && isObj(s.settings.fxManual) ? s.settings.fxManual : {};
  s.settings = { fxManual: { USD: num(fxm.USD) > 0 ? num(fxm.USD) : null, EUR: num(fxm.EUR) > 0 ? num(fxm.EUR) : null } };
  const objs = (list) => (Array.isArray(list) ? list : []).filter(isObj);
  const str = (v, n) => String(v ?? '').slice(0, n);
  const optNum = (v) => (v == null ? undefined : num(v));
  s.aportes = objs(s.aportes).slice(-10000).map((a) => prune({
    ...a, id: str(a.id || uid(), 64), date: isISODate(a.date) ? a.date : null,
    disponivel: num(a.disponivel), investido: num(a.investido), direto: num(a.direto), sobra: num(a.sobra),
    caixa: optNum(a.caixa), caixaPlano: optNum(a.caixaPlano),
    patrimonioAntes: optNum(a.patrimonioAntes), patrimonioDepois: optNum(a.patrimonioDepois),
    observacao: str(a.observacao, 300),
    compras: objs(a.compras).slice(0, 20000).map((x) => ({
      classId: str(x.classId, 64), ticker: str(x.ticker, 40), qty: num(x.qty), price: num(x.price), valor: num(x.valor),
      valorBRL: x.valorBRL == null ? num(x.valor) : num(x.valorBRL), currency: CURRENCIES.includes(x.currency) ? x.currency : 'BRL',
      modo: ['lote', 'fracao', 'valor'].includes(x.modo) ? x.modo : 'lote',
    })),
    deltas: Array.isArray(a.deltas) ? objs(a.deltas).slice(0, 20000).map((x) => prune({
      classId: str(x.classId, 64), assetId: x.assetId == null ? null : str(x.assetId, 64),
      field: x.field === 'qty' ? 'qty' : 'currentValue', amount: num(x.amount), label: str(x.label, 60),
      value: x.value == null ? undefined : num(x.value), currency: CURRENCIES.includes(x.currency) ? x.currency : undefined,
      epoch: num(x.epoch) > 0 ? Math.min(1e6, Math.round(num(x.epoch))) : undefined,
    })) : undefined,
    prevLastAporteDate: isISODate(a.prevLastAporteDate) ? a.prevLastAporteDate : null,
  }));
  s.dividendos = objs(s.dividendos).slice(-50000).map((x) => ({
    ...x, id: str(x.id || uid(), 64), date: isISODate(x.date) ? x.date : null, ticker: str(x.ticker, 40), tipo: str(x.tipo, 30), valor: num(x.valor),
  }));
  s.timeline = objs(s.timeline).slice(-50000).map((x) => prune({
    ...x, id: str(x.id || uid(), 64), date: isISODate(x.date) ? x.date : null,
    aporteId: x.aporteId == null ? undefined : str(x.aporteId, 64), dividendoId: x.dividendoId == null ? undefined : str(x.dividendoId, 64),
    type: ['aporte', 'dividendo', 'alerta', 'marco'].includes(x.type) ? x.type : 'marco', title: str(x.title, 200), detail: str(x.detail, 600),
  }));
  // o "desfazer" agora tira só o que o aporte somou (engine.revertAporte); a cópia inteira antiga sai
  delete s.undo;
  const prevNotes = (Array.isArray(s.migrationNotes) ? s.migrationNotes : []).filter((x) => typeof x === 'string').map((x) => x.slice(0, 400));
  s.migrationNotes = [...prevNotes, ...notes].slice(-10);
  if (!s.migrationNotes.length) delete s.migrationNotes;
  if (oldVersion !== STATE_VERSION) s.migratedFrom = oldVersion || 3;
  s.version = STATE_VERSION;
  return s;
}

/** Lista (ticker, fonte) que precisa de cotação automática nesta carteira. */
export function trackedTickers(state) {
  const map = new Map();
  state.classes.forEach((c) => {
    const src = quoteSource(c);
    if (src === 'none') return;
    (c.assets || []).forEach((a) => {
      const t = normTicker(a.ticker);
      if (!isQuotableTicker(t)) return;
      const k = src + '|' + t;
      if (!map.has(k)) map.set(k, { ticker: t, source: src });
    });
  });
  return [...map.values()].sort((x, y) => (x.source + x.ticker).localeCompare(y.source + y.ticker));
}

// ---------------------------------------------------------------------
// Utilidades de número e data (usadas por todo o app)
// ---------------------------------------------------------------------

/**
 * Converte texto digitado em número. Aceita:
 *  "1.234,56" (BR) · "1234,56" · "1,234.56" (US) · "1234.56" · "1.500" (milhar BR) · "R$ 10,50"
 *  "1.000.50" (o último grupo com 1–2 dígitos é a parte decimal) · "1e5" (notação científica)
 */
export function parseNum(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0;
  if (input === null || input === undefined) return 0;
  let s = String(input).trim();
  if (!s) return 0;
  const compact = s.replace(/R\$|US\$|€|\s/g, '');
  const negative = compact.startsWith('-') || /^\(.*\)$/.test(compact);
  const sci = compact.replace(/^[-+(]+|\)$/g, '');
  if (/^(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(sci)) { const n = Number(sci); return Number.isFinite(n) ? (negative ? -n : n) : 0; }
  s = s.replace(/[^\d.,]/g, '');
  if (!s || !/\d/.test(s)) return 0;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart = s, decPart = '';
  const groups = (parts) => { // vários separadores iguais: milhar, exceto se o último grupo não tem 3 dígitos
    const last = parts[parts.length - 1];
    if (last.length === 3) { intPart = parts.join(''); decPart = ''; } else { intPart = parts.slice(0, -1).join(''); decPart = last; }
  };
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = Math.max(lastDot, lastComma);
    intPart = s.slice(0, dec).replace(/[.,]/g, '');
    decPart = s.slice(dec + 1).replace(/[.,]/g, '');
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    if (parts.length > 2) groups(parts); // "1,234,567" (milhar US) · "1,234,56"
    else { intPart = parts[0]; decPart = parts[1]; }
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    if (parts.length > 2) groups(parts); // "1.234.567" · "1.000.50"
    else {
      const isThousands = parts[1].length === 3 && parts[0].length >= 1 && !/^0/.test(parts[0]);
      if (isThousands) intPart = parts.join('');
      else { intPart = parts[0]; decPart = parts[1]; }
    }
  }
  const n = parseFloat((intPart || '0') + (decPart ? '.' + decPart : ''));
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

/** Reais → centavos inteiros, arredondando corretamente casos como 1,005. */
export function toCents(v) {
  const n = num(v);
  return Math.round(n * 100 + (n >= 0 ? 1e-7 : -1e-7));
}

const FREQS = ['diario', 'semanal', 'quinzenal', 'mensal', 'personalizado'];
export function isISODate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')); }

export function todayISO(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

/** Próxima data de aporte conforme a rotina escolhida (null se personalizada). */
export function nextAporteDate(agenda, today = new Date()) {
  if (!agenda || agenda.frequency === 'personalizado') return null;
  const t0 = new Date(today); t0.setHours(0, 0, 0, 0);
  const ref = isISODate(agenda.lastAporteDate) ? new Date(agenda.lastAporteDate + 'T00:00:00') : null;
  let next;
  if (agenda.frequency === 'diario') next = ref ? addDays(ref, 1) : t0;
  else if (agenda.frequency === 'semanal' || agenda.frequency === 'quinzenal') {
    const wd = ((Math.round(num(agenda.weekday)) % 7) + 7) % 7;
    // semanal: a partir do dia seguinte ao último aporte; quinzenal: a partir de 14 dias depois
    next = ref ? addDays(ref, agenda.frequency === 'quinzenal' ? 14 : 1) : new Date(t0);
    let g = 0; while (next.getDay() !== wd && g < 8) { next = addDays(next, 1); g++; }
  } else if (agenda.frequency === 'mensal') {
    const day = Math.max(1, Math.min(28, Math.round(num(agenda.dayOfMonth)) || 5));
    if (ref) next = new Date(ref.getFullYear(), ref.getMonth() + 1, day);
    else { next = new Date(t0.getFullYear(), t0.getMonth(), day); if (next < t0) next = new Date(t0.getFullYear(), t0.getMonth() + 1, day); }
  } else next = t0;
  if (next < t0) next = t0; // atrasado: o próximo aporte é hoje
  return next;
}
