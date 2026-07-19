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

vm.runInContext(`
  const MAX_PLAYERS = 56;
  const HANDOFF_COMPRESSED_PREFIX = '14HIGHZ:';
  ${extractFunction('getDefaultOfflineState')}
  ${extractFunction('getMinimalHandoffState')}
  ${extractFunction('parseCompressedHandoffState')}
  ${extractFunction('parseHandoffImportText')}
  ${extractFunction('getImportParamFromText')}
  ${extractFunction('normalizeImportedGameState')}

  globalThis.handoff = {
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
const compressed = encodeURIComponent(JSON.stringify(sampleState));

{
  const parsed = api.parseHandoffImportText(`https://example.com/14-High/?import=${compressed}`);
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
