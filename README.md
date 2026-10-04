<div align="center">
  <img src="public/favicon.svg" alt="Black-Jack.io logo" width="88" height="88">
  <h1>BLACK-JACK.IO</h1>
  <p>Multiplayer Blackjack, played with friends. No account, no real money.</p>
  <p><a href="https://black-jack.abhishek-a.in"><strong>PLAY HERE</strong></a></p>
</div>

![Black-Jack.io gameplay preview](docs/preview.png)

## About this website

Black-Jack.io is a browser-based multiplayer Blackjack game. Create a private table and share its invite link, or join a public table. Players join with a nickname and avatar. Everything runs on virtual chips.

## How to play

1. Open the website and pick a nickname (optionally customize your avatar style and background).
2. Join a table:
   - **Play now** joins a public table with free seats.
   - Enter a **room code** and choose **Join room** to join a friend's private table.
   - **Create a private room** to start your own table, then share the invite link or room code.
3. Place your bet by tapping chips, then choose **Place bet**.
4. When your turn starts, choose **Hit**, **Stand**, **Double**, **Split**, or **Surrender** (availability depends on your hand and the table settings).
5. The host can start the game from the lobby and change table settings before starting.
6. After the set number of rounds, the player with the most chips wins.

## Rules

### Goal

Get as close to 21 as you can without going over. Each player competes against the dealer, not against other players.

### Card values

- Number cards count at face value.
- Jacks, queens, and kings count as 10.
- An ace counts as 1 or 11, whichever keeps your hand at 21 or less.
- An ace and a 10-value card in your first two cards is a natural Blackjack.

### Your moves

- **Hit**: take another card. Go over 21 and your hand busts.
- **Stand**: keep your current total.
- **Double down**: double your bet, take exactly one more card, then stand.
- **Split**: with a pair, split into two hands (each with its own bet).
- **Surrender**: give up the hand and get half your bet back.

The dealer plays after everyone finishes and follows fixed rules instead of making choices.

### Beating the dealer

- A higher total than the dealer without busting wins.
- If the dealer busts, all remaining hands win.
- Equal totals push and your bet is returned.
- By default, the dealer stands on soft 17, a regular win pays 1:1, and a natural Blackjack pays 3:2.

The host can adjust the table: number of players, starting chips, rounds, timers, decks, soft-17 rule, Blackjack payout (3:2 or 6:5), and which actions are allowed. All chips are virtual.

## Run it yourself

Requirements: Node.js 18 or newer, npm.

```bash
git clone <repository-url>
cd black-jack
npm install
npm run dev
```

Then open the URL shown in the terminal (usually http://localhost:8787).

MIT. See [LICENSE](LICENSE).
