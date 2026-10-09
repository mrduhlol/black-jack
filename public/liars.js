/* Liar's Table client — online rooms via the LiarsBarRoom Durable Object.
   Own screen, own net layer, own styles. Blackjack's client.js is untouched.
   Reuses only globals: $, myName(), avatar, avatarUrl(), Sound. */

const LbNet = {
  ws: null,
  handlers: {},
  playerId: null,
  roomCode: null,
  joined: false,
  manualClose: false,
  reconnectTries: 0,
  epoch: 0,
  joinTimer: null,
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
  dispatch(msg) {
    const fns = this.handlers[msg.t] || [];
    for (const fn of fns) {
      try { fn(msg); } catch (e) { console.error(e); }
    }
  },
  isOpen() { return !!this.ws && this.ws.readyState === 1; },
  send(obj) {
    if (!this.isOpen()) { lbToast('Not connected — refresh to rejoin', 'bad'); return false; }
    try { this.ws.send(JSON.stringify(obj)); return true; }
    catch (e) { lbToast('Not connected — refresh to rejoin', 'bad'); return false; }
  },
  socketUrl(code) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/liar/${code}/socket`;
  },
  connect(code) {
    try { if (this.ws) { this.manualClose = true; this.ws.close(); } } catch (e) {}
    this.manualClose = false;
    const myEpoch = ++this.epoch;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.socketUrl(code));
      // Never strand the UI: a handshake that neither opens nor fails
      // (proxies, AV filters, dead networks) rejects instead of hanging.
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch (e) {}
          reject(new Error('ws timeout'));
        }
      }, 15000);
      ws.onopen = () => { if (!settled) { settled = true; clearTimeout(timer); this.ws = ws; resolve(); } };
      ws.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg && typeof msg.t === 'string') this.dispatch(msg);
      };
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('ws error')); } };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('ws closed')); return; }
        if (myEpoch !== this.epoch) return;
        this.onUnexpectedClose();
      };
      this.ws = ws;
    });
  },
  onUnexpectedClose() {
    if (this.manualClose || !this.joined) return;
    if (this.reconnectTries >= 5) {
      lbToast('Connection lost — please refresh to rejoin', 'bad');
      return;
    }
    this.reconnectTries += 1;
    lbToast('Reconnecting…', '');
    setTimeout(async () => {
      if (this.manualClose || !this.roomCode) return;
      try {
        await this.connect(this.roomCode);
        this.reconnectTries = 0;
        this.send({ t: 'join', create: true, playerId: this.playerId, name: myName(), avatar });
        lbToast('Reconnected', 'gold');
      } catch (e) { this.onUnexpectedClose(); }
    }, 1200 * this.reconnectTries);
  },
  newIdentity() {
    this.playerId = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(16).slice(2);
  },
  async joinRoom(code, create) {
    code = String(code || '').toUpperCase();
    if (!code) { lbToast('Enter a room code', 'bad'); return; }
    this.manualClose = false;
    this.reconnectTries = 0;
    this.newIdentity();
    this.roomCode = code;
    this.joined = false;
    if (!lbRoom) lbShowConnection(code, 'connecting', !!create);
    try {
      await this.connect(code);
    } catch (e) {
      if (!lbRoom) lbShowConnection(code, 'error', !!create, 'Could not connect to this table. Check your connection and retry.');
      throw e;
    }
    this.joined = true;
    this.send({ t: 'join', create: !!create, playerId: this.playerId, name: myName(), avatar });
    history.replaceState(null, '', `/?${code}`);
    clearTimeout(this.joinTimer);
    this.joinTimer = setTimeout(() => {
      if (!lbRoom && this.roomCode === code) {
        lbShowConnection(code, 'error', !!create, 'The table did not respond. Check the code and try connecting again.');
      }
    }, 9000);
  },
  disconnect() {
    this.manualClose = true;
    this.joined = false;
    try { if (this.ws) this.ws.close(); } catch (e) {}
    this.ws = null;
  },
};

// ---------- local state ----------
let lbRoom = null;
let lbMyId = null;
let lbSelected = new Set();
let lbLastReveal = null;
let lbRevealPending = null;
let lbEndsAt = 0;
let lbPrevRank = null;
let lbLastTurnSeen = null;
let lbWarnKey = null;
let lbOutWarned = new Set();

// Table-cast flavor: every outlaw face gets a vice line in the roster.
const LB_VICE = {
  'adventurer-neutral': 'Owes the house money',
  'lorelei-neutral': 'Never blinks first',
  'notionists': 'Counts every card',
  'open-peeps': 'Laughs when lying',
  'thumbs': 'Already dead inside',
  'fun-emoji': 'Smiles at funerals',
};
function lbVice(p) {
  if (p && p.avatar && LB_VICE[p.avatar.style]) return LB_VICE[p.avatar.style];
  return 'Bar regular';
}

function lbToast(msg, kind = '') {
  const stack = $('lbToasts');
  if (!stack || !msg) return;
  while (stack.children.length >= 3) stack.firstChild.remove();
  const d = document.createElement('div');
  d.className = ('lb-toast ' + kind).trim();
  d.textContent = msg;
  stack.appendChild(d);
  setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity 300ms'; setTimeout(() => d.remove(), 320); }, 2600);
}

function lbShow(id) {
  for (const s of ['landing', 'game', 'liarGame']) {
    const el = $(s);
    if (el) el.classList.toggle('hidden', s !== id);
  }
  window.scrollTo(0, 0);
}

function lbShowConnection(code, state, create, message = '') {
  lbShow('liarGame');
  $('lbRoomCode').textContent = code;
  $('lbRoundLabel').textContent = state === 'connecting' ? 'Connecting…' : 'Connection issue';
  $('lbTableWrap').classList.add('hidden');
  const box = $('lbLobby');
  box.classList.add('lb-lobby-connecting');
  box.classList.remove('hidden');
  box.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = create ? 'Your private table' : 'Joining Liar’s Table';
  box.appendChild(heading);
  const invite = document.createElement('section');
  invite.className = 'lb-invite-card';
  const label = document.createElement('span');
  label.className = 'lb-invite-label';
  label.textContent = 'ROOM CODE';
  invite.appendChild(label);
  const codeEl = document.createElement('strong');
  codeEl.className = 'lb-code';
  codeEl.textContent = code;
  invite.appendChild(codeEl);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'lb-btn quiet';
  copy.textContent = 'Copy invite link';
  copy.onclick = () => {
    const url = `${location.origin}/?${code}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => lbToast('Invite link copied', 'gold')).catch(() => lbToast(url));
    } else lbToast(url);
  };
  invite.appendChild(copy);
  box.appendChild(invite);

  const status = document.createElement('p');
  status.className = 'lb-connection-status' + (state === 'error' ? ' bad' : '');
  status.setAttribute('role', 'status');
  status.textContent = state === 'connecting' ? 'Connecting to your table…' : (message || 'Could not connect.');
  box.appendChild(status);

  if (state === 'error') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'lb-start';
    retry.textContent = 'Retry connection';
    retry.onclick = () => LbNet.joinRoom(code, create).catch(() => {});
    box.appendChild(retry);
  }
}

function lbMe() {
  return lbRoom ? lbRoom.players.find((p) => p.isYou) || null : null;
}

function lbName(pid) {
  const p = lbRoom && lbRoom.players.find((x) => x.id === pid);
  return p ? p.name : 'A player';
}

function lbAvatarImg(p, cls) {
  const img = document.createElement('img');
  img.className = cls;
  img.alt = p.name;
  img.onerror = () => { img.replaceWith(document.createTextNode('🎭')); };
  try {
    img.src = avatarUrl(p.avatar);
  } catch (e) {
    img.src = '';
  }
  return img;
}

function lbRankLabel(rank) {
  const names = { A: 'Aces', K: 'Kings', Q: 'Queens', J: 'Jacks' };
  if (names[rank]) return names[rank];
  return rank + 's';
}

// ---------- seat geometry ----------
// Self sits at the bottom of the ring; everyone else spreads around the ellipse.
function lbSeatPos(i, n) {
  if (n <= 1) return { x: 50, y: 84 };
  const angle = Math.PI / 2 + (i / n) * Math.PI * 2; // start bottom, clockwise
  const rx = 44, ry = 38;
  const p = { x: 50 + rx * Math.cos(angle), y: 50 + ry * Math.sin(angle) };
  // Pull the bottom seat (you) slightly inward so the hand below never clips.
  if (i === 0) p.y = Math.min(p.y, 84);
  p.x = Math.max(8, Math.min(92, p.x));
  p.y = Math.max(8, Math.min(88, p.y));
  return p;
}

function lbOrderedPlayers() {
  if (!lbRoom) return [];
  const me = lbMe();
  const others = lbRoom.players.filter((p) => !(me && p.id === me.id));
  return me ? [me, ...others] : [...others];
}

// ---------- render ----------

function lbRender() {
  if (!lbRoom) return;
  clearTimeout(LbNet.joinTimer);
  $('lbLobby').classList.remove('lb-lobby-connecting');
  const me = lbMe();
  if (me) lbMyId = me.id;
  $('lbRoomCode').textContent = lbRoom.id;
  $('lbRoundLabel').textContent = lbRoom.state === 'lobby' ? 'Lobby' : `Round ${lbRoom.round}`;
  const inLobby = lbRoom.state === 'lobby';
  $('lbLobby').classList.toggle('hidden', !inLobby);
  $('lbTableWrap').classList.toggle('hidden', inLobby);
  if (inLobby) lbRenderLobby();
  else lbRenderTable();
  const bar = $('lbHistory');
  if (bar) {
    if (lbRoom.history && lbRoom.history.length) {
      bar.classList.remove('hidden');
      bar.textContent = lbRoom.history.join('   ·   ');
    } else bar.classList.add('hidden');
  }
}

function lbRenderLobby() {
  const box = $('lbLobby');
  box.innerHTML = '';
  box.classList.remove('lb-lobby-connecting');
  const me = lbMe();
  const isHost = !!(me && me.isHost);
  const connected = lbRoom.players.filter((p) => p.connected).length;

  const heading = document.createElement('div');
  heading.className = 'lb-lobby-heading';
  const title = document.createElement('div');
  const eyebrow = document.createElement('span');
  eyebrow.className = 'lb-invite-label';
  eyebrow.textContent = isHost ? 'PRIVATE TABLE' : 'YOU’RE IN';
  title.appendChild(eyebrow);
  const h = document.createElement('h2');
  h.textContent = "Liar's Table";
  title.appendChild(h);
  const sub = document.createElement('p');
  sub.textContent = isHost ? 'Invite your crew, set the house rules, then deal.' : 'You joined the table. The host will start when everyone is ready.';
  title.appendChild(sub);
  heading.appendChild(title);
  const playerCount = document.createElement('span');
  playerCount.className = 'lb-player-count';
  playerCount.textContent = `${connected}/${lbRoom.settings.maxPlayers} PLAYERS`;
  heading.appendChild(playerCount);
  box.appendChild(heading);

  const invite = document.createElement('section');
  invite.className = 'lb-invite-card';
  const codeWrap = document.createElement('div');
  const codeLabel = document.createElement('span');
  codeLabel.className = 'lb-invite-label';
  codeLabel.textContent = 'ROOM CODE';
  codeWrap.appendChild(codeLabel);
  const code = document.createElement('div');
  code.className = 'lb-code';
  code.textContent = lbRoom.id;
  codeWrap.appendChild(code);
  invite.appendChild(codeWrap);
  const inv = document.createElement('button');
  inv.className = 'lb-btn quiet lb-invite';
  inv.type = 'button';
  inv.textContent = 'Copy invite link';
  inv.onclick = () => {
    Sound.unlock(); Sound.click();
    const url = `${location.origin}/?${lbRoom.id}`;
    const done = () => lbToast('Invite link copied', 'gold');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => lbToast(url, ''));
    } else lbToast(url, '');
  };
  invite.appendChild(inv);
  box.appendChild(invite);

  const rules = document.createElement('details');
  rules.className = 'lb-rules';
  const sum = document.createElement('summary');
  sum.textContent = 'House rules';
  rules.appendChild(sum);
  const ol = document.createElement('ol');
  [
    'Lay 1–3 cards face-down as the table rank — Kings, Queens or Aces. Jokers are wild.',
    'Next seat calls LIAR! or lets it slide and plays on.',
    'Wrong side of a challenge faces the chamber. Survive and take the pile.',
    'Empty your hand and live, or be the last one standing.',
  ].forEach((t) => {
    const li = document.createElement('li');
    li.textContent = t;
    ol.appendChild(li);
  });
  rules.appendChild(ol);
  box.appendChild(rules);

  const rosterHead = document.createElement('div');
  rosterHead.className = 'lb-section-head';
  rosterHead.textContent = 'AT THE TABLE';
  box.appendChild(rosterHead);
  const roster = document.createElement('div');
  roster.className = 'lb-roster';
  lbRoom.players.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'lb-roster-row';
    row.appendChild(lbAvatarImg(p, ''));
    const st0 = p.stats || {};
    row.title = `Wins ${st0.wins || 0} · survivals ${st0.survivals || 0} · calls won ${st0.challengesWon || 0}`;
    const nm = document.createElement('span');
    nm.textContent = p.name + (p.isYou ? ' (you)' : '') + (p.connected ? '' : ' · offline');
    row.appendChild(nm);
    const vice = document.createElement('span');
    vice.className = 'lb-vice';
    vice.textContent = lbVice(p);
    row.appendChild(vice);
    if (p.isHost) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'HOST';
      row.appendChild(tag);
    }
    const meNow = lbMe();
    if (meNow && meNow.isHost && !p.isYou) {
      const kick = document.createElement('button');
      kick.className = 'lb-kick';
      kick.type = 'button';
      kick.textContent = 'Kick';
      kick.setAttribute('aria-label', `Kick ${p.name}`);
      kick.onclick = () => {
        if (kick.dataset.armed) {
          Sound.unlock(); Sound.click();
          LbNet.send({ t: 'kick', targetId: p.id });
          return;
        }
        kick.dataset.armed = '1';
        kick.textContent = 'Sure?';
        kick.classList.add('armed');
        setTimeout(() => {
          delete kick.dataset.armed;
          kick.textContent = 'Kick';
          kick.classList.remove('armed');
        }, 3000);
      };
      row.appendChild(kick);
    }
    roster.appendChild(row);
  });
  box.appendChild(roster);

  const status = document.createElement('p');
  status.className = 'lb-connection-status';
  status.setAttribute('role', 'status');
  status.textContent = connected < 2
    ? `Waiting for one more player. Share code ${lbRoom.id} or copy the invite link above.`
    : `${connected} players connected. The host can start the game.`;
  box.appendChild(status);

  const settingsHead = document.createElement('div');
  settingsHead.className = 'lb-section-head';
  settingsHead.textContent = isHost ? 'HOUSE SETUP' : 'HOUSE RULES';
  box.appendChild(settingsHead);
  if (me && me.isHost) {
    const set = document.createElement('div');
    set.className = 'lb-settings';
    const defs = [
      ['maxPlayers', 'Players', 2, 4],
      ['turnTimer', 'Turn (s)', 10, 120],
      ['chambers', 'Chambers', 3, 8],
      ['liveChambers', 'Live', 1, 7],
    ];
    defs.forEach(([key, label, min, max]) => {
      const lab = document.createElement('label');
      lab.textContent = label + ': ';
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = min; inp.max = max;
      inp.value = lbRoom.settings[key];
      inp.setAttribute('aria-label', label);
      inp.onchange = () => LbNet.send({ t: 'set_settings', [key]: Number(inp.value) });
      lab.appendChild(inp);
      set.appendChild(lab);
    });
    box.appendChild(set);
    const devilLab = document.createElement('label');
    devilLab.className = 'lb-devil-toggle';
    const devilInp = document.createElement('input');
    devilInp.type = 'checkbox';
    devilInp.checked = !!lbRoom.settings.devilMode;
    devilInp.setAttribute('aria-label', 'Devil card variant');
    devilInp.onchange = () => LbNet.send({ t: 'set_settings', devilMode: devilInp.checked });
    devilLab.appendChild(devilInp);
    devilLab.append(' 😈 Devil card — a challenged devil punishes the whole table');
    box.appendChild(devilLab);
  } else {
    const s = lbRoom.settings;
    const sum = document.createElement('p');
    sum.className = 'lb-setting-sum';
    sum.textContent = `${s.maxPlayers} seats · ${s.turnTimer}s turns · ${s.chambers} chambers (${s.liveChambers} live)` + (s.devilMode ? ' · 😈 devil' : '');
    box.appendChild(sum);
    if (lbRoom.settings.devilMode) {
      const dv = document.createElement('p');
      dv.className = 'lb-devil-note';
      dv.textContent = '😈 Devil card in play — ride it alone, if you dare.';
      box.appendChild(dv);
    }
  }

  const start = document.createElement('button');
  start.className = 'lb-start';
  if (isHost) {
    start.textContent = connected < 2 ? 'Waiting for a player…' : 'Start game';
    start.disabled = connected < 2;
    start.title = connected < 2 ? 'A second player must join before the game can start.' : '';
    start.onclick = () => { Sound.unlock(); Sound.click(); LbNet.send({ t: 'start_game' }); };
    box.appendChild(start);
  } else {
    start.textContent = 'Waiting for host to start';
    start.disabled = true;
    box.appendChild(start);
  }
}

function lbRenderTable() {
  const zone = $('lbTableZone');
  // keep hub, rebuild seats + pile
  zone.querySelectorAll('.lb-seat').forEach((s) => s.remove());

  const players = lbOrderedPlayers();
  const n = players.length;
  players.forEach((p, i) => {
    const pos = lbSeatPos(i, n);
    const seat = document.createElement('div');
    const isTurn = lbRoom.turnId === p.id && (lbRoom.state === 'playing');
    seat.className = 'lb-seat' + (isTurn ? ' turn' : '') + (p.eliminated ? ' dead' : '') + (p.isYou ? ' me' : '');
    if (!isTurn && lbRoom.state === 'playing' && Array.isArray(lbRoom.order)) {
      const idx = lbRoom.order.indexOf(lbRoom.turnId);
      if (idx >= 0 && lbRoom.order[(idx + 1) % lbRoom.order.length] === p.id) seat.classList.add('next');
    }
    seat.style.left = pos.x + '%';
    seat.style.top = pos.y + '%';
    seat.appendChild(lbAvatarImg(p, 'lb-ava'));
    const nm = document.createElement('div');
    nm.className = 'lb-nm';
    nm.textContent = p.name + (p.isYou ? ' (you)' : '');
    seat.appendChild(nm);
    const sub = document.createElement('div');
    sub.className = 'lb-sub';
    if (p.eliminated) sub.innerHTML = '<span class="out">OUT</span>';
    else if (!p.connected) sub.textContent = 'offline';
    else sub.textContent = `${p.cardCount} card${p.cardCount === 1 ? '' : 's'}`;
    seat.appendChild(sub);
    if (!p.isYou && !p.eliminated && p.cardCount > 0) {
      const minis = document.createElement('div');
      minis.className = 'lb-mini-cards';
      for (let k = 0; k < Math.min(5, p.cardCount); k++) minis.appendChild(document.createElement('i'));
      seat.appendChild(minis);
    }
    zone.appendChild(seat);
  });

  // hub
  $('lbTableRank').innerHTML = `<small>TABLE RANK</small>${lbRankLabel(lbRoom.tableRank)}`;
  const lp = lbRoom.lastPlay;
  const decl = $('lbDeclare');
  if (lp && (lbRoom.state === 'playing' || lbRoom.state === 'reveal')) {
    decl.textContent = `${lbName(lp.by)}: ${lp.count} ${lbRankLabel(lp.rank)}`;
  } else decl.textContent = '';
  const pile = $('lbPileStack');
  pile.innerHTML = '';
  const shown = Math.min(5, lbRoom.pileCount);
  for (let i = 0; i < shown; i++) {
    const c = document.createElement('div');
    c.className = 'lb-pile-card';
    c.style.bottom = (i * 3) + 'px';
    c.style.transform = `translateX(-50%) rotate(${(i % 2 ? 1 : -1) * (i * 4)}deg)`;
    c.style.zIndex = String(i + 1);
    pile.appendChild(c);
  }
  $('lbPileCount').textContent = lbRoom.pileCount > 0 ? `${lbRoom.pileCount} in the pile` : 'pile empty';
  const cfg = $('lbTableCfg');
  if (cfg && lbRoom.settings) {
    cfg.textContent = `${lbRoom.settings.chambers} chambers · ${lbRoom.settings.liveChambers} live` + (lbRoom.settings.devilMode ? ' · 😈' : '');
  }
  const note = $('lbTurnNote');
  delete note.dataset.base;
  if (lbRoom.state === 'risk' && lbRoom.risk) {
    note.innerHTML = `<b>${lbEsc(lbRoom.risk.playerName)}</b> faces the chamber…`;
  } else if (lbRoom.state === 'playing' && lbRoom.turnId) {
    const t = lbName(lbRoom.turnId);
    note.innerHTML = lbRoom.stage === 'decide'
      ? `<b>${lbEsc(t)}</b> smells something…`
      : `<b>${lbEsc(t)}</b> is laying cards…`;
  } else if (lbRoom.state === 'gameover') {
    note.textContent = '';
  } else note.textContent = '';

  if (lbRoom.stage === 'decide') {
    note.classList.add('decide');
  } else {
    note.classList.remove('decide');
  }
  const hub = zone.querySelector('.lb-hub');
  if (hub) hub.classList.toggle('hot', lbRoom.state === 'playing' && lbRoom.stage === 'decide');

  lbRenderHand();
  lbRenderActions();
  lbRenderReveal();
  lbRenderRisk();
}

function lbCardFace(d, c) {
  if (c.rank === 'JOKER') {
    d.classList.add('joker');
    d.innerHTML = `<div class="lb-corner">★<small>WILD</small></div><div class="lb-pip">★</div><div class="lb-corner" style="transform:rotate(180deg)">★<small>WILD</small></div>`;
    return;
  }
  if (['♥', '♦'].includes(c.suit)) d.classList.add('red');
  d.innerHTML = `<div class="lb-corner">${c.rank}<small>${c.suit}</small></div><div class="lb-pip">${c.suit}</div><div class="lb-corner" style="transform:rotate(180deg)">${c.rank}<small>${c.suit}</small></div>`;
  if (c.devil) {
    d.classList.add('devil');
    const mark = document.createElement('span');
    mark.className = 'lb-devil-mark';
    mark.textContent = '😈';
    mark.title = 'Devil card — play it alone';
    d.appendChild(mark);
  }
}

function lbCardEl(c, selectable) {
  const d = document.createElement('div');
  d.className = 'lb-card' + (lbSelected.has(c.id) ? ' sel' : '');
  d.dataset.cid = c.id;
  lbCardFace(d, c);
  const suitWord = { '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs', '★': 'stars' }[c.suit] || c.suit;
  const face = c.rank === 'JOKER' ? 'Wild joker' : `${c.rank} of ${suitWord}`;
  const setLabel = () => d.setAttribute('aria-label',
    `${face}${c.devil ? ', devil card' : ''}${lbSelected.has(c.id) ? ', selected' : ''}`);
  setLabel();
  if (selectable) {
    d.setAttribute('role', 'button');
    d.tabIndex = 0;
    const toggle = () => {
      Sound.unlock(); Sound.click();
      if (lbSelected.has(c.id)) lbSelected.delete(c.id);
      else if (lbSelected.size >= 3) lbToast('Lay at most 3 cards', 'bad');
      else lbSelected.add(c.id);
      setLabel();
      lbRenderHand();
      lbRenderActions();
    };
    d.onclick = toggle;
    d.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    };
  }
  return d;
}

function lbRenderHand() {
  const hand = $('lbHand');
  hand.innerHTML = '';
  const me = lbMe();
  const myTurn = lbRoom.turnId === lbMyId && lbRoom.state === 'playing' && lbRoom.stage === 'play';
  const playable = !!(myTurn && me && !me.eliminated);
  if (!me || me.eliminated) {
    const out = document.createElement('div');
    out.className = 'lb-hintline';
    out.textContent = me && me.eliminated ? 'You are out — watching the table.' : '';
    hand.appendChild(out);
    return;
  }
  (me.cards || []).forEach((c) => hand.appendChild(lbCardEl(c, playable)));
  // drop selections that left the hand (server is source of truth)
  const ids = new Set((me.cards || []).map((c) => c.id));
  for (const id of [...lbSelected]) if (!ids.has(id)) lbSelected.delete(id);
}

function lbRenderActions() {
  const box = $('lbActions');
  box.innerHTML = '';
  const hint = $('lbHint');
  hint.textContent = '';
  const me = lbMe();
  if (!me || me.eliminated || lbRoom.state === 'gameover') {
    if (lbRoom.state === 'gameover') lbRenderGameover(box);
    return;
  }
  const myTurn = lbRoom.turnId === lbMyId && lbRoom.state === 'playing';
  if (!myTurn) {
    hint.textContent = lbRoom.state === 'playing' ? `Waiting on ${lbName(lbRoom.turnId)}…` : '';
    return;
  }
  if (lbRoom.stage === 'play') {
    const hand = (me.cards || []);
    const tr = lbRoom.tableRank;
    const holdRank = hand.filter((c) => c.rank === tr).length;
    const holdWild = hand.filter((c) => c.rank === 'JOKER').length;
    const holdDevil = hand.some((c) => c.devil);
    const line = document.createElement('div');
    line.className = 'lb-countline';
    line.textContent = `You hold ${holdRank} ${lbRankLabel(tr)} + ${holdWild} wild` + (holdDevil ? ' + 😈 devil' : '');
    box.appendChild(line);
    const n = lbSelected.size;
    const selHasDevil = [...lbSelected].some((id) => {
      const cc = hand.find((x) => x.id === id);
      return cc && cc.devil;
    });
    const btn = document.createElement('button');
    btn.className = 'lb-btn primary';
    if (selHasDevil && n > 1) {
      btn.textContent = 'The Devil rides alone';
      btn.disabled = true;
    } else {
      btn.textContent = n > 0
        ? (selHasDevil ? 'Ride the Devil 😈' : `Play ${n} ${lbRankLabel(lbRoom.tableRank)}`)
        : `Select cards — ${lbRankLabel(lbRoom.tableRank)}`;
      btn.disabled = n === 0;
    }
    btn.onclick = () => {
      Sound.unlock(); Sound.click();
      LbNet.send({ t: 'liar_play', cards: [...lbSelected], count: n });
      lbSelected.clear();
    };
    box.appendChild(btn);
    hint.textContent = `Lay 1–3 cards face-down and declare them as ${lbRankLabel(lbRoom.tableRank)}. Jokers are wild — bluff if you must.`;
  } else {
    const lp = lbRoom.lastPlay;
    const liar = document.createElement('button');
    liar.className = 'lb-btn danger';
    liar.textContent = 'LIAR!';
    liar.onclick = () => { Sound.unlock(); Sound.click(); LbNet.send({ t: 'liar_call', liar: true }); };
    const cont = document.createElement('button');
    cont.className = 'lb-btn quiet';
    cont.textContent = 'Continue';
    cont.onclick = () => { Sound.unlock(); Sound.click(); LbNet.send({ t: 'liar_call', liar: false }); };
    box.appendChild(liar);
    box.appendChild(cont);
    hint.textContent = lp
      ? `${lp.byName} claims ${lp.count} ${lbRankLabel(lp.rank)}. Call it or let it slide.`
      : 'Call it or let it slide.';
  }
}

function lbRenderReveal() {
  let box = $('lbRevealBox');
  if (lbRevealPending && !lbLastReveal) {
    if (!box) {
      box = document.createElement('div');
      box.id = 'lbRevealBox';
      $('lbSelf').insertBefore(box, $('lbActions'));
    }
    box.className = 'lb-reveal suspense';
    box.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = lbRevealPending.devil ? 'Something burns…' : 'Called it…';
    box.appendChild(h);
    const p = document.createElement('p');
    p.textContent = lbRevealPending.devil
      ? 'The challenged cards carry a mark…'
      : `${lbRevealPending.challengerName} called LIAR on ${lbRevealPending.byName}. Cards turning…`;
    box.appendChild(p);
    return;
  }
  if (!lbLastReveal) {
    if (box) box.remove();
    return;
  }
  if (!box) {
    box = document.createElement('div');
    box.id = 'lbRevealBox';
    $('lbSelf').insertBefore(box, $('lbActions'));
  }
  const r = lbLastReveal;
  box.className = 'lb-reveal ' + (r.devil ? 'devil' : (r.truthful ? 'truth' : 'bluff'));
  box.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = r.devil ? 'THE DEVIL RIDES' : r.truthful ? 'Truth — wrong call' : 'Bluff caught';
  box.appendChild(h);
  const cards = document.createElement('div');
  cards.className = 'lb-reveal-cards';
  r.cards.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'lb-card';
    d.style.marginLeft = '0';
    d.style.cursor = 'default';
    lbCardFace(d, c);
    cards.appendChild(d);
  });
  box.appendChild(cards);
  const p = document.createElement('p');
  p.textContent = r.devil
    ? `${r.byName} rode the Devil — EVERYONE else faces the chamber.`
    : r.truthful
      ? `${r.challengerName} challenged ${r.byName}'s ${r.count} ${lbRankLabel(r.rank)} — every card matched. ${r.loserName} faces the chamber.`
      : `${r.challengerName} challenged ${r.byName}'s ${r.count} ${lbRankLabel(r.rank)} — a lie. ${r.loserName} faces the chamber.`;
  box.appendChild(p);
}

function lbRenderRisk() {
  let veil = $('lbRiskVeil');
  const showRisk = !!(lbRoom.state === 'risk' && lbRoom.risk);
  if (!showRisk) {
    if (veil) veil.remove();
    return;
  }
  const r = lbRoom.risk;
  const iAmPicker = r.playerId === lbMyId;
  if (!veil) {
    veil = document.createElement('div');
    veil.id = 'lbRiskVeil';
    veil.className = 'lb-risk-veil' + (lbRoom.risk && lbRoom.risk.devil ? ' devilchain' : '');
    document.body.appendChild(veil);
  }
  veil.innerHTML = '';
  const bx = document.createElement('div');
  bx.className = 'lb-risk-box';
  bx.innerHTML = `<p class="eyebrow">RISK CHAMBER</p><h2><b>${lbEsc(r.playerName)}</b> takes the risk</h2><p>${iAmPicker ? 'Tap a chamber. Choose wisely.' : 'Waiting on the challenged player…'}</p>`;
  if (lbRoom && lbRoom.settings) {
    const odds = document.createElement('p');
    odds.className = 'lb-risk-odds';
    odds.textContent = `${lbRoom.settings.liveChambers} live · ${lbRoom.settings.chambers} chambers`;
    bx.appendChild(odds);
  }
  const row = document.createElement('div');
  row.className = 'lb-chambers';
  const pickedInfo = lbRiskInfo();
  r.slots.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'lb-chamber';
    b.textContent = s.picked ? (pickedInfo && pickedInfo[i] && pickedInfo[i].live ? '✕' : '○') : `${i + 1}`;
    if (s.picked) b.classList.add(pickedInfo && pickedInfo[i] && pickedInfo[i].live ? 'picked-live' : 'picked-empty');
    b.disabled = !iAmPicker || s.picked;
    b.setAttribute('aria-label', `Chamber ${i + 1}`);
    if (iAmPicker && !s.picked) {
      b.onclick = () => { Sound.unlock(); try { Sound.emptyClick(); } catch (e) { Sound.click(); } LbNet.send({ t: 'risk_pick', slot: i }); };
    }
    row.appendChild(b);
  });
  bx.appendChild(row);
  const timer = document.createElement('p');
  timer.className = 'lb-risk-timer';
  timer.id = 'lbRiskTimer';
  bx.appendChild(timer);
  if (lbRoom.risk && lbRoom.risk.queueLeft > 0) {
    const q = document.createElement('p');
    q.className = 'lb-risk-queue';
    q.textContent = `+${lbRoom.risk.queueLeft} more after ${r.playerName}`;
    bx.appendChild(q);
  }
  row.classList.add('spin');
  setTimeout(() => { row.classList.remove('spin'); }, 900);
  const res = document.createElement('div');
  res.className = 'lb-risk-result';
  res.id = 'lbRiskResult';
  bx.appendChild(res);
  veil.appendChild(bx);
}

let lbLastRiskSlots = null;
function lbRiskInfo() { return lbLastRiskSlots; }
let lbRiskEndsAt = 0;
let lbRiskSeenFor = null;

// Keyboard shortcuts: L = LIAR!, C = continue, Enter = play selected.
// Ignored while typing in chat or when the bar is not on screen.
document.addEventListener('keydown', (e) => {
  const lg = $('liarGame');
  if (!lg || lg.classList.contains('hidden')) return;
  const tag = (e.target && e.target.tagName) || '';
  if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
  if (e.key === 'l' || e.key === 'L') {
    const b = document.querySelector('#lbActions .lb-btn.danger');
    if (b) { e.preventDefault(); b.click(); }
  } else if (e.key === 'c' || e.key === 'C') {
    const b = [...document.querySelectorAll('#lbActions .lb-btn.quiet')].find((x) => x.textContent === 'Continue');
    if (b) { e.preventDefault(); b.click(); }
  } else if (e.key === 'Enter') {
    const b = document.querySelector('#lbActions .lb-btn.primary');
    if (b && !b.disabled) { e.preventDefault(); b.click(); }
  }
});

function lbRenderGameover(box) {
  const go = lbLastGameover;
  if (!go) return;
  const h = document.createElement('div');
  h.className = 'lb-reveal truth';
  h.innerHTML = `<h3>${lbEsc(go.winnerName)} wins the table</h3><p>${lbEsc(go.note)}</p>`;
  box.appendChild(h);
  if (go.board && go.board.length) {
    const table = document.createElement('div');
    table.className = 'lb-board';
    go.board.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'lb-board-row' + (p.eliminated ? ' dead' : '');
      row.appendChild(lbAvatarImg({ name: p.name, avatar: p.avatar }, ''));
      const meta = document.createElement('div');
      meta.className = 'lb-board-meta';
      const st = p.stats || {};
      const nm = document.createElement('b');
      nm.textContent = `#${i + 1} ${p.name}`;
      const sub = document.createElement('span');
      sub.textContent = `W${st.wins || 0} · survived ${st.survivals || 0} · calls won ${st.challengesWon || 0}${p.eliminated ? ' · OUT' : ''}`;
      meta.appendChild(nm);
      meta.appendChild(sub);
      row.appendChild(meta);
      table.appendChild(row);
    });
    box.appendChild(table);
  }
  const me = lbMe();
  if (me && me.isHost) {
    const again = document.createElement('button');
    again.className = 'lb-btn primary';
    again.textContent = 'Play again';
    again.onclick = () => { Sound.unlock(); Sound.chips(); LbNet.send({ t: 'rematch' }); };
    box.appendChild(again);
  } else {
    const wait = document.createElement('div');
    wait.className = 'lb-waitline';
    wait.textContent = 'Waiting for the host to run it back…';
    box.appendChild(wait);
  }
}

let lbLastGameover = null;

// ---------- fly animation ----------
function lbFly(fromEl) {
  try {
    const table = $('lbTableZone').getBoundingClientRect();
    const r = fromEl.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'lb-fly';
    el.style.left = (r.left + r.width / 2 - 20) + 'px';
    el.style.top = (r.top + r.height / 2 - 28) + 'px';
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = `translate(${table.left + table.width / 2 - (r.left + r.width / 2)}px, ${table.top + table.height / 2 - (r.top + r.height / 2)}px) scale(0.6)`;
      el.style.opacity = '0.2';
    });
    setTimeout(() => el.remove(), 500);
  } catch (e) { /* decorative only */ }
}

// ---------- countdown ticker ----------
setInterval(() => {
  if (!lbRoom || lbRoom.mode !== 'liars') return;
  const note = $('lbTurnNote');
  if (lbEndsAt > Date.now() && note && lbRoom.state === 'playing') {
    const base = note.dataset.base || note.innerHTML;
    note.dataset.base = base;
    note.innerHTML = `${base} <b>· ${Math.ceil((lbEndsAt - Date.now()) / 1000)}s</b>`;
  } else if (note && note.dataset.base) {
    note.innerHTML = note.dataset.base;
    delete note.dataset.base;
  }
  if (note) {
    note.classList.toggle('urgent',
      !!(lbRoom && lbRoom.state === 'playing' && lbEndsAt > Date.now() && lbEndsAt - Date.now() < 6000));
  }
  const rt = $('lbRiskTimer');
  if (rt) {
    if (lbRiskEndsAt > Date.now()) {
      const s = Math.ceil((lbRiskEndsAt - Date.now()) / 1000);
      rt.textContent = `${s}s to pick`;
      rt.classList.toggle('urgent', s <= 5);
    } else {
      rt.textContent = '';
      rt.classList.remove('urgent');
    }
  }
  if (lbRoom && lbRoom.state === 'playing' && lbEndsAt > Date.now()) {
    const s = Math.ceil((lbEndsAt - Date.now()) / 1000);
    const key = `${lbRoom.round}:${lbRoom.turnId}`;
    if (s <= 5 && lbWarnKey !== key) {
      lbWarnKey = key;
      try { Sound.warning(); } catch (e) {}
    }
  }
}, 500);

// ---------- events ----------
function lbEsc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function lbFatalFlash() {
  const flash = $('flash');
  if (flash) { flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go'); }
  const wrap = $('shake-wrap');
  if (wrap) { wrap.classList.remove('shake'); void wrap.offsetWidth; wrap.classList.add('shake'); }
  if (navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) {} }
}

LbNet.on('room', (r) => {
  const first = !lbRoom;
  const rankChanged = !first && lbRoom && lbRoom.tableRank !== r.tableRank && r.state === 'playing';
  lbRoom = r;
  const me = r.players.find((p) => p.isYou);
  if (me) lbMyId = me.id;
  if (first || r.state === 'lobby') { lbLastGameover = null; }
  if (r.state === 'lobby') { lbPrevRank = null; lbOutWarned = new Set(); lbRevealPending = null; }
  if (r.state === 'playing' && !r.lastPlay) { lbLastReveal = null; lbRevealPending = null; }
  if (r.state === 'risk' || r.state === 'gameover') { lbRevealPending = null; }
  if (rankChanged) {
    lbToast(`New table rank: ${lbRankLabel(r.tableRank)}`, 'gold');
    try { Sound.roundStart(); } catch (e) {}
    const rankEl = $('lbTableRank');
    if (rankEl) { rankEl.classList.remove('swap'); void rankEl.offsetWidth; rankEl.classList.add('swap'); }
  }
  if (r.state === 'playing') {
    r.players.forEach((p) => {
      const key = r.round + ':' + p.id;
      if (!p.eliminated && p.connected && p.cardCount === 0 && !lbOutWarned.has(key)) {
        lbOutWarned.add(key);
        if (!first) {
          lbToast(`${p.name} is out of cards — call it or they walk!`, 'bad');
          try { Sound.warning(); } catch (e) {}
        }
      }
    });
  }
  const chatWrap = $('lbChatWrap');
  if (chatWrap) chatWrap.classList.remove('hidden');
  if (r.state === 'lobby' || r.state === 'playing') {
    const ev = $('lbEndVeil');
    if (ev) ev.remove();
  }
  if (!(r.state === 'playing' && r.turnId === lbMyId)) {
    document.title = 'Liar’s Table — Bluff. Challenge. Survive.';
  }
  if (r.state === 'playing' && r.turnId && r.turnId !== lbMyId && r.turnId !== lbLastTurnSeen) {
    lbEndsAt = Date.now() + (Number((r.settings && r.settings.turnTimer) || 30)) * 1000;
  }
  lbLastTurnSeen = r.turnId || null;
  if (r.state === 'risk' && r.risk && r.risk.playerId !== lbRiskSeenFor) {
    lbRiskSeenFor = r.risk.playerId;
    lbRiskEndsAt = Date.now() + (Number((r.settings && r.settings.turnTimer) || 30)) * 1000;
  }
  if (r.state !== 'risk') { lbRiskEndsAt = 0; lbRiskSeenFor = null; }
  lbShow('liarGame');
  lbRender();
});

LbNet.on('phase', () => { lbEndsAt = 0; });
LbNet.on('liar_turn', ({ stage, endsIn }) => {
  lbEndsAt = Date.now() + (Number(endsIn) || 30) * 1000;
  document.title = 'Your turn! — Liar’s Table';
  try { Sound.turn(); } catch (e) {}
  if (navigator.vibrate) { try { navigator.vibrate(80); } catch (e) {} }
  void stage;
});
LbNet.on('liar_played', ({ by }) => {
  lbLastReveal = null;
  try { Sound.slap(); } catch (e) {}
  const seat = [...document.querySelectorAll('.lb-seat')].find((s) => (s.textContent || '').includes(lbName(by)));
  if (seat) lbFly(seat);
});
LbNet.on('liar_reveal', (m) => {
  try { Sound.liar(); } catch (e) {}
  if (m.devil) { try { Sound.warning(); } catch (e) {} }
  if (navigator.vibrate) { try { navigator.vibrate([60, 40, 60]); } catch (e) {} }
  lbRevealPending = m;
  lbRenderReveal();
  setTimeout(() => {
    if (lbRevealPending !== m) return;
    lbLastReveal = m;
    lbRevealPending = null;
    lbRenderReveal();
  }, 1100);
});
LbNet.on('liar_risk', ({ endsIn }) => {
  lbLastRiskSlots = null;
  lbRiskEndsAt = Date.now() + (Number(endsIn) || 30) * 1000;
  try { Sound.revolverSpin(); } catch (e) {}
});
LbNet.on('liar_risk_result', ({ slots, fatal, playerName }) => {
  lbLastRiskSlots = slots;
  const el = $('lbRiskResult');
  if (el) {
    el.textContent = fatal ? `${playerName} is OUT.` : `${playerName} survives.`;
    el.classList.add(fatal ? 'live' : 'safe');
  }
  if (fatal) { try { Sound.bang(); } catch (e) {} lbFatalFlash(); }
  else {
    try { Sound.emptyClick(); Sound.survive(); } catch (e) {}
    try {
      if (window.FX && window.FX.burst) window.FX.burst(14, ['★', '✦', '♠'], ['#ecd9a8', '#c9a35c', '#9db38f']);
    } catch (e) {}
  }
  setTimeout(() => lbRenderRisk(), 400);
});
LbNet.on('liar_gameover', (m) => {
  lbLastGameover = m;
  lbLastReveal = null;
  const veil = $('lbRiskVeil');
  if (veil) veil.remove();
  try { Sound.win(); } catch (e) {}
  try {
    if (window.FX && window.FX.burst) window.FX.burst(44, ['♠', '★', '✦', '♣', '♦'], ['#ecd9a8', '#c9a35c', '#e07864', '#b3402e']);
  } catch (e) {}
  lbRender();
  lbShowEndVeil(m);
});

function lbShowEndVeil(go) {
  if (!go) return;
  let veil = $('lbEndVeil');
  if (veil) veil.remove();
  veil = document.createElement('div');
  veil.id = 'lbEndVeil';
  veil.className = 'lb-end-veil';
  const bx = document.createElement('div');
  bx.className = 'lb-end-box';
  const brow = document.createElement('p');
  brow.className = 'eyebrow';
  brow.textContent = 'LAST ONE STANDING';
  const h = document.createElement('h2');
  h.textContent = `${go.winnerName} takes the table`;
  const note = document.createElement('p');
  note.className = 'lb-end-note';
  note.textContent = go.note || '';
  bx.appendChild(brow);
  bx.appendChild(h);
  bx.appendChild(note);
  if (go.board && go.board.length) {
    const table = document.createElement('div');
    table.className = 'lb-board';
    go.board.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'lb-board-row' + (p.eliminated ? ' dead' : '');
      row.appendChild(lbAvatarImg({ name: p.name, avatar: p.avatar }, ''));
      const meta = document.createElement('div');
      meta.className = 'lb-board-meta';
      const st = p.stats || {};
      const nm = document.createElement('b');
      nm.textContent = `#${i + 1} ${p.name}`;
      const sub = document.createElement('span');
      sub.textContent = `W${st.wins || 0} · survived ${st.survivals || 0} · calls won ${st.challengesWon || 0}${p.eliminated ? ' · OUT' : ''}`;
      meta.appendChild(nm);
      meta.appendChild(sub);
      row.appendChild(meta);
      table.appendChild(row);
    });
    bx.appendChild(table);
  }
  const actions = document.createElement('div');
  actions.className = 'lb-end-actions';
  const me = lbMe();
  if (me && me.isHost) {
    const again = document.createElement('button');
    again.className = 'lb-btn primary';
    again.type = 'button';
    again.textContent = 'Play again';
    again.onclick = () => { Sound.unlock(); try { Sound.chips(); } catch (e) {} LbNet.send({ t: 'rematch' }); };
    actions.appendChild(again);
  }
  const close = document.createElement('button');
  close.className = 'lb-btn quiet';
  close.type = 'button';
  close.textContent = 'View table';
  close.onclick = () => { Sound.click(); veil.remove(); };
  actions.appendChild(close);
  const leave = document.createElement('button');
  leave.className = 'lb-btn quiet';
  leave.type = 'button';
  leave.textContent = 'Leave';
  leave.onclick = () => lbLeave();
  actions.appendChild(leave);
  bx.appendChild(actions);
  veil.appendChild(bx);
  document.body.appendChild(veil);
}
LbNet.on('liar_error', ({ message }) => lbToast(String(message || 'Action not allowed'), 'bad'));
LbNet.on('error', ({ message }) => {
  const text = String(message || 'Could not join room');
  if (!lbRoom && LbNet.roomCode) lbShowConnection(LbNet.roomCode, 'error', false, text);
  else lbToast(text, 'bad');
});
LbNet.on('kicked', () => {
  LbNet.disconnect();
  lbToast('Kicked by host', 'bad');
  setTimeout(() => { location.href = '/'; }, 900);
});
LbNet.on('chat', (m) => {
  lbAddChat(m);
  if (m.sys && /faces the (Risk )?Chamber|called LIAR|went out|survives|wins the table|is out of the game|Timed out/i.test(String(m.text || ''))) {
    lbToast(String(m.text), '');
  }
});
LbNet.on('emote', ({ name, emoji }) => lbAddChat({ name, text: String(emoji) }));

// ---------- bar chat (the bluffing is in the talking) ----------
function lbAddChat({ name, text, sys }) {
  const box = $('lbChatBox');
  if (!box) return;
  const div = document.createElement('div');
  if (sys) div.className = 'sys';
  div.textContent = sys ? String(text) : `${name}: ${text}`;
  box.appendChild(div);
  while (box.children.length > 60) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
function lbSendChat() {
  const inp = $('lbChatInput');
  if (!inp) return;
  const v = inp.value;
  if (!v.trim()) return;
  Sound.unlock();
  inp.value = '';
  LbNet.send({ t: 'chat', text: v });
}
if ($('lbChatSend')) $('lbChatSend').onclick = lbSendChat;
if ($('lbChatInput')) $('lbChatInput').onkeydown = (e) => { if (e.key === 'Enter') lbSendChat(); };
['🔥', '😎', '😭', '🍀', '💸', '👏', '🤯', '🃏'].forEach((em) => {
  const row = $('lbEmoteRow');
  if (!row) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = em;
  b.setAttribute('aria-label', `Send ${em} reaction`);
  b.onclick = () => { Sound.unlock(); LbNet.send({ t: 'emote', emoji: em }); };
  row.appendChild(b);
});

function lbLeave() {
  Sound.click();
  LbNet.send({ t: 'leave' });
  LbNet.disconnect();
  lbRoom = null;
  lbMyId = null;
  lbSelected = new Set();
  lbLastReveal = null;
  lbRevealPending = null;
  lbLastGameover = null;
  const endVeil = $('lbEndVeil');
  if (endVeil) endVeil.remove();
  const veil = $('lbRiskVeil');
  if (veil) veil.remove();
  location.href = '/';
}
