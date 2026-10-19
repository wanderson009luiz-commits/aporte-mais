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
  check(/BCFF11 está sem preço/.test(order), 'aviso do ativo sem preço aparece');
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
  await page.click('#btn-undo');
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

console.log(`\n${passes} ok, ${failures} falha(s)`);
if (errors.length) { console.log('\nErros de JavaScript na página:'); errors.forEach((e) => console.log('  ' + e)); }
await browser.close();
server.close();
process.exit(failures || errors.length ? 1 : 0);
