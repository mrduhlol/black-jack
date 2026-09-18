// Tiny WebAudio sound engine — no audio files needed.
// Blackjack party sounds: deal, chips, win, blackjack, bust, turn, click.
// Polished pass: volume + mute persistence, autoplay unlock, subtle premium mix.
const Sound = (() => {
  const LS_MUTE = 'bj.sound.muted';
  const LS_VOL = 'bj.sound.volume';
  let ctx = null;
  let enabled = true;
  let volume = 0.8;
  let unlocked = false;

  try {
    const m = localStorage.getItem(LS_MUTE);
    if (m === '1') enabled = false;
    const v = parseFloat(localStorage.getItem(LS_VOL) || '');
    if (Number.isFinite(v)) volume = Math.min(1, Math.max(0, v));
  } catch (e) { /* private mode */ }

  function persist() {
    try {
      localStorage.setItem(LS_MUTE, enabled ? '0' : '1');
      localStorage.setItem(LS_VOL, String(volume));
    } catch (e) { /* ignore */ }
  }

  // Browsers block AudioContext before a user gesture. Create/resume lazily,
  // and never throw before first interaction.
  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended' && unlocked) ctx.resume().catch(() => {});
    return ctx;
  }

  function unlock() {
    unlocked = true;
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  // Unlock on first real gesture so later game sounds are allowed.
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => {
    window.addEventListener(ev, unlock, { passive: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    else if (!document.hidden && unlocked && ctx && ctx.state === 'suspended' && enabled) ctx.resume().catch(() => {});
  });

  function tone(freq, dur = 0.12, type = 'sine', vol = 0.18, when = 0) {
    if (!enabled) return;
    if (!unlocked) return; // respect autoplay: silent until user interacts
    try {
      const c = ac();
      if (!c) return;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.value = freq;
      const v = vol * volume;
      g.gain.setValueAtTime(Math.max(0.0001, v), c.currentTime + when);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + when + dur);
      o.connect(g).connect(c.destination);
      o.start(c.currentTime + when);
      o.stop(c.currentTime + when + dur + 0.02);
    } catch (e) { /* audio blocked */ }
  }

  // crispy noise bursts: card slides, chip clacks, shuffle
  let noiseBuf = null;
  function noise(dur = 0.08, vol = 0.12, freq = 3000, when = 0, q = 1) {
    if (!enabled) return;
    if (!unlocked) return;
    try {
      const c = ac();
      if (!c) return;
      if (!noiseBuf) {
        noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.3), c.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const src = c.createBufferSource();
      src.buffer = noiseBuf;
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq;
      f.Q.value = q;
      const g = c.createGain();
      const v = vol * volume;
      g.gain.setValueAtTime(Math.max(0.0001, v), c.currentTime + when);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + when + dur);
      src.connect(f).connect(g).connect(c.destination);
      src.start(c.currentTime + when);
      src.stop(c.currentTime + when + dur + 0.02);
    } catch (e) { /* audio blocked */ }
  }

  return {
    get enabled() { return enabled; },
    get volume() { return volume; },
    get muted() { return !enabled; },
    toggle() { enabled = !enabled; unlock(); persist(); return enabled; },
    setMuted(m) { enabled = !m; unlock(); persist(); return enabled; },
    setVolume(v) {
      volume = Math.min(1, Math.max(0, Number(v) || 0));
      persist();
      return volume;
    },
    unlock,
    click() { tone(720, 0.05, 'triangle', 0.08); },
    deal() { noise(0.09, 0.12, 2500); tone(440, 0.07, 'triangle', 0.1, 0.03); },
    shuffle() { noise(0.1, 0.1, 1800); noise(0.1, 0.1, 2400, 0.1); noise(0.12, 0.1, 2000, 0.2); },
    chips() { noise(0.045, 0.14, 5200); noise(0.045, 0.14, 6100, 0.055); tone(1560, 0.05, 'sine', 0.06, 0.02); },
    chipRemove() { noise(0.05, 0.1, 3600); tone(520, 0.06, 'triangle', 0.07, 0.01); },
    win() { tone(523, 0.11, 'triangle', 0.16); tone(659, 0.11, 'triangle', 0.16, 0.09); tone(784, 0.2, 'triangle', 0.16, 0.18); noise(0.18, 0.04, 7000, 0.18); },
    blackjack() { tone(523, 0.09, 'triangle', 0.18); tone(659, 0.09, 'triangle', 0.18, 0.08); tone(784, 0.09, 'triangle', 0.18, 0.16); tone(1046, 0.32, 'triangle', 0.18, 0.24); noise(0.25, 0.05, 8000, 0.24); },
    lose() { tone(300, 0.14, 'sawtooth', 0.07); tone(220, 0.22, 'sawtooth', 0.07, 0.11); },
    bust() { tone(200, 0.18, 'sawtooth', 0.12); tone(140, 0.28, 'sawtooth', 0.12, 0.14); noise(0.12, 0.08, 900, 0.02); },
    push() { tone(440, 0.1, 'triangle', 0.1); tone(440, 0.1, 'triangle', 0.1, 0.12); },
    turn() { tone(880, 0.08, 'sine', 0.13); tone(880, 0.08, 'sine', 0.13, 0.13); },
    warning() { tone(660, 0.09, 'square', 0.05); tone(660, 0.09, 'square', 0.05, 0.14); },
    reveal() { tone(392, 0.09, 'triangle', 0.13); tone(494, 0.09, 'triangle', 0.13, 0.08); tone(587, 0.16, 'triangle', 0.13, 0.16); },
    roundStart() { tone(523, 0.09, 'triangle', 0.14); tone(784, 0.14, 'triangle', 0.14, 0.09); },
    roundEnd() { tone(587, 0.1, 'triangle', 0.12); tone(392, 0.16, 'triangle', 0.12, 0.1); },
  };
})();
