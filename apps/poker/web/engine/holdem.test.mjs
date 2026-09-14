/*
 * The engine's rules, checked where they are easy to get wrong: money must be
 * conserved, side pots must be built from what each player could actually
 * cover, and a betting round must not end while somebody still owes a decision.
 *
 *   node apps/poker/web/engine/holdem.test.mjs
 */
import { createGame, act, legalActions, startHand, rotate, buildPots, SHOWDOWN } from './holdem.mjs';

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };

const table = (n, stacks) => {
  const g = createGame({ seats: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, bot: i > 0 })), stack: 1000 });
  if (stacks) g.players.forEach((p, i) => { p.stack = stacks[i] - p.total; });
  return g;
};

/* ── blinds ──────────────────────────────────────────────── */
console.log('\nblinds and order');
{
  const g = table(3);
  check(g.players[1].total === 25 && g.players[2].total === 50, 'three-handed: blinds are left of the button');
  check(g.toAct === 0, 'three-handed: the button acts first before the flop');
}
{
  const g = table(2);
  check(g.players[0].total === 25 && g.players[1].total === 50, 'heads-up: the button posts the small blind');
  check(g.toAct === 0, 'heads-up: the button acts first before the flop');
}
{
  const g = table(3);
  act(g, 0, 'call'); act(g, 1, 'call'); act(g, 2, 'check');
  check(g.street === 'flop' && g.board.length === 3, 'the big blind may check its option to see a flop');
}

/* ── money is conserved ──────────────────────────────────── */
console.log('\nchips');
{
  let conserved = true, sidePotSeen = false, splitSeen = false;
  for (let hand = 0; hand < 4000; hand++) {
    const n = 2 + (hand % 5);
    const g = createGame({
      seats: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, bot: true })),
      stack: 200 + (hand % 7) * 130,
    });
    /* Uneven stacks on purpose. With everyone starting equal, every all-in is
       at the same level and a side pot can never form - the first version of
       this test looked thorough and never once exercised that code. */
    for (const p of g.players) p.stack = Math.max(60, Math.round(p.stack * (0.25 + Math.random() * 1.75)));
    const before = g.players.reduce((s, p) => s + p.stack + p.total, 0);
    let guard = 0;
    while (g.street !== SHOWDOWN && guard++ < 400) {
      const legal = legalActions(g, g.toAct);
      if (!legal) break;
      const roll = Math.random();
      if (legal.canCheck && roll < 0.45) act(g, g.toAct, 'check');
      else if (roll < 0.60 && legal.canRaise) act(g, g.toAct, 'raise', Math.round(legal.minRaiseTo + Math.random() * (legal.maxRaiseTo - legal.minRaiseTo)));
      else if (legal.canCall) act(g, g.toAct, 'call');
      else if (legal.canCheck) act(g, g.toAct, 'check');
      else act(g, g.toAct, 'fold');
    }
    const after = g.players.reduce((s, p) => s + p.stack, 0);
    if (after !== before) { conserved = false; console.log(`    hand ${hand}: ${before} in, ${after} out`); break; }
    if (g.pots.length > 1) sidePotSeen = true;
    if (g.result && g.result.winnings.length > 1) splitSeen = true;
  }
  check(conserved, '4,000 random hands: chips out always equal chips in');
  check(sidePotSeen, '  ...and side pots did occur, so that path was exercised');
  check(splitSeen, '  ...and pots were split, so that path was exercised');
}

/* ── side pots, by hand ──────────────────────────────────── */
console.log('\nside pots');
{
  const g = table(3);
  g.players[0].stack = 100; g.players[1].stack = 500; g.players[2].stack = 500;
  g.players.forEach((p) => { p.total = 0; p.committed = 0; });
  g.players[0].total = 100; g.players[1].total = 300; g.players[2].total = 300;
  g.players[0].stack = 0;
  const pots = buildPots(g);
  check(pots.length === 2, 'a short all-in makes exactly two pots');
  check(pots[0].amount === 300 && pots[0].eligible.length === 3, 'main pot is 300 and all three can win it');
  check(pots[1].amount === 400 && pots[1].eligible.join() === '1,2', 'side pot is 400 and only the two deep stacks can win it');
}
{
  const g = table(4);
  g.players.forEach((p) => { p.total = 0; p.committed = 0; p.folded = false; });
  g.players[0].total = 50;  g.players[0].folded = true;   // folded after putting money in
  g.players[1].total = 100; g.players[2].total = 400; g.players[3].total = 400;
  const pots = buildPots(g);
  const total = pots.reduce((s, p) => s + p.amount, 0);
  check(total === 950, 'dead money from a folded player stays in the pot');
  check(!pots.some((p) => p.eligible.includes(0)), 'a folded player cannot win any pot');
}

/* ── raising rules ───────────────────────────────────────── */
console.log('\nraising');
{
  const g = table(3);
  act(g, 0, 'raise', 150);
  const legal = legalActions(g, 1);
  check(legal.minRaiseTo === 250, 'a re-raise must lift the bet by at least the last raise');
}
{
  const g = table(3);
  g.players[0].stack = 60;                       // cannot make a full raise
  const legal = legalActions(g, 0);
  check(legal.isAllInOnly, 'a stack too short to raise properly is marked all-in-only');
  check(legal.maxRaiseTo === 60, '  ...and its maximum is exactly its stack');
}
{
  const g = table(3);
  act(g, 0, 'raise', 150);
  act(g, 1, 'call');
  act(g, 2, 'call');
  check(g.street === 'flop', 'calling a raise all round closes the betting');
}

/* ── a folded field ──────────────────────────────────────── */
console.log('\nfolds');
{
  const g = table(3);
  const before = g.players[2].stack + g.players[2].total;
  act(g, 0, 'fold'); act(g, 1, 'fold');
  check(g.street === SHOWDOWN, 'everyone folding ends the hand at once');
  check(!g.result.shown, '  ...without a showdown');
  check(g.players[2].stack === before + 25, '  ...and the last player standing takes the blinds');
}

/* ── the button moves ────────────────────────────────────── */
console.log('\nbetween hands');
{
  const g = table(3);
  const first = g.button;
  rotate(g); startHand(g);
  check(g.button !== first, 'the button moves on');
  check(g.players.every((p) => p.hole.length === 2 || p.stack === 0), 'everybody with chips is dealt two cards');
  const all = g.players.flatMap((p) => p.hole);
  check(new Set(all).size === all.length, 'no card is dealt twice');
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
