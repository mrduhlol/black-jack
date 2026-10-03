// Cloudflare Worker — HTTP + WebSocket front door for black-jack.io.
//
// Browser ──HTTPS/WSS──▶ Worker ──▶ GameRoom Durable Object (one per room)
//                          │
//                          └───────▶ LobbyDirectory Durable Object (matchmaking)
//
// Routes:
//   GET  /health                 -> { ok, rooms } (directory room count)
//   POST /api/public-room        -> { code } (existing lobby or fresh code)
//   POST /api/create-room        -> { code } (fresh private code)
//   GET  /room/:code/socket      -> WebSocket upgrade, proxied to the room's
//                                  GameRoom Durable Object instance
//   everything else              -> static frontend from ./public

import { GameRoom } from './game-room';
import { LobbyDirectory } from './directory';

export { GameRoom, LobbyDirectory };

// The ASSETS binding is provided automatically when `assets.directory` is
// configured (Cloudflare serves ./public through it). `wrangler types` does
// not emit it into Env, so it is declared here as an extension.
interface WorkerEnv extends Env {
  ASSETS: Fetcher;
}

function directoryStub(env: Env): DurableObjectStub {
  return env.LOBBY.get(env.LOBBY.idFromName('lobby'));
}

function roomStub(env: Env, code: string): DurableObjectStub {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(`room:${code}`));
}

function validCode(raw: string): string | null {
  const code = (raw || '').toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(code) ? code : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const fullEnv = env as unknown as WorkerEnv;

    if (url.pathname === '/health' && request.method === 'GET') {
      try {
        const res = await directoryStub(env).fetch('https://lobby/stats');
        const data = (await res.json()) as { rooms?: number };
        return Response.json({ ok: true, rooms: data.rooms ?? 0 });
      } catch {
        return Response.json({ ok: true, rooms: 0 });
      }
    }

    if (url.pathname === '/api/public-room' && request.method === 'POST') {
      const res = await directoryStub(env).fetch('https://lobby/find-public', { method: 'POST' });
      const data = (await res.json()) as { code: string };
      return Response.json({ code: data.code });
    }

    if (url.pathname === '/api/create-room' && request.method === 'POST') {
      const res = await directoryStub(env).fetch('https://lobby/mint-private', { method: 'POST' });
      const data = (await res.json()) as { code: string };
      return Response.json({ code: data.code });
    }

    const socketMatch = url.pathname.match(/^\/room\/([A-Za-z0-9]+)\/socket$/);
    if (socketMatch) {
      const code = validCode(socketMatch[1]);
      if (!code) return new Response('bad room code', { status: 400 });
      const upgrade = request.headers.get('Upgrade') || request.headers.get('upgrade');
      if (upgrade !== 'websocket') return new Response('expected websocket', { status: 426 });
      // Hand the socket to the room's Durable Object. The header tells the
      // fresh instance which room code it owns.
      const doRequest = new Request(url.origin + '/socket', request);
      doRequest.headers.set('x-room-code', code);
      return roomStub(env, code).fetch(doRequest);
    }

    // Static frontend (./public via the assets binding).
    return fullEnv.ASSETS.fetch(request);
  },
};
