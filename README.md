# black-jack.io

black-jack.io is a browser-based multiplayer Blackjack game for playing with friends. Create a private table and share its invite link, or join a public table. Players join with a nickname and avatar; no account or download is required.

The game uses virtual chips and is intended for casual play. It does not support real-money betting.

## Features

- Private rooms with shareable invite links and public matchmaking
- Live multiplayer tables with chat, emotes, and host controls
- Configurable table settings, including player limit, starting chips, rounds, timers, deck count, and dealer rules
- Blackjack actions: hit, stand, double down, split, and surrender
- Optional strategy hints and hit bust-percentage estimates
- Round summaries, chip standings, and a winner screen
- Responsive browser interface with sound controls

## Getting started

### Requirements

- Node.js 18 or newer
- npm

### Run locally

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser. To invite someone to a private room, create a room in the app and share its generated link.

For local development, `npm run dev` starts the same server.

## How to play

Each player plays their hand against the dealer. The goal is to finish closer to 21 than the dealer without exceeding 21. A hand over 21 busts. A tie returns the wager.

Card values follow standard Blackjack rules: number cards count at face value, face cards count as 10, and an ace counts as 1 or 11 as appropriate. A natural Blackjack is an ace and a 10-value card in the initial two cards.

Players place bets, then act when their turn begins. Depending on the table settings and hand, they can hit, stand, double down, split a pair, or surrender. The dealer follows fixed rules and does not make player choices. By default, the dealer stands on soft 17, and a natural Blackjack pays 3:2.

## Table settings

The host can configure the number of players, starting chips, rounds, betting and turn timers, and number of decks. The host can also choose whether the dealer hits soft 17, select a 3:2 or 6:5 natural Blackjack payout, and enable or disable double down, splitting, surrender, and strategy coaching.

Default settings are five players, 1,000 starting chips, eight rounds, six decks, a 20-second betting timer, a 20-second turn timer, stand on soft 17, and 3:2 Blackjack payouts.

## Technology

- Node.js and Express serve the web application.
- Socket.IO synchronizes rooms, player actions, chat, and game state in real time.
- The Blackjack rules engine is in `game/engine.js`.
- The browser client and static assets are in `public/`.

Room and game state are held in server memory. Restarting the server clears active rooms and their game state.

## Project structure

```text
game/       Blackjack rules engine
public/     Browser client, styles, and static assets
server.js   Express server and Socket.IO room/game handling
```

## License

This project is licensed under the MIT License. See the `package.json` license field.
