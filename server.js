const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// In-memory rooms. skribbl-style: public matchmaking + private invite codes.
const rooms = new Map(); // roomId -> room

function makeCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function defaultSettings() {
  return {
    maxPlayers: 5,
    startingChips: 1000,
    rounds: 8,
    turnTimer: 20, // seconds per decision, skribbl-like countdown
    betTimer: 20,
    numDecks: 6,
    dealerHitsSoft17: false, // S17 default
    blackjackPays: '3:2',
    allowDouble: true,
    allowSplit: true,
    allowSurrender: true,
    coachEnabled: true, // Blackjack party feature: basic-strategy hint + bust %
  };
}

function createRoom(isPrivate) {
  let id = makeCode();
  while (rooms.has(id)) id = makeCode();
  const room = {
    id,
    isPrivate: !!isPrivate,
    hostId: null,
    players: [], // {id,name,avatar,chips,connected,spectating,stats}
    settings: defaultSettings(),
    state: 'lobby',
    shoe: [],
    dealerHand: [],
    hands: {}, // socketId -> [{cards,bet,status,doubled,surrendered}]
    turnOrder: [],
    turnIndex: 0,
    round: 0,
    timers: {},
    banned: new Set(),
  };
  rooms.set(id, room);
  return room;
}

function publicRoom() {
  for (const r of rooms.values()) {
    if (!r.isPrivate && r.state === 'lobby' && r.players.length < r.settings.maxPlayers) return r;
  }
  return createRoom(false);
}

function roomView(room, forSocketId = null) {
  return {
    id: room.id,
    isPrivate: room.isPrivate,
    hostId: room.hostId,
    state: room.state,
    round: room.round,
    settings: room.settings,
    dealer: room.state === 'lobby' || room.state === 'betting' ? [] : hideHole(room),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      chips: p.chips,
      connected: p.connected,
      spectating: !!p.spectating,
      isHost: p.id === room.hostId,
      isYou: p.id === forSocketId,
      hands: room.hands[p.id] || [],
      stats: p.stats,
    })),
    turnId: room.turnOrder[room.turnIndex] || null,
    shoeLeft: room.shoe.length,
  };
}

function hideHole(room) {
  if (room.dealerHand.length < 2) return room.dealerHand;
  if (room.state === 'playing' || room.state === 'betting') {
    return [room.dealerHand[0], { hidden: true }];
  }
  return room.dealerHand;
}

function broadcast(room) {
  for (const p of room.players) {
    if (!p.connected) continue;
    io.to(p.id).emit('room', roomView(room, p.id));
  }
}

function findRoomOf(socketId) {
  for (const r of rooms.values()) {
    if (r.players.some((p) => p.id === socketId)) return r;
  }
  return null;
}

io.on('connection', (socket) => {
  socket.on('createPrivate', ({ name, avatar }) => {
    const room = createRoom(true);
    joinSocket(room, socket, name, avatar);
    socket.emit('roomCreated', { id: room.id });
  });

  socket.on('joinPublic', ({ name, avatar }) => {
    const room = publicRoom();
    const err = joinSocket(room, socket, name, avatar);
    if (err) socket.emit('joinError', err);
  });

  socket.on('joinPrivate', ({ code, name, avatar }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return socket.emit('joinError', 'Room not found. Check the invite code.');
    const err = joinSocket(room, socket, name, avatar);
    if (err) socket.emit('joinError', err);
  });

  socket.on('setSettings', (patch) => {
    const room = findRoomOf(socket.id);
    if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
    const allowed = ['maxPlayers', 'startingChips', 'rounds', 'turnTimer', 'betTimer', 'numDecks', 'dealerHitsSoft17', 'blackjackPays', 'allowDouble', 'allowSplit', 'allowSurrender', 'coachEnabled'];
    for (const k of allowed) if (patch[k] !== undefined) room.settings[k] = patch[k];
    room.settings.maxPlayers = Math.min(7, Math.max(2, room.settings.maxPlayers | 0 || 5));
    broadcast(room);
  });

  socket.on('startGame', () => {
    const room = findRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.filter((p) => p.connected).length < 1) return;
    room.round = 0;
    for (const p of room.players) {
      if (p.connected) {
        p.chips = room.settings.startingChips;
        p.spectating = false;
        p.stats = { wins: 0, losses: 0, pushes: 0, blackjacks: 0, busts: 0 };
      }
    }
    startBetting(room);
  });

  socket.on('placeBet', ({ amount }) => {
    const room = findRoomOf(socket.id);
    if (!room || room.state !== 'betting') return;
    const p = room.players.find((x) => x.id === socket.id);
    if (!p || p.spectating) return;
    const bet = Math.max(10, Math.min(p.chips, Math.floor(amount || 0)));
    if (bet <= 0) return;
    if (!room.hands[p.id] || room.hands[p.id].length === 0) {
      p.chips -= bet;
      room.hands[p.id] = [{ cards: [], bet, status: 'betting', doubled: false, surrendered: false }];
      io.to(room.id).emit('chat', { sys: true, text: `${p.name} bets ${bet}` });
      broadcast(room);
      if (allBetsIn(room)) dealRound(room);
    }
  });

  socket.on('disconnect', () => {
    const room = findRoomOf(socket.id);
    if (!room) return;
    const p = room.players.find((x) => x.id === socket.id);
    if (p) p.connected = false;
    if (room.hostId === socket.id) {
      const next = room.players.find((x) => x.connected);
      if (next) room.hostId = next.id;
    }
    broadcast(room);
    // cleanup empty private rooms
    if (room.players.every((x) => !x.connected)) {
      clearTimeout(room.timers.bet);
      clearTimeout(room.timers.turn);
      if (room.isPrivate) rooms.delete(room.id);
    }
  });
});

function joinSocket(room, socket, name, avatar) {
  if (room.banned.has(socket.handshake.address)) return 'You are banned from this room.';
  if (room.players.length >= room.settings.maxPlayers && !room.players.some((p) => p.id === socket.id)) {
    return 'Room is full.';
  }
  const cleanName = String(name || 'Player').slice(0, 14) || 'Player';
  let p = room.players.find((x) => x.id === socket.id);
  if (!p) {
    // rejoin by name? keep simple: new seat
    p = {
      id: socket.id,
      name: cleanName,
      avatar: avatar || { face: '🙂', color: '#ffd54f' },
      chips: room.settings.startingChips,
      connected: true,
      spectating: false,
      stats: { wins: 0, losses: 0, pushes: 0, blackjacks: 0, busts: 0 },
    };
    room.players.push(p);
    if (!room.hostId) room.hostId = p.id;
  } else {
    p.connected = true;
    p.name = cleanName;
    if (avatar) p.avatar = avatar;
  }
  socket.join(room.id);
  // rebind socket id room: socket.io rooms keyed by room id string
  socket.data.roomId = room.id;
  broadcast(room);
  return null;
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, () => console.log(`black-jack.io running on http://localhost:${PORT}`));
