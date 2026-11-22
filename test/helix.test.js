'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHelix, chunk } = require('../src/helix.js');
const { createAppToken } = require('../src/token.js');
const { shardsFromFile, scan } = require('../src/scan.js');

const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

// Fake Twitch: every login "uN" exists with id "N"; ids divisible by 10 are live;
// logins containing "bad" make /users answer 400 for the whole batch.
function fakeTwitch({ onRequest = () => {} } = {}) {
  const calls = { token: 0, users: 0, streams: 0, batchSizes: [] };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'id.twitch.tv') { calls.token++; return res(200, { access_token: 'tok' + calls.token, expires_in: 3600 }); }
    const early = onRequest(u, calls);
    if (early) return early;
    if (u.pathname.endsWith('/users')) {
      calls.users++;
      const logins = u.searchParams.getAll('login');
      calls.batchSizes.push(logins.length);
      if (logins.some((l) => l.includes('bad'))) return res(400, { message: 'Invalid login names' });
      return res(200, { data: logins.map((l) => ({ id: l.slice(1), login: l })) });
    }
    if (u.pathname.endsWith('/streams')) {
      calls.streams++;
      const ids = u.searchParams.getAll('user_id');
      calls.batchSizes.push(ids.length);
      return res(200, { data: ids.filter((id) => Number(id) % 10 === 0).map((id) => ({ user_id: id, user_login: 'u' + id })) });
    }
    return res(404, {});
  };
  return { fetchImpl, calls };
}

const opts = (fetchImpl, extra = {}) => Object.assign({ clientId: 'cid', clientSecret: 'sec', fetchImpl, maxRpm: 600000, wait: async () => {} }, extra);
const logins = (n) => Array.from({ length: n }, (_, i) => 'u' + (i + 1));

test('chunk splits into batches of 100', () => {
  assert.deepEqual(chunk(logins(250)).map((c) => c.length), [100, 100, 50]);
  assert.deepEqual(chunk([]), []);
});

test('usersByLogin and liveByIds batch 100 per request', async () => {
  const t = fakeTwitch();
  const h = createHelix(opts(t.fetchImpl));
  const users = await h.usersByLogin(logins(250));
  const live = await h.liveByIds(users.map((u) => u.id));
  assert.equal(users.length, 250);
  assert.equal(live.length, 25);
  assert.equal(t.calls.users, 3);
  assert.equal(t.calls.streams, 3);
  assert.ok(t.calls.batchSizes.every((n) => n <= 100));
});

test('a 400 batch is split until only the bad login is dropped', async () => {
  const t = fakeTwitch();
  const h = createHelix(opts(t.fetchImpl));
  const list = logins(100);
  list[37] = 'ubad';
  const users = await h.usersByLogin(list);
  assert.equal(users.length, 99);
  assert.ok(h.stats.split400 <= 8, `log2-ish splits, got ${h.stats.split400}`);
});

test('401 drops the cached token and mints once, then succeeds', async () => {
  let first = true;
  const t = fakeTwitch({ onRequest: () => { if (first) { first = false; return res(401, { message: 'invalid token' }); } } });
  const h = createHelix(opts(t.fetchImpl));
  const users = await h.usersByLogin(['u1']);
  assert.equal(users.length, 1);
  assert.equal(t.calls.token, 2);
  assert.equal(h.stats.remints, 1);
});

test('a second 401 in a row is an error, not a loop', async () => {
  const t = fakeTwitch({ onRequest: () => res(401, {}) });
  const h = createHelix(opts(t.fetchImpl));
  await assert.rejects(h.usersByLogin(['u1']), /401/);
});

test('429 waits until Ratelimit-Reset and retries', async () => {
  let clock = 1_000_000, waited = 0, n = 0;
  const t = fakeTwitch({ onRequest: () => { if (n++ === 0) return res(429, {}, { 'ratelimit-reset': String((clock + 5000) / 1000) }); } });
  const h = createHelix(opts(t.fetchImpl, { now: () => clock, wait: async (ms) => { waited += ms; clock += ms; } }));
  const users = await h.usersByLogin(['u1']);
  assert.equal(users.length, 1);
  assert.equal(h.stats.retries429, 1);
  assert.ok(waited >= 5000, `waited ${waited}ms`);
});

test('rate gate spaces request starts by 60000/maxRpm', async () => {
  // Three workers arrive at the same instant (clock frozen at 0): the first goes now,
  // the others are told to wait one and two gaps.
  const waits = [];
  const t = fakeTwitch();
  const h = createHelix(opts(t.fetchImpl, { maxRpm: 600, now: () => 0, wait: async (ms) => { waits.push(ms); } }));
  await Promise.all([h.liveByIds(['10']), h.liveByIds(['20']), h.liveByIds(['30'])]);
  assert.deepEqual(waits, [100, 200]);
});

test('token cache: reused while fresh, atomic file, re-minted near expiry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-'));
  const file = path.join(dir, 'tok.json');
  let clock = 1_000_000_000, mints = 0;
  const fetchImpl = async () => { mints++; return res(200, { access_token: 'a' + mints, expires_in: 3600 }); };
  const mk = () => createAppToken({ clientId: 'cid', clientSecret: 's', cacheFile: file, fetchImpl, now: () => clock });
  assert.equal(await mk().get(), 'a1');
  assert.equal(await mk().get(), 'a1');               // new process reads the file
  clock += (3600 - 200) * 1000;                       // inside the 5-minute skew
  assert.equal(await mk().get(), 'a2');
  fs.writeFileSync(file, '');                          // a 0-byte file is not trusted
  assert.equal(await mk().get(), 'a3');
  assert.ok(!fs.existsSync(file + '.tmp'));
});

test('scan streams a file in shards and reports live channels', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-'));
  const file = path.join(dir, 'logins.txt');
  fs.writeFileSync(file, logins(2500).join('\n') + '\nNot A Login!\nU5\n');
  const t = fakeTwitch();
  const h = createHelix(opts(t.fetchImpl));
  const live = [];
  const totals = await scan(h, shardsFromFile(file, 1000), { workers: 3, onLive: (s) => live.push(s.user_login) });
  assert.equal(totals.live, 250);
  assert.equal(live.length, 250);
  assert.equal(totals.checked, 2501); // junk line skipped; "U5" lowercased, counted again in its own shard
});
