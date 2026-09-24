// Hostile-input checks against the real app in Chromium (see README).
// Serve the repo with the vercel.json headers applied to also check the CSP.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:8014/';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const lz = vm.createContext({});
vm.runInContext(readFileSync(join(root, 'vendor/lz-string.min.js'), 'utf8'), lz);
const compress = value => vm.runInContext(`LZString.compressToEncodedURIComponent(${JSON.stringify(JSON.stringify(value))})`, lz);

const payload = '<img src=x onerror="window.pwned=1">';
const hostileGame = {
  players: ['Ann', payload, 'Bo'], gameStarted: true, currentRound: 3, dealerIndex: 0, bidPhase: true,
  bids: { Ann: payload, Bo: 1 }, tricks: {}, scores: { Ann: payload, Bo: 12, [payload]: 3 },
  eliminatedPlayers: ['Cy', { toString: null }],
  roundHistory: [{ currentRound: 1, players: ['Ann', 'Bo'], bids: { Ann: payload, Bo: 0 }, tricks: { Ann: 1, Bo: 0 }, scores: { Ann: payload, Bo: 0 } }]
};

const browser = await chromium.launch({ headless: true });
async function openApp(init, path = '') {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route(/googletagmanager\.com|google-analytics\.com/, route => route.abort());
  if (init) await context.addInitScript(init.fn, init.arg);
  await context.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', e => window.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push(error.message));
  page.dialogs = [];
  page.on('dialog', dialog => { page.dialogs.push(dialog.message()); dialog.accept(); });
  await page.goto(baseURL + path, { waitUntil: 'load' });
  return { context, page, problems };
}
async function assertSafe(page, problems, label) {
  assert.equal(await page.evaluate(() => window.pwned), undefined, `${label}: injected script did not run`);
  assert.equal(await page.locator('#app img, #game-details-body img, #completed-games-list img').count(), 0, `${label}: no injected elements`);
  assert.deepEqual(await page.evaluate(() => window.cspViolations), [], `${label}: no CSP violations`);
  assert.deepEqual(problems, [], `${label}: no page errors`);
}

try {
  // 1. A crafted hand-off link imports only validated data and renders names as text.
  {
    const { context, page, problems } = await openApp(null, `?import=${compress(hostileGame)}`);
    await page.waitForSelector('.bid-input');
    await assertSafe(page, problems, 'import link');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('offlineGameState')));
    assert.deepEqual(saved.players, ['Ann', payload, 'Bo']);
    assert.deepEqual(saved.scores, { Bo: 12, [payload]: 3 });
    assert.deepEqual(saved.bids, { Bo: 1 });
    assert.deepEqual(saved.eliminatedPlayers, ['Cy']);
    assert.ok((await page.locator('#app').innerText()).includes(payload), 'the name is shown literally');
    await context.close();
  }

  // 2. A booby-trapped save from an older version (never validated) is neutralized at startup.
  {
    const { context, page, problems } = await openApp({
      fn: ([game, payloadText]) => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('offlineGameState', JSON.stringify(game));
        localStorage.setItem('completedGames', JSON.stringify([{ date: '2026-01-01T00:00:00Z', winners: [payloadText], score: payloadText,
          players: ['Ann'], finalScores: { Ann: payloadText }, eliminatedPlayers: [{ toString: null }], roundHistory: game.roundHistory }]));
      }, arg: [hostileGame, payload]
    });
    await page.click('#select-offline-btn');
    await page.waitForSelector('.bid-input');
    await page.click('.hamburger-btn');
    await page.click('.completed-game-item');
    await page.waitForSelector('#game-details-modal.active');
    await assertSafe(page, problems, 'old save');
    await context.close();
  }

  // 3. Corrupt history and blocked storage do not stop the app.
  {
    const { context, page, problems } = await openApp({ fn: () => { localStorage.setItem('completedGames', '{not json'); } });
    assert.ok((await page.locator('#completed-games-list').textContent()).includes('No completed games yet'));
    await assertSafe(page, problems, 'corrupt history');
    await context.close();
  }
  {
    const { context, page, problems } = await openApp({ fn: () => {
      for (const method of ['getItem', 'setItem', 'removeItem']) {
        Storage.prototype[method] = () => { throw new DOMException('Blocked', 'SecurityError'); };
      }
    } });
    await page.click('#select-offline-btn');
    for (const name of ['Ann', 'Bo']) { await page.fill('#player-name', name); await page.press('#player-name', 'Enter'); }
    await page.click('#start-game-btn');
    await page.waitForSelector('.bid-input');
    await assertSafe(page, problems, 'blocked storage');
    await context.close();
  }

  // 4. Names with quotes/backslashes keep keyboard entry working; reserved names are refused.
  {
    const { context, page, problems } = await openApp(null);
    await page.click('#select-offline-btn');
    for (const name of ['a"b\\', "o'neil", '__proto__']) { await page.fill('#player-name', name); await page.press('#player-name', 'Enter'); }
    assert.ok(page.dialogs.some(message => message.includes("can't be used as a player name")));
    assert.equal(await page.locator('.player-item').count(), 2);
    await page.click('#start-game-btn');
    const inputs = page.locator('.bid-input');
    await inputs.nth(0).fill('0'); await inputs.nth(0).press('Enter');
    await inputs.nth(1).fill('0'); await inputs.nth(1).press('Enter');
    await page.waitForSelector('.trick-input');
    const focused = await page.evaluate(() => document.activeElement.className);
    assert.equal(focused, 'trick-input', 'Enter on the last bid moves on to hands won');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.trick-input')), true,
      'focus starts at the first player');
    await assertSafe(page, problems, 'quoted names');
    await context.close();
  }
  console.log('PASS: hostile links, old saves, corrupt/blocked storage and quoted names are handled safely with no CSP violations.');
} finally {
  await browser.close();
}
