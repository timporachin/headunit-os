/*
 * Texas Hold'em: blinds, four betting rounds, side pots, showdown.
 *
 * The engine holds no opinions and draws nothing. It exposes the legal actions
 * for whoever is to act, applies one action at a time, and says what happened.
 * Both the screen and the bots drive it through the same door, which is what
 * stops the bots being able to do things you cannot.
 */

import { dealer } from './cards.mjs';
import { evaluateBest, describe } from './evaluate.mjs';

export const PREFLOP = 'preflop', FLOP = 'flop', TURN = 'turn', RIVER = 'river', SHOWDOWN = 'showdown';
const STREETS = [PREFLOP, FLOP, TURN, RIVER];

export function createGame({ seats, smallBlind = 25, bigBlind = 50, stack = 5000, button = 0 }) {
  const players = seats.map((s, i) => ({
    index: i, name: s.name, bot: !!s.bot, stack,
    hole: [], folded: false, allIn: false, committed: 0, total: 0, hasActed: false, lastAction: null,
  }));

  const game = {
    players, smallBlind, bigBlind, button,
    street: PREFLOP, board: [], deck: null,
    currentBet: 0, minRaise: bigBlind, toAct: -1,
    pots: [], log: [], result: null, handNumber: 0,
  };

  startHand(game);
  return game;
}

/** Everyone who can still make a decision. */
const live = (g) => g.players.filter((p) => !p.folded && !p.allIn && p.stack > 0);
/** Everyone still in the hand, all-in or not. */
const contesting = (g) => g.players.filter((p) => !p.folded);

function nextSeat(g, from) {
  const n = g.players.length;
  for (let step = 1; step <= n; step++) {
    const p = g.players[(from + step) % n];
    if (!p.folded && !p.allIn && p.stack > 0) return p.index;
  }
  return -1;
}

export function startHand(g) {
  g.handNumber++;
  g.deck = dealer();
  g.board = [];
  g.street = PREFLOP;
  g.pots = [];
  g.result = null;
  g.log = [];
  for (const p of g.players) {
    p.hole = p.stack > 0 ? g.deck.take(2) : [];
    p.folded = p.stack <= 0;      // busted players sit out rather than vanish
    p.allIn = false;
    p.committed = 0; p.total = 0;
    p.hasActed = false; p.lastAction = null;
  }

  /* Heads-up puts the button on the small blind and it acts first before the
     flop — the one place the seating order differs from a full table. */
  const seated = g.players.filter((p) => !p.folded);
  const headsUp = seated.length === 2;
  const sbSeat = headsUp ? g.button : seatAfter(g, g.button);
  const bbSeat = headsUp ? seatAfter(g, g.button) : seatAfter(g, sbSeat);

  post(g, g.players[sbSeat], g.smallBlind, 'small blind');
  post(g, g.players[bbSeat], g.bigBlind, 'big blind');
  g.currentBet = g.bigBlind;
  g.minRaise = g.bigBlind;
  g.toAct = headsUp ? sbSeat : seatAfter(g, bbSeat);
  /* The big blind has money in but has not chosen anything yet, so it still
     owes an action even if nobody raises. */
  for (const p of g.players) p.hasActed = false;
  return g;
}

function seatAfter(g, from) {
  const n = g.players.length;
  for (let step = 1; step <= n; step++) {
    const p = g.players[(from + step) % n];
    if (!p.folded) return p.index;
  }
  return from;
}

function post(g, p, amount, what) {
  const paid = Math.min(amount, p.stack);
  p.stack -= paid; p.committed += paid; p.total += paid;
  if (p.stack === 0) p.allIn = true;
  g.log.push(`${p.name} posts the ${what}`);
}

/** What the player to act may legally do. */
export function legalActions(g, index = g.toAct) {
  const p = g.players[index];
  if (!p || p.folded || p.allIn || g.street === SHOWDOWN) return null;
  const owed = g.currentBet - p.committed;
  const canCheck = owed === 0;
  const callAmount = Math.min(owed, p.stack);
  /* A raise has to lift the bet by at least the last raise, except when the
     player cannot cover that — then their whole stack is the only size left. */
  const minRaiseTo = g.currentBet + g.minRaise;
  const maxRaiseTo = p.committed + p.stack;
  return {
    canFold: true,
    canCheck,
    canCall: owed > 0,
    callAmount,
    canRaise: maxRaiseTo > g.currentBet,
    minRaiseTo: Math.min(minRaiseTo, maxRaiseTo),
    maxRaiseTo,
    isAllInOnly: maxRaiseTo <= minRaiseTo,
  };
}

/**
 * Apply one action. `raiseTo` is the total this player will have in front of
 * them, not the increment — sizes are stated the way a dealer states them.
 */
export function act(g, index, action, raiseTo = 0) {
  const legal = legalActions(g, index);
  if (!legal || index !== g.toAct) throw new Error('not this player to act');
  const p = g.players[index];

  if (action === 'fold') {
    p.folded = true; p.lastAction = 'fold';
    g.log.push(`${p.name} folds`);
  } else if (action === 'check') {
    if (!legal.canCheck) throw new Error('cannot check facing a bet');
    p.lastAction = 'check';
    g.log.push(`${p.name} checks`);
  } else if (action === 'call') {
    pay(g, p, legal.callAmount);
    p.lastAction = p.allIn ? 'all-in' : 'call';
    g.log.push(`${p.name} ${p.allIn ? 'calls all in' : 'calls ' + legal.callAmount}`);
  } else if (action === 'raise' || action === 'bet') {
    const target = Math.max(legal.minRaiseTo, Math.min(raiseTo, legal.maxRaiseTo));
    const increment = target - g.currentBet;
    pay(g, p, target - p.committed);
    /* Only a full raise re-opens the betting; a short all-in does not, which is
       why minRaise is left alone when the increment does not reach it. */
    if (increment >= g.minRaise) g.minRaise = increment;
    g.currentBet = Math.max(g.currentBet, target);
    for (const other of g.players) if (other !== p && !other.folded && !other.allIn) other.hasActed = false;
    p.lastAction = p.allIn ? 'all-in' : (action === 'bet' ? 'bet' : 'raise');
    g.log.push(`${p.name} ${p.allIn ? 'is all in for ' + target : action + 's to ' + target}`);
  } else {
    throw new Error(`unknown action ${action}`);
  }

  p.hasActed = true;
  advance(g);
  return g;
}

function pay(g, p, amount) {
  const paid = Math.min(Math.max(amount, 0), p.stack);
  p.stack -= paid; p.committed += paid; p.total += paid;
  if (p.stack === 0) p.allIn = true;
}

function advance(g) {
  if (contesting(g).length === 1) return finish(g);

  const owing = live(g).filter((p) => !p.hasActed || p.committed < g.currentBet);
  if (owing.length > 0) {
    g.toAct = nextSeat(g, g.toAct);
    if (g.toAct === -1) return nextStreet(g);
    return;
  }
  nextStreet(g);
}

function nextStreet(g) {
  for (const p of g.players) { p.committed = 0; p.hasActed = false; }
  g.currentBet = 0;
  g.minRaise = g.bigBlind;

  const at = STREETS.indexOf(g.street);
  if (at === STREETS.length - 1) return finish(g);

  g.street = STREETS[at + 1];
  if (g.street === FLOP) g.board.push(...g.deck.take(3));
  else g.board.push(...g.deck.take(1));

  /* Once one player is all in there is nothing left to decide, so the rest of
     the board is dealt and the hand goes straight to a showdown. */
  if (live(g).length <= 1) return nextStreet(g);

  g.toAct = nextSeat(g, g.button);
  if (g.toAct === -1) return nextStreet(g);
}

/**
 * Split what everyone put in into a main pot and however many side pots the
 * all-ins require, then award each to the best hand eligible for it.
 */
export function buildPots(g) {
  const stakes = [...new Set(g.players.filter((p) => p.total > 0).map((p) => p.total))].sort((a, b) => a - b);
  const pots = [];
  let previous = 0;
  for (const level of stakes) {
    let amount = 0;
    for (const p of g.players) amount += Math.min(p.total, level) - Math.min(p.total, previous);
    const eligible = g.players.filter((p) => !p.folded && p.total >= level).map((p) => p.index);
    if (amount > 0) pots.push({ amount, eligible });
    previous = level;
  }
  return pots;
}

function finish(g) {
  g.street = SHOWDOWN;
  g.toAct = -1;
  g.pots = buildPots(g);

  const still = contesting(g);
  const shown = still.length > 1;
  const strength = new Map();
  if (shown) {
    /* Deal out whatever board is missing so a hand that ended all-in early is
       still decided by cards rather than by who ran out of money. */
    while (g.board.length < 5) g.board.push(...g.deck.take(1));
    for (const p of still) strength.set(p.index, evaluateBest([...p.hole, ...g.board]));
  }

  const winnings = new Map();
  for (const pot of g.pots) {
    const runners = pot.eligible.filter((i) => !g.players[i].folded);
    if (runners.length === 0) continue;
    let winners;
    if (!shown) winners = [still[0].index];
    else {
      const best = Math.max(...runners.map((i) => strength.get(i)));
      winners = runners.filter((i) => strength.get(i) === best);
    }
    /* Odd chips go to the first seat left of the button, as at a real table. */
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    for (const i of winners) {
      let take = share;
      if (remainder > 0) { take++; remainder--; }
      winnings.set(i, (winnings.get(i) || 0) + take);
    }
  }
  for (const [i, amount] of winnings) g.players[i].stack += amount;

  g.result = {
    shown,
    board: [...g.board],
    winnings: [...winnings.entries()].map(([index, amount]) => ({ index, amount })),
    hands: shown ? [...strength.entries()].map(([index, value]) => ({ index, value, label: describe(value) })) : [],
  };
  for (const { index, amount } of g.result.winnings) g.log.push(`${g.players[index].name} wins ${amount}`);
  return g;
}

/** Move the button to the next seat with chips, for the following hand. */
export function rotate(g) {
  const n = g.players.length;
  for (let step = 1; step <= n; step++) {
    const seat = (g.button + step) % n;
    if (g.players[seat].stack > 0) { g.button = seat; break; }
  }
  return g;
}

export const potTotal = (g) => g.players.reduce((sum, p) => sum + p.total, 0);
