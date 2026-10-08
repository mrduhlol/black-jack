// LiarsBarRoom Durable Object — one instance per Liar's Bar room code.
//
// Authoritative server for a single Liar's Bar table. Owns: room membership,
// hands, pile, declarations, challenges, risk resolution, broadcasts. The
// browser only sends intent and renders server snapshots.
//
// One room code maps deterministically to one instance
// (Worker uses LIARS_BAR.idFromName('liar:' + code)).
// Hibernating WebSockets + single-alarm scheduler + storage persistence,
// mirroring GameRoom.
//
// Game flow (states: lobby | playing | reveal | risk | gameover):
// - playing, stage 'play':   turn player lays 1-3 cards face-down, declaring
//                             a count of the table rank ("2 Kings"). Jokers
//                             are wild and always count as the table rank.
// - playing, stage 'decide':  next player answers LIAR! or CONTINUE.
// - reveal:                   challenged cards shown, truth determined.
// - risk:                     loser faces the Risk Chamber (fresh chamber).
// - going out (empty hand) wins once the next player's liar option resolves;
//   last player standing also wins.
//
// WebSocket protocol (JSON, field `t`):
//   client -> server: join | leave | set_settings | start_game | liar_play |
//                     liar_call | risk_pick | chat | emote | kick | rematch
//   server -> client: room | phase | liar_turn | liar_error | liar_played |
//                     liar_reveal | liar_risk | liar_risk_result | liar_gameover |
//                     chat | emote | error | kicked

import {
  buildChamber,
  dealHands,
  judgeChallenge,
  plural,
  randomTableRank,
} from '../game/liars.js';
import type { ChamberSlot, LiarCard } from '../game/liars.js';

interface Avatar {
  style: string;
  seed: string;
  bg: string;
}

interface LiarStats {
  wins: number;
  losses: number;
  challengesWon: number;
  survivals: number;
}

interface LiarPlayer {
  id: string;
  name: string;
  avatar: Avatar;
  connected: boolean;
  eliminated: boolean;
  stats: LiarStats;
}

interface LiarSettings {
  maxPlayers: number;
  turnTimer: number;
  chambers: number;
  liveChambers: number;
  riskType: string; // 'chamber' — resolver dispatch keeps future types pluggable
  devilMode: boolean; // one rank card is secretly marked; challenged devil = everyone else faces the chamber
}

interface LastPlay {
  by: string;
  count: number;
  cards: LiarCard[];
}

interface RiskState {
  type: string;
  playerId: string;
  slots: ChamberSlot[];
  queue: string[]; // devil retribution: more seats still waiting their turn
  devil: boolean; // true when this chain came from a challenged Devil card
}

interface RevealState {
  by: string;
  challenger: string;
  count: number;
  cards: LiarCard[];
  truthful: boolean;
  loser: string;
  outWin: boolean;
}

interface PersistedLiarState {
  code: string;
  players: LiarPlayer[];
  hostId: string | null;
  settings: LiarSettings;
  roomState: string;
  hands: Record<string, LiarCard[]>;
  pile: LiarCard[];
  tableRank: string;
  turnOrder: string[];
  turnIndex: number;
  stage: string; // 'play' | 'decide'
  lastPlay: LastPlay | null;
  pendingOut: string | null;
  devilId: string | null;
  risk: RiskState | null;
  round: number;
  history: string[];
}

const EMOTE_ALLOWLIST = ['🔥', '😎', '😭', '🍀', '💸', '👏', '🤯', '🃏'];
const SETTING_KEYS = ['maxPlayers', 'turnTimer', 'chambers', 'liveChambers', 'devilMode'] as const;
const REVEAL_MS = 4000;

function defaultSettings(): LiarSettings {
  return { maxPlayers: 4, turnTimer: 30, chambers: 6, liveChambers: 1, riskType: 'chamber', devilMode: false };
}

function freshStats(): LiarStats {
  return { wins: 0, losses: 0, challengesWon: 0, survivals: 0 };
}

function randomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export class LiarsBarRoom {
  private ctx: DurableObjectState;
  private env: Env;
  private loaded = false;
  private code = '';
  private players: LiarPlayer[] = [];
  private hostId: string | null = null;
  private settings: LiarSettings = defaultSettings();
  private roomState = 'lobby';
  private hands: Record<string, LiarCard[]> = {};
  private pile: LiarCard[] = [];
  private tableRank = 'A';
  private turnOrder: string[] = [];
  private turnIndex = 0;
  private stage = 'play';
  private lastPlay: LastPlay | null = null;
  private pendingOut: string | null = null;
  private devilId: string | null = null;
  private risk: RiskState | null = null;
  private round = 0;
  private history: string[] = [];
  private chatCooldown = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  // ---------- persistence ----------

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const saved = await this.ctx.storage.get<PersistedLiarState>('liar-state');
    if (saved) {
      this.code = saved.code;
      this.players = saved.players;
      this.hostId = saved.hostId;
      this.settings = { ...defaultSettings(), ...saved.settings };
      this.roomState = saved.roomState;
      this.hands = saved.hands;
      this.pile = saved.pile;
      this.tableRank = saved.tableRank;
      this.turnOrder = saved.turnOrder;
      this.turnIndex = saved.turnIndex;
      this.stage = saved.stage;
      this.lastPlay = saved.lastPlay;
      this.pendingOut = saved.pendingOut;
      this.devilId = (saved as { devilId?: string | null }).devilId || null;
      this.risk = saved.risk;
      this.round = saved.round;
      this.history = saved.history;
    }
    this.loaded = true;
  }

  private save(): void {
    const snapshot: PersistedLiarState = {
      code: this.code,
      players: this.players,
      hostId: this.hostId,
      settings: this.settings,
      roomState: this.roomState,
      hands: this.hands,
      pile: this.pile,
      tableRank: this.tableRank,
      turnOrder: this.turnOrder,
      turnIndex: this.turnIndex,
      stage: this.stage,
      lastPlay: this.lastPlay,
      pendingOut: this.pendingOut,
      devilId: this.devilId,
      risk: this.risk,
      round: this.round,
      history: this.history,
    };
    this.ctx.waitUntil(this.ctx.storage.put('liar-state', snapshot));
  }

  // ---------- websocket plumbing ----------

  private socketsFor(playerId: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      try {
        return ws.readyState === 1 && (ws.deserializeAttachment() as string | null) === playerId;
      } catch {
        return false;
      }
    });
  }

  private sendTo(playerId: string, msg: unknown): void {
    const text = JSON.stringify(msg);
    for (const ws of this.socketsFor(playerId)) {
      try {
        ws.send(text);
      } catch {
        // ignore broken sockets; close handler cleans up
      }
    }
  }

  private sendAll(msg: unknown): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      try {
        ws.send(text);
      } catch {
        // ignore broken sockets; close handler cleans up
      }
    }
  }

  private sendToSocket(ws: WebSocket, msg: unknown): void {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  private playerOf(ws: WebSocket): LiarPlayer | null {
    let id: unknown = null;
    try {
      id = ws.deserializeAttachment();
    } catch {
      return null;
    }
    if (typeof id !== 'string') return null;
    return this.players.find((p) => p.id === id) || null;
  }

  // ---------- views ----------

  private playerName(pid: string): string {
    return this.players.find((p) => p.id === pid)?.name || 'A player';
  }

  private aliveIds(): string[] {
    return this.turnOrder.filter((pid) => {
      const p = this.players.find((x) => x.id === pid);
      return p && !p.eliminated;
    });
  }

  private roomView(forPlayerId: string | null = null): Record<string, unknown> {
    return {
      id: this.code,
      mode: 'liars',
      hostId: this.hostId,
      state: this.roomState,
      round: this.round,
      tableRank: this.tableRank,
      settings: this.settings,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        connected: p.connected,
        eliminated: !!p.eliminated,
        isHost: p.id === this.hostId,
        isYou: p.id === forPlayerId,
        cards: p.id === forPlayerId
          ? (this.hands[p.id] || []).map((c) =>
              c.id === this.devilId ? { ...c, devil: true } : c,
            )
          : undefined,
        cardCount: (this.hands[p.id] || []).length,
        stats: p.stats,
      })),
      pileCount: this.pile.length,
      lastPlay: this.lastPlay
        ? { by: this.lastPlay.by, byName: this.playerName(this.lastPlay.by), count: this.lastPlay.count, rank: this.tableRank }
        : null,
      turnId: this.turnOrder[this.turnIndex] || null,
      stage: this.stage,
      order: this.turnOrder.filter((pid) => {
        const p = this.players.find((x) => x.id === pid);
        return p && !p.eliminated;
      }),
      risk: this.risk
        ? {
            type: this.risk.type,
            playerId: this.risk.playerId,
            playerName: this.playerName(this.risk.playerId),
            slots: this.risk.slots.map((s) => ({ picked: s.picked })),
            queueLeft: (this.risk.queue || []).length,
            devil: !!this.risk.devil,
          }
        : null,
      history: this.history.slice(-8),
    };
  }

  private broadcast(): void {
    for (const p of this.players) {
      if (!p.connected) continue;
      this.sendTo(p.id, { t: 'room', ...this.roomView(p.id) });
    }
  }

  private chat(text: string): void {
    this.sendAll({ t: 'chat', sys: true, text });
  }

  private checkChatCooldown(playerId: string): boolean {
    const now = Date.now();
    const last = this.chatCooldown.get(playerId) || 0;
    if (now - last < 1000) return false;
    this.chatCooldown.set(playerId, now);
    if (this.chatCooldown.size > 50) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [id, at] of this.chatCooldown) {
        if (at < oldestAt) { oldestAt = at; oldestKey = id; }
      }
      if (oldestKey) this.chatCooldown.delete(oldestKey);
    }
    return true;
  }

  private async reportDirectory(): Promise<void> {
    try {
      const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'));
      await stub.fetch('https://lobby/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: this.code,
          mode: 'liars',
          seats: this.players.length,
          connected: this.players.filter((p) => p.connected).length,
          max: this.settings.maxPlayers,
          state: this.roomState,
        }),
      });
    } catch {
      // directory unreachable; room itself keeps working
    }
  }

  private scheduleAlarm(delayMs: number): void {
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + delayMs));
  }

  private cancelAlarm(): void {
    this.ctx.waitUntil(this.ctx.storage.deleteAlarm());
  }

  // ---------- entry points ----------

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);
    if (!this.code) {
      this.code = (request.headers.get('x-room-code') || '').toUpperCase();
      this.save();
    }
    if (url.pathname === '/socket') {
      const upgrade = request.headers.get('Upgrade') || request.headers.get('upgrade');
      if (upgrade !== 'websocket') return new Response('expected websocket', { status: 426 });
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ensureLoaded();
    if (typeof message !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'join':
        await this.onJoin(ws, msg);
        break;
      default: {
        const player = this.playerOf(ws);
        if (!player) return;
        await this.onPlayerMessage(player, ws, msg);
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.ensureLoaded();
    const player = this.playerOf(ws);
    if (!player) return;
    if (this.socketsFor(player.id).length > 0) return;
    player.connected = false;
    if (this.hostId === player.id) {
      const next = this.players.find((p) => p.connected);
      this.hostId = next ? next.id : this.hostId;
    }
    this.save();
    this.broadcast();
    this.ctx.waitUntil(this.reportDirectory());
    // A disconnect on a live seat acts immediately like the relevant timeout.
    if (this.roomState === 'playing' && this.turnOrder[this.turnIndex] === player.id) {
      await this.turnTimeout();
    } else if (this.roomState === 'risk' && this.risk && this.risk.playerId === player.id) {
      await this.riskTimeout();
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (this.roomState === 'playing') await this.turnTimeout();
    else if (this.roomState === 'reveal') await this.advanceReveal();
    else if (this.roomState === 'risk') await this.riskTimeout();
  }

  // ---------- membership ----------

  private async onJoin(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const rawName = String(msg.name || 'Player').replace(/\s+/g, ' ').trim().slice(0, 14);
    const name = rawName || 'Player';
    const avatar = (msg.avatar as Avatar) && (msg.avatar as Avatar).style
      ? (msg.avatar as Avatar)
      : { style: 'adventurer', seed: name + String(Date.now() % 997), bg: 'ffd54f' };
    const requestedId = typeof msg.playerId === 'string' && msg.playerId ? msg.playerId : randomId();
    const wantsCreate = msg.create === true;

    let player = this.players.find((p) => p.id === requestedId);
    if (!player) {
      if (this.roomState !== 'lobby' && this.roomState !== 'gameover') {
        this.sendToSocket(ws, { t: 'error', message: 'Round in progress — wait for the next one.' });
        return;
      }
      if (this.players.length === 0 && !wantsCreate) {
        this.sendToSocket(ws, { t: 'error', message: 'Room not found. Check the invite code.' });
        return;
      }
      if (this.players.length >= this.settings.maxPlayers) {
        this.sendToSocket(ws, { t: 'error', message: 'Room is full.' });
        return;
      }
      player = { id: requestedId, name, avatar, connected: true, eliminated: false, stats: freshStats() };
      this.players.push(player);
      this.hands[player.id] = [];
      if (!this.hostId) this.hostId = player.id;
    } else {
      player.connected = true;
      player.name = name;
      player.avatar = avatar;
      if (!this.hostId) this.hostId = player.id;
    }
    try {
      ws.serializeAttachment(player.id);
    } catch {
      // non-hibernation runtimes; routing still works while resident
    }
    this.save();
    this.broadcast();
    this.ctx.waitUntil(this.reportDirectory());
    // A reconnect may be resuming an idled table (alarms cancelled when the
    // last seat dropped). Only the returning actor nudges the clock, so a
    // flapping spectator never resets anyone's timer.
    if (this.roomState === 'playing' && this.actorId() === player.id) await this.promptTurn();
    else if (this.roomState === 'risk' && this.risk) {
      const riskPlayer = this.players.find((p) => p.id === this.risk!.playerId);
      if (riskPlayer && riskPlayer.connected) this.scheduleAlarm(this.settings.turnTimer * 1000);
    }
  }

  private async onPlayerMessage(player: LiarPlayer, ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    switch (msg.t) {
      case 'set_settings':
        this.onSetSettings(player, msg);
        break;
      case 'start_game':
        await this.onStartGame(player);
        break;
      case 'liar_play':
        await this.onPlay(player, msg);
        break;
      case 'liar_call':
        await this.onCall(player, msg);
        break;
      case 'risk_pick':
        await this.onRiskPick(player, Number(msg.slot));
        break;
      case 'chat': {
        const text = String(msg.text || '').slice(0, 200);
        if (!text.trim()) return;
        if (!this.checkChatCooldown(player.id)) return;
        this.sendAll({ t: 'chat', name: player.name, avatar: player.avatar, text });
        break;
      }
      case 'emote': {
        const emoji = String(msg.emoji || '');
        if (!EMOTE_ALLOWLIST.includes(emoji)) return;
        if (!this.checkChatCooldown(player.id)) return;
        this.sendAll({ t: 'emote', name: player.name, emoji });
        break;
      }
      case 'kick':
        await this.onKick(player, String(msg.targetId || ''));
        break;
      case 'leave':
        await this.onLeave(player);
        break;
      case 'rematch':
        await this.onRematch(player);
        break;
      default:
        break;
    }
    void ws;
  }

  private onSetSettings(player: LiarPlayer, msg: Record<string, unknown>): void {
    if (this.hostId !== player.id || this.roomState !== 'lobby') return;
    const patch = (msg.patch || msg) as Record<string, unknown>;
    for (const k of SETTING_KEYS) {
      if (patch[k] !== undefined) (this.settings as unknown as Record<string, unknown>)[k] = patch[k];
    }
    this.settings.maxPlayers = Math.min(4, Math.max(2, this.settings.maxPlayers | 0 || 4));
    this.settings.turnTimer = Math.min(120, Math.max(10, this.settings.turnTimer | 0 || 30));
    this.settings.chambers = Math.min(8, Math.max(3, this.settings.chambers | 0 || 6));
    this.settings.liveChambers = Math.min(
      this.settings.chambers - 1,
      Math.max(1, this.settings.liveChambers | 0 || 1),
    );
    this.save();
    this.broadcast();
  }

  private activeCount(): number {
    return this.players.filter((p) => p.connected && !p.eliminated).length;
  }

  private async onStartGame(player: LiarPlayer): Promise<void> {
    if (this.hostId !== player.id) return;
    if (this.roomState !== 'lobby' && this.roomState !== 'gameover') return;
    const starters = this.players.filter((p) => p.connected);
    if (starters.length < 2) {
      this.sendTo(player.id, { t: 'liar_error', message: 'Need at least 2 players to start.' });
      return;
    }
    for (const p of this.players) {
      p.eliminated = false;
      p.stats = freshStats();
    }
    const { hands } = dealHands(starters.map((p) => p.id));
    this.hands = hands;
    this.pile = [];
    this.round = 1;
    this.tableRank = randomTableRank();
    this.devilId = null;
    if (this.settings.devilMode) {
      const dealt: LiarCard[] = [];
      for (const pid of starters.map((p) => p.id)) {
        for (const c of this.hands[pid] || []) {
          if (c.rank !== 'JOKER') dealt.push(c);
        }
      }
      if (dealt.length > 0) {
        this.devilId = dealt[Math.floor(Math.random() * dealt.length)].id;
      }
    }
    this.turnOrder = starters.map((p) => p.id);
    this.turnIndex = 0;
    this.stage = 'play';
    this.lastPlay = null;
    this.pendingOut = null;
    this.risk = null;
    this.roomState = 'playing';
    this.chat(`Round 1 — the table rank is ${this.tableRank}. ${this.playerName(this.turnOrder[0])} opens.`);
    this.save();
    this.broadcast();
    this.sendAll({ t: 'phase', phase: 'playing', round: this.round });
    this.ctx.waitUntil(this.reportDirectory());
    await this.promptTurn();
  }

  private async onKick(player: LiarPlayer, targetId: string): Promise<void> {
    if (this.hostId !== player.id) return;
    const idx = this.players.findIndex((p) => p.id === targetId);
    if (idx < 0) return;
    const [kicked] = this.players.splice(idx, 1);
    delete this.hands[targetId];
    if (this.devilId && !Object.values(this.hands).some((h) => h.some((c) => c.id === this.devilId))) {
      this.devilId = null;
    }
    this.turnOrder = this.turnOrder.filter((id) => id !== targetId);
    if (this.turnIndex >= this.turnOrder.length) this.turnIndex = 0;
    for (const ws of this.socketsFor(targetId)) {
      this.sendToSocket(ws, { t: 'kicked', text: 'Kicked by host' });
      try {
        ws.close(1000, 'kicked');
      } catch {
        // ignore
      }
    }
    this.chat(`${kicked.name} was kicked by host`);
    this.save();
    this.broadcast();
    this.ctx.waitUntil(this.reportDirectory());
    await this.checkContinuation();
  }

  private async onLeave(player: LiarPlayer): Promise<void> {
    this.players = this.players.filter((p) => p.id !== player.id);
    delete this.hands[player.id];
    if (this.devilId && !Object.values(this.hands).some((h) => h.some((c) => c.id === this.devilId))) {
      this.devilId = null;
    }
    this.turnOrder = this.turnOrder.filter((id) => id !== player.id);
    if (this.turnIndex >= this.turnOrder.length) this.turnIndex = 0;
    // Never strand a risk or pending exit on a departed seat.
    if (this.risk) {
      this.risk.queue = (this.risk.queue || []).filter((id) => id !== player.id);
      if (this.risk.playerId === player.id) {
        const nxt = this.risk.queue.shift();
        if (nxt && this.players.some((p) => p.id === nxt && p.connected && !p.eliminated)) {
          this.risk = {
            type: this.risk.type,
            playerId: nxt,
            slots: buildChamber(this.settings.chambers, this.settings.liveChambers),
            queue: this.risk.queue,
            devil: this.risk.devil,
          };
        } else {
          this.risk = null;
        }
      }
    }
    if (this.pendingOut === player.id) this.pendingOut = null;
    if (this.lastPlay && this.lastPlay.by === player.id) this.lastPlay = null;
    for (const ws of this.socketsFor(player.id)) {
      try {
        ws.close(1000, 'left');
      } catch {
        // ignore
      }
    }
    if (this.hostId === player.id) {
      const next = this.players.find((p) => p.connected);
      this.hostId = next ? next.id : null;
    }
    if (this.players.length === 0) {
      await this.resetTable();
      return;
    }
    // A departure can strand the decide stage (accuser gone, or the accused
    // claim left with them). Fall back to a fresh play turn instead of
    // waiting out a clock on a ghost decision.
    if (this.roomState === 'playing' && this.stage === 'decide') {
      const actor = this.actorId();
      const actorOk = !!actor && this.players.some((p) => p.id === actor && p.connected && !p.eliminated);
      if (!this.lastPlay || !actorOk) {
        this.stage = 'play';
        this.lastPlay = null;
      }
    }
    this.save();
    this.broadcast();
    this.ctx.waitUntil(this.reportDirectory());
    await this.checkContinuation();
  }

  private async onRematch(player: LiarPlayer): Promise<void> {
    if (this.hostId !== player.id) return;
    if (this.roomState !== 'gameover' && this.roomState !== 'lobby') return;
    this.roomState = 'lobby';
    this.save();
    this.broadcast();
    this.ctx.waitUntil(this.reportDirectory());
    await this.onStartGame(player);
  }

  private async resetTable(): Promise<void> {
    this.cancelAlarm();
    this.players = [];
    this.hostId = null;
    this.settings = defaultSettings();
    this.roomState = 'lobby';
    this.hands = {};
    this.pile = [];
    this.turnOrder = [];
    this.turnIndex = 0;
    this.stage = 'play';
    this.lastPlay = null;
    this.pendingOut = null;
    this.devilId = null;
    this.risk = null;
    this.round = 0;
    this.history = [];
    await this.ctx.storage.deleteAll();
    this.ctx.waitUntil(this.reportDirectory());
  }

  // ---------- turn engine ----------

  private actorId(): string | null {
    return this.turnOrder[this.turnIndex] || null;
  }

  private nextAliveIndex(from: number): number {
    if (this.turnOrder.length === 0) return 0;
    for (let step = 1; step <= this.turnOrder.length; step++) {
      const idx = (from + step) % this.turnOrder.length;
      const p = this.players.find((x) => x.id === this.turnOrder[idx]);
      if (p && !p.eliminated && p.connected) return idx;
    }
    return from;
  }

  private async promptTurn(): Promise<void> {
    const actor = this.actorId();
    if (!actor) return;
    if (!this.players.some((p) => p.connected)) {
      // Nobody is home: idle the table instead of spinning alarms forever.
      this.cancelAlarm();
      this.save();
      return;
    }
    this.save();
    this.broadcast();
    this.sendTo(actor, {
      t: 'liar_turn',
      stage: this.stage,
      tableRank: this.tableRank,
      endsIn: this.settings.turnTimer,
    });
    this.scheduleAlarm(this.settings.turnTimer * 1000);
  }

  private async turnTimeout(): Promise<void> {
    if (this.roomState !== 'playing') return;
    const actor = this.actorId();
    const player = actor ? this.players.find((p) => p.id === actor) : undefined;
    if (!actor || !player || player.eliminated || !player.connected) {
      this.turnIndex = this.nextAliveIndex(this.turnIndex);
      this.save();
      await this.promptTurn();
      return;
    }
    if (this.stage === 'play') {
      // Auto-play one random card, declared as the table rank.
      const hand = this.hands[actor] || [];
      if (hand.length === 0) {
        this.turnIndex = this.nextAliveIndex(this.turnIndex);
        this.save();
        await this.promptTurn();
        return;
      }
      const card = hand[Math.floor(Math.random() * hand.length)];
      this.chat(`${player.name} timed out — auto-plays 1 card.`);
      await this.applyPlay(actor, [card.id], 1);
    } else {
      this.chat(`${player.name} timed out — play continues.`);
      await this.applyContinue(actor);
    }
  }

  private handHas(pid: string, ids: string[]): LiarCard[] | null {
    const hand = this.hands[pid] || [];
    const found: LiarCard[] = [];
    for (const id of ids) {
      const c = hand.find((x) => x.id === id && !found.includes(x));
      if (!c) return null;
      found.push(c);
    }
    return found;
  }

  private async onPlay(player: LiarPlayer, msg: Record<string, unknown>): Promise<void> {
    if (this.roomState !== 'playing' || this.stage !== 'play') {
      this.sendTo(player.id, { t: 'liar_error', message: 'Not your play turn.' });
      return;
    }
    if (this.actorId() !== player.id) {
      this.sendTo(player.id, { t: 'liar_error', message: 'Wait for your turn.' });
      return;
    }
    const raw = msg.cards;
    const ids = Array.isArray(raw) ? raw.map(String).slice(0, 3) : [];
    const count = Number(msg.count) || 0;
    if (ids.length === 0 || ids.length > 3) {
      this.sendTo(player.id, { t: 'liar_error', message: 'Select 1 to 3 cards.' });
      return;
    }
    if (count !== ids.length) {
      this.sendTo(player.id, { t: 'liar_error', message: 'Declare exactly what you lay.' });
      return;
    }
    const cards = this.handHas(player.id, ids);
    if (!cards) {
      this.sendTo(player.id, { t: 'liar_error', message: 'Those cards are not in your hand.' });
      return;
    }
    if (this.settings.devilMode && this.devilId && ids.includes(this.devilId) && ids.length > 1) {
      this.sendTo(player.id, { t: 'liar_error', message: 'The Devil rides alone — play it by itself.' });
      return;
    }
    await this.applyPlay(player.id, ids, count);
  }

  private async applyPlay(pid: string, ids: string[], count: number): Promise<void> {
    const cards = this.handHas(pid, ids);
    if (!cards) return;
    const idSet = new Set(ids);
    this.hands[pid] = (this.hands[pid] || []).filter((c) => !idSet.has(c.id));
    this.pile.push(...cards);
    this.lastPlay = { by: pid, count, cards };
    this.sendAll({
      t: 'liar_played',
      by: pid,
      byName: this.playerName(pid),
      count,
      rank: this.tableRank,
      pileCount: this.pile.length,
    });
    if ((this.hands[pid] || []).length === 0) {
      this.pendingOut = pid;
      this.chat(`${this.playerName(pid)} is out of cards — the declaration can still be challenged.`);
    }
    this.turnIndex = this.nextAliveIndex(this.turnIndex);
    this.stage = 'decide';
    this.save();
    this.broadcast();
    await this.promptTurn();
  }

  private async onCall(player: LiarPlayer, msg: Record<string, unknown>): Promise<void> {
    if (this.roomState !== 'playing' || this.stage !== 'decide') {
      this.sendTo(player.id, { t: 'liar_error', message: 'Nothing to challenge right now.' });
      return;
    }
    if (this.actorId() !== player.id) {
      this.sendTo(player.id, { t: 'liar_error', message: 'Wait for your turn.' });
      return;
    }
    if (!this.lastPlay) return;
    if (msg.liar === true) {
      await this.openReveal(player.id);
    } else {
      await this.applyContinue(player.id);
    }
  }

  private async applyContinue(pid: string): Promise<void> {
    // Accept the declaration; it is now this player's turn to lay cards.
    // A pending out-player wins the moment their exit goes unchallenged.
    if (this.pendingOut) {
      const winner = this.players.find((p) => p.id === this.pendingOut);
      this.pendingOut = null;
      if (winner && !winner.eliminated) {
        await this.endGame(winner.id, `${winner.name} shed every card unchallenged.`);
        return;
      }
    }
    this.stage = 'play';
    this.save();
    this.broadcast();
    await this.promptTurn();
    void pid;
  }

  private async openReveal(challengerId: string): Promise<void> {
    if (!this.lastPlay) return;
    const play = this.lastPlay;
    const truthful = judgeChallenge(play.cards, this.tableRank);
    const loser = truthful ? challengerId : play.by;
    const devilHit = this.settings.devilMode && !!this.devilId && play.cards.some((c) => c.id === this.devilId);
    const challenger = this.players.find((p) => p.id === challengerId);
    if (challenger && !truthful && !devilHit) challenger.stats.challengesWon += 1;
    this.roomState = 'reveal';
    this.cancelAlarm();
    this.sendAll({
      t: 'liar_reveal',
      by: play.by,
      byName: this.playerName(play.by),
      challenger: challengerId,
      challengerName: this.playerName(challengerId),
      count: play.count,
      rank: this.tableRank,
      cards: play.cards.map((c) => (c.id === this.devilId ? { ...c, devil: true } : c)),
      truthful,
      devil: devilHit,
      loser,
      loserName: this.playerName(loser),
    });
    this.chat(
      devilHit
        ? `${this.playerName(play.by)} rode the Devil — everyone else faces the chamber!`
        : truthful
          ? `${this.playerName(challengerId)} called LIAR — but it was the truth.`
          : `${this.playerName(challengerId)} called LIAR — caught bluffing.`,
    );
    this.save();
    this.broadcast();
    this.scheduleAlarm(REVEAL_MS);
  }

  private async advanceReveal(): Promise<void> {
    if (this.roomState !== 'reveal' || !this.lastPlay) return;
    const play = this.lastPlay;
    const truthful = judgeChallenge(play.cards, this.tableRank);
    const challenger = this.actorId();
    const loser = truthful ? challenger : play.by;
    if (!loser || !this.players.some((p) => p.id === loser)) {
      // A seat left mid-reveal: discard the pile, turn a new rank, continue.
      this.pile = [];
      this.lastPlay = null;
      this.pendingOut = null;
      this.round += 1;
      this.tableRank = randomTableRank();
      this.roomState = 'playing';
      this.stage = 'play';
      this.chat('The challenged cards are discarded — new rank: ' + this.tableRank + '.');
      this.save();
      this.broadcast();
      await this.checkContinuation();
      return;
    }
    const devilHit = this.settings.devilMode && !!this.devilId && play.cards.some((c) => c.id === this.devilId);
    // An out-player whose truthful final play survives the challenge wins now.
    // (The Devil overrides everything: no clean wins on a devil round.)
    if (truthful && this.pendingOut === play.by && !devilHit) {
      this.pendingOut = null;
      await this.endGame(play.by, `${this.playerName(play.by)} went out clean.`);
      return;
    }
    if (devilHit) {
      await this.openDevilRetribution(play.by);
      return;
    }
    this.pendingOut = null;
    this.roomState = 'risk';
    this.risk = {
      type: this.settings.riskType,
      playerId: loser,
      slots: buildChamber(this.settings.chambers, this.settings.liveChambers),
      queue: [],
      devil: false,
    };
    this.chat(`${this.playerName(loser)} faces the Risk Chamber.`);
    this.save();
    this.broadcast();
    this.sendTo(loser, { t: 'liar_risk', slots: this.risk.slots.length, endsIn: this.settings.turnTimer });
    this.scheduleAlarm(this.settings.turnTimer * 1000);
  }

  // ---------- risk chamber (modular: dispatched by risk type) ----------

  private async openDevilRetribution(riderId: string): Promise<void> {
    const damned = this.turnOrder.filter((pid) => {
      if (pid === riderId) return false;
      const p = this.players.find((x) => x.id === pid);
      return p && !p.eliminated && p.connected;
    });
    this.pendingOut = null;
    if (damned.length === 0) {
      this.pile = [];
      this.lastPlay = null;
      this.round += 1;
      this.tableRank = randomTableRank();
      this.roomState = 'playing';
      this.stage = 'play';
      this.chat('The Devil found no one to punish — new rank: ' + this.tableRank + '.');
      this.save();
      this.broadcast();
      await this.checkContinuation();
      return;
    }
    this.roomState = 'risk';
    const [first, ...rest] = damned;
    this.risk = {
      type: this.settings.riskType,
      playerId: first,
      slots: buildChamber(this.settings.chambers, this.settings.liveChambers),
      queue: rest,
      devil: true,
    };
    this.save();
    this.broadcast();
    this.sendTo(first, { t: 'liar_risk', slots: this.risk.slots.length, endsIn: this.settings.turnTimer });
    this.scheduleAlarm(this.settings.turnTimer * 1000);
  }

  private async onRiskPick(player: LiarPlayer, slot: number): Promise<void> {
    if (this.roomState !== 'risk' || !this.risk) {
      this.sendTo(player.id, { t: 'liar_error', message: 'No risk to face right now.' });
      return;
    }
    if (this.risk.playerId !== player.id) {
      this.sendTo(player.id, { t: 'liar_error', message: 'Only the challenged player picks.' });
      return;
    }
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.risk.slots.length || this.risk.slots[slot].picked) {
      this.sendTo(player.id, { t: 'liar_error', message: 'Pick an untested chamber.' });
      return;
    }
    await this.resolveRiskPick(slot);
  }

  private async riskTimeout(): Promise<void> {
    if (this.roomState !== 'risk' || !this.risk) return;
    const open = this.risk.slots.map((s, i) => (s.picked ? -1 : i)).filter((i) => i >= 0);
    if (open.length === 0) return;
    await this.resolveRiskPick(open[Math.floor(Math.random() * open.length)]);
  }

  private async resolveRiskPick(slot: number): Promise<void> {
    if (!this.risk) return;
    if (this.risk.type !== 'chamber') return; // future risk types plug in here
    const risk = this.risk;
    risk.slots[slot].picked = true;
    const fatal = risk.slots[slot].live;
    const player = this.players.find((p) => p.id === risk.playerId);
    this.sendAll({
      t: 'liar_risk_result',
      playerId: risk.playerId,
      playerName: this.playerName(risk.playerId),
      slot,
      fatal,
      slots: risk.slots.map((s) => ({ picked: s.picked, live: s.picked ? s.live : undefined })),
    });
    if (player) {
      if (fatal) {
        player.eliminated = true;
        player.stats.losses += 1;
        delete this.hands[player.id];
        this.turnOrder = this.turnOrder.filter((id) => id !== player.id);
        if (this.turnIndex >= this.turnOrder.length) this.turnIndex = 0;
        this.chat(`${player.name} is out of the game.`);
        this.history.push(`${player.name} fell to the chamber`);
      } else {
        player.stats.survivals += 1;
        // Survivor takes the pile and the table turns over a new rank.
        const taken = this.pile.length;
        this.hands[player.id] = [...(this.hands[player.id] || []), ...this.pile];
        this.pile = [];
        this.round += 1;
        this.tableRank = randomTableRank();
        this.chat(
          `${player.name} survives and takes ${plural(taken, 'card')} — new rank: ${this.tableRank}.`,
        );
      }
    }
    this.risk = null;
    this.lastPlay = null;
    this.stage = 'play';
    // Devil queues walk seat to seat; the table turns over once paid.
    const queue = (risk.queue || []).filter((pid) => {
      const p = this.players.find((x) => x.id === pid);
      return p && !p.eliminated && p.connected;
    });
    if (queue.length > 0) {
      const [next, ...rest] = queue;
      this.risk = {
        type: risk.type,
        playerId: next,
        slots: buildChamber(this.settings.chambers, this.settings.liveChambers),
        queue: rest,
        devil: risk.devil,
      };
      this.chat(`${this.playerName(next)} steps up to the chamber…`);
      this.save();
      this.broadcast();
      this.sendTo(next, { t: 'liar_risk', slots: this.risk.slots.length, endsIn: this.settings.turnTimer });
      this.scheduleAlarm(this.settings.turnTimer * 1000);
      return;
    }
    if (risk.devil) {
      this.pile = [];
      this.round += 1;
      this.tableRank = randomTableRank();
      this.chat(`The Devil is paid — new rank: ${this.tableRank}.`);
    }
    // Play resumes with the next live seat after the risk player.
    this.turnIndex = this.nextAliveIndex(Math.max(0, this.turnOrder.indexOf(risk.playerId)));
    this.save();
    this.broadcast();
    await this.checkContinuation();
  }

  // ---------- continuation & end ----------

  private async checkContinuation(): Promise<void> {
    if (this.roomState === 'lobby' || this.roomState === 'gameover') return;
    const alive = this.players.filter((p) => !p.eliminated);
    const standing = alive.filter((p) => p.connected);
    if (alive.length === 1) {
      await this.endGame(alive[0].id, `${alive[0].name} is the last one standing.`);
      return;
    }
    if (alive.length === 0 || this.players.length === 0) {
      this.roomState = 'lobby';
      this.save();
      this.broadcast();
      this.ctx.waitUntil(this.reportDirectory());
      return;
    }
    if (standing.length === 0) {
      // Every seat walked away mid-game: idle the table. A reconnect
      // resumes the clock via onJoin instead of alarms spinning forever.
      this.cancelAlarm();
      this.save();
      this.broadcast();
      this.ctx.waitUntil(this.reportDirectory());
      return;
    }
    // One connected survivor among dropped seats: keep playing, the timers
    // drive past the ghosts. No early crown while seats may reconnect.
    // Keep the turn on a live seat.
    const actor = this.actorId();
    const actorOk = actor && standing.some((p) => p.id === actor);
    if (!actorOk) {
      const idx = this.turnOrder.findIndex((id) => standing.some((p) => p.id === id));
      this.turnIndex = idx >= 0 ? idx : 0;
    }
    this.roomState = 'playing';
    if (this.stage !== 'play' && this.stage !== 'decide') this.stage = 'play';
    this.save();
    this.broadcast();
    this.ctx.waitUntil(this.reportDirectory());
    await this.promptTurn();
  }

  private async endGame(winnerId: string, note: string): Promise<void> {
    this.cancelAlarm();
    this.roomState = 'gameover';
    const winner = this.players.find((p) => p.id === winnerId);
    if (winner) winner.stats.wins += 1;
    this.sendAll({
      t: 'liar_gameover',
      winner: winnerId,
      winnerName: winner?.name || 'A player',
      note,
      board: [...this.players].map((p) => ({
        name: p.name,
        avatar: p.avatar,
        eliminated: !!p.eliminated,
        cardCount: (this.hands[p.id] || []).length,
        stats: p.stats,
      })),
    });
    this.history.push(note);
    this.history = this.history.slice(-8);
    this.save();
    this.broadcast();
    this.ctx.waitUntil(this.reportDirectory());
  }
}
