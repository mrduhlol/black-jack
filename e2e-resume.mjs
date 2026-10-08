// E2E: both seats drop mid-game, then reconnect with the same ids.
// The table must idle (no crash) and resume to a finish.
// Needs `npm run dev` in another terminal. E2E_BASE overrides the host.
const BASE = process.env.E2E_BASE || 'http://localhost:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { code } = await (await fetch(`${BASE}/api/liar-create-room`, {
  method: 'POST', signal: AbortSignal.timeout(15000),
})).json();
console.log('room', code);

let seenTurn = false;
let seenOver = null;

function bot(name, id, create) {
  const b = { id, room: null, ws: null };
  b.connect = () => new Promise((res, rej) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/liar/${code}/socket`);
    b.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', create: !!create, playerId: id, name, avatar: { style: 'thumbs', seed: name, bg: '3a2417' } }));
      create = false;
      res();
    };
    ws.onerror = rej;
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'room') b.room = m;
      if (m.t === 'liar_turn') {
        seenTurn = true;
        const me = b.room && b.room.players.find((p) => p.isYou);
        if (!me || me.eliminated || !b.room || b.room.state !== 'playing') return;
        if (m.stage === 'decide') {
          ws.send(JSON.stringify({ t: 'liar_call', liar: Math.random() < 0.5 }));
        } else {
          const hand = me.cards || [];
          if (hand.length) {
            const pick = hand.slice(0, 1 + Math.floor(Math.random() * Math.min(3, hand.length)));
            ws.send(JSON.stringify({ t: 'liar_play', cards: pick.map((c) => c.id), count: pick.length }));
          }
        }
      }
      if (m.t === 'liar_risk') {
        const slots = (b.room && b.room.risk && b.room.risk.slots) || [];
        const open = slots.map((s, i) => (!s.picked ? i : -1)).filter((i) => i >= 0);
        if (open.length) ws.send(JSON.stringify({ t: 'risk_pick', slot: open[0] }));
      }
      if (m.t === 'liar_gameover') seenOver = m;
    };
  });
  b.drop = () => { try { b.ws.close(); } catch {} b.ws = null; };
  return b;
}

const stamp = Date.now();
const bots = [bot('ReA', `re-a-${stamp}`, true), bot('ReB', `re-b-${stamp}`, false)];
await bots[0].connect();
await bots[1].connect();
await sleep(500);
bots[0].ws.send(JSON.stringify({ t: 'set_settings', turnTimer: 10 }));
await sleep(300);
bots[0].ws.send(JSON.stringify({ t: 'start_game' }));

// wait for the game to go live, then drop both seats
const liveDead = Date.now() + 30000;
while (Date.now() < liveDead && !seenTurn) await sleep(250);
if (!seenTurn) { console.log('RESUME_FAIL game never started'); process.exit(1); }
console.log('live, dropping both seats');
bots.forEach((b) => b.drop());
await sleep(4000);
console.log('reconnecting same ids');
await bots[0].connect();
await bots[1].connect();

// the table must finish from here
const dead = Date.now() + 150000;
while (Date.now() < dead && !seenOver) await sleep(500);
bots.forEach((b) => b.drop());
if (seenOver) {
  console.log(`RESUME gameover winner=${seenOver.winnerName}`);
  console.log('RESUME_PASS');
  process.exitCode = 0;
} else {
  console.log('RESUME_FAIL no finish after reconnect');
  process.exitCode = 1;
}
