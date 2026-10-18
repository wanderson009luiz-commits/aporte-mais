// =====================================================================
// Aporte+ v4 — interface. Toda conta de dinheiro fica em engine.js/model.js (testados).
// =====================================================================
import {
  CLASS_TYPES, CURRENCIES, classType, classCurrency, buyMode, hasAssets, quoteSource, quoteKey, normTicker,
  assetPrice, assetValue, isAutoValued, classValueNative, classValueBRL, portfolioTotalBRL, fxRate, sumIdeal, isHundred,
  defaultState, migrateState, trackedTickers, parseNum, toCents, todayISO, nextAporteDate, uid,
  TICKER_CHANGES,
} from './model.js?v=dev';
import { planAporte, applyPlan, validateForPlan, alignmentScore } from './engine.js?v=dev';

const APP_VERSION = '4.0.0';
const SUPABASE_URL = 'https://vldiylyynkgprpfxyyej.supabase.co';
// Chave pública (anon) — é feita para ficar no navegador; a proteção real são as regras RLS do banco.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZsZGl5bHl5bmtncHJwZnh5eWVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxNjA4NTYsImV4cCI6MjEwNDczNjg1Nn0.mlv8I8EOtRhiZyw2PlVnp2mNMXLZCTJr0acDLMKKjy0';
const QUOTE_MAX_AGE_MS = 20 * 60 * 1000; // ao abrir o app, atualiza se a cotação tiver mais de 20 min
const QUOTE_REFRESH_EVERY_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------
let sb = null;
let user = null;
let portfolioId = null;
let state = null;
let stateLoaded = false;          // nunca salva antes de carregar com sucesso
let lastUpdatedAt = null;         // controle de edição em dois aparelhos
let conflict = false;
let quotes = {};                  // chave → {price, currency, change_percent, updated_at}
let fxAuto = {};                  // {USD: 5.06, EUR: 5.66}
let fxUpdatedAt = {};
let failedQuoteKeys = new Set();
let quotesRefreshing = false;
let lastQuoteRefresh = 0;
let quoteRefreshError = false;
let sentimentCache = {};
let activeTab = 'painel';
let activeAtivosClassId = null;
let lastPlan = null;
let lastSyncedTickers = null;
let authMode = 'login';
let booted = false;
let booting = false;

const $ = (id) => document.getElementById(id);
const market = () => ({ quotes, fx: { auto: fxAuto } });
const fxCtx = () => ({ auto: fxAuto, manual: state?.settings?.fxManual || {} });

// ---------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function n2(v) { const x = Number.isFinite(v) ? v : 0; return x.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function sym(cur) { return cur === 'USD' ? 'US$ ' : cur === 'EUR' ? '€ ' : 'R$ '; }
function money(v, cur = 'BRL') { return sym(cur) + n2(v); }
function moneyC(cents, cur = 'BRL') { return money(cents / 100, cur); }
function pct(v) { return (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 }); }
function pct1(v) { return (Math.round((Number(v) || 0) * 10) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function qtyTxt(q, mode) {
  if (mode === 'lote') return Math.round(q).toLocaleString('pt-BR');
  if (!(q > 0)) return '0';
  const dec = q >= 1 ? 4 : 8;
  return q.toLocaleString('pt-BR', { maximumFractionDigits: dec });
}
function priceTxt(p, cur) {
  if (!(p > 0)) return '—';
  const dec = p < 1 ? 4 : 2;
  return sym(cur) + p.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: dec });
}
function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return 'R$ ' + (v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi';
  if (a >= 1e3) return 'R$ ' + (v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil';
  return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
}
function ago(iso) {
  if (!iso) return '—';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
}
function fmtDateBR(iso) { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${y}`; }

// ---------------------------------------------------------------------
// Avisos e diálogos
// ---------------------------------------------------------------------
let toastTimer = null;
function toast(msg, opts = {}) {
  const t = $('toast');
  t.innerHTML = esc(msg) + (opts.action ? ` <button class="link-btn" id="toast-action" style="font-size:12px; margin-left:8px;">${esc(opts.action.label)}</button>` : '');
  t.classList.add('show');
  if (opts.action) $('toast-action').onclick = () => { t.classList.remove('show'); opts.action.run(); };
  t.style.pointerEvents = opts.action ? 'auto' : 'none';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), opts.ms || (opts.action ? 9000 : 3600));
}

/** Diálogo simples. buttons: [{label, kind:'primary'|'', value}] → Promise com o value clicado (null se fechar). */
function dialog({ title, html, buttons = [{ label: 'OK', kind: 'primary', value: true }], onOpen }) {
  return new Promise((resolve) => {
    const back = $('modal-back');
    const box = $('modal');
    box.innerHTML = `<h2 id="modal-title">${esc(title)}</h2>${html || ''}<div class="modal-actions">${buttons.map((b, i) => `<button class="btn ${b.kind === 'primary' ? 'btn-primary' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
    back.classList.add('show');
    const close = (v) => { back.classList.remove('show'); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    box.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
      const btn = buttons[Number(b.dataset.i)];
      if (btn.validate) { const ok = btn.validate(box); if (!ok) return; }
      close(typeof btn.value === 'function' ? btn.value(box) : btn.value);
    }));
    back.onclick = (e) => { if (e.target === back) close(null); };
    if (onOpen) onOpen(box);
    const first = box.querySelector('input') || box.querySelector('.btn-primary');
    if (first) setTimeout(() => first.focus(), 30);
  });
}
const confirmBox = (title, text, okLabel = 'Confirmar') => dialog({ title, html: `<p>${text}</p>`, buttons: [{ label: 'Cancelar', value: false }, { label: okLabel, kind: 'primary', value: true }] });

// ---------------------------------------------------------------------
// Inicialização e login
// ---------------------------------------------------------------------
function showBoot(title, text, { spinner = true, actions = '' } = {}) {
  $('boot-screen').style.display = 'flex';
  $('boot-title').textContent = title;
  $('boot-text').textContent = text;
  $('boot-spinner').style.display = spinner ? '' : 'none';
  $('boot-actions').innerHTML = actions;
}
function hideBoot() { $('boot-screen').style.display = 'none'; }

function showAuth(mode = 'login', msg = null) {
  hideBoot();
  $('app-root').style.display = 'none';
  $('auth-screen').style.display = 'flex';
  setAuthMode(mode);
  if (msg) authMsg(msg.text, msg.kind);
}
function setAuthMode(mode) {
  authMode = mode;
  const cfg = {
    login: ['Entrar', 'Sua carteira fica salva na nuvem, só você tem acesso.', 'Entrar', 'Criar conta', true],
    signup: ['Criar conta', 'Use seu e-mail e uma senha de pelo menos 8 caracteres.', 'Criar conta', 'Já tenho conta', true],
    forgot: ['Recuperar senha', 'Enviamos um link para você criar uma nova senha.', 'Enviar link', 'Voltar para o login', false],
  }[mode];
  $('auth-title').textContent = cfg[0];
  $('auth-sub').textContent = cfg[1];
  $('btn-auth-main').textContent = cfg[2];
  $('btn-auth-toggle').textContent = cfg[3];
  $('auth-pass-field').style.display = cfg[4] ? '' : 'none';
  $('btn-auth-forgot').style.display = mode === 'login' ? '' : 'none';
  $('auth-password').setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
  authMsg('');
}
function authMsg(text, kind) {
  const el = $('auth-msg');
  el.textContent = text || '';
  el.className = 'auth-msg' + (text ? ' show ' + (kind || '') : '');
}
function translateAuthError(e) {
  const m = String(e?.message || e || '');
  if (/invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
  if (/email not confirmed/i.test(m)) return 'Confirme seu e-mail (veja a caixa de entrada e o spam) e tente de novo.';
  if (/already registered|already exists/i.test(m)) return 'Já existe uma conta com este e-mail. Use "Entrar" ou "Esqueci a senha".';
  if (/password should be at least|weak password/i.test(m)) return 'Senha fraca: use pelo menos 8 caracteres, misturando letras e números.';
  if (/rate limit|only request this after|too many/i.test(m)) return 'Muitas tentativas seguidas. Aguarde um minuto e tente de novo.';
  if (/failed to fetch|network/i.test(m)) return 'Sem conexão com a internet. Verifique e tente de novo.';
  if (/invalid email|unable to validate email/i.test(m)) return 'E-mail inválido.';
  return 'Não foi possível concluir: ' + m;
}
const appUrl = () => location.origin + location.pathname;

async function onAuthSubmit(e) {
  e.preventDefault();
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const btn = $('btn-auth-main');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { authMsg('Digite um e-mail válido.', 'err'); return; }
  if (authMode !== 'forgot' && !password) { authMsg('Digite a senha.', 'err'); return; }
  if (authMode === 'signup' && password.length < 8) { authMsg('A senha precisa ter pelo menos 8 caracteres.', 'err'); return; }
  btn.disabled = true;
  try {
    if (authMode === 'login') {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await onAuthed(data.user);
    } else if (authMode === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } });
      if (error) throw error;
      if (data.session) await onAuthed(data.user);
      else { setAuthMode('login'); authMsg('Conta criada! Abra o e-mail de confirmação que enviamos e depois entre aqui.', 'ok'); }
    } else {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
      if (error) throw error;
      authMsg('Se existir uma conta com esse e-mail, enviamos um link para criar uma nova senha.', 'ok');
    }
  } catch (err) {
    authMsg(translateAuthError(err), 'err');
  } finally { btn.disabled = false; }
}

async function askNewPassword(title = 'Criar nova senha') {
  const pw = await dialog({
    title,
    html: `<p>Escolha uma senha com pelo menos 8 caracteres.</p><div class="auth-field"><label for="np1">Nova senha</label><input type="password" id="np1" autocomplete="new-password"></div><div class="auth-field"><label for="np2">Repita a senha</label><input type="password" id="np2" autocomplete="new-password"></div><div class="auth-msg" id="np-msg"></div>`,
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Salvar senha', kind: 'primary', value: (box) => box.querySelector('#np1').value,
      validate: (box) => {
        const a = box.querySelector('#np1').value, b = box.querySelector('#np2').value, m = box.querySelector('#np-msg');
        const fail = (t) => { m.textContent = t; m.className = 'auth-msg show err'; return false; };
        if (a.length < 8) return fail('Use pelo menos 8 caracteres.');
        if (a !== b) return fail('As senhas não são iguais.');
        return true;
      } }],
  });
  if (!pw) return;
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) toast(translateAuthError(error)); else toast('Senha atualizada.');
}

async function ensurePortfolio(userId) {
  const { data, error } = await sb.from('portfolios').select('id, created_at').eq('user_id', userId).order('created_at', { ascending: true }).limit(1);
  if (error) throw error;
  if (data && data.length) return data[0].id;
  const { data: created, error: e2 } = await sb.from('portfolios').insert({ user_id: userId, name: 'Minha carteira' }).select('id').single();
  if (e2) throw e2;
  return created.id;
}

async function loadState() {
  const { data, error } = await sb.from('portfolio_state').select('state, updated_at').eq('portfolio_id', portfolioId).maybeSingle();
  if (error) throw error; // NUNCA cai para a carteira padrão se a leitura falhar
  if (data && data.state) {
    const before = Number(data.state.version) || 0;
    state = migrateState(data.state);
    lastUpdatedAt = data.updated_at;
    stateLoaded = true;
    if (before !== state.version) scheduleSave(); // grava a carteira já no formato novo
  } else {
    state = defaultState();
    const nowIso = new Date().toISOString();
    const { data: ins, error: e2 } = await sb.from('portfolio_state').upsert({ portfolio_id: portfolioId, state, updated_at: nowIso }).select('updated_at').single();
    if (e2) throw e2;
    lastUpdatedAt = ins.updated_at;
    stateLoaded = true;
  }
  activeAtivosClassId = state.classes.find((c) => hasAssets(c))?.id || null;
}

async function onAuthed(u) {
  if (!u || booting) return;
  if (booted && user && user.id === u.id) return;
  booting = true;
  try { await bootFor(u); } finally { booting = false; }
}
async function bootFor(u) {
  user = u;
  $('auth-screen').style.display = 'none';
  showBoot('Abrindo sua carteira…', 'Carregando seus dados com segurança.');
  try {
    portfolioId = await ensurePortfolio(u.id);
    await loadState();
  } catch (e) {
    console.error(e);
    stateLoaded = false;
    showBoot('Não foi possível abrir a carteira', 'Verifique sua conexão. Seus dados estão seguros — nada foi alterado.', {
      spinner: false, actions: '<button class="btn btn-primary" id="btn-retry-boot">Tentar de novo</button> <button class="btn" id="btn-boot-logout">Sair</button>' });
    $('btn-retry-boot').onclick = () => { booted = false; setTimeout(() => onAuthed(u), 0); };
    $('btn-boot-logout').onclick = () => sb.auth.signOut();
    return;
  }
  booted = true;
  $('sidebar-user').textContent = u.email || '';
  $('account-email').textContent = u.email || '—';
  hideBoot();
  $('app-root').style.display = '';
  await loadMarketFromDb();
  switchTab(activeTab);
  renderTopbar();
  syncTrackedTickers();
  refreshSentimentCache().then(() => { if (activeTab === 'ativos') renderAtivos(); renderTopbar(); });
  const ages = trackedTickers(state).map((t) => quotes[quoteKey(t.source, t.ticker)]?.updated_at).map((x) => (x ? Date.now() - new Date(x).getTime() : Infinity));
  if (ages.some((a) => a > QUOTE_MAX_AGE_MS)) refreshQuotes();
  else lastQuoteRefresh = Date.now();
}

function resetSession() {
  user = null; portfolioId = null; state = null; stateLoaded = false; lastUpdatedAt = null; conflict = false;
  booted = false; lastPlan = null; lastSyncedTickers = null; quotes = {}; failedQuoteKeys = new Set();
}

// ---------------------------------------------------------------------
// Salvamento (com proteção contra edição em dois aparelhos)
// ---------------------------------------------------------------------
let saveTimer = null, saving = false, saveQueued = false, dirty = false;
function scheduleSave() {
  if (!stateLoaded || conflict) return;
  if (state?.undo) state.undo.after = (Number(state.undo.after) || 0) + 1; // mudanças feitas depois do ponto de desfazer
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}
async function saveNow() {
  if (!stateLoaded || conflict) return;
  if (saving) { saveQueued = true; return; }
  saving = true;
  try {
    const { data: cur, error: e1 } = await sb.from('portfolio_state').select('updated_at').eq('portfolio_id', portfolioId).maybeSingle();
    if (e1) throw e1;
    if (cur && lastUpdatedAt && Date.parse(cur.updated_at) !== Date.parse(lastUpdatedAt)) { await handleConflict(cur.updated_at); return; }
    const nowIso = new Date().toISOString();
    const { data, error } = await sb.from('portfolio_state').upsert({ portfolio_id: portfolioId, state, updated_at: nowIso }).select('updated_at').single();
    if (error) throw error;
    lastUpdatedAt = data.updated_at;
    dirty = false;
    syncTrackedTickers();
  } catch (e) {
    console.error('Falha ao salvar', e);
    toast('Não consegui salvar agora — vou tentar de novo em instantes.');
    clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 5000);
  } finally {
    saving = false;
    if (saveQueued) { saveQueued = false; saveNow(); }
  }
}
async function handleConflict(remoteUpdatedAt) {
  conflict = true;
  const choice = await dialog({
    title: 'Carteira alterada em outro lugar',
    html: '<p>Sua carteira foi salva em outro aparelho ou aba depois que você abriu esta tela. Para não perder nada, recarregue para ver a versão mais recente.</p>',
    buttons: [{ label: 'Manter a desta tela', value: 'mine' }, { label: 'Recarregar (recomendado)', kind: 'primary', value: 'reload' }],
  });
  if (choice === 'mine') { conflict = false; lastUpdatedAt = remoteUpdatedAt; saveNow(); }
  else location.reload();
}
window.addEventListener('beforeunload', (e) => { if (dirty || saving) { saveNow(); e.preventDefault(); e.returnValue = ''; } });

async function syncTrackedTickers() {
  if (!stateLoaded) return;
  const keys = [...new Set(trackedTickers(state).map((t) => quoteKey(t.source, t.ticker)))].sort();
  const sig = keys.join(',');
  if (sig === lastSyncedTickers) return;
  try {
    const { error: e1 } = await sb.from('tracked_tickers').delete().eq('portfolio_id', portfolioId);
    if (e1) throw e1;
    if (keys.length) { const { error: e2 } = await sb.from('tracked_tickers').insert(keys.map((k) => ({ portfolio_id: portfolioId, ticker: k }))); if (e2) throw e2; }
    lastSyncedTickers = sig;
  } catch (e) { console.error('Falha ao sincronizar tickers', e); }
}

// ---------------------------------------------------------------------
// Cotações
// ---------------------------------------------------------------------
function applyQuoteRows(rows) {
  (rows || []).forEach((r) => { quotes[r.ticker] = { price: Number(r.price), currency: r.currency || 'BRL', change_percent: r.change_percent == null ? null : Number(r.change_percent), updated_at: r.updated_at }; });
}
function applyFxRows(rows) {
  (rows || []).forEach((r) => {
    const cur = String(r.pair || '').split('-')[0];
    const v = Number(r.ask_price);
    if (cur && v > 0) { fxAuto[cur] = v; fxUpdatedAt[cur] = r.updated_at; }
  });
}
async function loadMarketFromDb() {
  const keys = trackedTickers(state).map((t) => quoteKey(t.source, t.ticker));
  try {
    for (let i = 0; i < keys.length; i += 100) {
      const { data, error } = await sb.from('ticker_quotes').select('ticker, price, currency, change_percent, updated_at').in('ticker', keys.slice(i, i + 100));
      if (error) throw error;
      applyQuoteRows(data);
    }
    const { data: fx, error: e2 } = await sb.from('exchange_rates').select('*');
    if (e2) throw e2;
    applyFxRows(fx);
  } catch (e) { console.error('Falha ao ler cotações', e); }
}
async function refreshQuotes({ silent = true } = {}) {
  if (quotesRefreshing || !stateLoaded) return;
  quotesRefreshing = true; quoteRefreshError = false; renderQuoteChip();
  const items = trackedTickers(state);
  const forUser = user?.id;
  try {
    const failed = new Set();
    for (let i = 0; i < Math.max(1, items.length); i += 100) {
      const { data, error } = await sb.functions.invoke('price-refresh', { body: { items: items.slice(i, i + 100) } });
      if (!stateLoaded || user?.id !== forUser) return; // saiu da conta enquanto buscava
      if (error) throw error;
      if (!data || data.ok !== true) throw new Error(data?.error || 'resposta inválida');
      applyQuoteRows(data.quotes);
      applyFxRows(data.fx);
      (data.failed || []).forEach((f) => { const [src, t] = String(f).split(':'); failed.add(quoteKey(src, t)); });
    }
    failedQuoteKeys = failed;
    lastQuoteRefresh = Date.now();
    if (!silent) toast(failed.size ? `Cotações atualizadas. ${failed.size} ticker(s) sem cotação — veja em Ativos.` : 'Cotações atualizadas.');
  } catch (e) {
    console.error('Falha ao atualizar cotações', e);
    quoteRefreshError = true;
    if (!silent) toast('Não foi possível atualizar as cotações agora. Usando as últimas conhecidas.');
  } finally {
    quotesRefreshing = false;
    renderAfterMarketChange();
  }
}
function renderAfterMarketChange() {
  if (!state || !stateLoaded) { renderQuoteChip(); return; }
  renderTopbar();
  if (activeTab === 'painel') renderPainel();
  if (activeTab === 'ativos') renderAtivos();
  if (activeTab === 'aporte') { renderReady(); if (lastPlan) $('resultado-container').innerHTML = '<div class="msg-box warn">As cotações mudaram. Calcule de novo para ver a ordem com os preços atuais.</div>'; lastPlan = null; }
  if (activeTab === 'config') renderFxCards();
}
setInterval(() => { if (stateLoaded && document.visibilityState === 'visible' && Date.now() - lastQuoteRefresh > QUOTE_REFRESH_EVERY_MS) refreshQuotes(); }, 60000);
document.addEventListener('visibilitychange', () => { if (stateLoaded && document.visibilityState === 'visible' && Date.now() - lastQuoteRefresh > QUOTE_REFRESH_EVERY_MS) refreshQuotes(); });

function newestQuoteTime() {
  let best = 0;
  trackedTickers(state || { classes: [] }).forEach((t) => { const q = quotes[quoteKey(t.source, t.ticker)]; if (q?.updated_at) best = Math.max(best, new Date(q.updated_at).getTime()); });
  return best ? new Date(best).toISOString() : null;
}
function renderQuoteChip() {
  const chip = $('quote-chip'); if (!chip || !state) return;
  const txt = $('quote-chip-txt');
  chip.classList.remove('busy', 'stale', 'off');
  if (quotesRefreshing) { chip.classList.add('busy'); txt.textContent = 'Atualizando…'; return; }
  const t = newestQuoteTime();
  if (!t) { chip.classList.add('off'); txt.textContent = quoteRefreshError ? 'Indisponível' : 'Sem cotações'; return; }
  const age = Date.now() - new Date(t).getTime();
  if (quoteRefreshError || age > 3 * 24 * 3600e3) chip.classList.add('off');
  else if (age > 60 * 60e3) chip.classList.add('stale');
  txt.textContent = ago(t);
}

async function refreshSentimentCache() {
  const tickers = [...new Set(trackedTickers(state).map((t) => t.ticker))];
  if (!tickers.length) return;
  try {
    const { data, error } = await sb.from('ticker_sentiment').select('*').in('ticker', tickers).order('checked_at', { ascending: false });
    if (error) throw error;
    sentimentCache = {};
    (data || []).forEach((r) => { if (!sentimentCache[r.ticker]) sentimentCache[r.ticker] = r; });
  } catch (e) { console.error('Falha ao ler leitura de mercado', e); }
}

// ---------------------------------------------------------------------
// Navegação
// ---------------------------------------------------------------------
const TABS = ['painel', 'aporte', 'ativos', 'config', 'agenda', 'timeline'];
function switchTab(tab) {
  if (!TABS.includes(tab)) tab = 'painel';
  activeTab = tab;
  document.querySelectorAll('.nav-btn').forEach((b) => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'); });
  TABS.forEach((t) => { $('tab-' + t).hidden = t !== tab; });
  window.scrollTo(0, 0);
  if (tab === 'painel') renderPainel();
  if (tab === 'aporte') renderAporteTab();
  if (tab === 'ativos') renderAtivos();
  if (tab === 'config') renderConfig();
  if (tab === 'agenda') renderAgenda();
  if (tab === 'timeline') renderTimeline();
  try { history.replaceState(null, '', '#' + tab); } catch { /* sem histórico */ }
}

// ---------------------------------------------------------------------
// Topo
// ---------------------------------------------------------------------
function portfolioTermometro() {
  let totalW = 0, sum = 0;
  state.classes.forEach((c) => {
    if (!hasAssets(c)) return;
    const r = fxRate(classCurrency(c), fxCtx()) ?? 0;
    c.assets.forEach((a) => {
      const v = assetValue(c, a, quotes) * r;
      if (a.termometro && a.termometro.nota !== null && v > 0) { sum += a.termometro.nota * v; totalW += v; }
    });
  });
  return totalW > 0 ? Math.round(sum / totalW) : null;
}
function termLabel(nota) {
  if (nota === null || nota === undefined) return { label: 'Sem avaliação', color: 'var(--text-faint)' };
  if (nota >= 85) return { label: 'Excelente', color: 'var(--teal)' };
  if (nota >= 70) return { label: 'Boa', color: 'var(--brass)' };
  if (nota >= 50) return { label: 'Atenção', color: 'var(--amber)' };
  return { label: 'Revisar', color: 'var(--coral)' };
}
function renderTopbar() {
  if (!state) return;
  const total = portfolioTotalBRL(state, quotes, fxCtx());
  const intPart = Math.floor(total + 1e-9);
  const cent = String(Math.round((total - intPart) * 100)).padStart(2, '0').slice(0, 2);
  $('patrimonio-total').innerHTML = 'R$ ' + intPart.toLocaleString('pt-BR') + '<span class="cents">,' + cent + '</span>';
  $('meta-ativos').textContent = state.classes.reduce((s, c) => s + (hasAssets(c) ? c.assets.length : 0), 0);
  const term = portfolioTermometro();
  const tl = termLabel(term);
  $('meta-term').innerHTML = `<span class="term-pill" style="background:${term === null ? 'var(--surface-2)' : 'color-mix(in srgb, ' + tl.color + ' 18%, transparent)'}; color:${tl.color};"><span class="tdot" style="background:${tl.color};"></span>${term === null ? '—' : term + '/100 · ' + tl.label}</span>`;
  renderQuoteChip();
  const next = nextAporteDate(state.agenda);
  const el = $('sidebar-next-aporte-val');
  if (!next) el.textContent = state.agenda.frequency === 'personalizado' ? (state.agenda.customNote || 'Personalizado') : '—';
  else { const today = new Date(); today.setHours(0, 0, 0, 0); const d = Math.round((next - today) / 86400000); el.textContent = d <= 0 ? 'Hoje' : d === 1 ? 'Amanhã' : `em ${d} dias`; }
}

// ---------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];
const classColor = (idx) => (idx < SERIES.length ? SERIES[idx] : 'var(--text-faint)');
function niceMax(v) { if (v <= 0) return 100; const raw = v / 4; const p = Math.pow(10, Math.floor(Math.log10(raw))); const n = raw / p; const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10; return m * p * 4; }
const chartW = () => (window.innerWidth < 640 ? 360 : 600);
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function attachTips(root) {
  root.querySelectorAll('.chart-wrap').forEach((wrap) => {
    const tip = wrap.querySelector('.chart-tip');
    if (!tip) return;
    const show = (el) => {
      tip.innerHTML = el.getAttribute('data-tip');
      const r = wrap.getBoundingClientRect();
      let x, y;
      if (el.hasAttribute('data-tx')) { const svg = wrap.querySelector('svg'); const k = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width; x = parseFloat(el.getAttribute('data-tx')) * k; y = parseFloat(el.getAttribute('data-ty')) * k; }
      else { const er = el.getBoundingClientRect(); x = er.left - r.left + er.width / 2; y = er.top - r.top; }
      x = Math.max(70, Math.min(r.width - 70, x));
      tip.style.left = x + 'px'; tip.style.top = y + 'px'; tip.classList.add('show');
    };
    wrap.querySelectorAll('[data-tip]').forEach((el) => {
      el.addEventListener('mouseenter', () => show(el));
      el.addEventListener('click', () => show(el));
      el.addEventListener('mouseleave', () => tip.classList.remove('show'));
    });
  });
}
function lineChartSVG(points, opts) {
  const W = chartW(), H = W < 600 ? 250 : 230, L = 58, R = 14, T = 14, B = 28;
  const iw = W - L - R, ih = H - T - B;
  const maxV = niceMax(Math.max(...points.flatMap((p) => p.ys.filter((v) => v != null))));
  const n = points.length;
  const xAt = (i) => L + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const yAt = (v) => T + ih - (v / maxV) * ih;
  let g = '';
  for (let k = 0; k <= 4; k++) { const v = (maxV * k) / 4, y = yAt(v); g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="${k === 0 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/><text x="${L - 8}" y="${y + 3.5}" text-anchor="end">${compact(v)}</text>`; }
  const labelIdx = n <= 1 ? [0] : n === 2 ? [0, 1] : [0, Math.floor((n - 1) / 2), n - 1];
  labelIdx.forEach((i) => { g += `<text x="${xAt(i)}" y="${H - 8}" text-anchor="${n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle'}">${points[i].x}</text>`; });
  opts.series.forEach((s, si) => {
    const pts = points.map((p, i) => (p.ys[si] == null ? null : [xAt(i), yAt(p.ys[si])])).filter(Boolean);
    if (!pts.length) return;
    if (si === 0 && pts.length > 1) g += `<path d="M${pts[0][0]},${T + ih} L${pts.map((p) => p.join(',')).join(' L')} L${pts[pts.length - 1][0]},${T + ih} Z" fill="${s.color}" opacity=".12"/>`;
    if (pts.length > 1) g += `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = pts[pts.length - 1];
    g += `<circle cx="${last[0]}" cy="${last[1]}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
  });
  const band = n === 1 ? iw : iw / (n - 1);
  points.forEach((p, i) => {
    const tipHtml = `<div class="t">${esc(p.full || p.x)}</div>` + opts.series.map((s, si) => (p.ys[si] == null ? '' : `<div><span class="swatch" style="display:inline-block;background:${s.color};margin-right:6px;"></span>${esc(s.name)}: <span class="num">R$ ${n2(p.ys[si])}</span></div>`)).join('');
    const top = Math.min(...p.ys.filter((v) => v != null).map(yAt));
    g += `<g class="hov"><line x1="${xAt(i)}" x2="${xAt(i)}" y1="${T}" y2="${T + ih}" stroke="var(--border-strong)" stroke-width="1" opacity="0"/><rect x="${xAt(i) - band / 2}" y="${T}" width="${band}" height="${ih}" fill="transparent" data-tip='${tipHtml.replace(/'/g, '&#39;')}' data-tx="${xAt(i)}" data-ty="${top}"/></g>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria)}">${g}</svg>`;
}
function barChartSVG(bars, color, aria) {
  const W = chartW(), H = W < 600 ? 220 : 200, L = 58, R = 10, T = 14, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const maxV = niceMax(Math.max(...bars.map((b) => b.v), 1));
  const slot = iw / bars.length, bw = Math.max(6, Math.min(28, slot - 4));
  const yAt = (v) => T + ih - (v / maxV) * ih;
  let g = '';
  for (let k = 0; k <= 4; k++) { const v = (maxV * k) / 4, y = yAt(v); g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="${k === 0 ? 'var(--axis)' : 'var(--grid)'}"/><text x="${L - 8}" y="${y + 3.5}" text-anchor="end">${compact(v)}</text>`; }
  bars.forEach((b, i) => {
    const cx = L + slot * i + slot / 2, x = cx - bw / 2;
    if (b.v > 0) { const h = Math.max(2, (b.v / maxV) * ih), y = T + ih - h, r = Math.min(4, h / 2, bw / 2); g += `<path d="M${x},${T + ih} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${T + ih} Z" fill="${color}"/>`; }
    if (W >= 600 || i % 2 === (bars.length - 1) % 2) g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${b.label}</text>`;
    g += `<rect x="${L + slot * i}" y="${T}" width="${slot}" height="${ih}" fill="transparent" data-tip='<div class="t">${b.full}</div><span class="num">R$ ${n2(b.v)}</span>' data-tx="${cx}" data-ty="${yAt(b.v)}"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${g}</svg>`;
}

function renderPainel() {
  const c = $('painel-container');
  const fx = fxCtx();
  const total = portfolioTotalBRL(state, quotes, fx);
  const aportes = [...state.aportes].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const totalAportado = aportes.reduce((s, a) => s + (Number(a.disponivel) || 0), 0);
  const proventos = state.dividendos.reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const rows = state.classes.map((cl, idx) => { const v = classValueBRL(cl, quotes, fx) || 0; return { cl, idx, v, cur: total > 0 ? (v / total) * 100 : 0, ideal: Number(cl.idealPct) || 0 }; });
  const align = total > 0 ? alignmentScore(rows.map((r) => ({ idealPct: r.ideal, currentPct: r.cur }))) : null;
  const ano = String(new Date().getFullYear());
  const provAno = state.dividendos.filter((d) => String(d.date || '').startsWith(ano)).reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const alignColor = align === null ? 'var(--text-faint)' : align >= 90 ? 'var(--teal)' : align >= 75 ? 'var(--amber)' : 'var(--coral)';
  let html = `<div class="kpi-grid">
    <div class="kpi"><div class="k">Patrimônio</div><div class="v">${compact(total)}</div><div class="s num">R$ ${n2(total)}</div></div>
    <div class="kpi"><div class="k">Total aportado</div><div class="v">${compact(totalAportado)}</div><div class="s">${aportes.length} aporte${aportes.length === 1 ? '' : 's'} registrado${aportes.length === 1 ? '' : 's'}</div></div>
    <div class="kpi"><div class="k">Proventos recebidos</div><div class="v">${compact(proventos)}</div><div class="s">R$ ${n2(provAno)} em ${ano}</div></div>
    <div class="kpi"><div class="k">Alinhamento com o plano</div><div class="v" style="color:${alignColor}">${align === null ? '—' : pct1(align) + '%'}</div><div class="s">${align === null ? 'Cadastre suas quantidades para medir' : align >= 90 ? 'Carteira próxima do ideal' : align >= 75 ? 'Alguns ajustes pendentes' : 'Carteira longe do plano'}</div></div>
  </div>`;
  let distHtml;
  if (total <= 0) {
    distHtml = '<div class="panel-empty">Sua carteira ainda está zerada. Informe quantas cotas você tem em <b>Ativos</b> (os preços vêm sozinhos) — ou faça seu primeiro aporte.<br><button class="btn btn-sm" data-goto="ativos">Ir para Ativos</button> <button class="btn btn-sm" data-goto="aporte">Fazer um aporte</button></div>';
  } else {
    const segs = rows.filter((r) => r.v > 0).map((r) => `<div class="comp-seg" style="flex:${r.v} 1 0; background:${classColor(r.idx)};" data-tip='<div class="t">${esc(r.cl.name).replace(/'/g, '&#39;')}</div><span class="num">${pct1(r.cur)}%</span> · R$ ${n2(r.v)}'></div>`).join('');
    const list = rows.map((r) => {
      const gap = (r.ideal / 100) * total - r.v;
      const gapTxt = Math.abs(gap) < total * 0.005 ? '<span class="lbl">no alvo</span><span style="color:var(--teal)">✓</span>'
        : gap > 0 ? `<span class="lbl">faltam</span><span style="color:var(--text)">R$ ${n2(gap)}</span>` : `<span class="lbl">acima</span><span style="color:var(--text-muted)">R$ ${n2(-gap)}</span>`;
      return `<div class="alloc-row"><div class="alloc-name"><span class="swatch" style="background:${classColor(r.idx)}"></span><span>${esc(r.cl.name)}</span></div>
        <div class="alloc-bar"><div class="ledger-bar" style="margin:0 0 4px;"><div class="ledger-bar-fill" style="width:${Math.min(100, r.cur)}%; background:${classColor(r.idx)};"></div><div class="ledger-bar-target" style="left:${Math.min(100, r.ideal)}%"></div></div>
        <div class="rc-pcts" style="margin-top:0;">atual ${pct1(r.cur)}% · ideal ${pct(r.ideal)}%</div></div><div class="alloc-gap">${gapTxt}</div></div>`;
    }).join('');
    distHtml = `<div class="chart-wrap"><div class="comp-bar">${segs}</div><div class="chart-tip"></div></div>${list}<div class="legend"><span><span style="display:inline-block;width:2px;height:12px;background:var(--brass);"></span>Marca dourada = percentual ideal</span></div>`;
  }
  let evoHtml;
  if (!aportes.length) evoHtml = '<div class="panel-empty">Nenhum aporte registrado ainda. Cada aporte registrado vira um ponto neste gráfico.<br><button class="btn btn-sm" data-goto="aporte">Fazer um aporte</button></div>';
  else {
    const byDay = {}; let acc = 0;
    aportes.forEach((a) => { acc += Number(a.disponivel) || 0; byDay[a.date] = { acc, pat: a.patrimonioDepois != null ? Number(a.patrimonioDepois) : (byDay[a.date] ? byDay[a.date].pat : null) }; });
    const days = Object.keys(byDay).sort();
    const pts = days.map((d) => { const [y, m, dd] = d.split('-'); return { x: `${dd}/${m}/${y.slice(2)}`, full: fmtDateBR(d), ys: [byDay[d].acc, byDay[d].pat] }; });
    const hasPat = pts.some((p) => p.ys[1] != null);
    const series = [{ name: 'Total aportado', color: 'var(--series-1)' }];
    if (hasPat) series.push({ name: 'Patrimônio após o aporte', color: 'var(--brass)' }); else pts.forEach((p) => { p.ys = [p.ys[0]]; });
    evoHtml = `<div class="chart-wrap">${lineChartSVG(pts, { series, aria: 'Evolução do total aportado' })}<div class="chart-tip"></div></div>${series.length > 1 ? `<div class="legend">${series.map((s) => `<span><span class="swatch" style="background:${s.color}"></span>${s.name}</span>`).join('')}</div>` : ''}`;
  }
  let provHtml;
  if (!state.dividendos.length) provHtml = '<div class="panel-empty">Nenhum provento registrado. Registre dividendos, JCP e rendimentos em <b>Histórico</b>.<br><button class="btn btn-sm" data-goto="timeline">Registrar provento</button></div>';
  else {
    const now = new Date(); const bars = [];
    for (let k = 11; k >= 0; k--) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const v = state.dividendos.filter((x) => String(x.date || '').startsWith(key)).reduce((s, x) => s + (Number(x.valor) || 0), 0);
      bars.push({ label: MESES[d.getMonth()], full: MESES[d.getMonth()] + '/' + d.getFullYear(), v });
    }
    const last12 = bars.reduce((s, b) => s + b.v, 0);
    provHtml = `<div class="chart-wrap">${barChartSVG(bars, 'var(--series-3)', 'Proventos por mês nos últimos 12 meses')}<div class="chart-tip"></div></div><div class="legend"><span>Últimos 12 meses: <b class="num" style="color:var(--text);">R$ ${n2(last12)}</b></span><span>Média mensal: <b class="num" style="color:var(--text);">R$ ${n2(last12 / 12)}</b></span></div>`;
  }
  const all = [];
  state.classes.forEach((cl) => { if (!hasAssets(cl)) return; const r = fxRate(classCurrency(cl), fx) ?? 0; cl.assets.forEach((a) => { const v = assetValue(cl, a, quotes) * r; if (v > 0) all.push({ t: a.ticker, c: cl.name, v }); }); });
  all.sort((x, y) => y.v - x.v);
  const top = all.slice(0, 6);
  const topHtml = !top.length ? '<div class="panel-empty">Sem posições com valor ainda.</div>'
    : top.map((p) => `<div class="top-row"><div><span class="tk">${esc(p.t)}</span><span class="cl">${esc(p.c)}</span></div><div class="vl">R$ ${n2(p.v)} <span style="color:var(--text-faint); font-size:11px;">${pct1((p.v / total) * 100)}%</span></div><div class="mini"><div style="width:${Math.min(100, (p.v / top[0].v) * 100)}%"></div></div></div>`).join('');
  html += `<div class="panel-grid"><div class="panel-stack">
      <div class="card"><h3 class="card-title">Distribuição atual × plano</h3><p class="card-sub">Quanto cada classe pesa hoje e quanto falta para chegar ao percentual ideal.</p>${distHtml}</div>
      <div class="card"><h3 class="card-title">Evolução dos aportes</h3><p class="card-sub">Soma acumulada de tudo que você já aportou${aportes.some((a) => a.patrimonioDepois != null) ? ' e o patrimônio logo após cada aporte' : ''}.</p>${evoHtml}</div>
    </div><div class="panel-stack">
      <div class="card"><h3 class="card-title">Proventos por mês</h3><p class="card-sub">Dividendos, JCP e rendimentos dos últimos 12 meses.</p>${provHtml}</div>
      <div class="card"><h3 class="card-title">Maiores posições</h3><p class="card-sub">Os ativos com mais dinheiro na carteira.</p>${topHtml}</div>
    </div></div>`;
  c.innerHTML = html;
  c.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.goto)));
  attachTips(c);
}
let resizeT = null;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (state && activeTab === 'painel') renderPainel(); }, 200); });

// ---------------------------------------------------------------------
// Aporte
// ---------------------------------------------------------------------
function readiness() {
  const errors = validateForPlan(state, market());
  const missing = []; const stale = []; let priced = 0, needPrice = 0;
  state.classes.forEach((c) => {
    if (!hasAssets(c) || buyMode(c) === 'valor' || !(Number(c.idealPct) > 0)) return;
    c.assets.forEach((a) => {
      if (!(Number(a.idealPct) > 0)) return;
      needPrice++;
      const p = assetPrice(c, a, quotes);
      if (p.price > 0) { priced++; if (p.source === 'cache') stale.push(normTicker(a.ticker)); } else missing.push(normTicker(a.ticker) || '(sem ticker)');
    });
  });
  return { errors, missing, stale, priced, needPrice };
}
function renderReady() {
  const r = readiness();
  const items = [];
  const sumC = sumIdeal(state.classes);
  items.push(isHundred(sumC) ? { k: 'ok', t: `Classes somam <b>100%</b>.` } : { k: 'bad', t: `Classes somam <b>${pct(sumC)}%</b> — precisa ser 100%. <button class="link-btn act" data-goto="config">Ajustar</button>` });
  const assetErrs = r.errors.filter((e) => e.code === 'soma_ativos' || e.code === 'classe_vazia');
  if (assetErrs.length) assetErrs.forEach((e) => items.push({ k: 'bad', t: esc(e.msg) + ' <button class="link-btn act" data-goto="ativos">Ajustar</button>' }));
  else items.push({ k: 'ok', t: 'Ativos de cada classe somam <b>100%</b>.' });
  const cashErr = r.errors.find((e) => e.code.startsWith('caixa') || e.code === 'sem_caixa');
  items.push(cashErr ? { k: 'bad', t: esc(cashErr.msg) + ' <button class="link-btn act" data-goto="config">Ajustar</button>' } : { k: 'ok', t: `Caixa de Oportunidade: <b>${esc(state.classes.find((c) => c.isCash)?.name || '')}</b>.` });
  r.errors.filter((e) => e.code === 'sem_cambio').forEach((e) => items.push({ k: 'bad', t: esc(e.msg) }));
  if (r.needPrice > 0) {
    if (!r.missing.length) items.push({ k: 'ok', t: `Todos os <b>${r.priced}</b> ativos com preço${newestQuoteTime() ? ` (cotações ${ago(newestQuoteTime())})` : ''}.` });
    else items.push({ k: 'warn', t: `<b>${r.missing.length}</b> de ${r.needPrice} ativos sem preço — eles ficam fora da compra e a parte deles vai para os outros ativos da classe (ou para o Caixa). <button class="link-btn act" data-refresh="1">Atualizar cotações</button> <button class="link-btn act" data-goto="ativos">Ver em Ativos</button><div class="tick-list">${r.missing.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` });
  }
  $('ready-card').innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap;"><h3 class="card-title" style="margin:0;">Antes de calcular</h3>${quotesRefreshing ? '<span class="quote-chip busy"><span class="qdot"></span>Atualizando cotações…</span>' : ''}</div><div class="ready-list">${items.map((i) => `<div class="ready-item ${i.k}"><span class="ic">${i.k === 'ok' ? '✓' : i.k === 'warn' ? '!' : '×'}</span><div>${i.t}</div></div>`).join('')}</div>`;
  $('ready-card').querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.goto)));
  $('ready-card').querySelectorAll('[data-refresh]').forEach((b) => b.addEventListener('click', () => refreshQuotes({ silent: false })));
}
function renderAporteTab() { renderReady(); if (lastPlan) renderResultado(); }

function calcular() {
  const valor = parseNum($('aporte-valor').value);
  const cont = $('resultado-container');
  lastPlan = null;
  if (!(valor > 0)) { cont.innerHTML = '<div class="msg-box err">Informe um valor de aporte maior que zero.</div>'; $('aporte-valor').focus(); return; }
  if (valor > 100000000) { cont.innerHTML = '<div class="msg-box err">Valor alto demais — confira se digitou certo.</div>'; return; }
  let plan;
  try { plan = planAporte(state, valor, market()); } catch (e) {
    console.error(e);
    cont.innerHTML = `<div class="msg-box err"><h3>Cálculo interrompido por segurança</h3>${esc(e.message)}<br>Nada foi registrado. Exporte um backup em Configuração e me envie se o problema continuar.</div>`;
    return;
  }
  if (!plan.ok) {
    cont.innerHTML = `<div class="msg-box err"><h3>Corrija antes de calcular</h3><ul>${plan.errors.map((e) => `<li>${esc(e.msg)}</li>`).join('')}</ul></div>`;
    return;
  }
  lastPlan = { plan, valor, obs: $('aporte-obs').value.trim(), at: Date.now() };
  renderResultado();
  cont.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function orderLines(plan) {
  const lines = [];
  plan.orders.forEach((o) => {
    if (o.mode === 'lote') lines.push(`Comprar ${o.qty} ${o.ticker} a ${priceTxt(o.price, o.currency)} = ${moneyC(o.valueNative, o.currency)}`);
    else if (o.mode === 'fracao') lines.push(`Comprar ${moneyC(o.valueNative, o.currency)} de ${o.ticker} (≈ ${qtyTxt(o.qty, 'fracao')})`);
    else lines.push(`Aplicar ${moneyC(o.valueNative, o.currency)} em ${o.ticker}`);
  });
  plan.classes.filter((c) => c.directBRL > 0 && !c.isCash).forEach((c) => lines.push(`Reservar ${moneyC(c.directNative, c.currency)} em ${c.name}`));
  const cash = plan.toCash + plan.cashDirect;
  if (cash > 0) lines.push(`Caixa de Oportunidade: ${moneyC(cash)}`);
  return lines;
}

function renderResultado() {
  const cont = $('resultado-container');
  if (!lastPlan) { cont.innerHTML = ''; return; }
  const { plan } = lastPlan;
  const lote = plan.orders.filter((o) => o.mode === 'lote');
  const frac = plan.orders.filter((o) => o.mode === 'fracao');
  const valor = plan.orders.filter((o) => o.mode === 'valor');
  const src = (o) => `<span class="src-pill ${o.priceSource}">${{ auto: 'auto', cache: 'última', manual: 'manual', none: '' }[o.priceSource] || ''}</span>`;
  const row = (left, sub, right, badge = '') => `<div class="order-item"><div class="oi-left"><div><div class="oi-ticker">${left}${badge}</div>${sub ? `<div class="oi-sub">${sub}</div>` : ''}</div></div><div class="oi-right"><div class="oi-val">${right}</div></div></div>`;
  let html = '';
  if (plan.warnings.length) html += `<div class="msg-box warn"><h3>Atenção</h3><ul>${plan.warnings.map((w) => `<li>${esc(w.msg)}</li>`).join('')}</ul></div>`;
  html += '<div class="order-card"><div class="order-title">🧾 Ordem de compra sugerida</div>';
  if (lote.length) html += `<div class="order-section-title">Comprar na bolsa (cotas inteiras)</div><div class="order-list">${lote.map((o) => row(`<span class="oi-qty" style="min-width:0; margin-right:8px;">${o.qty}×</span>${esc(o.ticker)}`, `${esc(o.className)} · ${priceTxt(o.price, o.currency)}${src(o)}${o.complemento ? ' · com a sobra' : ''}`, moneyC(o.valueNative, o.currency) + (o.currency !== 'BRL' ? `<div class="oi-sub">≈ ${moneyC(o.valueBRL)}</div>` : ''), ` <span class="priority-badge ${o.priority >= 70 ? '' : o.priority >= 40 ? 'mid' : 'low'}" title="Distância da meta: 100 = o mais longe da classe">prior. ${o.priority}</span>`)).join('')}</div>`;
  if (frac.length) html += `<div class="order-section-title">Comprar valor exato</div><div class="order-list">${frac.map((o) => row(esc(o.ticker), `${esc(o.className)} · ≈ ${qtyTxt(o.qty, 'fracao')} a ${priceTxt(o.price, o.currency)}${src(o)}`, moneyC(o.valueNative, o.currency) + (o.currency !== 'BRL' ? `<div class="oi-sub">≈ ${moneyC(o.valueBRL)}</div>` : ''))).join('')}</div>`;
  if (valor.length) html += `<div class="order-section-title">Aplicar</div><div class="order-list">${valor.map((o) => row(esc(o.ticker), esc(o.className), moneyC(o.valueNative, o.currency))).join('')}</div>`;
  const directs = plan.classes.filter((c) => c.directBRL > 0 && !c.isCash);
  if (directs.length) html += `<div class="order-section-title">Reservar</div><div class="order-list">${directs.map((c) => row(esc(c.name), 'valor direto', moneyC(c.directNative, c.currency))).join('')}</div>`;
  const cashTotal = plan.toCash + plan.cashDirect;
  html += `<div class="order-section-title">Caixa de Oportunidade</div><div class="order-list">${row(esc(state.classes.find((c) => c.isCash)?.name || 'Caixa'), `parte do plano ${moneyC(plan.cashDirect)} + sobras ${moneyC(plan.toCash)}`, moneyC(cashTotal))}</div>`;
  if (!plan.orders.length && !directs.length) html += '<div class="empty-state">Nada pôde ser comprado com este valor — tudo vai para o Caixa de Oportunidade.</div>';
  html += `<div class="order-totals">
    <div><div class="k">Aporte</div><div class="v">${moneyC(plan.aporte)}</div></div>
    <div><div class="k">Comprado / aplicado</div><div class="v">${moneyC(plan.investedBRL + plan.directBRL - plan.cashDirect)}</div></div>
    <div><div class="k">Para o Caixa</div><div class="v" style="color:var(--brass)">${moneyC(cashTotal)}</div></div>
    <div><div class="k">Alinhamento</div><div class="align-compare"><span>${pct1(plan.before)}%</span><span class="align-arrow">→</span><span class="align-after">${pct1(plan.after)}%</span></div></div>
  </div>
  <div class="order-footer2"><div class="order-actions"><button class="btn" id="btn-copy-order">Copiar ordem</button></div><button class="btn btn-primary" id="btn-registrar">Registrar este aporte</button></div></div>`;
  html += plan.classes.map((c) => {
    const idx = state.classes.findIndex((x) => x.id === c.classId);
    const totalBefore = plan.totalBefore;
    const curPct = totalBefore > 0 ? (c.currentBRL / totalBefore) * 100 : 0;
    let body;
    if (c.items.length) {
      body = `<div class="asset-row asset-row-head" style="border-bottom:1px solid var(--border-strong); padding-bottom:8px; margin-bottom:2px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-faint);">Ativo</div><div style="font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-faint);">Atual vs ideal</div>
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-faint); text-align:right;">Preço</div><div style="font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-faint); text-align:right;">Qtd.</div><div style="font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-faint); text-align:right;">Valor</div></div>` +
        c.items.map((it) => {
          const st = { na_meta: '<div class="badge info">no alvo</div>', sem_preco: '<div class="badge skip">sem preço</div>', lote_caro: '<div class="badge warn">cota acima da sobra</div>', abaixo_minimo: '<div class="badge warn">abaixo do mínimo</div>', ok: it.value > 0 ? '<div class="badge done">na ordem</div>' : '' }[it.status] || '';
          return `<div class="asset-row"><div class="asset-ticker">${esc(normTicker(it.a.ticker))}${st}</div>
            <div class="asset-bar"><div class="ledger-bar"><div class="ledger-bar-fill ${it.currentPct >= it.ideal ? 'over' : 'under'}" style="width:${Math.min(100, it.currentPct)}%"></div><div class="ledger-bar-target" style="left:${Math.min(100, it.ideal)}%"></div></div><div class="asset-pcts">atual ${pct1(it.currentPct)}% · ideal ${pct(it.ideal)}%${it.priority ? ' · prioridade ' + it.priority : ''}</div></div>
            <div class="asset-price">${it.mode === 'valor' ? '—' : priceTxt(it.price, c.currency)}</div>
            <div class="asset-qty ${it.qty > 0 ? '' : 'zero'}">${it.mode === 'valor' ? '—' : qtyTxt(it.qty, it.mode)}</div>
            <div class="asset-suggest ${it.value > 0 ? '' : 'zero'}">${moneyC(it.value, c.currency)}</div></div>`;
        }).join('');
    } else body = `<div class="caixa-note">${c.isCash ? 'Sua reserva de Caixa de Oportunidade — recebe a parte do plano e as sobras.' : 'Classe de valor direto — o valor entra direto no saldo dela.'}</div>`;
    return `<div class="result-class"><div class="result-class-head" data-toggle="${esc(c.classId)}"><div class="rc-left"><div class="rc-name"><span class="swatch" style="display:inline-block; background:${classColor(idx)}; margin-right:8px;"></span>${esc(c.name)}</div>
      <div class="rc-bar-wrap"><div class="ledger-bar"><div class="ledger-bar-fill ${curPct >= c.idealPct ? 'over' : 'under'}" style="width:${Math.min(100, curPct)}%"></div><div class="ledger-bar-target" style="left:${Math.min(100, c.idealPct)}%"></div></div><div class="rc-pcts">atual ${pct1(curPct)}% · ideal ${pct(c.idealPct)}%</div></div></div>
      <div class="rc-right"><div class="rc-aporte"><div class="k">Recebe</div><div class="v ${c.allocBRL > 0 ? '' : 'zero'}">${moneyC(c.allocBRL)}</div></div><div class="chev">▸</div></div></div>
      <div class="result-class-body">${body}</div></div>`;
  }).join('');
  cont.innerHTML = html;
  cont.querySelectorAll('[data-toggle]').forEach((h) => h.addEventListener('click', () => { h.nextElementSibling.classList.toggle('open'); h.querySelector('.chev').classList.toggle('open'); }));
  $('btn-registrar').addEventListener('click', registrarAporte);
  $('btn-copy-order').addEventListener('click', async () => {
    const txt = `Aporte+ — ordem de ${fmtDateBR(todayISO())}\nAporte: ${moneyC(plan.aporte)}\n\n` + orderLines(plan).join('\n');
    try { await navigator.clipboard.writeText(txt); toast('Ordem copiada.'); } catch { dialog({ title: 'Copiar ordem', html: `<textarea style="width:100%; height:200px; background:var(--surface-2); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:10px; font-family:IBM Plex Mono, monospace; font-size:12px;">${esc(txt)}</textarea>` }); }
  });
}

async function registrarAporte() {
  if (!lastPlan) return;
  const { plan, obs } = lastPlan;
  if (Date.now() - lastPlan.at > 30 * 60 * 1000) { toast('Este cálculo tem mais de 30 minutos. Calcule de novo antes de registrar.'); return; }
  const ok = await confirmBox('Registrar aporte?', `Vou somar à sua carteira as compras desta ordem (${moneyC(plan.aporte)}). Faça as compras na sua corretora. Se precisar, dá para desfazer depois em Histórico.`, 'Registrar');
  if (!ok) return;
  try {
    const prev = JSON.parse(JSON.stringify({ ...state, undo: undefined }));
    const { state: next, record } = applyPlan(state, plan, market(), { date: todayISO(), obs });
    next.undo = { kind: 'aporte', aporteId: record.id, at: new Date().toISOString(), label: 'aporte de ' + moneyC(plan.aporte), prev, after: -1 };
    state = next;
    lastPlan = null;
    $('aporte-valor').value = ''; $('aporte-obs').value = '';
    $('resultado-container').innerHTML = '';
    scheduleSave();
    renderTopbar(); renderReady();
    toast(`Aporte registrado! Patrimônio: ${money(portfolioTotalBRL(state, quotes, fxCtx()))}.`, { action: { label: 'Desfazer', run: undoLast } });
  } catch (e) {
    console.error(e);
    dialog({ title: 'Não registrado', html: `<p>Nada foi alterado. Motivo: ${esc(e.message)}</p>` });
  }
}

async function undoLast() {
  const u = state?.undo;
  if (!u || !u.prev) { toast('Não há nada para desfazer.'); return; }
  const later = Number(u.after) > 0 ? '<br><br><b>Atenção:</b> as alterações que você fez depois disso também serão desfeitas.' : '';
  const ok = await confirmBox('Desfazer?', `Isso volta a carteira para como estava antes do ${esc(u.label || 'último registro')}.${later}`, 'Desfazer');
  if (!ok) return;
  state = migrateState(u.prev);
  state.undo = null;
  scheduleSave();
  renderTopbar();
  switchTab(activeTab);
  toast('Desfeito.');
}

// ---------------------------------------------------------------------
// Ativos
// ---------------------------------------------------------------------
function quoteHint(c, a) {
  if (buyMode(c) === 'valor') return '';
  const src = quoteSource(c);
  const key = quoteKey(src, a.ticker);
  const q = quotes[key];
  const p = assetPrice(c, a, quotes);
  const t = normTicker(a.ticker);
  if (!t) return '<span class="warn-txt">Digite o ticker.</span>';
  if (q && q.currency !== classCurrency(c)) return `<span class="bad-txt">A cotação de ${esc(t)} veio em ${esc(q.currency)}, diferente da classe (${classCurrency(c)}). Confira o tipo da classe.</span>`;
  const qTxt = q ? `Cotação ${priceTxt(q.price, q.currency)} · ${ago(q.updated_at)}${q.change_percent != null ? ` · ${q.change_percent >= 0 ? '+' : ''}${pct(q.change_percent)}% no dia` : ''}` : '';
  if (p.source === 'manual') return `Usando o preço digitado.${q ? ` ${qTxt} · <button class="link-btn" data-action="auto-price">usar automático</button>` : ''}`;
  if (p.source === 'auto') return qTxt;
  const ch = TICKER_CHANGES[t];
  if (ch && !q) return `<span class="warn-txt">${esc(t)} ${esc(ch.note)}.</span> <button class="link-btn" data-action="rename" data-to="${esc(ch.to)}">Trocar para ${esc(ch.to)}</button> <span>· se você tinha cotas, confira na corretora a quantidade convertida.</span>`;
  if (failedQuoteKeys.has(key)) return `<span class="bad-txt">A fonte não reconhece ${esc(t)} — o ticker pode ter mudado ou deixado de ser negociado. Confira na corretora ou digite o preço.</span>`;
  if (p.source === 'cache') return '<span class="warn-txt">Sem cotação agora — usando o último preço conhecido.</span>';
  return quotesRefreshing ? 'Buscando cotação…' : '<span class="warn-txt">Sem cotação ainda. Toque em "Atualizar cotações agora" ou digite o preço.</span>';
}

function renderAtivos() {
  const tabs = $('ativos-class-tabs');
  const assetClasses = state.classes.filter((c) => hasAssets(c));
  if (!assetClasses.find((c) => c.id === activeAtivosClassId)) activeAtivosClassId = assetClasses[0]?.id || null;
  tabs.innerHTML = assetClasses.map((c) => `<button class="class-tab ${c.id === activeAtivosClassId ? 'active' : ''}" data-cls="${esc(c.id)}">${esc(c.name)} · ${c.assets.length}</button>`).join('');
  tabs.querySelectorAll('[data-cls]').forEach((b) => b.addEventListener('click', () => { activeAtivosClassId = b.dataset.cls; renderAtivos(); }));
  const cls = state.classes.find((c) => c.id === activeAtivosClassId);
  const list = $('asset-list');
  if (!cls) { list.innerHTML = '<div class="empty-state">Nenhuma classe com ativos. Crie uma em Configuração.</div>'; $('asset-total-val').textContent = '—'; $('btn-add-asset').hidden = true; return; }
  $('btn-add-asset').hidden = false;
  const mode = buyMode(cls);
  const cur = classCurrency(cls);
  const usd = cur === 'USD' ? 'usd' : '';
  list.innerHTML = cls.assets.length ? '' : `<div class="empty-state">Nenhum ativo em ${esc(cls.name)} ainda.</div>`;
  cls.assets.forEach((a) => {
    const card = document.createElement('div');
    card.className = 'asset-card';
    const p = assetPrice(cls, a, quotes);
    const auto = isAutoValued(cls, a, quotes);
    const val = assetValue(cls, a, quotes);
    const tl = termLabel(a.termometro.nota);
    const qtyVal = Number(a.qty) > 0 ? Number(a.qty).toLocaleString('pt-BR', { maximumFractionDigits: 8, useGrouping: false }) : '0';
    let fields = `<div class="field ticker"><label>${mode === 'valor' ? 'Ativo / título' : 'Ticker'}</label><input class="name-input" value="${esc(a.ticker)}" data-f="ticker" ${mode === 'valor' ? '' : 'style="text-transform:uppercase"'} maxlength="40" autocomplete="off" spellcheck="false"></div>
      <div class="field pct"><label title="Percentual ideal dentro da classe">% ideal</label><div class="pct-input-wrap"><input class="pct-input" inputmode="decimal" value="${pct(a.idealPct)}" data-f="idealPct"></div></div>`;
    if (mode === 'valor') {
      fields += `<div class="field val"><label>Valor aplicado</label><div class="value-input-wrap ${usd}"><input class="value-input" inputmode="decimal" value="${n2(a.currentValue)}" data-f="currentValue"></div></div>
        <div class="field val"><label title="Menor valor que a aplicação aceita (ex.: Tesouro ≈ R$ 30)">Aplicação mín.</label><div class="value-input-wrap ${usd}"><input class="value-input" inputmode="decimal" value="${n2(a.minAmount || 0)}" data-f="minAmount"></div></div>`;
    } else {
      fields += `<div class="field small"><label>Quantidade</label><input class="plain-input" inputmode="decimal" value="${qtyVal}" data-f="qty" title="Quantas cotas/unidades você tem. Deixe 0 para digitar o valor."></div>
        <div class="field val"><label>Preço <span class="src-pill ${p.source}">${{ auto: 'auto', cache: 'última', manual: 'manual', none: 'sem' }[p.source]}</span></label><div class="value-input-wrap ${usd}"><input class="value-input" inputmode="decimal" value="${p.price > 0 ? n2(p.price) : ''}" placeholder="—" data-f="price"></div></div>
        <div class="field val"><label>${auto ? 'Valor <span class="auto-pill">· auto</span>' : 'Valor atual'}</label><div class="value-input-wrap ${usd}"><input class="value-input" inputmode="decimal" value="${n2(val)}" data-f="currentValue" ${auto ? 'disabled title="Calculado: quantidade × preço"' : ''}></div></div>`;
      if (mode === 'lote') fields += `<div class="field small"><label title="Cotas por lote (1 no fracionário)">Lote</label><input class="plain-input" inputmode="numeric" value="${a.minQty}" data-f="minQty"></div>`;
      else fields += `<div class="field val"><label title="Menor compra aceita pela corretora">Compra mín.</label><div class="value-input-wrap ${usd}"><input class="value-input" inputmode="decimal" value="${n2(a.minAmount || 0)}" data-f="minAmount"></div></div>`;
    }
    const s = sentimentCache[normTicker(a.ticker)];
    card.innerHTML = `<div class="asset-card-main">${fields}
        <button class="term-toggle" data-action="toggle-term"><span class="term-dot" style="background:${tl.color}"></span>${a.termometro.nota === null ? 'Termômetro' : a.termometro.nota + '/100'}</button>${s ? `<span class="mini-sentiment ${esc(s.label)}">${esc({ alta: 'Alta', baixa: 'Baixa', neutro: 'Neutro', sem_novidade: 'Sem novidade' }[s.label] || s.label)}</span>` : ''}
        <div class="asset-card-actions"><button class="icon-btn" data-action="remove" title="Remover ativo" aria-label="Remover ${esc(a.ticker)}">✕</button></div>
        <div class="asset-hint-row">${quoteHint(cls, a)}</div>
      </div>
      <div class="term-panel" data-term-panel>
        <div class="term-panel-row"><div class="field small"><label>Nota (0-100)</label><input class="plain-input" style="width:80px;" inputmode="numeric" value="${a.termometro.nota === null ? '' : a.termometro.nota}" data-f="nota" placeholder="—"></div><div style="font-size:12px; color:${tl.color}; font-weight:600;">${tl.label}</div></div>
        <div data-motivos></div>
        <button class="btn btn-sm btn-ghost" data-action="add-motivo">+ Adicionar motivo</button>
        <div class="sentiment-box" style="margin-top:16px;"><div style="font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-faint); margin-bottom:8px;">Leitura automática de notícias</div>${renderSentimentBox(a.ticker)}</div>
      </div>`;
    const on = (f, ev, fn) => { const el = card.querySelector(`[data-f="${f}"]`); if (el) el.addEventListener(ev, fn); };
    on('ticker', 'change', (e) => { a.ticker = mode === 'valor' ? e.target.value.trim() : normTicker(e.target.value); scheduleSave(); renderAtivos(); renderTopbar(); if (mode !== 'valor') debounceQuoteRefresh(); });
    on('idealPct', 'change', (e) => { a.idealPct = Math.max(0, Math.min(100, parseNum(e.target.value))); scheduleSave(); renderAtivos(); });
    on('currentValue', 'change', (e) => { a.currentValue = Math.max(0, parseNum(e.target.value)); scheduleSave(); renderAtivos(); renderTopbar(); });
    on('minAmount', 'change', (e) => { a.minAmount = Math.max(0, parseNum(e.target.value)); scheduleSave(); renderAtivos(); });
    on('qty', 'change', (e) => { a.qty = Math.max(0, parseNum(e.target.value)); scheduleSave(); renderAtivos(); renderTopbar(); });
    on('price', 'change', (e) => {
      const v = Math.max(0, parseNum(e.target.value));
      if (v > 0) { a.price = v; a.priceMode = 'manual'; } else { a.price = 0; a.priceMode = 'auto'; }
      scheduleSave(); renderAtivos(); renderTopbar();
    });
    on('minQty', 'change', (e) => { a.minQty = Math.max(1, Math.round(parseNum(e.target.value)) || 1); scheduleSave(); renderAtivos(); });
    on('nota', 'change', (e) => { const v = e.target.value.trim(); a.termometro.nota = v === '' ? null : Math.max(0, Math.min(100, Math.round(parseNum(v)))); scheduleSave(); renderAtivos(); renderTopbar(); });
    card.querySelector('[data-action="auto-price"]')?.addEventListener('click', () => { a.priceMode = 'auto'; scheduleSave(); renderAtivos(); renderTopbar(); });
    card.querySelector('[data-action="rename"]')?.addEventListener('click', (e) => {
      const to = e.currentTarget.dataset.to;
      if (cls.assets.some((x) => x.id !== a.id && normTicker(x.ticker) === to)) { toast(`${to} já está nesta classe.`); return; }
      a.ticker = to; a.priceMode = 'auto'; a.lastQuotePrice = 0;
      scheduleSave(); renderAtivos(); renderTopbar(); debounceQuoteRefresh();
      toast(`Trocado para ${to}. Buscando a cotação…`);
    });
    card.querySelector('[data-action="toggle-term"]').addEventListener('click', () => card.querySelector('[data-term-panel]').classList.toggle('open'));
    card.querySelector('[data-action="remove"]').addEventListener('click', async () => {
      if (!(await confirmBox('Remover ativo?', `Remover <b>${esc(a.ticker || 'este ativo')}</b> de ${esc(cls.name)}? O valor dele deixa de contar no patrimônio.`, 'Remover'))) return;
      cls.assets = cls.assets.filter((x) => x.id !== a.id); scheduleSave(); renderAtivos(); renderTopbar();
    });
    const renderMotivos = () => {
      const w = card.querySelector('[data-motivos]');
      w.innerHTML = '';
      a.termometro.motivos.forEach((m, i) => {
        const r = document.createElement('div'); r.className = 'motivo-item';
        r.innerHTML = `<input value="${esc(m)}" maxlength="200"><button class="icon-btn" style="width:28px;height:28px;" aria-label="Remover motivo">✕</button>`;
        r.querySelector('input').addEventListener('change', (e) => { a.termometro.motivos[i] = e.target.value; scheduleSave(); });
        r.querySelector('button').addEventListener('click', () => { a.termometro.motivos.splice(i, 1); scheduleSave(); renderMotivos(); });
        w.appendChild(r);
      });
    };
    renderMotivos();
    card.querySelector('[data-action="add-motivo"]').addEventListener('click', () => { a.termometro.motivos.push(''); scheduleSave(); renderMotivos(); });
    list.appendChild(card);
  });
  const sum = sumIdeal(cls.assets);
  const tv = $('asset-total-val');
  tv.textContent = pct(sum) + '%';
  tv.className = 'val ' + (cls.assets.length === 0 ? '' : isHundred(sum) ? 'ok' : 'bad');
}
function renderSentimentBox(ticker) {
  const s = sentimentCache[normTicker(ticker)];
  if (!s) return '<div class="sentiment-empty">Leitura automática de notícias ainda não ativada para este ativo.</div>';
  const sources = (s.sources || []).slice(0, 2).map((src) => { const u = String(src.url || ''); return /^https?:\/\//i.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(src.title || 'fonte')}</a>` : esc(src.title || ''); }).join(' · ');
  return `<div class="sentiment-head"><span class="sentiment-badge ${esc(s.label)}">${esc({ alta: 'Alta', baixa: 'Baixa', neutro: 'Neutro', sem_novidade: 'Sem novidade' }[s.label] || s.label)}</span><span class="num" style="font-size:12px; color:var(--text-faint);">${Number(s.score) || 0}/100</span></div><div class="sentiment-summary">${esc(s.summary || '')}</div><div class="sentiment-meta">${s.session === 'abertura' ? 'Abertura' : 'Fechamento'} · ${fmtDateBR(s.session_date)}${sources ? ' · ' + sources : ''}</div>`;
}
let quoteT = null;
function debounceQuoteRefresh() { clearTimeout(quoteT); quoteT = setTimeout(() => { syncTrackedTickers(); refreshQuotes(); }, 1200); }

// ---------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------
function renderConfig() {
  const list = $('class-list');
  list.innerHTML = '';
  state.classes.forEach((cls) => {
    const t = classType(cls);
    const row = document.createElement('div');
    row.className = 'class-row v4';
    const cv = classValueNative(cls, quotes);
    const cur = classCurrency(cls);
    const curEditable = t === 'rendafixa' || t === 'valor';
    row.innerHTML = `
      <div class="cr-cell cr-name" data-label="Classe"><input class="name-input" value="${esc(cls.name)}" data-f="name" maxlength="40"></div>
      <div class="cr-cell cr-type" data-label="Tipo"><select class="plain-select type-select" data-f="type" ${cls.isCash ? 'disabled title="O Caixa é sempre de valor direto"' : ''}>${Object.entries(CLASS_TYPES).map(([k, v]) => `<option value="${k}" ${k === t ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
      <div class="cr-cell cr-pct" data-label="Ideal"><div class="pct-input-wrap"><input class="pct-input" inputmode="decimal" value="${pct(cls.idealPct)}" data-f="idealPct"></div></div>
      <div class="cr-cell cr-val" data-label="Valor atual"><div class="value-input-wrap ${cur === 'USD' ? 'usd' : ''}"><input class="value-input" inputmode="decimal" value="${n2(cv)}" data-f="currentValue" ${hasAssets(cls) ? 'disabled title="Soma dos ativos da classe"' : ''}></div></div>
      <div class="cr-cell cr-cur" data-label="Moeda">${curEditable && !cls.isCash ? `<select class="plain-select" data-f="currency">${CURRENCIES.map((c) => `<option value="${c}" ${c === cur ? 'selected' : ''}>${sym(c).trim()}</option>`).join('')}</select>` : `<span style="font-size:13px; color:var(--text-muted); padding:9px 4px; display:inline-block;">${sym(cur).trim()}</span>`}</div>
      <div class="cr-cell cr-frac">${t === 'b3' || t === 'exterior' ? `<label class="chk-label" title="Comprar valor exato (fração), sem cota inteira"><input type="checkbox" data-f="fractional" ${buyMode(cls) === 'fracao' ? 'checked' : ''}> Fração</label>` : ''}</div>
      <label class="cr-cell cr-cash"><input type="radio" name="cash-class" class="chk-cash" data-f="isCash" ${cls.isCash ? 'checked' : ''} ${t === 'valor' ? '' : 'disabled title="Só uma classe de valor direto pode ser o Caixa"'}><span class="cash-word">Caixa</span></label>
      <div class="cr-cell cr-del"><button class="icon-btn" data-action="remove" title="Remover classe" aria-label="Remover classe ${esc(cls.name)}">✕</button></div>`;
    const q = (f) => row.querySelector(`[data-f="${f}"]`);
    q('name').addEventListener('change', (e) => { cls.name = e.target.value.trim() || 'Classe'; scheduleSave(); renderTopbar(); });
    q('idealPct').addEventListener('change', (e) => { cls.idealPct = Math.max(0, Math.min(100, parseNum(e.target.value))); scheduleSave(); renderConfig(); });
    q('type').addEventListener('change', async (e) => {
      const nt = e.target.value;
      if (!CLASS_TYPES[nt.trim()]) return;
      if (!CLASS_TYPES[nt].hasAssets && cls.assets.length) {
        const ok = await confirmBox('Mudar o tipo?', `"${esc(cls.name)}" tem ${cls.assets.length} ativo(s). No tipo "Valor direto" a classe não tem ativos: eles serão removidos e o valor atual da classe passa a ser digitado.`, 'Mudar e remover ativos');
        if (!ok) { renderConfig(); return; }
        cls.currentValue = Math.round(classValueNative(cls, quotes) * 100) / 100;
        cls.assets = [];
      }
      cls.type = nt;
      cls.hasAssets = CLASS_TYPES[nt].hasAssets;
      cls.currency = classCurrency(cls);
      cls.fractional = nt === 'cripto' || nt === 'exterior';
      scheduleSave(); renderConfig(); renderTopbar(); debounceQuoteRefresh();
    });
    q('currentValue')?.addEventListener('change', (e) => { cls.currentValue = Math.max(0, parseNum(e.target.value)); scheduleSave(); renderConfig(); });
    q('currency')?.addEventListener('change', (e) => { cls.currency = e.target.value; scheduleSave(); renderConfig(); });
    q('fractional')?.addEventListener('change', (e) => { cls.fractional = e.target.checked; scheduleSave(); renderConfig(); });
    q('isCash').addEventListener('change', () => { state.classes.forEach((c) => { c.isCash = c.id === cls.id; }); scheduleSave(); renderConfig(); });
    row.querySelector('[data-action="remove"]').addEventListener('click', async () => {
      if (cls.isCash) { toast('Escolha outra classe como Caixa antes de remover esta.'); return; }
      if (!(await confirmBox('Remover classe?', `Remover "${esc(cls.name)}"${cls.assets.length ? ` e seus ${cls.assets.length} ativo(s)` : ''}? Dá para desfazer em Histórico.`, 'Remover'))) return;
      const prev = JSON.parse(JSON.stringify({ ...state, undo: undefined }));
      state.classes = state.classes.filter((c) => c.id !== cls.id);
      state.undo = { kind: 'classe', at: new Date().toISOString(), label: 'remoção da classe ' + cls.name, prev, after: -1 };
      scheduleSave(); renderConfig(); renderTopbar();
      toast('Classe removida.', { action: { label: 'Desfazer', run: undoLast } });
    });
    list.appendChild(row);
    if (classCurrency(cls) !== 'BRL' && fxRate(classCurrency(cls), fxCtx()) === null) {
      const w = document.createElement('div');
      w.className = 'caixa-note warn-note'; w.style.margin = '-4px 0 10px';
      w.textContent = `Sem cotação de ${classCurrency(cls)} ainda para "${cls.name}" — informe o câmbio abaixo ou aguarde a atualização automática.`;
      list.appendChild(w);
    }
  });
  const sum = sumIdeal(state.classes);
  const tv = $('config-total-val');
  tv.textContent = pct(sum) + '%';
  tv.className = 'val ' + (isHundred(sum) ? 'ok' : 'bad');
  renderFxCards();
  renderTopbar();
}
function renderFxCards() {
  const g = $('fx-grid'); if (!g || !state) return;
  g.innerHTML = ['USD', 'EUR'].map((cur) => {
    const auto = fxAuto[cur];
    const man = state.settings.fxManual?.[cur];
    return `<div class="fx-card"><div class="k">${cur === 'USD' ? 'Dólar (US$)' : 'Euro (€)'}</div><div class="v">${man > 0 ? 'R$ ' + n2(man) : auto ? 'R$ ' + n2(auto) : '—'}</div>
      <div class="field"><label>Fixar valor (vazio = automático)</label><div class="value-input-wrap"><input class="value-input" inputmode="decimal" data-fx="${cur}" value="${man > 0 ? n2(man) : ''}" placeholder="automático"></div></div>
      <div class="s">${auto ? `Automático: R$ ${n2(auto)} · ${ago(fxUpdatedAt[cur])}` : 'Automático indisponível no momento'}${man > 0 ? ' · usando o valor fixado' : ''}</div></div>`;
  }).join('');
  g.querySelectorAll('[data-fx]').forEach((inp) => inp.addEventListener('change', (e) => {
    const v = parseNum(e.target.value);
    state.settings.fxManual[e.target.dataset.fx] = v > 0 ? v : null;
    scheduleSave(); renderFxCards(); renderTopbar();
  }));
}

// ---------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------
const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
function renderAgenda() {
  const freqs = [['diario', 'Diário'], ['semanal', 'Semanal'], ['quinzenal', 'Quinzenal'], ['mensal', 'Mensal'], ['personalizado', 'Personalizado']];
  const ag = state.agenda;
  const opt = $('freq-options');
  opt.innerHTML = freqs.map(([id, label]) => `<button class="freq-btn ${ag.frequency === id ? 'active' : ''}" data-freq="${id}">${label}</button>`).join('');
  opt.querySelectorAll('[data-freq]').forEach((b) => b.addEventListener('click', () => { ag.frequency = b.dataset.freq; scheduleSave(); renderAgenda(); }));
  const d = $('agenda-detail');
  if (ag.frequency === 'semanal' || ag.frequency === 'quinzenal') {
    d.innerHTML = `<div class="field"><label for="agenda-weekday" style="font-size:11px; text-transform:uppercase; color:var(--text-faint); display:block; margin-bottom:8px;">Dia da semana</label><select class="name-input" id="agenda-weekday" style="width:160px;">${WEEKDAYS.map((w, i) => `<option value="${i}" ${Number(ag.weekday) === i ? 'selected' : ''}>${w}</option>`).join('')}</select></div>`;
    $('agenda-weekday').addEventListener('change', (e) => { ag.weekday = Number(e.target.value); scheduleSave(); renderAgenda(); });
  } else if (ag.frequency === 'mensal') {
    d.innerHTML = `<div class="field"><label for="agenda-day" style="font-size:11px; text-transform:uppercase; color:var(--text-faint); display:block; margin-bottom:8px;">Dia do mês (1 a 28)</label><input class="plain-input" style="width:80px; text-align:left;" id="agenda-day" inputmode="numeric" value="${ag.dayOfMonth || 5}"></div>`;
    $('agenda-day').addEventListener('change', (e) => { ag.dayOfMonth = Math.max(1, Math.min(28, Math.round(parseNum(e.target.value)) || 5)); scheduleSave(); renderAgenda(); });
  } else if (ag.frequency === 'personalizado') {
    d.innerHTML = `<div class="field" style="min-width:260px;"><label for="agenda-note" style="font-size:11px; text-transform:uppercase; color:var(--text-faint); display:block; margin-bottom:8px;">Sua rotina (nota livre)</label><input class="name-input" id="agenda-note" maxlength="120" value="${esc(ag.customNote || '')}" placeholder="ex: aporto quando sobra dinheiro no fim do mês"></div>`;
    $('agenda-note').addEventListener('change', (e) => { ag.customNote = e.target.value; scheduleSave(); renderTopbar(); });
  } else d.innerHTML = '';
  const next = nextAporteDate(ag);
  const el = $('agenda-next-val');
  if (!next) el.textContent = ag.customNote || 'Defina sua rotina abaixo';
  else { const today = new Date(); today.setHours(0, 0, 0, 0); const diff = Math.round((next - today) / 86400000); el.textContent = (diff <= 0 ? 'Hoje' : diff === 1 ? 'Amanhã' : `Em ${diff} dias`) + ' · ' + next.toLocaleDateString('pt-BR'); }
  renderTopbar();
}

// ---------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------
function renderTimeline() {
  if (!$('div-data').value) $('div-data').value = todayISO();
  const u = state.undo;
  const aps = [...state.aportes].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 8);
  $('aportes-card').innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:${aps.length ? 8 : 0}px;"><h3 class="card-title" style="margin:0;">Últimos aportes</h3>${u && u.prev ? `<button class="btn btn-sm" id="btn-undo">Desfazer ${esc(u.label || 'último registro')}</button>` : ''}</div>` +
    (aps.length ? aps.map((a) => `<div class="aporte-row"><div><div class="d">${fmtDateBR(a.date)}</div><div style="font-size:12px; color:var(--text-muted);">${esc(a.observacao || `${(a.compras || []).length} compra(s)`)}</div></div><div style="text-align:right;"><div class="v">${money(Number(a.disponivel) || 0)}</div><div style="font-size:11px; color:var(--text-faint);">caixa +${money(Number(a.sobra || 0) + 0)}</div></div></div>`).join('') : '<div class="empty-state" style="padding:16px;">Nenhum aporte registrado ainda.</div>');
  $('btn-undo')?.addEventListener('click', undoLast);
  const items = [...state.timeline].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  const c = $('timeline-container');
  if (!items.length) { c.innerHTML = '<div class="empty-state">Nenhum evento ainda. Registre um aporte ou um provento para começar sua linha do tempo.</div>'; return; }
  c.innerHTML = '<div class="timeline">' + items.map((it) => `<div class="tl-item ${esc(it.type)}"><div class="tl-date">${fmtDateBR(it.date)}</div><div class="tl-title">${esc(it.title)}</div>${it.detail ? `<div class="tl-detail">${esc(it.detail)}</div>` : ''}</div>`).join('') + '</div>';
}
function addDividendo(e) {
  e.preventDefault();
  const ticker = normTicker($('div-ticker').value);
  const tipo = $('div-tipo').value;
  const valor = parseNum($('div-valor').value);
  const data = $('div-data').value || todayISO();
  const addCaixa = $('div-add-caixa').checked;
  if (!ticker || !(valor > 0)) { toast('Informe o ticker e um valor maior que zero.'); return; }
  if (data > todayISO()) { toast('A data do provento não pode ser no futuro.'); return; }
  state.dividendos.push({ id: uid(), date: data, ticker, tipo, valor: Math.round(valor * 100) / 100, addedToCaixa: addCaixa });
  state.timeline.push({ id: uid(), date: data, type: 'dividendo', title: `${tipo} de ${ticker}: ${money(valor)}`, detail: addCaixa ? 'Somado ao Caixa de Oportunidade.' : 'Apenas registrado — não somado ao Caixa.' });
  if (addCaixa) { const cash = state.classes.find((c) => c.isCash); if (cash) cash.currentValue = Math.round((Number(cash.currentValue) + valor) * 100) / 100; }
  scheduleSave();
  $('div-ticker').value = ''; $('div-valor').value = '';
  renderTimeline(); renderTopbar();
  toast('Provento registrado.');
}

// ---------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------
function exportBackup() {
  const payload = { app: 'aporte-mais', version: state.version, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), state: { ...state, undo: undefined } };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `aporte-mais-backup-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Backup exportado.');
}
async function importBackup(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('Arquivo grande demais para ser um backup do Aporte+.'); return; }
  let incoming;
  try { const parsed = JSON.parse(await file.text()); incoming = parsed && parsed.state ? parsed.state : parsed; if (!incoming || !Array.isArray(incoming.classes)) throw new Error('formato'); }
  catch { toast('Não foi possível importar: arquivo inválido ou corrompido.'); return; }
  const migrated = migrateState(incoming);
  const nAssets = migrated.classes.reduce((s, c) => s + (c.assets || []).length, 0);
  if (!(await confirmBox('Importar backup?', `O backup tem ${migrated.classes.length} classes, ${nAssets} ativos e ${migrated.aportes.length} aportes. Ele vai substituir a carteira atual (dá para desfazer em Histórico).`, 'Importar'))) return;
  const prev = JSON.parse(JSON.stringify({ ...state, undo: undefined }));
  state = migrated;
  state.undo = { kind: 'import', at: new Date().toISOString(), label: 'importação do backup', prev, after: -1 };
  activeAtivosClassId = state.classes.find((c) => hasAssets(c))?.id || null;
  scheduleSave(); renderConfig(); renderTopbar(); debounceQuoteRefresh();
  toast('Backup importado.', { action: { label: 'Desfazer', run: undoLast } });
}

// ---------------------------------------------------------------------
// Ligações de eventos fixos
// ---------------------------------------------------------------------
function wire() {
  $('auth-form').addEventListener('submit', onAuthSubmit);
  $('btn-auth-toggle').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
  $('btn-auth-forgot').addEventListener('click', () => setAuthMode('forgot'));
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('btn-logout').addEventListener('click', async () => { if (dirty) await saveNow(); await sb.auth.signOut(); });
  $('quote-chip').addEventListener('click', () => refreshQuotes({ silent: false }));
  $('aporte-form').addEventListener('submit', (e) => { e.preventDefault(); calcular(); });
  $('btn-refresh-prices').addEventListener('click', () => refreshQuotes({ silent: false }));
  $('btn-refresh-sentiment').addEventListener('click', async () => { await refreshSentimentCache(); renderAtivos(); toast(Object.keys(sentimentCache).length ? 'Leitura de notícias atualizada.' : 'A leitura automática de notícias ainda não está ativada.'); });
  $('btn-add-asset').addEventListener('click', () => {
    const cls = state.classes.find((c) => c.id === activeAtivosClassId);
    if (!cls) return;
    cls.assets.push({ id: uid(), ticker: '', idealPct: 0, qty: 0, price: 0, priceMode: 'auto', currentValue: 0, minQty: 1, minAmount: 0, lastQuotePrice: 0, termometro: { nota: null, motivos: [] } });
    scheduleSave(); renderAtivos();
    const inputs = document.querySelectorAll('#asset-list [data-f="ticker"]');
    inputs[inputs.length - 1]?.focus();
  });
  $('btn-add-class').addEventListener('click', () => {
    state.classes.push({ id: uid(), name: 'Nova classe', type: 'b3', hasAssets: true, idealPct: 0, isCash: false, currency: 'BRL', fractional: false, currentValue: 0, assets: [] });
    scheduleSave(); renderConfig();
  });
  $('btn-export-backup').addEventListener('click', exportBackup);
  $('btn-import-backup').addEventListener('click', () => $('input-import-backup').click());
  $('input-import-backup').addEventListener('change', importBackup);
  $('btn-change-pass').addEventListener('click', () => askNewPassword('Trocar senha'));
  $('div-form').addEventListener('submit', addDividendo);
  $('aporte-valor').addEventListener('input', () => { if (lastPlan) { lastPlan = null; $('resultado-container').innerHTML = ''; } });
}

// ---------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------
(async function init() {
  wire();
  if (!window.supabase || !window.supabase.createClient) {
    showBoot('Não foi possível carregar o app', 'Recarregue a página. Se continuar, verifique sua conexão.', { spinner: false, actions: '<button class="btn btn-primary" id="btn-reload">Recarregar</button>' });
    $('btn-reload').addEventListener('click', () => location.reload());
    return;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const h = (location.hash || '').slice(1);
  if (TABS.includes(h)) activeTab = h;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { setTimeout(() => askNewPassword('Criar nova senha'), 300); }
    if (event === 'SIGNED_OUT') { resetSession(); showAuth('login'); }
    if (event === 'SIGNED_IN' && session?.user && !booted) setTimeout(() => onAuthed(session.user), 0);
  });
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await onAuthed(session.user);
    else showAuth('login');
  } catch (e) {
    console.error(e);
    showAuth('login', { text: 'Não foi possível verificar sua sessão. Entre novamente.', kind: 'err' });
  }
})();
