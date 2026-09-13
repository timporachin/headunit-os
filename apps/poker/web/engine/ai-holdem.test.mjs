/*
 * The bots' arithmetic, against numbers that are not mine.
 *
 *   node apps/poker/web/engine/ai-holdem.test.mjs
 *
 * Heads-up preflop equities against a random hand are long-settled figures. If
 * the rollout agrees with them it is measuring the right thing; if it does not,
 * no amount of tuning the personas will save the table.
 */
import { equity, decide, PERSONAS } from './ai-holdem.mjs';
import { parseHand } from './cards.mjs';
import { createGame, act, legalActions, SHOWDOWN, rotate, startHand } from './holdem.mjs';

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };

console.log('\nequity against one random hand (published figures)');
const KNOWN = [
  ['As Ad', 0.852, 'pocket aces'],
  ['Ks Kd', 0.824, 'pocket kings'],
  ['7s 2h', 0.346, 'seven-deuce offsuit'],
  ['As Ks', 0.670, 'ace-king suited'],
  ['2s 2d', 0.503, 'pocket deuces'],
];
for (const [cards, expected, label] of KNOWN) {
  const got = equity(parseHand(cards), [], 1, 24000);
  const off = Math.abs(got - expected);
  check(off < 0.012, `${label.padEnd(22)} ${(got * 100).toFixed(1)}%  (known ${(expected * 100).toFixed(1)}%, off by ${(off * 100).toFixed(2)} points)`);
}

console.log('\nequity on a finished board');
{
  // the nuts on the river: nothing can beat it
  const e = equity(parseHand('As Ks'), parseHand('Qs Js Ts 4d 3c'), 1, 3000);
  check(e > 0.995, `a royal flush on the river wins ${(e * 100).toFixed(1)}% of the time`);
}
{
  // drawing dead against a board that already plays
  const e = equity(parseHand('2c 3d'), parseHand('As Ks Qs Js Ts'), 1, 3000);
  check(e > 0.45 && e < 0.55, `a board that plays for everyone chops ${(e * 100).toFixed(0)}% of the time`);
}
{
  const more = equity(parseHand('As Ad'), [], 1, 6000);
  const fewer = equity(parseHand('As Ad'), [], 4, 6000);
  check(more > fewer, `aces are worth less against four opponents (${(more * 100).toFixed(0)}% vs ${(fewer * 100).toFixed(0)}%)`);
}

console.log('\nthe bots actually play');
{
  const tally = { fold: 0, check: 0, call: 0, bet: 0, raise: 0 };
  let hands = 0, stuck = 0;
  const g = createGame({ seats: PERSONAS.slice(0, 4).map((p) => ({ name: p.name, bot: true })), stack: 4000 });
  for (let h = 0; h < 120; h++) {
    let guard = 0;
    while (g.street !== SHOWDOWN && guard++ < 300) {
      const who = g.toAct;
      const move = decide(g, who, PERSONAS[who % PERSONAS.length]);
      if (!move) break;
      tally[move.action === 'bet' ? 'bet' : move.action]++;
      act(g, who, move.action, move.raiseTo);
    }
    if (guard >= 300) stuck++;
    hands++;
    if (g.players.filter((p) => p.stack > 0).length < 2) break;
    rotate(g); startHand(g);
  }
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  check(stuck === 0, `${hands} hands all reached a showdown or a fold (none stalled)`);
  check(tally.fold / total < 0.60, `folds are ${(tally.fold / total * 100).toFixed(0)}% of actions (a table that folds everything is not a game)`);
  check(tally.bet + tally.raise > 0, `bets and raises happen (${tally.bet + tally.raise} of ${total} actions)`);
  check(tally.call > 0, `calls happen (${tally.call})`);
  console.log(`    mix: ${Object.entries(tally).map(([k, v]) => `${k} ${(v / total * 100).toFixed(0)}%`).join(', ')}`);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
