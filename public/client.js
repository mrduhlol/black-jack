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

$('playBtn').onclick = () => { Sound.click(); socket.emit('joinPublic', { name: myName(), avatar }); };
$('createBtn').onclick = () => { Sound.click(); socket.emit('createPrivate', { name: myName(), avatar }); };
$('joinBtn').onclick = () => { Sound.click(); socket.emit('joinPrivate', { code: $('codeInput').value.trim(), name: myName(), avatar }); };
$('soundBtn').onclick = () => {
  const on = Sound.toggle();
  $('soundBtn').textContent = on ? '🔊' : '🔇';
  if (on) Sound.click();
};

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

function renderLobby(r) {
  const isHost = r.hostId === myId;
  $('lobbyPanel').style.display = r.state === 'lobby' ? 'block' : 'none';
  $('startBtn').classList.toggle('hidden', !isHost);
  const s = $('settingsBox');
  s.innerHTML = '';
  const defs = [
    ['maxPlayers', 'Max players', 'number', 2, 7],
    ['startingChips', 'Starting chips', 'number', 100, 10000],
    ['rounds', 'Rounds', 'number', 2, 20],
    ['turnTimer', 'Turn timer (s)', 'number', 5, 60],
    ['betTimer', 'Bet timer (s)', 'number', 5, 60],
    ['numDecks', 'Decks', 'number', 1, 8],
  ];
  defs.forEach(([key, label, type, min, max]) => {
    const lab = document.createElement('label');
    lab.textContent = `${label}: `;
    const inp = document.createElement('input');
    inp.type = type; inp.min = min; inp.max = max; inp.value = r.settings[key];
    inp.disabled = !isHost;
    inp.onchange = () => socket.emit('setSettings', { [key]: Number(inp.value) });
    lab.appendChild(inp);
    s.appendChild(lab);
  });
  const toggles = [['dealerHitsSoft17', 'Dealer hits soft 17 (H17)'], ['allowDouble', 'Allow double'], ['allowSplit', 'Allow split'], ['allowSurrender', 'Allow surrender'], ['coachEnabled', 'Coach hints + bust %']];
  toggles.forEach(([key, label]) => {
    const lab = document.createElement('label');
    const inp = document.createElement('input');
    inp.type = 'checkbox'; inp.checked = !!r.settings[key]; inp.disabled = !isHost;
    inp.onchange = () => socket.emit('setSettings', { [key]: inp.checked });
    lab.appendChild(inp); lab.append(` ${label}`);
    s.appendChild(lab);
  });
  const pay = document.createElement('label');
  pay.textContent = 'Blackjack pays: ';
  const sel = document.createElement('select');
  ['3:2', '6:5'].forEach((v) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v; if (r.settings.blackjackPays === v) o.selected = true;
    sel.appendChild(o);
  });
  sel.disabled = !isHost;
  sel.onchange = () => socket.emit('setSettings', { blackjackPays: sel.value });
  pay.appendChild(sel);
  s.appendChild(pay);
}
$('startBtn').onclick = () => socket.emit('startGame');

function renderBetting(r) {
  const me = r.players.find((p) => p.isYou);
  const show = r.state === 'betting' && me && !me.spectating && (!me.hands || me.hands.length === 0);
  $('betPanel').classList.toggle('hidden', !show);
  $('actionPanel').classList.add('hidden');
}
document.querySelectorAll('[data-bet]').forEach((b) => {
  b.onclick = () => { $('betInput').value = b.dataset.bet; };
});
$('betGo').onclick = () => socket.emit('placeBet', { amount: Number($('betInput').value) });

// --- turns: Blackjack party features (coach + bust %) ---
socket.on('yourTurn', ({ cards, dealerUp, hint, bustChance, endsIn }) => {
  $('actionPanel').classList.remove('hidden');
  $('betPanel').classList.add('hidden');
  $('coachBox').textContent = hint
    ? `🧠 Coach: ${hint} • 💥 Bust if hit: ${bustChance}% • Dealer shows ${dealerUp.rank}${dealerUp.suit}`
    : `Dealer shows ${dealerUp.rank}${dealerUp.suit} • Bust if hit: ${bustChance}%`;
  let t = endsIn;
  $('turnTimer').textContent = `⏱ ${t}s`;
  clearInterval(window._tt);
  window._tt = setInterval(() => {
    t -= 1;
    if (t <= 0) clearInterval(window._tt);
    else $('turnTimer').textContent = `⏱ ${t}s`;
  }, 1000);
});
$('hitBtn').onclick = () => socket.emit('action', { kind: 'hit' });
$('standBtn').onclick = () => socket.emit('action', { kind: 'stand' });
$('doubleBtn').onclick = () => socket.emit('action', { kind: 'double' });
$('splitBtn').onclick = () => socket.emit('action', { kind: 'split' });
$('surrenderBtn').onclick = () => socket.emit('action', { kind: 'surrender' });
socket.on('actionError', (m) => alert(m));

socket.on('settle', ({ dealerTotal, dealerBust, results, note }) => {
  $('actionPanel').classList.add('hidden');
  const me = results.filter((r) => room.players.find((p) => p.id === r.pid && p.isYou));
  const banner = $('resultBanner');
  banner.classList.remove('hidden');
  banner.textContent = `${note ? note + ' ' : ''}Dealer ${dealerTotal}${dealerBust ? ' BUST' : ''} • ` +
    me.map((r) => `${r.outcome} ${r.payout > 0 ? '+' + r.payout : ''}`).join(' | ');
  setTimeout(() => banner.classList.add('hidden'), 5000);
});
socket.on('gameover', ({ board }) => {
  const banner = $('resultBanner');
  banner.classList.remove('hidden');
  banner.textContent = `🏆 Winner: ${board[0].name} with ${board[0].chips} chips! ` +
    board.map((b, i) => `${i + 1}. ${b.name} ${b.chips}`).join(' • ');
});

// --- chat + emotes (skribbl-style social) ---
function addChat({ name, avatar: av, text, sys }) {
  const box = $('chatBox');
  const div = document.createElement('div');
  div.textContent = sys ? text : `${name}: ${text}`;
  if (sys) div.style.opacity = '.7';
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
socket.on('chat', addChat);
socket.on('phase', ({ phase, round }) => addChat({ sys: true, text: `— ${phase} (round ${round}) —` }));
socket.on('emote', ({ name, emoji }) => addChat({ sys: true, text: `${name} ${emoji}` }));
$('chatSend').onclick = sendChat;
$('chatInput').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
function sendChat() {
  const v = $('chatInput').value;
  $('chatInput').value = '';
  socket.emit('chat', { text: v });
}
['🔥', '😎', '😭', '🍀', '💸', '👏', '🤯', '🃏'].forEach((e) => {
  const b = document.createElement('button');
  b.textContent = e;
  b.onclick = () => socket.emit('emote', { emoji: e });
  $('emoteRow').appendChild(b);
});
$('copyLinkBtn').onclick = () => {
  const url = `${location.origin}/?${room.id}`;
  navigator.clipboard.writeText(url).then(() => alert('Invite copied: ' + url));
};
$('leaveBtn').onclick = () => { socket.emit('leave'); location.href = '/'; };
socket.on('kicked', () => { alert('Kicked by host'); location.href = '/'; });
