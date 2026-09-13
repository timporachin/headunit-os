/*
 * The Now Playing app's own server.
 *
 * It exists because the browser cannot do this job: what a paired phone is
 * playing lives in a Windows media session, reachable only through WinRT, and
 * no page can call that. Everything that touches the media session happens
 * here, and the page only ever sees the normalised result.
 *
 * Two rules shape the file.
 *
 * ONE. Nothing is invented. Where the source reports nothing, this sends null
 * and the screen leaves it out. Bluetooth routinely supplies no duration, no
 * artwork and no position, and a progress bar parked at 0:00 because of it is a
 * worse answer than no progress bar.
 *
 * TWO. State is pushed, not polled. Unlike the Family app — which polls because
 * its upstream rate-limits it — nothing here is rate-limited and the state
 * changes while nobody is touching the screen: a track ends, or the driver hits
 * pause on the phone itself. A poll fast enough to feel live would be a poll
 * running all the time, so the page gets an event stream instead.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createProvider, NOTHING_PLAYING, trackKeyFor } from './providers/index.mjs';
import * as artwork from './artwork.mjs';

const DIR = import.meta.dirname;
const WEB = path.join(DIR, 'web');
const PORT = Number(process.env.PORT) || 4400;

const VERBS = new Set(['play', 'pause', 'playpause', 'next', 'previous']);

/* windows on Windows, nothing anywhere else. "off" is a real answer: the screen
 * says it has no source rather than showing a track that is not playing. */
const MODE = process.env.HEADUNIT_MEDIA
  || (process.platform === 'win32' ? 'windows' : 'off');

/* ── State ──────────────────────────────────────────────────── */
let provider = null;
let current = { ...NOTHING_PLAYING };
const listeners = new Set();

function publish(snapshot) {
  const next = { ...NOTHING_PLAYING, ...snapshot };
  next.trackKey = trackKeyFor(next);

  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;

  if (next.trackKey && next.title) artwork.request(next.trackKey, next.artist, next.title);

  const body = publicState();
  for (const send of listeners) {
    try { send(body); } catch { /* a dead stream; its close handler will clear it */ }
  }
}

/* Artwork arrives later than the track it belongs to — a lookup is a network
 * round trip — so republish when it lands rather than making the page poll. */
artwork.onResolved((trackKey) => {
  if (trackKey !== current.trackKey) return;
  const body = publicState();
  for (const send of listeners) {
    try { send(body); } catch { /* as above */ }
  }
});

function publicState() {
  return {
    ...current,
    source: provider?.id ?? 'none',
    sourceLabel: provider?.label ?? 'No media source',
    synthetic: provider?.synthetic === true,
    artUrl: current.trackKey && artwork.has(current.trackKey)
      ? `/api/art?key=${encodeURIComponent(current.trackKey)}`
      : null,
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

function streamEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (body) => res.write(`data: ${JSON.stringify(body)}\n\n`);
  send(publicState());
  listeners.add(send);
  // A stream with nothing to say for minutes at a time is one that something in
  // the middle eventually decides is dead.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { listeners.delete(send); clearInterval(heartbeat); });
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/?/, '');

  if (route === 'now' && req.method === 'GET') return sendJSON(res, 200, publicState());
  if (route === 'events' && req.method === 'GET') return streamEvents(req, res);

  if (route === 'command' && req.method === 'POST') {
    const { command } = await readBody(req);
    if (!VERBS.has(command)) return sendJSON(res, 400, { error: `unknown command "${command}"` });
    if (!provider) return sendJSON(res, 400, { error: 'no media source is running' });
    try {
      provider.command(command);
      return sendJSON(res, 200, publicState());
    } catch (err) {
      // A phone that refuses a command is news for the driver, not a fault.
      return sendJSON(res, 400, { error: err.message });
    }
  }

  if (route === 'art' && req.method === 'GET') {
    const art = artwork.get(url.searchParams.get('key') || '');
    if (!art) return sendJSON(res, 404, { error: 'no artwork for that track' });
    res.writeHead(200, {
      'content-type': art.type,
      'content-length': art.body.length,
      // The key is the track's identity, so the bytes behind it never change.
      'cache-control': 'public, max-age=86400, immutable',
    });
    return res.end(art.body);
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
    console.warn(`[nowplaying] ${err.message}`);
    if (!res.headersSent) sendJSON(res, 500, { error: err.message });
  }
});

if (MODE !== 'off') {
  try {
    provider = createProvider(MODE);
    provider.start(publish);
  } catch (err) {
    console.warn(`[nowplaying] ${err.message}`);
    provider = null;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { provider?.stop(); process.exit(0); });
}

server.listen(PORT, () => {
  console.log(`[nowplaying] listening on ${PORT}, source ${provider?.label ?? 'none'}`
    + (artwork.enabled ? ', artwork lookup on' : ''));
});
