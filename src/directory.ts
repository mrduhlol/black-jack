// LobbyDirectory Durable Object — singleton matchmaking helper.
//
// The Worker reaches it via LOBBY.idFromName('lobby'). It owns:
// - minting collision-free room codes (private rooms),
// - tracking public rooms (reported by GameRoom instances) so "Play now"
//   can find a lobby table with a free seat instead of always minting one.
//
// Internal HTTP API (called by the Worker and by GameRoom instances):
//   POST /find-public -> { code }
//   POST /mint-private -> { code }
//   POST /report  { code, seats, connected, max, state }
//   GET  /stats   -> { rooms }

interface RoomEntry {
  code: string;
  mode: string; // 'blackjack' | 'liars'
  isPrivate: boolean;
  seats: number;
  connected: number;
  max: number;
  state: string;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode(len = 6): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export class LobbyDirectory {
  private ctx: DurableObjectState;
  private loaded = false;
  private rooms = new Map<string, RoomEntry>();

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const saved = await this.ctx.storage.get<RoomEntry[]>('rooms');
    if (saved) this.rooms = new Map(saved.map((r) => [r.code, r]));
    this.loaded = true;
  }

  private save(): void {
    this.ctx.waitUntil(this.ctx.storage.put('rooms', [...this.rooms.values()]));
  }

  private roomMode(code: string): string | null {
    const entry = this.rooms.get((code || '').toUpperCase());
    return entry ? entry.mode || 'blackjack' : null;
  }

  private mint(exclude: Set<string>): string {
    let code = makeCode();
    while (exclude.has(code)) code = makeCode();
    return code;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);
    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/find-public' && request.method === 'POST') {
      let mode = 'blackjack';
      try {
        const body = (await request.json()) as { mode?: string };
        if (body && (body.mode === 'liars' || body.mode === 'blackjack')) mode = body.mode;
      } catch {
        // no body — default matchmaking pool
      }
      for (const room of this.rooms.values()) {
        if (room.mode === mode && !room.isPrivate && room.state === 'lobby' && room.seats < room.max && room.connected > 0) {
          return json({ code: room.code, mode });
        }
      }
      const code = this.mint(new Set(this.rooms.keys()));
      const max = mode === 'liars' ? 4 : 5;
      this.rooms.set(code, { code, mode, isPrivate: false, seats: 0, connected: 0, max, state: 'lobby' });
      this.save();
      return json({ code, mode });
    }

    if (url.pathname === '/mint-private' && request.method === 'POST') {
      let mode = 'blackjack';
      try {
        const body = (await request.json()) as { mode?: string };
        if (body && (body.mode === 'liars' || body.mode === 'blackjack')) mode = body.mode;
      } catch {
        // no body — default pool
      }
      const code = this.mint(new Set(this.rooms.keys()));
      const max = mode === 'liars' ? 4 : 5;
      this.rooms.set(code, { code, mode, isPrivate: true, seats: 0, connected: 0, max, state: 'lobby' });
      this.save();
      return json({ code, mode });
    }

    if (url.pathname === '/report' && request.method === 'POST') {
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ ok: false }, 400);
      }
      const code = String(body.code || '');
      if (!code) return json({ ok: false }, 400);
      if (Number(body.seats) === 0) {
        // Nobody left at the table: forget the room so matchmaking
        // never points at ghost tables.
        this.rooms.delete(code);
      } else {
        const prev = this.rooms.get(code);
        this.rooms.set(code, {
          code,
          mode: typeof body.mode === 'string' && body.mode ? String(body.mode) : prev?.mode || 'blackjack',
          isPrivate: prev ? prev.isPrivate : true,
          seats: Number(body.seats) || 0,
          connected: Number(body.connected) || 0,
          max: Number(body.max) || 5,
          state: String(body.state || 'lobby'),
        });
      }
      this.save();
      return json({ ok: true });
    }

    if (url.pathname === '/room-mode' && request.method === 'GET') {
      const look = await this.roomMode(url.searchParams.get('code') || '');
      if (!look) return json({ mode: null }, 404);
      return json({ mode: look });
    }

    if (url.pathname === '/stats' && request.method === 'GET') {
      return json({ rooms: this.rooms.size });
    }

    return new Response('not found', { status: 404 });
  }
}
