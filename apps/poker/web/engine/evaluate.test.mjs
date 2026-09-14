/*
 * The evaluator's proof.
 *
 *   node apps/poker/web/engine/evaluate.test.mjs
 *
 * Every five-card hand there is — 2,598,960 of them — sorted into categories,
 * and the totals compared against the distribution the maths says they must
 * have. There is no sampling and no judgement in it: one hand mis-ranked moves
 * a count and the test fails. Everything else in this app rests on this file
 * being right, so it is checked exhaustively rather than spot-checked.
 */
import { evaluate5, evaluateBest, categoryOf, CATEGORY_NAMES,
         HIGH_CARD, PAIR, TWO_PAIR, TRIPS, STRAIGHT, FLUSH,
         FULL_HOUSE, QUADS, STRAIGHT_FLUSH } from './evaluate.mjs';
import { parseHand, freshDeck, shuffle, cardName } from './cards.mjs';

let failures = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
};

/* ── 1. Every hand, counted ──────────────────────────────── */

const EXPECTED = {
  [STRAIGHT_FLUSH]: 40, [QUADS]: 624, [FULL_HOUSE]: 3744, [FLUSH]: 5108,
  [STRAIGHT]: 10200, [TRIPS]: 54912, [TWO_PAIR]: 123552,
  [PAIR]: 1098240, [HIGH_CARD]: 1302540,
};

console.log('\nall 2,598,960 five-card hands');
const counts = new Array(9).fill(0);
const hand = [0, 0, 0, 0, 0];
let total = 0;
const t0 = Date.now();
for (let a = 0; a < 52; a++) {
  hand[0] = a;
  for (let b = a + 1; b < 52; b++) {
    hand[1] = b;
    for (let c = b + 1; c < 52; c++) {
      hand[2] = c;
      for (let d = c + 1; d < 52; d++) {
        hand[3] = d;
        for (let e = d + 1; e < 52; e++) {
          hand[4] = e;
          counts[categoryOf(evaluate5(hand))]++;
          total++;
        }
      }
    }
  }
}
check(total === 2598960, `dealt ${total.toLocaleString()} distinct hands`);
for (const cat of [STRAIGHT_FLUSH, QUADS, FULL_HOUSE, FLUSH, STRAIGHT, TRIPS, TWO_PAIR, PAIR, HIGH_CARD]) {
  const got = counts[cat], want = EXPECTED[cat];
  check(got === want, `${CATEGORY_NAMES[cat].padEnd(16)} ${got.toLocaleString().padStart(9)}  (expected ${want.toLocaleString()})`);
}
console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

/* ── 2. Ordering, where it is easy to get wrong ──────────── */

console.log('\nordering');
const beats = (winner, loser, what) =>
  check(evaluate5(parseHand(winner)) > evaluate5(parseHand(loser)), what);
const ties = (x, y, what) =>
  check(evaluate5(parseHand(x)) === evaluate5(parseHand(y)), what);

beats('6c 5c 4c 3c 2c', 'Ah Ad Ac Ks Kh', 'straight flush beats a full house');
beats('As Ks Qs Js Ts', '5c 4c 3c 2c Ac', 'broadway beats the steel wheel');
beats('6h 5d 4c 3s 2h', 'Ah 5d 4c 3s 2h', 'six-high straight beats the wheel');
beats('Ah 5d 4c 3s 2h', 'Ah Kh Qh Jd 9c', 'the wheel is still a straight');
beats('Ah Ad Ac 2s 2h', 'Kh Kd Kc As Ah', 'full house compares trips first');
beats('Ah Ad Kc Ks 2h', 'Ah Ad Qc Qs Jh', 'two pair compares the high pair first');
beats('Ah Ad Kc Ks 3h', 'Ah Ad Kc Ks 2h', 'two pair falls through to the kicker');
beats('Ah Kd Qc Js 9h', 'Ah Kd Qc Js 8h', 'high card falls through to the fifth card');
beats('Ah Ad 4c 3s 2h', 'Kh Kd Qc Js Th', 'a pair of aces beats a pair of kings');
ties('Ah Kh Qh Jh 9h', 'As Ks Qs Js 9s', 'suits do not break ties');
ties('Ah Ad Kc Qs Jh', 'As Ac Kd Qh Jc', 'identical ranks tie exactly');

/* ── 3. Best-of-seven, against brute force ───────────────── */

console.log('\nbest five from seven');
const combos5of7 = [];
for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) for (let c = b + 1; c < 7; c++)
  for (let d = c + 1; d < 7; d++) for (let e = d + 1; e < 7; e++) combos5of7.push([a, b, c, d, e]);

let mismatches = 0;
for (let trial = 0; trial < 40000; trial++) {
  const seven = shuffle(freshDeck()).slice(0, 7);
  let want = -1;
  for (const combo of combos5of7) {
    const v = evaluate5(combo.map((i) => seven[i]));
    if (v > want) want = v;
  }
  if (evaluateBest(seven) !== want) {
    if (mismatches++ === 0) console.log('    first mismatch:', seven.map(cardName).join(' '));
  }
}
check(mismatches === 0, `40,000 random seven-card deals match an independent search (${mismatches} off)`);

/* A seven-card hand where the flush and the straight both exist but the best
   five is neither — the case a naive "highest category wins" search gets wrong. */
check(categoryOf(evaluateBest(parseHand('Ah Kh Qh Jh 9h 8s 7d'))) === FLUSH,
      'seven cards containing both a flush and a near-straight pick the flush');
check(categoryOf(evaluateBest(parseHand('2h 2d 2c 2s 9h 9d 9c'))) === QUADS,
      'quads plus a set picks the quads');

console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
