// Supabase falso (só o que as funções usam), com tabelas em memória em globalThis.__DB
type Row = Record<string, any>;
const PK: Record<string, string[]> = { ticker_quotes: ["ticker"], exchange_rates: ["pair"], tracked_tickers: ["portfolio_id", "ticker"], ticker_sentiment: ["ticker", "session_date", "session"], ticker_news: ["id"], ticker_news_checks: ["ticker"], portfolios: ["id"], news_demand: ["user_id"] };
const db = () => (globalThis as any).__DB as Record<string, Row[]>;
class Q {
  t: string; f: ((r: Row) => boolean)[] = []; op = "select"; payload: any = null; opts: any = {}; ret = false; one = false; ord: string | null = null; asc = true; rng: [number, number] | null = null; lim: number | null = null;
  constructor(t: string) { this.t = t; }
  select(_c?: string) { if (this.op !== "select") this.ret = true; return this; }
  eq(c: string, v: any) { this.f.push((r) => r[c] === v); return this; }
  neq(c: string, v: any) { this.f.push((r) => r[c] !== v); return this; }
  lt(c: string, v: any) { this.f.push((r) => String(r[c]) < String(v)); return this; }
  gte(c: string, v: any) { this.f.push((r) => String(r[c]) >= String(v)); return this; }
  in(c: string, vs: any[]) { const s = new Set(vs); this.f.push((r) => s.has(r[c])); return this; }
  order(c: string, o: any = {}) { this.ord = c; this.asc = o.ascending !== false; return this; }
  limit(n: number) { this.lim = n; return this; }
  delete() { this.op = "delete"; return this; }
  range(a: number, b: number) { this.rng = [a, b]; return this; }
  maybeSingle() { this.one = true; return this; }
  update(v: any) { this.op = "update"; this.payload = v; return this; }
  upsert(rows: any, opts: any = {}) { this.op = "upsert"; this.payload = [].concat(rows); this.opts = opts; return this; }
  then(res: any, rej: any) { return this.exec().then(res, rej); }
  async exec(): Promise<{ data: any; error: any }> {
    (globalThis as any).__CALLS.push(`${this.t}.${this.op}`);
    const fail = (globalThis as any).__FAIL as Set<string>;
    if (fail?.has(`${this.t}.${this.op}`)) return { data: null, error: { message: "falha simulada" } };
    const tbl = db()[this.t] ??= [];
    const key = (r: Row) => PK[this.t].map((k) => r[k]).join("|");
    const match = (r: Row) => this.f.every((fn) => fn(r));
    let out: Row[] = [];
    if (this.op === "select") {
      out = tbl.filter(match).map((r) => ({ ...r }));
      if (this.ord) { out.sort((a, b) => String(a[this.ord!]).localeCompare(String(b[this.ord!]))); if (!this.asc) out.reverse(); }
      if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      else out = out.slice(0, this.lim ?? 1000); // limite padrão do PostgREST
    } else if (this.op === "delete") {
      const keep = tbl.filter((r) => !match(r)); out = tbl.filter(match); db()[this.t] = keep;
    } else if (this.op === "update") {
      tbl.forEach((r) => { if (match(r)) { Object.assign(r, this.payload); out.push({ ...r }); } });
    } else if (this.op === "upsert") {
      // como o Postgres: um texto que o banco não aceita derruba o bloco inteiro
      if (this.t === "ticker_news" && this.payload.some((p: Row) => /REJEITAR/.test(String(p.title)) || !String(p.title).isWellFormed())) return { data: null, error: { message: "invalid input" } };
      for (const p of this.payload) {
        const i = tbl.findIndex((x) => key(x) === key(p));
        if (i >= 0) { if (this.opts.ignoreDuplicates) continue; tbl[i] = { ...tbl[i], ...p }; out.push({ ...tbl[i] }); }
        else { tbl.push({ ...p }); out.push({ ...p }); }
      }
    }
    if (this.one) return { data: out[0] ?? null, error: null };
    return { data: this.op === "select" || this.ret ? out : null, error: null };
  }
}
export function createClient(_u: string, _k: string, _o?: any) {
  return {
    from: (t: string) => new Q(t),
    auth: { async getUser(jwt: string) { return jwt === "USER-TOKEN" ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: { message: "invalid claim: missing sub claim" } }; } },
  };
}
