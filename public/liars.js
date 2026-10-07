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
let lbRevealPending = null;
let lbEndsAt = 0;
let lbPrevRank = null;
let lbLastTurnSeen = null;
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
  h.textContent = "Liar's Table";
  box.appendChild(h);
  const sub = document.createElement('p');
  sub.textContent = 'Bluff. Challenge. Survive. Shed every card — or send someone to the chamber.';
  box.appendChild(sub);
  const code = document.createElement('div');
  code.className = 'lb-code';
  code.textContent = lbRoom.id;
  box.appendChild(code);

  const deck = document.createElement('p');
  deck.className = 'lb-deckline';
  deck.textContent = '20-card deck · Kings, Queens, Aces + 2 wild Jokers · 5 cards each';
  box.appendChild(deck);

  const odds = document.createElement('p');
  odds.className = 'lb-oddsline';
  const chN = lbRoom.settings.chambers, lvN = lbRoom.settings.liveChambers;
  odds.textContent = `${chN} chambers · ${lvN} live · ${Math.round((lvN / chN) * 100)}% sudden death`;
  box.appendChild(odds);

  const inv = document.createElement('button');
  inv.className = 'lb-btn quiet lb-invite';
  inv.type = 'button';
  inv.textContent = 'Copy invite link';
  inv.onclick = () => {
    Sound.unlock(); Sound.click();
    const url = `${location.origin}/?${lbRoom.id}`;
    const done = () => lbToast(`Invite copied: ${lbRoom.id}`, 'gold');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => lbToast(url, ''));
    } else lbToast(url, '');
  };
  box.appendChild(inv);

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

  const roster = document.createElement('div');
  roster.className = 'lb-roster';
  lbRoom.players.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'lb-roster-row';
    row.appendChild(lbAvatarImg(p, ''));
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
      kick.onclick = () => { Sound.unlock(); Sound.click(); LbNet.send({ t: 'kick', targetId: p.id }); };
      row.appendChild(kick);
    }
    roster.appendChild(row);
  });
  box.appendChild(roster);

  const connected = lbRoom.players.filter((p) => p.connected).length;
  if (connected < 2) {
    const need = document.createElement('p');
    need.className = 'lb-need';
    need.textContent = `Waiting for players (${connected}/2 to start)…`;
    box.appendChild(need);
  }

  const me = lbMe();
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
    if (lbRoom.settings.devilMode) {
      const dv = document.createElement('p');
      dv.className = 'lb-devil-note';
      dv.textContent = '😈 Devil card in play — ride it alone, if you dare.';
      box.appendChild(dv);
    }
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
  if (selectable) {
    d.onclick = () => {
      Sound.unlock(); Sound.click();
      if (lbSelected.has(c.id)) lbSelected.delete(c.id);
      else if (lbSelected.size >= 3) lbToast('Lay at most 3 cards', 'bad');
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
    veil.className = 'lb-risk-veil';
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
      b.onclick = () => { Sound.unlock(); Sound.click(); LbNet.send({ t: 'risk_pick', slot: i }); };
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
  if (chatWrap) chatWrap.classList.toggle('hidden', r.state === 'lobby');
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
  else { try { Sound.emptyClick(); Sound.survive(); } catch (e) {} }
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
LbNet.on('error', ({ message }) => lbToast(String(message || 'Could not join room'), 'bad'));
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
