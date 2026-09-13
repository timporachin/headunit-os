/*
 * How long to wait before starting the adapter again.
 *
 * The PowerShell adapter can die for reasons that clear up (a session manager
 * that is not ready yet, a restarted Bluetooth stack) and for reasons that
 * never will (this is not Windows, the media session API is absent). The ladder
 * is what tells those apart without having to know which is which: a cause that
 * clears up costs a couple of seconds, and one that does not settles into a
 * slow retry instead of spawning a process every second for the rest of the
 * drive.
 *
 * Its own shape is the policy, kept here rather than inline so it can be read
 * and tested without starting a server.
 */
export const DEFAULT_LADDER_SECONDS = [2, 4, 8, 15, 30];

export function createBackoff(ladder = DEFAULT_LADDER_SECONDS, now = () => Date.now()) {
  let step = 0;
  let until = 0;

  return {
    /** Record a failure and return how many seconds we will now wait. */
    fail() {
      const seconds = ladder[Math.min(step, ladder.length - 1)];
      step = Math.min(step + 1, ladder.length - 1);
      until = now() + seconds * 1000;
      return seconds;
    },
    /* A line of real output clears it. Not a successful spawn: the adapter that
     * exits immediately on a machine with no media session API spawns
     * perfectly well every time, and would reset the ladder forever. */
    reset() { step = 0; until = 0; },
    blocked() { return now() < until; },
    get until() { return until || 0; },
  };
}
