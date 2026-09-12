/*
 * A provider that makes its data up.
 *
 * Two jobs. It lets the screen be built and looked at without putting real
 * credentials anywhere, and it is the proof that the seam in index.mjs actually
 * holds — if this drives the screen unchanged, so will the next real source.
 *
 * It sets `synthetic: true`, and the UI is required to say so on screen for as
 * long as it is selected. A family map that might be showing invented positions
 * has to admit it; there is no version of that which is acceptable to leave
 * ambiguous.
 */

const MINUTE = 60_000;

/* Fictional on purpose, and named so nobody mistakes a row for a person. */
/* Between them these four cover every state the screen has to draw: charging,
 * flat, flat-but-charging, and no battery reading at all; driving and parked;
 * fresh and hours stale; a named place and nowhere in particular. */
const PEOPLE = [
  { id: 'demo-1', name: 'Demo Driver', lat: 38.6100, lon: -121.4400, battery: 82,
    charging: true, isDriving: true, wifi: false, address: 'I-80 near Sacramento', ageMin: 1 },
  { id: 'demo-2', name: 'Demo Passenger', lat: 38.6488, lon: -121.3400, battery: 14,
    charging: false, isDriving: false, wifi: true, address: 'Home', ageMin: 6 },
  { id: 'demo-3', name: 'Demo Walker', lat: 38.5100, lon: -121.5600, battery: 9,
    charging: true, isDriving: false, wifi: false, address: 'Land Park', ageMin: 3 },
  { id: 'demo-4', name: 'Demo Teenager', lat: 38.5449, lon: -121.7405, battery: null,
    charging: false, isDriving: false, wifi: false, address: null, ageMin: 190 },
];

export function createDemoProvider() {
  let live = false;
  return {
    id: 'demo',
    label: 'Demo data',
    synthetic: true,
    canRequestUpdate: false,
    get authenticated() { return live; },
    restore() { live = true; },
    forget() { live = false; },
    async authenticate() { live = true; return 'demo'; },
    async listCircles() { return [{ id: 'demo-circle', name: 'Demo Circle' }]; },
    async listMembers() {
      return PEOPLE.map((p) => ({
        id: p.id,
        name: p.name,
        avatarUrl: null,
        lat: p.lat,
        lon: p.lon,
        accuracy: 25,
        address: p.address,
        // One row is deliberately hours old so the stale label has something
        // to catch, and one has no battery so the dash does too.
        since: Date.now() - p.ageMin * MINUTE,
        battery: p.battery,
        charging: p.charging,
        speed: null,
        isDriving: p.isDriving,
        wifi: p.wifi,
      }));
    },
  };
}
