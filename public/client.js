const socket = io();
const $ = (id) => document.getElementById(id);

// --- skribbl-style avatar picker ---
const FACES = ['🙂', '😎', '🤠', '🦊', '🐼', '🤖', '👽', '🔥'];
const COLORS = ['#ffd54f', '#ff8a80', '#80d8ff', '#b9f6ca', '#ea80fc', '#ffccbc'];
let avatar = { face: FACES[0], color: COLORS[0] };

function buildAvatarPicker() {
  const fr = $('faceRow');
  const cr = $('colorRow');
  FACES.forEach((f) => {
    const b = document.createElement('button');
    b.textContent = f;
    if (f === avatar.face) b.classList.add('sel');
    b.onclick = () => { avatar.face = f; [...fr.children].forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); renderAvatar(); };
    fr.appendChild(b);
  });
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.style.background = c;
    b.textContent = '●';
    if (c === avatar.color) b.classList.add('sel');
    b.onclick = () => { avatar.color = c; [...cr.children].forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); renderAvatar(); };
    cr.appendChild(b);
  });
  renderAvatar();
}
function renderAvatar() {
  const p = $('avatarPreview');
  p.textContent = avatar.face;
  p.style.background = avatar.color;
}
function myName() {
  return ($('nameInput').value || 'Player').slice(0, 14);
}

buildAvatarPicker();
// auto-fill invite code from ?XXXXXX like skribbl.io
const qs = new URLSearchParams(location.search);
if ([...qs.keys()][0]) $('codeInput').value = [...qs.keys()][0].toUpperCase();

$('playBtn').onclick = () => socket.emit('joinPublic', { name: myName(), avatar });
$('createBtn').onclick = () => socket.emit('createPrivate', { name: myName(), avatar });
$('joinBtn').onclick = () => socket.emit('joinPrivate', { code: $('codeInput').value.trim(), name: myName(), avatar });

socket.on('roomCreated', ({ id }) => {
  history.replaceState(null, '', `/?${id}`);
});
socket.on('joinError', (msg) => alert(msg));

// --- room rendering ---
let room = null;
let myId = null;

socket.on('room', (r) => {
  room = r;
  const me = r.players.find((p) => p.isYou);
  if (me) myId = me.id;
  $('landing').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('roomBadge').classList.remove('hidden');
  $('roomBadge').textContent = `Room ${r.id} • ${r.state} • R${r.round}/${r.settings.rounds}`;
  $('roundLabel').textContent = `Round ${r.round}/${r.settings.rounds}`;
  $('phaseLabel').textContent = r.state;
  renderPlayers(r);
  renderDealer(r);
  renderSeats(r);
  renderLobby(r);
  renderBetting(r);
});

function cardEl(c) {
  const d = document.createElement('div');
  d.className = 'playing-card';
  if (c.hidden) { d.classList.add('back'); d.textContent = '?'; return d; }
  const red = c.suit === '♥' || c.suit === '♦';
  if (red) d.classList.add('red');
  d.textContent = `${c.rank}${c.suit}`;
  return d;
}
function handTotal(cards) {
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

function renderDealer(r) {
  const box = $('dealerCards');
  box.innerHTML = '';
  r.dealer.forEach((c) => box.appendChild(cardEl(c)));
  $('dealerTotal').textContent = r.dealer.length ? `(${handTotal(r.dealer)})` : '';
}

function renderPlayers(r) {
  const box = $('playerList');
  box.innerHTML = '';
  [...r.players].sort((a, b) => b.chips - a.chips).forEach((p) => {
    const div = document.createElement('div');
    div.innerHTML = `<span class="mini-avatar" style="background:${p.avatar.color}">${p.avatar.face}</span>
      <b>${p.name}</b> ${p.isHost ? '👑' : ''} — ${p.chips} chips
      <small>W${p.stats.wins}/L${p.stats.losses}/P${p.stats.pushes} BJ${p.stats.blackjacks}</small>`;
    if (p.isHost && myId && r.hostId === myId && p.id !== myId) {
      const k = document.createElement('button');
      k.textContent = 'kick';
      k.className = 'small';
      k.onclick = () => socket.emit('kick', { targetId: p.id });
      div.appendChild(k);
    }
    box.appendChild(div);
  });
}

function renderSeats(r) {
  const box = $('seats');
  box.innerHTML = '';
  r.players.forEach((p) => {
    const seat = document.createElement('div');
    seat.className = 'seat' + (r.turnId === p.id ? ' turn' : '');
    const head = document.createElement('div');
    head.className = 'seat-head';
    head.innerHTML = `<span class="mini-avatar" style="background:${p.avatar.color}">${p.avatar.face}</span> ${p.name} (${p.chips})`;
    seat.appendChild(head);
    (p.hands || []).forEach((h, i) => {
      const line = document.createElement('div');
      line.innerHTML = `<small>Bet ${h.bet} • ${h.status}${h.doubled ? ' • x2' : ''} • (${handTotal(h.cards)})</small>`;
      const cards = document.createElement('div');
      cards.className = 'cards';
      h.cards.forEach((c) => cards.appendChild(cardEl(c)));
      seat.appendChild(line);
      seat.appendChild(cards);
    });
    box.appendChild(seat);
  });
}
