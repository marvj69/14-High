// UI regression checks in Chromium (see README): dialogs, focus and input handling.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:8014/';

const browser = await chromium.launch({ headless: true });
async function openApp(path = '') {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1024, height: 900 } });
  await context.route(/googletagmanager\.com|google-analytics\.com/, route => route.abort());
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push(error.message));
  page.dialogs = [];
  page.on('dialog', dialog => { page.dialogs.push(dialog.message()); dialog.type() === 'confirm' && page.cancelConfirm ? dialog.dismiss() : dialog.accept(); });
  await page.goto(baseURL + path, { waitUntil: 'load' });
  return { context, page, problems };
}
async function addPlayers(page, names) {
  for (const name of names) { await page.fill('#player-name', name); await page.press('#player-name', 'Enter'); }
}

try {
  // A typed but not yet added name survives moving/removing players.
  {
    const { context, page, problems } = await openApp();
    await page.click('#select-offline-btn');
    await addPlayers(page, ['Ann', 'Bo', 'Cy']);
    await page.fill('#player-name', 'Dee');
    await page.click('.btn-move-up[data-player="Bo"]');
    assert.equal(await page.inputValue('#player-name'), 'Dee');
    await page.click('.btn-remove[data-player="Cy"]');
    assert.equal(await page.inputValue('#player-name'), 'Dee');
    await page.press('#player-name', 'Enter');
    assert.equal(await page.inputValue('#player-name'), '', 'adding still clears the field');
    assert.deepEqual(problems, []);
    await context.close();
  }

  // Selecting text in a dialog and releasing over the backdrop keeps it open; a real backdrop click closes it.
  {
    const { context, page, problems } = await openApp();
    await page.click('#handoff-import-btn');
    await page.waitForSelector('#handoff-paste-input');
    await page.fill('#handoff-paste-input', 'some pasted data');
    const box = await page.locator('#handoff-paste-input').boundingBox();
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(5, 5, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.locator('#handoff-import-modal').evaluate(el => el.classList.contains('active')), true);
    assert.equal(await page.inputValue('#handoff-paste-input'), 'some pasted data');
    await page.mouse.click(5, 5);
    assert.equal(await page.locator('#handoff-import-modal').evaluate(el => el.classList.contains('active')), false);
    // Escape closes the dialogs too.
    await page.click('#handoff-import-btn');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#handoff-import-modal').evaluate(el => el.classList.contains('active')), false);
    assert.deepEqual(problems, []);
    await context.close();
  }

  // A bad import link is shown once and removed from the address bar.
  {
    const { context, page, problems } = await openApp('?import=not-valid');
    assert.equal(new URL(page.url()).search, '');
    assert.ok((await page.locator('#handoff-import-banner').innerText()).length > 0);
    assert.deepEqual(problems, []);
    await context.close();
  }

  // Cancel on the game-over "leave" prompt asks only once; the menu's Back item works from the keyboard.
  {
    const { context, page, problems } = await openApp();
    await page.evaluate(() => localStorage.setItem('offlineGameState', JSON.stringify({
      players: ['Ann', 'Bo'], gameStarted: true, currentRound: 15, dealerIndex: 0, bids: {}, tricks: {},
      scores: { Ann: 40, Bo: 40 }, bidPhase: true, eliminatedPlayers: [], roundHistory: []
    })));
    await page.reload();
    await page.click('#select-offline-btn');
    page.cancelConfirm = true;
    await page.click('#back-to-menu-btn');
    assert.equal(page.dialogs.length, 1, 'one confirm per click');
    const medals = await page.$$eval('.winner-row .fa-medal', icons => icons.map(i => i.getAttribute('style')));
    assert.deepEqual(medals, ['color: #d4af37;', 'color: #d4af37;'], 'both tied winners get gold');
    page.cancelConfirm = false;
    await page.click('.hamburger-btn');
    await page.waitForTimeout(400); // drawer slide-in
    await page.focus('#menu-back-button');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#select-offline-btn').count(), 1, 'back on the start screen');
    assert.deepEqual(problems, []);
    await context.close();
  }

  // Closing game details fades the filled card out instead of collapsing it first.
  {
    const { context, page, problems } = await openApp();
    await page.evaluate(() => localStorage.setItem('completedGames', JSON.stringify([
      { mode: 'offline', date: '2026-08-01T19:30:00.000Z', winners: ['Bo'], score: 50, players: ['Ann', 'Bo'], finalScores: { Ann: 40, Bo: 50 }, eliminatedPlayers: [] }
    ])));
    await page.reload();
    await page.click('.hamburger-btn');
    await page.click('.completed-game-item');
    await page.click('#game-details-close');
    assert.ok((await page.locator('#game-details-body').innerHTML()).length > 0, 'content stays during the fade');
    await page.waitForFunction(() => document.getElementById('game-details-body').innerHTML === '');
    assert.deepEqual(problems, []);
    await context.close();
  }
  console.log('PASS: typed names, dialog backdrop/Escape, bad links, single confirm, tie medals and details fade behave correctly.');
} finally {
  await browser.close();
}
