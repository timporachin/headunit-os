/**
 * Album art, looked up rather than received.
 *
 * Bluetooth almost never delivers cover art: AVRCP's image profile is rarely
 * negotiated, so what arrives from the phone is text and nothing else. The only
 * way to put a sleeve on the screen is to go and find it.
 *
 * This is OFF unless HEADUNIT_MEDIA_ARTWORK=itunes, because it means telling
 * Apple what you are listening to. A head unit should not phone home about your
 * music because it looked prettier that way — that has to be a choice you made.
 */
const ENABLED = process.env.HEADUNIT_MEDIA_ARTWORK === 'itunes';
const ENDPOINT = 'https://itunes.apple.com/search';
const MAX_ENTRIES = 40;
const TIMEOUT_MS = 5_000;

/** trackKey -> { body: Buffer, type: string } */
const cache = new Map();
/** Keys already looked up and not found, so a miss is not retried every poll. */
const misses = new Set();
const inFlight = new Set();
const resolved = new Set();

export const enabled = ENABLED;
export const has = (trackKey) => cache.has(trackKey);
export const get = (trackKey) => cache.get(trackKey) ?? null;

export function onResolved(fn) {
  resolved.add(fn);
  return () => resolved.delete(fn);
}

function remember(trackKey, body, type) {
  // A drive is long and every sleeve is a few hundred KB. Oldest out first.
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(trackKey, { body, type });
  for (const fn of resolved) {
    try { fn(trackKey); } catch { /* a listener's problem, not ours */ }
  }
}

/**
 * Find the sleeve for a track, once. Returns nothing — the result arrives via
 * onResolved, because a lookup takes a network round trip and the track is
 * already on screen by then.
 */
export function request(trackKey, artist, title) {
  if (!ENABLED || !trackKey || !title) return;
  if (cache.has(trackKey) || misses.has(trackKey) || inFlight.has(trackKey)) return;

  inFlight.add(trackKey);
  (async () => {
    try {
      const term = [artist, title].filter(Boolean).join(' ');
      const url = `${ENDPOINT}?term=${encodeURIComponent(term)}&entity=song&limit=1`;
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`search returned ${res.status}`);

      const found = (await res.json())?.results?.[0]?.artworkUrl100;
      if (!found) { misses.add(trackKey); return; }

      // The search API only ever offers a 100px thumbnail; the same path serves
      // any size, and 600 is what a head unit actually needs.
      const art = await fetch(found.replace('100x100bb', '600x600bb'), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!art.ok) throw new Error(`artwork returned ${art.status}`);

      remember(trackKey, Buffer.from(await art.arrayBuffer()),
        art.headers.get('content-type') || 'image/jpeg');
    } catch (err) {
      // Losing a sleeve is not worth a word on the screen; the track still plays
      // and the fallback still looks deliberate.
      misses.add(trackKey);
      console.warn(`[media] artwork lookup failed: ${err.message}`);
    } finally {
      inFlight.delete(trackKey);
    }
  })();
}
