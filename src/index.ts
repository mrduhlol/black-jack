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
//   GET  /api/room-mode?code=XX  -> { mode } ('blackjack' | 'liars' | null)
//   POST /api/liar-public-room   -> { code } (liar's matchmaking pool)
//   POST /api/liar-create-room   -> { code } (fresh private liar's code)
//   GET  /room/:code/socket      -> WebSocket upgrade, proxied to the room's
//                                  GameRoom Durable Object instance
//   GET  /liar/:code/socket      -> WebSocket upgrade, proxied to the room's
//                                  LiarsBarRoom Durable Object instance
//   everything else              -> static frontend from ./public

import { GameRoom } from './game-room';
import { LiarsBarRoom } from './liars-room';
import { LobbyDirectory } from './directory';

export { GameRoom, LiarsBarRoom, LobbyDirectory };

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

function liarStub(env: Env, code: string): DurableObjectStub {
  return env.LIARS_BAR.get(env.LIARS_BAR.idFromName(`liar:${code}`));
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

    if (url.pathname === '/api/room-mode' && request.method === 'GET') {
      const code = (url.searchParams.get('code') || '').toUpperCase();
      try {
        const res = await directoryStub(env).fetch(`https://lobby/room-mode?code=${encodeURIComponent(code)}`);
        if (!res.ok) return Response.json({ mode: null });
        const data = (await res.json()) as { mode: string | null };
        return Response.json({ mode: data.mode });
      } catch {
        return Response.json({ mode: null });
      }
    }

    if (url.pathname === '/api/liar-public-room' && request.method === 'POST') {
      const res = await directoryStub(env).fetch('https://lobby/find-public', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'liars' }),
      });
      const data = (await res.json()) as { code: string };
      return Response.json({ code: data.code });
    }

    if (url.pathname === '/api/liar-create-room' && request.method === 'POST') {
      const res = await directoryStub(env).fetch('https://lobby/mint-private', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'liars' }),
      });
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

    const liarMatch = url.pathname.match(/^\/liar\/([A-Za-z0-9]+)\/socket$/);
    if (liarMatch) {
      const code = validCode(liarMatch[1]);
      if (!code) return new Response('bad room code', { status: 400 });
      const upgrade = request.headers.get('Upgrade') || request.headers.get('upgrade');
      if (upgrade !== 'websocket') return new Response('expected websocket', { status: 426 });
      const doRequest = new Request(url.origin + '/socket', request);
      doRequest.headers.set('x-room-code', code);
      return liarStub(env, code).fetch(doRequest);
    }

    // Static frontend (./public via the assets binding).
    const asset = await fullEnv.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
};
