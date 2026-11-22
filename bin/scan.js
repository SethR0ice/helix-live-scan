#!/usr/bin/env node
'use strict';
// Usage:
//   TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... node bin/scan.js logins.txt > live.jsonl
// One login per line. Live streams are written to stdout as JSON lines; progress to stderr.

const path = require('path');
const os = require('os');
const { createHelix } = require('../src/helix.js');
const { shardsFromFile, scan } = require('../src/scan.js');

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node bin/scan.js <logins.txt>'); process.exit(2); }
  const helix = createHelix({
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    tokenCacheFile: process.env.HELIX_TOKEN_CACHE || path.join(os.homedir(), '.cache', 'helix-live-scan', 'app-token.json'),
    maxRpm: Number(process.env.HELIX_MAX_RPM || 700),
  });
  const t0 = Date.now();
  const totals = await scan(helix, shardsFromFile(file, Number(process.env.SHARD_SIZE || 10_000)), {
    workers: Number(process.env.WORKERS || 4),
    onLive: (s) => process.stdout.write(JSON.stringify({ login: s.user_login, title: s.title, game: s.game_name, viewers: s.viewer_count, started_at: s.started_at }) + '\n'),
    onProgress: (t) => process.stderr.write(`\rchecked ${t.checked}  live ${t.live}  requests ${helix.stats.requests}   `),
  });
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`\ndone in ${s}s: ${JSON.stringify({ ...totals, ...helix.stats })}\n`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
