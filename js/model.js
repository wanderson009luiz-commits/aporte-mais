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
export const TICKER_CHANGES = {
  BCFF11: { to: 'BTHF11', note: 'foi incorporado pelo BTHF11 (fusão aprovada pelos cotistas)' },
  MALL11: { to: 'PMLL11', note: 'mudou de nome, gestão e código para PMLL11' },
};

export function uid() { return Math.random().toString(36).slice(2, 10); }

export function normTicker(t) { return String(t ?? '').trim().toUpperCase(); }

/** Tipo da classe (deduz de versões antigas que não tinham o campo). */
export function classType(cls) {
  if (cls && CLASS_TYPES[cls.type]) return cls.type;
  if (!cls || !cls.hasAssets) return 'valor';
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
  return cls.fractional === true ? 'fracao' : 'lote'; // b3
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

function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; }

/**
 * Preço efetivo de um ativo, na moeda da classe.
 * Modo automático (padrão): cotação atual → última cotação real conhecida.
 * Modo manual: preço digitado (se vazio, cai para a cotação).
 * @returns {{price:number, source:'auto'|'cache'|'manual'|'none', quote:object|null}}
 */
export function assetPrice(cls, a, quotes) {
  if (buyMode(cls) === 'valor') return { price: 0, source: 'none', quote: null };
  const src = quoteSource(cls);
  const q = quotes && src !== 'none' ? quotes[quoteKey(src, a.ticker)] : null;
  const qOk = q && num(q.price) > 0 && (q.currency || 'BRL') === classCurrency(cls);
  const manual = num(a.price);
  const cached = num(a.lastQuotePrice);
  if (a.priceMode === 'manual') {
    if (manual > 0) return { price: manual, source: 'manual', quote: qOk ? q : null };
    if (qOk) return { price: num(q.price), source: 'auto', quote: q };
    return { price: 0, source: 'none', quote: null };
  }
  if (qOk) return { price: num(q.price), source: 'auto', quote: q };
  // sem cotação agora (fonte fora do ar): só a última cotação real conhecida.
  // Um preço digitado em versões antigas NÃO é usado no automático — pode estar velho
  // (ex.: fundo que deixou de ser negociado). Para usar um preço digitado, fixe-o (modo manual).
  if (cached > 0) return { price: cached, source: 'cache', quote: null };
  return { price: 0, source: 'none', quote: null };
}

/** O valor deste ativo é calculado sozinho (quantidade × preço)? */
export function isAutoValued(cls, a, quotes) {
  return buyMode(cls) !== 'valor' && num(a.qty) > 0 && assetPrice(cls, a, quotes).price > 0;
}

/** Valor atual do ativo na moeda da classe (em reais/dólares, não em centavos). */
export function assetValue(cls, a, quotes) {
  if (isAutoValued(cls, a, quotes)) return Math.round(num(a.qty) * assetPrice(cls, a, quotes).price * 100) / 100;
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
  return { id: uid(), ticker, idealPct, qty: 0, price: 0, priceMode: 'auto', currentValue: 0, minQty: 1, termometro: { nota: null, motivos: [] } };
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

/** Atualiza uma carteira de qualquer versão anterior para a versão atual, sem perder dados. */
export function migrateState(input) {
  const d = defaultState();
  if (!input || typeof input !== 'object' || !Array.isArray(input.classes)) return d;
  const s = JSON.parse(JSON.stringify(input)); // nunca altera o objeto recebido
  const oldVersion = num(s.version);
  s.classes = s.classes.filter((c) => c && typeof c === 'object');
  s.classes.forEach((c) => {
    if (!c.id) c.id = uid();
    if (typeof c.name !== 'string') c.name = 'Classe';
    const t = classType(c);
    c.type = t;
    c.idealPct = Math.max(0, num(c.idealPct));
    c.isCash = c.isCash === true || (c.isCash === undefined && c.id === 'caixa');
    if (c.isCash) c.type = 'valor';
    c.currency = classCurrency(c);
    if (c.fractional === undefined) c.fractional = t === 'cripto' || t === 'exterior';
    c.currentValue = Math.max(0, num(c.currentValue));
    if (!Array.isArray(c.assets)) c.assets = [];
    c.hasAssets = CLASS_TYPES[c.type].hasAssets; // mantido só para versões antigas do app lerem a carteira
    c.assets = c.assets.filter((a) => a && typeof a === 'object');
    c.assets.forEach((a) => {
      if (!a.id) a.id = uid();
      a.ticker = typeof a.ticker === 'string' ? a.ticker : String(a.ticker ?? '');
      a.idealPct = Math.max(0, num(a.idealPct));
      a.qty = Math.max(0, num(a.qty));
      a.price = Math.max(0, num(a.price));
      a.currentValue = Math.max(0, num(a.currentValue));
      a.minQty = Math.max(1, Math.round(num(a.minQty)) || 1);
      a.minAmount = Math.max(0, num(a.minAmount));
      a.lastQuotePrice = Math.max(0, num(a.lastQuotePrice));
      // Versões antigas nunca tiveram cotação automática funcionando: os preços digitados lá
      // viram apenas reserva; o preço automático (mais atual) passa a valer quando existir.
      if (a.priceMode !== 'manual' && a.priceMode !== 'auto') a.priceMode = 'auto';
      if (!a.termometro || typeof a.termometro !== 'object') a.termometro = { nota: null, motivos: [] };
      if (a.termometro.nota === undefined) a.termometro.nota = null;
      if (!Array.isArray(a.termometro.motivos)) a.termometro.motivos = [];
    });
  });
  // exatamente um caixa
  let seenCash = false;
  s.classes.forEach((c) => { if (c.isCash) { if (seenCash) c.isCash = false; else seenCash = true; } });
  if (!s.agenda || typeof s.agenda !== 'object') s.agenda = d.agenda;
  if (!s.settings || typeof s.settings !== 'object') s.settings = d.settings;
  if (!s.settings.fxManual || typeof s.settings.fxManual !== 'object') s.settings.fxManual = { USD: null, EUR: null };
  if (!Array.isArray(s.aportes)) s.aportes = [];
  if (!Array.isArray(s.timeline)) s.timeline = [];
  if (!Array.isArray(s.dividendos)) s.dividendos = [];
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
 */
export function parseNum(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0;
  if (input === null || input === undefined) return 0;
  let s = String(input).trim();
  if (!s) return 0;
  const compact = s.replace(/R\$|US\$|€|\s/g, '');
  const negative = compact.startsWith('-') || /^\(.*\)$/.test(compact);
  s = s.replace(/[^\d.,]/g, '');
  if (!s || !/\d/.test(s)) return 0;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart = s, decPart = '';
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = Math.max(lastDot, lastComma);
    intPart = s.slice(0, dec).replace(/[.,]/g, '');
    decPart = s.slice(dec + 1).replace(/[.,]/g, '');
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    if (parts.length > 2) { // "1,234,567" → milhar no padrão americano
      intPart = parts.join('');
    } else {
      intPart = parts[0];
      decPart = parts[1];
    }
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    const isThousands = parts.length > 2 || (parts[1].length === 3 && parts[0].length >= 1 && parts[0] !== '0' && !/^0/.test(parts[0]));
    if (isThousands) intPart = parts.join('');
    else { intPart = parts[0]; decPart = parts[1]; }
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

export function todayISO(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

/** Próxima data de aporte conforme a rotina escolhida (null se personalizada). */
export function nextAporteDate(agenda, today = new Date()) {
  if (!agenda || agenda.frequency === 'personalizado') return null;
  const t0 = new Date(today); t0.setHours(0, 0, 0, 0);
  const ref = agenda.lastAporteDate ? new Date(agenda.lastAporteDate + 'T00:00:00') : null;
  let next;
  if (agenda.frequency === 'diario') next = ref ? addDays(ref, 1) : t0;
  else if (agenda.frequency === 'semanal' || agenda.frequency === 'quinzenal') {
    const wd = Number(agenda.weekday) || 0;
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
