// Run against a local server with Playwright installed (see README).
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:8014/';
const artifacts = process.env.TEST_ARTIFACTS || join(tmpdir(), '14-high-qr-tests');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const state = {
  players: ['Ann 🎴', 'Bo', 'Cy', 'Dee'], gameStarted: true, currentRound: 5,
  dealerIndex: 2, bids: { 'Ann 🎴': 2, Bo: 1 }, tricks: { Bo: 3 },
  scores: { 'Ann 🎴': 32, Bo: 28, Cy: -20, Dee: 44 }, bidPhase: false,
  eliminatedPlayers: ['Cy'],
  roundHistory: Array.from({ length: 4 }, (_, i) => ({
    players: ['Ann 🎴', 'Bo', 'Cy', 'Dee'], currentRound: i + 1, dealerIndex: i,
    bids: { 'Ann 🎴': i % 2, Bo: 0, Cy: 1, Dee: 0 },
    tricks: { 'Ann 🎴': i % 3, Bo: 1, Cy: 0, Dee: 0 },
    scores: { 'Ann 🎴': i * 10, Bo: i * 7, Cy: i === 0 ? 0 : -i * 5, Dee: i * 11 },
    bidPhase: false, gameStarted: true, eliminatedPlayers: []
  }))
};
try {
  const senderContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // Keep test runs out of the production analytics property.
  await senderContext.route(/googletagmanager\.com|google-analytics\.com/, route => route.abort());
  const sender = await senderContext.newPage();
  sender.on('pageerror', error => errors.push(error.message));
  await sender.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await sender.evaluate(state => {
    localStorage.setItem('offlineGameState', JSON.stringify(state));
    selectMode('offline');
    applyTheme('dark');
  }, state);
  await sender.getByRole('button', { name: 'Hand-off via QR' }).click();
  await sender.locator('.handoff-qr-image').waitFor();
  await sender.screenshot({ animations: 'disabled', path: join(artifacts, 'export-dark-mobile.png') });
  const images = await sender.evaluate(() => {
    const handoff = buildHandoffPayload(offlineState);
    return buildHandoffQRFrames(handoff.rawPayload).map(text => {
      const div = document.createElement('div');
      renderHandoffQRCode(div, text);
      return div.firstChild.toDataURL('image/png');
    });
  });
  assert.ok(images.length > 1, 'Fixture exercises multipart QR transfer');
  await sender.getByRole('button', { name: 'Close hand-off QR', exact: true }).click();

  const receiverContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await receiverContext.route(/googletagmanager\.com|google-analytics\.com/, route => route.abort());
  // Only replace the camera hardware. Production QR renderer, video scanner,
  // decoder, frame collection, import, persistence and UI all run unchanged.
  await receiverContext.addInitScript(images => {
    window.testCameraStreams = [];
    window.testCameraTracks = [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.testCameraConstraints = constraints;
      const loaded = await Promise.all(images.map(src => new Promise(resolve => {
        const image = new Image(); image.onload = () => resolve(image); image.src = src;
      })));
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 960;
      const ctx = canvas.getContext('2d');
      let frame = 0;
      const draw = () => {
        ctx.fillStyle = '#333'; ctx.fillRect(0, 0, 1280, 960);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(loaded[frame++ % loaded.length], 290, 130, 700, 700);
      };
      draw();
      const timer = setInterval(draw, 1100);
      const stream = canvas.captureStream(15);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
      }
      window.testCameraStreams.push(stream);
      window.testCameraTracks.push(...stream.getTracks());
      return stream;
    };
  }, images);
  const receiver = await receiverContext.newPage();
  receiver.on('pageerror', error => errors.push(error.message));
  receiver.on('console', message => { if (message.type() === 'warning') console.log('Browser warning:', message.text()); });
  await receiver.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await receiver.evaluate(() => {
    window.testImports = 0;
    const original = trackAnalyticsEvent;
    trackAnalyticsEvent = (name, params) => { if (name === 'handoff_imported') window.testImports++; original(name, params); };
  });
  const originalURL = receiver.url();
  await receiver.getByRole('button', { name: 'Import from QR', exact: false }).click();
  await receiver.waitForFunction(() => window.testImports === 1, null, { timeout: 20000 }).catch(async err => {
    await receiver.screenshot({ path: join(artifacts, 'scanner-failure.png') });
    console.error(await receiver.evaluate(() => ({ status: document.getElementById('handoff-import-status').textContent,
      imports: window.testImports, videos: Array.from(document.querySelectorAll('video')).map(v => ({ width: v.videoWidth, height: v.videoHeight, paused: v.paused })),
      tracks: window.testCameraStreams.map(s => s.getTracks().map(t => t.readyState)) })));
    throw err;
  });
  await receiver.waitForFunction(() => window.testCameraTracks.every(track => track.readyState === 'ended'));
  assert.equal(receiver.url(), originalURL);
  assert.equal(receiverContext.pages().length, 1);
  assert.deepEqual(await receiver.evaluate(() => JSON.parse(localStorage.getItem('offlineGameState'))), state);
  assert.equal(await receiver.locator('#handoff-import-modal').evaluate(el => el.classList.contains('active')), false);
  assert.ok(await receiver.getByText('Round 5', { exact: false }).count() > 0);
  await receiver.screenshot({ path: join(artifacts, 'imported-mobile.png') });

  // Reopen and close repeatedly, including while the camera is starting.
  for (let i = 0; i < 3; i++) {
    await receiver.evaluate(() => { showHandoffImportModal(); document.getElementById('handoff-import-close').click(); });
  }
  await receiver.evaluate(() => handoffScannerCleanup);
  assert.equal(await receiver.evaluate(() => window.testImports), 1);
  assert.ok(await receiver.evaluate(() => window.testCameraTracks.every(t => t.readyState === 'ended')));

  // Installed/offline app shell and local scanner libraries remain available.
  await receiver.evaluate(() => navigator.serviceWorker.ready);
  await receiver.waitForFunction(() => navigator.serviceWorker.controller);
  await receiverContext.setOffline(true);
  await receiver.reload({ waitUntil: 'domcontentloaded' });
  await receiver.getByRole('button', { name: 'Import from QR', exact: false }).click();
  await receiver.waitForFunction(() => document.getElementById('handoff-import-banner').textContent.includes('Game imported successfully'));
  await receiver.waitForFunction(() => window.testCameraTracks.every(t => t.readyState === 'ended'));
  assert.deepEqual(await receiver.evaluate(() => JSON.parse(localStorage.getItem('offlineGameState'))), state);
  assert.equal(receiver.url(), originalURL);
  assert.equal(receiverContext.pages().length, 1);
  // Closing during a pending permission request must stop the late stream,
  // then allow a new scanner session to own the reader.
  await receiver.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let first = true;
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (first) {
        first = false;
        await new Promise(resolve => { window.releaseTestCamera = resolve; });
      }
      return original(constraints);
    };
    showHandoffImportModal();
  });
  await receiver.waitForFunction(() => typeof window.releaseTestCamera === 'function');
  await receiver.evaluate(() => {
    document.getElementById('handoff-import-close').click();
    showHandoffImportModal();
    window.releaseTestCamera();
  });
  await receiver.waitForFunction(() => window.testCameraStreams.length >= 3);
  await receiver.waitForFunction(() => !document.getElementById('handoff-import-modal').classList.contains('active'));
  await receiver.waitForFunction(() => window.testCameraTracks.every(t => t.readyState === 'ended'), null, { timeout: 10000 }).catch(async err => {
    console.error('LATE CAMERA', await receiver.evaluate(() => ({ status: document.getElementById('handoff-import-status').textContent,
      tracks: window.testCameraStreams.map(s => s.getTracks().map(t => t.readyState)) })));
    throw err;
  });

  // Denied camera access leaves a working in-app paste fallback. Invalid data
  // must leave the previous game untouched and keep the dialog usable.
  await receiver.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Camera access denied', 'NotAllowedError'); };
    showHandoffImportModal();
  });
  await receiver.waitForFunction(() => document.getElementById('handoff-import-status').textContent.includes('Camera unavailable'));
  await receiver.getByLabel('Paste hand-off import link or data').fill('unrelated QR data');
  await receiver.getByRole('button', { name: 'Import Pasted Data' }).click();
  assert.deepEqual(await receiver.evaluate(() => JSON.parse(localStorage.getItem('offlineGameState'))), state);
  assert.equal(await receiver.locator('#handoff-import-modal').evaluate(el => el.classList.contains('active')), true);
  const oldLink = await sender.evaluate(() => buildHandoffPayload(offlineState).importUrl);
  await receiver.getByLabel('Paste hand-off import link or data').fill(oldLink);
  await receiver.getByRole('button', { name: 'Import Pasted Data' }).click();
  assert.deepEqual(await receiver.evaluate(() => JSON.parse(localStorage.getItem('offlineGameState'))), state);
  assert.equal(receiver.url(), originalURL);
  assert.equal(await receiver.locator('#handoff-import-modal').evaluate(el => el.classList.contains('active')), false);
  assert.deepEqual(errors, []);
  console.log(`PASS: ${images.length} real QR frames decoded through video; exact game/history imported in place; camera cleanup and offline re-import passed. Artifacts: ${artifacts}`);
} finally {
  await browser.close();
}
