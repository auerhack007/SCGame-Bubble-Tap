// public/sfx.js
// "Happy Birthday" — по одной НОТЕ за попадание, тембр: пианино (Web Audio).
// API: SFX.start(), SFX.pop(), SFX.miss(), SFX.fail(), SFX.level(),
//      SFX.setVolume(v 0..1), SFX.setTranspose(semitones), SFX.resetMelody()
(() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx, comp, master, delayBus;
  let MASTER_VOL = 0.85;
  let transposeSemis = 0;
  let melodyIndex = 0;

  // --- инициализация аудио ---
  function ensureCtx() {
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();

      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.knee.value = 20;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;

      master = ctx.createGain();
      master.gain.value = MASTER_VOL;

      comp.connect(master);
      master.connect(ctx.destination);

      delayBus = buildDelayBus();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const now = () => (ensureCtx() ? ctx.currentTime : 0);
  const toMaster = n => n && comp && n.connect(comp);

  // --- короткое стерео-эхо для «комнаты» ---
  function buildDelayBus() {
    const inL = ctx.createGain();
    const inR = ctx.createGain();

    const dlL = ctx.createDelay(0.25); dlL.delayTime.value = 0.050; // 50 ms
    const dlR = ctx.createDelay(0.25); dlR.delayTime.value = 0.060; // 60 ms
    const fbL = ctx.createGain(); fbL.gain.value = 0.22;
    const fbR = ctx.createGain(); fbR.gain.value = 0.22;

    const lpL = ctx.createBiquadFilter(); lpL.type='lowpass'; lpL.frequency.value = 2800;
    const lpR = ctx.createBiquadFilter(); lpR.type='lowpass'; lpR.frequency.value = 2800;

    const outL = ctx.createGain(); outL.gain.value = 0.18;
    const outR = ctx.createGain(); outR.gain.value = 0.18;

    inL.connect(dlL); dlL.connect(lpL); lpL.connect(outL); lpL.connect(fbL); fbL.connect(dlL);
    inR.connect(dlR); dlR.connect(lpR); lpR.connect(outR); lpR.connect(fbR); fbR.connect(dlR);

    outL.connect(master);
    outR.connect(master);

    return { inL, inR };
  }

  function panNode(amount = 0.25) {
    if (!('createStereoPanner' in ctx)) return null;
    const p = ctx.createStereoPanner();
    p.pan.value = (Math.random() * 2 - 1) * amount;
    return p;
  }

  // щелчок молоточка
  function hammerNoise(t0, fHint = 2000) {
    const frames = Math.max(1, Math.floor(0.018 * ctx.sampleRate));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) ch[i] = (Math.random() * 2 - 1) * 0.7;

    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = Math.min(4000, fHint * 3.5); bp.Q.value = 6;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.04);

    const p = panNode(0.3);

    src.connect(bp); bp.connect(g);
    if (p) { g.connect(p); p.connect(comp); } else toMaster(g);

    // чуть в «комнату»
    const wet = ctx.createGain(); wet.gain.value = 0.14;
    g.connect(wet); wet.connect(delayBus.inL); wet.connect(delayBus.inR);

    src.start(t0); src.stop(t0 + 0.05);
  }

  // --- МЕЛОДИЯ "Happy Birthday" (C major) ---
  // G4 G4 A4 G4 C5 B4 | G4 G4 A4 G4 D5 C5 | G4 G4 G5 E5 C5 B4 A4 | F5 F5 E5 C5 D5 C5
  const MELODY_BASE = [
    392.00,392.00,440.00,392.00,523.25,493.88,
    392.00,392.00,440.00,392.00,587.33,523.25,
    392.00,392.00,783.99,659.25,523.25,493.88,440.00,
    698.46,698.46,659.25,523.25,587.33,523.25
  ];
  function transposedFreq(f, semis) { return f * Math.pow(2, semis / 12); }

  // --- «Пианино»-голос: несколько обертонов, быстрый щелчок, LP-изменение, никакого вибрато ---
  function playPiano(freqHz, { dur = 0.38 } = {}) {
    const t0 = now();
    const f = transposedFreq(freqHz, transposeSemis);

    // фундаментальные: лёгкий детюн для «живости»
    const f1 = f * (1 + (Math.random()*2 - 1) * 0.0015);
    const f2 = f * (1 + (Math.random()*2 - 1) * 0.0020);

    // обертона (2f, 3f) — тише и затухают быстрее
    const partials = [
      { type: 'sine',     freq: f1, gain: 0.85, rel: dur },            // ядро
      { type: 'triangle', freq: f2, gain: 0.35, rel: dur * 0.85 },     // тело
      { type: 'sine',     freq: f*2, gain: 0.22, rel: Math.max(0.22, dur*0.55) }, // 2-й обертон
      { type: 'sine',     freq: f*3, gain: 0.14, rel: Math.max(0.18, dur*0.45) }  // 3-й обертон
    ];

    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(6200, t0);                // старт яркий
    lp.frequency.exponentialRampToValueAtTime(2400, t0 + Math.min(0.22, dur*0.6)); // быстро темнеет

    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(0.9, t0 + 0.005);  // быстрая атака
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); // эксп. затухание

    const p = panNode(0.18);

    lp.connect(out);
    if (p) { out.connect(p); p.connect(comp); } else toMaster(out);

    // посыл в «комнату»
    const wet = ctx.createGain(); wet.gain.value = 0.2;
    out.connect(wet); wet.connect(delayBus.inL); wet.connect(delayBus.inR);

    // создаём частичные
    const stops = [];
    partials.forEach(prt => {
      const osc = ctx.createOscillator(); osc.type = prt.type;
      osc.frequency.value = prt.freq;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(prt.gain, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + prt.rel);

      osc.connect(g); g.connect(lp);
      osc.start(t0);
      const st = t0 + prt.rel + 0.05;
      osc.stop(st);
      stops.push(st);
    });

    // щелчок молоточка
    hammerNoise(t0, f);

    // обрезаем фильтр чуть позже, чтобы не звенел
    const stopAt = Math.max(...stops);
    // небольшой спад частоты с яркого к тёплому — уже задан выше

    // готово
  }

  // --- события игры ---
  function pop() {
    ensureCtx();
    const f = MELODY_BASE[melodyIndex % MELODY_BASE.length];
    playPiano(f, { dur: 0.38 });
    melodyIndex = (melodyIndex + 1) % MELODY_BASE.length;
  }

  function miss() {
    ensureCtx();
    const t0 = now();
    // тихий «шш», чтобы не забивать мелодию
    const frames = Math.max(1, Math.floor(0.06 * ctx.sampleRate));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i=0;i<frames;i++) ch[i] = (Math.random()*2-1) * 0.6;

    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=900; bp.Q.value=3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);

    src.connect(bp); bp.connect(g); toMaster(g);
    src.start(t0); src.stop(t0 + 0.08);
  }

  function fail() {
    ensureCtx();
    const t0 = now(), dur = 0.5;
    const osc = ctx.createOscillator(); osc.type = 'sine';
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.45, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const p = panNode(0.12);
    if (p) { osc.connect(p); p.connect(g); } else { osc.connect(g); }
    toMaster(g);
    osc.frequency.setValueAtTime(300, t0);
    osc.frequency.exponentialRampToValueAtTime(85,  t0 + dur);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }

  function level() {
    ensureCtx();
    const t0 = now(), dur = 0.16;
    const osc = ctx.createOscillator(); osc.type = 'sine';
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.36, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const p = panNode(0.2);
    if (p) { osc.connect(p); p.connect(g); } else { osc.connect(g); }
    toMaster(g);
    osc.frequency.setValueAtTime(880, t0);
    osc.frequency.exponentialRampToValueAtTime(1320, t0 + dur * 0.6);
    osc.start(t0); osc.stop(t0 + dur + 0.04);
  }

  // --- API ---
  const SFX = {
    start() { const c = ensureCtx(); if (c && c.state === 'suspended') c.resume(); },
    pop, miss, fail, level,
    setVolume(v = 0.85) { ensureCtx(); MASTER_VOL = Math.max(0, Math.min(1, v)); if (master) master.gain.value = MASTER_VOL; },
    setTranspose(semitones = 0) { transposeSemis = semitones | 0; },
    resetMelody() { melodyIndex = 0; }
  };

  window.SFX = SFX;
})();
