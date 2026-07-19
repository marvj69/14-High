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

const context = vm.createContext({});
vm.runInContext(`
  ${extractFunction('calculateRoundPoints')}
  ${extractFunction('getRoundHistoryRows')}

  globalThis.roundHistory = {
    calculateRoundPoints,
    getRoundHistoryRows
  };
`, context);

const api = context.roundHistory;

assert.equal(api.calculateRoundPoints(0, 0), 10);
assert.equal(api.calculateRoundPoints(2, 2), 22);
assert.equal(api.calculateRoundPoints(2, 1), 1);
assert.equal(api.calculateRoundPoints(undefined, 1), null);

{
  const rows = api.getRoundHistoryRows({
    currentRound: 4,
    players: ['Ann', 'Bo', 'Cy'],
    bids: { Ann: 2, Bo: 0, Cy: 1 },
    tricks: { Ann: 2, Bo: 0, Cy: 2 },
    scores: { Ann: 10, Bo: 12, Cy: 5 }
  });

  assert.equal(JSON.stringify(rows), JSON.stringify([
    { player: 'Ann', bid: 2, tricks: 2, points: 22, totalScore: 32 },
    { player: 'Bo', bid: 0, tricks: 0, points: 10, totalScore: 22 },
    { player: 'Cy', bid: 1, tricks: 2, points: 2, totalScore: 7 }
  ]));
}

{
  const rows = api.getRoundHistoryRows({
    bids: { Ann: 1 },
    tricks: { Ann: 1 },
    scores: { Ann: 20 }
  });

  assert.equal(JSON.stringify(rows), JSON.stringify([
    { player: 'Ann', bid: 1, tricks: 1, points: 11, totalScore: 31 }
  ]));
}

console.log('Round history tests passed');
