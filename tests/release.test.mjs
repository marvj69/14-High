// Guards the deploy configuration: an edit that breaks one of these would ship
// a blank page (CSP) or a stale/mixed offline cache (versions).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');
const html = read('index.html');
const offline = read('offline.html');
const sw = read('service-worker.js');
const vercel = JSON.parse(read('vercel.json'));

const globalHeaders = vercel.headers.find(rule => rule.source === '/(.*)').headers;
const header = name => (globalHeaders.find(h => h.key.toLowerCase() === name.toLowerCase()) || {}).value;
const csp = header('Content-Security-Policy');
assert.ok(csp, 'CSP header is configured');
const directive = name => (csp.split(';').map(d => d.trim()).find(d => d.startsWith(`${name} `)) || '');

// Every inline script must be allowed by hash (editing one requires updating vercel.json).
for (const [file, text] of [['index.html', html], ['offline.html', offline]]) {
  for (const match of text.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (/\ssrc=/.test(match[1] || '')) continue;
    const hash = `'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`;
    assert.ok(directive('script-src').includes(hash), `${file}: inline script needs ${hash} in the CSP script-src`);
  }
  assert.doesNotMatch(text, /<[^>]+\son[a-z]+\s*=/i, `${file}: inline event handler attributes are blocked by the CSP`);
  assert.doesNotMatch(text, /javascript:/i, `${file}: javascript: URLs are blocked by the CSP`);
}
assert.doesNotMatch(directive('script-src'), /'unsafe-inline'|'unsafe-eval'/);
assert.match(directive('object-src'), /'none'/);
assert.match(directive('frame-ancestors'), /'none'/);
assert.match(directive('base-uri'), /'self'/);
assert.match(header('Permissions-Policy'), /camera=\(self\)/, 'the QR scanner needs the camera');
assert.equal(header('X-Content-Type-Options'), 'nosniff');
assert.equal(header('X-Frame-Options'), 'DENY');

// Only same-origin assets (plus the Google tag) are loaded by the page.
for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
  const url = match[1];
  if (/^https?:/.test(url)) {
    assert.match(url, /^https:\/\/www\.googletagmanager\.com\//, `unexpected third-party asset ${url}`);
  } else {
    assert.ok(existsSync(join(root, url.split('?')[0])), `referenced file ${url} exists`);
  }
}

// One version everywhere: badge, cache name, and the cache-busting query strings.
const version = (sw.match(/const APP_VERSION = '([\d.]+)'/) || [])[1];
assert.ok(version, 'service worker declares APP_VERSION');
assert.ok(html.includes(`<span>v${version}</span>`), `version badge shows v${version}`);
const versioned = [...html.matchAll(/(?:src|href)="([^"]+\?v=([^"]+))"/g)];
assert.ok(versioned.some(([, url]) => url.startsWith('app.js?')), 'app.js is versioned');
for (const [, url, v] of versioned) assert.equal(v, version, `${url} uses the current version`);
// Every precached file exists, and every script the page loads is precached.
const precache = [...sw.matchAll(/^\s+[`']\.\/([^`'\n]*)[`'],?$/gm)].map(m => m[1].replace('${APP_VERSION}', version));
for (const entry of precache) {
  if (entry === '') continue;
  assert.ok(existsSync(join(root, entry.split('?')[0])), `precached ${entry} exists`);
}
for (const match of html.matchAll(/<script src="([^"]+)"/g)) {
  assert.ok(precache.includes(match[1]), `${match[1]} is precached`);
}

// Scripts loaded on demand use the same version and are precached for offline use.
const appSource = read('app.js');
assert.equal((appSource.match(/const APP_VERSION = '([\d.]+)'/) || [])[1], version, 'app.js APP_VERSION matches');
const lazyScripts = [...appSource.matchAll(/loadScriptOnce\(`([^`]+)`\)/g)].map(m => m[1].replace('${APP_VERSION}', version));
assert.ok(lazyScripts.length > 0, 'the QR scanner is loaded on demand');
for (const path of lazyScripts) assert.ok(precache.includes(path), `${path} is precached`);

// Development-only files are not deployed.
const ignored = read('.vercelignore').split('\n').map(l => l.trim());
assert.ok(ignored.includes('tests'), 'tests are not deployed');

console.log('Release config tests passed');
