/*
 * Hand strength.
 *
 * evaluate5 returns one integer per five-card hand, where a bigger number is a
 * better hand and equal numbers are a genuine tie. Nothing outside this file
 * needs to know how the number is built; it only needs the comparison to be
 * right, which is what the exhaustive test checks.
 *
 * The layout is category in the high bits, then up to five tiebreak ranks
 * below it, four bits each:
 *
 *   cat << 20 | a << 16 | b << 12 | c << 8 | d << 4 | e
 *
 * Ranks are 0..12, so four bits each is exact and the whole thing stays well
 * inside a 32-bit int. Ordering the tiebreakers correctly is the entire job:
 * a full house compares trips first then the pair, two pair compares the high
 * pair, the low pair, then the kicker, and so on.
 */

import { rankOf, suitOf } from './cards.mjs';

export const HIGH_CARD = 0, PAIR = 1, TWO_PAIR = 2, TRIPS = 3, STRAIGHT = 4,
             FLUSH = 5, FULL_HOUSE = 6, QUADS = 7, STRAIGHT_FLUSH = 8;

export const CATEGORY_NAMES = [
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush',
];

const score = (cat, a = 0, b = 0, c = 0, d = 0, e = 0) =>
  (cat << 20) | (a << 16) | (b << 12) | (c << 8) | (d << 4) | e;

export const categoryOf = (value) => value >>> 20;

/**
 * The high card of a straight, or -1. `mask` is a 13-bit set of ranks present.
 *
 * The wheel is the only special case in the whole evaluator: A-2-3-4-5 is a
 * straight in which the ace plays low, and it is the weakest straight rather
 * than the strongest. It is checked separately because the ace sits at bit 12
 * and cannot be found by sliding a window down from the top.
 */
function straightHigh(mask) {
  for (let high = 12; high >= 4; high--) {
    const run = 0b11111 << (high - 4);
    if ((mask & run) === run) return high;
  }
  const wheel = (1 << 12) | 0b1111;          // A,5,4,3,2
  return (mask & wheel) === wheel ? 3 : -1;  // a five-high straight
}

/** Ranks present, biggest first, limited to `count`. */
function topRanks(mask, count) {
  const out = [];
  for (let r = 12; r >= 0 && out.length < count; r--) if (mask & (1 << r)) out.push(r);
  return out;
}

/** Exactly five cards in, one comparable integer out. */
export function evaluate5(cards) {
  let rankMask = 0;
  const bySuit = [0, 0, 0, 0];
  const counts = new Uint8Array(13);

  for (let i = 0; i < 5; i++) {
    const card = cards[i];
    const r = rankOf(card);
    counts[r]++;
    rankMask |= 1 << r;
    bySuit[suitOf(card)] |= 1 << r;
  }

  const flushSuit = bySuit.findIndex((m) => popcount(m) === 5);
  const isFlush = flushSuit >= 0;
  const straight = straightHigh(rankMask);

  if (isFlush && straight >= 0) return score(STRAIGHT_FLUSH, straight);

  /* Group ranks by how many of them there are. Sorting by count first and rank
     second puts the trips before the pair in a full house, and the high pair
     before the low one in two pair, which is exactly the tiebreak order. */
  const groups = [];
  for (let r = 12; r >= 0; r--) if (counts[r]) groups.push([counts[r], r]);
  groups.sort((x, y) => y[0] - x[0] || y[1] - x[1]);

  const [n0, r0] = groups[0];
  const n1 = groups[1]?.[0], r1 = groups[1]?.[1];

  if (n0 === 4) return score(QUADS, r0, r1);
  if (n0 === 3 && n1 === 2) return score(FULL_HOUSE, r0, r1);
  if (isFlush) { const [a, b, c, d, e] = topRanks(rankMask, 5); return score(FLUSH, a, b, c, d, e); }
  if (straight >= 0) return score(STRAIGHT, straight);
  if (n0 === 3) return score(TRIPS, r0, groups[1][1], groups[2][1]);
  if (n0 === 2 && n1 === 2) return score(TWO_PAIR, r0, r1, groups[2][1]);
  if (n0 === 2) return score(PAIR, r0, groups[1][1], groups[2][1], groups[3][1]);
  { const [a, b, c, d, e] = topRanks(rankMask, 5); return score(HIGH_CARD, a, b, c, d, e); }
}

function popcount(x) {
  let n = 0;
  while (x) { x &= x - 1; n++; }
  return n;
}

/* The 21 ways to choose 5 from 7, written out rather than generated: this runs
   inside the AI's rollouts, where it is the hot path. */
const C7 = [];
for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) for (let c = b + 1; c < 7; c++)
  for (let d = c + 1; d < 7; d++) for (let e = d + 1; e < 7; e++) C7.push([a, b, c, d, e]);

/** Best five-card value available from five, six or seven cards. */
export function evaluateBest(cards) {
  if (cards.length === 5) return evaluate5(cards);
  let best = -1;
  if (cards.length === 7) {
    const pick = [0, 0, 0, 0, 0];
    for (const combo of C7) {
      for (let i = 0; i < 5; i++) pick[i] = cards[combo[i]];
      const v = evaluate5(pick);
      if (v > best) best = v;
    }
    return best;
  }
  // six cards, or anything else small: drop one at a time
  const pick = [];
  const walk = (start, chosen) => {
    if (chosen.length === 5) { const v = evaluate5(chosen); if (v > best) best = v; return; }
    for (let i = start; i < cards.length; i++) { chosen.push(cards[i]); walk(i + 1, chosen); chosen.pop(); }
  };
  walk(0, pick);
  return best;
}

/** A short description, for the showdown line. */
export function describe(value) {
  const cat = categoryOf(value);
  return CATEGORY_NAMES[cat];
}
