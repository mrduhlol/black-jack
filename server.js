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

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, () => console.log(`black-jack.io running on http://localhost:${PORT}`));
