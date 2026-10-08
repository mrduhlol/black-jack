// E2E: scripted bots play a full Blackjack game against a local dev server.
// Needs `npm run dev` in another terminal (http://localhost:8787).
const BASE = process.env.E2E_BASE || 'http://localhost:8787';
const WSURL = (code) => `${BASE.replace(/^http/, 'ws')}/room/${code}/socket`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function total(cards) {
  let t = 0, aces = 0;
  for (const c of cards) {
    if (c.hidden) continue;
    if (c.rank === 'A') { t += 11; aces++; }
    else if (['K', 'Q', 'J'].includes(c.rank)) t += 10;
    else t += parseInt(c.rank, 10);
  }
  while (t > 21 && aces > 0) { t -= 10; aces--; }
  return t;
}

function makeBot(code, name, isHost) {
  const bot = { name, id: `bj-${name}-${Math.floor(Math.random() * 1e6)}`, room: null, ws: null };
  bot.connect = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(WSURL(code));
    bot.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', create: isHost, playerId: bot.id, name, avatar: { style: 'adventurer', seed: name, bg: 'ffd54f' } }));
      resolve();
    };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'room') bot.room = m;
      if (m.t === 'your_turn') bot.onTurn && bot.onTurn(m);
      if (m.t === 'settle') stats.settles++;
      if (m.t === 'gameover') { seen.over = m; }
      if (m.t === 'action_error') { console.log('[e2e]', name, 'ERR:', m.message); bot.onActionError && bot.onActionError(m); }
    };
  });
  bot.send = (o) => bot.ws.send(JSON.stringify(o));
  bot.close = () => { try { bot.ws.close(); } catch {} };
  return bot;
}

const stats = { settles: 0, bets: 0, actions: 0, fancy: 0 };
const seen = { over: null };
const deadline = Date.now() + 150000;

const { code } = await (await fetch(`${BASE}/api/create-room`, { method: 'POST', signal: AbortSignal.timeout(15000) })).json();
console.log('[e2e] room', code);

const bots = [makeBot(code, 'Alf', true), makeBot(code, 'Bet', false)];
for (const b of bots) await b.connect();
await sleep(500);

bots[0].send({ t: 'set_settings', rounds: 2, betTimer: 8, turnTimer: 10 });
await sleep(300);
bots[0].send({ t: 'start_game' });

for (const b of bots) {
  const basic = (cards) => {
    const t = total(cards);
    stats.actions++;
    b.send({ t: 'action', kind: t < 17 ? 'hit' : 'stand' });
  };
  b.onTurn = (m) => {
    const cards = m.cards || [];
    b.lastCards = cards;
    const t = total(cards);
    if (cards.length === 2 && !b.triedFancy) {
      b.triedFancy = true;
      if (t >= 9 && t <= 11) { stats.fancy++; return b.send({ t: 'action', kind: 'double' }); }
      if (cards[0].rank === cards[1].rank) { stats.fancy++; return b.send({ t: 'action', kind: 'split' }); }
      if (t === 15 || t === 16) { stats.fancy++; return b.send({ t: 'action', kind: 'surrender' }); }
    }
    b.triedFancy = false;
    basic(cards);
  };
  b.onActionError = () => { if (b.lastCards) basic(b.lastCards); };
}

// auto-bet whenever anyone is in betting with no hands yet
const betLoop = setInterval(() => {
  for (const b of bots) {
    const me = b.room && b.room.players.find((p) => p.isYou);
    if (b.room && b.room.state === 'betting' && me && !(me.hands || []).length && !me.spectating) {
      stats.bets++;
      b.send({ t: 'place_bet', amount: 50 });
    }
  }
}, 700);

while (Date.now() < deadline && !seen.over) await sleep(500);
clearInterval(betLoop);

console.log('STATS', JSON.stringify(stats));
let gamePass = false;
if (seen.over) {
  console.log('GAMEOVER', JSON.stringify(seen.over.board.map((p) => ({ n: p.name, chips: p.chips }))));
  gamePass = true;
} else {
  console.log('E2E_FAIL no gameover in time');
}

// rematch: host runs it back, betting must reopen
let rematchPass = false;
if (gamePass) {
  seen.over = null;
  bots[0].send({ t: 'rematch' });
  const rdead = Date.now() + 60000;
  while (Date.now() < rdead && !rematchPass) {
    await sleep(500);
    rematchPass = bots.some((b) => b.room && (b.room.state === 'betting' || b.room.state === 'playing'));
  }
}
console.log('REMATCH', rematchPass ? 'PASS' : 'FAIL');

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
await sleep(600);
const afterBurst = chatEchoes;
await sleep(1200);
bots[0].send({ t: 'chat', text: 'spam-4' });
await sleep(600);
const cooldownPass = afterBurst === 1 && chatEchoes === 2;
console.log(`COOLDOWN burst=${afterBurst} total=${chatEchoes} ${cooldownPass ? 'PASS' : 'FAIL'}`);

if (gamePass && rematchPass && cooldownPass) {
  console.log('E2E_PASS');
  process.exitCode = 0;
} else {
  console.log('E2E_FAIL');
  process.exitCode = 1;
}
bots.forEach((b) => b.close());
