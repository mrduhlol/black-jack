// Pure Liar's Bar engine — no sockets, no state.
// Standard 52-card deck, bluffing loop: a table rank is announced each
// round, players lay cards face-down declaring a count of that rank
// (truthfully or not), and the next player may call LIAR.
// Runs unchanged in the Cloudflare Worker/Durable Object and in tests.

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

function buildDeck() {
  const deck = [];
  let n = 0;
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      n += 1;
      deck.push({ id: `c${n}`, rank, suit });
    }
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

// Deal the deck out as evenly as possible. Leftover cards are set aside
// (returned as `leftover`) and never enter play.
function dealHands(playerIds) {
  const deck = shuffle(buildDeck());
  const hands = {};
  for (const pid of playerIds) hands[pid] = [];
  let i = 0;
  const per = Math.floor(deck.length / Math.max(1, playerIds.length));
  const usable = per * playerIds.length;
  for (let k = 0; k < usable; k++) {
    hands[playerIds[k % playerIds.length]].push(deck[k]);
  }
  return { hands, leftover: deck.slice(usable) };
}

function randomTableRank() {
  return RANKS[Math.floor(Math.random() * RANKS.length)];
}

// A challenge is truthful only if EVERY played card matches the table rank.
function judgeChallenge(playedCards, tableRank) {
  if (!playedCards || playedCards.length === 0) return false;
  return playedCards.every((c) => c.rank === tableRank);
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

export { RANKS, SUITS, buildDeck, shuffle, dealHands, randomTableRank, judgeChallenge, buildChamber, plural };
