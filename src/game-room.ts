// GameRoom Durable Object — one instance per room code.
//
// This is the authoritative server for a single Blackjack table. It owns:
// connected players, room membership, settings, shoe, hands, turns, bets,
// payouts and all broadcasts. The browser never decides game results.
//
// Design notes:
// - One room code maps deterministically to one instance
//   (Worker uses GAME_ROOM.idFromName('room:' + code)).
// - WebSockets use the hibernation API: sockets are accepted with
//   ctx.acceptWebSocket() and the player id is stored with
//   serializeAttachment(), so messages can be routed after hibernation.
// - Timers (bet/turn/dealer/settle delays) use a single Durable Object
//   alarm. alarm() dispatches on the current room state, so a lost
//   in-memory timer after eviction still resolves correctly.
// - Mutable state is persisted to DO storage on every change, so an
//   evicted instance reloads the exact table on its next event.
//
// WebSocket protocol (JSON messages, field `t`):
//   client -> server: join | leave | set_settings | start_game | place_bet |
//                     action | chat | emote | kick | rematch
//   server -> client: room | phase | your_turn | action_error | chat | emote |
//                     settle | gameover | error | kicked

import {
  bustChance,
  cardValue,
  coachHint,
  createShoe,
  dealerShouldHit,
  handValue,
  isBlackjack,
  settleBet,
} from '../game/engine.js';

interface Avatar {
  style: string;
  seed: string;
  bg: string;
}

interface Stats {
  wins: number;
  losses: number;
  pushes: number;
  blackjacks: number;
  busts: number;
}

interface Player {
  id: string;
  name: string;
  avatar: Avatar;
  chips: number;
  connected: boolean;
  spectating: boolean;
  stats: Stats;
}

interface Card {
  rank: string;
  suit: string;
}

interface HandState {
  cards: Card[];
  bet: number;
  status: string; // betting | active | stood | bust | surrendered
  doubled: boolean;
  surrendered: boolean;
}

interface Settings {
  maxPlayers: number;
  startingChips: number;
  rounds: number;
  turnTimer: number;
  betTimer: number;
  numDecks: number;
  dealerHitsSoft17: boolean;
  blackjackPays: string;
  allowDouble: boolean;
  allowSplit: boolean;
  allowSurrender: boolean;
  coachEnabled: boolean;
}

interface PersistedState {
  code: string;
  players: Player[];
  hostId: string | null;
  settings: Settings;
  roomState: string;
  shoe: Card[];
  dealerHand: Card[];
  hands: Record<string, HandState[]>;
  turnOrder: string[];
  turnIndex: number;
  round: number;
  history: string[];
}

const EMOTE_ALLOWLIST = ['🔥', '😎', '😭', '🍀', '💸', '👏', '🤯', '🃏'];
const SETTING_KEYS = [
  'maxPlayers',
  'startingChips',
  'rounds',
  'turnTimer',
  'betTimer',
  'numDecks',
  'dealerHitsSoft17',
  'blackjackPays',
  'allowDouble',
  'allowSplit',
  'allowSurrender',
  'coachEnabled',
] as const;

function defaultSettings(): Settings {
  return {
    maxPlayers: 5,
    startingChips: 1000,
    rounds: 8,
    turnTimer: 20,
    betTimer: 20,
    numDecks: 6,
    dealerHitsSoft17: false,
    blackjackPays: '3:2',
    allowDouble: true,
    allowSplit: true,
    allowSurrender: true,
    coachEnabled: true,
  };
}

function freshStats(): Stats {
  return { wins: 0, losses: 0, pushes: 0, blackjacks: 0, busts: 0 };
}

function randomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export class GameRoom {
  private ctx: DurableObjectState;
  private env: Env;
  private loaded = false;
  private code = '';
  private players: Player[] = [];
  private hostId: string | null = null;
  private settings: Settings = defaultSettings();
  private roomState = 'lobby';
  private shoe: Card[] = [];
  private dealerHand: Card[] = [];
  private hands: Record<string, HandState[]> = {};
  private turnOrder: string[] = [];
  private turnIndex = 0;
  private round = 0;
  private history: string[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  // ---------- persistence ----------

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const saved = await this.ctx.storage.get<PersistedState>('state');
    if (saved) {
      this.code = saved.code;
      this.players = saved.players;
      this.hostId = saved.hostId;
      this.settings = { ...defaultSettings(), ...saved.settings };
      this.roomState = saved.roomState;
      this.shoe = saved.shoe;
      this.dealerHand = saved.dealerHand;
      this.hands = saved.hands;
      this.turnOrder = saved.turnOrder;
      this.turnIndex = saved.turnIndex;
      this.round = saved.round;
      this.history = saved.history;
    }
    this.loaded = true;
  }

  private save(): void {
    // Fire-and-forget persistence; the in-memory copy is authoritative
    // for the current event, storage is the recovery copy.
    const snapshot: PersistedState = {
      code: this.code,
      players: this.players,
      hostId: this.hostId,
      settings: this.settings,
      roomState: this.roomState,
      shoe: this.shoe,
      dealerHand: this.dealerHand,
      hands: this.hands,
      turnOrder: this.turnOrder,
      turnIndex: this.turnIndex,
      round: this.round,
      history: this.history,
    };
    this.ctx.waitUntil(this.ctx.storage.put('state', snapshot));
  }

  // ---------- websocket plumbing ----------

  private socketsFor(playerId: string): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => {
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

  private playerOf(ws: WebSocket): Player | null {
    let id: unknown = null;
    try {
      id = ws.deserializeAttachment();
    } catch {
      return null;
    }
    if (typeof id !== 'string') return null;
    return this.players.find((p) => p.id === id) || null;
  }

  // ---------- room views (same shape the browser renders) ----------

  private hideHole(): unknown[] {
    if (this.dealerHand.length < 2) return this.dealerHand;
    if (this.roomState === 'playing' || this.roomState === 'betting') {
      return [this.dealerHand[0], { hidden: true }];
    }
    return this.dealerHand;
  }

  private roomView(forPlayerId: string | null = null): Record<string, unknown> {
    return {
      id: this.code,
      isPrivate: true,
      hostId: this.hostId,
      state: this.roomState,
      round: this.round,
      settings: this.settings,
      dealer: this.roomState === 'lobby' || this.roomState === 'betting' ? [] : this.hideHole(),
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        chips: p.chips,
        connected: p.connected,
        spectating: !!p.spectating,
        isHost: p.id === this.hostId,
        isYou: p.id === forPlayerId,
        hands: this.hands[p.id] || [],
        stats: p.stats,
      })),
      turnId: this.turnOrder[this.turnIndex] || null,
      shoeLeft: this.shoe.length,
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

  private async reportDirectory(): Promise<void> {
    // Tell the lobby directory about current occupancy for matchmaking.
    // Best-effort: a stale directory entry only affects public discovery.
    try {
      const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'));
      await stub.fetch('https://lobby/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: this.code,
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
    // Only mark disconnected when no other socket of theirs is still open.
    if (this.socketsFor(player.id).length > 0) return;
    player.connected = false;
    if (this.hostId === player.id) {
      const next = this.players.find((p) => p.connected);
      this.hostId = next ? next.id : this.hostId;
    }
    this.save();
    this.broadcast();
    this.ctx.waitUntil(this.reportDirectory());
    // If the table is busy, a disconnect behaves like a skipped turn.
    if (this.roomState === 'playing' && this.turnOrder[this.turnIndex] === player.id) {
      await this.nextTurn();
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    // Single-alarm scheduler, dispatched on room state so it survives
    // eviction: whatever the phase is, its deadline action runs.
    await this.ensureLoaded();
    if (this.roomState === 'betting') await this.autoBets();
    else if (this.roomState === 'playing') await this.turnTimeout();
    else if (this.roomState === 'dealer') await this.finishDealer();
    else if (this.roomState === 'settle') await this.advance();
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
      if (this.players.length === 0 && !wantsCreate) {
        this.sendToSocket(ws, { t: 'error', message: 'Room not found. Check the invite code.' });
        return;
      }
      if (this.players.length >= this.settings.maxPlayers) {
        this.sendToSocket(ws, { t: 'error', message: 'Room is full.' });
        return;
      }
      player = {
        id: requestedId,
        name,
        avatar,
        chips: this.settings.startingChips,
        connected: true,
        spectating: false,
        stats: freshStats(),
      };
      this.players.push(player);
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
  }

  private sendToSocket(ws: WebSocket, msg: unknown): void {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  private async onPlayerMessage(player: Player, ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    switch (msg.t) {
      case 'set_settings':
        this.onSetSettings(player, ws, msg);
        break;
      case 'start_game':
        await this.onStartGame(player);
        break;
      case 'place_bet':
        await this.onPlaceBet(player, Number(msg.amount) || 0);
        break;
      case 'action':
        await this.doAction(player.id, String(msg.kind || ''));
        break;
      case 'chat': {
        const text = String(msg.text || '').slice(0, 200);
        if (!text.trim()) return;
        this.sendAll({ t: 'chat', name: player.name, avatar: player.avatar, text });
        break;
      }
      case 'emote': {
        const emoji = String(msg.emoji || '');
        if (!EMOTE_ALLOWLIST.includes(emoji)) return;
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
  }

  private onSetSettings(player: Player, ws: WebSocket, msg: Record<string, unknown>): void {
    if (this.hostId !== player.id || this.roomState !== 'lobby') return;
    const patch = (msg.patch || msg) as Record<string, unknown>;
    for (const k of SETTING_KEYS) {
      if (patch[k] !== undefined) (this.settings as unknown as Record<string, unknown>)[k] = patch[k];
    }
    this.settings.maxPlayers = Math.min(7, Math.max(2, this.settings.maxPlayers | 0 || 5));
    this.save();
    this.broadcast();
    void ws;
  }

  private async onStartGame(player: Player): Promise<void> {
    if (this.hostId !== player.id) return;
    if (this.players.filter((p) => p.connected).length < 1) return;
    this.round = 0;
    for (const p of this.players) {
      if (p.connected) {
        p.chips = this.settings.startingChips;
        p.spectating = false;
        p.stats = freshStats();
      }
    }
    await this.startBetting();
  }

  private async onPlaceBet(player: Player, amount: number): Promise<void> {
    if (this.roomState !== 'betting') return;
    if (player.spectating) return;
    const bet = Math.max(10, Math.min(player.chips, Math.floor(amount || 0)));
    if (bet <= 0) return;
    if (!this.hands[player.id] || this.hands[player.id].length === 0) {
      player.chips -= bet;
      this.hands[player.id] = [{ cards: [], bet, status: 'betting', doubled: false, surrendered: false }];
      this.chat(`${player.name} bets ${bet}`);
      this.save();
      this.broadcast();
      if (this.allBetsIn()) await this.dealRound();
    }
  }

  private async onKick(player: Player, targetId: string): Promise<void> {
    if (this.hostId !== player.id) return;
    const idx = this.players.findIndex((p) => p.id === targetId);
    if (idx < 0) return;
    const [kicked] = this.players.splice(idx, 1);
    delete this.hands[targetId];
    for (const ws of this.socketsFor(targetId)) {
      this.sendToSocket(ws, { t: 'kicked', text: 'Kicked by host' });
      try {
        ws.close(1000, 'kicked');
      } catch {
        // ignore
      }
    }
    this.chat(`👢 ${kicked.name} was kicked by host`);
    this.save();
    this.broadcast();
    this.ctx.waitUntil(this.reportDirectory());
  }

  private async onLeave(player: Player): Promise<void> {
    this.players = this.players.filter((p) => p.id !== player.id);
    delete this.hands[player.id];
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
    this.save();
    this.broadcast();
    this.ctx.waitUntil(this.reportDirectory());
    if (this.roomState === 'playing' && !this.activeHand(player.id)) {
      await this.nextTurn();
    }
  }

  private async onRematch(player: Player): Promise<void> {
    if (this.hostId !== player.id) return;
    if (this.roomState !== 'gameover' && this.roomState !== 'lobby') return;
    this.round = 0;
    for (const p of this.players) {
      if (p.connected) {
        p.chips = this.settings.startingChips;
        p.spectating = false;
        p.stats = freshStats();
      }
    }
    this.chat('🔁 Rematch! Fresh chips, same room.');
    await this.startBetting();
  }

  private async resetTable(): Promise<void> {
    this.cancelAlarm();
    this.players = [];
    this.hostId = null;
    this.settings = defaultSettings();
    this.roomState = 'lobby';
    this.shoe = [];
    this.dealerHand = [];
    this.hands = {};
    this.turnOrder = [];
    this.turnIndex = 0;
    this.round = 0;
    this.history = [];
    await this.ctx.storage.deleteAll();
    this.ctx.waitUntil(this.reportDirectory());
  }

  // ---------- game flow (ported from the Node server, same rules) ----------

  private needReshuffle(): boolean {
    return this.shoe.length < 52 || this.shoe.length < this.settings.numDecks * 52 * 0.25;
  }

  private async startBetting(): Promise<void> {
    this.roomState = 'betting';
    this.dealerHand = [];
    this.hands = {};
    this.turnOrder = [];
    this.turnIndex = 0;
    this.round += 1;
    if (this.needReshuffle()) {
      this.shoe = createShoe(this.settings.numDecks) as Card[];
      this.chat(`🔀 Shuffling fresh ${this.settings.numDecks}-deck shoe`);
    }
    for (const p of this.players) {
      if (p.connected && p.chips < 10) {
        p.spectating = true;
        this.chat(`💸 ${p.name} is out of chips and spectates`);
      } else if (p.connected && p.chips >= 10) {
        p.spectating = false;
      }
    }
    this.save();
    this.broadcast();
    this.sendAll({ t: 'phase', phase: 'betting', round: this.round, endsIn: this.settings.betTimer });
    this.ctx.waitUntil(this.reportDirectory());
    this.scheduleAlarm(this.settings.betTimer * 1000);
  }

  private allBetsIn(): boolean {
    const active = this.players.filter((p) => p.connected && !p.spectating);
    return active.length > 0 && active.every((p) => this.hands[p.id] && this.hands[p.id].length > 0);
  }

  private async autoBets(): Promise<void> {
    if (this.roomState !== 'betting') return;
    for (const p of this.players) {
      if (!p.connected || p.spectating) continue;
      if (!this.hands[p.id]) {
        const bet = Math.min(50, p.chips);
        if (bet > 0) {
          p.chips -= bet;
          this.hands[p.id] = [{ cards: [], bet, status: 'betting', doubled: false, surrendered: false }];
        } else {
          p.spectating = true;
        }
      }
    }
    const active = this.players.filter((p) => p.connected && !p.spectating && this.hands[p.id]);
    if (active.length === 0) {
      this.roomState = 'lobby';
      this.save();
      this.broadcast();
      this.ctx.waitUntil(this.reportDirectory());
      return;
    }
    await this.dealRound();
  }

  private draw(): Card {
    if (this.shoe.length === 0) this.shoe = createShoe(this.settings.numDecks) as Card[];
    return this.shoe.pop() as Card;
  }

  private async dealRound(): Promise<void> {
    this.cancelAlarm();
    this.roomState = 'playing';
    this.dealerHand = [this.draw(), this.draw()];
    for (const pid of Object.keys(this.hands)) {
      this.hands[pid][0].cards = [this.draw(), this.draw()];
      this.hands[pid][0].status = 'active';
    }
    if (isBlackjack(this.dealerHand)) {
      await this.settleRound('Dealer Blackjack!');
      return;
    }
    for (const pid of Object.keys(this.hands)) {
      if (isBlackjack(this.hands[pid][0].cards)) this.hands[pid][0].status = 'stood';
    }
    this.turnOrder = Object.keys(this.hands).filter((pid) => this.hands[pid].some((h) => h.status === 'active'));
    this.turnIndex = 0;
    if (this.turnOrder.length === 0) {
      await this.settleRound('All players hit Blackjack!');
      return;
    }
    this.save();
    this.broadcast();
    await this.promptTurn();
  }

  private activeHand(pid: string): HandState | undefined {
    return (this.hands[pid] || []).find((h) => h.status === 'active');
  }

  private async promptTurn(): Promise<void> {
    const pid = this.turnOrder[this.turnIndex];
    if (!pid) return this.dealerPlay();
    const player = this.players.find((p) => p.id === pid);
    if (!player || !player.connected || player.spectating) return this.nextTurn();
    const hand = this.activeHand(pid);
    if (!hand) return this.nextTurn();
    this.save();
    this.broadcast();
    const handIndex = this.hands[pid].indexOf(hand);
    this.sendTo(pid, {
      t: 'your_turn',
      handIndex,
      cards: hand.cards,
      dealerUp: this.dealerHand[0],
      hint: this.settings.coachEnabled ? coachHint(hand.cards, this.dealerHand[0]) : null,
      bustChance: bustChance(hand.cards),
      endsIn: this.settings.turnTimer,
    });
    this.scheduleAlarm(this.settings.turnTimer * 1000);
  }

  private async turnTimeout(): Promise<void> {
    if (this.roomState !== 'playing') return;
    const pid = this.turnOrder[this.turnIndex];
    const player = pid ? this.players.find((p) => p.id === pid) : undefined;
    const hand = pid ? this.activeHand(pid) : undefined;
    if (!pid || !hand) return this.nextTurn();
    hand.status = 'stood';
    if (player) this.chat(`⏱ ${player.name} timed out — auto-stand`);
    this.save();
    await this.nextTurn();
  }

  private async nextTurn(): Promise<void> {
    const pid = this.turnOrder[this.turnIndex];
    if (pid && this.activeHand(pid)) return this.promptTurn();
    this.turnIndex += 1;
    if (this.turnIndex >= this.turnOrder.length) return this.dealerPlay();
    await this.promptTurn();
  }

  private async doAction(pid: string, kind: string): Promise<void> {
    if (this.roomState !== 'playing') return;
    if (this.turnOrder[this.turnIndex] !== pid) return;
    const player = this.players.find((p) => p.id === pid);
    const hand = this.activeHand(pid);
    if (!player || !hand) return;
    const hands = this.hands[pid];

    if (kind === 'hit') {
      hand.cards.push(this.draw());
      const v = handValue(hand.cards);
      if (v.bust) {
        hand.status = 'bust';
        player.stats.busts += 1;
        this.chat(`💥 ${player.name} busts (${v.total})`);
      } else if (v.total === 21) hand.status = 'stood';
      if (hand.status !== 'active') {
        this.save();
        return this.nextTurn();
      }
      this.save();
      this.broadcast();
      await this.promptTurn();
    } else if (kind === 'stand') {
      hand.status = 'stood';
      this.save();
      await this.nextTurn();
    } else if (kind === 'double') {
      if (!this.settings.allowDouble || hand.cards.length !== 2 || player.chips < hand.bet) {
        this.sendTo(pid, { t: 'action_error', message: 'Cannot double now' });
        return;
      }
      player.chips -= hand.bet;
      hand.bet *= 2;
      hand.doubled = true;
      hand.cards.push(this.draw());
      const v = handValue(hand.cards);
      hand.status = v.bust ? 'bust' : 'stood';
      if (v.bust) player.stats.busts += 1;
      this.chat(`⚡ ${player.name} doubles to ${hand.bet}`);
      this.save();
      await this.nextTurn();
    } else if (kind === 'split') {
      if (!this.settings.allowSplit || hand.cards.length !== 2 || hands.length > 1 || player.chips < hand.bet) {
        this.sendTo(pid, { t: 'action_error', message: 'Cannot split now' });
        return;
      }
      const [c1, c2] = hand.cards;
      const v1 = cardValue(c1.rank);
      const v2 = cardValue(c2.rank);
      if (v1 !== v2 && !(v1 === 10 && v2 === 10)) {
        this.sendTo(pid, { t: 'action_error', message: 'Need a pair to split' });
        return;
      }
      player.chips -= hand.bet;
      hands.splice(
        0,
        1,
        { cards: [c1, this.draw()], bet: hand.bet, status: 'active', doubled: false, surrendered: false },
        { cards: [c2, this.draw()], bet: hand.bet, status: 'active', doubled: false, surrendered: false },
      );
      this.chat(`✂️ ${player.name} splits!`);
      this.save();
      this.broadcast();
      await this.promptTurn();
    } else if (kind === 'surrender') {
      if (!this.settings.allowSurrender || hand.cards.length !== 2) {
        this.sendTo(pid, { t: 'action_error', message: 'Cannot surrender now' });
        return;
      }
      hand.status = 'surrendered';
      const back = Math.floor(hand.bet / 2);
      player.chips += back;
      this.chat(`🏳️ ${player.name} surrenders (+${back} back)`);
      this.save();
      await this.nextTurn();
    }
  }

  private async dealerPlay(): Promise<void> {
    this.roomState = 'dealer';
    this.save();
    this.broadcast();
    // Small drama delay so players see the hole-card reveal.
    this.scheduleAlarm(1200);
  }

  private async finishDealer(): Promise<void> {
    if (this.roomState !== 'dealer') return;
    while (dealerShouldHit(this.dealerHand, this.settings.dealerHitsSoft17)) {
      this.dealerHand.push(this.draw());
    }
    await this.settleRound();
  }

  private async settleRound(note: string | null = null): Promise<void> {
    this.cancelAlarm();
    this.roomState = 'settle';
    const dVal = handValue(this.dealerHand);
    const results: Array<{ pid: string; hand: number; outcome: string; payout: number; total?: number }> = [];
    for (const [pid, hands] of Object.entries(this.hands)) {
      const player = this.players.find((p) => p.id === pid);
      if (!player) continue;
      for (let i = 0; i < hands.length; i++) {
        const h = hands[i];
        if (h.status === 'surrendered') {
          results.push({ pid, hand: i, outcome: 'surrender', payout: 0 });
          player.stats.losses += 1;
          continue;
        }
        const r = settleBet(h.cards, this.dealerHand, h.bet, { blackjackPays: this.settings.blackjackPays });
        player.chips += r.payout;
        if (r.outcome === 'win' || r.outcome === 'blackjack') player.stats.wins += 1;
        else if (r.outcome === 'push') player.stats.pushes += 1;
        else player.stats.losses += 1;
        if (r.outcome === 'blackjack') player.stats.blackjacks += 1;
        results.push({ pid, hand: i, outcome: r.outcome, payout: r.payout, total: handValue(h.cards).total });
      }
    }
    this.sendAll({
      t: 'settle',
      dealer: this.dealerHand,
      dealerTotal: dVal.total,
      dealerBust: dVal.bust,
      results,
      note,
    });
    const winners = results
      .filter((r) => r.outcome === 'win' || r.outcome === 'blackjack')
      .map((r) => this.players.find((p) => p.id === r.pid)?.name)
      .filter(Boolean) as string[];
    this.history.push(
      `R${this.round}: D${dVal.total}${dVal.bust ? '💥' : ''} • ${winners.length ? '👏 ' + [...new Set(winners)].join(', ') : 'house takes it'}`,
    );
    this.history = this.history.slice(-8);
    this.save();
    this.broadcast();
    this.scheduleAlarm(5000);
  }

  private async advance(): Promise<void> {
    if (this.roomState !== 'settle') return;
    if (this.round >= this.settings.rounds) {
      this.roomState = 'gameover';
      const board = [...this.players].sort((a, b) => b.chips - a.chips);
      this.sendAll({
        t: 'gameover',
        board: board.map((p) => ({ name: p.name, chips: p.chips, avatar: p.avatar, stats: p.stats })),
      });
      this.save();
      this.broadcast();
      this.ctx.waitUntil(this.reportDirectory());
    } else {
      await this.startBetting();
    }
  }
}
