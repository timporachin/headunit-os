/*
 * Life360.
 *
 * The only file in this app that knows Life360 exists. Everything above it
 * speaks the Member shape in providers/index.mjs, which is what lets a second
 * source replace this one without the screen changing.
 *
 * There is no public Life360 API. This talks to the private one their own apps
 * use, the same way every community client does, and it is worth being clear
 * about what that means: it is undocumented, unsupported, and Life360 have shut
 * third-party clients out before — Home Assistant removed its built-in
 * integration in 2024.2 for exactly that reason. Expect this to break someday.
 * When it does, the fix is a different provider, not a rewrite of the screen.
 *
 * Because it is their private API, this is a deliberately quiet client: one poll
 * a minute at most, a long backoff on 429 and 403, and no automatic location
 * requests — those buzz somebody's phone.
 */

const HOST = 'https://api-cloudfront.life360.com';

/* Published in every open-source Life360 client; it identifies the phone app,
 * not the user, and carries no account of ours. Their server rejects a request
 * without it. */
const CLIENT_TOKEN =
  'Y2F0aGFwYWNyQVBoZUtVc3RlOGV2ZXZldnVjSGFmZVRydVl1ZnJhYzpkOEM5ZVlVdkE2dUZ1YnJ1SmVnZXRyZVZ1dFJlQ1JVWQ==';

/* A default Node user-agent is the fastest way to a 403. */
const USER_AGENT = 'com.life360.android.safetymapd/KOKO/23.50.0 android/13';

const TIMEOUT_MS = 20_000;

export class AuthError extends Error {}
export class RateLimited extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/* Life360 sends booleans as the strings "0" and "1". */
const truthy = (value) => value === true || value === 1 || value === '1';

/**
 * One member, in this app's shape rather than Life360's.
 *
 * Speed is deliberately dropped. Life360 reports a `speed` field whose unit is
 * undocumented and which is frequently -1, and a wrong speed on a screen a
 * driver glances at is worse than no speed at all. `isDriving` is what the UI
 * shows instead, which is the part Life360 actually states.
 */
function toMember(raw) {
  const loc = raw.location || {};
  const name = [raw.firstName, raw.lastName].filter(Boolean).join(' ').trim();
  const address = [loc.address1, loc.address2].filter(Boolean).join(', ');

  return {
    id: String(raw.id ?? ''),
    name: name || 'Unknown',
    avatarUrl: raw.avatar || null,
    lat: numberOrNull(loc.latitude),
    lon: numberOrNull(loc.longitude),
    accuracy: numberOrNull(loc.accuracy),
    // `name` is a named place ("Home"); the street address is the fallback.
    address: loc.name || address || null,
    // Their timestamps are unix seconds; everything above this line uses ms.
    since: numberOrNull(loc.timestamp) === null ? null : numberOrNull(loc.timestamp) * 1000,
    battery: numberOrNull(loc.battery),
    charging: truthy(loc.charge),
    speed: null,
    isDriving: truthy(loc.isDriving) || truthy(loc.inTransit),
    wifi: truthy(loc.wifiState),
  };
}

export function createLife360Provider() {
  let authorization = null;

  async function call(path, { method = 'GET', body = null, auth = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${HOST}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'cache-control': 'no-cache',
          'user-agent': USER_AGENT,
          authorization: auth || authorization || '',
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError'
        ? `Life360 did not answer within ${TIMEOUT_MS / 1000}s`
        : `Could not reach Life360: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) {
      throw new AuthError('Life360 rejected the saved sign-in. Sign in again.');
    }
    // 403 here is usually Cloudflare rather than Life360 itself, and it means
    // back off rather than that the credentials are wrong.
    if (res.status === 429 || res.status === 403) {
      throw new RateLimited(
        res.status === 429
          ? 'Life360 is rate limiting this account.'
          : 'Life360 refused the request, which usually means it wants a pause.',
        res.status,
      );
    }
    if (!res.ok) throw new Error(`Life360 answered ${res.status} ${res.statusText}`);

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // An HTML body here is a Cloudflare interstitial, not an API response.
      throw new RateLimited('Life360 returned a challenge page instead of data.', res.status);
    }
  }

  return {
    id: 'life360',
    label: 'Life360',
    canRequestUpdate: true,

    /** True once there is something to call the API with. */
    get authenticated() { return Boolean(authorization); },

    /** Restore a token saved from a previous run. */
    restore(token) {
      authorization = token ? (/^\w+ /.test(token) ? token : `Bearer ${token}`) : null;
    },

    forget() { authorization = null; },

    /**
     * Sign in and return the token to store. The password is used here and
     * nowhere else — it is never returned, saved or logged.
     *
     * Username and password only works for accounts WITHOUT a verified phone
     * number. Life360 rejects the password grant outright for accounts that
     * have one, which is why the token path exists and why the setup screen
     * explains both.
     */
    async authenticate({ mode, username, password, token }) {
      if (mode === 'token') {
        if (!token) throw new AuthError('Paste the LIFE360_AUTH_TOKEN cookie value.');
        const candidate = /^\w+ /.test(token) ? token : `Bearer ${token}`;
        // Prove it works before saving it, so a bad paste fails at the form.
        await call('/v3/users/me', { auth: candidate });
        authorization = candidate;
        return candidate;
      }

      if (!username || !password) throw new AuthError('Both the email and the password are needed.');

      let reply;
      try {
        reply = await call('/v3/oauth2/token', {
          method: 'POST',
          auth: `Basic ${CLIENT_TOKEN}`,
          body: new URLSearchParams({ grant_type: 'password', username, password }).toString(),
        });
      } catch (err) {
        if (err instanceof RateLimited) throw err;
        throw new AuthError(
          `Life360 would not accept that sign-in. If this account has a verified phone `
          + `number, the password will not work here — use the access token instead. (${err.message})`,
        );
      }

      if (!reply?.access_token) {
        throw new AuthError('Life360 accepted the request but returned no token.');
      }
      authorization = `${reply.token_type || 'Bearer'} ${reply.access_token}`;
      return authorization;
    },

    async listCircles() {
      const reply = await call('/v4/circles');
      return (reply?.circles || []).map((c) => ({ id: String(c.id), name: c.name || 'Circle' }));
    },

    async listMembers(circleId) {
      const reply = await call(`/v3/circles/${encodeURIComponent(circleId)}/members`);
      return (reply?.members || []).map(toMember);
    },

    /** Ask a phone to report in. This rings their device, so it is manual only. */
    async requestUpdate(circleId, memberId) {
      await call(
        `/v3/circles/${encodeURIComponent(circleId)}/members/${encodeURIComponent(memberId)}/request`,
        { method: 'POST', body: new URLSearchParams({ type: 'location' }).toString() },
      );
    },
  };
}
