'use strict';
// Who in a (possibly huge) list of Twitch logins is live right now?
//
// Memory stays flat however long the list is: logins are streamed from disk in
// shards (default 10,000), each shard is resolved to user ids and checked, results
// are emitted, and the shard is dropped. An earlier design loaded multi-million-line
// source files whole and was killed by the OOM killer; sharding fixed it.

const fs = require('fs');
const readline = require('readline');

const LOGIN_RE = /^[a-z0-9_]{1,25}$/;

async function* shardsFromFile(file, size = 10_000) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let shard = [];
  const seen = new Set(); // dedupe within a shard; cross-shard dupes cost one extra lookup, not memory
  for await (const line of rl) {
    const login = line.trim().toLowerCase();
    if (!LOGIN_RE.test(login) || seen.has(login)) continue; // skip junk before it costs a request
    seen.add(login);
    shard.push(login);
    if (shard.length >= size) { yield shard; shard = []; seen.clear(); }
  }
  if (shard.length) yield shard;
}

// Runs `workers` shards at once. Every request still passes the shared rate gate in
// helix.js, so more workers fill the budget better without exceeding it.
async function scan(helix, shards, { workers = 4, onLive = () => {}, onProgress = () => {} } = {}) {
  const totals = { checked: 0, resolved: 0, live: 0 };
  const it = shards[Symbol.asyncIterator] ? shards[Symbol.asyncIterator]() : shards[Symbol.iterator]();
  async function worker() {
    for (;;) {
      const next = await it.next();
      if (next.done) return;
      const logins = next.value;
      const users = await helix.usersByLogin(logins);
      const live = await helix.liveByIds(users.map((u) => u.id));
      totals.checked += logins.length;
      totals.resolved += users.length;
      totals.live += live.length;
      for (const s of live) onLive(s);
      onProgress({ ...totals });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, workers) }, worker));
  return totals;
}

module.exports = { shardsFromFile, scan, LOGIN_RE };
