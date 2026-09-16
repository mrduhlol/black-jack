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

## Round flow (standard casino order)

1. Place bets (chips, no real money in v1 — fun credits).
2. Deal: each player gets 2 face-up cards, dealer gets 1 upcard + 1 hole card face-down.
3. Peek/check: if dealer shows Ace or 10-value, check for dealer Blackjack before players act (variant-dependent).
4. Players act in turn order, one hand at a time.
5. Dealer reveals hole card and plays by fixed rules (no choices).
6. Settle: compare each remaining player hand vs dealer, pay / take / push.

## Player actions

- Hit: take another card. Can repeat until stand or bust.
- Stand: keep total, end your turn. Always stand hard 17+.
- Double down: double bet, take exactly 1 more card, then done. Typical spot: hard 10/11 vs weak dealer card.
- Split: if first two cards are a pair, pay a second bet and play two hands. Always split Aces and 8s, never split 10s or 5s. Split Aces usually get 1 card each.
- Surrender (where offered): forfeit half bet and end hand on first two cards. Typical: hard 16 vs 9/10/Ace, hard 15 vs 10.
- Insurance: side bet (half stake) when dealer shows Ace, pays 2:1 if dealer has Blackjack. Bad odds — basic strategy says never take it.

## Dealer rules (fixed, no choices)

- Must hit 16 or below, must stand 17 or above.
- S17 = stands on all 17s incl. soft 17 (A+6). Better for player.
- H17 = hits soft 17. Adds ~0.2% house edge.
- Dealer cannot split, double, or surrender. If dealer busts, all remaining player hands win.
- black-jack.io default: 6-deck shoe, dealer stands on soft 17 (S17), Blackjack pays 3:2, dealer peeks for Blackjack.

## Payouts

- Win = 1:1 (bet $10, win $10 + stake back).
- Natural Blackjack = 3:2 ($10 wins $15). Avoid 6:5 tables (+1.39% house edge).
- Push = stake returned.
- Surrender = lose half bet.
- Bust = lose immediately.
- Dealer Blackjack beats all non-Blackjack hands; player Blackjack vs dealer Blackjack = push.

## How it plays like skribbl.io (rooms, not matchmaking)

skribbl.io loop: create private room -> share link -> host sets players/rounds/draw-time -> everyone joins with a nickname -> host starts -> rotating turns -> live canvas + chat guessing -> points -> winner crowned.

black-jack.io mirrors that:

- Home: enter nickname -> Play (public table) or Create Private Room.
- Private room link like `black-jack.io/?XXXXXX` — friends join anytime from browser, no account.
- Lobby: player list with avatars/chip stacks, chat before start, host badge.
- Host controls: max players (2–7 + dealer), starting chips, number of rounds/shoes, turn timer (e.g. 15–30s per decision), S17/H17 toggle, 3:2/6:5 toggle, allow surrender / insurance / split / double toggles.
- Game: all players sit at one virtual table vs one dealer (bot dealer, server-authoritative). Turn order left-to-right, action buttons Hit/Stand/Double/Split/Surrender with countdown timer. Auto-stand on timeout.
- Live sync via WebSocket (Socket.IO): joinRoom, placeBet, playerAction, dealerPlay, roundSettle, chatMessage.
- Scoring: chip stacks persist across rounds. Busted-out players spectate. After N rounds, richest stack is crowned winner.
- Moderation like skribbl.io: host kick/ban, votekick, mute, report.

## Tech plan (v1)

- Frontend: single-page web app (HTML/CSS/JS), table UI, no download.
- Backend: Node.js + Socket.IO (same stack pattern as skribbl.io), server-authoritative shoe + dealer logic.
- One shared shoe per room (6 decks, reshuffle at ~75% penetration), server deals, validates actions, broadcasts state.
- Fun credits only — no real money, no gambling license needed for party play.

## Roadmap

- [x] README with real rules (this file)
- [ ] Room lobby + invite links + nickname join (waiting for your order to build)
- [ ] Single-table Blackjack engine (deal, hit/stand/double/split/surrender, S17 dealer, 3:2 payout)
- [ ] Multiplayer sync + timers + chat + host controls
- [ ] Rounds, chip leaderboard, winner screen
- [ ] Polish: avatars, sounds, mobile layout, reconnect

## Disclaimer

Party game for fun with friends using virtual chips. Not a casino, no real-money betting. If you add real money later, gambling laws and licenses apply.

---
Status: README done. Awaiting order to build black-jack.io.
