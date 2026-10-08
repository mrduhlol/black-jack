// E2E: public liar matchmaking hands out a joinable lobby, and the
// invite-link mode lookup reports it as such.
// Needs `npm run dev` in another terminal. E2E_BASE overrides the host.
const BASE = process.env.E2E_BASE || 'http://localhost:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pub = await (await fetch(`${BASE}/api/liar-public-room`, {
  method: 'POST', signal: AbortSignal.timeout(15000),
})).json();
console.log('public code =', pub.code);
if (!pub.code) { console.log('MATCH_FAIL no code'); process.exit(1); }

const modeRes = await fetch(`${BASE}/api/room-mode?code=${encodeURIComponent(pub.code)}`, { signal: AbortSignal.timeout(15000) });
const { mode } = await modeRes.json();
console.log('room-mode =', mode);
if (mode !== 'liars') { console.log('MATCH_FAIL wrong mode'); process.exit(1); }

const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/liar/${pub.code}/socket`);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let lobbySeen = false;
ws.onmessage = (ev) => {
  try {
    const m = JSON.parse(ev.data);
    if (m.t === 'room' && m.state === 'lobby') lobbySeen = true;
    if (m.t === 'error') console.log('server error:', m.message);
  } catch {}
};
ws.send(JSON.stringify({ t: 'join', create: true, playerId: `match-${Date.now()}`, name: 'Match', avatar: { style: 'thumbs', seed: 'm', bg: '3a2417' } }));
const dead = Date.now() + 15000;
while (Date.now() < dead && !lobbySeen) await sleep(250);
ws.close();
if (lobbySeen) { console.log('MATCH_PASS'); process.exitCode = 0; }
else { console.log('MATCH_FAIL no lobby'); process.exitCode = 1; }
