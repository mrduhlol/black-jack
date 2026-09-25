/* black-jack.io FX — gold dust particles, cursor glow, 3D tilt, win bursts. Visual only. */
(() => {
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);

  /* ---------- gold dust + floating suits canvas ---------- */
  const canvas = $('fx');
  let ctx = null, parts = [], W = 0, H = 0;
  const SUITS = ['♠', '♥', '♦', '♣', '★', '✦'];
  function resize() {
    if (!canvas) return;
    W = canvas.width = Math.floor(window.innerWidth * Math.min(2, window.devicePixelRatio || 1));
    H = canvas.height = Math.floor(window.innerHeight * Math.min(2, window.devicePixelRatio || 1));
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
  }
  function seed() {
    parts = [];
    const n = Math.min(90, Math.floor(window.innerWidth / 16));
    for (let i = 0; i < n; i++) {
      parts.push({
        x: Math.random() * W, y: Math.random() * H,
        r: (Math.random() * 2.2 + 0.6) * (window.devicePixelRatio || 1),
        vy: (Math.random() * 0.35 + 0.08) * (window.devicePixelRatio || 1),
        vx: (Math.random() - 0.5) * 0.25 * (window.devicePixelRatio || 1),
        a: Math.random() * Math.PI * 2,
        suit: Math.random() < 0.22 ? SUITS[Math.floor(Math.random() * SUITS.length)] : null,
        hue: Math.random(),
        tw: Math.random() * Math.PI * 2,
      });
    }
  }
  function tick() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const t = Date.now() / 1000;
    for (const p of parts) {
      p.y -= p.vy; p.x += p.vx + Math.sin(t * 0.7 + p.a) * 0.25;
      p.tw += 0.03;
      if (p.y < -20) { p.y = H + 20; p.x = Math.random() * W; }
      if (p.x < -20) p.x = W + 20; if (p.x > W + 20) p.x = -20;
      const alpha = 0.25 + Math.abs(Math.sin(p.tw)) * 0.5;
      if (p.suit) {
        ctx.font = `${14 * (window.devicePixelRatio || 1)}px serif`;
        ctx.fillStyle = p.hue > 0.7 ? `rgba(255,61,129,${alpha * 0.5})` : `rgba(255,212,71,${alpha * 0.55})`;
        ctx.fillText(p.suit, p.x, p.y);
      } else {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3);
        g.addColorStop(0, `rgba(255,232,154,${alpha})`);
        g.addColorStop(1, 'rgba(255,232,154,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    requestAnimationFrame(tick);
  }
  if (canvas && !reduced()) {
    ctx = canvas.getContext('2d');
    resize(); seed(); tick();
    window.addEventListener('resize', () => { resize(); seed(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && parts.length === 0) seed(); });
  }

  /* ---------- cursor glow ---------- */
  const glow = $('cursorGlow');
  if (glow && !reduced() && window.matchMedia('(hover:hover)').matches) {
    let gx = -999, gy = -999, tx = gx, ty = gy;
    window.addEventListener('pointermove', (e) => { tx = e.clientX; ty = e.clientY; }, { passive: true });
    (function follow() {
      gx += (tx - gx) * 0.12; gy += (ty - gy) * 0.12;
      glow.style.transform = `translate(${gx - 260}px,${gy - 260}px)`;
      requestAnimationFrame(follow);
    })();
  } else if (glow) glow.style.display = 'none';

  /* ---------- hero 3D tilt ---------- */
  const fan = $('heroFan');
  if (fan && !reduced() && window.matchMedia('(hover:hover)').matches) {
    const card = $('setupCard') || fan;
    card.addEventListener('pointermove', (e) => {
      const r = fan.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dx = (e.clientX - cx) / r.width, dy = (e.clientY - cy) / r.height;
      fan.style.setProperty('--ry', `${Math.max(-14, Math.min(14, dx * 18))}deg`);
      fan.style.setProperty('--rx', `${Math.max(-12, Math.min(12, -dy * 14))}deg`);
    });
    card.addEventListener('pointerleave', () => {
      fan.style.setProperty('--rx', '0deg'); fan.style.setProperty('--ry', '0deg');
    });
  }

  /* ---------- magnetic play button ---------- */
  document.querySelectorAll('.magnetic').forEach((btn) => {
    if (reduced() || !window.matchMedia('(hover:hover)').matches) return;
    btn.addEventListener('pointermove', (e) => {
      const r = btn.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      btn.style.transform = `translate(${dx * 0.08}px,${dy * 0.12 - 2}px)`;
    });
    btn.addEventListener('pointerleave', () => { btn.style.transform = ''; });
  });

  /* ---------- win bursts: DOM chips + flash + shake ---------- */
  const layer = $('burst-layer'), flash = $('flash'), wrap = $('shake-wrap');
  function burst(n = 26, emojis = ['♠', '♥', '♦', '♣', '★', '$', '✦']) {
    if (!layer || reduced()) { if (flash) { flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go'); } return; }
    const cx = window.innerWidth / 2, cy = window.innerHeight * 0.38;
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      s.className = 'burst-p';
      s.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      const gold = Math.random() < 0.55;
      s.style.left = cx + 'px'; s.style.top = cy + 'px';
      s.style.color = gold ? '#ffd447' : (Math.random() < 0.5 ? '#ff3d81' : '#22e6ff');
      s.style.fontSize = (14 + Math.random() * 22) + 'px';
      s.style.textShadow = '0 0 12px currentColor';
      const ang = Math.random() * Math.PI * 2, dist = 120 + Math.random() * 320;
      s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
      s.style.setProperty('--dy', `${Math.sin(ang) * dist - 120}px`);
      s.style.setProperty('--rr', `${(Math.random() - 0.5) * 540}deg`);
      layer.appendChild(s);
      setTimeout(() => s.remove(), 1500);
    }
    if (flash) { flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go'); }
    if (wrap) { wrap.classList.remove('shake'); void wrap.offsetWidth; wrap.classList.add('shake'); }
  }
  window.FX = { burst };

  // Watch the existing game banner — no changes to client.js needed.
  const banner = $('resultBanner');
  if (banner) {
    const obs = new MutationObserver(() => {
      if (banner.classList.contains('hidden')) return;
      const c = banner.className;
      if (c.includes('blackjack')) burst(44);
      else if (c.includes('win')) burst(26);
      else if (c.includes('lose')) { if (wrap) { wrap.classList.remove('shake'); void wrap.offsetWidth; wrap.classList.add('shake'); } }
    });
    obs.observe(banner, { attributes: true, attributeFilter: ['class'] });
  }
  // Big confetti when winner modal opens
  const modal = $('winnerModal');
  if (modal) {
    const obs = new MutationObserver(() => {
      if (!modal.classList.contains('hidden')) burst(60);
    });
    obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
  }
  // Chip click sparkle on bet
  document.addEventListener('click', (e) => {
    const chip = e.target && e.target.closest ? e.target.closest('.poker-chip') : null;
    if (!chip || reduced() || !layer) return;
    for (let i = 0; i < 8; i++) {
      const s = document.createElement('span');
      s.className = 'burst-p'; s.textContent = '✦';
      s.style.left = e.clientX + 'px'; s.style.top = e.clientY + 'px';
      s.style.color = '#ffe89a'; s.style.fontSize = (10 + Math.random() * 12) + 'px';
      const ang = Math.random() * Math.PI * 2, dist = 40 + Math.random() * 80;
      s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
      s.style.setProperty('--dy', `${Math.sin(ang) * dist - 30}px`);
      s.style.setProperty('--rr', '180deg');
      s.style.animationDuration = '0.8s';
      layer.appendChild(s);
      setTimeout(() => s.remove(), 900);
    }
  });
})();
