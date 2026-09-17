const socket = io();
const $ = (id) => document.getElementById(id);

// --- character picker (cool DiceBear characters) ---
let avatar = { style: AVATAR_STYLES[0].id, seed: randomSeed(), bg: AVATAR_BGS[0] };

function buildAvatarPicker() {
  const sr = $('styleRow');
  const cr = $('colorRow');
  AVATAR_STYLES.forEach((s) => {
    const b = document.createElement('button');
    b.textContent = s.label;
    if (s.id === avatar.style) b.classList.add('sel');
    b.onclick = () => { Sound.click(); avatar.style = s.id; [...sr.children].forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); renderAvatar(); };
    sr.appendChild(b);
  });
  AVATAR_BGS.forEach((c) => {
    const b = document.createElement('button');
    b.style.background = '#' + c;
    if (c === avatar.bg) b.classList.add('sel');
    b.onclick = () => { Sound.click(); avatar.bg = c; [...cr.children].forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); renderAvatar(); };
    cr.appendChild(b);
  });
  renderAvatar();
}
function renderAvatar() {
  const img = $('avatarPreview');
  img.src = avatarUrl(avatar);
  img.style.background = '#' + avatar.bg;
}
$('shuffleBtn').onclick = () => { Sound.click(); avatar.seed = randomSeed(); renderAvatar(); };
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

function avatarImg(p, cls = 'mini-avatar') {
  const img = document.createElement('img');
  img.className = cls;
  img.alt = p.name;
  const url = avatarUrl(p.avatar);
  if (url) {
    img.src = url;
    img.onerror = () => { img.replaceWith(document.createTextNode('🙂')); };
  } else {
    // back-compat: old emoji avatars
    const s = document.createElement('span');
    s.className = cls;
    s.style.background = p.avatar.color || '#ffd54f';
    s.textContent = p.avatar.face || '🙂';
    return s;
  }
  return img;
}

function renderPlayers(r) {
  const box = $('playerList');
  box.innerHTML = '';
  [...r.players].sort((a, b) => b.chips - a.chips).forEach((p) => {
    const div = document.createElement('div');
    div.className = 'player-row';
    div.appendChild(avatarImg(p));
    const label = document.createElement('span');
    label.innerHTML = ` <b>${p.name}</b> ${p.isHost ? '👑' : ''} — <span class="stack-chips"><span class="pile"></span>${p.chips}</span>
      <small>W${p.stats.wins}/L${p.stats.losses}/P${p.stats.pushes} BJ${p.stats.blackjacks}</small>`;
    div.appendChild(label);
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
    head.appendChild(avatarImg(p, 'seat-avatar'));
    const name = document.createElement('span');
    name.innerHTML = ` ${p.name} <span class="stack-chips"><span class="pile"></span>${p.chips}</span>`;
    head.appendChild(name);
    seat.appendChild(head);
    (p.hands || []).forEach((h, i) => {
      const spot = document.createElement('div');
      spot.className = 'bet-spot';
      spot.appendChild(betStack(h.bet));
      seat.appendChild(spot);
      const line = document.createElement('div');
      line.innerHTML = `<small>${h.status}${h.doubled ? ' • x2' : ''} • (${handTotal(h.cards)})</small>`;
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

// real coins: break a bet into poker-chip denominations for the stack visual
const DENOMS = [500, 250, 100, 50, 10];
function breakChips(amount) {
  const out = [];
  let rest = amount;
  for (const d of DENOMS) {
    while (rest >= d) { out.push(d); rest -= d; }
  }
  return out.slice(0, 8);
}
const CHIP_COLORS = { 10: '#2b6cb0', 50: '#229654', 100: '#1a202c', 250: '#6b46c1', 500: '#c53030' };
function betStack(amount) {
  const wrap = document.createElement('div');
  wrap.className = 'bet-stack';
  breakChips(amount).forEach((d, i) => {
    const c = document.createElement('div');
    c.className = 'mini-chip';
    c.style.setProperty('--chip', CHIP_COLORS[d]);
    c.style.bottom = (i * 7) + 'px';
    c.style.marginLeft = ((i % 2) ? 4 : -4) + 'px';
    c.textContent = d;
    wrap.appendChild(c);
  });
  return wrap;
}

// chip tray: tap coins to stack a bet, then deal
let pendingBet = 0;
const TRAY = [10, 50, 100, 250, 500];
function buildChipTray() {
  const row = $('chipRow');
  row.innerHTML = '';
  TRAY.forEach((d) => {
    const b = document.createElement('button');
    b.className = 'poker-chip c' + d;
    b.textContent = d;
    b.onclick = () => {
      const me = room && room.players.find((p) => p.isYou);
      if (pendingBet + d > (me ? me.chips : d)) return;
      pendingBet += d;
      Sound.chips();
      paintTray();
    };
    row.appendChild(b);
  });
  const total = document.createElement('div');
  total.id = 'betTotal';
  total.className = 'bet-total';
  row.appendChild(total);
  paintTray();
}
function paintTray() {
  const t = $('betTotal');
  if (t) t.textContent = pendingBet > 0 ? `Bet: ${pendingBet}` : 'Tap coins to bet';
  [...$('chipRow').querySelectorAll('.poker-chip')].forEach((b) => {
    b.classList.toggle('sel', pendingBet > 0 && Number(b.textContent) <= pendingBet);
  });
}
$('betClear').onclick = () => { Sound.click(); pendingBet = 0; paintTray(); };
$('betGo').onclick = () => {
  if (pendingBet < 10) { pendingBet = 50; }
  Sound.chips();
  socket.emit('placeBet', { amount: pendingBet });
  pendingBet = 0;
  paintTray();
};

// --- turns: Blackjack party features (coach + bust %) ---
socket.on('yourTurn', ({ cards, dealerUp, hint, bustChance, endsIn }) => {
  $('actionPanel').classList.remove('hidden');
  $('betPanel').classList.add('hidden');
  Sound.turn();
  if (navigator.vibrate) navigator.vibrate(80);
  document.title = '🎯 Your turn! — black-jack.io';
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
$('hitBtn').onclick = () => { Sound.click(); Sound.deal(); socket.emit('action', { kind: 'hit' }); };
$('standBtn').onclick = () => { Sound.click(); socket.emit('action', { kind: 'stand' }); };
$('doubleBtn').onclick = () => { Sound.chips(); socket.emit('action', { kind: 'double' }); };
$('splitBtn').onclick = () => { Sound.chips(); socket.emit('action', { kind: 'split' }); };
$('surrenderBtn').onclick = () => { Sound.click(); socket.emit('action', { kind: 'surrender' }); };
socket.on('actionError', (m) => alert(m));

socket.on('settle', ({ dealerTotal, dealerBust, results, note }) => {
  $('actionPanel').classList.add('hidden');
  document.title = 'black-jack.io — party Blackjack';
  Sound.reveal();
  const me = results.filter((r) => room.players.find((p) => p.id === r.pid && p.isYou));
  const banner = $('resultBanner');
  banner.classList.remove('hidden');
  banner.textContent = `${note ? note + ' ' : ''}Dealer ${dealerTotal}${dealerBust ? ' BUST' : ''} • ` +
    me.map((r) => `${r.outcome} ${r.payout > 0 ? '+' + r.payout : ''}`).join(' | ');
  // personal sounds: blackjack fanfare > win > bust thud > lose
  if (me.some((r) => r.outcome === 'blackjack')) Sound.blackjack();
  else if (me.some((r) => r.outcome === 'win')) Sound.win();
  else if (me.some((r) => r.outcome === 'bust')) Sound.bust();
  else if (me.some((r) => r.outcome === 'lose')) Sound.lose();
  setTimeout(() => banner.classList.add('hidden'), 5000);
});
socket.on('gameover', ({ board }) => {
  const banner = $('resultBanner');
  banner.classList.remove('hidden');
  banner.textContent = `🏆 Winner: ${board[0].name} with ${board[0].chips} chips! ` +
    board.map((b, i) => `${i + 1}. ${b.name} ${b.chips}`).join(' • ');
  Sound.blackjack();
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  showWinnerModal(board);
});

function showWinnerModal(board) {
  const modal = $('winnerModal');
  modal.classList.remove('hidden');
  const medals = ['🥇', '🥈', '🥉'];
  const podium = $('podium');
  podium.innerHTML = '';
  const order = [board[1], board[0], board[2]].filter(Boolean); // 2nd, 1st, 3rd visual
  const classes = board[1] ? ['p2', 'p1', 'p3'] : ['p1'];
  order.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'place ' + classes[i];
    d.innerHTML = `${medals[board.indexOf(p)]}<br><span style="font-size:28px">${p.avatar.face}</span><br>${p.name}<br>${p.chips} chips`;
    podium.appendChild(d);
  });
  $('winnerTitle').textContent = `🏆 ${board[0].name} wins the table!`;
  $('winnerStats').textContent = board.map((b) => `${b.name}: ${b.stats.wins}W/${b.stats.losses}L/${b.stats.pushes}P, ${b.stats.blackjacks} BJ`).join(' • ');
  const isHost = room && room.hostId === myId;
  $('rematchBtn').classList.toggle('hidden', !isHost);
  // confetti rain
  const conf = $('confetti');
  conf.innerHTML = '';
  const emojis = ['🎉', '🃏', '💰', '⭐', '🎊', '♠️', '♥️'];
  for (let i = 0; i < 40; i++) {
    const s = document.createElement('span');
    s.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    s.style.left = Math.random() * 100 + '%';
    s.style.animationDelay = (Math.random() * 1.5) + 's';
    conf.appendChild(s);
  }
}
$('closeModalBtn').onclick = () => { Sound.click(); $('winnerModal').classList.add('hidden'); };
$('rematchBtn').onclick = () => { Sound.chips(); socket.emit('rematch'); $('winnerModal').classList.add('hidden'); };

// round history ticker
socket.on('room', (r) => {
  // history is rendered by second listener to keep main render clean
  const bar = document.getElementById('historyBar');
  if (r.history && r.history.length) {
    bar.classList.remove('hidden');
    bar.textContent = '📜 ' + r.history.join('   •   ');
  }
});
socket.on('phase', ({ phase }) => { if (phase === 'betting') Sound.chips(); if (phase === 'playing') Sound.deal(); });

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
