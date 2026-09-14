/*
 * Cards, and a shuffle you can trust.
 *
 * A card is one integer, 0..51: rank = card >> 2, suit = card & 3. Ranks run
 * 0..12 for deuce..ace. Keeping a card as a number rather than an object is
 * what lets the evaluator do its work with bit operations instead of string
 * comparisons, and a hand is then just an array of five or seven small ints.
 */

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['c', 'd', 'h', 's'];
export const SUIT_GLYPH = { c: '♣', d: '♦', h: '♥', s: '♠' };

export const rankOf = (card) => card >> 2;
export const suitOf = (card) => card & 3;
export const cardName = (card) => RANKS[rankOf(card)] + SUITS[suitOf(card)];

/** "As" / "Td" back to a card number. Used by tests and by hand-written fixtures. */
export function parseCard(text) {
  const r = RANKS.indexOf(text[0].toUpperCase());
  const s = SUITS.indexOf(text[1].toLowerCase());
  if (r < 0 || s < 0) throw new Error(`not a card: ${text}`);
  return (r << 2) | s;
}

export const parseHand = (text) => text.trim().split(/\s+/).map(parseCard);

export const freshDeck = () => Array.from({ length: 52 }, (_, i) => i);

/*
 * Randomness.
 *
 * Math.random is seeded per page and is not required to be unpredictable; a
 * card game that can deal the same sequence twice is not worth playing. This
 * takes bytes from the platform CSPRNG and throws away the ones that would
 * skew the result — without the rejection, a 256-value byte folded into a
 * 52-card range makes the low cards measurably likelier, which is exactly the
 * kind of bias nobody notices and everybody would object to.
 */
const cryptoSource = globalThis.crypto;

function randomBelow(bound) {
  if (bound <= 1) return 0;
  const limit = Math.floor(256 / bound) * bound;   // largest whole multiple
  const byte = new Uint8Array(1);
  for (;;) {
    cryptoSource.getRandomValues(byte);
    if (byte[0] < limit) return byte[0] % bound;
  }
}

/** Fisher-Yates, in place, unbiased. Returns the same array for convenience. */
export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}

/** A dealer that hands out cards from the top and cannot repeat itself. */
export function dealer(deck = shuffle(freshDeck())) {
  let next = 0;
  return {
    take(n = 1) {
      if (next + n > deck.length) throw new Error('the deck is out of cards');
      return deck.slice(next, next += n);
    },
    get remaining() { return deck.length - next; },
    /** What is left, for equity rollouts that must not deal cards already out. */
    rest() { return deck.slice(next); },
  };
}
