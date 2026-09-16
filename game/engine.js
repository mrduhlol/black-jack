// Pure Blackjack engine — no sockets, no state. Shared rules for black-jack.io.
// Default table: 6 decks, S17, Blackjack pays 3:2, dealer peeks.

function cardValue(rank) {
  if (rank === 'A') return 11;
  if (['K', 'Q', 'J'].includes(rank)) return 10;
  return parseInt(rank, 10);
}

function handValue(cards) {
  // cards: [{rank:'A'|'K'|..., suit:'♠'|...}]
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardValue(c.rank);
    if (c.rank === 'A') aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  const soft = aces > 0;
  return { total, soft, bust: total > 21 };
}

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

function createShoe(numDecks = 6) {
  const shoe = [];
  for (let d = 0; d < numDecks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        shoe.push({ rank, suit });
      }
    }
  }
  // Fisher-Yates shuffle
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function isBlackjack(cards) {
  if (cards.length !== 2) return false;
  return handValue(cards).total === 21;
}

// Dealer plays by fixed rules. S17 default, H17 optional.
function dealerShouldHit(cards, hitSoft17 = false) {
  const { total, soft } = handValue(cards);
  if (total < 17) return true;
  if (total > 17) return false;
  // total === 17
  if (soft) return hitSoft17;
  return false;
}

function bustChance(cards) {
  // Party feature: live bust % if you hit now. Counts ranks remaining naively (infinite deck approx).
  const { total, soft } = handValue(cards);
  if (soft) return 0; // soft hand cannot bust on one card
  const bustAt = 22 - total; // need this value or higher to bust
  if (bustAt > 11) return 0;
  // values 2..11, with 10-valued = 16/52 approx using infinite deck: 10,J,Q,K = 16/13? use standard 52-deck weights
  // weights: A=4, 2-9=4 each, 10-value=16
  let bustCards = 0;
  const weights = { A: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 16 };
  for (const [rank, w] of Object.entries(weights)) {
    const v = rank === 'A' ? 11 : rank === '10' ? 10 : parseInt(rank, 10);
    if (v >= bustAt) bustCards += w;
  }
  return Math.round((bustCards / 52) * 100);
}

module.exports = { cardValue, handValue };
