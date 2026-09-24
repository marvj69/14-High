import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '..', 'app.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Expected to find function ${name}`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract function ${name}`);
}

function extractConst(name) {
  const start = source.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `Expected to find const ${name}`);
  return source.slice(start, source.indexOf(';\n', start) + 1);
}

const storage = new Map();
const fakeLocalStorage = {
  mode: 'ok',
  getItem(key) { if (this.mode === 'blocked') throw new Error('SecurityError'); return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) {
    if (this.mode === 'blocked') throw new Error('SecurityError');
    if (this.mode === 'full') throw Object.assign(new Error('full'), { name: 'QuotaExceededError', code: 22 });
    storage.set(key, String(value));
  },
  removeItem(key) { if (this.mode === 'blocked') throw new Error('SecurityError'); storage.delete(key); }
};

const context = vm.createContext({
  URL, URLSearchParams, console: { warn() {}, error() {}, log() {} }, localStorage: fakeLocalStorage,
  window: { location: { href: 'https://14-high.vercel.app/' } }
});
vm.runInContext(readFileSync(join(__dirname, '..', 'vendor/lz-string.min.js'), 'utf8'), context);
vm.runInContext(`
  const MAX_PLAYERS = 56;
  const LOCAL_STORAGE_HISTORY_KEY = 'completedGames';
  const HANDOFF_COMPRESSED_PREFIX = '14HIGHZ:';
  let localHistory = [];
  ${extractConst('HANDOFF_MAX_COMPRESSED_LENGTH')}
  ${extractConst('HANDOFF_MAX_JSON_LENGTH')}
  ${extractConst('MAX_ROUND_HISTORY')}
  ${extractConst('LZ_URI_SAFE_VALUES')}
  ${[
    'readStorage', 'isQuotaError', 'writeStorage', 'readStoredJSON', 'isReservedKey', 'isPlainObject',
    'isHandCount', 'isScoreValue', 'sanitizePlayerNames', 'sanitizeValueMap', 'normalizeDealerIndex',
    'copyOwnFields', 'sanitizeRoundEntry', 'sanitizeRoundHistory', 'sanitizeGameState', 'sanitizeCompletedGame',
    'decompressHandoffData', 'parseCompressedHandoffState', 'parseHandoffImportText', 'getImportParamFromText',
    'normalizeImportedGameState', 'getDefaultOfflineState', 'escapeHtml', 'calculateRoundPoints',
    'getRoundHistoryRows', 'renderRoundHistory', 'getWinners', 'getSortedPlayers', 'renderGameplay',
    'dropOldestRoundDetails', 'persistHistory'
  ].map(extractFunction).join('\n')}
  globalThis.api = {
    readStorage, writeStorage, readStoredJSON, sanitizeGameState, sanitizeCompletedGame, decompressHandoffData,
    parseCompressedHandoffState, parseHandoffImportText, normalizeImportedGameState, renderGameplay, persistHistory,
    setHistory: games => { localHistory = games; }, getHistory: () => localHistory
  };
`, context);
const api = context.api;
const LZString = context.LZString;
const plain = value => JSON.parse(JSON.stringify(value));

// --- Guarded decompression is byte-for-byte LZString below the cap ---------------------
{
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const samples = [];
  for (let i = 0; i < 300; i++) {
    const length = Math.floor(random() * 400);
    samples.push(Array.from({ length }, () => String.fromCharCode(random() < 0.8 ? 32 + Math.floor(random() * 95) : Math.floor(random() * 0xd7ff))).join(''));
  }
  samples.push('', 'a', JSON.stringify({ players: ['Ånn 🎴', 'Bo'], scores: { 'Ånn 🎴': 1 } }), 'x'.repeat(5000));
  for (const text of samples) {
    const compressed = LZString.compressToEncodedURIComponent(text);
    assert.equal(api.decompressHandoffData(compressed), LZString.decompressFromEncodedURIComponent(compressed));
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$ ?#';
  for (let i = 0; i < 1500; i++) {
    const garbage = Array.from({ length: 1 + Math.floor(random() * 60) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    let expected, actual;
    try { expected = { value: LZString.decompressFromEncodedURIComponent(garbage) }; } catch (err) { expected = { error: true }; }
    try { actual = { value: api.decompressHandoffData(garbage) }; } catch (err) { actual = { error: true }; }
    assert.deepEqual(actual, expected, `garbage input ${JSON.stringify(garbage)}`);
  }
}

// --- A tiny link cannot expand into a huge string ----------------------------------------
{
  const bomb = LZString.compressToEncodedURIComponent('a'.repeat(3000000));
  assert.ok(bomb.length < 20000, 'fixture is a small link');
  const started = Date.now();
  assert.throws(() => api.decompressHandoffData(bomb), /too large/);
  assert.throws(() => api.parseCompressedHandoffState(bomb), /too large/);
  assert.ok(Date.now() - started < 2000, 'rejected quickly');
  assert.throws(() => api.parseCompressedHandoffState('A'.repeat(200001)), /too large/);
}

// --- Imported/saved games are sanitized ---------------------------------------------------
const xss = '<img src=x onerror=alert(1)>';
const hostile = {
  players: ['Ann', 'Bo', 'Ann', ' ', '__proto__', 'constructor', 'Cy'],
  gameStarted: true,
  currentRound: '99',
  dealerIndex: 7,
  bids: JSON.parse(`{"Ann": ${JSON.stringify(xss)}, "Bo": 2, "Cy": 1.5, "__proto__": 3}`),
  tricks: { Ann: -1, Bo: 15, Cy: 3 },
  scores: { Ann: xss, Bo: 20, Cy: Infinity },
  bidPhase: 'yes',
  eliminatedPlayers: ['Dee', { toString: null }, 'Dee', '__proto__', 7],
  extra: 'dropped',
  roundHistory: [
    null,
    'bad',
    { currentRound: 3, players: ['Ann', 'Bo', 'constructor'], bids: { Ann: xss, Bo: 1 }, tricks: { Bo: 1 }, scores: { Ann: xss, Bo: 11 }, gameStarted: true, dealerIndex: 'x' },
    ...Array.from({ length: 20 }, (_, i) => ({ currentRound: (i % 14) + 1, bids: {}, tricks: {}, scores: {} }))
  ]
};
{
  const state = plain(api.sanitizeGameState(JSON.parse(JSON.stringify(hostile))));
  assert.deepEqual(state.players, ['Ann', 'Bo', 'Cy']);
  assert.equal(state.currentRound, 15);
  assert.equal(state.dealerIndex, 1);
  assert.deepEqual(state.bids, { Bo: 2 });
  assert.deepEqual(state.tricks, { Cy: 3 });
  assert.deepEqual(state.scores, { Bo: 20 });
  assert.equal(state.bidPhase, true);
  assert.deepEqual(state.eliminatedPlayers, ['Dee', '7'], 'objects (even ones that cannot become strings) are dropped');
  assert.equal('extra' in state, false);
  assert.equal(state.roundHistory.length, 14);
  assert.ok(!JSON.stringify(state).includes('onerror'), 'no hostile values survive');
}
{
  const entry = plain(api.sanitizeGameState({ players: ['Ann', 'Bo'], gameStarted: true, roundHistory: hostile.roundHistory.slice(0, 3) }).roundHistory[0]);
  assert.deepEqual(entry, { currentRound: 3, players: ['Ann', 'Bo'], bids: { Bo: 1 }, tricks: { Bo: 1 }, scores: { Bo: 11 }, gameStarted: true });
}
{
  const game = plain(api.sanitizeCompletedGame({ date: '2026-01-01T00:00:00Z', winners: [xss, 'Bo'], score: xss, players: ['Bo'], finalScores: { Bo: 5, Ann: xss }, roundHistory: 'x' }));
  assert.equal(game.score, 0);
  assert.deepEqual(game.finalScores, { Bo: 5 });
  assert.deepEqual(game.winners, [xss, 'Bo'], 'names are kept and escaped when rendered');
  assert.equal('roundHistory' in game, false);
  assert.equal(api.sanitizeCompletedGame('nope'), null);
}
{
  assert.throws(() => api.normalizeImportedGameState({ players: 'Ann', gameStarted: true }), /Invalid game data/);
  assert.throws(() => api.normalizeImportedGameState({ players: ['__proto__', 'Ann'], gameStarted: true }), /at least 2 players/);
  const hashLink = `https://14-high.vercel.app/#import=${LZString.compressToEncodedURIComponent(JSON.stringify({ players: ['Ann', 'Bo'], gameStarted: true }))}`;
  assert.deepEqual(plain(api.parseHandoffImportText(hashLink).players), ['Ann', 'Bo'], 'new #import= links');
  const link = `https://14-high.vercel.app/?import=${LZString.compressToEncodedURIComponent(JSON.stringify(hostile))}`;
  const imported = plain(api.normalizeImportedGameState(api.parseHandoffImportText(link)));
  assert.ok(!JSON.stringify(imported).includes('onerror'));
}

// --- Rendering escapes even unsanitized values (defense in depth) --------------------------
{
  const raw = {
    players: ['Ann', 'Bo'], eliminatedPlayers: ['Cy'], gameStarted: true, currentRound: 3, dealerIndex: 0, bidPhase: false,
    bids: { Ann: xss, Bo: 1, Cy: xss }, tricks: { Ann: xss, Cy: xss }, scores: { Ann: xss, Bo: 2, Cy: xss },
    roundHistory: [{ currentRound: 1, players: ['Ann', 'Bo'], bids: { Ann: xss }, tricks: { Ann: xss }, scores: { Ann: xss } }]
  };
  for (const state of [raw, { ...raw, bidPhase: true }, { ...raw, currentRound: 15 }]) {
    const html = api.renderGameplay(state);
    assert.ok(!html.includes('<img'), 'no raw tag from game data');
    assert.ok(html.includes('&lt;img'), 'value is shown as text');
  }
}

// --- Storage failures never throw -----------------------------------------------------------
{
  fakeLocalStorage.mode = 'blocked';
  assert.equal(api.readStorage('x'), null);
  assert.equal(api.readStoredJSON('x'), null);
  assert.deepEqual(plain(api.writeStorage('x', '1')), { saved: false, full: false });
  fakeLocalStorage.mode = 'ok';
  storage.set('corrupt', '{not json');
  assert.equal(api.readStoredJSON('corrupt'), null);
  fakeLocalStorage.mode = 'full';
  assert.deepEqual(plain(api.writeStorage('x', '1')), { saved: false, full: true });
  fakeLocalStorage.mode = 'ok';
}

// --- A full disk trims old round details instead of losing the newest game -----------------
{
  const games = [1, 2, 3].map(n => ({ date: `2026-0${n}-01`, winners: ['A'], score: n, roundHistory: [{ currentRound: 1, bids: {}, tricks: {}, scores: {} }] }));
  api.setHistory(games);
  let failures = 2;
  const original = fakeLocalStorage.setItem;
  fakeLocalStorage.setItem = function (key, value) {
    if (failures-- > 0) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    return original.call(this, key, value);
  };
  assert.equal(api.persistHistory(), true);
  fakeLocalStorage.setItem = original;
  const saved = JSON.parse(storage.get('completedGames'));
  assert.equal(saved.length, 3);
  assert.equal('roundHistory' in saved[0], false);
  assert.equal('roundHistory' in saved[1], false);
  assert.ok(Array.isArray(saved[2].roundHistory), 'newest game keeps its details');
}

console.log('Security tests passed');
