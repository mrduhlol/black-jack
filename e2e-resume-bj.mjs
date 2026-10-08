// E2E: blackjack seats drop mid-game, reconnect with the same ids, finish.
// Needs `npm run dev` in another terminal. E2E_BASE overrides the host.
const BASE = process.env.E2E_BASE || 'http://localhost:8787';
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

const { code } = await (await fetch(`${BASE}/api/create-room`, {
  method: 'POST', signal: AbortSignal.timeout(15000),
})).json();
console.log('room', code);

let seenSettle = false;
let seenOver = null;

function bot(name, id, create) {
  const b = { id, room: null, ws: null };
  b.connect = () => new Promise((res, rej) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/room/${code}/socket`);
    b.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', create: !!create, playerId: id, name, avatar: { style: 'adventurer', seed: name, bg: 'ffd54f' } }));
      create = false;
      res();
    };
    ws.onerror = rej;
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'room') {
        b.room = m;
        const me = m.players.find((p) => p.isYou);
        if (m.state === 'betting' && me && !(me.hands || []).length && !me.spectating) {
          ws.send(JSON.stringify({ t: 'place_bet', amount: 50 }));
        }
      }
      if (m.t === 'your_turn') {
        const t = total(m.cards || []);
        ws.send(JSON.stringify({ t: 'action', kind: t < 17 ? 'hit' : 'stand' }));
      }
      if (m.t === 'settle') seenSettle = true;
      if (m.t === 'gameover') seenOver = m;
    };
  });
  b.drop = () => { try { b.ws.close(); } catch {} b.ws = null; };
  return b;
}

const stamp = Date.now();
const bots = [bot('ReA', `bj-a-${stamp}`, true), bot('ReB', `bj-b-${stamp}`, false)];
await bots[0].connect();
await bots[1].connect();
await sleep(500);
bots[0].ws.send(JSON.stringify({ t: 'set_settings', rounds: 2, betTimer: 8, turnTimer: 10 }));
await sleep(300);
bots[0].ws.send(JSON.stringify({ t: 'start_game' }));

// wait for the first settled round, then drop both seats
const liveDead = Date.now() + 90000;
while (Date.now() < liveDead && !seenSettle) await sleep(250);
if (!seenSettle) { console.log('RESUME_FAIL no live round'); process.exit(1); }
console.log('round settled, dropping both seats');
bots.forEach((b) => b.drop());
await sleep(4000);
console.log('reconnecting same ids');
await bots[0].connect();
await bots[1].connect();

const dead = Date.now() + 150000;
while (Date.now() < dead && !seenOver) await sleep(500);
bots.forEach((b) => b.drop());
if (seenOver) {
  console.log(`RESUME gameover, top=${seenOver.board[0].name} ${seenOver.board[0].chips}`);
  console.log('RESUME_PASS');
  process.exitCode = 0;
} else {
  console.log('RESUME_FAIL no finish after reconnect');
  process.exitCode = 1;
}
