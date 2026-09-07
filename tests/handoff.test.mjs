import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `Expected to find function ${name}`);

  const bodyStart = html.indexOf('{', start);
  let depth = 0;

  for (let index = bodyStart; index < html.length; index++) {
    const char = html[index];
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth === 0) return html.slice(start, index + 1);
  }

  throw new Error(`Could not extract function ${name}`);
}

const context = vm.createContext({
  URL,
  window: { location: { href: 'https://example.com/14-High/' } },
  LZString: {
    compressToEncodedURIComponent(value) {
      return encodeURIComponent(value);
    },
    decompressFromEncodedURIComponent(value) {
      return decodeURIComponent(value);
    }
  }
});

vm.runInContext(readFileSync(join(__dirname, '..', 'vendor/lz-string.min.js'), 'utf8'), context);

vm.runInContext(`
  const MAX_PLAYERS = 56;
  const HANDOFF_COMPRESSED_PREFIX = '14HIGHZ:';
  ${extractFunction('handoffChecksum')}
  ${extractFunction('buildHandoffQRFrames')}
  ${extractFunction('collectHandoffQRFrame')}
  ${extractFunction('getDefaultOfflineState')}
  ${extractFunction('getMinimalHandoffState')}
  ${extractFunction('parseCompressedHandoffState')}
  ${extractFunction('parseHandoffImportText')}
  ${extractFunction('getImportParamFromText')}
  ${extractFunction('normalizeImportedGameState')}

  globalThis.handoff = {
    buildHandoffQRFrames,
    collectHandoffQRFrame,
    parseCompressedHandoffState,
    parseHandoffImportText,
    normalizeImportedGameState,
    getMinimalHandoffState
  };
`, context);

const api = context.handoff;
const sampleState = {
  players: ['Ann', 'Bo'],
  gameStarted: true,
  currentRound: 5,
  dealerIndex: 1,
  bids: { Ann: 2 },
  tricks: { Bo: 3 },
  scores: { Ann: 32, Bo: 28 },
  bidPhase: false,
  eliminatedPlayers: ['Cy'],
  roundHistory: [{
    currentRound: 4,
    players: ['Ann', 'Bo'],
    bids: { Ann: 2, Bo: 1 },
    tricks: { Ann: 2, Bo: 2 },
    scores: { Ann: 10, Bo: 12 }
  }]
};
const compressed = context.LZString.compressToEncodedURIComponent(JSON.stringify(sampleState));

{
  const parsed = api.parseHandoffImportText(`https://example.com/14-High/?import=${encodeURIComponent(compressed)}`);
  assert.equal(JSON.stringify(parsed), JSON.stringify(sampleState));
}

{
  const parsed = api.parseHandoffImportText(`14HIGHZ:${compressed}`);
  assert.equal(JSON.stringify(parsed), JSON.stringify(sampleState));
}

{
  const parsed = api.parseHandoffImportText(`14HIGH:${JSON.stringify(sampleState)}`);
  assert.equal(JSON.stringify(parsed), JSON.stringify(sampleState));
}

{
  const normalized = api.normalizeImportedGameState(sampleState);
  assert.deepEqual(Array.from(normalized.players), ['Ann', 'Bo']);
  assert.equal(normalized.gameStarted, true);
  assert.equal(normalized.currentRound, 5);
  assert.equal(normalized.dealerIndex, 1);
  assert.equal(normalized.bidPhase, false);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.scores)), sampleState.scores);
  assert.equal(JSON.stringify(normalized.roundHistory), JSON.stringify(sampleState.roundHistory));
}

{
  const minimal = api.getMinimalHandoffState(sampleState);
  assert.equal(JSON.stringify(minimal.roundHistory), JSON.stringify(sampleState.roundHistory));
}

{
  assert.throws(
    () => api.parseHandoffImportText('not a handoff payload'),
    /Not a 14-High game QR code/
  );
}

console.log('Handoff QR tests passed');

// Use the actual bundled compressor, including Unicode player names and history.
const largeState = { ...sampleState, players: ['Ånn 🎴', 'Bo'], roundHistory: Array.from({ length: 14 }, (_, i) => ({
  currentRound: i + 1, players: ['Ånn 🎴', 'Bo'], bids: { 'Ånn 🎴': i % 3, Bo: i % 4 },
  tricks: { 'Ånn 🎴': i % 2, Bo: i % 5 }, scores: { 'Ånn 🎴': i * 12, Bo: i * 7 }
})) };
const raw = '14HIGHZ:' + context.LZString.compressToEncodedURIComponent(JSON.stringify(largeState));
const frames = api.buildHandoffQRFrames(raw);
assert.ok(frames.length > 1);
assert.ok(frames.every(frame => frame.length <= 550));
const transfer = {};
assert.equal(api.collectHandoffQRFrame(frames[0], transfer).received, 1);
assert.equal(api.collectHandoffQRFrame(frames[0], transfer).received, 1, 'Duplicates do not advance progress');
for (const frame of Array.from(frames).reverse()) {
  const result = api.collectHandoffQRFrame(frame, transfer);
  if (result.payload) assert.deepEqual(JSON.parse(JSON.stringify(api.parseHandoffImportText(result.payload))), largeState);
}
assert.equal(transfer.parts.size, frames.length);
const corrupt = {};
assert.throws(() => {
  for (const frame of frames) api.collectHandoffQRFrame(frame.slice(0, -1) + '!', corrupt);
}, /Could not combine/);
assert.throws(() => api.collectHandoffQRFrame('14HIGHQ:1:12345678:0:2:abc', {}), /Invalid/);
assert.throws(() => api.collectHandoffQRFrame('14HIGHQ:1:12345678:1:129:abc', {}), /Invalid/);
assert.equal(api.buildHandoffQRFrames('x'.repeat(64001)).length, 0);
const small = '14HIGHZ:' + compressed;
assert.equal(api.collectHandoffQRFrame(small, {}).payload, small);
const otherFrames = api.buildHandoffQRFrames(raw + 'different');
api.collectHandoffQRFrame(otherFrames[0], transfer);
assert.equal(transfer.parts.size, 1, 'A different snapshot resets incomplete transfer');
