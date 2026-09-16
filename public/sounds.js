// Tiny WebAudio sound engine — no audio files needed.
// Blackjack party sounds: deal, chips, win, blackjack, bust, turn, click.
const Sound = (() => {
  let ctx = null;
  let enabled = true;

  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, dur = 0.12, type = 'sine', vol = 0.18, when = 0) {
    if (!enabled) return;
    try {
      const c = ac();
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, c.currentTime + when);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + when + dur);
      o.connect(g).connect(c.destination);
      o.start(c.currentTime + when);
      o.stop(c.currentTime + when + dur);
    } catch (e) { /* audio blocked */ }
  }

  return {
    get enabled() { return enabled; },
    toggle() { enabled = !enabled; return enabled; },
    click() { tone(600, 0.06, 'square', 0.08); },
    deal() { tone(440, 0.08, 'triangle', 0.15); tone(520, 0.08, 'triangle', 0.12, 0.07); },
    chips() { tone(1200, 0.05, 'square', 0.06); tone(1600, 0.05, 'square', 0.06, 0.05); },
    win() { tone(523, 0.12, 'sine', 0.2); tone(659, 0.12, 'sine', 0.2, 0.1); tone(784, 0.2, 'sine', 0.2, 0.2); },
    blackjack() { tone(523, 0.1, 'sine', 0.22); tone(659, 0.1, 'sine', 0.22, 0.09); tone(784, 0.1, 'sine', 0.22, 0.18); tone(1046, 0.3, 'sine', 0.22, 0.27); },
    lose() { tone(300, 0.15, 'sawtooth', 0.1); tone(220, 0.25, 'sawtooth', 0.1, 0.12); },
    bust() { tone(200, 0.2, 'sawtooth', 0.16); tone(140, 0.3, 'sawtooth', 0.16, 0.15); },
    turn() { tone(880, 0.09, 'sine', 0.16); tone(880, 0.09, 'sine', 0.16, 0.14); },
    reveal() { tone(392, 0.1, 'triangle', 0.16); tone(494, 0.1, 'triangle', 0.16, 0.09); tone(587, 0.18, 'triangle', 0.16, 0.18); },
  };
})();
