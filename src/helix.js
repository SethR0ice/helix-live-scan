'use strict';
// Small Twitch Helix client for bulk work: batches of 100, a proactive rate gate,
// one re-mint on 401, waits out 429 using Twitch's own Ratelimit-Reset header, and
// splits a batch that Twitch rejects (HTTP 400) to find the one bad name.

const { createAppToken } = require('./token.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(list, size = 100) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return list.length ? out : [];
}

class HelixError extends Error {
  constructor(status, msg) { super(`Helix HTTP ${status}: ${msg}`); this.status = status; }
}

function createHelix({
  clientId, clientSecret, token = null, tokenCacheFile = null,
  maxRpm = 700,                // Twitch allows ~800 points/min per app; stay under it
  maxRetries = 4,
  fetchImpl = globalThis.fetch, now = Date.now, wait = sleep,
} = {}) {
  token = token || createAppToken({ clientId, clientSecret, cacheFile: tokenCacheFile, fetchImpl, now });
  const minGap = Math.ceil(60_000 / maxRpm);
  let nextSlot = 0;
  let pausedUntil = 0;
  const stats = { requests: 0, retries429: 0, remints: 0, split400: 0 };

  // Spaces request START times, so N concurrent workers still share one budget.
  // Pacing below the limit avoids 429s instead of reacting to them.
  async function gate() {
    const t = now();
    const slot = Math.max(t, nextSlot, pausedUntil);
    nextSlot = slot + minGap;
    if (slot > t) await wait(slot - t);
  }

  async function get(pathname, params) {
    let reminted = false;
    for (let attempt = 0; ; attempt++) {
      await gate();
      stats.requests++;
      const res = await fetchImpl(`https://api.twitch.tv/helix/${pathname}?${params}`, {
        headers: { 'Client-ID': clientId, Authorization: `Bearer ${await token.get()}` },
      });
      if (res.ok) return res.json();
      // A cached app token can die long before its stated expiry. Mint once, then give up.
      if (res.status === 401 && !reminted) { reminted = true; stats.remints++; token.invalidate(); continue; }
      if (res.status === 429 && attempt < maxRetries) {
        stats.retries429++;
        const reset = Number(res.headers.get('ratelimit-reset')) * 1000; // epoch seconds
        pausedUntil = Math.max(pausedUntil, reset > now() ? reset + 250 : now() + 60_000);
        continue;
      }
      const body = await res.text().catch(() => '');
      throw new HelixError(res.status, body.slice(0, 200));
    }
  }

  // GET /users?login=... in batches of 100. A 400 means at least one login in the batch
  // is not a valid name; split the batch in half until the bad one is isolated, instead
  // of dropping 99 good names with it.
  async function usersByLogin(logins) {
    const out = [];
    const run = async (batch) => {
      const p = new URLSearchParams();
      for (const l of batch) p.append('login', l);
      try {
        const j = await get('users', p);
        out.push(...(j.data || []));
      } catch (e) {
        if (e.status !== 400) throw e;
        if (batch.length === 1) return; // the bad one
        stats.split400++;
        const mid = batch.length >> 1;
        await run(batch.slice(0, mid));
        await run(batch.slice(mid));
      }
    };
    for (const b of chunk(logins)) await run(b);
    return out;
  }

  // GET /streams?user_id=... in batches of 100. Only live channels come back.
  async function liveByIds(ids) {
    const out = [];
    for (const b of chunk(ids)) {
      const p = new URLSearchParams({ first: '100' });
      for (const id of b) p.append('user_id', id);
      const j = await get('streams', p);
      out.push(...(j.data || []));
    }
    return out;
  }

  return { get, usersByLogin, liveByIds, stats };
}

module.exports = { createHelix, chunk, HelixError };
