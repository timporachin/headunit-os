/**
 * The media source.
 *
 * Owns whatever knows what is playing, normalises it to one shape, and lets the
 * shell subscribe to changes. Nothing above this file knows that the answer
 * comes from a PowerShell process reading a Windows media session.
 *
 * The honesty rule from the vehicle readout applies here too: when there is no
 * source, this says so. It never reports a paused track at 0:00 to fill a gap,
 * because a head unit that invents state is worse than one that admits it has
 * none.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './registry.mjs';
import * as artwork from './media/artwork.mjs';

const SCRIPT = path.join(ROOT, 'server', 'media', 'windows-media.ps1');
const LOG_LINES = 60;
const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 30_000;

export const VERBS = new Set(['play', 'pause', 'playpause', 'next', 'previous']);

/** Every consumer gets all of these keys, whatever the source had to say. */
const IDLE = Object.freeze({
  source: 'unavailable',
  state: 'none',
  title: null,
  artist: null,
  album: null,
  position: null,
  duration: null,
  positionAt: null,
  canPlay: false,
  canPause: false,
  canNext: false,
  canPrevious: false,
  sourceApp: null,
  trackKey: null,
  artUrl: null,
});

let state = { ...IDLE };
let child = null;
let stopped = false;
let restartDelay = RESTART_MIN_MS;
let restartTimer = null;
let demoTimer = null;
const log = [];
const listeners = new Set();

export const getState = () => state;
export const logs = () => [...log];
/** The bytes for a track's sleeve, if one was ever found. */
export const artFor = (trackKey) => artwork.get(trackKey);

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function record(line) {
  for (const l of String(line).split('\n')) {
    if (!l.trim()) continue;
    log.push(l);
    if (log.length > LOG_LINES) log.shift();
  }
}

/** Identity of a track, and the cache key its artwork is filed under. */
const keyFor = (s) => [s.artist, s.title, s.album].some(Boolean)
  ? [s.artist || '', s.title || '', s.album || ''].join(' | ')
  : null;

function publish(next) {
  const merged = { ...IDLE, ...next };
  merged.trackKey = keyFor(merged);
  merged.artUrl = merged.trackKey && artwork.has(merged.trackKey)
    ? `/api/media/art?key=${encodeURIComponent(merged.trackKey)}`
    : null;

  // Only wake the shell for real news. The adapter already quantises position,
  // but a demo source or a restart can repeat itself.
  if (JSON.stringify(merged) === JSON.stringify(state)) return;
  state = merged;
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.warn(`[media] listener threw: ${err.message}`); }
  }
}

/* Artwork arrives later than the track it belongs to — a lookup is a network
 * round trip — so republish when it lands rather than making every consumer
 * poll for it. */
artwork.onResolved((trackKey) => {
  if (trackKey === state.trackKey) publish({ ...state });
});

/* ── The Windows source ───────────────────────────────────────── */
function startWindows() {
  if (stopped) return;

  child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  child.on('error', (err) => {
    // No powershell.exe at all: this is not Windows, or it is a stripped image.
    record(`could not launch powershell.exe: ${err.message}`);
    publish({ ...IDLE });
    child = null;
    scheduleRestart();
  });

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        record(`unparseable line: ${line.slice(0, 200)}`);
        continue;
      }
      if (msg.error) {
        record(msg.error);
        publish({ ...IDLE });
        continue;
      }
      // A line got through, so the adapter works; stop backing off.
      restartDelay = RESTART_MIN_MS;
      publish({ ...msg, source: 'windows-media' });
      if (msg.title) artwork.request(keyFor(msg), msg.artist, msg.title);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', record);

  child.on('exit', (code) => {
    child = null;
    if (stopped) return;
    record(`adapter exited with code ${code}`);
    publish({ ...IDLE });
    scheduleRestart();
  });
}

function scheduleRestart() {
  if (stopped || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startWindows();
  }, restartDelay);
  restartTimer.unref?.();
  restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
}

/* ── The demo source ──────────────────────────────────────────── */
/* Only ever runs when asked for by name. It reports source: "demo" and the UI
 * prints that, so a fake track can never be mistaken for the phone. */
const DEMO_TRACKS = [
  { title: 'Nightcall', artist: 'Kavinsky', album: 'OutRun', duration: 258_000 },
  { title: 'Midnight City', artist: 'M83', album: 'Hurry Up, We\'re Dreaming', duration: 244_000 },
  { title: 'Digital Love', artist: 'Daft Punk', album: 'Discovery', duration: 301_000 },
];

function startDemo() {
  let index = 0;
  let playing = true;
  let position = 0;
  let last = Date.now();

  const emit = () => {
    const track = DEMO_TRACKS[index];
    publish({
      source: 'demo',
      state: playing ? 'playing' : 'paused',
      ...track,
      position: Math.round(position),
      positionAt: Date.now(),
      canPlay: !playing,
      canPause: playing,
      canNext: true,
      canPrevious: true,
      sourceApp: 'demo',
    });
    artwork.request(keyFor(track), track.artist, track.title);
  };

  demoTimer = setInterval(() => {
    const now = Date.now();
    if (playing) position += now - last;
    last = now;
    if (position >= DEMO_TRACKS[index].duration) { index = (index + 1) % DEMO_TRACKS.length; position = 0; }
    emit();
  }, 1000);
  demoTimer.unref?.();

  emit();

  return (verb) => {
    const now = Date.now();
    if (playing) position += now - last;
    last = now;
    if (verb === 'play') playing = true;
    if (verb === 'pause') playing = false;
    if (verb === 'playpause') playing = !playing;
    if (verb === 'next') { index = (index + 1) % DEMO_TRACKS.length; position = 0; }
    // Restart the track first, like every real player, and only step back if
    // you were already near its start.
    if (verb === 'previous') {
      if (position < 3000) index = (index - 1 + DEMO_TRACKS.length) % DEMO_TRACKS.length;
      position = 0;
    }
    emit();
  };
}

let demoCommand = null;

/* ── Lifecycle ────────────────────────────────────────────────── */
export function start() {
  const mode = process.env.HEADUNIT_MEDIA
    || (process.platform === 'win32' ? 'windows' : 'off');

  if (mode === 'demo') { demoCommand = startDemo(); return 'demo'; }
  if (mode === 'windows') { startWindows(); return 'windows'; }
  // Nothing to read here, and nothing worth pretending. The shell will show
  // "no source" everywhere the track would have gone.
  return 'off';
}

export function command(verb) {
  if (!VERBS.has(verb)) throw new Error(`unknown command "${verb}"`);
  if (demoCommand) return demoCommand(verb);
  if (!child?.stdin.writable) throw new Error('no media source is running');
  child.stdin.write(`${verb}\n`);
}

export function stop() {
  stopped = true;
  clearTimeout(restartTimer);
  clearInterval(demoTimer);
  restartTimer = null;
  // Closing stdin is the adapter's own shutdown signal; kill is the backstop.
  child?.stdin.end();
  child?.kill();
  child = null;
}

// The supervisor's signal handlers already funnel through process.exit, so this
// one hook covers Ctrl-C, SIGTERM and a clean return alike.
process.on('exit', stop);
