// End-to-end scenarios in a real browser (Chromium via Playwright): an
// "iPhone" and a "laptop" on different origins (separate storage) sharing one
// test database. Run with: npm run e2e
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { startServer } from './server.mjs';

const root = execSync('npm root -g').toString().trim();
const { chromium, devices } = await import(`${root}/playwright/index.mjs`);

const PASS = 'نافذة برتقال سفر هادئ';
const NEW_PASS = 'جبل قهوة مطر ٢٠٢٦ أزرق';
const results = [];
const shots = 'docs/screenshots';
mkdirSync(shots, { recursive: true });

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: String((e && e.message) || e).split('\n')[0] });
    console.log(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n')[0]}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function poll(fn, msg, timeout = 8000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`timeout: ${msg}`);
}

const { server, docs } = await startServer(4173);
const browser = await chromium.launch();

async function device(origin, options) {
  const ctx = await browser.newContext(options);
  const external = [];
  const errors = [];
  const consoleText = [];
  ctx.on('request', (r) => {
    if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) external.push(r.url());
  });
  await ctx.addInitScript(() => {
    window.__notif = 0;
    if (window.Notification) {
      const orig = Notification.requestPermission;
      Notification.requestPermission = function () {
        window.__notif++;
        return orig.apply(this, arguments);
      };
    }
    if (navigator.permissions) {
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) => {
        if (d && d.name === 'notifications') window.__notif++;
        return q(d);
      };
    }
    if (window.PushManager) {
      const s = PushManager.prototype.subscribe;
      PushManager.prototype.subscribe = function () {
        window.__notif++;
        return s.apply(this, arguments);
      };
    }
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    consoleText.push(m.text());
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + '/');
  return { ctx, page, external, errors, consoleText };
}

const titles = (page) => page.$$eval('#list .task-title', (els) => els.map((e) => e.textContent));
const row = (page, title) => page.locator('#list li.task', { has: page.locator('.task-title', { hasText: title }) });
async function addTask(page, text) {
  await page.fill('#newTask', text);
  await page.press('#newTask', 'Enter');
}
async function openTask(page, title) {
  await row(page, title).locator('.task-body').click();
  await page.waitForSelector('#taskTitle');
}
async function closeSheet(page) {
  await page.click('#sheet [data-k="close"]');
  await page.waitForSelector('#sheetLayer', { state: 'hidden' });
}
const noHorizontalScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);

// ---------------------------------------------------------------------------
console.log('\nPocket Time — end-to-end\n');

const phone = await device('http://localhost:4173', { ...devices['iPhone SE'], defaultBrowserType: undefined, locale: 'ar' });
const P = phone.page;
let recoveryCode = '';

await step('First run: passphrase rules, vault creation, one-time recovery code', async () => {
  await P.waitForSelector('#pass1');
  await P.fill('#pass1', 'short');
  await P.fill('#pass2', 'short');
  await P.click('#gate button[type=submit]');
  await P.waitForSelector('#gate .error:not([hidden])');
  assert((await P.textContent('#gate .error')).includes('10'), 'short passphrase error');
  await P.screenshot({ path: `${shots}/01-setup-iphone.png` });
  await P.fill('#pass1', PASS);
  await P.fill('#pass2', PASS.replace('سفر', 'سفر'));
  await P.click('#gate button[type=submit]');
  await P.waitForSelector('#gate .code', { timeout: 20000 });
  recoveryCode = (await P.textContent('#gate .code')).trim();
  assert(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/.test(recoveryCode), 'recovery code format');
  assert(await P.isDisabled('#gate .btn.primary'), 'start disabled until confirmed');
  await P.check('#savedIt');
  await P.click('#gate .btn.primary');
  await P.waitForSelector('#gate', { state: 'hidden' });
});

await step('1. Add a task in seconds (type + Return)', async () => {
  const t0 = Date.now();
  await P.click('#newTask');
  await P.keyboard.type('اتصال سريع');
  await P.keyboard.press('Enter');
  await row(P, 'اتصال سريع').waitFor();
  const ms = Date.now() - t0;
  assert(ms < 3000, `took ${ms}ms`);
  assert((await P.inputValue('#newTask')) === '', 'composer cleared');
  assert(await P.evaluate(() => document.activeElement.id === 'newTask'), 'composer keeps focus for the next task');
});

await step('2. Add a task without a time', async () => {
  await addTask(P, 'شراء هدية');
  await row(P, 'شراء هدية').waitFor();
  assert((await row(P, 'شراء هدية').locator('.task-time').count()) === 0, 'no time column');
});

await step('3. Add a task with start and end in one line', async () => {
  await P.fill('#newTask', 'قراءة كتاب 20:00-20:30');
  await P.waitForSelector('#parse:not([hidden])');
  assert((await P.textContent('#parseChip')).includes('20:00–20:30'), 'preview chip');
  await P.press('#newTask', 'Enter');
  const r = row(P, 'قراءة كتاب');
  await r.waitFor();
  assert((await r.locator('.task-time .start').textContent()) === '20:00', 'start');
  assert((await r.locator('.task-time .end').textContent()) === '20:30', 'end');
});

await step('Quick add understands "tomorrow" and can be ignored', async () => {
  await P.fill('#newTask', 'الاتصال بالمورد غدًا 10:00');
  await P.waitForSelector('#parse:not([hidden])');
  assert((await P.textContent('#parseChip')).includes('غدًا · 10:00'), 'chip shows tomorrow');
  await P.press('#newTask', 'Enter');
  await P.waitForSelector('#toast:not([hidden])');
  assert((await P.textContent('#toast')).includes('غدًا'), 'toast names the day');
  assert((await row(P, 'الاتصال بالمورد').count()) === 0, 'not on today');
  await P.fill('#newTask', 'موعد 9:00 مع أحمد');
  await P.click('#parseIgnore');
  assert(await P.isHidden('#parse'), 'chip hidden after ignore');
  await P.press('#newTask', 'Enter');
  await row(P, 'موعد 9:00 مع أحمد').waitFor();
});

await step('4. Arabic-Indic digits become 123 (typing, pasting, saved data)', async () => {
  await P.click('#newTask');
  await P.keyboard.type('١٢٣');
  assert((await P.inputValue('#newTask')) === '123', 'typed');
  await P.evaluate(() => document.execCommand('insertText', false, ' ٤٥٦ ۷۸۹'));
  assert((await P.inputValue('#newTask')) === '123 456 789', 'pasted: ' + (await P.inputValue('#newTask')));
  await P.fill('#newTask', '');
  await P.evaluate(() => {
    const el = document.getElementById('newTask');
    el.value = 'رياضة ٧:٣٠ م لمدة ٤٥ دقيقة';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert((await P.inputValue('#newTask')) === 'رياضة 7:30 م لمدة 45 دقيقة', 'programmatic input');
  await P.press('#newTask', 'Enter');
  const r = row(P, 'رياضة');
  await r.waitFor();
  assert((await r.locator('.task-time .start').textContent()) === '19:30', 'pm time');
  assert((await r.locator('.task-time .end').textContent()) === '20:15', 'duration end');
  const text = await P.evaluate(() => document.body.innerText);
  assert(!/[٠-٩۰-۹]/.test(text), 'no Arabic-Indic digits anywhere on screen');
});

await step('5. Change a task time (10:00-style edit) without recreating it', async () => {
  await openTask(P, 'قراءة كتاب');
  await P.waitForTimeout(250);
  await P.screenshot({ path: `${shots}/05-task-sheet-iphone.png` });
  await P.click('#sheet [data-k="time-start"]');
  await P.click('#sheet [data-k="start-h-14"]');
  await P.click('#sheet [data-k="start-m-0"]');
  await closeSheet(P);
  const r = row(P, 'قراءة كتاب');
  assert((await r.locator('.task-time .start').textContent()) === '14:00', 'new start');
  assert((await r.locator('.task-time .end').textContent()) === '14:30', 'duration kept');
  assert((await row(P, 'قراءة كتاب').count()) === 1, 'still one task');
});

await step('Overlapping times are flagged quietly, not blocked', async () => {
  await addTask(P, 'مكالمة 14:15-14:45');
  await row(P, 'مكالمة').waitFor();
  assert((await row(P, 'مكالمة').locator('.tag').textContent()) === 'يتداخل', 'tag shown');
});

await step('6. Move a task to tomorrow', async () => {
  await openTask(P, 'شراء هدية');
  await P.click('#sheet [data-k="date-غدًا"]');
  await closeSheet(P);
  assert((await row(P, 'شراء هدية').count()) === 0, 'gone from today');
  await P.click('#nextBtn');
  await row(P, 'شراء هدية').waitFor();
  await row(P, 'الاتصال بالمورد').waitFor();
  await P.click('#todayBtn');
  await row(P, 'قراءة كتاب').waitFor();
});

await step('7. Mark done, then not done (one tap each, no confirmation)', async () => {
  const r = row(P, 'قراءة كتاب');
  await r.locator('.check').click();
  await poll(async () => (await r.getAttribute('class')).includes('done'), 'done class');
  assert((await r.locator('.check').getAttribute('aria-pressed')) === 'true', 'aria-pressed');
  assert(await P.isHidden('#sheetLayer'), 'no dialog');
  await r.locator('.check').click();
  await poll(async () => !(await r.getAttribute('class')).includes('done'), 'undone');
});

await step('Delete with undo', async () => {
  await openTask(P, 'اتصال سريع');
  await P.click('#sheet [data-k="delete"]');
  await poll(async () => (await row(P, 'اتصال سريع').count()) === 0, 'deleted');
  await P.click('#toast button');
  await row(P, 'اتصال سريع').waitFor();
});

await step('8. Close and reopen: data is still there, no passphrase asked', async () => {
  const before = (await titles(P)).sort();
  await P.reload();
  await P.waitForSelector('#list .task');
  assert(await P.isHidden('#gate'), 'no gate');
  const after = (await titles(P)).sort();
  assert(JSON.stringify(before) === JSON.stringify(after), `${before} vs ${after}`);
});

// --- Laptop ---------------------------------------------------------------
const laptop = await device('http://127.0.0.1:4173', { viewport: { width: 1280, height: 800 }, locale: 'ar' });
const L = laptop.page;

await step('Second device: wrong passphrase rejected, right one unlocks once', async () => {
  await L.waitForSelector('#unlockPass', { timeout: 15000 });
  await L.fill('#unlockPass', 'not the passphrase');
  await L.click('#gate button[type=submit]');
  await L.waitForSelector('#gate .error:not([hidden])', { timeout: 20000 });
  await L.fill('#unlockPass', PASS.replace('٢', '2'));
  await L.click('#gate button[type=submit]');
  await L.waitForSelector('#gate', { state: 'hidden', timeout: 20000 });
  await row(L, 'قراءة كتاب').waitFor({ timeout: 8000 });
});

await step('9. Edit on iPhone → appears on laptop, and back', async () => {
  await row(P, 'قراءة كتاب').locator('.check').click();
  await poll(async () => (await row(L, 'قراءة كتاب').getAttribute('class')).includes('done'), 'laptop sees done');
  await addTask(L, 'من اللابتوب');
  await row(P, 'من اللابتوب').waitFor({ timeout: 8000 });
  await openTask(L, 'مكالمة');
  await L.click('#sheet [data-k="shift-60"]');
  await closeSheet(L);
  await poll(async () => (await row(P, 'مكالمة').locator('.task-time .start').textContent()) === '15:15', 'phone sees shift');
});

await step('10. Same task edited on both devices: no silent loss', async () => {
  await P.evaluate(() => window.__mock.setOffline(true));
  await L.evaluate(() => window.__mock.setOffline(true));
  await openTask(P, 'رياضة');
  await P.fill('#taskTitle', 'رياضة (نسخة الآيفون)');
  await closeSheet(P);
  await new Promise((r) => setTimeout(r, 50));
  await openTask(L, 'رياضة');
  await L.fill('#taskTitle', 'رياضة (نسخة اللابتوب)');
  await closeSheet(L);
  await P.evaluate(() => (window.__mock.setOffline(false), window.dispatchEvent(new Event('online'))));
  await L.evaluate(() => (window.__mock.setOffline(false), window.dispatchEvent(new Event('online'))));
  await poll(async () => {
    const a = (await titles(P)).filter((x) => x.startsWith('رياضة'));
    const b = (await titles(L)).filter((x) => x.startsWith('رياضة'));
    return a.length === 1 && b.length === 1 && a[0] === b[0] && a[0].includes('اللابتوب');
  }, 'converged on the newest title', 15000);
  const r = row(P, 'رياضة');
  assert((await r.locator('.tag').allTextContents()).includes('نسختان'), 'two-versions tag');
  await r.locator('.task-body').click();
  await P.waitForSelector('#sheet .conflict');
  assert((await P.textContent('#sheet .conflict-value')).includes('الآيفون'), 'other version offered');
  await P.waitForTimeout(250);
  await P.screenshot({ path: `${shots}/10-conflict-iphone.png` });
  await P.click('#sheet .conflict .chip >> nth=0');
  await closeSheet(P);
  await poll(async () => (await titles(L)).includes('رياضة (نسخة الآيفون)'), 'choice synced');
});

await step('11. Offline: keeps working, says so calmly, syncs when back', async () => {
  await P.evaluate(() => window.__mock.setOffline(true));
  await addTask(P, 'مهمة دون اتصال');
  await row(P, 'مهمة دون اتصال').waitFor();
  await poll(async () => (await P.isVisible('#status')) && (await P.textContent('#status')).includes('محفوظ على الجهاز'), 'offline note', 10000);
  await P.evaluate(() => (window.__mock.setOffline(false), window.dispatchEvent(new Event('online'))));
  await row(L, 'مهمة دون اتصال').waitFor({ timeout: 10000 });
  await poll(async () => await P.isHidden('#status'), 'status clears');
});

await step('Closing the page before it could sync loses nothing', async () => {
  await P.evaluate(() => window.__mock.setOffline(true));
  await addTask(P, 'أُغلقت قبل المزامنة');
  await row(P, 'أُغلقت قبل المزامنة').waitFor();
  await new Promise((r) => setTimeout(r, 300));
  await P.reload(); // the reloaded page is online again
  await row(P, 'أُغلقت قبل المزامنة').waitFor();
  await row(L, 'أُغلقت قبل المزامنة').waitFor({ timeout: 10000 });
});

await step('Earlier open tasks are offered, never moved automatically', async () => {
  await P.click('#prevBtn');
  await addTask(P, 'مهمة الأمس');
  await row(P, 'مهمة الأمس').waitFor();
  await P.click('#todayBtn');
  await P.waitForSelector('#list .carry');
  assert((await row(P, 'مهمة الأمس').count()) === 0, 'not moved by itself');
  await P.click('#list .carry');
  await P.click('#sheet .carry-item .chip');
  await row(P, 'مهمة الأمس').waitFor();
});

await step('12. Arabic RTL and English LTR', async () => {
  assert((await P.getAttribute('html', 'dir')) === 'rtl', 'rtl');
  await P.screenshot({ path: `${shots}/12-day-iphone-ar.png` });
  await P.click('#settingsBtn');
  await P.click('#sheet [data-k="lang-en"]');
  await closeSheet(P);
  assert((await P.getAttribute('html', 'dir')) === 'ltr', 'ltr');
  assert((await P.getAttribute('#newTask', 'placeholder')) === 'Add a task…', 'english placeholder');
  assert((await P.textContent('#dayMain')) === 'Today', 'english day');
  assert(await noHorizontalScroll(P), 'no horizontal scroll in English');
  await P.screenshot({ path: `${shots}/12-day-iphone-en.png` });
  await P.click('#settingsBtn');
  await P.click('#sheet [data-k="lang-ar"]');
  await closeSheet(P);
  assert((await P.getAttribute('html', 'dir')) === 'rtl', 'back to rtl');
});

await step('13. Small iPhone, 320px, dark mode and laptop layouts', async () => {
  assert(await noHorizontalScroll(P), 'iPhone SE');
  const small = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  const sp = await small.newPage();
  await sp.goto('http://localhost:4173/');
  await sp.waitForSelector('#app');
  assert(await noHorizontalScroll(sp), '320px');
  await small.close();
  await P.emulateMedia({ colorScheme: 'dark' });
  await P.screenshot({ path: `${shots}/13-day-iphone-dark.png` });
  await openTask(P, 'مكالمة');
  await P.waitForTimeout(250);
  await P.screenshot({ path: `${shots}/13-task-sheet-dark.png` });
  await closeSheet(P);
  await P.emulateMedia({ colorScheme: 'light' });
  const tapTargets = await P.evaluate(() =>
    [...document.querySelectorAll('#list .check, #newTask, #prevBtn, #nextBtn, #settingsBtn, .week-day')]
      .map((e) => [e.id || e.className, Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)])
      .filter(([, w, h]) => w < 40 || h < 40),
  );
  assert(tapTargets.length === 0, `small tap targets: ${JSON.stringify(tapTargets)}`);
  assert(await noHorizontalScroll(L), 'laptop');
  await L.screenshot({ path: `${shots}/13-day-laptop.png` });
});

await step('Laptop keyboard: n focuses the composer, arrows change day, Esc closes', async () => {
  await L.evaluate(() => document.activeElement && document.activeElement.blur());
  await L.keyboard.press('n');
  assert(await L.evaluate(() => document.activeElement.id === 'newTask'), 'focus');
  await L.keyboard.press('Escape');
  const day = await L.textContent('#dayMain');
  await L.keyboard.press('ArrowLeft');
  await poll(async () => (await L.textContent('#dayMain')) !== day, 'day changed');
  await L.keyboard.press('t');
  await poll(async () => (await L.textContent('#dayMain')) === 'اليوم', 'back to today');
});

await step('Recovery code: forgot passphrase on a new device', async () => {
  const third = await device('http://127.0.0.2:4173', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const T = third.page;
  await T.waitForSelector('#unlockPass', { timeout: 15000 });
  await T.click('#gate .link');
  await T.fill('#recCode', recoveryCode.toLowerCase().replace(/-/g, ' '));
  await T.fill('#recNew1', NEW_PASS);
  await T.fill('#recNew2', NEW_PASS);
  await T.click('#gate button[type=submit]');
  await T.waitForSelector('#gate', { state: 'hidden', timeout: 20000 });
  await row(T, 'قراءة كتاب').waitFor({ timeout: 8000 });
  await third.ctx.close();
});

await step('Export a plain copy through the download capability', async () => {
  await P.click('#settingsBtn');
  await P.click('#sheet [data-k="export"]');
  await poll(() => P.evaluate(() => window.__downloads.length === 1), 'download');
  const data = JSON.parse(await P.evaluate(() => window.__downloads[0].data));
  assert(data.tasks.some((x) => x.title === 'قراءة كتاب'), 'export content');
  await closeSheet(P);
});

await step('14. No notifications and no permission prompts', async () => {
  for (const d of [phone, laptop]) assert((await d.page.evaluate(() => window.__notif)) === 0, 'notification API touched');
});

await step('15. Server holds ciphertext only', async () => {
  const all = [...docs.entries()];
  assert(all.length >= 2, 'docs exist');
  const dump = JSON.stringify(all);
  for (const word of ['قراءة', 'رياضة', 'هدية', 'اللابتوب', '14:00', '20:30', PASS, NEW_PASS]) {
    assert(!dump.includes(word), `plaintext found: ${word}`);
  }
  for (const [path, body] of all) {
    assert(path.startsWith('data/users/user-test-1/'), 'private per-user path: ' + path);
    if (path.endsWith('/keyring')) assert(Object.keys(body.pass).sort().join() === 'ct,iter,iv,kdf,salt', 'keyring shape');
    else assert(Object.keys(body).sort().join() === 'ct,iv,k,v', 'bucket shape');
  }
});

await step('16. No third-party requests, no errors, no task content in logs', async () => {
  for (const d of [phone, laptop]) {
    assert(d.external.length === 0, 'external: ' + d.external.join(', '));
    assert(d.errors.length === 0, 'errors: ' + d.errors.join(' | '));
    const logs = d.consoleText.join('\n');
    assert(!/قراءة|رياضة|هدية/.test(logs), 'task text in console');
  }
});

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
writeFileSync('e2e/results.json', JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
