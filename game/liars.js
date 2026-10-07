// Pure Liar's Table engine — no sockets, no state.
// Authentic Liar's Deck rules: a 20-card deck (6 Kings, 6 Queens, 6 Aces,
// 2 Jokers). Jokers are wild — they always count as the table rank.
// Each player is dealt 5 cards; the table names one rank (K, Q or A) per
// round; on a turn a player lays 1–3 cards face-down declaring the table
// rank (truthfully or not), and the next player may call LIAR.
// Runs unchanged in the Cloudflare Worker/Durable Object and in tests.

const TABLE_RANKS = ['K', 'Q', 'A'];
const JOKER_RANK = 'JOKER';
const JOKER_SUIT = '★';
const SUITS = ['♠', '♥', '♦', '♣'];
const HAND_SIZE = 5;
const MAX_PLAY = 3;

function isJoker(card) {
  return !!card && card.rank === JOKER_RANK;
}

function buildDeck() {
  const deck = [];
  let n = 0;
  for (const rank of TABLE_RANKS) {
    for (let k = 0; k < 6; k++) {
      n += 1;
      deck.push({ id: `c${n}`, rank, suit: SUITS[k % SUITS.length] });
    }
  }
  for (let j = 0; j < 2; j++) {
    n += 1;
    deck.push({ id: `c${n}`, rank: JOKER_RANK, suit: JOKER_SUIT });
  }
  return deck;
}

function shuffle(cards) {
  const arr = cards.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Deal HAND_SIZE cards to each player. Leftover cards are set aside
// (returned as `leftover`) and never enter play.
function dealHands(playerIds, handSize = HAND_SIZE) {
  const deck = shuffle(buildDeck());
  const hands = {};
  for (const pid of playerIds) hands[pid] = [];
  const per = Math.max(0, handSize | 0);
  const usable = Math.min(deck.length, per * playerIds.length);
  for (let k = 0; k < usable; k++) {
    hands[playerIds[k % playerIds.length]].push(deck[k]);
  }
  return { hands, leftover: deck.slice(usable) };
}

function randomTableRank() {
  return TABLE_RANKS[Math.floor(Math.random() * TABLE_RANKS.length)];
}

// A challenge is truthful only if EVERY played card matches the table rank.
// Jokers are wild and always count as the table rank.
function judgeChallenge(playedCards, tableRank) {
  if (!playedCards || playedCards.length === 0) return false;
  return playedCards.every((c) => isJoker(c) || c.rank === tableRank);
}

// Build a fresh risk chamber: `chambers` slots, `live` of them loaded,
// shuffled so positions are unpredictable. Returns slot states hidden
// from players (`live` flags stay server-side until picked).
function buildChamber(chambers, live) {
  const slots = [];
  for (let i = 0; i < chambers; i++) slots.push({ live: i < live, picked: false });
  return shuffle(slots);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export {
  TABLE_RANKS,
  JOKER_RANK,
  JOKER_SUIT,
  SUITS,
  HAND_SIZE,
  MAX_PLAY,
  isJoker,
  buildDeck,
  shuffle,
  dealHands,
  randomTableRank,
  judgeChallenge,
  buildChamber,
  plural,
};
