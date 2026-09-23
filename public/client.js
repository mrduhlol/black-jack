const socket = io();
const $ = (id) => document.getElementById(id);

const CROWN_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 17 2 7l5.5 3.5L12 4l4.5 6.5L22 7l-1 10H3Zm0 2h18v2H3v-2Z"/></svg>';
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- gameplay state UX (display-only; no rule/socket changes) ----
let prevSnap = null;          // { phase, turnId, round, hands: Map(pid -> sig) }
let prevPlayerIds = new Set();
let settleMap = null;         // Map(`${pid}:${handIdx}` -> { outcome, payout }) for settle overrides
let betEndsAt = 0;            // local deadline for betting countdown
let betTotalSecs = 0;
let turnEndsAt = 0;           // local deadline for turn countdown (mine + observed)
let turnTotalSecs = 0;
let warnedAt = 0;
let chatUnread = 0;
// --- room rendering state (declared early: ticker + paintTray run before init) ---
let room = null;
let myId = null;
let lastTurn = null;
// --- chip tray state (declared early: buildChipTray runs during init) ---
let pendingBet = 0;
let pendingStack = [];
const TRAY = [10, 50, 100, 250, 500];
// real coins: denominations + colors (used by paintTray during init)
const DENOMS = [500, 250, 100, 50, 10];
const CHIP_COLORS = { 10: '#2b6cb0', 50: '#1f9d63', 100: '#2b313c', 250: '#6b5cc7', 500: '#b32335' };

function toast(msg, kind = '') {
  const stack = $('toastStack');
  if (!stack || !msg) return;
  while (stack.children.length >= 3) stack.firstChild.remove();
  const d = document.createElement('div');
  d.className = ('toast ' + kind).trim();
  d.textContent = msg;
  stack.appendChild(d);
  setTimeout(() => d.classList.add('out'), 3400);
  setTimeout(() => d.remove(), 3800);
}
function setLastEvent(msg) {
  const el = $('lastEvent');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.remove('flash');
  if (msg) { void el.offsetWidth; el.classList.add('flash'); }
}
function sigHands(hands) {
  return JSON.stringify((hands || []).map((h) => ({
    c: h.cards.map((c) => (c.hidden ? '?' : c.rank + c.suit)).join(','),
    s: h.status, b: h.bet, d: !!h.doubled,
  })));
}
function cardsSig(cards) {
  return (cards || []).map((c) => (c.hidden ? '?' : c.rank + c.suit)).join(',');
}
function playerName(r, pid) {
  const p = r.players.find((x) => x.id === pid);
  return p ? p.name : 'A player';
}
function clearActionPending() {
  document.querySelectorAll('.btn.action.pending').forEach((b) => b.classList.remove('pending'));
  document.querySelectorAll('.btn.action').forEach((b) => { b.disabled = false; b.classList.remove('awaiting'); });
  const go = $('betGo');
  if (go) go.classList.remove('pending');
}
function markActionPending(btn) {
  if (!btn) return;
  btn.classList.add('pending');
  document.querySelectorAll('.btn.action').forEach((b) => {
    if (b !== btn) { b.disabled = true; b.classList.add('awaiting'); }
  });
}

// Central 500ms ticker: betting + turn countdowns (display only).
setInterval(() => {
  const now = Date.now();
  const pc = $('phaseCount');
  if (room && pc) {
    let show = false, secs = 0, total = 0;
    if (room.state === 'betting' && betEndsAt > now) { secs = Math.ceil((betEndsAt - now) / 1000); total = betTotalSecs; show = true; }
    else if (room.state === 'playing' && turnEndsAt > now) { secs = Math.ceil((turnEndsAt - now) / 1000); total = turnTotalSecs; show = true; }
    pc.classList.toggle('hidden', !show);
    if (show) {
      pc.textContent = `${secs}s`;
      pc.classList.toggle('urgent', secs <= 5);
      if (secs <= 5 && secs > 0 && now - warnedAt > 4500) { warnedAt = now; Sound.warning(); }
    } else pc.classList.remove('urgent');
    void total;
  }
  if (room && room.state === 'betting' && betEndsAt > 0) {
    const lbl = $('betTimerLabel'), fill = $('betTimerFill'), wrap = $('betBarWrap');
    const secs = Math.max(0, Math.ceil((betEndsAt - now) / 1000));
    if (lbl) {
      lbl.textContent = betEndsAt > now ? `${secs}s left` : 'Closing…';
      lbl.classList.toggle('urgent', betEndsAt > now && secs <= 5);
    }
    if (fill && betTotalSecs > 0) {
      const pct = Math.max(0, Math.min(100, (betEndsAt - now) / (betTotalSecs * 1000) * 100));
      fill.style.width = pct + '%';
      if (wrap) wrap.setAttribute('aria-valuenow', String(Math.round(100 - pct)));
    }
  }
  // Observer seat countdown (mine is driven by startTurnCountdown; this mirrors others).
  if (room && room.state === 'playing' && turnEndsAt > now) {
    const el = document.querySelector('.seat.turn .turn-secs');
    if (el) el.textContent = ` · ${Math.ceil((turnEndsAt - now) / 1000)}s`;
  }
}, 500);

// --- character picker ---
let avatar = { style: AVATAR_STYLES[0].id, seed: randomSeed(), bg: AVATAR_BGS[0] };

function buildAvatarPicker() {
  const sr = $('styleRow');
  const cr = $('colorRow');
  sr.innerHTML = '';
  cr.innerHTML = '';
  AVATAR_STYLES.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.label;
    if (s.id === avatar.style) b.classList.add('sel');
    b.setAttribute('aria-pressed', s.id === avatar.style ? 'true' : 'false');
    b.onclick = () => { Sound.unlock(); Sound.click(); avatar.style = s.id; [...sr.children].forEach((x) => { x.classList.remove('sel'); x.setAttribute('aria-pressed', 'false'); }); b.classList.add('sel'); b.setAttribute('aria-pressed', 'true'); renderAvatar(); };
    sr.appendChild(b);
  });
  AVATAR_BGS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = '#' + c;
    b.setAttribute('aria-label', 'Avatar background #' + c);
    b.setAttribute('aria-pressed', c === avatar.bg ? 'true' : 'false');
    if (c === avatar.bg) b.classList.add('sel');
    b.onclick = () => { Sound.unlock(); Sound.click(); avatar.bg = c; [...cr.children].forEach((x) => { x.classList.remove('sel'); x.setAttribute('aria-pressed', 'false'); }); b.classList.add('sel'); b.setAttribute('aria-pressed', 'true'); renderAvatar(); };
    cr.appendChild(b);
  });
  renderAvatar();
}
function renderAvatar() {
  const img = $('avatarPreview');
  img.src = avatarUrl(avatar);
  img.style.background = '#' + avatar.bg;
}
$('shuffleBtn').onclick = () => { Sound.unlock(); Sound.click(); avatar.seed = randomSeed(); renderAvatar(); };
function myName() {
  return ($('nameInput').value || 'Player').slice(0, 14);
}

buildAvatarPicker();
buildChipTray();
initSoundUI();
initMobileTabs();
// auto-fill invite code from ?XXXXXX like skribbl.io
const qs = new URLSearchParams(location.search);
if ([...qs.keys()][0]) $('codeInput').value = [...qs.keys()][0].toUpperCase();

$('playBtn').onclick = () => { Sound.unlock(); Sound.click(); socket.emit('joinPublic', { name: myName(), avatar }); };
$('createBtn').onclick = () => { Sound.unlock(); Sound.click(); socket.emit('createPrivate', { name: myName(), avatar }); };
$('joinBtn').onclick = () => { Sound.unlock(); Sound.click(); socket.emit('joinPrivate', { code: $('codeInput').value.trim(), name: myName(), avatar }); };

// --- sound settings UI (mute + volume, persisted in sounds.js) ---
function initSoundUI() {
  const btn = $('soundBtn'), pop = $('soundPop');
  if (!btn || !pop) return;
  const vol = $('volumeRange'), muteBtn = $('muteToggleBtn'), label = $('soundStateLabel');
  const paint = () => {
    const on = Sound.enabled;
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-expanded', String(!pop.classList.contains('hidden')));
    const a = btn.querySelector('.ic-sound-on');
    const b = btn.querySelector('.ic-sound-off');
    if (a) a.classList.toggle('hidden', !on);
    if (b) b.classList.toggle('hidden', on);
    if (vol) vol.value = String(Math.round(Sound.volume * 100));
    if (muteBtn) muteBtn.textContent = on ? 'Mute' : 'Unmute';
    if (label) label.textContent = on ? 'Sound on' : 'Muted';
  };
  paint();
  btn.onclick = (e) => {
    e.stopPropagation();
    Sound.unlock();
    pop.classList.toggle('hidden');
    paint();
  };
  document.addEventListener('click', (e) => {
    if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      pop.classList.add('hidden');
      paint();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.classList.contains('hidden')) { pop.classList.add('hidden'); paint(); btn.focus(); }
  });
  if (muteBtn) muteBtn.onclick = () => { const on = Sound.toggle(); paint(); if (on) Sound.click(); };
  if (vol) vol.oninput = () => {
    Sound.unlock();
    Sound.setVolume(Number(vol.value) / 100);
    if (Sound.muted && Number(vol.value) > 0) Sound.setMuted(false);
    paint();
  };
  // long-press / double-click legacy behavior: quick toggle
  btn.ondblclick = () => { Sound.toggle(); paint(); };
}

// --- mobile tabs: Table / Players / Chat ---
function initMobileTabs() {
  const side = $('sidePanel');
  if (!side) return;
  side.dataset.mobileView = 'table';
  const set = (view) => {
    side.dataset.mobileView = view;
    [['tabTable', 'table'], ['tabPlayers', 'players'], ['tabChat', 'chat']].forEach(([id, v]) => {
      const b = $(id);
      if (!b) return;
      const sel = v === view;
      b.classList.toggle('sel', sel);
      b.setAttribute('aria-pressed', String(sel));
    });
    if (view === 'chat') {
      chatUnread = 0;
      paintChatBadge();
      const det = document.querySelector('.chat-card');
      if (det && !det.open) det.open = true;
      setTimeout(() => { const inp = $('chatInput'); if (inp && window.innerWidth <= 760) { /* keep keyboard closed until tap */ } }, 50);
    }
  };
  if ($('tabTable')) $('tabTable').onclick = () => { Sound.click(); set('table'); };
  if ($('tabPlayers')) $('tabPlayers').onclick = () => { Sound.click(); set('players'); };
  if ($('tabChat')) $('tabChat').onclick = () => { Sound.click(); set('chat'); };
}
function paintChatBadge() {
  const badge = $('chatBadge');
  const dot = $('chatDot');
  if (badge) {
    badge.textContent = chatUnread > 0 ? String(Math.min(99, chatUnread)) : '';
    badge.classList.toggle('hidden', chatUnread <= 0);
  }
  if (dot) dot.classList.toggle('hidden', chatUnread <= 0);
}

socket.on('roomCreated', ({ id }) => {
  history.replaceState(null, '', `/?${id}`);
});
socket.on('joinError', (msg) => toast(String(msg || 'Could not join room'), 'bad'));
socket.on('kicked', () => { toast('Kicked by host', 'bad'); setTimeout(() => { location.href = '/'; }, 900); });

// --- room rendering (state declared at top) ---
socket.on('room', (r) => {
  room = r;
  const me = r.players.find((p) => p.isYou);
  if (me) myId = me.id;
  $('landing').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('roomBadge').classList.remove('hidden');
  $('roomBadge').textContent = `Room ${r.id} · R${r.round}/${r.settings.rounds}`;
  $('roundLabel').textContent = `Round ${r.round}/${r.settings.rounds}`;
  $('phaseLabel').textContent = prettyPhase(r.state);
  if ($('lobbyCode')) $('lobbyCode').textContent = r.id;
  if ($('sideRoomCode')) $('sideRoomCode').textContent = r.id;
  if ($('sidePlayerCount')) $('sidePlayerCount').textContent = `${r.players.length}/${r.settings.maxPlayers}`;
  if ($('playerCountBadge')) $('playerCountBadge').textContent = r.players.length ? String(r.players.length) : '';
  clearActionPending();
  detectJoinLeave(prevPlayerIds, r);
  prevPlayerIds = new Set(r.players.map((p) => p.id));
  detectHandEvents(prevSnap, r);
  detectPhaseChange(prevSnap, r);
  if (!prevSnap || prevSnap.turnId !== r.turnId) {
    if (r.state === 'playing' && r.turnId && r.turnId !== myId) {
      turnEndsAt = Date.now() + (r.settings.turnTimer || 20) * 1000;
      turnTotalSecs = r.settings.turnTimer || 20;
    }
    if (r.state !== 'playing') { turnEndsAt = 0; turnTotalSecs = 0; }
  }
  if (r.state === 'betting' && (!prevSnap || prevSnap.phase !== 'betting')) {
    settleMap = null;
    betEndsAt = Date.now() + (r.settings.betTimer || 20) * 1000;
    betTotalSecs = r.settings.betTimer || 20;
    document.querySelectorAll('.seat').forEach((s) => s.classList.remove('outcome-win', 'outcome-blackjack', 'outcome-lose', 'outcome-bust', 'outcome-push'));
  }
  if (r.state !== 'betting') { betEndsAt = 0; }
  renderPlayers(r);
  renderDealer(r);
  renderSeats(r);
  renderLobby(r);
  renderBetting(r);
  updatePhaseBanner(r);
  refreshActions();
  prevSnap = {
    phase: r.state, turnId: r.turnId, round: r.round,
    hands: new Map(r.players.map((p) => [p.id, sigHands(p.hands)])),
    names: new Map(r.players.map((p) => [p.id, p.name])),
    hostId: r.hostId,
  };
});

function prettyPhase(s) {
  const map = { lobby: 'Lobby', betting: 'Betting', playing: 'Playing', dealer: 'Dealer turn', settle: 'Settling', gameover: 'Game over' };
  return map[s] || s;
}

function detectJoinLeave(prevIds, r) {
  const now = new Set(r.players.map((p) => p.id));
  const firstLoad = !prevIds || prevIds.size === 0;
  if (!firstLoad) {
    for (const p of r.players) {
      if (!prevIds.has(p.id)) {
        toast(`${p.name} joined the table`, '');
        setLastEvent(`${p.name} joined the table`);
        Sound.click();
      }
    }
    // Leaving players vanish from the roster; name them from the previous snapshot.
    if (prevSnap && prevSnap.names) {
      for (const id of prevIds) {
        if (!now.has(id)) {
          const nm = prevSnap.names.get(id) || 'A player';
          toast(`${nm} left the table`, '');
          setLastEvent(`${nm} left the table`);
        }
      }
    }
    // host handoff notice
    if (prevSnap && prevSnap.hostId && r.hostId && prevSnap.hostId !== r.hostId) {
      const h = r.players.find((p) => p.id === r.hostId);
      if (h) setLastEvent(`${h.name} is now the host`);
    }
  }
  if (prevSnap) {
    prevSnap.names = new Map(r.players.map((p) => [p.id, p.name]));
    prevSnap.hostId = r.hostId;
  } else {
    prevSnap = { names: new Map(r.players.map((p) => [p.id, p.name])), hostId: r.hostId };
  }
}

function detectPhaseChange(prev, r) {
  if (!prev || prev.phase === r.state) return;
  if (r.state === 'betting') { Sound.roundStart(); setLastEvent(`Round ${r.round} — place your bets`); }
  else if (r.state === 'playing') { Sound.deal(); setLastEvent('Cards dealt — good luck'); }
  else if (r.state === 'dealer') { Sound.reveal(); setLastEvent('Dealer reveals the hole card'); }
  else if (r.state === 'settle') { Sound.reveal(); }
  else if (r.state === 'gameover') { setLastEvent('Game over'); }
}

function detectHandEvents(prev, r) {
  if (!prev || !prev.hands) return;
  for (const p of r.players) {
    const before = prev.hands.get(p.id);
    const after = sigHands(p.hands);
    if (before === undefined || before === after) continue;
    const nm = p.name;
    const hands = p.hands || [];
    for (const h of hands) {
      if (h.status === 'bust' && !(before || '').includes('"s":"bust"')) {
        if (p.isYou) { Sound.bust(); toast('Bust — over 21', 'bad'); }
        else setLastEvent(`${nm} busts`);
      }
    }
    // new card dealt (not on first bet snapshot)
    if (prev.phase === 'playing' && r.state === 'playing') Sound.deal();
  }
  // turn changed
  if (prev.turnId !== r.turnId && r.turnId) {
    const nm = playerName(r, r.turnId);
    const isMe = r.turnId === myId;
    if (!isMe) setLastEvent(`${nm} is thinking…`);
  }
}

function updatePhaseBanner(r) {
  const banner = $('phaseBanner');
  const title = $('phaseTitle'), hint = $('phaseHint');
  if (!banner || !title || !hint) return;
  const me = r.players.find((p) => p.isYou);
  const myBet = me && me.hands && me.hands.length > 0;
  let tone = '', t = '', h = '';
  if (r.state === 'lobby') { tone = ''; t = 'Lobby'; h = `Waiting for players · ${r.players.length}/${r.settings.maxPlayers} seated`; }
  else if (r.state === 'betting') {
    tone = 'gold'; t = `Betting — Round ${r.round}`;
    h = myBet ? 'Bet locked in — waiting for the table…' : me && me.spectating ? 'You are spectating this round' : 'Tap chips, then Place bet';
  }
  else if (r.state === 'playing') {
    const isMe = r.turnId === myId;
    tone = isMe ? 'green' : 'blue';
    t = isMe ? 'Your turn — act!' : `${playerName(r, r.turnId)}'s turn`;
    h = isMe ? 'Hit, stand, double, split or surrender' : 'Watch the table…';
  }
  else if (r.state === 'dealer') { tone = 'purple'; t = 'Dealer turn'; h = 'Dealer reveals and plays…'; }
  else if (r.state === 'settle') { tone = 'gold'; t = 'Round settled'; h = 'Payouts going out…'; }
  else if (r.state === 'gameover') { tone = 'gold'; t = 'Game over'; h = 'Final standings are in'; }
  banner.dataset.tone = tone;
  title.textContent = t;
  hint.textContent = h;
}

function cardEl(c, extraCls = '') {
  const d = document.createElement('div');
  d.className = ('playing-card ' + extraCls).trim();
  if (c.hidden) { d.classList.add('back'); d.setAttribute('aria-label', 'Face-down card'); return d; }
  const red = c.suit === '♥' || c.suit === '♦';
  if (red) d.classList.add('red');
  const rankCls = c.rank === '10' ? ' rank10' : '';
  d.setAttribute('aria-label', `${c.rank} of ${suitName(c.suit)}`);
  d.innerHTML = `<span class="corner top"><b class="${rankCls}">${c.rank}</b><span class="s">${c.suit}</span></span><span class="pip" aria-hidden="true">${c.suit}</span><span class="corner bottom"><b class="${rankCls}">${c.rank}</b><span class="s">${c.suit}</span></span>`;
  return d;
}
function suitName(s) {
  return s === '♥' ? 'hearts' : s === '♦' ? 'diamonds' : s === '♣' ? 'clubs' : 'spades';
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
  const prevSig = box.dataset.sig || '';
  box.innerHTML = '';
  const sig = cardsSig(r.dealer);
  r.dealer.forEach((c, i) => {
    const isNew = prevSig && !prevSig.split('|').includes(c.hidden ? '?' : c.rank + c.suit) && i >= prevSig.split('|').filter(Boolean).length - 1;
    const revealed = prevSig.includes('?') && !c.hidden;
    box.appendChild(cardEl(c, revealed ? 'flip' : isNew ? 'new-deal' : ''));
  });
  box.dataset.sig = sig.split(',').join('|');
  const zone = document.querySelector('.dealer-zone');
  if (zone) zone.classList.toggle('dealer-active', r.state === 'dealer');
  const note = $('dealerNote');
  if (note) {
    note.textContent = r.state === 'dealer' ? 'Dealer plays…' : r.state === 'playing' ? 'Dealer stands on 17' : '';
  }
  const total = $('dealerTotal');
  if (!r.dealer.length) { total.textContent = ''; total.className = 'total-badge'; return; }
  const t = handTotal(r.dealer);
  const bust = t > 21;
  const bj = r.dealer.length === 2 && t === 21 && (r.state === 'settle' || r.state === 'gameover' || r.state === 'dealer');
  total.textContent = bust ? 'BUST' : String(t);
  total.className = 'total-badge' + (bust ? ' bust' : bj ? ' bj' : '');
  total.setAttribute('aria-label', bust ? 'Dealer busts' : `Dealer shows ${t}`);
}

function avatarImg(p, cls = 'mini-avatar') {
  const url = avatarUrl(p.avatar);
  if (url) {
    const img = document.createElement('img');
    img.className = cls;
    img.alt = p.name;
    img.src = url;
    img.loading = 'lazy';
    img.onerror = () => { img.replaceWith(document.createTextNode('🙂')); };
    return img;
  }
  const s = document.createElement('span');
  s.className = cls;
  s.style.background = (p.avatar && p.avatar.color) || '#ffd54f';
  s.textContent = (p.avatar && p.avatar.face) || '🙂';
  return s;
}

function outcomeIcon(o) {
  return o === 'blackjack' ? '★ ' : o === 'win' ? '✓ ' : o === 'lose' || o === 'bust' ? '✕ ' : o === 'push' ? '= ' : '';
}

function renderPlayers(r) {
  const box = $('playerList');
  box.innerHTML = '';
  [...r.players].sort((a, b) => b.chips - a.chips).forEach((p) => {
    const isTurn = r.turnId === p.id && (r.state === 'playing');
    const div = document.createElement('div');
    div.className = 'player-row' + (isTurn ? ' is-turn' : '') + (p.isYou ? ' is-me' : '') + (!p.connected ? ' is-offline' : '');
    div.setAttribute('role', 'listitem');
    if (isTurn) div.setAttribute('aria-current', 'true');
    div.appendChild(avatarImg(p));
    const meta = document.createElement('div');
    meta.className = 'pmeta';
    const crown = p.isHost ? `<span class="crown subtle" title="Host">${CROWN_SVG}</span>` : '';
    const turnPill = isTurn ? `<span class="turn-pill">${p.isYou ? 'YOUR TURN' : 'TURN'}</span>` : '';
    const offPill = !p.connected ? `<span class="offline-pill">offline</span>` : p.spectating ? `<span class="offline-pill">out</span>` : '';
    meta.innerHTML = `<div class="pname"><span class="pn">${escapeHtml(p.name)}</span> ${crown}${turnPill}${offPill}</div>
      <div class="psub"><span class="stack-chips"><span class="pile" aria-hidden="true"></span>${fmt(p.chips)}</span> · <small>W${p.stats.wins}/L${p.stats.losses}/P${p.stats.pushes} · BJ${p.stats.blackjacks}</small></div>`;
    div.appendChild(meta);
    if (r.hostId === myId && p.id !== myId && p.isHost === false) {
      const k = document.createElement('button');
      k.textContent = 'Kick';
      k.className = 'small';
      k.setAttribute('aria-label', `Kick ${p.name}`);
      k.onclick = () => socket.emit('kick', { targetId: p.id });
      div.appendChild(k);
    }
    box.appendChild(div);
  });
  if (!r.players.length) {
    const empty = document.createElement('div');
    empty.className = 'player-row';
    empty.textContent = 'No players yet — share the invite!';
    box.appendChild(empty);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function renderSeats(r) {
  const box = $('seats');
  // Preserve entering animation: track which seats are new.
  const existing = new Set([...box.children].map((el) => el.dataset.pid));
  box.innerHTML = '';
  const prevHands = (prevSnap && prevSnap.hands) || new Map();
  r.players.forEach((p) => {
    const isMe = !!p.isYou;
    const isTurn = r.turnId === p.id && r.state === 'playing';
    const seat = document.createElement('div');
    seat.dataset.pid = p.id;
    const isNew = !existing.has(p.id) && prevSnap && prevSnap.phase;
    seat.className = 'seat' + (isTurn ? ' turn' : '') + (isMe ? ' me' : '') + (p.spectating ? ' out' : '') + (isNew && !reduceMotion() ? ' entering' : '');
    if (isTurn) seat.setAttribute('aria-current', 'true');
    const head = document.createElement('div');
    head.className = 'seat-head';
    head.appendChild(avatarImg(p, 'seat-avatar'));
    const meta = document.createElement('div');
    meta.className = 'seat-meta';
    meta.innerHTML = `<div class="seat-name"><span class="name-text">${escapeHtml(p.name)}</span>${p.isHost ? `<span class="crown subtle" title="Host">${CROWN_SVG}</span>` : ''}${isMe ? '<span class="you">YOU</span>' : ''}</div>
      <div class="seat-sub"><span class="chips">${fmt(p.chips)} chips</span><span class="bet-val">${betTotalFor(p) > 0 ? 'Bet ' + fmt(betTotalFor(p)) : p.spectating ? 'Sitting out' : ''}</span>${!p.connected ? '<span class="offline">· offline</span>' : ''}</div>`;
    head.appendChild(meta);
    seat.appendChild(head);
    const flag = document.createElement('span');
    flag.className = 'turn-flag';
    flag.innerHTML = isMe ? 'YOUR TURN<span class="turn-secs"></span>' : 'THINKING<span class="turn-secs"></span>';
    seat.appendChild(flag);
    const beforeSig = prevHands.get(p.id) || '';
    (p.hands || []).forEach((h, hi) => {
      const hb = document.createElement('div');
      hb.className = 'hand-block';
      const line = document.createElement('div');
      line.className = 'hand-line';
      const pill = document.createElement('span');
      const sm = settleMap && settleMap.get(`${p.id}:${hi}`);
      const effStatus = sm ? sm.outcome : h.status;
      pill.className = 'status-pill ' + (h.status || '') + (sm ? ' outcome-' + sm.outcome : '');
      pill.textContent = outcomeIcon(effStatus) + statusLabel({ status: effStatus });
      line.appendChild(pill);
      const tot = document.createElement('span');
      tot.className = 'hand-total';
      tot.textContent = `${handTotal(h.cards)}${h.doubled ? ' · Doubled' : ''}${h.surrendered || h.status === 'surrendered' ? ' · Surrendered' : ''}`;
      line.appendChild(tot);
      if (sm && sm.payout !== undefined && p.isYou) {
        const delta = document.createElement('span');
        const net = outcomeNet(h, sm);
        delta.className = 'delta-badge ' + (sm.outcome === 'blackjack' ? 'gold' : net > 0 ? 'plus' : net < 0 ? 'minus' : 'flat');
        delta.textContent = net > 0 ? `+$${fmt(net)}` : net < 0 ? `−$${fmt(-net)}` : 'Push';
        line.appendChild(delta);
      }
      hb.appendChild(line);
      if (h.bet) {
        const spot = document.createElement('div');
        spot.className = 'bet-spot';
        spot.appendChild(betStack(h.bet));
        const amt = document.createElement('span');
        amt.textContent = fmt(h.bet);
        spot.appendChild(amt);
        hb.appendChild(spot);
      }
      const cards = document.createElement('div');
      cards.className = 'cards';
      cards.setAttribute('role', 'img');
      cards.setAttribute('aria-label', `${p.name} hand ${hi + 1}: ${handTotal(h.cards)}`);
      h.cards.forEach((c, ci) => {
        const prevCards = (beforeSig.match(/"c":"([^"]*)"/) || [])[1];
        const isFresh = beforeSig && prevCards !== undefined && ci >= prevCards.split(',').filter(Boolean).length;
        cards.appendChild(cardEl(c, isFresh && !reduceMotion() ? 'new-deal' : ''));
      });
      hb.appendChild(cards);
      seat.appendChild(hb);
    });
    // settle outcome ring
    if (settleMap) {
      const outcomes = (p.hands || []).map((_, hi) => (settleMap.get(`${p.id}:${hi}`) || {}).outcome).filter(Boolean);
      if (outcomes.includes('blackjack')) seat.classList.add('outcome-blackjack');
      else if (outcomes.includes('win')) seat.classList.add('outcome-win');
      else if (outcomes.includes('bust') || outcomes.includes('lose')) seat.classList.add('outcome-bust');
      else if (outcomes.includes('push') || outcomes.includes('surrender')) seat.classList.add('outcome-push');
    }
    box.appendChild(seat);
  });
}

function outcomeNet(hand, sm) {
  // payout already includes stake return; net = payout - bet (surrender handled as half-back already).
  if (!sm) return 0;
  if (sm.outcome === 'surrender') return -Math.ceil((hand.bet || 0) / 2);
  return (sm.payout || 0) - (hand.bet || 0);
}

function betTotalFor(p) {
  return (p.hands || []).reduce((s, h) => s + (h.bet || 0), 0);
}
function statusLabel(h) {
  const m = { active: 'Active', stood: 'Stand', bust: 'Bust', win: 'Win', lose: 'Loss', push: 'Push', blackjack: 'Blackjack', surrender: 'Surrender', betting: 'Bet placed' };
  return m[h.status] || h.status || '';
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
    inp.setAttribute('aria-label', label);
    inp.onchange = () => socket.emit('setSettings', { [key]: Number(inp.value) });
    lab.appendChild(inp);
    s.appendChild(lab);
  });
  const toggles = [['dealerHitsSoft17', 'Dealer hits soft 17'], ['allowDouble', 'Allow double'], ['allowSplit', 'Allow split'], ['allowSurrender', 'Allow surrender'], ['coachEnabled', 'Coach hints + bust %']];
  toggles.forEach(([key, label]) => {
    const lab = document.createElement('label');
    const inp = document.createElement('input');
    inp.type = 'checkbox'; inp.checked = !!r.settings[key]; inp.disabled = !isHost;
    inp.setAttribute('aria-label', label);
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
  sel.setAttribute('aria-label', 'Blackjack payout');
  sel.onchange = () => socket.emit('setSettings', { blackjackPays: sel.value });
  pay.appendChild(sel);
  s.appendChild(pay);
}
$('startBtn').onclick = () => { Sound.unlock(); Sound.chips(); socket.emit('startGame'); };

function renderBetting(r) {
  const me = r.players.find((p) => p.isYou);
  const panel = $('betPanel');
  const inBetting = r.state === 'betting' && me && !me.spectating;
  const hasBet = !!(me && (me.hands || []).length > 0);
  panel.classList.toggle('hidden', !inBetting);
  // Waiting view: bet locked — keep the panel visible with stake + who is still deciding.
  panel.classList.toggle('locked', inBetting && hasBet);
  if (!lastTurn) $('actionPanel').classList.add('hidden');
  if ($('betBalance') && me) $('betBalance').textContent = fmt(me.chips) + ' chips';
  let note = panel.querySelector('.bet-locked-note');
  if (inBetting && hasBet) {
    const bet = (me.hands || [])[0];
    const active = r.players.filter((p) => p.connected && !p.spectating);
    const waiting = active.filter((p) => !p.isYou && (p.hands || []).length === 0).map((p) => p.name);
    if (!note) { note = document.createElement('div'); note.className = 'bet-locked-note'; panel.insertBefore(note, panel.querySelector('.bet-progress')); }
    note.textContent = waiting.length
      ? `Bet locked: $${fmt(bet ? bet.bet : 0)} — waiting for ${waiting.join(', ')}.`
      : `Bet locked: $${fmt(bet ? bet.bet : 0)} — dealing…`;
    const n = active.filter((p) => (p.hands || []).length > 0).length;
    if ($('betStatus')) $('betStatus').textContent = `${n}/${active.length} bets placed`;
  } else {
    if (note) note.remove();
    if (inBetting) {
      $('betStatus').textContent = pendingBet > 0 ? 'Tap Place bet when ready' : 'Choose your chips';
      paintTray();
    } else if (r.state !== 'betting' && pendingBet > 0) {
      pendingBet = 0; pendingStack = []; paintTray();
    }
  }
}

// real coins: break a bet into poker-chip denominations for the stack visual (consts declared at top)
function breakChips(amount) {
  const out = [];
  let rest = amount;
  for (const d of DENOMS) {
    while (rest >= d) { out.push(d); rest -= d; }
  }
  return out.slice(0, 8);
}
function betStack(amount) {
  const wrap = document.createElement('div');
  wrap.className = 'bet-stack';
  wrap.setAttribute('aria-hidden', 'true');
  breakChips(amount).forEach((d, i) => {
    const c = document.createElement('div');
    c.className = 'mini-chip';
    c.style.background = CHIP_COLORS[d];
    c.style.bottom = (i * 6) + 'px';
    c.style.marginLeft = ((i % 2) ? 4 : -4) + 'px';
    c.textContent = d;
    wrap.appendChild(c);
  });
  return wrap;
}

// chip tray: tap coins to stack a bet, then deal (state declared at top)
function buildChipTray() {
  const row = $('chipRow');
  row.innerHTML = '';
  TRAY.forEach((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'poker-chip c' + d;
    b.textContent = d;
    b.dataset.value = d;
    b.setAttribute('aria-label', `Add ${d} chip to bet`);
    b.onclick = () => {
      Sound.unlock();
      const me = room && room.players.find((p) => p.isYou);
      const bal = me ? me.chips : d;
      if (pendingBet + d > bal) { toast(`Not enough balance for +${d}`, 'bad'); Sound.chipRemove(); return; }
      pendingBet += d;
      pendingStack.push(d);
      Sound.chips();
      paintTray();
      // pop animation on the tapped chip
      b.classList.remove('chip-pop');
      void b.offsetWidth;
      b.classList.add('chip-pop');
      const t = $('betTotal');
      if (t) { t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop'); }
    };
    row.appendChild(b);
  });
  paintTray();
}
function paintTray() {
  const t = $('betTotal');
  if (t) t.textContent = pendingBet > 0 ? '$' + fmt(pendingBet) : '$0';
  const me = room && room.players.find((p) => p.isYou);
  const bal = me ? me.chips : Infinity;
  [...$('chipRow').querySelectorAll('.poker-chip')].forEach((b) => {
    const v = Number(b.dataset.value);
    const afford = pendingBet + v <= bal;
    b.disabled = !afford;
    b.classList.toggle('sel', pendingStack.length > 0 && pendingStack[pendingStack.length - 1] === v);
    b.setAttribute('aria-pressed', pendingStack.includes(v) ? 'true' : 'false');
    b.setAttribute('aria-label', `Add ${v} chip to bet${afford ? '' : ' (not enough balance)'}`);
  });
  const undo = $('betUndo'), clear = $('betClear'), go = $('betGo');
  if (undo) undo.disabled = pendingStack.length === 0;
  if (clear) clear.disabled = pendingBet === 0;
  if (go) go.disabled = false;
  // after-hint + preview
  const after = $('betAfterHint');
  if (after && me) after.textContent = pendingBet > 0 ? `${fmt(me.chips - pendingBet)} left after bet` : '';
  const pv = $('betPreview');
  if (pv) {
    pv.innerHTML = '';
    pendingStack.slice(-10).forEach((d) => {
      const s = document.createElement('span');
      s.className = 'pv-chip';
      s.style.background = CHIP_COLORS[d];
      s.textContent = `+${d}`;
      pv.appendChild(s);
    });
  }
  const st = $('betStatus');
  if (st && room && room.state === 'betting') st.textContent = pendingBet > 0 ? `${pendingStack.length} chip${pendingStack.length > 1 ? 's' : ''} stacked — tap Place bet` : 'Choose your chips';
}
const betUndoBtn = $('betUndo');
if (betUndoBtn) betUndoBtn.onclick = () => {
  if (!pendingStack.length) return;
  Sound.chipRemove();
  pendingStack.pop();
  pendingBet = pendingStack.reduce((s, v) => s + v, 0);
  paintTray();
};
$('betClear').onclick = () => { Sound.chipRemove(); pendingBet = 0; pendingStack = []; paintTray(); };
$('betGo').onclick = (e) => {
  if (pendingBet < 10) { pendingBet = 50; pendingStack = [50]; }
  Sound.unlock();
  Sound.chips();
  markActionPending(e.currentTarget);
  socket.emit('placeBet', { amount: pendingBet });
  pendingBet = 0;
  pendingStack = [];
  paintTray();
};

// --- turns ---
socket.on('yourTurn', ({ cards, dealerUp, hint, bustChance, endsIn }) => {
  lastTurn = { cards, dealerUp, endsIn };
  $('actionPanel').classList.remove('hidden');
  $('betPanel').classList.add('hidden');
  Sound.turn();
  if (navigator.vibrate) { try { navigator.vibrate(80); } catch (e) {} }
  document.title = 'Your turn! — black-jack.io';
  const bustTxt = `Bust if you hit: ${bustChance}%`;
  const dealerTxt = dealerUp ? `Dealer shows ${dealerUp.rank}${dealerUp.suit}` : '';
  const total = handTotal(cards || []);
  $('handSummary').innerHTML = `You hold <b>${total}</b> · ${dealerTxt} · <span>${escapeHtml(bustTxt)}</span>`;
  $('coachBox').textContent = hint ? `Coach: ${hint} · ${bustTxt}` : `${dealerTxt} · ${bustTxt}`;
  turnEndsAt = Date.now() + (endsIn || 20) * 1000;
  turnTotalSecs = endsIn || 20;
  startTurnCountdown(endsIn);
  refreshActions();
  // bring actions into view on mobile
  if (window.innerWidth <= 760) {
    setTimeout(() => { const ap = $('actionPanel'); if (ap) ap.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' }); }, 60);
  }
});

function startTurnCountdown(total) {
  let t = total;
  warnedAt = 0;
  const label = $('turnTimer');
  const fill = $('turnBarFill');
  label.classList.toggle('urgent', t <= 5);
  label.textContent = `${t}s`;
  if (fill) {
    fill.style.transition = 'none';
    fill.style.width = '100%';
    requestAnimationFrame(() => {
      if (reduceMotion()) { fill.style.transition = 'none'; fill.style.width = '0%'; return; }
      fill.style.transition = `width ${total}s linear`;
      fill.style.width = '0%';
    });
  }
  clearInterval(window._tt);
  let warned = false;
  window._tt = setInterval(() => {
    t -= 1;
    if (t === 5 && !warned) { warned = true; Sound.warning(); }
    if (t <= 0) { clearInterval(window._tt); label.textContent = '0s'; return; }
    label.textContent = `${t}s`;
    label.classList.toggle('urgent', t <= 5);
  }, 1000);
}

// Only display actions that are currently valid.
function refreshActions() {
  if (!room || !lastTurn) return;
  if ($('actionPanel').classList.contains('hidden')) return;
  const me = room.players.find((p) => p.isYou);
  const cards = lastTurn.cards || [];
  const total = handTotal(cards);
  $('hitBtn').style.display = total >= 21 ? 'none' : '';
  $('standBtn').style.display = '';
  $('doubleBtn').style.display = checkDouble(room, me, cards) ? '' : 'none';
  $('splitBtn').style.display = canSplit(room, me, cards) ? '' : 'none';
  $('surrenderBtn').style.display = (room.settings.allowSurrender && cards.length === 2) ? '' : 'none';
  // screen-reader labels with context
  $('hitBtn').setAttribute('aria-label', `Hit on ${total} — take another card`);
  $('standBtn').setAttribute('aria-label', `Stand on ${total} — keep your hand`);
}

function myActiveBet() {
  if (!room || !myId) return 0;
  const me = room.players.find((p) => p.id === myId);
  if (!me || !me.hands) return 0;
  const h = me.hands.find((x) => x.status === 'active');
  return h ? h.bet : 0;
}
function checkDouble(room, me, cards) {
  if (!room || !me || !cards) return false;
  if (!room.settings.allowDouble || cards.length !== 2) return false;
  return me.chips >= myActiveBet() && myActiveBet() > 0;
}
function canSplit(room, me, cards) {
  if (!room || !me || !cards) return false;
  if (!room.settings.allowSplit || cards.length !== 2) return false;
  if (!me.hands || me.hands.length !== 1) return false;
  const [c1, c2] = cards;
  const v = (c) => (c.rank === 'A' ? 11 : ['K', 'Q', 'J'].includes(c.rank) ? 10 : parseInt(c.rank, 10));
  if (v(c1) !== v(c2)) return false;
  return me.chips >= myActiveBet() && myActiveBet() > 0;
}

$('hitBtn').onclick = (e) => { Sound.unlock(); Sound.click(); Sound.deal(); markActionPending(e.currentTarget); socket.emit('action', { kind: 'hit' }); };
$('standBtn').onclick = (e) => { Sound.unlock(); Sound.click(); markActionPending(e.currentTarget); socket.emit('action', { kind: 'stand' }); };
$('doubleBtn').onclick = (e) => { Sound.unlock(); Sound.chips(); markActionPending(e.currentTarget); socket.emit('action', { kind: 'double' }); };
$('splitBtn').onclick = (e) => { Sound.unlock(); Sound.chips(); markActionPending(e.currentTarget); socket.emit('action', { kind: 'split' }); };
$('surrenderBtn').onclick = (e) => { Sound.unlock(); Sound.click(); markActionPending(e.currentTarget); socket.emit('action', { kind: 'surrender' }); };
socket.on('actionError', (m) => { clearActionPending(); toast(String(m || 'Action not allowed'), 'bad'); });

socket.on('settle', ({ dealerTotal, dealerBust, results, note }) => {
  lastTurn = null;
  clearInterval(window._tt);
  turnEndsAt = 0;
  $('actionPanel').classList.add('hidden');
  document.title = 'black-jack.io — Multiplayer Blackjack';
  Sound.reveal();
  settleMap = new Map(results.map((r) => [`${r.pid}:${r.hand}`, r]));
  if (room) renderSeats(room);
  const me = results.filter((r) => room && room.players.find((p) => p.id === r.pid && p.isYou));
  const banner = $('resultBanner');
  banner.classList.remove('hidden');
  const hasBJ = me.some((r) => r.outcome === 'blackjack');
  const hasWin = me.some((r) => r.outcome === 'win');
  const hasBust = me.some((r) => r.outcome === 'bust');
  const hasLose = me.some((r) => r.outcome === 'lose');
  const hasPush = me.every((r) => r.outcome === 'push' || r.outcome === 'surrender') && me.length > 0;
  banner.className = 'result ' + (hasBJ ? 'blackjack' : hasWin ? 'win' : hasBust || hasLose ? 'lose' : '');
  const icon = hasBJ ? '★ ' : hasWin ? '✓ ' : hasBust || hasLose ? '✕ ' : '= ';
  banner.textContent = `${icon}${note ? note + ' ' : ''}Dealer ${dealerTotal}${dealerBust ? ' busts' : ''} · ` +
    (me.length ? me.map((r) => `${r.outcome}${r.payout > 0 ? ' +' + fmt(r.payout) : ''}`).join(' · ') : 'Watching this one.');
  if (hasBJ) Sound.blackjack();
  else if (hasWin) Sound.win();
  else if (hasBust) Sound.bust();
  else if (hasLose) Sound.lose();
  else if (hasPush) Sound.push();
  if (hasBJ || hasWin) toast(hasBJ ? '★ Blackjack! Nice!' : '✓ You win!', 'gold');
  else if (hasBust) toast('✕ Bust', 'bad');
  else if (hasLose) toast('✕ Dealer takes it', 'bad');
  setTimeout(() => banner.classList.add('hidden'), 6000);
});
socket.on('gameover', ({ board }) => {
  lastTurn = null;
  clearInterval(window._tt);
  const banner = $('resultBanner');
  banner.classList.remove('hidden');
  banner.className = 'result blackjack';
  banner.textContent = `★ Winner: ${board[0].name} with ${fmt(board[0].chips)} chips! ` +
    board.map((b, i) => `${i + 1}. ${b.name} ${fmt(b.chips)}`).join(' · ');
  Sound.blackjack();
  if (navigator.vibrate) { try { navigator.vibrate([100, 50, 100]); } catch (e) {} }
  showWinnerModal(board);
});

function showWinnerModal(board) {
  const modal = $('winnerModal');
  modal.classList.remove('hidden');
  const podium = $('podium');
  podium.innerHTML = '';
  const order = [board[1], board[0], board[2]].filter(Boolean); // 2nd, 1st, 3rd visual
  const classes = board[1] ? ['p2', 'p1', 'p3'] : ['p1'];
  order.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'place ' + classes[i];
    const url = avatarUrl(p.avatar);
    const rank = board.indexOf(p) + 1;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉';
    d.innerHTML = `<div>${medal} #${rank}</div>${url ? `<img src="${url}" alt="${escapeHtml(p.name)}" />` : '🙂'}<div>${escapeHtml(p.name)}</div><div>${fmt(p.chips)} chips</div>`;
    podium.appendChild(d);
  });
  $('winnerTitle').textContent = `${board[0].name} wins the table!`;
  $('winnerStats').textContent = board.map((b) => `${b.name}: ${b.stats.wins}W/${b.stats.losses}L/${b.stats.pushes}P, ${b.stats.blackjacks} BJ`).join(' · ');
  const isHost = room && room.hostId === myId;
  $('rematchBtn').classList.toggle('hidden', !isHost);
  const conf = $('confetti');
  conf.innerHTML = '';
  if (!reduceMotion()) {
    const suits = ['♠', '♥', '♦', '♣', '★'];
    for (let i = 0; i < 28; i++) {
      const s = document.createElement('span');
      s.textContent = suits[Math.floor(Math.random() * suits.length)];
      s.style.left = Math.random() * 100 + '%';
      s.style.color = i % 3 === 0 ? '#d4a437' : i % 3 === 1 ? '#c22536' : '#0d6b41';
      s.style.animationDelay = (Math.random() * 1.2) + 's';
      conf.appendChild(s);
    }
  }
  // focus management + Esc to close
  const closeBtn = $('closeModalBtn');
  if (closeBtn) closeBtn.focus();
}
$('closeModalBtn').onclick = () => { Sound.click(); $('winnerModal').classList.add('hidden'); };
$('rematchBtn').onclick = () => { Sound.unlock(); Sound.chips(); socket.emit('rematch'); $('winnerModal').classList.add('hidden'); };
const homeBtn = $('homeBtn');
if (homeBtn) homeBtn.onclick = () => { location.href = '/'; };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('winnerModal').classList.contains('hidden')) $('winnerModal').classList.add('hidden');
});

// round history ticker
socket.on('room', (r) => {
  const bar = document.getElementById('historyBar');
  if (r.history && r.history.length) {
    bar.classList.remove('hidden');
    bar.textContent = r.history.join('   ·   ');
  }
});
// --- chat + emotes (compact, never covers controls) ---
function chatNearBottom() {
  const box = $('chatBox');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 60;
}
function addChat({ name, avatar: av, text, sys }) {
  const box = $('chatBox');
  const stick = chatNearBottom();
  const div = document.createElement('div');
  if (sys) div.className = 'sys';
  div.textContent = sys ? String(text) : `${name}: ${text}`;
  box.appendChild(div);
  while (box.children.length > 80) box.firstChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
  // unread badge when chat panel is hidden on mobile
  const side = $('sidePanel');
  if (!sys || true) {
    if (side && side.dataset.mobileView !== 'chat' && window.innerWidth <= 760) {
      chatUnread += 1;
      paintChatBadge();
    } else if (document.hidden) {
      chatUnread += 1;
      paintChatBadge();
    }
  }
  if (sys && text.includes('Shuffling')) Sound.shuffle();
}
socket.on('chat', addChat);
socket.on('phase', ({ phase, round }) => addChat({ sys: true, text: `— ${phase} (round ${round}) —` }));
socket.on('emote', ({ name, emoji }) => addChat({ sys: true, text: `${name} ${emoji}` }));
$('chatSend').onclick = sendChat;
$('chatInput').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
function sendChat() {
  const v = $('chatInput').value;
  if (!v.trim()) return;
  Sound.unlock();
  $('chatInput').value = '';
  socket.emit('chat', { text: v });
}
['🔥', '😎', '😭', '🍀', '💸', '👏', '🤯', '🃏'].forEach((e) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = e;
  b.setAttribute('aria-label', `Send ${e} reaction`);
  b.onclick = () => { Sound.unlock(); socket.emit('emote', { emoji: e }); };
  $('emoteRow').appendChild(b);
});
function copyInvite() {
  if (!room) return;
  Sound.unlock();
  const url = `${location.origin}/?${room.id}`;
  const done = () => {
    toast(`Invite copied: ${room.id}`, 'gold');
    for (const id of ['copyLinkBtn', 'sideCopyBtn']) {
      const b = $(id);
      if (!b) continue;
      const orig = b.innerHTML;
      b.innerHTML = '<span>✓ Copied</span>';
      setTimeout(() => { b.innerHTML = orig; }, 1600);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (err) { toast(url, ''); }
    });
  } else {
    toast(url, '');
  }
}
$('copyLinkBtn').onclick = copyInvite;
const sideCopy = $('sideCopyBtn');
if (sideCopy) sideCopy.onclick = copyInvite;
$('leaveBtn').onclick = () => { Sound.click(); socket.emit('leave'); location.href = '/'; };
