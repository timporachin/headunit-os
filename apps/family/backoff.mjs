/*
 * How long to wait after being told to slow down.
 *
 * Life360 answers an over-eager client with 429 or 403, and the community
 * clients that survive settled on minutes rather than seconds. Its own shape
 * is the policy, kept here rather than inline so it can be read and tested
 * without starting a server.
 */
export const DEFAULT_LADDER_MINUTES = [1, 2, 4, 8, 10];

export function createBackoff(ladder = DEFAULT_LADDER_MINUTES, now = () => Date.now()) {
  let step = 0;
  let until = 0;

  return {
    /** Record a refusal and return how many minutes we will now wait. */
    fail() {
      const minutes = ladder[Math.min(step, ladder.length - 1)];
      step = Math.min(step + 1, ladder.length - 1);
      until = now() + minutes * 60_000;
      return minutes;
    },
    /** A success clears it: the next refusal starts at the bottom again. */
    reset() { step = 0; until = 0; },
    blocked() { return now() < until; },
    get until() { return until || 0; },
  };
}
