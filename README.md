# black-jack.io

Multiplayer online Blackjack party game — inspired by skribbl.io, but for Blackjack.

Play with friends: create a private room, share the link, sit at a virtual table together, and play rounds live. No download, browser-based, room-based, host-controlled — just like skribbl.io is for drawing, black-jack.io is for Blackjack.

## Objective (real casino rules)

- Beat the dealer, not the other players. Each hand is you vs dealer.
- Get closer to 21 than the dealer without going over 21 (bust).
- You win if: your total > dealer total (no bust), dealer busts and you don't, or you hit a natural Blackjack and dealer doesn't.
- You lose if: you bust (lose immediately, even if dealer busts later), or dealer total > yours.
- Tie = push: bet returned, no win, no loss.

## Card values

- 2–10 = face value (e.g. 7 = 7).
- J / Q / K = 10.
- Ace = 1 or 11, whichever keeps the hand valid.
- Soft hand = Ace counted as 11 (e.g. A+6 = soft 17, cannot bust on one hit).
- Hard hand = no Ace, or Ace forced to 1 (e.g. 10+7 = hard 17, A+6+10 = hard 17).
- Natural Blackjack = Ace + 10-value card on first two cards only. 21 with 3+ cards is just 21, not a natural.
