/*
 * The provider seam.
 *
 * The screen never talks to a media session. It talks to one of these, and they
 * all answer in the same shape, so replacing the source is a config change
 * rather than a rewrite. That matters here because the source is the weakest
 * part of the design: reading what a phone is playing depends entirely on what
 * the host OS chooses to expose, and that is different on every one of them.
 * A Linux head unit would talk to BlueZ over D-Bus instead, and that should be
 * a file next to this one rather than a second version of the app.
 *
 * A provider supplies:
 *
 *   id, label           what it is called
 *   synthetic           true if its data is made up (the UI must say so)
 *   start(onChange)     begin reporting; onChange(NowPlaying) on every change
 *   stop()              stop reporting and release whatever it holds
 *   command(verb)       play | pause | playpause | next | previous
 *
 * NowPlaying is this app's shape, never the upstream one. Every field except
 * `state` may be null, and null means "not reported" — the UI hides the element
 * rather than drawing a zero. No provider invents a value to fill a gap: a
 * progress bar parked at 0:00 because Bluetooth sent no position is a worse
 * answer than no progress bar.
 *
 *   { state, title, artist, album, position, duration, positionAt,
 *     canPlay, canPause, canNext, canPrevious, sourceApp, trackKey }
 *
 * `state` is one of:
 *
 *   none       nothing is connected, or no session exists
 *   stopped    a session exists but is not on a track
 *   playing    playing
 *   paused     paused
 *   changing   mid-skip; the UI holds the previous track rather than blinking
 *
 * `position` and `duration` are milliseconds, and `positionAt` is when the
 * position was measured (epoch ms) so the screen can advance the playhead
 * itself between reports instead of polling fast enough to look live.
 *
 * The canPlay/canPause/canNext/canPrevious flags are what the phone says it
 * will honour. They exist because AVRCP advertises more than it accepts, and a
 * button that does nothing is worse than one that is visibly unavailable.
 */
import { createWindowsMediaProvider } from './windows-media.mjs';
import { createDemoProvider } from './demo.mjs';

const FACTORIES = {
  windows: createWindowsMediaProvider,
  demo: createDemoProvider,
};

export const PROVIDER_IDS = Object.keys(FACTORIES);

/** Every field a consumer may read, so nothing downstream guards for undefined. */
export const NOTHING_PLAYING = Object.freeze({
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
});

/** Identity of a track, and the key its artwork is filed under. */
export function trackKeyFor(snapshot) {
  const parts = [snapshot.artist, snapshot.title, snapshot.album];
  if (!parts.some(Boolean)) return null;
  return parts.map((p) => p || '').join(' | ');
}

export function createProvider(id) {
  const make = FACTORIES[id];
  if (!make) throw new Error(`no provider "${id}" (have: ${PROVIDER_IDS.join(', ')})`);
  return make();
}
