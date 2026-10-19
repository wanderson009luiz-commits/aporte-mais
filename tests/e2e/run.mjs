// Teste de ponta a ponta da interface (Playwright + Supabase falso).
// Uso: node tests/e2e/run.mjs [pasta-de-prints]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const shots = path.resolve(process.argv[2] || path.join(here, 'shots'));
fs.mkdirSync(shots, { recursive: true });
const { chromium } = await import(process.env.PW_PATH || 'playwright');

// site de teste: o app de verdade, trocando só o Supabase pelo falso
const site = fs.mkdtempSync('/tmp/aporte-e2e-');
for (const f of ['index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png']) fs.copyFileSync(path.join(root, f), path.join(site, f));
fs.cpSync(path.join(root, 'css'), path.join(site, 'css'), { recursive: true });
fs.cpSync(path.join(root, 'js'), path.join(site, 'js'), { recursive: true });
fs.copyFileSync(path.join(here, 'fixtures.js'), path.join(site, 'fixtures.js'));
fs.copyFileSync(path.join(here, 'fake-supabase.js'), path.join(site, 'fake-supabase.js'));
let html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
const vendorTag = '<script src="js/vendor/supabase.js?v=2.117.2" defer></script>';
if (!html.includes(vendorTag)) throw new Error('tag do supabase não encontrada no index.html');
html = html.replace(vendorTag, '<script src="fixtures.js" defer></script><script src="fake-supabase.js" defer></script>');
fs.writeFileSync(path.join(site, 'index.html'), html);

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const p = path.join(site, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(site) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const browser = await chromium.launch(fs.existsSync(exe) ? { executablePath: exe } : {});
let failures = 0, passes = 0;
const errors = [];
function check(cond, msg) { if (cond) { passes++; console.log('  ✓', msg); } else { failures++; console.log('  ✗', msg); } }
async function newPage(query, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1 });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${query}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|net::|falha simulada|non-2xx|formato inesperado/i.test(m.text())) errors.push(`[${query}] console: ${m.text()}`); });
  await page.goto(`${base}?${query}`);
  return page;
}
const txt = (page, sel) => page.locator(sel).first().innerText();
const money = (s) => Number(String(s).replace(/[^\d,]/g, '').replace(',', '.'));

// ---------------------------------------------------------------- 1
console.log('\n1) Carteira com todos os preços zerados — calcular, registrar, recarregar, desfazer');
{
  const page = await newPage('scenario=zerada&run=1');
  await page.waitForSelector('#app-root:not([style*="none"])');
  await page.waitForFunction(() => document.querySelector('#quote-chip-txt')?.textContent === 'agora', null, { timeout: 8000 });
  check(true, 'cotações buscadas automaticamente ao abrir');
  await page.screenshot({ path: `${shots}/01-painel-desktop.png`, fullPage: true });
  await page.click('.nav-btn[data-tab="aporte"]');
  const ready = await txt(page, '#ready-card');
  check(/2 de 38 ativos sem preço/.test(ready) && /BCFF11/.test(ready) && /MALL11/.test(ready), 'checklist mostra 2 de 38 sem preço (BCFF11, MALL11)');
  await page.fill('#aporte-valor', '1.000,00');
  await page.click('#btn-calcular');
  await page.waitForSelector('.order-card');
  const order = await txt(page, '#resultado-container');
  check(/Comprar na bolsa/i.test(order) && /Comprar valor exato/i.test(order) && /Aplicar/i.test(order), 'ordem tem bolsa, valor exato (cripto) e renda fixa');
  check(/sem preço — [^.]*BCFF11/.test(order), 'aviso agrupado dos ativos sem preço aparece (BCFF11)');
  const totals = await page.locator('.order-totals').innerText();
  check(/R\$\s*1\.000,00/.test(totals), 'aporte total R$ 1.000,00');
  await page.screenshot({ path: `${shots}/02-aporte-resultado-desktop.png`, fullPage: true });
  await page.click('#btn-copy-order');
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  check(/Aporte: R\$ 1\.000,00/.test(clip) && /Comprar \d+ /.test(clip), 'ordem copiada como texto');
  await page.click('#btn-registrar');
  await page.waitForSelector('.modal-back.show');
  await page.click('.modal .btn-primary');
  await page.waitForTimeout(1500);
  const pat = money(await txt(page, '#patrimonio-total'));
  check(Math.abs(pat - 1000) < 0.02, `patrimônio após registrar = R$ 1.000,00 (obtido ${pat})`);
  const saved = await page.evaluate(() => window.__fakeDb().portfolio_state[0].state);
  check(saved.version === 4 && saved.aportes.length === 1, 'carteira salva no formato v4 com 1 aporte');
  await page.reload();
  await page.waitForSelector('#app-root:not([style*="none"])');
  await page.waitForTimeout(600);
  const pat2 = money(await txt(page, '#patrimonio-total'));
  check(Math.abs(pat2 - 1000) < 0.02, `depois de recarregar o patrimônio continua R$ 1.000,00 (${pat2})`);
  await page.click('.nav-btn[data-tab="timeline"]');
  const hist = await txt(page, '#aportes-card');
  check(/1\.000,00/.test(hist) && /Desfazer/.test(hist), 'histórico mostra o aporte e o botão desfazer');
  await page.screenshot({ path: `${shots}/03-historico-desktop.png`, fullPage: true });
  await page.click('[data-undo-aporte]');
  await page.waitForSelector('.modal-back.show');
  check(/exatamente o que ele somou/.test(await txt(page, '#modal')), 'desfazer explica que tira só o que o aporte somou');
  await page.click('.modal .btn-primary');
  await page.waitForTimeout(1200);
  const pat3 = money(await txt(page, '#patrimonio-total'));
  check(pat3 === 0, `desfazer volta o patrimônio para R$ 0,00 (${pat3})`);
  await page.click('.nav-btn[data-tab="ativos"]');
  await page.waitForSelector('.asset-card');
  const hint = await page.locator('#asset-list').innerText();
  check(/Cotação R\$ 66,21/.test(hint), 'Ativos mostra a cotação automática (VALE3 R$ 66,21)');
  await page.screenshot({ path: `${shots}/04-ativos-desktop.png`, fullPage: true });
  // informar quantidade → valor automático
  const qty = page.locator('.asset-card').first().locator('[data-f="qty"]');
  await qty.fill('10'); await qty.press('Tab');
  await page.waitForTimeout(300);
  const v = await page.locator('.asset-card').first().locator('[data-f="currentValue"]').inputValue();
  check(v === '662,10', `10 × R$ 66,21 = R$ 662,10 (obtido ${v})`);
  // código que mudou na B3: aviso + botão de troca
  await page.click('.class-tab:has-text("FIIs")');
  await page.waitForTimeout(200);
  const fiis = await page.locator('#asset-list').innerText();
  check(/BCFF11 foi incorporado pelo BTHF11/.test(fiis) && /Trocar para BTHF11/.test(fiis), 'avisa que BCFF11 virou BTHF11 e oferece a troca');
  await page.click('[data-action="rename"][data-to="BTHF11"]');
  await page.waitForTimeout(2000);
  const tick = await page.evaluate(() => window.__fakeDb().portfolio_state[0].state.classes.find((c) => c.id === 'fiis').assets.map((a) => a.ticker));
  check(tick.includes('BTHF11') && !tick.includes('BCFF11'), 'troca salva: BCFF11 → BTHF11');
  check(/Cotação R\$ 8,94/.test(await page.locator('#asset-list').innerText()), 'cotação do BTHF11 aparece depois da troca');
  await page.screenshot({ path: `${shots}/04b-troca-codigo.png`, fullPage: true });
  await page.close();
}

// ---------------------------------------------------------------- 2
console.log('\n2) Carteira antiga (preços digitados à mão + classe em dólar)');
{
  const page = await newPage('scenario=antiga&run=2');
  await page.waitForSelector('#app-root:not([style*="none"])');
  await page.waitForTimeout(800);
  const st = await page.evaluate(() => window.__fakeDb().portfolio_state[0].state);
  check(st.version === 4, 'carteira antiga migrada e salva como v4');
  const eua = st.classes.find((c) => c.id === 'acoes-eua');
  check(eua && eua.type === 'exterior' && eua.currency === 'USD', 'classe "Ações EUA (Avenue)" virou tipo Exterior em US$');
  check(st.classes.find((c) => c.id === 'rendafixa').type === 'rendafixa', 'Renda Fixa virou tipo por valor');
  await page.click('.nav-btn[data-tab="config"]');
  await page.waitForSelector('#class-list .class-row');
  const cfg = await page.locator('#tab-config').innerText();
  check(/5,06/.test(cfg), 'câmbio automático do dólar aparece em Configuração');
  await page.screenshot({ path: `${shots}/05-config-desktop.png`, fullPage: true });
  await page.click('.nav-btn[data-tab="aporte"]');
  await page.fill('#aporte-valor', '500');
  await page.click('#btn-calcular');
  await page.waitForSelector('.order-card');
  const r = await txt(page, '#resultado-container');
  check(/auto/i.test(r) && !/MANUAL/i.test(r) && !/7,28/.test(r), 'cálculo usa a cotação nova (auto), nunca o preço antigo digitado (BCFF11 R$ 7,28)');
  await page.close();
}

// ---------------------------------------------------------------- 3
console.log('\n3) Falha ao carregar a carteira NÃO pode apagar nada');
{
  const page = await newPage('scenario=zerada&run=3&fail=state_select');
  await page.waitForSelector('#boot-screen #btn-retry-boot', { timeout: 5000 });
  const t = await txt(page, '#boot-screen');
  check(/Não foi possível abrir a carteira/.test(t), 'mostra erro claro com "Tentar de novo"');
  const calls = await page.evaluate(() => window.__fakeDb().calls.upsert_state);
  check(calls === 0, 'nenhuma gravação foi feita sobre a carteira');
  await page.screenshot({ path: `${shots}/06-erro-carga.png` });
  await page.close();
}

// ---------------------------------------------------------------- 4
console.log('\n4) Login: senha errada, depois certa');
{
  const page = await newPage('scenario=zerada&run=4&session=0');
  await page.waitForSelector('#auth-screen:not([style*="none"])');
  await page.fill('#auth-email', 'pessoa@teste.com');
  await page.fill('#auth-password', 'errada123');
  await page.click('#btn-auth-main');
  await page.waitForSelector('#auth-msg.show');
  check(/E-mail ou senha incorretos/.test(await txt(page, '#auth-msg')), 'erro de senha em português');
  await page.screenshot({ path: `${shots}/07-login.png` });
  await page.fill('#auth-password', 'senha12345');
  await page.click('#btn-auth-main');
  await page.waitForSelector('#app-root:not([style*="none"])', { timeout: 6000 });
  check(true, 'entra no app com a senha certa');
  await page.click('#btn-logout');
  await page.waitForSelector('#auth-screen:not([style*="none"])');
  check(true, 'sair volta para a tela de login');
  await page.click('#btn-auth-forgot');
  await page.fill('#auth-email', 'pessoa@teste.com');
  await page.click('#btn-auth-main');
  await page.waitForSelector('#auth-msg.show');
  check(/enviamos um link/.test(await txt(page, '#auth-msg')), 'recuperar senha envia link');
  await page.close();
}

// ---------------------------------------------------------------- 5
console.log('\n5) Edição em outro aparelho → aviso, sem sobrescrever');
{
  const page = await newPage('scenario=zerada&run=5');
  await page.waitForSelector('#app-root:not([style*="none"])');
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__fakeExternalSave());
  await page.click('.nav-btn[data-tab="agenda"]');
  await page.click('.freq-btn[data-freq="mensal"]');
  await page.waitForSelector('.modal-back.show', { timeout: 4000 });
  const m = await txt(page, '#modal');
  check(/alterada em outro lugar/.test(m), 'mostra aviso de conflito');
  const remote = await page.evaluate(() => window.__fakeDb().portfolio_state[0].updated_at);
  check(remote.startsWith('2030'), 'versão do outro aparelho não foi sobrescrita');
  await page.close();
}

// ---------------------------------------------------------------- 6
console.log('\n6) Cotações fora do ar');
{
  const page = await newPage('scenario=zerada&run=6&quotes=fail');
  await page.waitForSelector('#app-root:not([style*="none"])');
  await page.waitForTimeout(800);
  check(/Indispon|Sem cota/.test(await txt(page, '#quote-chip')), 'indicador de cotações mostra indisponível');
  await page.click('.nav-btn[data-tab="aporte"]');
  await page.fill('#aporte-valor', '300');
  await page.click('#btn-calcular');
  await page.waitForSelector('.order-card');
  const r = await txt(page, '#resultado-container');
  check(/sem preço/i.test(r) && /Aplicar/i.test(r), 'sem cotação: avisa e ainda aplica renda fixa/caixa');
  await page.close();
}

// ---------------------------------------------------------------- 7
console.log('\n7) Carteira nova (sem dados) e validações');
{
  const page = await newPage('scenario=new&run=7');
  await page.waitForSelector('#app-root:not([style*="none"])');
  await page.waitForTimeout(600);
  const st = await page.evaluate(() => window.__fakeDb().portfolio_state[0]?.state);
  check(st && st.version === 4 && st.classes.length === 6, 'cria a carteira padrão v4');
  await page.click('.nav-btn[data-tab="config"]');
  const pctInput = page.locator('#class-list .class-row').first().locator('[data-f="idealPct"]');
  await pctInput.fill('30'); await pctInput.press('Tab');
  await page.waitForTimeout(300);
  check(/95%/.test(await txt(page, '#config-total-val')), 'soma das classes mostra 95%');
  await page.click('.nav-btn[data-tab="aporte"]');
  await page.fill('#aporte-valor', '1000');
  await page.click('#btn-calcular');
  await page.waitForSelector('.msg-box.err');
  check(/não 100%/.test(await txt(page, '#resultado-container')), 'bloqueia o cálculo com soma 95%');
  await page.fill('#aporte-valor', '0');
  await page.click('#btn-calcular');
  check(/maior que zero/.test(await txt(page, '#resultado-container')), 'bloqueia aporte zero');
  await page.close();
}

// ---------------------------------------------------------------- 8
console.log('\n8) Celular: todas as telas sem rolagem lateral');
{
  const page = await newPage('scenario=zerada&run=8', { width: 390, height: 844 });
  await page.waitForSelector('#app-root:not([style*="none"])');
  await page.waitForTimeout(800);
  for (const tab of ['painel', 'aporte', 'ativos', 'config', 'agenda', 'timeline']) {
    await page.click(`.nav-btn[data-tab="${tab}"]`);
    await page.waitForTimeout(250);
    if (tab === 'aporte') { await page.fill('#aporte-valor', '2500'); await page.click('#btn-calcular'); await page.waitForSelector('.order-card'); }
    const ow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(ow <= 0, `${tab}: sem rolagem lateral (${ow}px)`);
    await page.screenshot({ path: `${shots}/m-${tab}.png`, fullPage: true });
  }
  await page.close();
}

// ---------------------------------------------------------------- 9
console.log('\n9) Falha ao salvar: aviso visível e nada perdido');
{
  const page = await newPage('scenario=zerada&run=9&fail=state_update');
  await page.waitForSelector('#app-root:not([style*="none"])');
  await page.waitForTimeout(800);
  await page.click('.nav-btn[data-tab="agenda"]');
  await page.click('.freq-btn[data-freq="mensal"]');
  await page.waitForSelector('#save-banner:not([hidden])', { timeout: 5000 });
  check(/ainda não foram salvas/.test(await txt(page, '#save-banner')), 'mostra "suas últimas alterações ainda não foram salvas"');
  await page.close();
}

// ---------------------------------------------------------------- 10
console.log('\n10) Backup adulterado não executa nada');
{
  const page = await newPage('scenario=zerada&run=10');
  await page.waitForSelector('#app-root:not([style*="none"])');
  await page.waitForTimeout(800);
  const evil = { app: 'aporte-mais', state: {
    classes: [
      { id: 'c1', name: '<img src=x onerror="window.__xss=1">Ações', type: 'b3', idealPct: 95, assets: [{ id: 'a1', ticker: 'VALE3', idealPct: 100, qty: 3, termometro: { nota: '"><img src=y onerror="window.__xss=2">', motivos: ['<b>x</b>'] } }] },
      { id: 'cx', name: 'Caixa', type: 'valor', isCash: true, idealPct: 5, currentValue: 100, assets: [] }],
    agenda: { frequency: 'mensal', dayOfMonth: '"><img src=z onerror="window.__xss=3">' },
    aportes: [{ id: 'q', date: '2026-10-01">x', disponivel: 100 }, { id: 'r', date: '2026-10-02', disponivel: 50, observacao: '<script>window.__xss=4</script>' }],
  } };
  const file = path.join(site, 'evil.json');
  fs.writeFileSync(file, JSON.stringify(evil));
  await page.click('.nav-btn[data-tab="config"]');
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-import-backup');
  await (await chooser).setFiles(file);
  await page.waitForSelector('.modal-back.show');
  await page.click('.modal .btn-primary');
  await page.waitForTimeout(800);
  for (const tab of ['painel', 'ativos', 'agenda', 'timeline', 'config', 'aporte']) { await page.click(`.nav-btn[data-tab="${tab}"]`); await page.waitForTimeout(200); }
  await page.click('.nav-btn[data-tab="painel"]');
  const seg = page.locator('.comp-seg').first();
  if (await seg.count()) { await seg.hover(); await page.waitForTimeout(200); }
  const res = await page.evaluate(() => ({ xss: window.__xss, imgs: [...document.querySelectorAll('img')].map((i) => i.getAttribute('src')) }));
  check(res.xss === undefined && res.imgs.length === 0, `nenhum código do backup executou (xss=${res.xss}, imgs=${res.imgs.join(',')})`);
  await page.click('.nav-btn[data-tab="config"]');
  check(/<img src=x/.test(await page.locator('#class-list [data-f="name"]').first().inputValue()), 'o nome aparece como texto, não como HTML');
  await page.close();
}

// ---------------------------------------------------------------- 11
console.log('\n11) Carteira corrompida no banco: nada é gravado por cima');
{
  const page = await newPage('scenario=corrupt&run=11');
  await page.waitForSelector('#boot-screen #btn-raw', { timeout: 5000 });
  check(/formato inesperado/.test(await txt(page, '#boot-screen')), 'mostra aviso de formato inesperado com "Baixar dados brutos"');
  const st = await page.evaluate(() => window.__fakeDb().portfolio_state[0].state);
  check(st.classes === 'quebrado' && st.extra === 1, 'o documento original continua intacto');
  await page.close();
}


// helpers dos cenários novos
async function openApp(query, viewport) {
  const page = await newPage(query, viewport);
  await page.waitForSelector('#app-root:not([style*="none"])');
  await page.waitForFunction(() => document.querySelector('#quote-chip-txt')?.textContent === 'agora', null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  return page;
}
async function calcularAporte(page, valor) {
  await page.click('.nav-btn[data-tab="aporte"]');
  await page.fill('#aporte-valor', valor);
  await page.click('#btn-calcular');
  await page.waitForSelector('.order-card');
}
async function confirmModal(page) {
  await page.waitForSelector('.modal-back.show');
  await page.click('.modal .btn-primary');
}
const dbState = (page) => page.evaluate(() => window.__fakeDb().portfolio_state.find((r) => r.portfolio_id === 'p1').state);

// ---------------------------------------------------------------- 12
console.log('\n12) Ordem velha nunca pode ser registrada; cotação igual não apaga a ordem');
{
  const page = await openApp('scenario=zerada&run=12');
  await calcularAporte(page, '1000');
  await page.click('#quote-chip');
  await page.waitForTimeout(1200);
  check(await page.locator('.order-card').count() === 1, 'atualizar cotações sem mudança de preço mantém a ordem na tela');
  await page.click('.nav-btn[data-tab="ativos"]');
  const qty = page.locator('.asset-card').first().locator('[data-f="qty"]');
  await qty.fill('5'); await qty.press('Tab');
  await page.waitForTimeout(400);
  await page.click('.nav-btn[data-tab="aporte"]');
  const r = await txt(page, '#resultado-container');
  check(/mudaram depois do cálculo/.test(r) && (await page.locator('#btn-registrar').count()) === 0, 'depois de mudar a carteira a ordem antiga some e pede novo cálculo');
  await page.close();
}

// ---------------------------------------------------------------- 13
console.log('\n13) Desfazer tira só o aporte; observação digitada depois vale; Caixa completo no histórico');
{
  const page = await openApp('scenario=zerada&run=13');
  await calcularAporte(page, '500');
  await page.fill('#aporte-obs', 'salário de outubro');
  await page.click('#btn-registrar');
  await confirmModal(page);
  await page.waitForFunction(() => /salvo/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 6000 });
  let st = await dbState(page);
  check(st.aportes.length === 1 && st.aportes[0].observacao === 'salário de outubro', 'observação digitada depois do cálculo foi gravada');
  await page.click('.nav-btn[data-tab="timeline"]');
  const hist = await txt(page, '#aportes-card');
  const rec = st.aportes[0];
  check(new RegExp('caixa \\+R\\$\\s*' + rec.caixa.toLocaleString('pt-BR', { minimumFractionDigits: 2 }).replace('.', '\\.')).test(hist), `histórico mostra o Caixa total do aporte (R$ ${rec.caixa})`);
  await page.fill('#div-ticker', 'MXRF11');
  await page.fill('#div-valor', '45,90');
  await page.click('#btn-add-div');
  await page.waitForTimeout(300);
  // depois do aporte, a pessoa compra mais 3 cotas de um ativo que o aporte também comprou
  const acoes = st.classes.find((c) => c.id === 'acoes');
  const dq = rec.deltas.find((d) => d.classId === 'acoes' && d.field === 'qty');
  const tk = acoes.assets.find((a) => a.id === dq.assetId).ticker;
  await page.click('.nav-btn[data-tab="ativos"]');
  await page.click('.class-tab:has-text("Ações")');
  const card = page.locator('.asset-card').filter({ has: page.locator(`[data-f="ticker"][value="${tk}"]`) });
  const q2 = card.locator('[data-f="qty"]');
  await q2.fill(String(dq.amount + 3)); await q2.press('Tab');
  await page.waitForTimeout(300);
  await page.click('.nav-btn[data-tab="timeline"]');
  await page.click('[data-undo-aporte]');
  await confirmModal(page);
  await page.waitForTimeout(1500);
  st = await dbState(page);
  const cash = st.classes.find((c) => c.isCash);
  check(st.aportes.length === 0, 'o aporte saiu do histórico');
  check(st.dividendos.length === 1 && Math.abs(cash.currentValue - 45.9) < 0.001, `o provento registrado depois continua (Caixa = R$ 45,90; obtido ${cash.currentValue})`);
  const after = st.classes.find((c) => c.id === 'acoes').assets.find((a) => a.id === dq.assetId).qty;
  check(after === 3, `${tk}: o aporte tirou só as ${dq.amount} cotas dele; as 3 compradas depois ficaram (obtido ${after})`);
  await page.close();
}

// ---------------------------------------------------------------- 14
console.log('\n14) Registrar sem conseguir salvar: aviso claro, nada some em silêncio');
{
  const page = await openApp('scenario=zerada&run=14&fail=state_update');
  await calcularAporte(page, '200');
  await page.click('#btn-registrar');
  await confirmModal(page);
  await page.waitForFunction(() => /ainda NÃO salvo/.test(document.querySelector('#modal')?.textContent || ''), null, { timeout: 10000 });
  check(true, 'mostra "Aporte registrado — ainda NÃO salvo na nuvem" com opção de backup');
  check(/ainda não foram salvas/.test(await txt(page, '#save-banner')), 'aviso fixo no topo continua visível');
  await page.close();
}

// ---------------------------------------------------------------- 15
console.log('\n15) Centavos do patrimônio no topo e Caixa só em R$');
{
  const page = await openApp('scenario=new&run=15');
  await page.click('.nav-btn[data-tab="config"]');
  await page.click('#btn-add-class');
  const row = page.locator('#class-list .class-row').last();
  await row.locator('[data-f="type"]').selectOption('valor');
  await confirmModal(page);
  await page.waitForTimeout(300);
  const row2 = page.locator('#class-list .class-row').last();
  await row2.locator('[data-f="currency"]').selectOption('USD');
  await page.waitForTimeout(300);
  const v = page.locator('#class-list .class-row').last().locator('[data-f="currentValue"]');
  await v.fill('10,07'); await v.press('Tab');
  await page.waitForTimeout(400);
  const top = await txt(page, '#patrimonio-total');
  check(/51,00/.test(top), `US$ 10,07 × 5,0645 = R$ 51,00 no topo (obtido "${top.replace(/\s+/g, ' ')}")`);
  check(await page.locator('#class-list .class-row').last().locator('[data-f="isCash"]').isDisabled(), 'classe em US$ não pode ser marcada como Caixa');
  await page.close();
}

// ---------------------------------------------------------------- 16
console.log('\n16) Celular: dá para sair da conta em Configuração');
{
  const page = await openApp('scenario=zerada&run=16', { width: 390, height: 844 });
  await page.click('.nav-btn[data-tab="config"]');
  const b = page.locator('#btn-logout-2');
  check(await b.isVisible(), 'botão "Sair da conta" visível no celular');
  await b.click();
  await page.waitForSelector('#auth-screen:not([style*="none"])', { timeout: 5000 });
  check(true, 'sair funciona no celular');
  await page.close();
}

// ---------------------------------------------------------------- 17
console.log('\n17) Trocar de conta no mesmo navegador não mostra nada da conta anterior');
{
  const page = await openApp('scenario=zerada&run=17');
  await calcularAporte(page, '1000');
  await page.fill('#aporte-obs', 'segredo do usuário 1');
  await page.click('.nav-btn[data-tab="timeline"]');
  await page.fill('#div-ticker', 'XPTO11');
  await page.fill('#div-valor', '10');
  await page.click('#btn-logout');
  await page.waitForSelector('#auth-screen:not([style*="none"])');
  check((await page.inputValue('#auth-password')) === '' && (await page.inputValue('#auth-email')) === '', 'tela de login volta vazia (sem e-mail e senha da conta anterior)');
  await page.fill('#auth-email', 'outra@teste.com');
  await page.fill('#auth-password', 'senha67890');
  await page.click('#btn-auth-main');
  await page.waitForSelector('#app-root:not([style*="none"])', { timeout: 6000 });
  await page.waitForTimeout(500);
  check(await page.locator('#tab-painel').isVisible(), 'a conta nova começa no Painel');
  await page.click('.nav-btn[data-tab="aporte"]');
  check((await page.inputValue('#aporte-valor')) === '' && (await page.inputValue('#aporte-obs')) === '' && (await page.locator('.order-card').count()) === 0, 'nenhuma ordem, valor ou observação da conta anterior');
  await page.click('.nav-btn[data-tab="timeline"]');
  check((await page.inputValue('#div-ticker')) === '' && (await page.inputValue('#div-valor')) === '', 'formulário de provento limpo');
  await page.close();
}

// ---------------------------------------------------------------- 18
console.log('\n18) Teclado em Ativos: Tab não perde o foco nem o que foi digitado');
{
  const page = await openApp('scenario=zerada&run=18');
  await page.click('.nav-btn[data-tab="ativos"]');
  const card = page.locator('.asset-card').first();
  await card.locator('[data-f="qty"]').fill('10');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  await page.keyboard.type('70');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1500);
  const st = await dbState(page);
  const a0 = st.classes[0].assets[0];
  check(a0.qty === 10 && a0.price === 70 && a0.priceMode === 'manual', `quantidade 10 e preço 70 digitados em sequência (qty=${a0.qty}, preço=${a0.price}, ${a0.priceMode})`);
  await page.locator('.asset-card').first().locator('[data-action="toggle-term"]').click();
  const nota = page.locator('.asset-card').first().locator('[data-f="nota"]');
  await nota.fill('80'); await nota.press('Tab');
  await page.waitForTimeout(300);
  check(await page.locator('.asset-card').first().locator('.term-panel.open').count() === 1, 'o termômetro continua aberto depois de digitar a nota');
  const pctIn = page.locator('.asset-card').first().locator('[data-f="idealPct"]');
  await pctIn.fill('abc'); await pctIn.press('Tab');
  await page.waitForTimeout(300);
  check(/não é um número válido/.test(await txt(page, '#toast')), 'texto inválido no % ideal mostra aviso em vez de virar 0');
  await page.close();
}

// ---------------------------------------------------------------- 19
console.log('\n19) Proventos: limite de valor e exclusão');
{
  const page = await openApp('scenario=zerada&run=19');
  await page.click('.nav-btn[data-tab="timeline"]');
  await page.fill('#div-ticker', 'MXRF11');
  await page.fill('#div-valor', '99999999999');
  await page.click('#btn-add-div');
  await page.waitForTimeout(300);
  check(/máximo/.test(await txt(page, '#toast')) && (await dbState(page)).dividendos.length === 0, 'valor absurdo é recusado com aviso');
  await page.fill('#div-valor', '45,90');
  await page.click('#btn-add-div');
  await page.waitForTimeout(1200);
  let st = await dbState(page);
  check(st.dividendos.length === 1 && Math.abs(st.classes.find((c) => c.isCash).currentValue - 45.9) < 0.001, 'provento somado ao Caixa');
  await page.click('[data-del-div]');
  await confirmModal(page);
  await page.waitForTimeout(1200);
  st = await dbState(page);
  check(st.dividendos.length === 0 && st.classes.find((c) => c.isCash).currentValue === 0 && !st.timeline.some((t) => t.type === 'dividendo'), 'excluir tira o provento, o valor do Caixa e o evento do histórico');
  await page.close();
}

// ---------------------------------------------------------------- 20
console.log('\n20) Mudar o tipo da classe não zera o valor');
{
  const page = await openApp('scenario=zerada&run=20');
  await page.click('.nav-btn[data-tab="ativos"]');
  const q = page.locator('.asset-card').first().locator('[data-f="qty"]');
  await q.fill('10'); await q.press('Tab');
  await page.waitForTimeout(400);
  await page.click('.nav-btn[data-tab="config"]');
  await page.locator('#class-list .class-row').first().locator('[data-f="type"]').selectOption('rendafixa');
  await page.waitForSelector('.modal-back.show');
  check(/continua R\$\s*662,10/.test(await txt(page, '#modal')), 'confirmação mostra que o valor continua R$ 662,10');
  await page.click('.modal .btn-primary');
  await page.waitForTimeout(400);
  check(/662,10/.test(await txt(page, '#patrimonio-total')), 'patrimônio continua R$ 662,10 depois de mudar para renda fixa');
  await page.close();
}

// ---------------------------------------------------------------- 21
console.log('\n21) Duplo clique em "Registrar" não fecha a confirmação');
{
  const page = await openApp('scenario=zerada&run=21');
  await calcularAporte(page, '300');
  await page.dblclick('#btn-registrar');
  await page.waitForTimeout(500);
  check(await page.locator('.modal-back.show').count() === 1, 'a confirmação continua aberta');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(await page.locator('.modal-back.show').count() === 0 && (await dbState(page)).aportes.length === 0, 'Esc cancela sem registrar');
  await page.close();
}


// ---------------------------------------------------------------- 22
console.log('\n22) Exportar backup salva a carteira de verdade; aviso que sumiu não recebe clique');
{
  const page = await openApp('scenario=zerada&run=22');
  await page.click('.nav-btn[data-tab="config"]');
  const dl = page.waitForEvent('download');
  await page.click('#btn-export-backup');
  const file = await (await dl).path();
  const bk = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(bk.app === 'aporte-mais' && Array.isArray(bk.state?.classes) && bk.state.classes.length === 6, `backup tem a carteira (${bk.state?.classes?.length} classes)`);
  // remover a classe Criptomoedas, esperar o aviso sumir e clicar onde ele estava
  const row = page.locator('#class-list .class-row').filter({ has: page.locator('[data-f="name"][value="Criptomoedas"]') });
  await row.locator('[data-action="remove"]').click();
  await confirmModal(page);
  await page.waitForSelector('#toast.show #toast-action');
  const box = await page.locator('#toast-action').boundingBox();
  await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('show'), null, { timeout: 15000 });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  const names = await page.evaluate(() => [...document.querySelectorAll('#class-list [data-f="name"]')].map((i) => i.value));
  check(!names.includes('Criptomoedas'), 'clique onde estava o "Desfazer" (já sumido) não traz a classe de volta');
  await page.close();
}

console.log(`\n${passes} ok, ${failures} falha(s)`);
if (errors.length) { console.log('\nErros de JavaScript na página:'); errors.forEach((e) => console.log('  ' + e)); }
await browser.close();
server.close();
process.exit(failures || errors.length ? 1 : 0);
