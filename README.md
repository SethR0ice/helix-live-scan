# helix-live-scan

Find out which channels in a long list of Twitch logins are live right now, using the Twitch Helix API, without tripping rate limits and with flat memory however long the list is.

```bash
TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... node bin/scan.js logins.txt > live.jsonl
# checked 2500  live 31  requests 50
# done in 6.2s: {"checked":2500,"resolved":2471,"live":31,"requests":50,...}
```

Zero dependencies. Node 18+. You need a Twitch application (client id and secret) from the Twitch developer console; the scan uses an app access token, no user login.

## Why it exists

This is the reusable core of a scanner I run for my Twitch community tools. In its biggest run it checked **10,900,852 channels and found 114,889 live (1.1%)**. Helix allows 100 names per request and roughly 800 requests a minute per application, so at that size every wasted request, retry storm, or crash matters.

## Run it

```bash
npm test                                   # 9 tests against a fake Helix, no network
node bin/scan.js logins.txt > live.jsonl   # one login per line
```

Environment variables: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` (required); `HELIX_MAX_RPM` (default 700), `WORKERS` (4), `SHARD_SIZE` (10000), `HELIX_TOKEN_CACHE` (token cache path).

As a library:

```js
const { createHelix } = require('helix-live-scan');
const helix = createHelix({ clientId, clientSecret, tokenCacheFile: '.cache/token.json' });
const users = await helix.usersByLogin(['some_login', 'another_login']);
const live = await helix.liveByIds(users.map((u) => u.id));
```

## The interesting parts

**Pace requests instead of reacting to 429s.** Backing off only after a 429 stalls whole workers. `helix.js` spaces request *start times* by `60000 / maxRpm` ms through one shared gate, so several concurrent workers share one budget and stay under the limit. If a 429 still happens, it waits until Twitch's own `Ratelimit-Reset` time instead of guessing.

**An app token can die before its stated expiry.** App tokens (`client_credentials`) have no refresh token; they are minted again, never refreshed. A cached token that claimed 4.3 days of life left was already returning 401 at Twitch, and because the code trusted the cache, it failed **320 of 476 shards** in one run. Now a 401 drops the cached token and mints exactly once; a second 401 is a real error instead of a loop. The cache is written atomically (temp file + rename), because a half-written token file once made a worker fail silently; a 0-byte or unreadable cache is now treated as missing.

**One bad name should not cost 99 good ones.** Helix rejects a whole `/users` batch with HTTP 400 if any login in it is invalid. This version splits a failed batch in half until the bad login is isolated, which takes about log2(100) = 7 splits (roughly 14 extra requests) instead of losing the batch. Lines that cannot be Twitch logins are filtered before they cost a request at all.

**Flat memory.** The first design loaded multi-million-line source files whole and was killed by the out-of-memory killer. `scan.js` streams the file with `readline`, groups it into shards of 10,000 logins, resolves and checks each shard, emits results, and drops it.

## Files

| File | What |
|---|---|
| `src/token.js` | App token mint, file cache with 5-minute expiry margin, atomic writes, `invalidate()` |
| `src/helix.js` | Rate gate, 401 re-mint, 429 wait, 400 batch split, `usersByLogin()`, `liveByIds()` |
| `src/scan.js` | Streams a login file in shards and runs workers |
| `bin/scan.js` | Command line tool: JSON lines of live streams to stdout |

## Stack

Node.js (built-in `fetch`, `readline`, `node:test`), Twitch Helix API (`/users`, `/streams`, OAuth client credentials).

## License

MIT
