/*
 * The provider seam.
 *
 * The screen never talks to a location service. It talks to one of these, and
 * they all answer in the same shape, so replacing the source is a config change
 * rather than a rewrite. That matters more here than it usually would: Life360
 * has no public API and has cut third-party clients off before, so this app is
 * built on the assumption that its source will eventually stop working.
 *
 * A provider supplies:
 *
 *   id, label            what it is called
 *   synthetic            true if its data is made up (the UI must say so)
 *   canRequestUpdate     whether requestUpdate() exists
 *   authenticated        whether it can currently call anything
 *   restore(token)       take a token saved from a previous run
 *   forget()             drop it
 *   authenticate(input)  -> token to store, or throw AuthError
 *   listCircles()        -> [{ id, name }]
 *   listMembers(id)      -> [Member]
 *   requestUpdate(c, m)  optional; ask a device to report in
 *
 * A Member is this app's shape, never the upstream one. Every field except id
 * and name may be null, and null means "not reported" — the UI draws a dash. No
 * provider should ever invent a value to fill a gap.
 *
 *   { id, name, avatarUrl, lat, lon, accuracy, address, since,
 *     battery, charging, speed, isDriving, wifi }
 *
 * `since` is milliseconds since the epoch, so the UI can age it. `speed` is only
 * set by a provider that knows its own unit; Life360 does not document its own,
 * so it sends null rather than a number that might be wrong.
 */
import { createLife360Provider, AuthError, RateLimited } from './life360.mjs';
import { createDemoProvider } from './demo.mjs';

export { AuthError, RateLimited };

const FACTORIES = {
  life360: createLife360Provider,
  demo: createDemoProvider,
};

export const PROVIDER_IDS = Object.keys(FACTORIES);

export function createProvider(id) {
  const make = FACTORIES[id];
  if (!make) throw new Error(`no provider "${id}" (have: ${PROVIDER_IDS.join(', ')})`);
  return make();
}
