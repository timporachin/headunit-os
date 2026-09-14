/*
 * The Hold'em screen.
 *
 * Everything about the rules lives in engine/; this file decides what is on
 * the glass and when. Its one real job beyond drawing is pacing: a bot that
 * acts the instant it is asked turns four opponents into a single blur, so
 * each one is given a beat you can follow.
 */
import { createGame, act, legalActions, rotate, startHand, SHOWDOWN } from './engine/holdem.mjs';
import { decide, PERSONAS } from './engine/ai-holdem.mjs';
import { RANKS, SUITS, SUIT_GLYPH, rankOf, suitOf } from './engine/cards.mjs';

const $ = (id) => document.getElementById(id);
const el = {
  menu: $('menu'), felt: $('felt'), leave: $('leave'), playHoldem: $('playHoldem'),
  seats: $('seats'), board: $('board'), pot: $('pot'), you: $('you'),
  verdict: $('verdict'), blinds: $('blinds'), handNo: $('handNo'),
  actions: $('actions'), sizer: $('sizer'), slider: $('betSlider'), betAmount: $('betAmount'),
  fold: $('btnFold'), check: $('btnCheck'), call: $('btnCall'), raise: $('btnRaise'),
  next: $('next'), btnNext: $('btnNext'),
  busted: $('busted'), bustedText: $('bustedText'), btnRebuy: $('btnRebuy'),
};

const YOU = 0;
const THINK_MS = 620;          // long enough to read, short enough not to wait
const STACK = 5000, SB = 25, BB = 50;

let game = null;
let timer = null;

/* ── Cards ───────────────────────────────────────────────── */

function cardEl(card, faceDown = false) {
  const node = document.createElement('div');
  node.className = 'card' + (faceDown ? ' down' : '');
  if (faceDown) return node;
  const suit = SUITS[suitOf(card)];
  node.classList.add(suit === 'h' || suit === 'd' ? 'red' : 'black');
  const rank = document.createElement('span');
  rank.className = 'card-rank';
  rank.textContent = RANKS[rankOf(card)];
  const pip = document.createElement('span');
  pip.className = 'card-suit';
  pip.textContent = SUIT_GLYPH[suit];
  node.append(rank, pip);
  return node;
}

const chips = (n) => n.toLocaleString();

/* ── Drawing ─────────────────────────────────────────────── */

function render() {
  const g = game;
  el.blinds.textContent = `Blinds ${chips(g.smallBlind)} / ${chips(g.bigBlind)}`;
  el.handNo.textContent = `Hand ${g.handNumber}`;

  // opponents
  el.seats.replaceChildren(...g.players.filter((p) => p.index !== YOU).map((p) => {
    const seat = document.createElement('div');
    seat.className = 'seat';
    if (p.folded) seat.classList.add('out');
    if (g.toAct === p.index) seat.classList.add('acting');

    const name = document.createElement('div');
    name.className = 'seat-name';
    name.textContent = p.name + (g.button === p.index ? ' ⬤' : '');

    const cards = document.createElement('div');
    cards.className = 'seat-cards';
    const reveal = g.street === SHOWDOWN && g.result?.shown && !p.folded;
    if (p.hole.length) cards.append(...p.hole.map((c) => cardEl(c, !reveal)));

    const stack = document.createElement('div');
    stack.className = 'seat-stack';
    stack.textContent = p.stack > 0 ? chips(p.stack) : 'out';

    seat.append(name, cards, stack);
    if (p.committed > 0) {
      const bet = document.createElement('div');
      bet.className = 'seat-bet';
      bet.textContent = chips(p.committed);
      seat.append(bet);
    }
    if (p.lastAction) {
      const tag = document.createElement('div');
      tag.className = 'seat-action';
      tag.textContent = p.lastAction;
      seat.append(tag);
    }
    return seat;
  }));

  // board and pot
  el.board.replaceChildren(...g.board.map((c) => cardEl(c)));
  const total = g.players.reduce((s, p) => s + p.total, 0);
  el.pot.textContent = total > 0 ? `Pot ${chips(total)}` : '';

  // you
  const me = g.players[YOU];
  el.you.replaceChildren();
  const yourCards = document.createElement('div');
  yourCards.className = 'your-cards';
  if (me.hole.length) yourCards.append(...me.hole.map((c) => cardEl(c)));
  const yourStack = document.createElement('div');
  yourStack.className = 'your-stack';
  yourStack.textContent = `${me.name} · ${chips(me.stack)}` +
    (g.button === YOU ? ' · dealer' : '') + (me.committed ? ` · in ${chips(me.committed)}` : '');
  el.you.append(yourCards, yourStack);
  el.you.classList.toggle('acting', g.toAct === YOU);

  renderControls();
}

function renderControls() {
  const g = game;
  const over = g.street === SHOWDOWN;
  el.verdict.hidden = !over;
  if (over) el.verdict.textContent = verdictText();

  const myTurn = !over && g.toAct === YOU;
  el.actions.hidden = !myTurn;
  el.next.hidden = !over;
  el.busted.hidden = true;

  if (over && g.players[YOU].stack <= 0) {
    el.next.hidden = true;
    el.busted.hidden = false;
    el.bustedText.textContent = 'You are out of chips.';
  }
  if (!myTurn) return;

  const legal = legalActions(g, YOU);
  el.check.hidden = !legal.canCheck;
  el.call.hidden = !legal.canCall;
  el.call.textContent = legal.callAmount >= g.players[YOU].stack
    ? `Call all in ${chips(legal.callAmount)}` : `Call ${chips(legal.callAmount)}`;
  el.raise.hidden = !legal.canRaise;
  el.raise.textContent = legal.isAllInOnly ? 'All in'
    : (g.currentBet === 0 ? 'Bet' : 'Raise');
  el.sizer.hidden = !legal.canRaise || legal.isAllInOnly;

  if (!el.sizer.hidden) {
    el.slider.min = String(legal.minRaiseTo);
    el.slider.max = String(legal.maxRaiseTo);
    el.slider.step = String(g.smallBlind);
    if (+el.slider.value < legal.minRaiseTo || +el.slider.value > legal.maxRaiseTo) {
      el.slider.value = String(legal.minRaiseTo);
    }
    el.betAmount.textContent = chips(+el.slider.value);
  }
}

function verdictText() {
  const g = game;
  if (!g.result) return '';
  const parts = g.result.winnings.map(({ index, amount }) => {
    const who = g.players[index].name;
    const hand = g.result.hands.find((h) => h.index === index);
    return `${who} wins ${chips(amount)}${hand ? ` with ${hand.label.toLowerCase()}` : ''}`;
  });
  return parts.join(' · ') || 'Hand over';
}

/* ── Turn taking ─────────────────────────────────────────── */

function step() {
  clearTimeout(timer);
  render();
  if (game.street === SHOWDOWN) return;
  if (game.toAct === YOU || game.toAct < 0) return;

  const who = game.toAct;
  timer = setTimeout(() => {
    if (!game || game.toAct !== who || game.street === SHOWDOWN) return;
    const persona = PERSONAS[who % PERSONAS.length];
    const move = decide(game, who, persona);
    if (!move) return;
    act(game, who, move.action, move.raiseTo);
    step();
  }, THINK_MS);
}

function play(action, amount) {
  act(game, YOU, action, amount);
  step();
}

/* ── Wiring ──────────────────────────────────────────────── */

el.fold.addEventListener('click', () => play('fold'));
el.check.addEventListener('click', () => play('check'));
el.call.addEventListener('click', () => play('call'));
el.raise.addEventListener('click', () => {
  const legal = legalActions(game, YOU);
  const to = el.sizer.hidden ? legal.maxRaiseTo : +el.slider.value;
  play(game.currentBet === 0 ? 'bet' : 'raise', to);
});
el.slider.addEventListener('input', () => { el.betAmount.textContent = chips(+el.slider.value); });

for (const button of document.querySelectorAll('.sizer-row button')) {
  button.addEventListener('click', () => {
    const legal = legalActions(game, YOU);
    if (!legal) return;
    const pot = game.players.reduce((s, p) => s + p.total, 0);
    const size = button.dataset.size;
    /* A pot-sized raise is "call, then raise what is in the middle after that
       call" — currentBet + f * (pot + callAmount) — not the min raise plus a
       slice of the pot, which is what this did first and which quietly sized
       a half-pot raise about a quarter too big. */
    const want = size === 'max'
      ? legal.maxRaiseTo
      : game.currentBet + Number(size) * (pot + legal.callAmount);
    el.slider.value = String(Math.max(legal.minRaiseTo, Math.min(Math.round(want / game.smallBlind) * game.smallBlind, legal.maxRaiseTo)));
    el.betAmount.textContent = chips(+el.slider.value);
  });
}

el.btnNext.addEventListener('click', () => {
  rotate(game); startHand(game); step();
});
el.btnRebuy.addEventListener('click', () => { newGame(); });

el.playHoldem.addEventListener('click', () => {
  newGame();
  el.menu.hidden = true;
  el.felt.hidden = false;
  if (window.headunit) { headunit.setImmersive(true); headunit.setTitle("Texas Hold'em"); }
});

el.leave.addEventListener('click', () => {
  clearTimeout(timer);
  el.felt.hidden = true;
  el.menu.hidden = false;
  if (window.headunit) { headunit.setImmersive(false); headunit.setTitle('Poker'); }
});

function newGame() {
  clearTimeout(timer);
  const seats = [{ name: 'You' }, ...PERSONAS.slice(0, 4).map((p) => ({ name: p.name, bot: true }))];
  game = createGame({ seats, smallBlind: SB, bigBlind: BB, stack: STACK, button: 0 });
  el.busted.hidden = true;
  step();
}

if (window.headunit) {
  headunit.ready(() => headunit.setTitle('Poker'));
  headunit.on('background', () => clearTimeout(timer));
  headunit.on('foreground', () => { if (game && !el.felt.hidden) step(); });
}

/* Exposed for the browser test to drive the table without clicking. */
globalThis.__poker = { get game() { return game; }, play, step, newGame };
