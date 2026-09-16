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
    history: [], // last round summaries for history bar
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

  socket.on('action', ({ kind }) => {
    const room = findRoomOf(socket.id);
    if (!room || room.state !== 'playing') return;
    if (room.turnOrder[room.turnIndex] !== socket.id) return;
    doAction(room, socket.id, kind);
  });

  socket.on('chat', ({ text }) => {
    const room = findRoomOf(socket.id);
    if (!room) return;
    const p = room.players.find((x) => x.id === socket.id);
    if (!p) return;
    const clean = String(text || '').slice(0, 200);
    if (!clean.trim()) return;
    io.to(room.id).emit('chat', { name: p.name, avatar: p.avatar, text: clean });
  });

  socket.on('emote', ({ emoji }) => {
    const room = findRoomOf(socket.id);
    if (!room) return;
    const p = room.players.find((x) => x.id === socket.id);
    if (!p) return;
    const allowed = ['🔥', '😎', '😭', '🍀', '💸', '👏', '🤯', '🃏'];
    if (!allowed.includes(emoji)) return;
    io.to(room.id).emit('emote', { name: p.name, emoji });
  });

  socket.on('kick', ({ targetId }) => {
    const room = findRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    const idx = room.players.findIndex((x) => x.id === targetId);
    if (idx < 0) return;
    const [kicked] = room.players.splice(idx, 1);
    delete room.hands[targetId];
    io.to(targetId).emit('kicked', { text: 'Kicked by host' });
    io.to(room.id).emit('chat', { sys: true, text: `👢 ${kicked.name} was kicked by host` });
    broadcast(room);
  });

  socket.on('leave', () => {
    const room = findRoomOf(socket.id);
    if (!room) return;
    room.players = room.players.filter((x) => x.id !== socket.id);
    delete room.hands[socket.id];
    socket.leave(room.id);
    if (room.hostId === socket.id) {
      const next = room.players.find((x) => x.connected);
      room.hostId = next ? next.id : null;
    }
    broadcast(room);
  });

  socket.on('rematch', () => {
    const room = findRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.state !== 'gameover' && room.state !== 'lobby') return;
    room.round = 0;
    for (const p of room.players) {
      if (p.connected) {
        p.chips = room.settings.startingChips;
        p.spectating = false;
        p.stats = { wins: 0, losses: 0, pushes: 0, blackjacks: 0, busts: 0 };
      }
    }
    io.to(room.id).emit('chat', { sys: true, text: '🔁 Rematch! Fresh chips, same room.' });
    startBetting(room);
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

const engine = require('./game/engine');

function needReshuffle(room) {
  return room.shoe.length < 52 || room.shoe.length < room.settings.numDecks * 52 * 0.25;
}

function startBetting(room) {
  room.state = 'betting';
  room.dealerHand = [];
  room.hands = {};
  room.turnOrder = [];
  room.turnIndex = 0;
  room.round += 1;
  if (needReshuffle(room)) {
    room.shoe = engine.createShoe(room.settings.numDecks);
    io.to(room.id).emit('chat', { sys: true, text: `🔀 Shuffling fresh ${room.settings.numDecks}-deck shoe` });
  }
  // broke players spectate
  for (const p of room.players) {
    if (p.connected && p.chips < 10) {
      p.spectating = true;
      io.to(room.id).emit('chat', { sys: true, text: `💸 ${p.name} is out of chips and spectates` });
    } else if (p.connected && p.chips >= 10) {
      p.spectating = false;
    }
  }
  broadcast(room);
  io.to(room.id).emit('phase', { phase: 'betting', round: room.round, endsIn: room.settings.betTimer });
  clearTimeout(room.timers.bet);
  room.timers.bet = setTimeout(() => autoBets(room), room.settings.betTimer * 1000);
}

function allBetsIn(room) {
  const active = room.players.filter((p) => p.connected && !p.spectating);
  return active.length > 0 && active.every((p) => room.hands[p.id] && room.hands[p.id].length > 0);
}

function autoBets(room) {
  if (room.state !== 'betting') return;
  for (const p of room.players) {
    if (!p.connected || p.spectating) continue;
    if (!room.hands[p.id]) {
      const bet = Math.min(50, p.chips);
      if (bet > 0) {
        p.chips -= bet;
        room.hands[p.id] = [{ cards: [], bet, status: 'betting', doubled: false, surrendered: false }];
      } else {
        p.spectating = true;
      }
    }
  }
  const active = room.players.filter((p) => p.connected && !p.spectating && room.hands[p.id]);
  if (active.length === 0) {
    room.state = 'lobby';
    broadcast(room);
    return;
  }
  dealRound(room);
}

function draw(room) {
  if (room.shoe.length === 0) room.shoe = engine.createShoe(room.settings.numDecks);
  return room.shoe.pop();
}

function dealRound(room) {
  clearTimeout(room.timers.bet);
  room.state = 'playing';
  room.dealerHand = [draw(room), draw(room)];
  for (const pid of Object.keys(room.hands)) {
    room.hands[pid][0].cards = [draw(room), draw(room)];
    room.hands[pid][0].status = 'active';
  }
  // dealer blackjack peek: if dealer has BJ, skip player turns
  if (engine.isBlackjack(room.dealerHand)) {
    return settleRound(room, 'Dealer Blackjack!');
  }
  // mark player blackjacks as stood
  for (const pid of Object.keys(room.hands)) {
    if (engine.isBlackjack(room.hands[pid][0].cards)) room.hands[pid][0].status = 'stood';
  }
  room.turnOrder = Object.keys(room.hands).filter((pid) => room.hands[pid].some((h) => h.status === 'active'));
  room.turnIndex = 0;
  if (room.turnOrder.length === 0) return settleRound(room, 'All players hit Blackjack!');
  broadcast(room);
  promptTurn(room);
}

function activeHand(room, pid) {
  const hands = room.hands[pid] || [];
  return hands.find((h) => h.status === 'active');
}

function promptTurn(room) {
  clearTimeout(room.timers.turn);
  const pid = room.turnOrder[room.turnIndex];
  if (!pid) return dealerPlay(room);
  const p = room.players.find((x) => x.id === pid);
  if (!p || !p.connected || p.spectating) return nextTurn(room);
  const hand = activeHand(room, pid);
  if (!hand) return nextTurn(room);
  broadcast(room);
  const handIdx = room.hands[pid].indexOf(hand);
  io.to(pid).emit('yourTurn', {
    handIndex: handIdx,
    cards: hand.cards,
    dealerUp: room.dealerHand[0],
    hint: room.settings.coachEnabled ? engine.coachHint(hand.cards, room.dealerHand[0]) : null,
    bustChance: engine.bustChance(hand.cards),
    endsIn: room.settings.turnTimer,
  });
  room.timers.turn = setTimeout(() => {
    // auto-stand like skribbl auto-skip on timeout
    hand.status = 'stood';
    io.to(room.id).emit('chat', { sys: true, text: `⏱ ${p.name} timed out — auto-stand` });
    nextTurn(room);
  }, room.settings.turnTimer * 1000);
}

function nextTurn(room) {
  clearTimeout(room.timers.turn);
  // if current player still has another active hand (after split), stay; else advance
  const pid = room.turnOrder[room.turnIndex];
  if (pid && activeHand(room, pid)) return promptTurn(room);
  room.turnIndex += 1;
  if (room.turnIndex >= room.turnOrder.length) return dealerPlay(room);
  promptTurn(room);
}

function doAction(room, pid, kind) {
  const p = room.players.find((x) => x.id === pid);
  const hand = activeHand(room, pid);
  if (!p || !hand) return;
  const hands = room.hands[pid];

  if (kind === 'hit') {
    hand.cards.push(draw(room));
    const v = engine.handValue(hand.cards);
    if (v.bust) {
      hand.status = 'bust';
      p.stats.busts += 1;
      io.to(room.id).emit('chat', { sys: true, text: `💥 ${p.name} busts (${v.total})` });
    } else if (v.total === 21) hand.status = 'stood';
    if (hand.status !== 'active') return nextTurn(room);
    broadcast(room);
    promptTurn(room); // refresh hint/bust%
  } else if (kind === 'stand') {
    hand.status = 'stood';
    nextTurn(room);
  } else if (kind === 'double') {
    if (!room.settings.allowDouble || hand.cards.length !== 2 || p.chips < hand.bet) {
      return io.to(pid).emit('actionError', 'Cannot double now');
    }
    p.chips -= hand.bet;
    hand.bet *= 2;
    hand.doubled = true;
    hand.cards.push(draw(room));
    const v = engine.handValue(hand.cards);
    hand.status = v.bust ? 'bust' : 'stood';
    if (v.bust) p.stats.busts += 1;
    io.to(room.id).emit('chat', { sys: true, text: `⚡ ${p.name} doubles to ${hand.bet}` });
    nextTurn(room);
  } else if (kind === 'split') {
    if (!room.settings.allowSplit || hand.cards.length !== 2 || hands.length > 1 || p.chips < hand.bet) {
      return io.to(pid).emit('actionError', 'Cannot split now');
    }
    const [c1, c2] = hand.cards;
    const v1 = engine.cardValue(c1.rank);
    const v2 = engine.cardValue(c2.rank);
    if (v1 !== v2 && !(v1 === 10 && v2 === 10)) return io.to(pid).emit('actionError', 'Need a pair to split');
    p.chips -= hand.bet;
    hands.splice(0, 1,
      { cards: [c1, draw(room)], bet: hand.bet, status: 'active', doubled: false, surrendered: false },
      { cards: [c2, draw(room)], bet: hand.bet, status: 'active', doubled: false, surrendered: false });
    io.to(room.id).emit('chat', { sys: true, text: `✂️ ${p.name} splits!` });
    broadcast(room);
    promptTurn(room);
  } else if (kind === 'surrender') {
    if (!room.settings.allowSurrender || hand.cards.length !== 2) {
      return io.to(pid).emit('actionError', 'Cannot surrender now');
    }
    hand.status = 'surrendered';
    const back = Math.floor(hand.bet / 2);
    p.chips += back;
    io.to(room.id).emit('chat', { sys: true, text: `🏳️ ${p.name} surrenders (+${back} back)` });
    nextTurn(room);
  }
}

function dealerPlay(room) {
  clearTimeout(room.timers.turn);
  room.state = 'dealer';
  broadcast(room);
  // small drama delay so players see hole reveal
  setTimeout(() => {
    while (engine.dealerShouldHit(room.dealerHand, room.settings.dealerHitsSoft17)) {
      room.dealerHand.push(draw(room));
    }
    settleRound(room);
  }, 1200);
}

function settleRound(room, note = null) {
  room.state = 'settle';
  const dVal = engine.handValue(room.dealerHand);
  const results = [];
  for (const [pid, hands] of Object.entries(room.hands)) {
    const p = room.players.find((x) => x.id === pid);
    if (!p) continue;
    for (let i = 0; i < hands.length; i++) {
      const h = hands[i];
      if (h.status === 'surrendered') {
        results.push({ pid, hand: i, outcome: 'surrender', payout: 0 });
        p.stats.losses += 1;
        continue;
      }
      const r = engine.settleBet(h.cards, room.dealerHand, h.bet, { blackjackPays: room.settings.blackjackPays });
      p.chips += r.payout;
      if (r.outcome === 'win' || r.outcome === 'blackjack') p.stats.wins += 1;
      else if (r.outcome === 'push') p.stats.pushes += 1;
      else p.stats.losses += 1;
      if (r.outcome === 'blackjack') p.stats.blackjacks += 1;
      results.push({ pid, hand: i, outcome: r.outcome, payout: r.payout, total: engine.handValue(h.cards).total });
    }
  }
  const dealerTotal = dVal.total;
  io.to(room.id).emit('settle', { dealer: room.dealerHand, dealerTotal, dealerBust: dVal.bust, results, note });
  broadcast(room);
  const done = room.round >= room.settings.rounds;
  setTimeout(() => {
    if (done) {
      room.state = 'gameover';
      const board = [...room.players].sort((a, b) => b.chips - a.chips);
      io.to(room.id).emit('gameover', { board: board.map((x) => ({ name: x.name, chips: x.chips, avatar: x.avatar, stats: x.stats })) });
      broadcast(room);
    } else {
      startBetting(room);
    }
  }, 5000);
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, () => console.log(`black-jack.io running on http://localhost:${PORT}`));
