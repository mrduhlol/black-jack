/* Liar's Bar client — online rooms via the LiarsBarRoom Durable Object.
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
      ws.onopen = () => { if (!settled) { settled = true; this.ws = ws; resolve(); } };
      ws.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg && typeof msg.t === 'string') this.dispatch(msg);
      };
      ws.onerror = () => { if (!settled) { settled = true; reject(new Error('ws error')); } };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        if (!settled) { settled = true; reject(new Error('ws closed')); return; }
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
    await this.connect(code);
    this.joined = true;
    this.send({ t: 'join', create: !!create, playerId: this.playerId, name: myName(), avatar });
    history.replaceState(null, '', `/?${code}`);
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
let lbEndsAt = 0;

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
// Self sits at the bottom of the ring; everyone else spreads around.
function lbSeatPos(i, n) {
  if (n <= 1) return { x: 50, y: 88 };
  const angle = Math.PI / 2 + (i / n) * Math.PI * 2; // start bottom, clockwise
  const rx = 42, ry = 42;
  return { x: 50 + rx * Math.cos(angle), y: 50 + ry * Math.sin(angle) };
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
  const h = document.createElement('h2');
  h.textContent = "Liar's Bar";
  box.appendChild(h);
  const sub = document.createElement('p');
  sub.textContent = 'Bluff. Challenge. Survive. Shed every card — or send someone to the chamber.';
  box.appendChild(sub);
  const code = document.createElement('div');
  code.className = 'lb-code';
  code.textContent = lbRoom.id;
  box.appendChild(code);

  const roster = document.createElement('div');
  roster.className = 'lb-roster';
  lbRoom.players.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'lb-roster-row';
    row.appendChild(lbAvatarImg(p, ''));
    const nm = document.createElement('span');
    nm.textContent = p.name + (p.isYou ? ' (you)' : '') + (p.connected ? '' : ' · offline');
    row.appendChild(nm);
    if (p.isHost) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'HOST';
      row.appendChild(tag);
    }
    roster.appendChild(row);
  });
  box.appendChild(roster);

  const me = lbMe();
  if (me && me.isHost) {
    const set = document.createElement('div');
    set.className = 'lb-settings';
    const defs = [
      ['maxPlayers', 'Players', 2, 6],
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
    const start = document.createElement('button');
    start.className = 'lb-start';
    start.textContent = 'Start game';
    start.disabled = lbRoom.players.filter((p) => p.connected).length < 2;
    start.onclick = () => { Sound.unlock(); Sound.click(); LbNet.send({ t: 'start_game' }); };
    box.appendChild(start);
  } else {
    const wait = document.createElement('p');
    wait.textContent = 'Waiting for the host to start…';
    box.appendChild(wait);
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
  const note = $('lbTurnNote');
  delete note.dataset.base;
  if (lbRoom.state === 'risk' && lbRoom.risk) {
    note.innerHTML = `<b>${lbRoom.risk.playerName}</b> faces the chamber…`;
  } else if (lbRoom.state === 'playing' && lbRoom.turnId) {
    const t = lbName(lbRoom.turnId);
    note.innerHTML = lbRoom.stage === 'decide'
      ? `<b>${t}</b> smells something…`
      : `<b>${t}</b> is laying cards…`;
  } else if (lbRoom.state === 'gameover') {
    note.textContent = '';
  } else note.textContent = '';

  lbRenderHand();
  lbRenderActions();
  lbRenderReveal();
  lbRenderRisk();
}

function lbCardEl(c, selectable) {
  const d = document.createElement('div');
  d.className = 'lb-card' + (['♥', '♦'].includes(c.suit) ? ' red' : '') + (lbSelected.has(c.id) ? ' sel' : '');
  d.dataset.cid = c.id;
  d.innerHTML = `<div class="lb-corner">${c.rank}<small>${c.suit}</small></div><div class="lb-pip">${c.suit}</div><div class="lb-corner" style="transform:rotate(180deg)">${c.rank}<small>${c.suit}</small></div>`;
  if (selectable) {
    d.onclick = () => {
      Sound.unlock(); Sound.click();
      if (lbSelected.has(c.id)) lbSelected.delete(c.id);
      else if (lbSelected.size >= 4) lbToast('Lay at most 4 cards', 'bad');
      else lbSelected.add(c.id);
      lbRenderHand();
      lbRenderActions();
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
    const n = lbSelected.size;
    const btn = document.createElement('button');
    btn.className = 'lb-btn primary';
    btn.textContent = n > 0 ? `Play ${n} ${lbRankLabel(lbRoom.tableRank)}` : `Select cards — ${lbRankLabel(lbRoom.tableRank)}`;
    btn.disabled = n === 0;
    btn.onclick = () => {
      Sound.unlock(); Sound.click();
      LbNet.send({ t: 'liar_play', cards: [...lbSelected], count: n });
      lbSelected.clear();
    };
    box.appendChild(btn);
    hint.textContent = `Lay 1–4 cards face-down and declare them as ${lbRankLabel(lbRoom.tableRank)}. Bluff if you must.`;
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
  box.className = 'lb-reveal ' + (r.truthful ? 'truth' : 'bluff');
  box.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = r.truthful ? 'Truth — wrong call' : 'Bluff caught';
  box.appendChild(h);
  const cards = document.createElement('div');
  cards.className = 'lb-reveal-cards';
  r.cards.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'lb-card' + (['♥', '♦'].includes(c.suit) ? ' red' : '');
    d.style.marginLeft = '0';
    d.style.cursor = 'default';
    d.innerHTML = `<div class="lb-corner">${c.rank}<small>${c.suit}</small></div><div class="lb-pip">${c.suit}</div><div class="lb-corner" style="transform:rotate(180deg)">${c.rank}<small>${c.suit}</small></div>`;
    cards.appendChild(d);
  });
  box.appendChild(cards);
  const p = document.createElement('p');
  p.textContent = r.truthful
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
    veil.className = 'lb-risk-veil';
    document.body.appendChild(veil);
  }
  veil.innerHTML = '';
  const bx = document.createElement('div');
  bx.className = 'lb-risk-box';
  bx.innerHTML = `<p class="eyebrow">RISK CHAMBER</p><h2><b>${r.playerName}</b> takes the risk</h2><p>${iAmPicker ? 'Tap a chamber. Choose wisely.' : 'Waiting on the challenged player…'}</p>`;
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
      b.onclick = () => { Sound.unlock(); Sound.click(); LbNet.send({ t: 'risk_pick', slot: i }); };
    }
    row.appendChild(b);
  });
  bx.appendChild(row);
  const res = document.createElement('div');
  res.className = 'lb-risk-result';
  res.id = 'lbRiskResult';
  bx.appendChild(res);
  veil.appendChild(bx);
}

let lbLastRiskSlots = null;
function lbRiskInfo() { return lbLastRiskSlots; }

function lbRenderGameover(box) {
  const go = lbLastGameover;
  if (!go) return;
  const h = document.createElement('div');
  h.className = 'lb-reveal truth';
  h.innerHTML = `<h3>${go.winnerName} wins the table</h3><p>${go.note}</p>`;
  box.appendChild(h);
  const me = lbMe();
  if (me && me.isHost) {
    const again = document.createElement('button');
    again.className = 'lb-btn primary';
    again.textContent = 'Play again';
    again.onclick = () => { Sound.unlock(); Sound.chips(); LbNet.send({ t: 'rematch' }); };
    box.appendChild(again);
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
}, 500);

// ---------- events ----------
LbNet.on('room', (r) => {
  const first = !lbRoom;
  lbRoom = r;
  const me = r.players.find((p) => p.isYou);
  if (me) lbMyId = me.id;
  if (first || r.state === 'lobby') { lbLastGameover = null; }
  if (r.state === 'playing' && !r.lastPlay) { lbLastReveal = null; }
  lbShow('liarGame');
  lbRender();
});

LbNet.on('phase', () => { lbEndsAt = 0; });
LbNet.on('liar_turn', ({ stage, endsIn }) => {
  lbEndsAt = Date.now() + (Number(endsIn) || 30) * 1000;
  void stage;
});
LbNet.on('liar_played', ({ by }) => {
  lbLastReveal = null;
  Sound.deal();
  const seat = [...document.querySelectorAll('.lb-seat')].find((s) => (s.textContent || '').includes(lbName(by)));
  if (seat) lbFly(seat);
});
LbNet.on('liar_reveal', (m) => {
  lbLastReveal = m;
  Sound.warning();
  if (navigator.vibrate) { try { navigator.vibrate([60, 40, 60]); } catch (e) {} }
  lbRenderReveal();
});
LbNet.on('liar_risk', () => {
  lbLastRiskSlots = null;
  Sound.warning();
});
LbNet.on('liar_risk_result', ({ slots, fatal, playerName }) => {
  lbLastRiskSlots = slots;
  const el = $('lbRiskResult');
  if (el) {
    el.textContent = fatal ? `${playerName} is OUT.` : `${playerName} survives.`;
    el.classList.add(fatal ? 'live' : 'safe');
  }
  if (fatal) Sound.bust();
  else Sound.win();
  setTimeout(() => lbRenderRisk(), 400);
});
LbNet.on('liar_gameover', (m) => {
  lbLastGameover = m;
  lbLastReveal = null;
  const veil = $('lbRiskVeil');
  if (veil) veil.remove();
  Sound.win();
  lbRender();
});
LbNet.on('liar_error', ({ message }) => lbToast(String(message || 'Action not allowed'), 'bad'));
LbNet.on('error', ({ message }) => lbToast(String(message || 'Could not join room'), 'bad'));
LbNet.on('kicked', () => {
  LbNet.disconnect();
  lbToast('Kicked by host', 'bad');
  setTimeout(() => { location.href = '/'; }, 900);
});
LbNet.on('chat', ({ name, text, sys }) => {
  if (sys) lbToast(String(text), '');
});
LbNet.on('emote', ({ name, emoji }) => lbToast(`${name} ${emoji}`, ''));

function lbLeave() {
  Sound.click();
  LbNet.send({ t: 'leave' });
  LbNet.disconnect();
  lbRoom = null;
  lbMyId = null;
  lbSelected = new Set();
  lbLastReveal = null;
  lbLastGameover = null;
  const veil = $('lbRiskVeil');
  if (veil) veil.remove();
  location.href = '/';
}
