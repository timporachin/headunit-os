/**
 * The shell server.
 *
 * Serves the shell UI itself and a small control plane the launcher uses to
 * start, stop and inspect apps. It deliberately does NOT proxy app traffic:
 * apps are reached directly on their own ports, so their absolute-path fetches
 * and their cookies stay their own. See server/registry.mjs for why.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { loadRegistry, ROOT } from './registry.mjs';
import * as supervisor from './supervisor.mjs';
import * as media from './media.mjs';

const PORT = Number(process.env.PORT) || 4100;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

// URL prefix -> directory on disk. The SDK and the design tokens are published
// so that a static app can pull them in with a plain <script>/<link>.
const MOUNTS = [
  ['/sdk/', path.join(ROOT, 'sdk')],
  ['/design/', path.join(ROOT, 'design')],
  ['/', path.join(ROOT, 'shell')],
];

let registry = { apps: [], errors: [] };

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

/** Read a JSON request body, with a cap so a stuck client cannot grow forever. */
async function readJson(req, limit = 8_192) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('request body too large');
  }
  return body ? JSON.parse(body) : {};
}

/**
 * Push media state to the shell as it changes.
 *
 * Server-sent events rather than polling: what is playing changes while nobody
 * is touching the screen — a track ends, the driver hits pause on the phone —
 * and a poll fast enough to feel live would be a poll running all the time.
 */
function mediaEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const push = (state) => res.write(`data: ${JSON.stringify(state)}\n\n`);
  push(media.getState());
  const unsubscribe = media.subscribe(push);
  // A stream with nothing to say for minutes at a time is a stream something
  // in the middle will eventually decide is dead.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { unsubscribe(); clearInterval(heartbeat); });
}

async function sendFile(res, file) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(file).pipe(res);
  return true;
}

/** The launcher's view of an app: its manifest plus its live run state. */
const publicApp = (app) => ({
  id: app.id, name: app.name, icon: app.icon,
  description: app.description, kind: app.kind,
  immersive: app.immersive, boot: app.boot,
  ...supervisor.describe(app),
});

async function handleApi(req, res, url) {
  const segments = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);

  if (segments[0] === 'apps' && segments.length === 1) {
    return json(res, 200, { apps: registry.apps.map(publicApp), errors: registry.errors });
  }

  if (segments[0] === 'apps' && segments.length >= 2) {
    const app = registry.apps.find((a) => a.id === segments[1]);
    if (!app) return json(res, 404, { error: `no app "${segments[1]}"` });
    const action = segments[2];

    if (action === 'start' && req.method === 'POST') {
      try {
        const { url: appUrl } = await supervisor.start(app);
        return json(res, 200, { ...publicApp(app), url: appUrl });
      } catch (err) {
        // A failed launch is normal operational news, not a server fault: the
        // launcher shows the reason and the log rather than a dead tile.
        return json(res, 200, { ...publicApp(app), state: 'failed', error: err.message });
      }
    }
    if (action === 'stop' && req.method === 'POST') {
      supervisor.stop(app.id);
      return json(res, 200, publicApp(app));
    }
    if (action === 'logs') {
      return json(res, 200, { id: app.id, lines: supervisor.logsFor(app.id) });
    }
    if (!action) return json(res, 200, publicApp(app));
  }

  if (segments[0] === 'media') {
    const action = segments[1];
    if (!action) return json(res, 200, media.getState());
    if (action === 'events') return mediaEvents(req, res);

    if (action === 'command' && req.method === 'POST') {
      try {
        const { command } = await readJson(req);
        media.command(String(command));
        return json(res, 200, media.getState());
      } catch (err) {
        // A phone that will not skip is news for the driver, not a server fault.
        return json(res, 400, { error: err.message });
      }
    }

    if (action === 'art') {
      const art = media.artFor(url.searchParams.get('key') || '');
      if (!art) return json(res, 404, { error: 'no artwork for that track' });
      res.writeHead(200, {
        'content-type': art.type,
        'content-length': art.body.length,
        // The key is the track's identity, so the bytes behind it never change.
        'cache-control': 'public, max-age=86400, immutable',
      });
      return res.end(art.body);
    }

    if (action === 'logs') return json(res, 200, { lines: media.logs() });
  }

  if (segments[0] === 'reload' && req.method === 'POST') {
    registry = await loadRegistry();
    return json(res, 200, { apps: registry.apps.map(publicApp), errors: registry.errors });
  }

  return json(res, 404, { error: 'no such endpoint' });
}

const server = createServer(async (req, res) => {
  try {
    // The shell frames apps; nothing may frame the shell. An app that allows
    // this origin to frame it is trusting this page specifically, and that
    // trust only holds while this page cannot itself be wrapped by a third
    // party. Both headers: the modern control, and the one older engines obey.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    for (const [prefix, dir] of MOUNTS) {
      if (!url.pathname.startsWith(prefix)) continue;
      const rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
      const file = path.join(dir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(dir)) continue;
      if (await sendFile(res, file)) return;
      // The shell is a single page, so an extensionless path falls back to it.
      // A missing .js or .css must NOT: serving index.html in its place turns a
      // plain 404 into a parse error thrown far away from the actual mistake.
      const looksLikeAsset = path.extname(file) !== '';
      if (prefix === '/' && !looksLikeAsset && await sendFile(res, path.join(dir, 'index.html'))) return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(`shell error: ${err.message}`);
  }
});

registry = await loadRegistry();
for (const problem of registry.errors) console.warn(`[registry] ${problem}`);

const mediaMode = media.start();

server.listen(PORT, () => {
  console.log(`\n  Head unit shell   http://localhost:${PORT}`);
  console.log(`  media source: ${mediaMode}`);
  console.log(`  ${registry.apps.length} app(s) installed: ${registry.apps.map((a) => a.id).join(', ') || 'none'}\n`);
  for (const app of registry.apps.filter((a) => a.boot === 'eager')) {
    supervisor.start(app).catch((err) => console.warn(`[${app.id}] ${err.message}`));
  }
});
