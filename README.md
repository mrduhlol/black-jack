# Blackjack

Real-time multiplayer Blackjack game.

## Features

- Real-time multiplayer Blackjack
- Private game rooms with shareable room codes
- Public matchmaking ("Play now" finds a lobby table with a free seat)
- Real-time player synchronization over WebSockets
- Browser-based gameplay, no account required
- Server-authoritative game state and results

## Tech Stack

- Cloudflare Workers (HTTP + WebSocket front door, static frontend hosting)
- Cloudflare Durable Objects (one `GameRoom` instance per room code, plus a `LobbyDirectory` for matchmaking)
- Native WebSockets (browser ↔ Worker ↔ Durable Object)
- TypeScript (Worker and Durable Objects), JavaScript + HTML + CSS frontend
- Wrangler (local dev, types, deployment)

## Architecture

```text
Browser ──HTTPS/WSS──▶ Cloudflare Worker ──▶ GameRoom Durable Object ──▶ Game Room
   │                          │                    (WebSocket, authoritative
   │                          │                     cards / turns / payouts)
   │                          └──────────────▶ LobbyDirectory Durable Object
   │                                           (public matchmaking, room codes)
   └── static frontend served from ./public ──▶ index.html / client.js / styles.css
```

- The **Worker** (`src/index.ts`) serves the frontend, exposes `/health` and the `/api/*` room endpoints, and forwards `/room/:code/socket` WebSocket upgrades to the correct Durable Object.
- Each room code maps deterministically to one **GameRoom** instance (`GAME_ROOM.idFromName('room:' + code)`), so all players in a room always share the same authoritative state. Room state is also persisted to Durable Object storage, so a table survives instance restarts.
- Public matchmaking is coordinated by a single **LobbyDirectory** instance that tracks lobby occupancy reported by rooms.
- There is no database, no Redis, and no external WebSocket server. The old Node.js/Express/Socket.IO server has been removed; there is no always-on Node process in production.

### WebSocket protocol

Client → server (JSON, `{ t, ... }`):

| message        | payload                                              |
| -------------- | ---------------------------------------------------- |
| `join`         | `{ playerId, name, avatar, create }`                 |
| `leave`        | —                                                    |
| `set_settings` | table settings patch (host, lobby only)              |
| `start_game`   | — (host)                                             |
| `place_bet`    | `{ amount }`                                         |
| `action`       | `{ kind: hit \| stand \| double \| split \| surrender }` |
| `chat`         | `{ text }`                                           |
| `emote`        | `{ emoji }`                                          |
| `kick`         | `{ targetId }` (host)                                |
| `rematch`      | — (host)                                             |

Server → client:

| message        | payload                                              |
| -------------- | ---------------------------------------------------- |
| `room`         | full room snapshot (personalized `isYou` per player) |
| `phase`        | `{ phase, round, endsIn }`                           |
| `your_turn`    | `{ handIndex, cards, dealerUp, hint, bustChance, endsIn }` |
| `action_error` | `{ message }`                                        |
| `chat` / `emote` | table chat / reactions                             |
| `settle`       | `{ dealer, dealerTotal, dealerBust, results, note }` |
| `gameover`     | `{ board }`                                          |
| `error`        | `{ message }` (e.g. room not found, room full)       |
| `kicked`       | `{ text }`                                           |

## Local Development

Requirements: Node.js 18 or newer, npm.

```bash
git clone <repository-url>
cd black-jack
npm install
npm run dev
```

Then open the URL Wrangler prints (usually http://localhost:8787).

The browser connects with `ws://` locally and `wss://` in production, derived from the current page origin — no hardcoded hosts.

Useful scripts:

```bash
npm run dev        # local Worker + Durable Objects (workerd)
npm run deploy     # deploy to Cloudflare (after login)
npm run typecheck  # wrangler types + tsc --noEmit
```

## Deployment

```bash
npx wrangler login
npm run deploy
```

This publishes the Worker, the `GameRoom` + `LobbyDirectory` Durable Objects, and the `./public` frontend to your Cloudflare account. Nothing has been deployed yet — these commands deploy it for the first time.

## Custom Domain

After deployment, connect your own Cloudflare-managed domain in the Cloudflare dashboard:

1. Make sure the domain's DNS is managed by Cloudflare (nameservers pointing at Cloudflare).
2. Go to **Workers & Pages → your Worker → Settings → Domains & Routes** (or **Custom Domains**).
3. Add your domain (e.g. `blackjack.example.com`) as a custom domain / route for the Worker.
4. Cloudflare provisions TLS automatically; the game then runs at `https://your-domain` with `wss://` sockets derived from the page origin — no code changes needed.

## Game State

Multiplayer room state is managed by Durable Objects: one `GameRoom` instance per room code holds players, hands, shoe, turns, timers (via alarms) and history, and persists snapshots to its own storage. If the instance restarts, the next request or socket event reloads the table from storage. Like any in-memory-ish store, a catastrophic loss of the instance's storage would drop the room — players can simply create a new one.

## Security

The `GameRoom` Durable Object is authoritative for room membership, cards, turns, bets, actions and results. Clients only send intent (`hit`, `stand`, `place_bet`, …); all validation, dealing, timers and payouts happen server-side, and every client renders the snapshots the server broadcasts. Do not trust anything the browser claims about game outcomes — the browser never decides them.

## Project Structure

```text
black-jack/
├── game/
│   └── engine.js + engine.d.ts  # pure Blackjack rules (shared by Worker; no Node APIs)
├── public/
│   ├── index.html               # app markup
│   ├── client.js                # browser UI + native WebSocket net layer
│   ├── styles.css               # all styling
│   ├── avatars.js / sounds.js / fx.js / favicon.svg
├── src/
│   ├── index.ts                 # Worker: assets, /health, /api/*, WS routing
│   ├── game-room.ts             # GameRoom Durable Object (authoritative table)
│   └── directory.ts             # LobbyDirectory Durable Object (matchmaking)
├── wrangler.jsonc               # Worker config, assets, DO bindings, migrations
├── tsconfig.json
├── package.json
└── LICENSE
```

## License

MIT — see [LICENSE](LICENSE).
