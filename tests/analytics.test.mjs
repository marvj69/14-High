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

  const signatureEnd = html.indexOf(')', start);
  const bodyStart = html.indexOf('{', signatureEnd);
  let depth = 0;

  for (let index = bodyStart; index < html.length; index++) {
    const char = html[index];
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth === 0) return html.slice(start, index + 1);
  }

  throw new Error(`Could not extract function ${name}`);
}

assert.match(
  html,
  /https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-553V1C3J93/,
  'Expected the production GA4 tag'
);
assert.match(html, /allow_google_signals:\s*false/);
assert.match(html, /allow_ad_personalization_signals:\s*false/);

const calls = [];
const context = vm.createContext({
  window: {
    gtag(...args) {
      calls.push(args);
    }
  }
});

vm.runInContext(`
  ${extractFunction('getSafeAnalyticsParams')}
  ${extractFunction('trackAnalyticsEvent')}

  globalThis.analytics = {
    getSafeAnalyticsParams,
    trackAnalyticsEvent
  };
`, context);

const api = context.analytics;
const unsafeParams = {
  player_count: 4,
  round_number: 7,
  qr_available: true,
  transfer_method: 'qr',
  import_source: 'paste',
  player_name: 'Private Player',
  bids: { PrivatePlayer: 2 },
  scores: { PrivatePlayer: 32 },
  transfer_payload: 'private-game-state',
  transfer_method_invalid: 'email'
};

assert.equal(api.trackAnalyticsEvent('round_recorded', unsafeParams), true);
assert.equal(calls.length, 1);
assert.equal(JSON.stringify(calls[0]), JSON.stringify([
  'event',
  'round_recorded',
  {
    player_count: 4,
    round_number: 7,
    qr_available: true,
    transfer_method: 'qr',
    import_source: 'paste'
  }
]));
assert.equal(api.trackAnalyticsEvent('Invalid Event Name', {}), false);
assert.equal(calls.length, 1);

const eventNames = Array.from(
  html.matchAll(/trackAnalyticsEvent\('([a-z0-9_]+)'/g),
  match => match[1]
);

for (const expected of [
  'game_started',
  'round_recorded',
  'game_completed',
  'game_reset',
  'round_undone',
  'handoff_export_opened',
  'handoff_imported'
]) {
  assert.ok(eventNames.includes(expected), `Expected ${expected} analytics event`);
}

console.log('Analytics tests passed');
