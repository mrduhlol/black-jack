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

module.exports = { cardValue, handValue };
