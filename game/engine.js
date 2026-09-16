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

// Basic-strategy coach: simplified hint for hard/soft/pairs vs dealer upcard.
function coachHint(playerCards, dealerUp) {
  const { total, soft } = handValue(playerCards);
  const d = dealerUp.rank === 'A' ? 11 : cardValue(dealerUp.rank);
  const pair = playerCards.length === 2 && playerCards[0].rank === playerCards[1].rank
    ? playerCards[0].rank : null;

  if (pair === 'A' || pair === '8') return 'Split';
  if (pair === '10' || pair === 'J' || pair === 'Q' || pair === 'K') return 'Stand (never split 10s)';
  if (soft) {
    if (total <= 17) return 'Hit (soft — cannot bust)';
    if (total === 18) return (d >= 9 || d <= 2) ? 'Hit' : d >= 3 && d <= 6 ? 'Double if allowed, else Stand' : 'Stand';
    return 'Stand';
  }
  if (total <= 8) return 'Hit';
  if (total === 9) return (d >= 3 && d <= 6) ? 'Double if allowed, else Hit' : 'Hit';
  if (total === 10) return (d <= 9) ? 'Double if allowed, else Hit' : 'Hit';
  if (total === 11) return d === 11 ? 'Hit' : 'Double if allowed, else Hit';
  if (total === 12) return (d >= 4 && d <= 6) ? 'Stand' : 'Hit';
  if (total >= 13 && total <= 16) return (d >= 2 && d <= 6) ? 'Stand' : 'Hit';
  return 'Stand';
}

function settleBet(playerCards, dealerCards, bet, opts = {}) {
  // Returns { outcome, payout } where payout = chips returned (incl. stake).
  const bjPay = opts.blackjackPays === '6:5' ? 1.2 : 1.5;
  const pBJ = isBlackjack(playerCards);
  const dBJ = isBlackjack(dealerCards);
  const p = handValue(playerCards);
  const d = handValue(dealerCards);
  if (pBJ && dBJ) return { outcome: 'push', payout: bet };
  if (pBJ) return { outcome: 'blackjack', payout: Math.floor(bet + bet * bjPay) };
  if (dBJ) return { outcome: 'lose', payout: 0 };
  if (p.bust) return { outcome: 'bust', payout: 0 };
  if (d.bust) return { outcome: 'win', payout: bet * 2 };
  if (p.total > d.total) return { outcome: 'win', payout: bet * 2 };
  if (p.total < d.total) return { outcome: 'lose', payout: 0 };
  return { outcome: 'push', payout: bet };
}

module.exports = { cardValue, handValue, createShoe, isBlackjack, dealerShouldHit, bustChance, coachHint, settleBet, RANKS, SUITS };
