/*
 * A provider that makes its data up.
 *
 * Two jobs. It lets the screen be built and looked at on a machine with no
 * phone, no Bluetooth and no Windows — which is every machine this was written
 * on — and it is the proof that the seam in index.mjs holds: if this drives the
 * screen unchanged, so will the next real source.
 *
 * It sets `synthetic: true`, and the UI says so on screen for as long as it is
 * selected. A dashboard showing a track nobody is playing has to admit it.
 */
/* Named so nobody mistakes one for their own music. Between them these cover
 * every state the screen has to draw, which is the point of them — a demo made
 * of four pleasant three-minute songs would leave the awkward halves of this
 * screen untested until a real phone found them. */
const TRACKS = [
  // The happy path: everything reported, every control accepted.
  { title: 'Demo Track One', artist: 'The Demonstrators', album: 'Synthetic Sounds',
    duration: 245_000, canNext: true, canPrevious: true },

  // No duration. Bluetooth frequently reports none, and the progress bar has to
  // disappear rather than sit frozen at the left edge.
  { title: 'Demo Stream', artist: 'The Demonstrators', album: null,
    duration: null, canNext: true, canPrevious: true },

  // No artist and no album — the rows below the title must collapse, not leave
  // a gap where text should be.
  { title: 'Demo Track With Nothing But A Title', artist: null, album: null,
    duration: 180_000, canNext: true, canPrevious: true },

  // A title long enough to need clamping, so the layout is proven against the
  // worst case rather than the average one.
  { title: 'Demo Track With An Unreasonably Long Title That Will Not Fit On One Line Of A Head Unit Screen',
    artist: 'An Artist With A Similarly Inconvenient And Overlong Name',
    album: 'Album Titles Can Be Long Too', duration: 372_000,
    canNext: true, canPrevious: true },

  // A phone that refuses to skip. The transport buttons must dim rather than
  // stay live and do nothing.
  { title: 'Demo Track Five', artist: 'The Demonstrators', album: 'Synthetic Sounds',
    duration: 210_000, canNext: false, canPrevious: false },
];

export function createDemoProvider() {
  let report = () => {};
  let timer = null;
  let index = 0;
  let playing = true;
  let position = 0;
  let last = Date.now();

  const advance = () => {
    const now = Date.now();
    if (playing) position += now - last;
    last = now;
  };

  const emit = () => {
    const track = TRACKS[index];
    report({
      state: playing ? 'playing' : 'paused',
      title: track.title,
      artist: track.artist,
      album: track.album,
      // A track with no duration reports no position either: a source that does
      // not know how long something is does not know where you are in it.
      position: track.duration === null ? null : Math.round(position),
      duration: track.duration,
      positionAt: Date.now(),
      canPlay: !playing,
      canPause: playing,
      canNext: track.canNext,
      canPrevious: track.canPrevious,
      sourceApp: 'demo',
    });
  };

  return {
    id: 'demo',
    label: 'Demo data',
    synthetic: true,

    start(onChange) {
      report = onChange;
      last = Date.now();
      timer = setInterval(() => {
        advance();
        const { duration } = TRACKS[index];
        if (duration !== null && position >= duration) {
          index = (index + 1) % TRACKS.length;
          position = 0;
        }
        emit();
      }, 1000);
      timer.unref?.();
      emit();
    },

    stop() {
      clearInterval(timer);
      timer = null;
    },

    command(verb) {
      advance();
      const track = TRACKS[index];
      // Honour the same refusals a real phone would, so the dimmed buttons are
      // actually proven not to work rather than merely drawn that way.
      if ((verb === 'next' && !track.canNext) || (verb === 'previous' && !track.canPrevious)) {
        throw new Error(`this track does not accept "${verb}"`);
      }
      if (verb === 'play') playing = true;
      if (verb === 'pause') playing = false;
      if (verb === 'playpause') playing = !playing;
      if (verb === 'next') { index = (index + 1) % TRACKS.length; position = 0; }
      // Restart the track first, like every real player, and step back only if
      // you were already near its start.
      if (verb === 'previous') {
        if (position < 3000) index = (index - 1 + TRACKS.length) % TRACKS.length;
        position = 0;
      }
      emit();
    },
  };
}
