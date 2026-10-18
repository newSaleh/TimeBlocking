// End-to-end scenarios in a real browser (Chromium via Playwright).
// An "iPhone" and a "laptop" on different origins (separate storage) use the
// built GitHub Pages site; GitHub's API is replaced by an in-memory fake.
// Run with: npm run e2e
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { startServer } from './server.mjs';
import { createFakeGitHub } from '../test/fake-github.mjs';

const root = execSync('npm root -g').toString().trim();
const { chromium, devices } = await import(`${root}/playwright/index.mjs`);

const REPO = 'newSaleh/pocket-time-data';
const TOKEN = 'github_pat_TEST_TOKEN_123';
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
    try {
      await P.screenshot({ path: `e2e/debug-${results.length}.png` });
    } catch (_) {}
    console.log(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n')[0]}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function poll(fn, msg, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await fn()) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`timeout: ${msg}`);
}

const { server, docs } = await startServer(4173);
const gh = createFakeGitHub({ token: TOKEN, repo: REPO });
const browser = await chromium.launch();

async function device(origin, options, path = '/') {
  const ctx = await browser.newContext({ ...options, permissions: ['clipboard-read', 'clipboard-write'] });
  const state = { offline: false };
  const external = [];
  const errors = [];
  const consoleText = [];
  await ctx.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    if (state.offline) return route.abort('internetdisconnected');
    const r = gh.handle(req.method(), req.url(), await req.allHeaders(), req.postData());
    await route.fulfill({ status: r.status, headers: r.headers, body: r.body });
  });
  ctx.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('https://api.github.com/') && !u.startsWith('data:')) external.push(u);
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
  await page.goto(origin + path);
  return {
    ctx,
    page,
    external,
    errors,
    consoleText,
    async setOffline(v) {
      state.offline = v;
      await ctx.setOffline(v);
      if (!v) await page.evaluate(() => window.dispatchEvent(new Event('online')));
    },
  };
}

const titles = (page) => page.evaluate(() => [...document.querySelectorAll('#list .task-title')].map((e) => e.textContent));
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
async function go(page, btn) {
  const before = await page.textContent('#daySub');
  await page.click(btn);
  await poll(async () => (await page.textContent('#daySub')) !== before, 'day changed');
}
const noHorizontalScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);

// ---------------------------------------------------------------------------
console.log('\nPocket Time — end-to-end\n');

const phone = await device('http://localhost:4173', { ...devices['iPhone SE'], defaultBrowserType: undefined, locale: 'ar' });
const P = phone.page;
let recoveryLink = '';

await step('First open: no password, no setup, straight to today', async () => {
  await P.waitForSelector('#newTask');
  assert(await P.isHidden('#gate'), 'no gate');
  assert((await P.textContent('#dayMain')) === 'اليوم', 'today');
  await P.waitForSelector('#list .empty');
  await P.screenshot({ path: `${shots}/01-first-open-iphone.png` });
});

await step('1. Add a task in seconds (type + Return)', async () => {
  const t0 = Date.now();
  await P.click('#newTask');
  await P.keyboard.type('اتصال سريع');
  await P.keyboard.press('Enter');
  await row(P, 'اتصال سريع').waitFor();
  assert(Date.now() - t0 < 3000, 'slow');
  assert((await P.inputValue('#newTask')) === '', 'composer cleared');
  assert(await P.evaluate(() => document.activeElement.id === 'newTask'), 'composer keeps focus');
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
  assert((await row(P, 'الاتصال بالمورد').count()) === 0, 'not on today');
  await P.fill('#newTask', 'موعد 9:00 مع أحمد');
  await P.click('#parseIgnore');
  await P.press('#newTask', 'Enter');
  await row(P, 'موعد 9:00 مع أحمد').waitFor();
});

await step('4. Arabic-Indic digits become 123 (typing, pasting, saved data)', async () => {
  await P.click('#newTask');
  await P.keyboard.type('١٢٣');
  assert((await P.inputValue('#newTask')) === '123', 'typed');
  await P.evaluate(() => document.execCommand('insertText', false, ' ٤٥٦ ۷۸۹'));
  assert((await P.inputValue('#newTask')) === '123 456 789', 'pasted');
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
  assert(!/[٠-٩۰-۹]/.test(await P.evaluate(() => document.body.innerText)), 'no Arabic-Indic digits on screen');
});

await step('5. Change a task time without recreating it', async () => {
  await openTask(P, 'قراءة كتاب');
  await P.click('#sheet [data-k="time-start"]');
  await P.click('#sheet [data-k="start-h-14"]');
  await P.click('#sheet [data-k="start-m-0"]');
  await P.waitForTimeout(250);
  await P.screenshot({ path: `${shots}/05-task-sheet-iphone.png` });
  await closeSheet(P);
  const r = row(P, 'قراءة كتاب');
  assert((await r.locator('.task-time .start').textContent()) === '14:00', 'new start');
  assert((await r.locator('.task-time .end').textContent()) === '14:30', 'duration kept');
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
  await P.click('#todayBtn');
  await row(P, 'قراءة كتاب').waitFor();
});

await step('7. Mark done, then not done (one tap each, no confirmation)', async () => {
  const r = row(P, 'قراءة كتاب');
  await r.locator('.check').click();
  await poll(async () => (await r.getAttribute('class')).includes('done'), 'done class');
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

await step('8. Close and reopen: data is still there', async () => {
  const before = (await titles(P)).sort();
  await P.reload();
  await P.waitForSelector('#list .task');
  const after = (await titles(P)).sort();
  assert(JSON.stringify(before) === JSON.stringify(after), `${before} vs ${after}`);
});

await step('Opens with no internet at all (offline cold start)', async () => {
  await P.evaluate(() => navigator.serviceWorker.ready);
  await P.reload();
  await poll(() => P.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls page');
  await phone.setOffline(true);
  await P.reload();
  await row(P, 'قراءة كتاب').waitFor({ timeout: 8000 });
  await addTask(P, 'أُضيفت دون إنترنت');
  await row(P, 'أُضيفت دون إنترنت').waitFor();
  await phone.setOffline(false);
});

await step('Turn on GitHub sync: clear errors, then one-time setup', async () => {
  await P.click('#settingsBtn');
  await P.click('#sheet [data-k="sub-github"]');
  await P.fill('#ghRepo', REPO);
  await P.fill('#ghToken', 'wrong-token');
  await P.click('#sheet button[type=submit]');
  await P.waitForSelector('#sheet .error:not([hidden])');
  assert((await P.textContent('#sheet .error')).includes('رمز GitHub غير صالح'), 'token error');
  await P.screenshot({ path: `${shots}/github-setup-iphone.png` });
  await P.fill('#ghRepo', 'https://github.com/' + REPO);
  await P.fill('#ghToken', TOKEN);
  await P.click('#sheet button[type=submit]');
  await P.waitForSelector('#sheet [data-k="sendEmail"]', { timeout: 10000 });
  await P.waitForTimeout(250);
  await P.screenshot({ path: `${shots}/recovery-send-iphone.png` });
  const mail = await P.getAttribute('#sheet [data-k="sendEmail"]', 'href');
  const tg = await P.getAttribute('#sheet [data-k="sendTelegram"]', 'href');
  assert(mail.startsWith('mailto:?subject=') && decodeURIComponent(mail).includes('#pair='), 'email link');
  assert(tg.startsWith('https://t.me/share/url?url=') && decodeURIComponent(tg).includes('#pair='), 'telegram link');
  await P.click('#sheet [data-k="copyLink"]');
  recoveryLink = await P.evaluate(() => navigator.clipboard.readText());
  assert(recoveryLink.startsWith('http://localhost:4173/#pair='), 'copied link: ' + recoveryLink.slice(0, 40));
  await closeSheet(P);
  await poll(() => gh.files.has('pt/meta.json') && [...gh.files.keys()].some((k) => k.startsWith('pt/b/')), 'uploaded to GitHub');
});

// --- Laptop ---------------------------------------------------------------
const laptop = await device('http://127.0.0.1:4173', { viewport: { width: 1280, height: 800 }, locale: 'ar' });
const L = laptop.page;

await step('Laptop: opening the recovery link connects it, no password', async () => {
  await L.waitForSelector('#newTask');
  await L.goto(recoveryLink.replace('http://localhost:4173', 'http://127.0.0.1:4173'));
  await row(L, 'قراءة كتاب').waitFor({ timeout: 10000 });
  await row(L, 'أُضيفت دون إنترنت').waitFor();
  assert(!(await L.evaluate(() => location.hash)).includes('pair'), 'link removed from the address bar');
});

await step('9. Edit on iPhone → appears on laptop, and back', async () => {
  await row(P, 'قراءة كتاب').locator('.check').click();
  await poll(async () => (await row(L, 'قراءة كتاب').getAttribute('class')).includes('done'), 'laptop sees done', 25000);
  await addTask(L, 'من اللابتوب');
  await row(P, 'من اللابتوب').waitFor({ timeout: 25000 });
});

await step('10. Same task edited on both devices: no silent loss', async () => {
  await phone.setOffline(true);
  await laptop.setOffline(true);
  await openTask(P, 'رياضة');
  await P.fill('#taskTitle', 'رياضة (نسخة الآيفون)');
  await closeSheet(P);
  await new Promise((r) => setTimeout(r, 50));
  await openTask(L, 'رياضة');
  await L.fill('#taskTitle', 'رياضة (نسخة اللابتوب)');
  await closeSheet(L);
  await phone.setOffline(false);
  await laptop.setOffline(false);
  await poll(async () => {
    const a = (await titles(P)).filter((x) => x.startsWith('رياضة'));
    const b = (await titles(L)).filter((x) => x.startsWith('رياضة'));
    return a.length === 1 && b.length === 1 && a[0] === b[0];
  }, 'converged', 30000);
  const r = row(P, 'رياضة');
  await poll(async () => (await r.locator('.tag').allTextContents()).includes('نسختان'), 'two-versions tag', 15000);
  await r.locator('.task-body').click();
  await P.waitForSelector('#sheet .conflict');
  await P.waitForTimeout(250);
  await P.screenshot({ path: `${shots}/10-conflict-iphone.png` });
  await closeSheet(P);
});

await step('11. Offline: keeps working, says so calmly, syncs when back', async () => {
  await phone.setOffline(true);
  await addTask(P, 'مهمة دون اتصال');
  await row(P, 'مهمة دون اتصال').waitFor();
  await poll(async () => (await P.isVisible('#status')) && (await P.textContent('#status')).includes('محفوظ على الجهاز'), 'offline note', 15000);
  await phone.setOffline(false);
  await row(L, 'مهمة دون اتصال').waitFor({ timeout: 20000 });
  await poll(async () => await P.isHidden('#status'), 'status clears', 15000);
});

await step('A third device that skips the link is told to use it; pasting it works', async () => {
  const third = await device('http://127.0.0.2:4173', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const T = third.page;
  await T.waitForSelector('#newTask');
  await addTask(T, 'مهمة الجهاز الثالث');
  await T.click('#settingsBtn');
  await T.click('#sheet [data-k="sub-github"]');
  await T.fill('#ghRepo', REPO);
  await T.fill('#ghToken', TOKEN);
  await T.click('#sheet button[type=submit]');
  await T.waitForSelector('#sheet .error:not([hidden])');
  assert((await T.textContent('#sheet .error')).includes('رابط الاستعادة'), 'mismatch explained');
  await closeSheet(T);
  await T.click('#settingsBtn');
  await T.click('#sheet [data-k="sub-pair2"]');
  await T.fill('#pairInput', 'not a link');
  await T.click('#sheet button[type=submit]');
  await T.waitForSelector('#sheet .error:not([hidden])');
  await T.fill('#pairInput', recoveryLink);
  await T.click('#sheet button[type=submit]');
  await row(T, 'قراءة كتاب').waitFor({ timeout: 15000 });
  await row(T, 'مهمة الجهاز الثالث').waitFor();
  await row(P, 'مهمة الجهاز الثالث').waitFor({ timeout: 20000 });
  await third.ctx.close();
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

await step('Tapping empty space in the day opens the composer', async () => {
  await P.evaluate(() => document.activeElement && document.activeElement.blur());
  await P.evaluate(() => (document.getElementById('main').scrollTop = 1e6));
  const box = await P.locator('#main').boundingBox();
  await P.mouse.click(box.x + box.width / 2, box.y + box.height - 30);
  assert(await P.evaluate(() => document.activeElement.id === 'newTask'), 'composer focused');
  await P.evaluate(() => document.activeElement.blur());
});

await step('Import from Reminders: paste, tomorrow pre-selected, no duplicates', async () => {
  const tomorrow = await P.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const lines = [`${tomorrow} 09:00 تمارين الصباح`, `${tomorrow} 15:00 حلاق (Oct/15)`, `${tomorrow} 00:00 شراء هدية`, `2030-01-01 10:00 مهمة بعيدة`].join('\n');
  await P.click('#settingsBtn');
  await P.click('#sheet [data-k="openImport"]');
  await P.fill('#importText', lines);
  await P.click(`#sheet [data-k="importFor-${tomorrow}"]`);
  const checked = await P.evaluate(() => [...document.querySelectorAll('.import-item input')].map((x) => x.checked));
  // Only tomorrow's lines are shown; "شراء هدية" was moved to tomorrow earlier, so it is left out.
  assert(JSON.stringify(checked) === JSON.stringify([true, true]), 'selection ' + JSON.stringify(checked));
  assert((await P.textContent('#sheet [data-k="importSkipped"]')).includes('مهمة واحدة'), 'skipped note');
  await P.waitForTimeout(200);
  await P.screenshot({ path: `${shots}/import-iphone.png` });
  await P.click('#sheet [data-k="importAdd"]');
  await row(P, 'تمارين الصباح').waitFor();
  assert((await row(P, 'حلاق (Oct/15)').locator('.task-time .start').textContent()) === '15:00', 'time kept');
  assert((await titles(P)).filter((x) => x === 'شراء هدية').length === 1, 'no duplicate');
  // Delete one imported task, then import the same text again: nothing comes back.
  await openTask(P, 'حلاق (Oct/15)');
  await P.click('#sheet [data-k="delete"]');
  await poll(async () => (await row(P, 'حلاق (Oct/15)').count()) === 0, 'deleted');
  await P.click('#settingsBtn');
  await P.click('#sheet [data-k="openImport"]');
  await P.fill('#importText', lines);
  await P.click(`#sheet [data-k="importFor-${tomorrow}"]`);
  const left = await P.evaluate(() => [...document.querySelectorAll('.import-item .task-title')].map((x) => x.textContent));
  assert(JSON.stringify(left) === '[]', 'nothing left for tomorrow: ' + JSON.stringify(left));
  assert((await P.textContent('#sheet [data-k="importSkipped"]')).includes('3'), 'three skipped');
  await closeSheet(P);
  await P.click('#todayBtn');
});

await step('Pasted Shortcut text picks its own day (today here)', async () => {
  const today = await P.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await P.click('#settingsBtn');
  await P.click('#sheet [data-k="openImport"]');
  await P.fill('#importText', `\n${today} 08:00 مهمة من الاختصار\n${today} 21:30 مهمة أخرى`);
  await P.waitForSelector(`#sheet [data-k="importFor-${today}"][aria-pressed="true"]`);
  const checked = await P.evaluate(() => [...document.querySelectorAll('.import-item input')].map((x) => x.checked));
  assert(JSON.stringify(checked) === '[true,true]', 'both selected ' + JSON.stringify(checked));
  assert(await P.isVisible('#sheet [data-k="getShortcut"]'), 'shortcut button');
  await closeSheet(P);
});

await step('Shortcut link (#import=...) opens the import screen filled in', async () => {
  await P.evaluate(() => (location.hash = 'import=' + encodeURIComponent('10:00 من الاختصار')));
  await P.waitForSelector('#importText');
  assert((await P.inputValue('#importText')) === '10:00 من الاختصار', 'prefilled');
  assert(!(await P.evaluate(() => location.hash)).includes('import'), 'hash cleared');
  await closeSheet(P);
});

await step('Repeat daily: shows on the next days, each day keeps its own done state, syncs', async () => {
  await openTask(P, 'مكالمة');
  await P.click('#sheet [data-k="rep-daily"]');
  await P.waitForSelector('#sheet [data-k="rep-daily"][aria-pressed="true"]');
  await P.waitForTimeout(250);
  await P.screenshot({ path: `${shots}/repeat-iphone.png` });
  await closeSheet(P);
  assert((await row(P, 'مكالمة').locator('.rep-mark').count()) === 1, 'repeat mark today');
  await go(P, '#nextBtn');
  const r = row(P, 'مكالمة');
  await r.waitFor();
  assert((await r.locator('.task-time .start').textContent()) === '14:15', 'same time tomorrow');
  await r.locator('.check').click();
  await poll(async () => (await r.getAttribute('class')).includes('done'), 'tomorrow done');
  await go(P, '#nextBtn');
  await row(P, 'مكالمة').waitFor();
  assert(!(await row(P, 'مكالمة').getAttribute('class')).includes('done'), 'day after is independent');
  await go(P, '#todayBtn');
  assert(!(await row(P, 'مكالمة').getAttribute('class')).includes('done'), 'today unaffected');
  assert((await titles(P)).filter((x) => x === 'مكالمة').length === 1, 'no duplicate today');
  await go(L, '#nextBtn');
  await poll(async () => (await row(L, 'مكالمة').count()) === 1 && (await row(L, 'مكالمة').getAttribute('class')).includes('done'), 'laptop sees series and done', 25000);
  await go(L, '#todayBtn');
});

await step('Repeat on certain days, then stop it from a later day', async () => {
  await go(P, '#nextBtn');
  await go(P, '#nextBtn');
  await openTask(P, 'مكالمة');
  await P.click('#sheet [data-k="rep-days"]');
  await P.waitForSelector('#sheet .weekday-chips');
  assert((await P.locator('#sheet .weekday-chips .chip').count()) === 7, 'seven day toggles');
  await P.click('#sheet [data-k="delete"]');
  await P.click('#sheet [data-k="deleteFollowing"]');
  await P.waitForSelector('#sheetLayer', { state: 'hidden' });
  await poll(async () => (await row(P, 'مكالمة').count()) === 0, 'gone from this day');
  await go(P, '#nextBtn');
  assert((await row(P, 'مكالمة').count()) === 0, 'and the days after');
  await go(P, '#todayBtn');
  await go(P, '#nextBtn');
  await row(P, 'مكالمة').waitFor();
  await go(P, '#todayBtn');
  await row(P, 'مكالمة').waitFor();
});

await step('Copy a task to the next day', async () => {
  await openTask(P, 'قراءة كتاب');
  await P.click('#sheet [data-k="copyNext"]');
  await P.waitForSelector('#toast:not([hidden])');
  await closeSheet(P);
  await go(P, '#nextBtn');
  const r = row(P, 'قراءة كتاب');
  await r.waitFor();
  assert((await r.locator('.task-time .start').textContent()) === '14:00', 'copied with its time');
  await go(P, '#todayBtn');
  await row(P, 'قراءة كتاب').waitFor();
});

await step('Long press on a task asks, then deletes (with undo)', async () => {
  await addTask(P, 'للحذف بضغطة مطولة');
  const r = row(P, 'للحذف بضغطة مطولة');
  await r.waitFor();
  await P.evaluate(() => (document.getElementById('toast').hidden = true)); // an earlier notice could sit over the row
  await r.scrollIntoViewIfNeeded();
  const box = await r.locator('.task-title').boundingBox();
  await P.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await P.mouse.down();
  await P.waitForTimeout(750);
  await P.mouse.up();
  await P.waitForSelector('#sheet .confirm-delete');
  assert(await P.isHidden('#taskTitle'), 'the edit sheet did not open');
  await P.waitForTimeout(200);
  await P.screenshot({ path: `${shots}/long-press-delete-iphone.png` });
  await P.click('#sheet [data-k="deleteCancel"]');
  await P.waitForSelector('#sheetLayer', { state: 'hidden' });
  assert((await r.count()) === 1, 'cancel keeps it');
  await P.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await P.mouse.down();
  await P.waitForTimeout(750);
  await P.mouse.up();
  await P.click('#sheet [data-k="deleteOne"]');
  await poll(async () => (await r.count()) === 0, 'deleted');
  await P.click('#toast button');
  await r.waitFor();
  await P.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await P.mouse.down();
  await P.mouse.up();
  await P.waitForSelector('#taskTitle');
  await closeSheet(P);
});

await step('Light / dark switch, and a red delete button', async () => {
  await P.click('#settingsBtn');
  await P.click('#sheet [data-k="theme-dark"]');
  assert((await P.getAttribute('html', 'data-theme')) === 'dark', 'dark');
  await P.waitForTimeout(200);
  await P.screenshot({ path: `${shots}/settings-dark-iphone.png` });
  await P.click('#sheet [data-k="theme-light"]');
  assert((await P.getAttribute('html', 'data-theme')) === 'light', 'light');
  await P.click('#sheet [data-k="theme-auto"]');
  assert((await P.getAttribute('html', 'data-theme')) === null, 'auto');
  await closeSheet(P);
  await openTask(P, 'مكالمة');
  const color = await P.$eval('#sheet [data-k="delete"]', (el) => getComputedStyle(el).color);
  assert(/rgb\((19[0-9]|2\d\d), (\d{1,2}), /.test(color), 'red-ish: ' + color);
  await P.click('#sheet [data-k="time-start"]');
  assert(await P.isVisible('#sheet .picker-divider'), 'divider between hours and minutes');
  await closeSheet(P);
});

await step('12. Arabic RTL and English LTR', async () => {
  assert((await P.getAttribute('html', 'dir')) === 'rtl', 'rtl');
  await P.screenshot({ path: `${shots}/12-day-iphone-ar.png` });
  await P.click('#settingsBtn');
  await P.click('#sheet [data-k="lang-en"]');
  await closeSheet(P);
  assert((await P.getAttribute('html', 'dir')) === 'ltr', 'ltr');
  assert((await P.getAttribute('#newTask', 'placeholder')) === 'Add a task…', 'english placeholder');
  assert(await noHorizontalScroll(P), 'no horizontal scroll in English');
  await P.screenshot({ path: `${shots}/12-day-iphone-en.png` });
  await P.click('#settingsBtn');
  await P.click('#sheet [data-k="lang-ar"]');
  await closeSheet(P);
});

await step('13. Small iPhone, 320px, dark mode and laptop layouts', async () => {
  assert(await noHorizontalScroll(P), 'iPhone SE');
  const small = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  const sp = await small.newPage();
  await sp.goto('http://localhost:4173/');
  await sp.waitForSelector('#newTask');
  assert(await noHorizontalScroll(sp), '320px');
  await small.close();
  await P.emulateMedia({ colorScheme: 'dark' });
  await P.screenshot({ path: `${shots}/13-day-iphone-dark.png` });
  await P.click('#settingsBtn');
  await P.waitForTimeout(250);
  await P.screenshot({ path: `${shots}/13-settings-dark.png` });
  await closeSheet(P);
  await P.emulateMedia({ colorScheme: 'light' });
  const small2 = await P.evaluate(() =>
    [...document.querySelectorAll('#list .check, #newTask, #prevBtn, #nextBtn, #settingsBtn, .week-day')]
      .map((e) => [e.id || e.className, Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)])
      .filter(([, w, h]) => w < 40 || h < 40),
  );
  assert(small2.length === 0, `small tap targets: ${JSON.stringify(small2)}`);
  assert(await noHorizontalScroll(L), 'laptop');
  await L.screenshot({ path: `${shots}/13-day-laptop.png` });
});

await step('Laptop keyboard: n focuses the composer, arrows change day', async () => {
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

await step('Export a plain copy', async () => {
  await L.click('#settingsBtn');
  const [download] = await Promise.all([L.waitForEvent('download'), L.click('#sheet [data-k="export"]')]);
  assert(download.suggestedFilename().startsWith('pocket-time-'), 'file name');
  await closeSheet(L);
});

await step('Installable: manifest, icons and service worker are served', async () => {
  const m = await P.evaluate(() => fetch('manifest.webmanifest').then((r) => r.json()));
  assert(m.display === 'standalone' && m.icons.length >= 2, 'manifest');
  assert(await P.evaluate(() => fetch('apple-touch-icon.png').then((r) => r.ok)), 'apple icon');
});

await step('Inside claude.ai the same page syncs through the artifact database', async () => {
  const c = await device('http://localhost:4173', { viewport: { width: 390, height: 844 } }, '/claude.html');
  await c.page.waitForSelector('#newTask');
  await addTask(c.page, 'CLAUDE-SECRET');
  await poll(() => [...docs.keys()].some((k) => k.includes('/vault/b/')), 'stored in db');
  assert([...docs.keys()].includes('data/users/user-test-1/meta'), 'vault meta');
  assert(!JSON.stringify([...docs]).includes('CLAUDE-SECRET'), 'ciphertext only');
  await c.ctx.close();
});

await step('14. No notifications and no permission prompts', async () => {
  for (const d of [phone, laptop]) assert((await d.page.evaluate(() => window.__notif)) === 0, 'notification API touched');
});

await step('15. GitHub holds ciphertext only', async () => {
  const files = [...gh.files.entries()].map(([p, f]) => [p, Buffer.from(f.content, 'base64').toString()]);
  assert(files.length >= 2, 'files exist');
  const dump = JSON.stringify(files);
  for (const word of ['قراءة', 'رياضة', 'هدية', 'اللابتوب', '14:00', '20:30']) assert(!dump.includes(word), `plaintext found: ${word}`);
  for (const [path, text] of files) {
    const body = JSON.parse(text);
    if (path === 'pt/meta.json') assert(Object.keys(body).sort().join() === 'kid,v', 'meta shape');
    else assert(Object.keys(body).sort().join() === 'ct,iv,k,v', 'bucket shape ' + path);
  }
  assert(!dump.includes(TOKEN), 'token not stored in repo');
});

await step('Time box sheet (day/): same tasks in :00/:30 cells, tap a cell to add, priorities, timer, A4 print', async () => {
  await addTask(P, 'تمرين 07:00-08:00');
  await P.click('#viewLink');
  await P.waitForURL('**/day/');
  await P.waitForSelector('.tb');
  assert((await P.locator('.tb tbody tr').count()) === 24, '24 hours');
  const cell = (time) => P.locator(`.tb-cell button[data-start="${time}"]`);
  assert((await cell('07:00').textContent()).includes('تمرين'), 'task in its cell');
  assert(await P.locator('.tb-cell.filled button[data-start="07:30"]').count(), 'covered half hour filled');
  // Tap the empty 15:30 cell, then type: the task lands there.
  await cell('15:30').click();
  await poll(async () => (await P.getAttribute('#newTask', 'placeholder')).includes('15:30'), 'slot placeholder');
  await P.keyboard.type('مراجعة');
  await P.keyboard.press('Enter');
  await poll(async () => (await cell('15:30').textContent()).includes('مراجعة'), 'added in slot');
  await cell('07:00').click();
  await P.waitForSelector('#taskTitle');
  await closeSheet(P);
  // A top priority is a task without a time, marked with a star.
  await P.click('.prio-box >> nth=0');
  await P.keyboard.type('التقرير');
  await P.keyboard.press('Enter');
  await poll(async () => (await P.textContent('.prio-box >> nth=0')) === 'التقرير', 'priority');
  // Sleep hours fold into one row.
  await P.evaluate(() => localStorage.setItem('pt.sleep', '23:00-06:00'));
  await P.reload();
  await P.waitForSelector('.tb-sleep');
  assert((await P.locator('.tb tbody tr[data-hour]').count()) === 17, 'sleep folded');
  await P.click('.tb-sleep button >> nth=0');
  await P.click('#sheet [data-k="sleep-off"]');
  await closeSheet(P);
  await poll(async () => (await P.locator('.tb tbody tr[data-hour]').count()) === 24, 'sleep off');
  // Timer
  await P.click('.timer-go');
  assert(/^(29|30):\d\d$/.test(await P.textContent('#timerLeft')), 'countdown');
  await P.click('#timer .text-btn');
  await P.waitForSelector('.timer-go');
  assert(await noHorizontalScroll(P), 'no sideways scroll');
  await P.screenshot({ path: `${shots}/17-day-sheet-iphone.png` });
  await P.emulateMedia({ media: 'print' });
  assert(await P.isHidden('.composer'), 'print hides the app chrome');
  await P.emulateMedia({ media: 'screen' });
  await P.click('#viewLink');
  await row(P, 'مراجعة').waitFor();
  await row(P, '★ التقرير').waitFor();
});

await step('16. Only GitHub is contacted: no third parties, no errors, no task text in logs', async () => {
  for (const d of [phone, laptop]) {
    assert(d.external.length === 0, 'external: ' + d.external.join(', '));
    const real = d.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|net::ERR/.test(e));
    assert(real.length === 0, 'errors: ' + real.join(' | '));
    assert(!/قراءة|رياضة|هدية/.test(d.consoleText.join('\n')), 'task text in console');
  }
});

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
writeFileSync('e2e/results.json', JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
