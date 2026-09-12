/*
 * The Family app's own server.
 *
 * It exists because the browser cannot do this job: Life360 sends no
 * access-control-allow-origin at all, so a page can never call it directly.
 * Everything that touches a credential or a location service happens here, and
 * the page only ever sees the normalised result.
 *
 * Two rules shape the whole file.
 *
 * ONE. A secret is never printed. The shell's supervisor pipes this process's
 * stdout and stderr into a ring buffer that the Settings screen renders on the
 * dashboard, so a stray console.log of a token would put it on the windscreen.
 * Every line out of here goes through redact(), and the token is never
 * interpolated into one in the first place.
 *
 * TWO. Be a quiet client. One poll a minute at most, however many times the page
 * asks; a long backoff when told to slow down; and no automatic location
 * requests, because those ring somebody's phone.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createProvider, AuthError, RateLimited } from './providers/index.mjs';
import { createRedactor } from './redact.mjs';
import { createBackoff } from './backoff.mjs';

const DIR = import.meta.dirname;
const WEB = path.join(DIR, 'web');
const SECRETS_FILE = path.join(DIR, 'secrets.json');
const PORT = Number(process.env.PORT) || 4300;

const MIN_POLL_MS = 60_000;
const CIRCLES_TTL_MS = 6 * 60 * 60_000;
const REQUEST_THROTTLE_MS = 2 * 60_000;
const STALE_MS = 30 * 60_000;

/* ── Redaction and backoff, both policies of their own ──────── */
const { guard, release, redact } = createRedactor();
const backoff = createBackoff();

const log = (...parts) => console.log(redact(parts.join(' ')));
const warn = (...parts) => console.warn(redact(parts.join(' ')));

/* ── State ──────────────────────────────────────────────────── */
const state = {
  providerId: 'life360',
  circleId: null,
  circles: [],
  circlesFetchedAt: 0,
  members: [],
  lastUpdate: null,
  problem: '',
};

let provider = createProvider(state.providerId);
let inFlight = null;
const lastRequestAt = new Map();

/* ── Secrets on disk ────────────────────────────────────────── */
async function saveSecrets(data) {
  const body = JSON.stringify(data, null, 2);
  await writeFile(SECRETS_FILE, body, { mode: 0o600 });
  // The mode option only applies when the file is created, so an existing file
  // keeps whatever it had. Set it explicitly every time.
  await chmod(SECRETS_FILE, 0o600).catch(() => { /* not POSIX; nothing to do */ });
}

async function loadSecrets() {
  try {
    return JSON.parse(await readFile(SECRETS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function clearSecrets() {
  await unlink(SECRETS_FILE).catch(() => { /* already gone */ });
}

/* ── Polling ────────────────────────────────────────────────── */
function noteFailure(err) {
  if (err instanceof RateLimited) {
    const minutes = backoff.fail();
    state.problem = `${err.message} Waiting ${minutes} minute${minutes === 1 ? '' : 's'} before trying again.`;
    warn(`[family] backing off ${minutes}m:`, err.message);
    return;
  }
  if (err instanceof AuthError) {
    state.problem = err.message;
    warn('[family] auth:', err.message);
    return;
  }
  state.problem = err.message;
  warn('[family]', err.message);
}

async function doRefresh() {
  if (!provider.authenticated) return;

  if (!state.circles.length || Date.now() - state.circlesFetchedAt > CIRCLES_TTL_MS) {
    state.circles = await provider.listCircles();
    state.circlesFetchedAt = Date.now();
    if (!state.circles.some((c) => c.id === state.circleId)) {
      state.circleId = state.circles[0]?.id ?? null;
    }
  }
  if (!state.circleId) {
    state.members = [];
    state.problem = 'This account is not in any circle.';
    return;
  }

  state.members = await provider.listMembers(state.circleId);
  state.lastUpdate = Date.now();
  state.problem = '';
  backoff.reset();
}

/**
 * Refresh if it is time to. Every caller shares one upstream request: the page
 * polls this, and so would a second page, but Life360 only ever sees one.
 */
async function refresh({ force = false } = {}) {
  if (!provider.authenticated) return;
  if (backoff.blocked()) return;
  if (!force && state.lastUpdate && Date.now() - state.lastUpdate < MIN_POLL_MS) return;
  if (inFlight) return inFlight;

  inFlight = doRefresh()
    .catch(noteFailure)
    .finally(() => { inFlight = null; });
  return inFlight;
}

/* ── The public view ────────────────────────────────────────── */
/* Whatever else changes here, a credential must never enter this object. */
function publicState() {
  return {
    provider: provider.id,
    providerLabel: provider.label,
    synthetic: provider.synthetic === true,
    canRequestUpdate: provider.canRequestUpdate === true,
    authenticated: provider.authenticated,
    circles: state.circles,
    circleId: state.circleId,
    members: state.members.map((m) => ({
      ...m,
      stale: m.since === null ? true : Date.now() - m.since > STALE_MS,
    })),
    lastUpdate: state.lastUpdate,
    problem: state.problem,
    backoffUntil: backoff.until || null,
    staleAfterMs: STALE_MS,
  };
}

/* ── HTTP ───────────────────────────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const sendJSON = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('body was not JSON');
  }
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/?/, '');

  if (route === 'state' && req.method === 'GET') {
    await refresh();
    return sendJSON(res, 200, publicState());
  }

  if (route === 'login' && req.method === 'POST') {
    const body = await readBody(req);
    // The password lives for the length of this call and is never stored,
    // returned or logged. Registering it means even an upstream error message
    // that quotes it comes out redacted.
    guard(body.password);
    const wanted = body.provider === 'demo' ? 'demo' : 'life360';
    if (wanted !== provider.id) { provider = createProvider(wanted); state.circles = []; }

    try {
      const token = await provider.authenticate({
        mode: body.mode === 'token' ? 'token' : 'password',
        username: body.username,
        password: body.password,
        token: body.token,
      });
      guard(token);
      await saveSecrets({ provider: provider.id, token });
      state.problem = '';
      backoff.reset();
      state.circles = [];
      state.circlesFetchedAt = 0;
      log(`[family] signed in with ${provider.label}`);
      await refresh({ force: true });
      return sendJSON(res, 200, publicState());
    } catch (err) {
      const message = redact(err.message);
      warn('[family] sign-in failed:', message);
      return sendJSON(res, 200, { ...publicState(), problem: message });
    } finally {
      release(body.password);
    }
  }

  if (route === 'logout' && req.method === 'POST') {
    provider.forget();
    await clearSecrets();
    Object.assign(state, {
      circleId: null, circles: [], circlesFetchedAt: 0, members: [],
      lastUpdate: null, problem: '',
    });
    backoff.reset();
    log('[family] signed out');
    return sendJSON(res, 200, publicState());
  }

  if (route === 'circle' && req.method === 'POST') {
    const body = await readBody(req);
    if (!state.circles.some((c) => c.id === body.circleId)) {
      return sendJSON(res, 400, { error: 'no such circle' });
    }
    state.circleId = body.circleId;
    await refresh({ force: true });
    return sendJSON(res, 200, publicState());
  }

  if (route === 'request' && req.method === 'POST') {
    const body = await readBody(req);
    if (!provider.canRequestUpdate) return sendJSON(res, 400, { error: 'this source cannot do that' });
    const last = lastRequestAt.get(body.memberId) || 0;
    const wait = REQUEST_THROTTLE_MS - (Date.now() - last);
    // This rings their phone. Throttled hard, and never on a timer.
    if (wait > 0) {
      return sendJSON(res, 429, { error: `Already asked. Try again in ${Math.ceil(wait / 1000)}s.` });
    }
    try {
      await provider.requestUpdate(state.circleId, body.memberId);
      lastRequestAt.set(body.memberId, Date.now());
      return sendJSON(res, 200, { ok: true });
    } catch (err) {
      noteFailure(err);
      return sendJSON(res, 200, { ok: false, error: redact(err.message) });
    }
  }

  return sendJSON(res, 404, { error: 'no such endpoint' });
}

async function serveFile(res, pathname) {
  const rel = decodeURIComponent(pathname) === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
  const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB)) { res.writeHead(403).end('forbidden'); return; }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith('/api')) return await handleApi(req, res, url);
    return await serveFile(res, url.pathname);
  } catch (err) {
    const message = redact(err.message);
    warn('[family]', message);
    if (!res.headersSent) sendJSON(res, 500, { error: message });
  }
});

const saved = await loadSecrets();
if (saved?.token) {
  try {
    provider = createProvider(saved.provider || 'life360');
    guard(saved.token);
    provider.restore(saved.token);
    log(`[family] restored a saved ${provider.label} sign-in`);
  } catch (err) {
    warn('[family] could not restore the saved sign-in:', err.message);
  }
}

server.listen(PORT, () => {
  log(`[family] listening on ${PORT}, source ${provider.label},`,
      provider.authenticated ? 'signed in' : 'not signed in');
});
