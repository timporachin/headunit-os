/**
 * The app supervisor: starts apps, gives each one a port, and knows whether
 * it is actually up.
 *
 * Apps are started lazily. A head unit has to reach its launcher in a second
 * or two, but a Cesium globe needs far longer than that to boot, so paying for
 * every app at startup would make the whole system feel broken. Opening an app
 * starts it; the shell shows the boot state while it comes up.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const FIRST_PORT = 4200;
const LOG_LINES = 200;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.map': 'application/json; charset=utf-8',
};

/** instances: id -> { app, port, state, proc, server, error, log } */
const instances = new Map();
let nextPort = FIRST_PORT;

function claimPort(preferred) {
  if (preferred) return preferred;
  return nextPort++;
}

/*
 * Both loopback families, always.
 *
 * An app told to serve on "localhost" binds to whatever that name resolves to
 * first, and that differs by platform: ::1 on Windows, 127.0.0.1 on Linux.
 * Probing only IPv4 makes a perfectly healthy Windows app look dead for the
 * entire start timeout — the app logs "ready", and the supervisor still calls
 * the launch failed. Ask both and take whichever answers.
 */
const LOOPBACK = ['127.0.0.1', '::1'];

/** Resolve true if something accepts a connection on host:port right now. */
function probe(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const settle = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1500);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}

/** Resolve once something is listening on `port`, or reject at the deadline. */
function waitForPort(port, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      if (isDead?.()) return reject(new Error('the app exited before it served anything'));
      const answered = await Promise.all(LOOPBACK.map((host) => probe(host, port)));
      if (answered.some(Boolean)) return resolve();
      if (Date.now() > deadline) {
        return reject(new Error(
          `nothing listened on port ${port} (tried ${LOOPBACK.join(' and ')}) within ${Math.round(timeoutMs / 1000)}s`));
      }
      setTimeout(attempt, 300);
    };
    attempt();
  });
}

/** A minimal static file server, one per static app so it gets its own origin. */
function serveStatic(rootDir, port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      // Contain the request inside rootDir: no ".." escape, no absolute paths.
      const target = path.join(rootDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (!target.startsWith(rootDir)) { res.writeHead(403).end('forbidden'); return; }

      let file = target;
      const info = await stat(file).catch(() => null);
      if (info?.isDirectory()) file = path.join(file, 'index.html');
      const found = await stat(file).catch(() => null);
      if (!found?.isFile()) { res.writeHead(404).end('not found'); return; }

      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': found.size,
        'cache-control': 'no-cache',
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(500).end('server error');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, 'localhost', () => resolve(server));
  });
}

function record(instance, line) {
  for (const l of String(line).split('\n')) {
    if (!l.trim()) continue;
    instance.log.push(l);
    if (instance.log.length > LOG_LINES) instance.log.shift();
  }
}

/** Public view of an instance — what the shell UI is allowed to see. */
export function describe(app) {
  const i = instances.get(app.id);
  if (app.kind === 'external') return { state: 'ready', url: app.url };
  if (!i) return { state: 'stopped', url: null };
  return {
    state: i.state,
    url: i.state === 'ready' ? `http://localhost:${i.port}` : null,
    error: i.error || null,
  };
}

export function logsFor(id) {
  return instances.get(id)?.log ?? [];
}

/**
 * Start an app if it is not already running, and resolve once it is serving.
 * Concurrent opens of the same app share one launch rather than racing.
 */
export async function start(app) {
  if (app.kind === 'external') return { url: app.url };

  const existing = instances.get(app.id);
  if (existing?.state === 'ready') return { url: `http://localhost:${existing.port}` };
  if (existing?.launching) return existing.launching;

  const instance = { app, port: claimPort(app.port), state: 'starting', error: null, log: [] };
  instances.set(app.id, instance);

  instance.launching = (async () => {
    try {
      if (app.kind === 'static') {
        instance.server = await serveStatic(app.serveDir, instance.port);
      } else {
        let exited = false;
        const proc = spawn(app.start, {
          cwd: app.cwd,
          shell: true,
          env: { ...process.env, ...app.env, [app.portEnv]: String(instance.port) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        instance.proc = proc;
        proc.stdout.on('data', (d) => record(instance, d));
        proc.stderr.on('data', (d) => record(instance, d));
        proc.on('exit', (code) => {
          exited = true;
          if (instance.state !== 'stopped') {
            instance.state = 'failed';
            instance.error = `exited with code ${code}`;
          }
        });
        await waitForPort(instance.port, app.startTimeoutMs, () => exited);
      }
      instance.state = 'ready';
      return { url: `http://localhost:${instance.port}` };
    } catch (err) {
      instance.state = 'failed';
      instance.error = err.message;
      throw err;
    } finally {
      delete instance.launching;
    }
  })();

  return instance.launching;
}

export function stop(id) {
  const instance = instances.get(id);
  if (!instance) return false;
  instance.state = 'stopped';
  instance.proc?.kill();
  instance.server?.close();
  instances.delete(id);
  return true;
}

export function stopAll() {
  for (const id of [...instances.keys()]) stop(id);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopAll(); process.exit(0); });
}
process.on('exit', stopAll);
