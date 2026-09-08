/**
 * The app registry.
 *
 * An "app" in this OS is a URL, not a JavaScript module. That is the whole
 * design: it means any project that can serve itself over HTTP is installable
 * here without being ported to our framework first, and it means an app that
 * fetches absolute paths (God's Eye View asks for `/api/opensky`) resolves
 * against its own origin instead of ours. Path-prefixing apps under one origin
 * would silently break exactly those fetches, so every app gets its own port.
 *
 * A manifest lives at apps/<id>/app.json and declares one of three kinds:
 *
 *   process   a repo that runs its own server; we spawn it and hand it a port
 *   static    a folder of files; we serve it on a port of its own
 *   external  something already running; we only point at it
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
const APPS_DIR = path.join(ROOT, 'apps');

const KINDS = new Set(['process', 'static', 'external']);

/** Validate one manifest, returning it normalized, or throw with a usable message. */
function normalize(raw, dir) {
  const where = path.relative(ROOT, path.join(dir, 'app.json'));
  const fail = (msg) => { throw new Error(`${where}: ${msg}`); };

  if (!raw.id) fail('needs an "id"');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) fail(`id "${raw.id}" must be lowercase letters, digits and dashes`);
  if (!KINDS.has(raw.kind)) fail(`kind must be one of ${[...KINDS].join(', ')}`);

  const app = {
    id: raw.id,
    name: raw.name || raw.id,
    icon: raw.icon || '▦',
    description: raw.description || '',
    kind: raw.kind,
    // An immersive app owns the whole screen; the shell collapses its nav rail
    // to an edge tab so a map or a camera view is not boxed in.
    immersive: raw.immersive === true,
    // "eager" apps start with the shell. Everything else waits until opened,
    // because a head unit should reach its launcher fast and a Cesium globe
    // takes real seconds to come up.
    boot: raw.boot === 'eager' ? 'eager' : 'on-demand',
    dir,
  };

  if (raw.kind === 'process') {
    if (!raw.start) fail('a process app needs a "start" command');
    app.start = raw.start;
    // Where the command runs, relative to the repo root — usually a vendored checkout.
    app.cwd = path.resolve(ROOT, raw.cwd || dir);
    // How the app learns which port to listen on. Vite reads PORT; others differ.
    app.portEnv = raw.portEnv || 'PORT';
    app.port = raw.port ?? null;
    app.env = raw.env && typeof raw.env === 'object' ? raw.env : {};
    // How long to wait for the port to answer before calling the launch failed.
    app.startTimeoutMs = Number(raw.startTimeoutMs) || 90_000;
  }

  if (raw.kind === 'static') {
    app.serveDir = path.resolve(dir, raw.dir || '.');
    app.port = raw.port ?? null;
  }

  if (raw.kind === 'external') {
    if (!raw.url) fail('an external app needs a "url"');
    app.url = raw.url;
  }

  return app;
}

/** Read every apps/<id>/app.json. A broken manifest is reported, not fatal. */
export async function loadRegistry() {
  let entries = [];
  try {
    entries = await readdir(APPS_DIR, { withFileTypes: true });
  } catch {
    return { apps: [], errors: [] };
  }

  const apps = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(APPS_DIR, entry.name);
    try {
      const raw = JSON.parse(await readFile(path.join(dir, 'app.json'), 'utf8'));
      apps.push(normalize(raw, dir));
    } catch (err) {
      if (err.code !== 'ENOENT') errors.push(err.message);
    }
  }

  const seen = new Set();
  for (const app of apps) {
    if (seen.has(app.id)) errors.push(`duplicate app id "${app.id}"`);
    seen.add(app.id);
  }

  apps.sort((a, b) => a.name.localeCompare(b.name));
  return { apps, errors };
}
