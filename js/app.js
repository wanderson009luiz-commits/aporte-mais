// =====================================================================
// Aporte+ v4 — interface. Toda conta de dinheiro fica em engine.js/model.js (testados).
// =====================================================================
import {
  CLASS_TYPES, CURRENCIES, classType, classCurrency, buyMode, hasAssets, quoteSource, quoteKey, normTicker,
  assetPrice, assetValue, isAutoValued, classValueNative, classValueBRL, portfolioTotalBRL, fxRate, sumIdeal, isHundred,
  defaultState, migrateState, trackedTickers, parseNum, toCents, todayISO, nextAporteDate, uid, isQuotableTicker, cleanPrice,
  TICKER_CHANGES, convertQty, isISODate,
} from './model.js?v=dev';
import { planAporte, applyPlan, revertAporte, stateSignature, validateForPlan, alignmentScore } from './engine.js?v=dev';
import { newsAssets, cleanNewsRows, filterNews, groupByAsset, newsCounts, isAttention, bySeverity, NEWS_WINDOW_DAYS } from './news.js?v=dev';

const APP_VERSION = '4.2.0';
const SUPABASE_URL = 'https://vldiylyynkgprpfxyyej.supabase.co';
// Chave pública (anon) — é feita para ficar no navegador; a proteção real são as regras RLS do banco.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZsZGl5bHl5bmtncHJwZnh5eWVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxNjA4NTYsImV4cCI6MjEwNDczNjg1Nn0.mlv8I8EOtRhiZyw2PlVnp2mNMXLZCTJr0acDLMKKjy0';
const QUOTE_MAX_AGE_MS = 20 * 60 * 1000; // ao abrir o app, atualiza se a cotação tiver mais de 20 min
const QUOTE_REFRESH_EVERY_MS = 15 * 60 * 1000;
const QUOTE_STALE_MS = 7 * 24 * 3600 * 1000; // cotação sem atualizar há 7 dias não vale como preço atual (feriados longos têm até 5 dias)

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
// notícias da carteira
let newsRows = [];                // linhas limpas de ticker_news (só ativos da carteira)
let newsChecks = new Map();       // chave → quando o servidor verificou pela última vez
let newsLoadedAt = 0, lastNewsInvoke = 0, newsRun = 0;
let newsLoading = false, newsFetching = false, newsError = '', newsAi = null;
let newsFilter = 'todas', newsAssetFilter = '';
let activeTab = 'painel';
let activeAtivosClassId = null;
let lastPlan = null;
let lastSyncedTickers = null;
let sessionUndo = null;           // desfazer rápido (só nesta tela): remoção de classe/ativo
const openTermPanels = new Set(); // termômetros abertos em Ativos (sobrevivem a re-renderizações)
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
function fmtDateBR(iso) { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return esc(`${d}/${m}/${y}`); }
function plural(n, one, many) { return `${Number(n).toLocaleString('pt-BR')} ${n === 1 ? one : many}`; }
const round2 = (v) => Math.round((Number(v) || 0) * 100 + 1e-7) / 100;

/**
 * Lê um campo numérico digitado. Nunca converte em silêncio: devolve {ok:false, msg} quando o texto
 * não é número, é negativo, passa do limite ou (se int) não é inteiro.
 */
function readField(input, { label = 'Valor', min = 0, max = 1e12, int = false, allowEmpty = true } = {}) {
  const raw = String(input?.value ?? '').trim();
  if (raw === '') return allowEmpty ? { ok: true, empty: true, value: 0 } : { ok: false, msg: `${label}: preencha o campo.` };
  const core = raw.replace(/R\$|US\$|€|%|\s/g, '').replace(/^\((.*)\)$/, '-$1');
  const shape = /^[+-]?(\d{1,3}([.,]\d{3})+|\d+)([.,]\d*)?$/.test(core) || /^[+-]?[.,]\d+$/.test(core) || /^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(core);
  const v = parseNum(raw);
  if (!shape || !Number.isFinite(v)) return { ok: false, msg: `${label}: "${raw}" não é um número válido.` };
  if (v < 0 && min >= 0) return { ok: false, msg: `${label}: não pode ser negativo.` };
  if (v < min) return { ok: false, msg: `${label}: o mínimo é ${min.toLocaleString('pt-BR')}.` };
  if (v > max) return { ok: false, msg: `${label}: o máximo é ${max.toLocaleString('pt-BR')}.` };
  if (int && !Number.isInteger(v)) return { ok: false, msg: `${label}: use um número inteiro.` };
  return { ok: true, empty: false, value: v };
}
/** Aplica um campo: se inválido, avisa, marca o campo e devolve null (o valor anterior continua). */
function fieldOr(input, opts, apply) {
  const r = readField(input, opts);
  if (!r.ok) { toast(r.msg); input.classList.add('invalid'); setTimeout(() => input.classList.remove('invalid'), 2500); return false; }
  apply(r);
  return true;
}

// ---------------------------------------------------------------------
// Avisos e diálogos
// ---------------------------------------------------------------------
let toastTimer = null;
function hideToast() {
  const t = $('toast');
  clearTimeout(toastTimer);
  t.classList.remove('show');
  t.style.pointerEvents = 'none';
  const b = $('toast-action'); if (b) { b.onclick = null; b.disabled = true; } // botão escondido não age mais
}
function toast(msg, opts = {}) {
  const t = $('toast');
  t.innerHTML = esc(msg) + (opts.action ? ` <button class="link-btn" id="toast-action" style="font-size:12px; margin-left:8px;">${esc(opts.action.label)}</button>` : '');
  t.classList.add('show');
  if (opts.action) $('toast-action').onclick = () => { hideToast(); opts.action.run(); };
  t.style.pointerEvents = opts.action ? 'auto' : 'none';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, opts.ms || (opts.action ? 9000 : 3600));
}

/**
 * Diálogo simples. buttons: [{label, kind:'primary'|'', value}] → Promise com o value clicado (null se fechar).
 * Esc e clique fora = fechar (null). Enter num campo = botão principal. O foco fica preso no diálogo e
 * volta para onde estava ao fechar. Um segundo clique logo depois de abrir não fecha o diálogo.
 */
let closeCurrentDialog = null;
function dialog({ title, html, buttons = [{ label: 'OK', kind: 'primary', value: true }], onOpen }) {
  if (closeCurrentDialog) closeCurrentDialog(null); // nunca dois ao mesmo tempo
  return new Promise((resolve) => {
    const back = $('modal-back');
    const box = $('modal');
    const opener = document.activeElement;
    const openedAt = Date.now();
    let done = false;
    box.innerHTML = `<h2 id="modal-title">${esc(title)}</h2>${html || ''}<div class="modal-actions">${buttons.map((b, i) => `<button type="button" class="btn ${b.kind === 'primary' ? 'btn-primary' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
    back.classList.add('show');
    const close = (v) => {
      if (done) return; done = true;
      back.classList.remove('show'); document.removeEventListener('keydown', onKey, true); closeCurrentDialog = null;
      if (opener && opener.isConnected && typeof opener.focus === 'function') { try { opener.focus({ preventScroll: true }); } catch { /* sem foco */ } }
      resolve(v);
    };
    closeCurrentDialog = close;
    const press = (i) => {
      const btn = buttons[i];
      if (btn.validate) { const ok = btn.validate(box); if (!ok) return; }
      close(typeof btn.value === 'function' ? btn.value(box) : btn.value);
    };
    const onKey = (e) => {
      if (!back.classList.contains('show')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && box.contains(e.target)) {
        const pi = buttons.findIndex((b) => b.kind === 'primary');
        if (pi >= 0) { e.preventDefault(); press(pi); }
        return;
      }
      if (e.key === 'Tab') { // foco preso dentro do diálogo
        const f = [...box.querySelectorAll('button, input, select, textarea, a[href]')].filter((x) => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    // o 2º clique de um duplo clique (no botão que abriu o diálogo) não pode fechar nem confirmar nada
    const fromDouble = (e) => e.detail > 1 && Date.now() - openedAt < 800;
    box.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', (e) => { if (fromDouble(e)) return; press(Number(b.dataset.i)); }));
    back.onclick = (e) => { if (e.target === back && !fromDouble(e)) close(null); };
    if (onOpen) onOpen(box);
    const first = box.querySelector('input') || box.querySelector('.btn-primary');
    if (first) setTimeout(() => { if (!done) first.focus(); }, 30);
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
  if (data && data.state != null && (typeof data.state !== 'object' || !Array.isArray(data.state.classes))) {
    const e = new Error('formato inesperado da carteira'); e.raw = data.state; throw e; // não migra nem grava por cima
  }
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
    const raw = e && e.raw !== undefined ? e.raw : undefined;
    showBoot('Não foi possível abrir a carteira', raw !== undefined
      ? 'Os dados salvos estão num formato inesperado. Nada foi alterado. Baixe os dados brutos e me envie para recuperar.'
      : 'Verifique sua conexão. Seus dados estão seguros — nada foi alterado.', {
      spinner: false, actions: '<button class="btn btn-primary" id="btn-retry-boot">Tentar de novo</button> ' + (raw !== undefined ? '<button class="btn" id="btn-raw">Baixar dados brutos</button> ' : '') + '<button class="btn" id="btn-boot-logout">Sair</button>' });
    $('btn-retry-boot').onclick = () => { booted = false; setTimeout(() => onAuthed(u), 0); };
    $('btn-boot-logout').onclick = () => sb.auth.signOut({ scope: 'local' });
    if (raw !== undefined) $('btn-raw').onclick = () => {
      const blob = new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `aporte-mais-dados-brutos-${todayISO()}.json`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
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
  showMigrationNotes();
  syncTrackedTickers();
  refreshSentimentCache().then(() => { if (activeTab === 'ativos') renderAtivos(); renderTopbar(); });
  loadNews(); // em segundo plano: alertas no Painel e no menu assim que chegarem
  const ages = trackedTickers(state).map((t) => quotes[quoteKey(t.source, t.ticker)]?.updated_at).map((x) => (x ? Date.now() - new Date(x).getTime() : Infinity));
  if (ages.some((a) => a > QUOTE_MAX_AGE_MS)) refreshQuotes();
  else lastQuoteRefresh = Date.now();
}

function resetSession() {
  user = null; portfolioId = null; state = null; stateLoaded = false; lastUpdatedAt = null; conflict = false;
  booted = false; lastPlan = null; lastSyncedTickers = null; quotes = {}; failedQuoteKeys = new Set();
  sessionUndo = null; sentimentCache = {}; openTermPanels.clear(); pendingRender.clear();
  newsRun++; newsRows = []; newsChecks = new Map(); newsLoadedAt = 0; lastNewsInvoke = 0;
  newsLoading = false; newsFetching = false; newsError = ''; newsAi = null; newsFilter = 'todas'; newsAssetFilter = '';
}
/** Limpa tudo que estava na tela — a próxima pessoa que entrar neste navegador não vê nada da anterior. */
function resetUI() {
  activeTab = 'painel'; activeAtivosClassId = null;
  if (closeCurrentDialog) closeCurrentDialog(null);
  ['aporte-valor', 'aporte-obs', 'div-ticker', 'div-valor', 'div-data', 'auth-password', 'auth-email'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
  const chk = $('div-add-caixa'); if (chk) chk.checked = true;
  ['resultado-container', 'ready-card', 'painel-container', 'asset-list', 'class-list', 'aportes-card', 'proventos-card', 'timeline-container',
    'ativos-class-tabs', 'fx-grid', 'agenda-detail', 'freq-options', 'news-container', 'news-status'].forEach((id) => { const el = $(id); if (el) el.innerHTML = ''; });
  if ($('news-badge')) $('news-badge').hidden = true;
  if ($('sidebar-user')) $('sidebar-user').textContent = '';
  if ($('account-email')) $('account-email').textContent = '—';
  if ($('patrimonio-total')) $('patrimonio-total').textContent = 'R$ 0,00';
  hideToast();
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sem histórico */ }
}
function showMigrationNotes() {
  const notes = Array.isArray(state?.migrationNotes) ? state.migrationNotes : [];
  if (!notes.length) return;
  dialog({ title: 'Sua carteira foi atualizada', html: `<p>Fizemos ajustes para a versão nova do app:</p><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`,
    buttons: [{ label: 'Entendi', kind: 'primary', value: true }] }).then(() => {
    if (state && Array.isArray(state.migrationNotes)) { delete state.migrationNotes; scheduleSave(); }
  });
}

// ---------------------------------------------------------------------
// Salvamento (com proteção contra edição em dois aparelhos)
// ---------------------------------------------------------------------
let saveTimer = null, saving = false, saveQueued = false, dirty = false, editGen = 0, saveFailing = false, reloadingForConflict = false;
function scheduleSave() {
  if (!stateLoaded) return;
  invalidatePlanIfStale();
  dirty = true; editGen++;
  if (conflict) { renderSaveBanner(); return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}
/** Grava a carteira. Gravação condicional: o banco só aceita se ninguém salvou depois que esta tela leu. */
/** Antes de salvar: cada ativo com cotas guarda o último preço real visto (rede de segurança se a fonte cair). */
function rememberLivePrices() {
  state?.classes.forEach((c) => {
    if (!hasAssets(c) || buyMode(c) === 'valor') return;
    c.assets.forEach((a) => {
      if (!(Number(a.qty) > 0)) return;
      const p = assetPrice(c, a, quotes);
      if (p.source === 'auto' && p.price > 0 && Number(a.lastQuotePrice) !== p.price) a.lastQuotePrice = p.price;
    });
  });
}
let slowSave = false;
async function saveNow() {
  if (!stateLoaded || conflict) return false;
  if (saving) { saveQueued = true; return false; }
  saving = true;
  const gen = editGen;
  let ok = false;
  const slowTimer = setTimeout(() => { if (saving) { slowSave = true; renderSaveBanner(); } }, 5000);
  rememberLivePrices();
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await sb.from('portfolio_state').update({ state, updated_at: nowIso })
      .eq('portfolio_id', portfolioId).eq('updated_at', lastUpdatedAt).select('updated_at');
    if (error) throw error;
    if (data && data.length) { lastUpdatedAt = data[0].updated_at; ok = true; }
    else {
      const { data: cur, error: e2 } = await sb.from('portfolio_state').select('updated_at').eq('portfolio_id', portfolioId).maybeSingle();
      if (e2) throw e2;
      if (!cur) { // a linha não existe mais: recria com a carteira desta tela
        const { data: ins, error: e3 } = await sb.from('portfolio_state').insert({ portfolio_id: portfolioId, state, updated_at: nowIso }).select('updated_at').single();
        if (e3) throw e3;
        lastUpdatedAt = ins.updated_at; ok = true;
      } else if (Date.parse(cur.updated_at) === Date.parse(lastUpdatedAt)) {
        // mesma versão (só o formato do horário diferiu): pode gravar
        const { data: up, error: e4 } = await sb.from('portfolio_state').update({ state, updated_at: nowIso }).eq('portfolio_id', portfolioId).select('updated_at');
        if (e4) throw e4;
        if (!up || !up.length) throw new Error('gravação não confirmada');
        lastUpdatedAt = up[0].updated_at; ok = true;
      } else {
        saving = false;
        await handleConflict(cur.updated_at);
        return false;
      }
    }
    if (editGen === gen) dirty = false;
    if (saveFailing) { saveFailing = false; renderSaveBanner(); }
    syncTrackedTickers();
  } catch (e) {
    console.error('Falha ao salvar', e);
    saveFailing = true; renderSaveBanner();
    clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 5000);
  } finally {
    saving = false;
    clearTimeout(slowTimer);
    if (slowSave) { slowSave = false; renderSaveBanner(); }
    if (saveQueued && !conflict) { saveQueued = false; saveNow(); }
  }
  return ok;
}
/** Grava agora e espera a resposta. true = está na nuvem. */
async function flushSave() {
  clearTimeout(saveTimer);
  for (let i = 0; i < 150 && saving; i++) await new Promise((r) => setTimeout(r, 100));
  if (!dirty) return true;
  if (conflict) return false;
  return await saveNow(); // true = a gravação que levou esta alteração foi confirmada
}
/** Avisa o resultado de uma gravação importante (registrar/desfazer aporte). */
function reportSave(ok, what) {
  if (ok) return true;
  dialog({ title: `${what} — ainda NÃO salvo na nuvem`, html: conflict
    ? '<p>A carteira foi alterada em outro aparelho, então esta tela não está salvando.</p><p><b>Se recarregar, o que você fez aqui (incluindo este aporte) some.</b> Baixe o backup desta tela, ou use "Substituir a do outro aparelho" no aviso do topo se esta tela tem a versão certa.</p>'
    : '<p>Sem conexão com a nuvem agora. O app continua tentando sozinho — <b>não feche esta página</b> até o aviso do topo sumir. Se preferir, baixe um backup agora.</p>',
    buttons: [{ label: 'Fechar', value: null }, { label: 'Baixar backup', kind: 'primary', value: 'b' }] }).then((v) => { if (v) exportBackup(); });
  return false;
}
function renderSaveBanner() {
  const b = $('save-banner'); if (!b) return;
  if (conflict) {
    b.className = 'save-banner err';
    b.innerHTML = '<span>Sua carteira foi alterada em outro aparelho. <b>As alterações desta tela não estão sendo salvas.</b></span><span class="sb-actions"><button class="btn btn-sm" id="sb-backup">Baixar backup desta tela</button><button class="btn btn-sm" id="sb-mine">Substituir a do outro aparelho</button><button class="btn btn-sm btn-primary" id="sb-reload">Recarregar</button></span>';
    b.hidden = false;
    $('sb-backup').onclick = () => exportBackup();
    $('sb-reload').onclick = () => { reloadingForConflict = true; location.reload(); };
    $('sb-mine').onclick = () => replaceRemote();
  } else if (saveFailing) {
    b.className = 'save-banner warn';
    b.innerHTML = '<span>Sem conexão com a nuvem — <b>suas últimas alterações ainda não foram salvas</b>. Tentando de novo…</span>';
    b.hidden = false;
  } else if (slowSave) {
    b.className = 'save-banner warn';
    b.innerHTML = '<span>Salvando na nuvem… a conexão está lenta. <b>Não feche esta página</b> até este aviso sumir.</span>';
    b.hidden = false;
  } else { b.hidden = true; b.innerHTML = ''; }
}
let remoteUpdatedAtSeen = null;
async function replaceRemote() {
  const ok = await confirmBox('Substituir a versão do outro aparelho?', 'A carteira salva no outro aparelho será trocada pela que está nesta tela. O que foi feito lá depois que você abriu esta tela será perdido.', 'Substituir');
  if (!ok) return;
  conflict = false; lastUpdatedAt = remoteUpdatedAtSeen; renderSaveBanner();
  saveNow();
}
async function handleConflict(remoteUpdatedAt) {
  conflict = true; remoteUpdatedAtSeen = remoteUpdatedAt;
  renderSaveBanner();
  const choice = await dialog({
    title: 'Carteira alterada em outro lugar',
    html: '<p>Sua carteira foi salva em outro aparelho ou aba depois que você abriu esta tela, e esta tela parou de salvar para não apagar nada.</p><p><b>Recarregar</b> mostra a versão mais recente e descarta as alterações desta tela que não foram salvas — se quiser guardá-las, baixe um backup antes.</p>',
    buttons: [{ label: 'Decidir depois', value: null }, { label: 'Baixar backup desta tela', value: 'backup' }, { label: 'Recarregar (recomendado)', kind: 'primary', value: 'reload' }],
  });
  if (choice === 'backup') exportBackup();
  if (choice === 'reload') { reloadingForConflict = true; location.reload(); }
  // fechar/decidir depois: o aviso fica visível no topo, com as mesmas opções
}
window.addEventListener('beforeunload', (e) => { if (!reloadingForConflict && (dirty || saving)) { if (!conflict) saveNow(); e.preventDefault(); e.returnValue = ''; } });

let syncingTickers = null;
/** Uma sincronização por vez: chamadas que chegam durante uma em andamento esperam e conferem de novo. */
async function syncTrackedTickers() {
  while (syncingTickers) await syncingTickers.catch(() => {});
  syncingTickers = syncTrackedTickersNow();
  try { await syncingTickers; } finally { syncingTickers = null; }
}
async function syncTrackedTickersNow() {
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
  // linhas com moeda "ERR" = a fonte não reconhece o ticker (o servidor guarda isso por um tempo para não insistir)
  (rows || []).forEach((r) => {
    if (!r || typeof r.ticker !== 'string') return;
    const price = Number(r.price);
    const t = Date.parse(r.updated_at);
    const failed = String(r.currency || '').toUpperCase() === 'ERR';
    // "ERR": a fonte não reconhece o ticker. O preço que vier junto é o último preço real conhecido
    // (na moeda da bolsa daquele ticker); nunca vale como cotação atual.
    const currency = failed ? (r.ticker.startsWith('US:') ? 'USD' : 'BRL') : String(r.currency || 'BRL').toUpperCase();
    quotes[r.ticker] = { price: Number.isFinite(price) && price > 0 ? price : 0, currency, change_percent: r.change_percent == null ? null : Number(r.change_percent),
      updated_at: r.updated_at, failed, stale: failed || !Number.isFinite(t) || Date.now() - t > QUOTE_STALE_MS };
  });
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
    if (!silent) toast(failed.size ? `Cotações atualizadas. ${plural(failed.size, 'ticker ficou', 'tickers ficaram')} sem cotação — veja em Ativos.` : 'Cotações atualizadas.');
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
  invalidatePlanIfStale();
  if (activeTab === 'painel') renderPainel();
  if (activeTab === 'ativos') renderWhenIdle('asset-list', renderAtivos);
  if (activeTab === 'aporte') renderReady();
  if (activeTab === 'config') renderWhenIdle('fx-grid', renderFxCards);
}

// ---------------------------------------------------------------------
// Re-renderização sem atrapalhar quem está digitando
// ---------------------------------------------------------------------
const pendingRender = new Map(); // container → função de render adiada
function isEditing(containerId) {
  const el = document.activeElement; const c = $(containerId);
  return !!(c && el && c.contains(el) && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
}
/** Atualização "de fundo" (cotações, notícias): espera a pessoa sair do campo. */
function renderWhenIdle(containerId, fn) { if (isEditing(containerId)) { pendingRender.set(containerId, fn); return; } fn(); }
/** Atualização por edição da própria pessoa: re-renderiza logo depois e devolve o foco ao mesmo campo. */
function rerenderKeepFocus(fn) {
  setTimeout(() => {
    const ae = document.activeElement;
    const key = ae && ae.dataset ? ae.dataset.key : null;
    let sel = null;
    try { sel = key && typeof ae.selectionStart === 'number' ? [ae.selectionStart, ae.selectionEnd] : null; } catch { sel = null; }
    fn();
    if (!key) return;
    const el = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch { /* campo sem seleção */ } }
  }, 0);
}
function flushPending(containerId) {
  setTimeout(() => {
    const fn = pendingRender.get(containerId);
    if (fn && !isEditing(containerId)) { pendingRender.delete(containerId); fn(); }
  }, 0);
}
setInterval(() => { if (stateLoaded && document.visibilityState === 'visible' && Date.now() - lastQuoteRefresh > QUOTE_REFRESH_EVERY_MS) refreshQuotes(); }, 60000);
document.addEventListener('visibilitychange', () => { if (stateLoaded && document.visibilityState === 'visible' && Date.now() - lastQuoteRefresh > QUOTE_REFRESH_EVERY_MS) refreshQuotes(); });

function newestQuoteTime() {
  let best = 0;
  trackedTickers(state || { classes: [] }).forEach((t) => { const q = quotes[quoteKey(t.source, t.ticker)]; if (q?.updated_at && !q.failed) best = Math.max(best, new Date(q.updated_at).getTime() || 0); });
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
// Notícias
// ---------------------------------------------------------------------
const NEWS_STALE_MS = 2 * 3600e3;
const IMPACT_TXT = { alto: 'Impacto alto', medio: 'Impacto médio', baixo: 'Impacto baixo' };
const DIR_TXT = { positivo: '▲ Boa', negativo: '▼ Ruim', neutro: '• Neutra' };
const tickerOfKey = (k) => String(k).replace(/^(US|CRYPTO):/, '');
const newsAiOn = () => (newsAi !== null ? newsAi : newsRows.some((n) => n.byAi));

async function readNews(keys) {
  const since = new Date(Date.now() - NEWS_WINDOW_DAYS * 864e5).toISOString();
  const rows = []; const checks = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const part = keys.slice(i, i + 50);
    // em páginas de 1.000 (o limite do servidor): nenhuma notícia — nem alerta — some por excesso de outras
    for (let page = 0; page < 30; page++) {
      const { data, error } = await sb.from('ticker_news').select('id, ticker, title, url, source, published_at, impact, direction, relevant, summary, classified_by')
        .in('ticker', part).gte('published_at', since).order('published_at', { ascending: false }).order('id', { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const { data: ch, error: e2 } = await sb.from('ticker_news_checks').select('ticker, checked_at').in('ticker', part);
    if (e2) throw e2;
    (ch || []).forEach((r) => checks.set(r.ticker, Date.parse(r.checked_at)));
  }
  newsRows = cleanNewsRows(rows);
  newsChecks = checks;
}
/** Lê as notícias salvas e, se algum ativo não é verificado há 2 h (ou a pessoa pediu), pede ao servidor as novas. */
async function loadNews({ force = false } = {}) {
  if (!stateLoaded || !sb || !state) return;
  const run = ++newsRun; // só a chamada mais recente mexe na tela (troca de conta, cliques repetidos)
  const keys = [...newsAssets(state, quotes, fxCtx()).keys()];
  if (!keys.length) { newsRows = []; newsLoadedAt = Date.now(); newsError = ''; renderNewsEverywhere(); return; }
  newsLoading = true; newsError = ''; renderNewsEverywhere();
  try {
    await readNews(keys);
    if (run !== newsRun) return;
    const stale = keys.filter((k) => !(Date.now() - (newsChecks.get(k) || 0) < NEWS_STALE_MS));
    if ((force || stale.length) && Date.now() - lastNewsInvoke > 60e3) {
      lastNewsInvoke = Date.now();
      newsFetching = true; renderNewsEverywhere();
      await syncTrackedTickers(); // o servidor só busca tickers que estão na carteira de quem pede
      const { data, error } = await sb.functions.invoke('news-refresh', { body: { tickers: keys } });
      if (run !== newsRun) return;
      if (error || !data?.ok) newsError = 'Não deu para buscar notícias novas agora — mostrando as que já estavam salvas.';
      else { newsAi = !!data.ai; await readNews(keys); }
    }
  } catch (e) {
    console.error('Falha ao carregar notícias', e);
    if (run === newsRun) newsError = 'Não foi possível carregar as notícias. Verifique sua conexão e toque em Atualizar.';
  } finally {
    if (run === newsRun) { newsLoading = false; newsFetching = false; newsLoadedAt = Date.now(); renderNewsEverywhere(); }
  }
}
function renderNewsEverywhere() {
  if (!state) return;
  updateNewsBadge();
  if (activeTab === 'noticias') renderNoticias();
  if (activeTab === 'painel') renderPainel();
}
/** Notícias que pedem atenção (impacto alto, ou médio e ruim, dos últimos 7 dias) nos ativos da carteira. */
function newsAlerts() {
  const assets = newsAssets(state, quotes, fxCtx());
  return newsRows.filter((n) => assets.has(n.ticker) && isAttention(n)).sort(bySeverity);
}
function updateNewsBadge() {
  const b = $('news-badge');
  if (!b) return;
  const n = state ? newsAlerts().length : 0;
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : String(n);
  b.setAttribute('aria-label', `${n} ${n === 1 ? 'notícia pede' : 'notícias pedem'} atenção`);
}
function newsItemHtml(n, { showTicker = false } = {}) {
  return `<article class="news-item imp-${n.impact} dir-${n.direction}">
    <div class="news-tags"><span class="imp-tag ${n.impact}">${IMPACT_TXT[n.impact]}</span><span class="dir-tag ${n.direction}">${DIR_TXT[n.direction]}</span>${showTicker ? `<span class="news-tk">${esc(tickerOfKey(n.ticker))}</span>` : ''}</div>
    <a class="news-title" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>
    ${n.summary ? `<p class="news-sum">${esc(n.summary)}</p>` : ''}
    <div class="news-meta">${esc(n.source || 'Fonte')} · ${esc(ago(new Date(n.published).toISOString()))}${n.byAi ? '' : ' · classificação automática simples'}</div>
  </article>`;
}
function renderNoticias() {
  const box = $('news-container');
  if (!box || !state) return;
  const assets = newsAssets(state, quotes, fxCtx());
  const list = [...assets.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  if (newsAssetFilter && !assets.has(newsAssetFilter)) newsAssetFilter = '';
  const sel = $('news-asset');
  sel.innerHTML = `<option value="">Todos os ativos (${list.length})</option>` + list.map((a) => `<option value="${esc(a.key)}"${a.key === newsAssetFilter ? ' selected' : ''}>${esc(a.ticker)}</option>`).join('');
  const base = filterNews(newsRows, assets, { asset: newsAssetFilter });
  const cnt = newsCounts(base);
  const chipN = { todas: cnt.total, alto: cnt.alto, ruins: cnt.negativo, boas: cnt.positivo };
  document.querySelectorAll('[data-nf]').forEach((b) => {
    const on = b.dataset.nf === newsFilter;
    b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.innerHTML = `${esc({ todas: 'Todas', alto: 'Impacto alto', ruins: 'Ruins', boas: 'Boas' }[b.dataset.nf])}<span class="n">${chipN[b.dataset.nf] ?? 0}</span>`;
  });
  const checked = [...newsChecks.values()].filter(Boolean);
  const lastCheck = checked.length ? Math.max(...checked) : 0;
  $('news-status').innerHTML = newsFetching ? 'Buscando notícias novas dos seus ativos…'
    : newsLoading ? 'Carregando…'
    : `${lastCheck ? `Verificado ${esc(ago(new Date(lastCheck).toISOString()))}` : 'Ainda sem verificação'}${newsError ? ` · <span class="warn-txt">${esc(newsError)}</span>` : ''}`;
  if (!assets.size) { box.innerHTML = '<div class="empty-state">Cadastre seus ativos da bolsa, do exterior ou cripto em <b>Ativos</b> para ver as notícias deles aqui.</div>'; return; }
  const rows = filterNews(newsRows, assets, { filter: newsFilter, asset: newsAssetFilter });
  const attention = rows.filter((n) => isAttention(n)).sort(bySeverity);
  const groups = groupByAsset(rows, assets);
  const indirect = rows.filter((n) => !n.relevant).sort((a, b) => b.published - a.published);
  const withNews = new Set(groups.map((g) => g.asset.key));
  const quiet = list.filter((a) => !withNews.has(a.key) && (!newsAssetFilter || a.key === newsAssetFilter));
  let html = '';
  if (!newsRows.length && (newsLoading || newsFetching)) { box.innerHTML = '<div class="empty-state">Buscando as notícias dos seus ativos…</div>'; return; }
  html += `<div class="news-summary"><span>Últimos ${NEWS_WINDOW_DAYS} dias:</span><span><b>${cnt.alto}</b> de impacto alto</span><span><b>${cnt.medio}</b> médio</span><span><b>${cnt.baixo}</b> baixo</span><span><b style="color:var(--coral)">${cnt.negativo}</b> ruins</span><span><b style="color:var(--teal)">${cnt.positivo}</b> boas</span></div>`;
  if (attention.length) {
    html += `<div class="card news-attn"><h3 class="card-title">Precisa da sua atenção</h3><p class="card-sub">Impacto alto, ou médio e ruim, nos últimos 7 dias. Abra a notícia e veja se muda o seu plano para o ativo.</p>${attention.slice(0, 8).map((n) => newsItemHtml(n, { showTicker: true })).join('')}${attention.length > 8 ? `<div class="news-meta">+ ${attention.length - 8} abaixo, em cada ativo.</div>` : ''}</div>`;
  }
  groups.forEach((g) => {
    const a = g.asset;
    const w = a.weight != null ? `${pct1(a.weight)}% da carteira` : `alvo de ${pct1(a.target)}% da carteira`;
    const first = g.items.slice(0, 3), rest = g.items.slice(3);
    html += `<section class="card news-group"><header class="news-group-head"><div><span class="news-group-tk">${esc(a.ticker)}</span><span class="news-group-cls">${esc(a.cls)}</span></div>
      <div class="news-group-meta">${w}${g.bad ? ` · <span class="bad">▼ ${g.bad} ${g.bad === 1 ? 'ruim' : 'ruins'}</span>` : ''}${g.good ? ` · <span class="good">▲ ${g.good} ${g.good === 1 ? 'boa' : 'boas'}</span>` : ''}</div></header>
      ${first.map((n) => newsItemHtml(n)).join('')}
      ${rest.length ? `<details class="news-more"><summary>Mais ${rest.length} ${rest.length === 1 ? 'notícia' : 'notícias'} de ${esc(a.ticker)}</summary>${rest.map((n) => newsItemHtml(n)).join('')}</details>` : ''}</section>`;
  });
  if (!groups.length && !attention.length) {
    html += `<div class="empty-state">${newsFilter === 'todas' ? 'Nenhuma notícia sobre os seus ativos nos últimos dias.' : 'Nenhuma notícia com esse filtro.'}</div>`;
  }
  if (indirect.length) {
    html += `<div class="card"><details class="news-more"><summary>Menções em listas e resumos do mercado (${indirect.length})</summary><p class="news-foot">O ativo aparece citado, mas a notícia não é sobre ele.</p>${indirect.slice(0, 30).map((n) => newsItemHtml(n, { showTicker: true })).join('')}</details></div>`;
  }
  if (quiet.length && newsFilter === 'todas') {
    html += `<div class="card"><h3 class="card-title" style="font-size:14px;">Sem notícias nos últimos ${NEWS_WINDOW_DAYS} dias</h3><div class="news-quiet">${quiet.map((a) => `<span>${esc(a.ticker)}</span>`).join('')}</div></div>`;
  }
  html += `<p class="news-foot">Notícias do Google Notícias, só dos seus ativos. ${newsAiOn() ? 'Impacto, direção e resumo feitos por IA a partir do título.' : 'Classificação automática simples, por palavras do título — com a IA ligada, cada notícia ganha um resumo e uma leitura melhor do impacto.'} Não é recomendação de compra ou venda: abra a notícia, veja a fonte e decida.</p>`;
  box.innerHTML = html;
}

// ---------------------------------------------------------------------
// Navegação
// ---------------------------------------------------------------------
const TABS = ['painel', 'aporte', 'noticias', 'ativos', 'config', 'agenda', 'timeline'];
function switchTab(tab) {
  if (!TABS.includes(tab)) tab = 'painel';
  activeTab = tab;
  document.querySelectorAll('.nav-btn').forEach((b) => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'); });
  TABS.forEach((t) => { $('tab-' + t).hidden = t !== tab; });
  window.scrollTo(0, 0);
  if (tab === 'painel') renderPainel();
  if (tab === 'aporte') renderAporteTab();
  if (tab === 'noticias') { renderNoticias(); if (Date.now() - newsLoadedAt > 15 * 60e3 && !newsLoading) loadNews(); }
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
  const cents = Math.max(0, Math.round(total * 100 + 1e-7)); // arredonda UMA vez (R$ 50,9995 → R$ 51,00)
  const intPart = Math.floor(cents / 100);
  const cent = String(cents % 100).padStart(2, '0');
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
  labelIdx.forEach((i) => { g += `<text x="${xAt(i)}" y="${H - 8}" text-anchor="${n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle'}">${esc(points[i].x)}</text>`; });
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
    g += `<g class="hov"><line x1="${xAt(i)}" x2="${xAt(i)}" y1="${T}" y2="${T + ih}" stroke="var(--border-strong)" stroke-width="1" opacity="0"/><rect x="${xAt(i) - band / 2}" y="${T}" width="${band}" height="${ih}" fill="transparent" data-tip="${esc(tipHtml)}" data-tx="${xAt(i)}" data-ty="${top}"/></g>`;
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
    g += `<rect x="${L + slot * i}" y="${T}" width="${slot}" height="${ih}" fill="transparent" data-tip="${esc(`<div class="t">${esc(b.full)}</div><span class="num">R$ ${n2(b.v)}</span>`)}" data-tx="${cx}" data-ty="${yAt(b.v)}"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${g}</svg>`;
}

/** Ativos com cotas e nenhum preço conhecido (o patrimônio mostrado fica menor do que o real). */
function unpricedHoldings() {
  const out = [];
  state.classes.forEach((c) => {
    if (!hasAssets(c) || buyMode(c) === 'valor') return;
    c.assets.forEach((a) => { if (Number(a.qty) > 0 && !(assetPrice(c, a, quotes).price > 0) && !(Number(a.currentValue) > 0)) out.push(normTicker(a.ticker) || '(sem ticker)'); });
  });
  return out;
}
function renderPainel() {
  const c = $('painel-container');
  const fx = fxCtx();
  const total = portfolioTotalBRL(state, quotes, fx);
  const aportes = state.aportes.filter((a) => a.date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const totalAportado = aportes.reduce((s, a) => s + (Number(a.disponivel) || 0), 0);
  const proventos = state.dividendos.reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const rows = state.classes.map((cl, idx) => { const v = classValueBRL(cl, quotes, fx) || 0; return { cl, idx, v, cur: total > 0 ? (v / total) * 100 : 0, ideal: Number(cl.idealPct) || 0 }; });
  const align = total > 0 ? alignmentScore(rows.map((r) => ({ idealPct: r.ideal, currentPct: r.cur }))) : null;
  const ano = String(new Date().getFullYear());
  const provAno = state.dividendos.filter((d) => String(d.date || '').startsWith(ano)).reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const alignColor = align === null ? 'var(--text-faint)' : align >= 90 ? 'var(--teal)' : align >= 75 ? 'var(--amber)' : 'var(--coral)';
  let html = `<div class="kpi-grid">
    <div class="kpi"><div class="k">Patrimônio</div><div class="v">${compact(total)}</div><div class="s num">R$ ${n2(total)}</div>${unpricedHoldings().length ? `<div class="s" style="color:var(--coral);">Incompleto: ${esc(unpricedHoldings().join(', '))} sem preço</div>` : ''}</div>
    <div class="kpi"><div class="k">Total aportado</div><div class="v">${compact(totalAportado)}</div><div class="s">${aportes.length} aporte${aportes.length === 1 ? '' : 's'} registrado${aportes.length === 1 ? '' : 's'}</div></div>
    <div class="kpi"><div class="k">Proventos recebidos</div><div class="v">${compact(proventos)}</div><div class="s">R$ ${n2(provAno)} em ${ano}</div></div>
    <div class="kpi"><div class="k">Alinhamento com o plano</div><div class="v" style="color:${alignColor}">${align === null ? '—' : pct1(align) + '%'}</div><div class="s">${align === null ? 'Cadastre suas quantidades para medir' : align >= 90 ? 'Carteira próxima do ideal' : align >= 75 ? 'Alguns ajustes pendentes' : 'Carteira longe do plano'}</div></div>
  </div>`;
  const changes = tickerChangeAlerts();
  const alerts = newsAlerts();
  if (changes.length || alerts.length) {
    html += `<div class="card attention-card"><h3 class="card-title">Precisa da sua atenção</h3>${changes.map(({ c: cl, a, ch }) => `<div class="attn-row"><div class="attn-txt"><b>${esc(normTicker(a.ticker))}</b> ${esc(ch.note)}.</div><button class="btn btn-sm" data-swap-c="${esc(cl.id)}" data-swap-a="${esc(a.id)}">${esc(swapLabel(cl, a, ch.to, ch.factor))}</button></div>`).join('')}${alerts.slice(0, 3).map((n) => `<div class="attn-row"><div class="attn-txt"><span class="imp-tag ${n.impact}">${IMPACT_TXT[n.impact]}</span> <span class="dir-tag ${n.direction}">${DIR_TXT[n.direction]}</span> <b>${esc(tickerOfKey(n.ticker))}</b>: <a class="news-title" style="display:inline; font-size:13.5px;" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a></div></div>`).join('')}${alerts.length ? `<div class="attn-row"><div class="attn-txt" style="color:var(--text-muted);">${alerts.length} ${alerts.length === 1 ? 'notícia pede' : 'notícias pedem'} atenção nos últimos 7 dias.</div><button class="btn btn-sm" data-goto="noticias">Ver notícias</button></div>` : ''}</div>`;
  }
  let distHtml;
  if (total <= 0) {
    distHtml = '<div class="panel-empty">Sua carteira ainda está zerada. Informe quantas cotas você tem em <b>Ativos</b> (os preços vêm sozinhos) — ou faça seu primeiro aporte.<br><button class="btn btn-sm" data-goto="ativos">Ir para Ativos</button> <button class="btn btn-sm" data-goto="aporte">Fazer um aporte</button></div>';
  } else {
    const segs = rows.filter((r) => r.v > 0).map((r) => `<div class="comp-seg" style="flex:${r.v} 1 0; background:${classColor(r.idx)};" data-tip="${esc(`<div class="t">${esc(r.cl.name)}</div><span class="num">${pct1(r.cur)}%</span> · R$ ${n2(r.v)}`)}"></div>`).join('');
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
  bindSwapButtons(c);
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
  // carteira zerada: a sugestão divide o aporte só pelos percentuais (certo para quem está começando)
  const anyAsset = state.classes.some((c) => hasAssets(c) && c.assets.length > 0);
  const empty = state.classes.every((c) => (hasAssets(c) ? c.assets.every((a) => !(Number(a.qty) > 0) && !(Number(a.currentValue) > 0)) : !(Number(c.currentValue) > 0)));
  if (anyAsset && empty) items.push({ k: 'warn', t: 'Nenhuma quantidade informada: a carteira está zerada. Se você já tem investimentos, informe <b>quantas cotas tem de cada ativo</b> — sem isso a sugestão considera a carteira vazia e divide o aporte só pelos seus percentuais. <button class="link-btn act" data-goto="ativos">Informar em Ativos</button>' });
  // tickers que mudaram de código (incorporação, troca de gestão): troca aqui mesmo, com a conversão
  tickerChangeAlerts().forEach(({ c, a, ch }) => items.push({ k: 'bad', t: `<b>${esc(normTicker(a.ticker))}</b> ${esc(ch.note)}. <button class="link-btn act" data-swap-c="${esc(c.id)}" data-swap-a="${esc(a.id)}">${esc(swapLabel(c, a, ch.to, ch.factor))}</button>` }));
  const assetErrs = r.errors.filter((e) => e.code === 'soma_ativos' || e.code === 'classe_vazia');
  if (assetErrs.length) assetErrs.forEach((e) => items.push({ k: 'bad', t: esc(e.msg) + ' <button class="link-btn act" data-goto="ativos">Ajustar</button>' }));
  else items.push({ k: 'ok', t: 'Ativos de cada classe somam <b>100%</b>.' });
  const cashErr = r.errors.find((e) => e.code.startsWith('caixa') || e.code === 'sem_caixa');
  items.push(cashErr ? { k: 'bad', t: esc(cashErr.msg) + ' <button class="link-btn act" data-goto="config">Ajustar</button>' } : { k: 'ok', t: `Caixa de Oportunidade: <b>${esc(state.classes.find((c) => c.isCash)?.name || '')}</b>.` });
  r.errors.filter((e) => e.code === 'sem_cambio').forEach((e) => items.push({ k: 'bad', t: esc(e.msg) }));
  r.errors.filter((e) => e.code === 'posicao_sem_preco').forEach((e) => items.push({ k: 'bad', t: esc(e.msg) + ' <button class="link-btn act" data-goto="ativos">Ver em Ativos</button>' }));
  const shown = new Set(['soma_classes', 'soma_ativos', 'classe_vazia', 'sem_caixa', 'caixa_duplo', 'caixa_com_ativos', 'caixa_moeda', 'sem_cambio', 'posicao_sem_preco']);
  r.errors.filter((e) => !shown.has(e.code)).forEach((e) => items.push({ k: 'bad', t: esc(e.msg) }));
  const dupes = [], invalid = [];
  state.classes.forEach((c) => {
    if (!hasAssets(c)) return;
    const seen = new Set();
    c.assets.forEach((a) => {
      const t = normTicker(a.ticker);
      if (!t) return;
      if (seen.has(t)) dupes.push(`${t} (${c.name})`); seen.add(t);
      if (quoteSource(c) !== 'none' && !isQuotableTicker(t)) invalid.push(t);
    });
  });
  if (r.stale.length) items.push({ k: 'warn', t: `<b>${r.stale.length}</b> ${r.stale.length === 1 ? 'ativo está' : 'ativos estão'} sem cotação recente e ${r.stale.length === 1 ? 'vai' : 'vão'} usar o último preço conhecido: ${r.stale.map(esc).join(', ')}. Confira esses preços na corretora.` });
  if (dupes.length) items.push({ k: 'warn', t: `Ticker repetido na mesma classe: <b>${dupes.map(esc).join(', ')}</b> — junte em uma linha só. <button class="link-btn act" data-goto="ativos">Ver em Ativos</button>` });
  if (invalid.length) items.push({ k: 'warn', t: `Ticker inválido (use só letras e números, sem espaços): <b>${invalid.map(esc).join(', ')}</b>. <button class="link-btn act" data-goto="ativos">Corrigir</button>` });
  if (r.needPrice > 0) {
    if (!r.missing.length) items.push({ k: 'ok', t: `Todos os <b>${r.priced}</b> ativos com preço${newestQuoteTime() ? ` (cotações ${ago(newestQuoteTime())})` : ''}.` });
    else items.push({ k: 'warn', t: `<b>${r.missing.length}</b> de ${r.needPrice} ativos sem preço — eles ficam fora da compra e a parte deles vai para os outros ativos da classe (ou para o Caixa). <button class="link-btn act" data-refresh="1">Atualizar cotações</button> <button class="link-btn act" data-goto="ativos">Ver em Ativos</button><div class="tick-list">${r.missing.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` });
  }
  $('ready-card').innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap;"><h3 class="card-title" style="margin:0;">Antes de calcular</h3>${quotesRefreshing ? '<span class="quote-chip busy"><span class="qdot"></span>Atualizando cotações…</span>' : ''}</div><div class="ready-list">${items.map((i) => `<div class="ready-item ${i.k}"><span class="ic">${i.k === 'ok' ? '✓' : i.k === 'warn' ? '!' : '×'}</span><div>${i.t}</div></div>`).join('')}</div>`;
  $('ready-card').querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.goto)));
  $('ready-card').querySelectorAll('[data-refresh]').forEach((b) => b.addEventListener('click', () => refreshQuotes({ silent: false })));
  bindSwapButtons($('ready-card'));
}
/** Ativos cujo ticker mudou de código (lista conhecida) e que estão sem cotação atual. */
function tickerChangeAlerts() {
  const out = [];
  state.classes.forEach((c) => {
    if (!hasAssets(c) || buyMode(c) === 'valor') return;
    c.assets.forEach((a) => {
      const ch = TICKER_CHANGES[normTicker(a.ticker)];
      if (!ch) return;
      const q = quotes[quoteKey(quoteSource(c), a.ticker)];
      if (q && !q.failed && !q.stale) return; // ainda com cotação atual: não insiste
      out.push({ c, a, ch });
    });
  });
  return out;
}
function bindSwapButtons(root) {
  root.querySelectorAll('[data-swap-a]').forEach((b) => b.addEventListener('click', () => {
    const c = state.classes.find((x) => x.id === b.dataset.swapC);
    const a = c?.assets.find((x) => x.id === b.dataset.swapA);
    const ch = a && TICKER_CHANGES[normTicker(a.ticker)];
    if (ch) swapTicker(c.id, a.id, ch.to, ch.factor, ch.date);
  }));
}
function renderAporteTab() { renderReady(); if (!invalidatePlanIfStale() && lastPlan) renderResultado(); }

/** A ordem calculada só vale para a carteira e as cotações daquele momento. */
function planIsCurrent() {
  if (!lastPlan || !state) return false;
  if (Date.now() - lastPlan.at > 30 * 60 * 1000) return false;
  try { return lastPlan.plan.sig === stateSignature(state, market()); } catch { return false; }
}
function invalidatePlanIfStale() {
  if (!lastPlan || planIsCurrent()) return false;
  const old = Date.now() - lastPlan.at > 30 * 60 * 1000;
  lastPlan = null;
  const cont = $('resultado-container');
  if (cont) cont.innerHTML = `<div class="msg-box warn">${old ? 'Este cálculo tem mais de 30 minutos.' : 'A carteira ou as cotações mudaram depois do cálculo.'} Calcule de novo para ver a ordem atualizada.</div>`;
  return true;
}

function calcular() {
  const cont = $('resultado-container');
  lastPlan = null;
  const r = readField($('aporte-valor'), { label: 'Valor do aporte', max: 100000000, allowEmpty: false });
  if (!r.ok) {
    const tooBig = /máximo/.test(r.msg);
    cont.innerHTML = `<div class="msg-box err">${tooBig ? 'Valor alto demais — confira se digitou certo (máximo R$ 100 milhões).' : /negativo|preencha/.test(r.msg) ? 'Informe um valor de aporte maior que zero.' : esc(r.msg)}</div>`;
    $('aporte-valor').focus(); return;
  }
  const valor = r.value;
  if (!(toCents(valor) > 0)) { cont.innerHTML = '<div class="msg-box err">Informe um valor de aporte maior que zero.</div>'; $('aporte-valor').focus(); return; }
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
  lastPlan = { plan, valor, at: Date.now(), whileRefreshing: quotesRefreshing };
  renderResultado();
  cont.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function orderLines(plan) {
  const lines = [];
  const group = (title, list, fmt) => { if (!list.length) return; lines.push('', title); list.forEach((o) => lines.push('• ' + fmt(o))); };
  const ex = (o) => (o.currency !== 'BRL' ? ` (≈ ${moneyC(o.valueBRL)})` : '');
  group('BOLSA (cotas inteiras)', plan.orders.filter((o) => o.mode === 'lote'),
    (o) => `Comprar ${o.qty} ${o.ticker} a ${priceTxt(o.price, o.currency)} = ${moneyC(o.valueNative, o.currency)}${ex(o)}`);
  group('EXTERIOR (valor exato)', plan.orders.filter((o) => o.mode === 'fracao' && o.classType === 'exterior'),
    (o) => `Comprar ${moneyC(o.valueNative, o.currency)} de ${o.ticker} (≈ ${qtyTxt(o.qty, 'fracao')})${ex(o)}`);
  group('CRIPTO (valor exato)', plan.orders.filter((o) => o.mode === 'fracao' && o.classType !== 'exterior'),
    (o) => `Comprar ${moneyC(o.valueNative, o.currency)} de ${o.ticker} (≈ ${qtyTxt(o.qty, 'fracao')})`);
  group('RENDA FIXA', plan.orders.filter((o) => o.mode === 'valor'), (o) => `Aplicar ${moneyC(o.valueNative, o.currency)} em ${o.ticker}${ex(o)}`);
  group('RESERVAR', plan.classes.filter((c) => c.directBRL > 0 && !c.isCash), (c) => `${moneyC(c.directNative, c.currency)} em ${c.name}${c.currency !== 'BRL' ? ` (≈ ${moneyC(c.directBRL)})` : ''}`);
  const cash = plan.toCash + plan.cashDirect;
  if (cash > 0) lines.push('', `CAIXA DE OPORTUNIDADE: ${moneyC(cash)}${plan.cashDirect && plan.toCash ? ` (${moneyC(plan.cashDirect)} do plano + ${moneyC(plan.toCash)} de sobras)` : ''}`);
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
  const warns = plan.warnings.map((w) => w.msg);
  if (lastPlan.whileRefreshing) warns.push('As cotações ainda estavam sendo atualizadas quando você calculou. Se algum preço mudar, esta ordem é cancelada e o app pede um novo cálculo.');
  if (warns.length) html += `<div class="msg-box warn"><h3>Atenção</h3><ul>${warns.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`;
  html += '<div class="order-card"><div class="order-title">🧾 Ordem de compra sugerida</div>';
  if (lote.length) html += `<div class="order-section-title">Comprar na bolsa (cotas inteiras)</div><div class="order-list">${lote.map((o) => row(`<span class="oi-qty" style="min-width:0; margin-right:8px;">${o.qty}×</span>${esc(o.ticker)}`, `${esc(o.className)} · ${priceTxt(o.price, o.currency)}${src(o)}${o.complemento ? ' · com a sobra' : ''}`, moneyC(o.valueNative, o.currency) + (o.currency !== 'BRL' ? `<div class="oi-sub">≈ ${moneyC(o.valueBRL)}</div>` : ''), ` <span class="priority-badge ${o.priority >= 70 ? '' : o.priority >= 40 ? 'mid' : 'low'}" title="Distância da meta: 100 = o mais longe da classe">prior. ${o.priority}</span>`)).join('')}</div>`;
  if (frac.length) html += `<div class="order-section-title">Comprar valor exato</div><div class="order-list">${frac.map((o) => row(esc(o.ticker), `${esc(o.className)} · ≈ ${qtyTxt(o.qty, 'fracao')} a ${priceTxt(o.price, o.currency)}${src(o)}`, moneyC(o.valueNative, o.currency) + (o.currency !== 'BRL' ? `<div class="oi-sub">≈ ${moneyC(o.valueBRL)}</div>` : ''))).join('')}</div>`;
  if (valor.length) html += `<div class="order-section-title">Aplicar</div><div class="order-list">${valor.map((o) => row(esc(o.ticker), esc(o.className), moneyC(o.valueNative, o.currency))).join('')}</div>`;
  const directs = plan.classes.filter((c) => c.directBRL > 0 && !c.isCash);
  if (directs.length) html += `<div class="order-section-title">Reservar</div><div class="order-list">${directs.map((c) => row(esc(c.name), 'valor direto', moneyC(c.directNative, c.currency) + (c.currency !== 'BRL' ? `<div class="oi-sub">≈ ${moneyC(c.directBRL)}</div>` : ''))).join('')}</div>`;
  const cashTotal = plan.toCash + plan.cashDirect;
  html += `<div class="order-section-title">Caixa de Oportunidade</div><div class="order-list">${row(esc(state.classes.find((c) => c.isCash)?.name || 'Caixa'), `parte do plano ${moneyC(plan.cashDirect)} + sobras ${moneyC(plan.toCash)}`, moneyC(cashTotal))}</div>`;
  if (!plan.orders.length && !directs.length) html += '<div class="empty-state">Nada pôde ser comprado com este valor — tudo vai para o Caixa de Oportunidade.</div>';
  html += `<div class="order-totals">
    <div><div class="k">Aporte</div><div class="v">${moneyC(plan.aporte)}</div></div>
    <div><div class="k">Comprado / aplicado</div><div class="v">${moneyC(plan.investedBRL + plan.directBRL - plan.cashDirect)}</div></div>
    <div><div class="k">Para o Caixa</div><div class="v" style="color:var(--brass)">${moneyC(cashTotal)}</div></div>
    <div><div class="k">Alinhamento</div><div class="align-compare"><span>${plan.before === null ? '—' : pct1(plan.before) + '%'}</span><span class="align-arrow">→</span><span class="align-after">${pct1(plan.after)}%</span></div></div>
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
    return `<div class="result-class"><div class="result-class-head" data-toggle="${esc(c.classId)}" role="button" tabindex="0" aria-expanded="false"><div class="rc-left"><div class="rc-name"><span class="swatch" style="display:inline-block; background:${classColor(idx)}; margin-right:8px;"></span>${esc(c.name)}</div>
      <div class="rc-bar-wrap"><div class="ledger-bar"><div class="ledger-bar-fill ${curPct >= c.idealPct ? 'over' : 'under'}" style="width:${Math.min(100, curPct)}%"></div><div class="ledger-bar-target" style="left:${Math.min(100, c.idealPct)}%"></div></div><div class="rc-pcts">atual ${pct1(curPct)}% · ideal ${pct(c.idealPct)}%</div></div></div>
      <div class="rc-right"><div class="rc-aporte"><div class="k">Recebe</div><div class="v ${c.allocBRL > 0 ? '' : 'zero'}">${moneyC(c.allocBRL)}</div></div><div class="chev">▸</div></div></div>
      <div class="result-class-body">${body}</div></div>`;
  }).join('');
  cont.innerHTML = html;
  cont.querySelectorAll('[data-toggle]').forEach((h) => {
    const toggle = () => { const open = h.nextElementSibling.classList.toggle('open'); h.querySelector('.chev').classList.toggle('open', open); h.setAttribute('aria-expanded', open ? 'true' : 'false'); };
    h.addEventListener('click', toggle);
    h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
  $('btn-registrar').addEventListener('click', registrarAporte);
  $('btn-copy-order').addEventListener('click', async () => {
    const txt = `Aporte+ — ordem de ${fmtDateBR(todayISO())}\nAporte: ${moneyC(plan.aporte)}\n` + orderLines(plan).join('\n');
    try { await navigator.clipboard.writeText(txt); toast('Ordem copiada.'); } catch { dialog({ title: 'Copiar ordem', html: `<textarea style="width:100%; height:200px; background:var(--surface-2); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:10px; font-family:IBM Plex Mono, monospace; font-size:12px;">${esc(txt)}</textarea>` }); }
  });
}

let registering = false;
async function registrarAporte() {
  if (registering) { toast('Aguarde: ainda salvando o aporte anterior…'); return; }
  if (!lastPlan) return;
  if (conflict) { dialog({ title: 'Não dá para registrar agora', html: '<p>A carteira foi alterada em outro aparelho e esta tela não está salvando. Recarregue para pegar a versão mais recente (veja o aviso no topo) e calcule de novo.</p>' }); return; }
  if (invalidatePlanIfStale()) return;
  const { plan } = lastPlan;
  registering = true;
  try {
    const ok = await confirmBox('Registrar aporte?', `Vou somar à sua carteira as compras desta ordem (${moneyC(plan.aporte)}). Faça as compras na sua corretora. Se precisar, dá para desfazer depois em Histórico.`, 'Registrar');
    if (!ok) return;
    if (invalidatePlanIfStale()) return; // algo mudou enquanto a confirmação estava aberta
    const obs = $('aporte-obs').value.trim(); // a observação vale como está agora (pode ter sido digitada depois do cálculo)
    let res;
    try { res = applyPlan(state, plan, market(), { date: todayISO(), obs }); } catch (e) {
      console.error(e);
      lastPlan = null; $('resultado-container').innerHTML = '';
      dialog({ title: 'Não registrado', html: `<p>Nada foi alterado. Motivo: ${esc(e.message)}</p>` });
      return;
    }
    state = res.state;
    lastPlan = null;
    $('aporte-valor').value = ''; $('aporte-obs').value = '';
    $('resultado-container').innerHTML = '';
    dirty = true; editGen++;
    renderTopbar(); renderReady();
    toast('Aporte registrado. Salvando na nuvem…', { ms: 20000 });
    const saved = await flushSave();
    if (reportSave(saved, 'Aporte registrado')) {
      toast(`Aporte registrado e salvo! Patrimônio: ${money(portfolioTotalBRL(state, quotes, fxCtx()))}.`, { action: { label: 'Desfazer', run: () => undoAporte(res.record.id) } });
    } else hideToast();
  } finally { registering = false; }
}

/** Desfaz um aporte: tira exatamente o que ele somou. O que foi feito depois continua. */
async function undoAporte(aporteId) {
  const rec = state?.aportes?.find((a) => a.id === aporteId);
  if (!rec) { toast('Este aporte não existe mais.'); return; }
  if (!Array.isArray(rec.deltas)) { dialog({ title: 'Não dá para desfazer automaticamente', html: '<p>Este aporte foi registrado numa versão antiga do app, que não guardava o detalhe do que foi somado. Ajuste as quantidades em Ativos, se precisar.</p>' }); return; }
  const curOf = (d) => { const c = state.classes.find((x) => x.id === d.classId); return c ? classCurrency(c) : 'BRL'; };
  const parts = rec.deltas.map((d) => (d.field === 'qty' ? (Number.isInteger(d.amount) ? `${qtyTxt(d.amount, 'lote')}× ${esc(d.label)}` : `${qtyTxt(d.amount, 'fracao')} de ${esc(d.label)}`) : `${money(d.amount, curOf(d))} em ${esc(d.label)}`));
  const ok = await confirmBox('Desfazer este aporte?', `Aporte de <b>${money(Number(rec.disponivel) || 0)}</b> em ${fmtDateBR(rec.date)}. Vou tirar da carteira exatamente o que ele somou:<br><span style="font-size:12px; color:var(--text-muted);">${parts.join(' · ')}</span><br><br>O que você fez depois (proventos, outras edições) continua como está.`, 'Desfazer aporte');
  if (!ok) return;
  let res;
  try { res = revertAporte(state, aporteId, market()); } catch (e) { dialog({ title: 'Não foi possível desfazer', html: `<p>${esc(e.message)}</p>` }); return; }
  state = res.state;
  dirty = true; editGen++;
  renderTopbar(); switchTab(activeTab);
  const notes = [];
  if (res.missing.length) notes.push(`Não existem mais e ficaram como estão: ${res.missing.map(esc).join(', ')}.`);
  if (res.clamped.length) notes.push(`Já tinham menos do que o aporte somou e ficaram em zero: ${res.clamped.map(esc).join(', ')}. Confira em Ativos.`);
  const swapped = res.manual.filter((m) => m.swapped);
  const otherManual = res.manual.filter((m) => !m.swapped);
  if (swapped.length) notes.push(`Cotas compradas antes de uma troca de ticker não foram tiradas (a quantidade mudou na conversão) — ajuste à mão em Ativos: ${swapped.map((m) => `${esc(m.label)}: ${qtyTxt(m.qty, Number.isInteger(m.qty) ? 'lote' : 'fracao')} ${m.qty === 1 ? 'cota' : 'cotas'} (${money(m.amount, m.currency)})`).join(' · ')}.`);
  if (otherManual.length) notes.push(`Não deu para tirar sozinho (a classe mudou depois do aporte) — ajuste à mão em Ativos: ${otherManual.map((m) => `${esc(m.label)}: ${money(m.amount, m.currency)}`).join(' · ')}.`);
  const saved = await flushSave();
  if (reportSave(saved, 'Aporte desfeito')) {
    if (notes.length) dialog({ title: 'Aporte desfeito — confira', html: `<p>${notes.join('</p><p>')}</p>` });
    else toast('Aporte desfeito e salvo.');
  }
}

/** Desfazer rápido de remoções (só nesta tela, logo depois de remover). */
function offerSessionUndo(label, run) {
  const token = {};
  sessionUndo = token;
  toast(`${label}.`, { action: { label: 'Desfazer', run: () => { if (sessionUndo !== token) { toast('Não dá mais para desfazer.'); return; } sessionUndo = null; run(); } } });
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
  if (!isQuotableTicker(t)) return `<span class="bad-txt">"${esc(t)}" não é um ticker válido — use só letras e números, sem espaços (ex.: PETR4).</span>`;
  if (c.assets.some((x) => x.id !== a.id && normTicker(x.ticker) === t)) return `<span class="bad-txt">${esc(t)} aparece duas vezes nesta classe — junte as quantidades em uma linha só e remova a outra.</span>`;
  const qFailed = !!q && !!q.failed;
  if (q && q.stale && !qFailed && p.source !== 'manual') return `<span class="bad-txt">A última cotação de ${esc(t)} é de ${ago(q.updated_at).replace('há ', '')} atrás — a fonte parou de atualizar. Confira na corretora ou digite o preço.</span>${p.source === 'cache' ? ` <span class="warn-txt">Usando o último preço conhecido (${priceTxt(p.price, classCurrency(c))}).</span>` : ''}`;
  if (q && !qFailed && q.currency !== classCurrency(c)) return `<span class="bad-txt">A cotação de ${esc(t)} veio em ${esc(q.currency)}, diferente da classe (${classCurrency(c)}). Confira o tipo da classe.</span>`;
  const qTxt = q && !qFailed ? `Cotação ${priceTxt(q.price, q.currency)} · ${ago(q.updated_at)}${q.change_percent != null ? ` · ${q.change_percent >= 0 ? '+' : ''}${pct(q.change_percent)}% no dia` : ''}` : '';
  if (p.source === 'manual') return `Usando o preço digitado.${qTxt ? ` ${qTxt} · <button class="link-btn" data-action="auto-price" data-key="${esc(a.id)}:auto-price">usar automático</button>` : ''}`;
  const before = Array.isArray(a.swaps) && a.swaps.length ? ` · antes ${esc(a.swaps[a.swaps.length - 1].from)}` : '';
  if (p.source === 'auto') return qTxt + before;
  const ch = TICKER_CHANGES[t];
  if (ch && (!q || qFailed)) return `<span class="warn-txt">${esc(t)} ${esc(ch.note)}.</span> <button class="link-btn" data-action="rename" data-key="${esc(a.id)}:rename" data-to="${esc(ch.to)}" data-factor="${ch.factor}">${esc(swapLabel(c, a, ch.to, ch.factor))}</button>`;
  // preço digitado numa versão antiga: oferecido quando não há nenhum outro preço real
  const oldPrice = p.source === 'none' && a.priceMode === 'auto' && Number(a.price) > 0 ? cleanPrice(c, a.price) : 0;
  const useOld = oldPrice > 0 ? ` <button class="link-btn" data-action="use-old-price" data-key="${esc(a.id)}:use-old">usar o preço digitado antes (${priceTxt(oldPrice, classCurrency(c))})</button>` : '';
  if (qFailed || failedQuoteKeys.has(key)) return `<span class="bad-txt">A fonte não reconhece ${esc(t)} — o ticker pode ter mudado ou deixado de ser negociado. Confira na corretora ou digite o preço.</span>${p.source === 'cache' ? ` <span class="warn-txt">Usando o último preço conhecido (${priceTxt(p.price, classCurrency(c))}).</span>` : ''}${useOld} <button class="link-btn" data-action="swap-manual" data-key="${esc(a.id)}:swap-manual">Mudou de código? Trocar ticker</button>`;
  if (p.source === 'cache') return `<span class="warn-txt">Sem cotação agora — usando o último preço conhecido (${priceTxt(p.price, classCurrency(c))}).</span>`;
  return (quotesRefreshing ? 'Buscando cotação…' : '<span class="warn-txt">Sem cotação ainda. Toque em "Atualizar cotações agora" ou digite o preço.</span>') + useOld;
}

/** Texto do botão de troca, já com a conta das cotas (ex.: "Trocar para BTHF11 (13 → 10 cotas)"). */
function swapLabel(cls, a, to, factor) {
  const q = Number(a.qty) || 0;
  if (!(q > 0) || Number(factor) === 1) return `Trocar para ${to}${q > 0 ? ` (mesmas ${qtyTxt(q, buyMode(cls))} cotas)` : ''}`;
  const conv = convertQty(q, factor, buyMode(cls));
  return `Trocar para ${to} (${qtyTxt(q, buyMode(cls))} → ${qtyTxt(conv.qty, buyMode(cls))} ${conv.qty === 1 ? 'cota' : 'cotas'})`;
}
/**
 * Troca o ticker de um ativo (incorporação, mudança de código), convertendo as cotas pela
 * proporção. Os percentuais e o histórico continuam; o preço passa a vir da cotação do novo.
 */
async function swapTicker(classId, assetId, toRaw, factorRaw, date) {
  const cls = state?.classes.find((c) => c.id === classId);
  const a = cls?.assets.find((x) => x.id === assetId);
  if (!cls || !a) return;
  const to = normTicker(toRaw).replace(/\s+/g, '');
  const factor = Number(factorRaw);
  const from = normTicker(a.ticker);
  if (!isQuotableTicker(to)) { toast('Ticker novo inválido — use só letras e números (ex.: BTHF11).'); return; }
  if (to === from) { toast('O ticker novo é igual ao atual.'); return; }
  if (!(factor > 0 && factor <= 1000)) { toast('Proporção inválida.'); return; }
  if (cls.assets.some((x) => x.id !== a.id && normTicker(x.ticker) === to)) {
    toast(`${to} já está em ${cls.name}: some as cotas convertidas na linha de ${to} e remova ${from}.`); return;
  }
  const mode = buyMode(cls);
  const had = Number(a.qty) || 0;
  const conv = convertQty(had, factor, mode);
  const fTxt = factor.toLocaleString('pt-BR', { maximumFractionDigits: 6 });
  if (had > 0 && factor !== 1) {
    const frac = conv.fraction > 0 ? `<p>A sobra de ${conv.fraction.toLocaleString('pt-BR', { maximumFractionDigits: 6 })} cota não vira cota: a B3 junta as frações, vende em leilão e paga em dinheiro na sua conta da corretora. Se quiser, registre esse valor em Histórico → Proventos.</p>` : '';
    const ok = await dialog({ title: `Trocar ${from} por ${to}?`, buttons: [{ label: 'Cancelar', value: false }, { label: 'Trocar', kind: 'primary', value: true }], html:
      `<p>Cada cota de ${esc(from)} vale <b>${fTxt}</b> de ${esc(to)}. Suas <b>${qtyTxt(had, mode)}</b> cotas viram <b>${qtyTxt(conv.qty, mode)}</b> ${conv.qty === 1 ? 'cota' : 'cotas'} de ${esc(to)} (${qtyTxt(had, mode)} × ${fTxt} = ${(Math.round(had * factor * 1e6) / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 6 })}).</p>${frac}<p style="color:var(--text-muted); font-size:13px;">Confira a quantidade na corretora ou na Área do Investidor da B3. Os percentuais e o histórico continuam iguais.</p>` });
    if (!ok) return;
  }
  const backup = JSON.parse(JSON.stringify(a));
  a.ticker = to; a.priceMode = 'auto'; a.price = 0; a.lastQuotePrice = 0;
  if (had > 0 && factor !== 1) { a.qty = conv.qty; a.qtyEpoch = (Number(a.qtyEpoch) || 0) + 1; }
  a.swaps = [...(Array.isArray(a.swaps) ? a.swaps : []), { from, to, factor, date: isISODate(date) ? date : todayISO() }].slice(-10);
  scheduleSave(); renderAtivos(); renderTopbar(); if (activeTab === 'aporte') renderAporteTab(); if (activeTab === 'painel') renderPainel();
  debounceQuoteRefresh();
  offerSessionUndo(`${from} trocado por ${to}${had > 0 && factor !== 1 ? ` (${qtyTxt(conv.qty, mode)} ${conv.qty === 1 ? 'cota' : 'cotas'})` : ''}. Buscando a cotação…`, () => {
    const c2 = state?.classes.find((c) => c.id === classId);
    const i = c2 ? c2.assets.findIndex((x) => x.id === assetId) : -1;
    if (i < 0) { toast('Não dá mais para desfazer.'); return; }
    c2.assets[i] = backup;
    scheduleSave(); renderAtivos(); renderTopbar(); if (activeTab === 'aporte') renderAporteTab(); if (activeTab === 'painel') renderPainel(); debounceQuoteRefresh();
    toast(`${from} de volta.`);
  });
}
async function askManualSwap(classId, assetId) {
  const cls = state?.classes.find((c) => c.id === classId);
  const a = cls?.assets.find((x) => x.id === assetId);
  if (!cls || !a) return;
  const from = normTicker(a.ticker);
  const res = await dialog({
    title: `${from} mudou de código?`,
    html: `<p style="font-size:13px; color:var(--text-muted);">Use quando o ativo foi incorporado, trocou de gestão ou de código. A proporção está no fato relevante do ativo (ex.: BCFF11 → BTHF11 foi 0,8: cada 10 cotas viraram 8).</p>
      <div class="field"><label for="swap-to">Ticker novo</label><input id="swap-to" class="plain-input" maxlength="12" autocomplete="off" spellcheck="false" style="text-transform:uppercase" placeholder="ex.: BTHF11"></div>
      <div class="field" style="margin-top:10px;"><label for="swap-factor">Cotas novas para cada cota antiga</label><input id="swap-factor" class="plain-input" inputmode="decimal" value="1"></div>`,
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Continuar', kind: 'primary', value: (box) => ({ to: box.querySelector('#swap-to').value, factor: parseNum(box.querySelector('#swap-factor').value) }),
      validate: (box) => {
        const to = normTicker(box.querySelector('#swap-to').value).replace(/\s+/g, '');
        const f = parseNum(box.querySelector('#swap-factor').value);
        if (!isQuotableTicker(to)) { toast('Digite o ticker novo (só letras e números).'); return false; }
        if (!(f > 0 && f <= 1000)) { toast('Digite a proporção (ex.: 1 ou 0,8).'); return false; }
        return true;
      } }],
    onOpen: (box) => box.querySelector('#swap-to')?.focus(),
  });
  if (res) await swapTicker(classId, assetId, res.to, res.factor, null);
}

function renderAtivos() {
  pendingRender.delete('asset-list');
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
  const again = () => rerenderKeepFocus(() => { renderAtivos(); renderTopbar(); });
  list.innerHTML = cls.assets.length ? '' : `<div class="empty-state">Nenhum ativo em ${esc(cls.name)} ainda.</div>`;
  cls.assets.forEach((a) => {
    const card = document.createElement('div');
    card.className = 'asset-card';
    const p = assetPrice(cls, a, quotes);
    const auto = isAutoValued(cls, a, quotes);
    const val = assetValue(cls, a, quotes);
    const tl = termLabel(a.termometro.nota);
    const k = (f) => `data-f="${f}" data-key="${esc(a.id)}:${f}"`;
    const qtyVal = Number(a.qty) > 0 ? Number(a.qty).toLocaleString('pt-BR', { maximumFractionDigits: 8, useGrouping: false }) : '0';
    let fields = `<div class="field ticker"><label>${mode === 'valor' ? 'Ativo / título' : 'Ticker'}</label><input class="name-input" value="${esc(a.ticker)}" ${k('ticker')} ${mode === 'valor' ? '' : 'style="text-transform:uppercase"'} maxlength="40" autocomplete="off" spellcheck="false"></div>
      <div class="field pct"><label title="Percentual ideal dentro da classe">% ideal</label><div class="pct-input-wrap"><input class="pct-input" inputmode="decimal" value="${pct(a.idealPct)}" ${k('idealPct')}></div></div>`;
    if (mode === 'valor') {
      fields += `<div class="field val"><label>Valor aplicado</label><div class="value-input-wrap ${usd}"><input class="value-input" inputmode="decimal" value="${n2(a.currentValue)}" ${k('currentValue')}></div></div>
        <div class="field val"><label title="Menor valor que a aplicação aceita (ex.: Tesouro ≈ R$ 30)">Aplicação mín.</label><div class="value-input-wrap ${usd}"><input class="value-input" inputmode="decimal" value="${n2(a.minAmount || 0)}" ${k('minAmount')}></div></div>`;
    } else {
      fields += `<div class="field small"><label>Quantidade</label><input class="plain-input" inputmode="decimal" value="${qtyVal}" ${k('qty')} title="Quantas cotas/unidades você tem. Deixe 0 para digitar o valor."></div>
        <div class="field val"><label>Preço <span class="src-pill ${p.source}">${{ auto: 'auto', cache: 'última', manual: 'manual', none: 'sem' }[p.source]}</span></label><div class="value-input-wrap ${usd}"><input class="value-input" inputmode="decimal" value="${p.price > 0 ? (p.price < 1 ? p.price.toLocaleString('pt-BR', { maximumFractionDigits: 8 }) : n2(p.price)) : ''}" placeholder="—" ${k('price')}></div></div>
        <div class="field val"><label>${auto ? 'Valor <span class="auto-pill">· auto</span>' : 'Valor atual'}</label><div class="value-input-wrap ${usd}"><input class="value-input" inputmode="decimal" value="${n2(val)}" ${k('currentValue')} ${auto ? 'disabled title="Calculado: quantidade × preço"' : ''}></div></div>`;
      if (mode === 'lote') fields += `<div class="field small"><label title="Cotas por lote (1 no fracionário)">Lote</label><input class="plain-input" inputmode="numeric" value="${a.minQty}" ${k('minQty')}></div>`;
      else fields += `<div class="field val"><label title="Menor compra aceita pela corretora (o app nunca sugere menos de 1,00)">Compra mín.</label><div class="value-input-wrap ${usd}"><input class="value-input" inputmode="decimal" value="${n2(a.minAmount || 0)}" ${k('minAmount')}></div></div>`;
    }
    const s = sentimentCache[normTicker(a.ticker)];
    const termOpen = openTermPanels.has(a.id);
    card.innerHTML = `<div class="asset-card-main">${fields}
        <button class="term-toggle" data-action="toggle-term" data-key="${esc(a.id)}:term" aria-expanded="${termOpen}"><span class="term-dot" style="background:${tl.color}"></span>${a.termometro.nota === null ? 'Termômetro' : esc(a.termometro.nota) + '/100'}</button>${s ? `<span class="mini-sentiment ${esc(s.label)}">${esc({ alta: 'Alta', baixa: 'Baixa', neutro: 'Neutro', sem_novidade: 'Sem novidade' }[s.label] || s.label)}</span>` : ''}
        <div class="asset-card-actions"><button class="icon-btn" data-action="remove" data-key="${esc(a.id)}:remove" title="Remover ativo" aria-label="Remover ${esc(a.ticker || 'ativo')}">✕</button></div>
        <div class="asset-hint-row">${quoteHint(cls, a)}</div>
      </div>
      <div class="term-panel ${termOpen ? 'open' : ''}" data-term-panel>
        <div class="term-panel-row"><div class="field small"><label>Nota (0-100)</label><input class="plain-input" style="width:80px;" inputmode="numeric" value="${a.termometro.nota === null ? '' : esc(a.termometro.nota)}" ${k('nota')} placeholder="—"></div><div style="font-size:12px; color:${tl.color}; font-weight:600;">${tl.label}</div></div>
        <div data-motivos></div>
        <button class="btn btn-sm btn-ghost" data-action="add-motivo" data-key="${esc(a.id)}:add-motivo">+ Adicionar motivo</button>
        <div class="sentiment-box" style="margin-top:16px;"><div style="font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-faint); margin-bottom:8px;">Leitura automática de notícias</div>${renderSentimentBox(a.ticker)}</div>
      </div>`;
    const on = (f, ev, fn) => { const el = card.querySelector(`[data-f="${f}"]`); if (el) el.addEventListener(ev, fn); };
    const field = (f, opts, apply) => on(f, 'change', (e) => { if (fieldOr(e.target, opts, apply)) scheduleSave(); again(); });
    on('ticker', 'change', (e) => {
      const v = mode === 'valor' ? e.target.value.trim().slice(0, 40) : normTicker(e.target.value).replace(/\s+/g, '');
      a.ticker = v; scheduleSave(); again(); if (mode !== 'valor') debounceQuoteRefresh();
    });
    field('idealPct', { label: '% ideal', max: 100 }, (r) => { a.idealPct = r.value; });
    field('currentValue', { label: 'Valor', max: 1e11 }, (r) => { a.currentValue = round2(r.value); });
    field('minAmount', { label: 'Mínimo', max: 1e9 }, (r) => { a.minAmount = round2(r.value); });
    field('qty', { label: mode === 'lote' ? 'Quantidade (cotas inteiras)' : 'Quantidade', max: 1e12, int: mode === 'lote' }, (r) => { a.qty = r.value; });
    field('price', { label: 'Preço', max: 1e9 }, (r) => {
      const v = cleanPrice(cls, r.value);
      if (!r.empty && r.value > 0 && v > 0) { a.price = v; a.priceMode = 'manual'; } else { a.price = 0; a.priceMode = 'auto'; }
    });
    field('minQty', { label: 'Lote', min: 1, max: 1e6, int: true, allowEmpty: false }, (r) => { a.minQty = r.value; });
    field('nota', { label: 'Nota do termômetro', max: 100, int: true }, (r) => { a.termometro.nota = r.empty ? null : r.value; });
    card.querySelector('[data-action="auto-price"]')?.addEventListener('click', () => { a.priceMode = 'auto'; scheduleSave(); again(); });
    card.querySelector('[data-action="use-old-price"]')?.addEventListener('click', () => { a.price = cleanPrice(cls, a.price); a.priceMode = 'manual'; scheduleSave(); again(); toast('Usando o preço digitado. Confira se ele ainda vale.'); });
    card.querySelector('[data-action="rename"]')?.addEventListener('click', (e) => {
      const ch = TICKER_CHANGES[normTicker(a.ticker)];
      if (ch) swapTicker(cls.id, a.id, ch.to, ch.factor, ch.date);
    });
    card.querySelector('[data-action="swap-manual"]')?.addEventListener('click', () => askManualSwap(cls.id, a.id));
    card.querySelector('[data-action="toggle-term"]').addEventListener('click', (e) => {
      const open = card.querySelector('[data-term-panel]').classList.toggle('open');
      if (open) openTermPanels.add(a.id); else openTermPanels.delete(a.id);
      e.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    card.querySelector('[data-action="remove"]').addEventListener('click', async () => {
      if (!(await confirmBox('Remover ativo?', `Remover <b>${esc(a.ticker || 'este ativo')}</b> de ${esc(cls.name)}? O valor dele deixa de contar no patrimônio.`, 'Remover'))) return;
      const idx = cls.assets.findIndex((x) => x.id === a.id);
      if (idx < 0) return;
      const removed = cls.assets.splice(idx, 1)[0];
      scheduleSave(); renderAtivos(); renderTopbar();
      offerSessionUndo(`${removed.ticker || 'Ativo'} removido`, () => {
        const c2 = state?.classes.find((x) => x.id === cls.id);
        if (!c2 || c2.assets.some((x) => x.id === removed.id)) { toast('Não dá mais para desfazer.'); return; }
        c2.assets.splice(Math.min(idx, c2.assets.length), 0, removed);
        scheduleSave(); renderAtivos(); renderTopbar(); toast('Ativo de volta.');
      });
    });
    const renderMotivos = () => {
      const w = card.querySelector('[data-motivos]');
      w.innerHTML = '';
      a.termometro.motivos.forEach((m, i) => {
        const r = document.createElement('div'); r.className = 'motivo-item';
        r.innerHTML = `<input value="${esc(m)}" maxlength="200" aria-label="Motivo ${i + 1}"><button class="icon-btn" style="width:28px;height:28px;" aria-label="Remover motivo">✕</button>`;
        r.querySelector('input').addEventListener('change', (e) => { a.termometro.motivos[i] = e.target.value.slice(0, 200); scheduleSave(); });
        r.querySelector('button').addEventListener('click', () => { a.termometro.motivos.splice(i, 1); scheduleSave(); renderMotivos(); });
        w.appendChild(r);
      });
    };
    renderMotivos();
    card.querySelector('[data-action="add-motivo"]').addEventListener('click', () => {
      if (a.termometro.motivos.length >= 20) { toast('Máximo de 20 motivos.'); return; }
      a.termometro.motivos.push(''); scheduleSave(); renderMotivos();
      const ins = card.querySelectorAll('[data-motivos] input'); ins[ins.length - 1]?.focus();
    });
    list.appendChild(card);
  });
  const sum = sumIdeal(cls.assets);
  const tv = $('asset-total-val');
  tv.textContent = pct(sum) + '%';
  tv.className = 'val ' + (cls.assets.length === 0 ? '' : isHundred(sum) ? 'ok' : 'bad');
}
function renderSentimentBox(ticker) {
  const s = sentimentCache[normTicker(ticker)];
  if (!s) return '<div class="sentiment-empty">As notícias deste ativo, com impacto e se são boas ou ruins, ficam na aba Notícias.</div>';
  const srcList = Array.isArray(s.sources) ? s.sources.filter((x) => x && typeof x === 'object') : [];
  const sources = srcList.slice(0, 2).map((src) => { const u = String(src.url || ''); return /^https?:\/\//i.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(src.title || 'fonte')}</a>` : esc(src.title || ''); }).join(' · ');
  return `<div class="sentiment-head"><span class="sentiment-badge ${esc(s.label)}">${esc({ alta: 'Alta', baixa: 'Baixa', neutro: 'Neutro', sem_novidade: 'Sem novidade' }[s.label] || s.label)}</span><span class="num" style="font-size:12px; color:var(--text-faint);">${Number(s.score) || 0}/100</span></div><div class="sentiment-summary">${esc(s.summary || '')}</div><div class="sentiment-meta">${s.session === 'abertura' ? 'Abertura' : 'Fechamento'} · ${fmtDateBR(s.session_date)}${sources ? ' · ' + sources : ''}</div>`;
}
let quoteT = null;
function debounceQuoteRefresh() { clearTimeout(quoteT); quoteT = setTimeout(() => { syncTrackedTickers(); refreshQuotes(); }, 1200); }

// ---------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------
/** Moeda que a classe terá depois de mudar para o tipo `nt`. */
function currencyForType(cls, nt) {
  if (nt === 'b3' || nt === 'cripto') return 'BRL';
  if (nt === 'exterior') return 'USD';
  return CURRENCIES.includes(cls.currency) ? cls.currency : 'BRL';
}
/**
 * Muda o tipo de uma classe SEM perder valor: o que hoje vale R$ X continua valendo R$ X.
 * Mostra antes exatamente o que vai acontecer e só aplica se a pessoa confirmar.
 */
async function changeClassType(cls, nt) {
  const ot = classType(cls);
  if (nt === ot || !CLASS_TYPES[nt]) return false;
  const fx = fxCtx();
  const oldCur = classCurrency(cls), newCur = currencyForType(cls, nt);
  const rOld = fxRate(oldCur, fx), rNew = fxRate(newCur, fx);
  if (oldCur !== newCur && (rOld === null || rNew === null)) {
    await dialog({ title: 'Sem câmbio para converter', html: `<p>Mudar para "${esc(CLASS_TYPES[nt].label)}" troca a moeda de ${oldCur} para ${newCur}, e não há cotação de câmbio agora para converter os valores. Informe o câmbio em Configuração → Câmbio e tente de novo.</p>` });
    return false;
  }
  const conv = oldCur === newCur ? 1 : rOld / rNew;
  const before = classValueBRL(cls, quotes, fx) || 0;
  const next = JSON.parse(JSON.stringify(cls));
  next.type = nt; next.hasAssets = CLASS_TYPES[nt].hasAssets; next.currency = newCur;
  next.fractional = nt === 'cripto' || nt === 'exterior';
  const notes = [];
  if (!CLASS_TYPES[nt].hasAssets) {
    next.currentValue = round2(classValueNative(cls, quotes) * conv);
    next.assets = [];
    if (cls.assets.length) notes.push(`Os ${plural(cls.assets.length, 'ativo', 'ativos')} da classe serão removidos (no tipo "Valor direto" a classe não tem ativos). O valor de hoje, ${money(next.currentValue, newCur)}, passa a ser o valor da classe.`);
  } else if (!hasAssets(cls)) {
    const v = round2(Math.max(0, Number(cls.currentValue) || 0) * conv);
    if (v > 0) {
      next.assets = [{ id: uid(), ticker: nt === 'rendafixa' ? cls.name.slice(0, 40) : '', idealPct: 100, qty: 0, price: 0, priceMode: 'auto', currentValue: v, minQty: 1, minAmount: 0, lastQuotePrice: 0, termometro: { nota: null, motivos: [] } }];
      notes.push(`O valor atual da classe (${money(v, newCur)}) vira um ativo${nt === 'rendafixa' ? '' : ' sem ticker'} — ajuste o nome e os ativos em Ativos.`);
    }
  } else {
    // cada ativo mantém o valor de hoje; se no tipo novo ele não for calculado por cotas × preço, o valor é guardado
    const hadQty = cls.assets.some((a) => Number(a.qty) > 0);
    next.assets.forEach((a, i) => {
      // o valor de hoje fica guardado em cada ativo; as cotas zeram (no tipo novo seriam de outro mercado)
      a.currentValue = round2(assetValue(cls, cls.assets[i], quotes) * conv);
      a.qty = 0; a.price = 0; a.priceMode = 'auto'; a.lastQuotePrice = 0;
    });
    if (hadQty) notes.push('As quantidades de cotas são zeradas e o valor de hoje de cada ativo fica guardado. Se voltar ao tipo anterior, digite as quantidades de novo em Ativos.');
    if (quoteSource(next) !== quoteSource(cls) && CLASS_TYPES[nt].quote !== 'none') notes.push(`As cotações passam a vir de ${{ b3: 'Bolsa Brasil (B3)', us: 'bolsa dos EUA, em US$', crypto: 'corretoras de cripto' }[CLASS_TYPES[nt].quote]} — confira se os tickers continuam certos.`);
    if (nt === 'rendafixa') notes.push('Os ativos passam a ser contados pelo valor aplicado (sem cotas): guardo o valor de hoje de cada um.');
  }
  if (oldCur !== newCur) notes.push(`A moeda muda de ${oldCur} para ${newCur}; os valores foram convertidos pelo câmbio de hoje.`);
  const after = classValueBRL(next, quotes, fx) || 0;
  if (Math.abs(after - before) >= 0.01) notes.push(`O valor da classe muda de ${money(before)} para ${money(after)} — normalmente porque a cotação do tipo novo ainda não chegou. Confira em Ativos depois.`);
  else notes.push(`O valor da classe continua ${money(before)}.`);
  const ok = await confirmBox(`Mudar "${esc(cls.name)}" para ${esc(CLASS_TYPES[nt].label)}?`, `<ul style="margin:0; padding-left:18px;">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`, 'Mudar o tipo');
  if (!ok) return false;
  Object.keys(cls).forEach((k) => { delete cls[k]; });
  Object.assign(cls, next);
  return true;
}

function renderConfig() {
  const list = $('class-list');
  list.innerHTML = '';
  const again = () => rerenderKeepFocus(() => { renderConfig(); });
  state.classes.forEach((cls) => {
    const t = classType(cls);
    const row = document.createElement('div');
    row.className = 'class-row v4';
    const cv = classValueNative(cls, quotes);
    const cur = classCurrency(cls);
    const curEditable = (t === 'rendafixa' || t === 'valor') && !cls.isCash;
    const canBeCash = t === 'valor' && cur === 'BRL';
    const k = (f) => `data-f="${f}" data-key="${esc(cls.id)}:${f}"`;
    row.innerHTML = `
      <div class="cr-cell cr-name" data-label="Classe"><input class="name-input" value="${esc(cls.name)}" ${k('name')} maxlength="40"></div>
      <div class="cr-cell cr-type" data-label="Tipo"><select class="plain-select type-select" ${k('type')} ${cls.isCash ? 'disabled title="O Caixa é sempre de valor direto"' : ''}>${Object.entries(CLASS_TYPES).map(([key, v]) => `<option value="${key}" ${key === t ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
      <div class="cr-cell cr-pct" data-label="Ideal"><div class="pct-input-wrap"><input class="pct-input" inputmode="decimal" value="${pct(cls.idealPct)}" ${k('idealPct')}></div></div>
      <div class="cr-cell cr-val" data-label="Valor atual"><div class="value-input-wrap ${cur === 'USD' ? 'usd' : ''}"><input class="value-input" inputmode="decimal" value="${n2(cv)}" ${k('currentValue')} ${hasAssets(cls) ? 'disabled title="Soma dos ativos da classe"' : ''}></div></div>
      <div class="cr-cell cr-cur" data-label="Moeda">${curEditable ? `<select class="plain-select" ${k('currency')}>${CURRENCIES.map((c) => `<option value="${c}" ${c === cur ? 'selected' : ''}>${sym(c).trim()}</option>`).join('')}</select>` : `<span style="font-size:13px; color:var(--text-muted); padding:9px 4px; display:inline-block;">${sym(cur).trim()}</span>`}${cls.isCash && cur !== 'BRL' ? ` <button class="link-btn" data-action="cash-brl" data-key="${esc(cls.id)}:cash-brl">Converter para R$</button>` : ''}</div>
      <div class="cr-cell cr-frac">${t === 'exterior' ? `<label class="chk-label" title="Comprar valor exato (fração), sem cota inteira"><input type="checkbox" ${k('fractional')} ${buyMode(cls) === 'fracao' ? 'checked' : ''}> Fração</label>` : t === 'b3' ? '<span class="frac-note" title="Na B3 a compra é sempre em cotas inteiras (o mercado fracionário também negocia cotas inteiras)">cotas inteiras</span>' : ''}</div>
      <label class="cr-cell cr-cash"><input type="radio" name="cash-class" class="chk-cash" ${k('isCash')} ${cls.isCash ? 'checked' : ''} ${canBeCash || cls.isCash ? '' : `disabled title="${t === 'valor' ? 'O Caixa precisa estar em R$' : 'Só uma classe de valor direto pode ser o Caixa'}"`}><span class="cash-word">Caixa</span></label>
      <div class="cr-cell cr-del"><button class="icon-btn" data-action="remove" data-key="${esc(cls.id)}:remove" title="Remover classe" aria-label="Remover classe ${esc(cls.name)}">✕</button></div>`;
    const q = (f) => row.querySelector(`[data-f="${f}"]`);
    q('name').addEventListener('change', (e) => { cls.name = e.target.value.trim().slice(0, 40) || 'Classe'; e.target.value = cls.name; scheduleSave(); renderTopbar(); });
    q('idealPct').addEventListener('change', (e) => { if (fieldOr(e.target, { label: '% ideal', max: 100 }, (r) => { cls.idealPct = r.value; })) scheduleSave(); again(); });
    q('type').addEventListener('change', async (e) => {
      const changed = await changeClassType(cls, e.target.value);
      if (changed) { scheduleSave(); renderTopbar(); debounceQuoteRefresh(); toast('Tipo da classe alterado.'); }
      renderConfig();
      document.querySelector(`[data-key="${CSS.escape(cls.id + ':type')}"]`)?.focus({ preventScroll: true });
    });
    q('currentValue')?.addEventListener('change', (e) => { if (fieldOr(e.target, { label: 'Valor', max: 1e11 }, (r) => { cls.currentValue = round2(r.value); })) scheduleSave(); again(); renderTopbar(); });
    q('currency')?.addEventListener('change', async (e) => {
      const nc = e.target.value;
      if (!CURRENCIES.includes(nc) || nc === cur) return;
      if (classValueNative(cls, quotes) > 0) {
        const ok = await confirmBox('Mudar a moeda?', `Os valores de "${esc(cls.name)}" continuam com os mesmos números, mas passam a ser lidos em ${nc}. Se você queria converter, ajuste os valores depois.`, `Mudar para ${nc}`);
        if (!ok) { renderConfig(); return; }
      }
      cls.currency = nc; scheduleSave(); renderConfig();
    });
    q('fractional')?.addEventListener('change', (e) => { cls.fractional = e.target.checked; scheduleSave(); again(); });
    q('isCash').addEventListener('change', () => {
      if (!canBeCash) { renderConfig(); return; }
      state.classes.forEach((c) => { c.isCash = c.id === cls.id; }); scheduleSave(); renderConfig();
    });
    row.querySelector('[data-action="cash-brl"]')?.addEventListener('click', async () => {
      const r = fxRate(cur, fxCtx());
      if (r === null) { toast(`Sem cotação de ${cur} agora — informe o câmbio abaixo.`); return; }
      const v = round2((Number(cls.currentValue) || 0) * r);
      if (!(await confirmBox('Converter o Caixa para R$?', `${money(Number(cls.currentValue) || 0, cur)} × ${r.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} = <b>${money(v)}</b>.`, 'Converter'))) return;
      cls.currentValue = v; cls.currency = 'BRL'; scheduleSave(); renderConfig();
    });
    row.querySelector('[data-action="remove"]').addEventListener('click', async () => {
      if (cls.isCash) { toast('Escolha outra classe como Caixa antes de remover esta.'); return; }
      const v = classValueBRL(cls, quotes, fxCtx()) || 0;
      if (!(await confirmBox('Remover classe?', `Remover "${esc(cls.name)}"${cls.assets.length ? ` e seus ${plural(cls.assets.length, 'ativo', 'ativos')}` : ''}?${v > 0 ? ` O valor dela (${money(v)}) deixa de contar no patrimônio.` : ''}`, 'Remover'))) return;
      const idx = state.classes.findIndex((c) => c.id === cls.id);
      if (idx < 0) return;
      const removed = state.classes.splice(idx, 1)[0];
      scheduleSave(); renderConfig(); renderTopbar();
      offerSessionUndo(`Classe "${removed.name}" removida`, () => {
        if (!state || state.classes.some((c) => c.id === removed.id)) { toast('Não dá mais para desfazer.'); return; }
        state.classes.splice(Math.min(idx, state.classes.length), 0, removed);
        scheduleSave(); renderConfig(); renderTopbar(); toast('Classe de volta.');
      });
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
  pendingRender.delete('fx-grid');
  const g = $('fx-grid'); if (!g || !state) return;
  g.innerHTML = ['USD', 'EUR'].map((cur) => {
    const auto = fxAuto[cur];
    const man = state.settings.fxManual?.[cur];
    return `<div class="fx-card"><div class="k">${cur === 'USD' ? 'Dólar (US$)' : 'Euro (€)'}</div><div class="v">${man > 0 ? 'R$ ' + n2(man) : auto ? 'R$ ' + n2(auto) : '—'}</div>
      <div class="field"><label>Fixar valor (vazio = automático)</label><div class="value-input-wrap"><input class="value-input" inputmode="decimal" data-fx="${cur}" data-key="fx:${cur}" value="${man > 0 ? n2(man) : ''}" placeholder="automático"></div></div>
      <div class="s">${auto ? `Automático: R$ ${n2(auto)} · ${ago(fxUpdatedAt[cur])}` : 'Automático indisponível no momento'}${man > 0 ? ' · usando o valor fixado' : ''}</div></div>`;
  }).join('');
  g.querySelectorAll('[data-fx]').forEach((inp) => inp.addEventListener('change', (e) => {
    const cur = e.target.dataset.fx;
    if (fieldOr(e.target, { label: `Câmbio ${cur}`, max: 1000 }, (r) => { state.settings.fxManual[cur] = !r.empty && r.value > 0 ? Math.round(r.value * 10000) / 10000 : null; })) scheduleSave();
    rerenderKeepFocus(() => { renderFxCards(); renderTopbar(); });
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
    d.innerHTML = `<div class="field"><label for="agenda-day" style="font-size:11px; text-transform:uppercase; color:var(--text-faint); display:block; margin-bottom:8px;">Dia do mês (1 a 28)</label><input class="plain-input" style="width:80px; text-align:left;" id="agenda-day" inputmode="numeric" value="${esc(ag.dayOfMonth || 5)}"></div>`;
    $('agenda-day').addEventListener('change', (e) => { if (fieldOr(e.target, { label: 'Dia do mês', min: 1, max: 28, int: true, allowEmpty: false }, (r) => { ag.dayOfMonth = r.value; })) scheduleSave(); renderAgenda(); });
  } else if (ag.frequency === 'personalizado') {
    d.innerHTML = `<div class="field" style="min-width:260px;"><label for="agenda-note" style="font-size:11px; text-transform:uppercase; color:var(--text-faint); display:block; margin-bottom:8px;">Sua rotina (nota livre)</label><input class="name-input" id="agenda-note" maxlength="120" value="${esc(ag.customNote || '')}" placeholder="ex: aporto quando sobra dinheiro no fim do mês"></div>`;
    $('agenda-note').addEventListener('input', (e) => { ag.customNote = e.target.value.slice(0, 120); renderAgendaNext(); });
    $('agenda-note').addEventListener('change', () => { scheduleSave(); renderTopbar(); });
  } else d.innerHTML = '';
  renderAgendaNext();
  renderTopbar();
}
function renderAgendaNext() {
  const ag = state.agenda;
  const next = nextAporteDate(ag);
  const el = $('agenda-next-val');
  if (!next) el.textContent = ag.customNote || 'Defina sua rotina abaixo';
  else { const today = new Date(); today.setHours(0, 0, 0, 0); const diff = Math.round((next - today) / 86400000); el.textContent = (diff <= 0 ? 'Hoje' : diff === 1 ? 'Amanhã' : `Em ${diff} dias`) + ' · ' + next.toLocaleDateString('pt-BR'); }
}

// ---------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------
function renderTimeline() {
  if (!$('div-data').value) $('div-data').value = todayISO();
  const aps = state.aportes.map((a, i) => ({ a, i })).sort((x, y) => (x.a.date < y.a.date ? 1 : x.a.date > y.a.date ? -1 : y.i - x.i)).slice(0, 12).map((x) => x.a);
  $('aportes-card').innerHTML = `<h3 class="card-title" style="margin:0 0 ${aps.length ? 8 : 0}px;">Últimos aportes</h3>` +
    (aps.length ? aps.map((a) => {
      const caixa = a.caixa != null ? Number(a.caixa) : Number(a.sobra || 0);
      const det = a.caixa != null && Number(a.caixaPlano) > 0 && Number(a.sobra) > 0 ? ` (${money(Number(a.caixaPlano))} do plano + ${money(Number(a.sobra))} de sobras)` : '';
      const n = (a.compras || []).length;
      return `<div class="aporte-row"><div><div class="d">${fmtDateBR(a.date)}</div><div style="font-size:12px; color:var(--text-muted);">${esc(a.observacao || plural(n, 'compra', 'compras'))}</div></div>
        <div style="text-align:right;"><div class="v">${money(Number(a.disponivel) || 0)}</div><div style="font-size:11px; color:var(--text-faint);">caixa +${money(caixa)}${det}</div>
        ${Array.isArray(a.deltas) ? `<button class="link-btn" data-undo-aporte="${esc(a.id)}" style="font-size:12px; margin-top:2px;">Desfazer</button>` : ''}</div></div>`;
    }).join('') : '<div class="empty-state" style="padding:16px;">Nenhum aporte registrado ainda.</div>');
  $('aportes-card').querySelectorAll('[data-undo-aporte]').forEach((b) => b.addEventListener('click', () => undoAporte(b.dataset.undoAporte)));
  const divs = [...state.dividendos].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 30);
  const pc = $('proventos-card');
  if (pc) {
    pc.innerHTML = `<h3 class="card-title" style="margin:0 0 ${divs.length ? 8 : 0}px;">Proventos registrados</h3>` + (divs.length ? divs.map((d) => `<div class="aporte-row"><div><div class="d">${fmtDateBR(d.date)}</div><div style="font-size:12px; color:var(--text-muted);">${esc(d.tipo || 'Provento')} · ${esc(d.ticker)}${d.addedToCaixa ? ' · somado ao Caixa' : ''}</div></div>
      <div style="text-align:right;"><div class="v">${money(Number(d.valor) || 0)}</div><button class="link-btn" data-del-div="${esc(d.id)}" style="font-size:12px;">Excluir</button></div></div>`).join('')
      : '<div class="empty-state" style="padding:16px;">Nenhum provento registrado ainda.</div>');
    pc.querySelectorAll('[data-del-div]').forEach((b) => b.addEventListener('click', () => deleteDividendo(b.dataset.delDiv)));
  }
  const items = [...state.timeline].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  const c = $('timeline-container');
  if (!items.length) { c.innerHTML = '<div class="empty-state">Nenhum evento ainda. Registre um aporte ou um provento para começar sua linha do tempo.</div>'; return; }
  c.innerHTML = '<div class="timeline">' + items.map((it) => `<div class="tl-item ${esc(it.type)}"><div class="tl-date">${fmtDateBR(it.date)}</div><div class="tl-title">${esc(it.title)}</div>${it.detail ? `<div class="tl-detail">${esc(it.detail)}</div>` : ''}</div>`).join('') + '</div>';
}
const MAX_PROVENTO = 10000000; // R$ 10 milhões por lançamento: acima disso é quase certamente erro de digitação
function addDividendo(e) {
  e.preventDefault();
  const ticker = normTicker($('div-ticker').value).replace(/\s+/g, '').slice(0, 20);
  const tipo = String($('div-tipo').value || 'Outro').slice(0, 30);
  const vr = readField($('div-valor'), { label: 'Valor do provento', max: MAX_PROVENTO, allowEmpty: false });
  const data = $('div-data').value || todayISO();
  const addCaixa = $('div-add-caixa').checked;
  if (!ticker) { toast('Informe o ticker do provento.'); return; }
  if (!vr.ok) { toast(vr.msg); return; }
  const valor = round2(vr.value);
  if (!(valor > 0)) { toast('O valor do provento precisa ser maior que zero.'); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) { toast('Data inválida.'); return; }
  if (data > todayISO()) { toast('A data do provento não pode ser no futuro.'); return; }
  const cash = state.classes.find((c) => c.isCash);
  if (addCaixa && !cash) { toast('Marque uma classe como Caixa em Configuração para somar o provento.'); return; }
  const id = uid();
  state.dividendos.push({ id, date: data, ticker, tipo, valor, addedToCaixa: addCaixa });
  state.timeline.push({ id: uid(), dividendoId: id, date: data, type: 'dividendo', title: `${tipo} de ${ticker}: ${money(valor)}`, detail: addCaixa ? 'Somado ao Caixa de Oportunidade.' : 'Apenas registrado — não somado ao Caixa.' });
  if (addCaixa) cash.currentValue = round2((Number(cash.currentValue) || 0) + valor);
  scheduleSave();
  $('div-ticker').value = ''; $('div-valor').value = '';
  renderTimeline(); renderTopbar();
  toast('Provento registrado.');
}
async function deleteDividendo(id) {
  const d = state.dividendos.find((x) => x.id === id);
  if (!d) return;
  const cash = state.classes.find((c) => c.isCash);
  const fromCash = d.addedToCaixa && cash;
  const ok = await confirmBox('Excluir provento?', `${esc(d.tipo || 'Provento')} de <b>${esc(d.ticker)}</b>: ${money(Number(d.valor) || 0)} em ${fmtDateBR(d.date)}.${fromCash ? ` Ele tinha sido somado ao Caixa — vou tirar ${money(Number(d.valor) || 0)} do Caixa.` : ''}`, 'Excluir');
  if (!ok) return;
  state.dividendos = state.dividendos.filter((x) => x.id !== id);
  const before = state.timeline.length;
  state.timeline = state.timeline.filter((t) => t.dividendoId !== id);
  if (state.timeline.length === before) { // registro antigo, sem ligação: remove o evento igual
    const title = `${d.tipo} de ${d.ticker}: ${money(Number(d.valor) || 0)}`;
    const i = state.timeline.findIndex((t) => t.type === 'dividendo' && t.date === d.date && t.title === title);
    if (i >= 0) state.timeline.splice(i, 1);
  }
  let warn = '';
  if (fromCash) {
    const cur = Number(cash.currentValue) || 0;
    if (cur < Number(d.valor)) warn = ` O Caixa tinha só ${money(cur)} e ficou em R$ 0,00.`;
    cash.currentValue = Math.max(0, round2(cur - Number(d.valor)));
  }
  scheduleSave(); renderTimeline(); renderTopbar();
  toast('Provento excluído.' + warn, { ms: warn ? 7000 : 3600 });
}

// ---------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------
function exportBackup(st = state, name = 'aporte-mais-backup') {
  // proteção: só exporta uma carteira de verdade (nunca um evento de clique ou outro objeto qualquer)
  if (!st || typeof st !== 'object' || !Array.isArray(st.classes)) st = state;
  if (!st || !Array.isArray(st.classes)) { toast('Não há carteira carregada para exportar.'); return; }
  const payload = { app: 'aporte-mais', version: st.version, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), state: st };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${name}-${todayISO()}.json`;
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
  if (!Array.isArray(incoming.classes) || incoming.classes.filter((c) => c && typeof c === 'object' && !Array.isArray(c)).length === 0) {
    toast('Este backup não tem nenhuma classe — nada para importar.'); return;
  }
  const migrated = migrateState(incoming);
  const nAssets = migrated.classes.reduce((s, c) => s + (c.assets || []).length, 0);
  const choice = await dialog({ title: 'Importar backup?',
    html: `<p>O backup tem ${plural(migrated.classes.length, 'classe', 'classes')}, ${plural(nAssets, 'ativo', 'ativos')} e ${plural(migrated.aportes.length, 'aporte', 'aportes')}. Ele vai <b>substituir</b> a carteira atual.</p><p>Recomendado: baixe antes um backup da carteira atual — é o jeito de voltar atrás.</p>`,
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Importar sem backup', value: 'direct' }, { label: 'Baixar a atual e importar', kind: 'primary', value: 'backup' }] });
  if (!choice) return;
  if (choice === 'backup') exportBackup(state, 'aporte-mais-antes-da-importacao');
  state = migrated;
  lastPlan = null; sessionUndo = null; openTermPanels.clear();
  activeAtivosClassId = state.classes.find((c) => hasAssets(c))?.id || null;
  scheduleSave(); renderConfig(); renderTopbar(); debounceQuoteRefresh();
  toast('Backup importado.');
  showMigrationNotes();
}

// ---------------------------------------------------------------------
// Ligações de eventos fixos
// ---------------------------------------------------------------------
async function doLogout() {
  clearTimeout(saveTimer);
  if (dirty && !conflict) await saveNow();
  for (let i = 0; i < 100 && saving; i++) await new Promise((r) => setTimeout(r, 100));
  if (dirty) {
    const choice = await dialog({ title: 'Sair sem salvar?', html: '<p>Algumas alterações ainda não chegaram à nuvem. Baixe um backup para não perdê-las.</p>',
      buttons: [{ label: 'Cancelar', value: null }, { label: 'Baixar backup e sair', value: 'backup' }, { label: 'Sair mesmo assim', kind: 'primary', value: 'exit' }] });
    if (!choice) return;
    if (choice === 'backup') exportBackup();
  }
  dirty = false; // a pessoa decidiu sair
  await sb.auth.signOut({ scope: 'local' });
}
function wire() {
  $('auth-form').addEventListener('submit', onAuthSubmit);
  $('btn-auth-toggle').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
  $('btn-auth-forgot').addEventListener('click', () => setAuthMode('forgot'));
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('btn-logout').addEventListener('click', doLogout);
  $('btn-logout-2')?.addEventListener('click', doLogout);
  ['asset-list', 'class-list', 'fx-grid'].forEach((id) => $(id)?.addEventListener('focusout', () => flushPending(id)));
  $('quote-chip').addEventListener('click', () => refreshQuotes({ silent: false }));
  $('aporte-form').addEventListener('submit', (e) => { e.preventDefault(); calcular(); });
  $('btn-refresh-prices').addEventListener('click', () => refreshQuotes({ silent: false }));
  $('btn-refresh-sentiment').addEventListener('click', () => switchTab('noticias'));
  document.querySelectorAll('[data-nf]').forEach((b) => b.addEventListener('click', () => { newsFilter = b.dataset.nf; renderNoticias(); }));
  $('news-asset').addEventListener('change', (e) => { newsAssetFilter = e.target.value; renderNoticias(); });
  $('btn-refresh-news').addEventListener('click', () => {
    if (newsLoading || newsFetching) return;
    if (Date.now() - lastNewsInvoke < 60e3) { toast('As notícias acabaram de ser verificadas. Tente de novo em um minuto.'); return; }
    loadNews({ force: true });
  });
  $('btn-add-asset').addEventListener('click', () => {
    const cls = state.classes.find((c) => c.id === activeAtivosClassId);
    if (!cls) return;
    if (cls.assets.length >= 300) { toast('Máximo de 300 ativos por classe.'); return; }
    cls.assets.push({ id: uid(), ticker: '', idealPct: 0, qty: 0, price: 0, priceMode: 'auto', currentValue: 0, minQty: 1, minAmount: 0, lastQuotePrice: 0, termometro: { nota: null, motivos: [] } });
    scheduleSave(); renderAtivos();
    const inputs = document.querySelectorAll('#asset-list [data-f="ticker"]');
    inputs[inputs.length - 1]?.focus();
  });
  $('btn-add-class').addEventListener('click', () => {
    if (state.classes.length >= 50) { toast('Máximo de 50 classes.'); return; }
    state.classes.push({ id: uid(), name: 'Nova classe', type: 'b3', hasAssets: true, idealPct: 0, isCash: false, currency: 'BRL', fractional: false, currentValue: 0, assets: [] });
    scheduleSave(); renderConfig();
  });
  $('btn-export-backup').addEventListener('click', () => exportBackup());
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
  if (window.top !== window.self) { document.body.textContent = 'Abra o Aporte+ diretamente no endereço do app.'; return; }
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
    if (event === 'SIGNED_OUT') {
      const unsaved = dirty && state ? state : null;
      resetSession(); resetUI(); dirty = false; saveFailing = false; renderSaveBanner();
      showAuth('login');
      if (unsaved) dialog({ title: 'Sessão encerrada', html: '<p>Você saiu da conta antes de algumas alterações chegarem à nuvem. Baixe um backup delas para importar depois.</p>',
        buttons: [{ label: 'Fechar', value: null }, { label: 'Baixar backup', kind: 'primary', value: 'b' }] }).then((v) => { if (v) exportBackup(unsaved, 'aporte-mais-nao-salvo'); });
    }
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
