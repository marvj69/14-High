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
  const ELIMINATION_THRESHOLD = 56;
  ${extractFunction('getMaxPlayersForRound')}
  ${extractFunction('calculateEliminationPlan')}
  ${extractFunction('getUpcomingEliminationPlan')}

  globalThis.elimination = {
    getMaxPlayersForRound,
    calculateEliminationPlan,
    getUpcomingEliminationPlan
  };
`, context);

const api = context.elimination;

function hostArray(value) {
  return Array.from(value);
}

function makePlayers(count) {
  return Array.from({ length: count }, (_, index) => `P${String(index + 1).padStart(2, '0')}`);
}

function makeState(count, round, scores = {}) {
  const players = makePlayers(count);
  return {
    gameStarted: true,
    currentRound: round,
    players,
    scores: Object.fromEntries(players.map((player, index) => [player, scores[player] ?? index]))
  };
}

{
  const plan = api.calculateEliminationPlan(makeState(56, 2));
  assert.equal(plan.maxPlayers, 28);
  assert.equal(plan.count, 28);
  assert.deepEqual(hostArray(plan.players), makePlayers(28));
}

{
  const scores = Object.fromEntries(makePlayers(29).map(player => [player, 100]));
  scores.P17 = -5;
  const plan = api.calculateEliminationPlan(makeState(29, 2, scores));
  assert.equal(plan.count, 1);
  assert.deepEqual(hostArray(plan.players), ['P17']);
}

{
  const scores = Object.fromEntries(makePlayers(20).map(player => [player, 10]));
  const plan = api.calculateEliminationPlan(makeState(20, 3, scores));
  assert.equal(plan.maxPlayers, 18);
  assert.equal(plan.count, 2);
  assert.deepEqual(hostArray(plan.players), ['P01', 'P02']);
}

{
  const plan = api.calculateEliminationPlan(makeState(28, 2));
  assert.equal(plan.count, 0);
  assert.deepEqual(hostArray(plan.players), []);
}

{
  const upcoming = api.getUpcomingEliminationPlan(makeState(40, 1));
  assert.equal(upcoming.round, 2);
  assert.equal(upcoming.maxPlayers, 28);
  assert.equal(upcoming.count, 12);
}

{
  const upcoming = api.getUpcomingEliminationPlan(makeState(4, 14));
  assert.equal(upcoming, null);
}

console.log('Elimination tests passed');
