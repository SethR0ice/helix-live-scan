'use strict';
// Twitch app access token (client_credentials). These tokens have NO refresh_token:
// they are minted again, never refreshed. The cache is trusted only until 5 minutes
// before its stated expiry, and invalidate() lets a caller drop a token that Twitch
// rejected early (revoked, secret rotated, minted again somewhere else).

const fs = require('fs');
const path = require('path');

const SKEW_S = 300;

function createAppToken({ clientId, clientSecret, cacheFile = null, fetchImpl = globalThis.fetch, now = Date.now }) {
  if (!clientId || !clientSecret) throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are required');
  let mem = null;

  function readCache() {
    if (mem) return mem;
    if (!cacheFile) return null;
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // A 0-byte or half-written file parses as an error and falls through to a fresh mint.
      return c && c.access_token && c.client_id === clientId ? c : null;
    } catch { return null; }
  }
  const fresh = (c) => c && (c.obtained_at + c.expires_in - SKEW_S) * 1000 > now();

  async function get() {
    const c = readCache();
    if (fresh(c)) { mem = c; return c.access_token; }
    const res = await fetchImpl('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new Error(`token mint failed: HTTP ${res.status}`);
    mem = { access_token: body.access_token, expires_in: body.expires_in || 0, obtained_at: Math.floor(now() / 1000), client_id: clientId };
    if (cacheFile) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(mem), { mode: 0o600 });
      fs.renameSync(tmp, cacheFile); // atomic: a crash never leaves a 0-byte token file
    }
    return mem.access_token;
  }

  function invalidate() {
    mem = null;
    if (cacheFile) { try { fs.unlinkSync(cacheFile); } catch { /* already gone */ } }
  }

  return { get, invalidate };
}

module.exports = { createAppToken };
