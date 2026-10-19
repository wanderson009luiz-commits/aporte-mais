// Supabase falso, em memória, para testar a interface sem tocar no banco real.
// Parâmetros na URL: ?scenario=zerada|antiga|new  &session=0  &quotes=ok|fail  &fail=state_select|state_upsert
(function () {
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario') || 'zerada';
  const quotesMode = params.get('quotes') || 'ok';
  const newsMode = params.get('news') || 'ok';
  const failSet = new Set((params.get('fail') || '').split(',').filter(Boolean));
  const F = window.__FIXTURES;
  const KEY = 'fake-db-' + scenario + '-' + (params.get('run') || '0');
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  function initialDb() {
    const db = { users: [{ id: 'u1', email: 'pessoa@teste.com', password: 'senha12345' }, { id: 'u2', email: 'outra@teste.com', password: 'senha67890' }], portfolios: [], portfolio_state: [], tracked_tickers: [], ticker_quotes: [], exchange_rates: [], ticker_sentiment: [], ticker_news: [], ticker_news_checks: [], calls: { invoke: 0, upsert_state: 0, news: 0 } };
    db.portfolios.push({ id: 'p1', user_id: 'u1', name: 'Minha carteira', created_at: '2026-09-13T22:53:30Z' });
    if (scenario === 'corrupt') db.portfolio_state.push({ portfolio_id: 'p1', state: { classes: 'quebrado', extra: 1 }, updated_at: '2026-10-11T16:34:43.576593+00:00' });
    else if (scenario !== 'new') db.portfolio_state.push({ portfolio_id: 'p1', state: JSON.parse(JSON.stringify(F[scenario] || F.zerada)), updated_at: '2026-10-11T16:34:43.576593+00:00' });
    return db;
  }
  let db = JSON.parse(sessionStorage.getItem(KEY) || 'null') || initialDb();
  const persist = () => sessionStorage.setItem(KEY, JSON.stringify(db));
  persist();
  let session = JSON.parse(sessionStorage.getItem(KEY + '-session') || 'null');
  if (!session && params.get('session') !== '0' && !sessionStorage.getItem(KEY + '-loggedout')) session = { user: { id: 'u1', email: 'pessoa@teste.com' }, access_token: 'fake' };
  const saveSession = () => { sessionStorage.setItem(KEY + '-session', JSON.stringify(session)); };
  let authCb = null;
  // como o supabase-js com o link de "Esqueci a senha" (#access_token=…&type=recovery): entra, limpa o endereço e avisa PASSWORD_RECOVERY
  let recovery = false;
  if (/(^|[#&])type=recovery(&|$)/.test(location.hash.slice(1)) && /access_token=/.test(location.hash)) {
    recovery = true;
    session = { user: { id: 'u1', email: 'pessoa@teste.com' }, access_token: 'fake' }; saveSession();
    history.replaceState(null, '', location.pathname + location.search);
  }

  window.__fakeDb = () => db;
  window.__fakeExternalSave = () => { const r = db.portfolio_state.find((x) => x.portfolio_id === 'p1'); r.updated_at = '2030-01-01T00:00:00.123456+00:00'; persist(); };

  const PK = { portfolios: ['id'], portfolio_state: ['portfolio_id'], tracked_tickers: ['portfolio_id', 'ticker'], ticker_quotes: ['ticker'], exchange_rates: ['pair'], ticker_sentiment: ['ticker'], ticker_news: ['id'], ticker_news_checks: ['ticker'] };
  const keyOf = (t, r) => PK[t].map((k) => r[k]).join('|');

  class Q {
    constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.payload = null; this.one = false; this.maybe = false; this.lim = null; this.ret = false; }
    select() { if (this.op !== 'select') this.ret = true; return this; }
    eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
    in(c, vs) { const s = new Set(vs.map(String)); this.f.push((r) => s.has(String(r[c]))); return this; }
    gte(c, v) { this.f.push((r) => String(r[c]) >= String(v)); return this; }
    order() { return this; }
    limit(n) { this.lim = n; return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    maybeSingle() { this.maybe = true; return this; }
    single() { this.one = true; return this; }
    insert(rows) { this.op = 'insert'; this.payload = [].concat(rows); return this; }
    upsert(rows) { this.op = 'upsert'; this.payload = [].concat(rows); return this; }
    update(v) { this.op = 'update'; this.payload = v; return this; }
    delete() { this.op = 'delete'; return this; }
    then(res, rej) { return this.exec().then(res, rej); }
    async exec() {
      await delay(15);
      const tag = (this.t === 'portfolio_state' ? 'state' : this.t) + '_' + this.op;
      if (failSet.has(tag)) return { data: null, error: { message: 'falha simulada: ' + tag } };
      const tbl = db[this.t];
      const match = (r) => this.f.every((fn) => fn(r));
      let out = [];
      if (this.op === 'select') out = tbl.filter(match).map((r) => JSON.parse(JSON.stringify(r)));
      else if (this.op === 'insert' || this.op === 'upsert') {
        for (const row of this.payload) {
          const r = JSON.parse(JSON.stringify(row));
          if (this.t === 'portfolio_state') { db.calls.upsert_state++; if (!r.updated_at) r.updated_at = nowIso(); }
          const k = keyOf(this.t, r);
          const i = tbl.findIndex((x) => keyOf(this.t, x) === k);
          if (i >= 0) { if (this.op === 'insert') return { data: null, error: { message: 'duplicate key value violates unique constraint' } }; tbl[i] = { ...tbl[i], ...r }; out.push(tbl[i]); }
          else { if (this.t === 'portfolios' && !r.id) r.id = 'p' + (tbl.length + 1); tbl.push(r); out.push(r); }
        }
        persist();
      } else if (this.op === 'update') {
        tbl.forEach((r) => { if (match(r)) { Object.assign(r, this.payload); out.push(r); } }); persist();
      } else if (this.op === 'delete') {
        db[this.t] = tbl.filter((r) => !match(r)); persist();
      }
      if (this.op === 'select') out = this.rng ? out.slice(this.rng[0], this.rng[1] + 1) : out.slice(0, 1000); // máximo de linhas do PostgREST
      if (this.lim) out = out.slice(0, this.lim);
      if (this.one) return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } };
      if (this.maybe) return { data: out[0] || null, error: null };
      return { data: (this.op === 'select' || this.ret) ? out : null, error: null };
    }
  }

  const client = {
    from: (t) => new Q(t),
    functions: {
      async invoke(name, { body } = {}) {
        await delay(120);
        if (name === 'news-refresh') {
          db.calls.news++;
          if (newsMode === 'fail') return { data: null, error: { message: 'Edge Function returned a non-2xx status code' } };
          // como o servidor: só tickers acompanhados pela carteira de quem pede
          const mine = new Set(db.tracked_tickers.filter((t) => t.portfolio_id === 'p1').map((t) => t.ticker));
          const wanted = ((body && body.tickers) || []).filter((k) => mine.has(k));
          const now = Date.now();
          (F.news || []).forEach((n, k) => {
            if (!wanted.includes(n.ticker) && n.ticker !== 'PETR4') return; // PETR4: notícia de ativo de outra pessoa já no banco
            const row = { id: 'n' + k, ticker: n.ticker, title: n.title, url: 'https://news.google.com/rss/articles/T' + k, source: n.source, published_at: new Date(now - n.h * 3600e3).toISOString(),
              impact: n.impact, direction: n.direction, relevant: n.relevant, summary: n.summary, classified_by: n.classified_by, fetched_at: new Date(now).toISOString() };
            if (!db.ticker_news.some((x) => x.id === row.id)) db.ticker_news.push(row);
          });
          wanted.forEach((k) => { const i = db.ticker_news_checks.findIndex((x) => x.ticker === k); const row = { ticker: k, checked_at: new Date(now).toISOString(), found: 1, ok: true }; if (i >= 0) db.ticker_news_checks[i] = row; else db.ticker_news_checks.push(row); });
          persist();
          return { data: { ok: true, mode: 'app', ai: true, checked: wanted.length }, error: null };
        }
        db.calls.invoke++;
        if (quotesMode === 'fail') return { data: null, error: { message: 'Edge Function returned a non-2xx status code' } };
        const items = (body && body.items) || [];
        const now = nowIso();
        const quotes = []; const failed = [];
        items.forEach((it) => {
          const key = it.source === 'us' ? 'US:' + it.ticker : it.source === 'crypto' ? 'CRYPTO:' + it.ticker : it.ticker;
          const p = F.quotes[key];
          if (p && !F.unknown.includes(it.ticker)) {
            const row = { ticker: key, price: p, currency: it.source === 'us' ? 'USD' : 'BRL', change_percent: -0.5, updated_at: now };
            const i = db.ticker_quotes.findIndex((x) => x.ticker === key);
            if (i >= 0) db.ticker_quotes[i] = row; else db.ticker_quotes.push(row);
            quotes.push(row);
          } else failed.push(it.source + ':' + it.ticker);
        });
        db.exchange_rates = Object.entries(F.fx).map(([pair, v]) => ({ pair, bid_price: v, ask_price: v, updated_at: now }));
        persist();
        return { data: { ok: true, requested: items.length, refreshed: quotes.length, failed, quotes, fx: db.exchange_rates }, error: null };
      },
    },
    auth: {
      async getSession() { await delay(10); return { data: { session } }; },
      onAuthStateChange(cb) { authCb = cb; if (recovery) setTimeout(() => cb('PASSWORD_RECOVERY', session), 30); return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithPassword({ email, password }) {
        await delay(40);
        const u = db.users.find((x) => x.email === email);
        if (!u || u.password !== password) return { data: {}, error: { message: 'Invalid login credentials' } };
        session = { user: { id: u.id, email }, access_token: 'fake' }; saveSession(); sessionStorage.removeItem(KEY + '-loggedout');
        setTimeout(() => authCb && authCb('SIGNED_IN', session), 0);
        return { data: { user: session.user, session }, error: null };
      },
      // como o Supabase de verdade (com confirmação de e-mail): e-mail que já tem conta responde "ok", sem enviar
      // nada e sem identidades — não dá erro (para não revelar quem tem conta)
      async signUp({ email }) {
        await delay(40);
        const u = db.users.find((x) => x.email === email);
        if (u) return { data: { user: { id: u.id, email, identities: [] }, session: null }, error: null };
        return { data: { user: { id: 'u9', email, identities: [{ id: 'i9', provider: 'email' }] }, session: null }, error: null };
      },
      async resetPasswordForEmail() { await delay(30); return { data: {}, error: null }; },
      async updateUser({ password } = {}) { await delay(30); const u = session && db.users.find((x) => x.id === session.user.id); if (u && password) { u.password = password; persist(); } return { data: {}, error: null }; },
      async signOut() { session = null; sessionStorage.removeItem(KEY + '-session'); sessionStorage.setItem(KEY + '-loggedout', '1'); setTimeout(() => authCb && authCb('SIGNED_OUT', null), 0); return { error: null }; },
    },
  };
  window.supabase = { createClient: () => client };
})();
