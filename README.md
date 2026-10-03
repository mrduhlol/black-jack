# Blackjack

A real-time multiplayer Blackjack game built with Node.js, Express and Socket.IO.

## Features

- Real-time multiplayer Blackjack
- Private game rooms
- Room codes
- Real-time player synchronization
- Browser-based gameplay
- Server-authoritative game state

## Tech Stack

- Node.js
- Express
- Socket.IO
- JavaScript
- HTML
- CSS

## Getting Started

### Requirements

- Node.js 18 or newer
- npm

### Installation

```bash
git clone <repository-url>
cd black-jack
npm install
```

### Run locally

```bash
npm start
```

Then open:

http://localhost:3000

## Project Structure

```text
black-jack/
├── game/
│   └── engine.js        # Pure Blackjack rules engine (cards, hand values,
│                        # dealer logic, payouts). No sockets or I/O here.
├── public/
│   ├── index.html       # App markup (landing, table, sidebar, modals)
│   ├── client.js        # Browser client: Socket.IO wiring and table rendering
│   ├── styles.css       # All styling for the landing page and game table
│   ├── avatars.js       # Avatar generation helpers
│   ├── sounds.js        # Web Audio sound effects
│   ├── fx.js            # Canvas/confetti and visual effects
│   └── favicon.svg      # App icon
├── server.js            # Express static server + Socket.IO rooms and game flow
├── package.json         # Scripts and dependencies
├── package-lock.json    # Locked dependency tree
├── README.md            # This file
├── .gitignore           # Ignored files (node_modules, env files, logs, OS files)
└── LICENSE              # MIT License
```

`server.js` is the entry point: it serves the `public/` folder over HTTP and runs the Socket.IO server on the same port. All room state, betting, turns and payouts are decided on the server; the browser client only renders what the server sends.

## Deployment

The application can be deployed as a Node.js web service on platforms such as Render or Railway.

Build command:

```text
npm install
```

Start command:

```text
npm start
```

The server listens on the `PORT` environment variable (falling back to `3000` locally), so no extra configuration is needed. Make sure the platform exposes the web service port and keeps the process running.

## Important Notes

The current multiplayer room/game state is stored in server memory. Therefore active rooms may disappear if the server restarts or the deployment is restarted.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
