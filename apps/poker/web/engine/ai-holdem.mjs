/*
 * The opponents.
 *
 * Equity by rollout rather than by hand-chart: deal the unknown cards out at
 * random a few hundred times and count how often this hand ends up ahead. It
 * is slower than a lookup table and it is never wrong about a board, which
 * matters more — a chart that does not know the board cannot tell a flush draw
 * from a dead one.
 *
 * On top of equity sits pot odds, which decide calls, and a per-bot appetite
 * for aggression, which decides everything else. Without the appetite every
 * bot plays the identical solved line and the table becomes a calculator you
 * can read; with it, they are recognisably different players.
 */

import { evaluateBest } from './evaluate.mjs';
import { legalActions } from './holdem.mjs';

export const PERSONAS = [
  { name: 'Roy',  aggression: 0.55, bluff: 0.10, looseness: 0.92 },
  { name: 'Dot',  aggression: 0.30, bluff: 0.04, looseness: 0.72 },  // rock
  { name: 'Cal',  aggression: 0.85, bluff: 0.22, looseness: 1.18 },  // maniac
  { name: 'June', aggression: 0.50, bluff: 0.12, looseness: 1.00 },
  { name: 'Wes',  aggression: 0.68, bluff: 0.16, looseness: 1.06 },
];

/** Cards nobody has seen: the deck minus this bot's hole cards and the board. */
function unseen(hole, board) {
  const out = [];
  const taken = new Set([...hole, ...board]);
  for (let c = 0; c < 52; c++) if (!taken.has(c)) out.push(c);
  return out;
}

/**
 * Share of the pot this hand expects to win against `opponents` random hands.
 * Ties count as a split rather than a win, or the bot over-values chops.
 */
export function equity(hole, board, opponents, trials = 300) {
  const pool = unseen(hole, board);
  const need = 5 - board.length;
  let score = 0;

  for (let t = 0; t < trials; t++) {
    /* Partial Fisher-Yates: only shuffle the cards this trial actually needs. */
    const draw = need + opponents * 2;
    for (let i = 0; i < draw; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    let at = 0;
    const full = board.concat(pool.slice(at, at += need));
    const mine = evaluateBest(hole.concat(full));
    let better = 0, equal = 0;
    for (let o = 0; o < opponents; o++) {
      const theirs = evaluateBest([pool[at++], pool[at++]].concat(full));
      if (theirs > mine) { better++; break; }
      if (theirs === mine) equal++;
    }
    if (better === 0) score += 1 / (1 + equal);
  }
  return score / trials;
}

/**
 * One decision. Returns { action, raiseTo } ready to hand to act().
 *
 * Rollouts are cheaper on later streets because fewer cards are unknown, so
 * the preflop count is kept low and the river gets the most — that is where a
 * wrong answer costs the most chips.
 */
export function decide(game, index, persona = PERSONAS[0]) {
  const legal = legalActions(game, index);
  if (!legal) return null;
  const me = game.players[index];
  const others = game.players.filter((p) => p !== me && !p.folded).length;
  const trials = game.board.length === 0 ? 160 : game.board.length === 5 ? 420 : 300;

  const raw = equity(me.hole, game.board, Math.max(1, others), trials);
  /* Looseness bends the read rather than replacing it: a maniac genuinely
     believes its hand is better than it is. */
  const strength = Math.min(0.98, raw * persona.looseness);

  const pot = game.players.reduce((sum, p) => sum + p.total, 0);
  const toCall = legal.callAmount;
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

  // Nothing to call: check, or take a stab at it.
  if (legal.canCheck) {
    const wantsToBet = strength > 0.58 + (1 - persona.aggression) * 0.18;
    const bluffing = strength < 0.35 && Math.random() < persona.bluff;
    if ((wantsToBet || bluffing) && legal.canRaise) {
      return { action: 'bet', raiseTo: sizeBet(game, legal, pot, strength, persona) };
    }
    return { action: 'check' };
  }

  // Facing a bet.
  if (strength < potOdds * 0.92) {
    /* Priced out — but folding every single time makes a bot readable, so a
       little of the worst of it comes along anyway. */
    if (toCall <= game.bigBlind && Math.random() < 0.30) return { action: 'call' };
    return { action: 'fold' };
  }

  const raiseThreshold = 0.70 - persona.aggression * 0.14;
  if (strength > raiseThreshold && legal.canRaise && Math.random() < persona.aggression) {
    return { action: 'raise', raiseTo: sizeBet(game, legal, pot, strength, persona) };
  }
  return { action: 'call' };
}

/** Bet sizing as a fraction of the pot, jittered so it is not a tell. */
function sizeBet(game, legal, pot, strength, persona) {
  const base = 0.45 + strength * 0.55 + persona.aggression * 0.25;
  const jitter = 0.85 + Math.random() * 0.3;
  const target = legal.minRaiseTo + pot * base * jitter;
  const rounded = Math.round(target / game.smallBlind) * game.smallBlind;
  return Math.max(legal.minRaiseTo, Math.min(rounded, legal.maxRaiseTo));
}
