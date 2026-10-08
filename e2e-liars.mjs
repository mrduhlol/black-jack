// E2E: scripted bots play full Liar's Table games against a local dev server.
// Needs `npm run dev` in another terminal (http://localhost:8787).
// Usage: node e2e-liars.mjs [normal|devil]   (CP=1.0 forces every challenge)
const MODE = process.argv[2] === 'devil' ? 'devil' : 'normal';
const CHALLENGE_P = parseFloat(process.env.CP || '0.45');
const BASE = process.env.E2E_BASE || 'http://localhost:8787';
const WSURL = (code) => `${BASE.replace(/^http/, 'ws')}/liar/${code}/socket`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeBot(code, name, isHost, log) {
  const bot = { name, id: `bot-${name}-${Math.floor(Math.random() * 1e6)}`, room: null, ws: null, over: false };
  bot.connect = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(WSURL(code));
    bot.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', create: isHost, playerId: bot.id, name, avatar: { style: 'thumbs', seed: name, bg: '3a2417' } }));
      resolve();
    };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'room') {
        bot.room = m;
        const me = m.players.find((p) => p.isYou);
        if (me) bot.me = me;
      }
      if (m.t === 'liar_turn') bot.onTurn && bot.onTurn(m);
      if (m.t === 'liar_risk') bot.onRisk && bot.onRisk(m);
      if (m.t === 'liar_gameover') { bot.over = true; bot.result = m; }
      if (m.t === 'error' || m.t === 'liar_error') log(`${name} ERR: ${m.message}`);
    };
  });
  bot.send = (o) => bot.ws.send(JSON.stringify(o));
  bot.close = () => { try { bot.ws.close(); } catch {} };
  return bot;
}

const log = (...a) => console.log('[e2e]', ...a);
const deadline = Date.now() + 150000;

const { code } = await (await fetch(`${BASE}/api/liar-create-room`, { method: 'POST' })).json();
log(`room ${code} mode=${MODE}`);

const bots = [];
const NAMES = ['Alf', 'Bet', 'Cal', 'Dan'];
const N = Math.min(4, Math.max(2, parseInt(process.env.BOTS || '3', 10) || 3));
for (let i = 0; i < N; i++) bots.push(makeBot(code, NAMES[i], i === 0, log));
for (const b of bots) await b.connect();
await sleep(500);

// lobby chat must route before the game starts
let lobbyEcho = false;
const lobbyProbe = (ev) => {
  try {
    const m = JSON.parse(ev.data);
    if (m.t === 'chat' && m.text === 'lobby-hi') lobbyEcho = true;
  } catch {}
};
bots[0].ws.addEventListener('message', lobbyProbe);
bots[0].send({ t: 'chat', text: 'lobby-hi' });
const ldead = Date.now() + 10000;
while (Date.now() < ldead && !lobbyEcho) await sleep(250);
console.log('LOBBYCHAT', lobbyEcho ? 'PASS' : 'FAIL');

if (MODE === 'devil') {
  bots[0].send({ t: 'set_settings', devilMode: true, turnTimer: 10 });
  await sleep(300);
}
bots[0].send({ t: 'set_settings', turnTimer: 10 });
await sleep(300);
bots[0].send({ t: 'start_game' });
await sleep(500);

let stats = { plays: 0, calls: 0, risks: 0, reveals: 0, devilHits: 0 };
for (const b of bots) {
  b.onTurn = (m) => {
    const me = b.room.players.find((p) => p.isYou);
    if (!me || me.eliminated) return;
    if (b.room.state !== 'playing') return;
    if (m.stage === 'play' || b.room.stage === 'play') {
      const hand = me.cards || [];
      if (!hand.length) return;
      const devil = hand.find((c) => c.devil);
      let pick;
      if (devil && Math.random() < 0.8) {
        pick = [devil];
      } else {
        const n = 1 + Math.floor(Math.random() * Math.min(3, hand.length));
        pick = hand.slice().sort(() => Math.random() - 0.5).slice(0, n);
      }
      stats.plays++;
      b.send({ t: 'liar_play', cards: pick.map((c) => c.id), count: pick.length });
    } else {
      const liar = Math.random() < CHALLENGE_P;
      stats.calls++;
      b.send({ t: 'liar_call', liar });
    }
  };
  b.onRisk = () => {
    const r = b.room;
    const slots = (r && r.risk && r.risk.slots) || [];
    const open = slots.map((s, i) => (!s.picked ? i : -1)).filter((i) => i >= 0);
    stats.risks++;
    if (open.length) b.send({ t: 'risk_pick', slot: open[Math.floor(Math.random() * open.length)] });
  };
}

// track reveals/devils via Alf's socket
const seen = { over: null };
bots[0].ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.t === 'liar_reveal') { stats.reveals++; if (m.devil) stats.devilHits++; }
  if (m.t === 'liar_gameover') seen.over = m;
});

while (Date.now() < deadline && !seen.over) await sleep(500);

console.log('STATS', JSON.stringify(stats));
let gamePass = false;
if (seen.over) {
  console.log(`GAMEOVER winner=${seen.over.winnerName} note=${seen.over.note}`);
  console.log('BOARD', JSON.stringify(seen.over.board.map((p) => ({ n: p.name, out: p.eliminated, st: p.stats }))));
  gamePass = true;
} else {
  console.log('E2E_FAIL no gameover in time');
}

// rematch: host runs it back, the table must deal again
let rematchPass = false;
if (gamePass) {
  seen.over = null;
  bots[0].send({ t: 'rematch' });
  const rdead = Date.now() + 60000;
  while (Date.now() < rdead && !rematchPass) {
    await sleep(500);
    rematchPass = bots.some((b) => b.room && b.room.state === 'playing');
  }
}
console.log('REMATCH', rematchPass ? 'PASS' : 'FAIL');

// cooldown probe: 3 rapid chats -> exactly 1 echo; after 1.2s the next goes through
let chatEchoes = 0;
const chatProbe = (ev) => {
  try {
    const m = JSON.parse(ev.data);
    if (m.t === 'chat' && !m.sys && typeof m.text === 'string' && m.text.startsWith('spam-')) chatEchoes++;
  } catch {}
};
bots[0].ws.addEventListener('message', chatProbe);
bots[0].send({ t: 'chat', text: 'spam-1' });
bots[0].send({ t: 'chat', text: 'spam-2' });
bots[0].send({ t: 'chat', text: 'spam-3' });
await sleep(1000);
const afterBurst = chatEchoes;
await sleep(1500);
bots[0].send({ t: 'chat', text: 'spam-4' });
await sleep(1000);
const cooldownPass = afterBurst === 1 && chatEchoes === 2;
console.log(`COOLDOWN burst=${afterBurst} total=${chatEchoes} ${cooldownPass ? 'PASS' : 'FAIL'}`);

if (gamePass && rematchPass && lobbyEcho && cooldownPass) {
  console.log('E2E_PASS');
  process.exitCode = 0;
} else {
  console.log('E2E_FAIL');
  process.exitCode = 1;
}
bots.forEach((b) => b.close());
