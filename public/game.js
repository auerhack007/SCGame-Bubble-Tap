// public/game.js

// --- Anti-zoom (pinch, ctrl+wheel, double-tap) --- //
(() => {
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => {
    document.addEventListener(ev, e => e.preventDefault(), { passive: false });
  });

  document.addEventListener('touchmove', e => {
    if (e.scale && e.scale !== 1) e.preventDefault();
  }, { passive: false });

  let lastTouchEnd = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  window.addEventListener('wheel', e => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '_'].includes(e.key)) {
      e.preventDefault();
    }
  });
})();

(() => {
  // ---------- DOM ----------
  const $ = s => document.querySelector(s);
  const canvas = $('#game');
  const ctx = canvas.getContext('2d');

  const overlay = $('#overlay');
  const btnStart = $('#start');
  const btnInvite = $('#invite');
  const btnHow = $('#how');
  const btnTop = $('#topbtn');
  const meAvatarTop = $('#meAvatarTop');

  const scoreEl = $('#score');
  const timerFill = $('#timer-fill');

  const gameover = $('#gameover');
  const finalScoreEl = $('#final-score');
  const btnAgain = $('#again');
  const btnShare = $('#share');
  const btnMenu = $('#to-menu');

  const howModal = $('#how-modal');
  const btnOk = $('#modal-ok');
  const btnX = $('#modal-close');

  const leaders = $('#leaders-panel');
  const leadersList = $('#leaders-list');
  const btnCloseTop = $('#close-top');

  // ---------- Utils ----------
  const DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const qs = new URLSearchParams(location.search);
  const getToken = () => qs.get('token');

  const show = el => { if (!el) return; el.classList.remove('hide'); el.style.removeProperty('display'); };
  const hide = el => { if (!el) return; el.classList.add('hide'); el.style.removeProperty('display'); };

  function resize() {
    const w = innerWidth, h = innerHeight;
    canvas.width = Math.round(w * DPR);
    canvas.height = Math.round(h * DPR);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  addEventListener('resize', resize);
  resize();

  // ---------- Haptics ----------
  const Haptics = {
    _v(p){ try { if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') { navigator.vibrate(p); return true; } } catch{} return false; },
    _tryTelegram(fnName, ...args) {
      try {
        if (typeof Telegram !== 'undefined' && Telegram?.WebApp?.HapticFeedback && typeof Telegram.WebApp.HapticFeedback[fnName] === 'function') {
          Telegram.WebApp.HapticFeedback[fnName](...args);
          return true;
        }
      } catch {}
      return false;
    },
    start(){ const ok=this._tryTelegram('impactOccurred','medium')||this._v(10); console.debug('Haptics.start',ok); },
    hit(){ const ok=this._tryTelegram('impactOccurred','light')||this._v(20); console.debug('Haptics.hit',ok); },
    miss(){ const ok=this._tryTelegram('selectionChanged')||this._v(8); console.debug('Haptics.miss',ok); },
    over(){ const ok=this._tryTelegram('notificationOccurred','error')||this._v([20,40,20]); console.debug('Haptics.over',ok); }
  };

  // ---------- Avatar ----------
  const headImg = new Image();
  headImg.decoding = 'async';
  headImg.crossOrigin = 'anonymous';
  const fallbackHead = 'https://i.ibb.co/chPMD6hw/Frame-2087327338.png';
  const token = getToken();

  headImg.onload = () => { if (meAvatarTop) meAvatarTop.src = headImg.src; };
  headImg.onerror = () => { if (headImg.src.includes('/api/me-avatar')) meAvatarTop && (meAvatarTop.src = fallbackHead); };
  headImg.src = token ? '/api/me-avatar?token=' + encodeURIComponent(token) : fallbackHead;

  // ---------- Game state ----------
  const state = {
    running: false,
    score: 0,
    level: 0,
    circle: null,
    nextDeadline: 0,
    lastTime: 0,
    baseLifetime: 2000,
    minLifetime: 500,
    levelLifeFactor: 0.9,
    lifePerHit: 0.98,
    currentLife: null,
    particles: [],
    shakeT: 0,
    fixedRadius: 48,
    baseHue: 200,
    hue: 200,
    hueStep: 36,
    bgHueApplied: NaN
  };

  const LS_BEST = 'scgame_best';
  const best = Number(localStorage.getItem(LS_BEST) || 0);
  const updateHUD = () => { if (scoreEl) scoreEl.textContent = state.score; };
  const getLevel = score => Math.floor(score / 10);

  function approachHue(current, target, t){
    let dh = (((target - current) % 360) + 540) % 360 - 180;
    return current + dh * t;
  }

  function applyBackground(h){
    const c1 = `hsl(${(h + 20) % 360} 55% 22%)`;
    const c2 = `hsl(${(h + 0) % 360} 60% 12%)`;
    const c3 = `hsl(${(h - 10) % 360} 70% 7%)`;
    document.body.style.background = `radial-gradient(1000px 600px at 20% 10%, ${c1} 0%, ${c2} 50%, ${c3} 100%)`;
    state.bgHueApplied = h;
  }

  // ---------- Entities ----------
  function easeOutBack(t){ const c1=1.70158, c3=c1+1; return 1 + c3*Math.pow(t-1,3) + c1*Math.pow(t-1,2); }

  class Target {
    constructor(x,y,r){ this.x=x; this.y=y; this.R=r; this.r=0; this.scale=0; this.glowT=Math.random()*6.28; }
    update(dt){ this.scale=Math.min(1,this.scale+dt*3); this.r=this.R*easeOutBack(this.scale); this.glowT+=2.1*dt; }
    draw(g){
      const h1 = state.hue, h2 = (h1 + 48) % 360;
      const glowR = Math.max(this.r*1.25, this.R*1.25);
      const halo = g.createRadialGradient(this.x,this.y,glowR*0.12, this.x,this.y,glowR);
      halo.addColorStop(0, `hsla(${h1} 90% 65% / ${0.35 + 0.15*Math.sin(this.glowT)})`);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = halo; g.beginPath(); g.arc(this.x,this.y,glowR,0,Math.PI*2); g.fill();

      const core = g.createRadialGradient(this.x, this.y, this.r*0.1, this.x, this.y, this.r);
      core.addColorStop(0.0, '#ffffff');
      core.addColorStop(0.55, `hsl(${h2} 95% 70%)`);
      core.addColorStop(1.0, `hsl(${h1} 90% 62%)`);
      g.fillStyle = core; g.beginPath(); g.arc(this.x,this.y,this.r,0,Math.PI*2); g.fill();

      g.lineWidth = 3;
      g.strokeStyle = `hsla(${h1} 100% 70% / ${0.6 + 0.4*Math.sin(this.glowT)})`;
      g.beginPath(); g.arc(this.x,this.y,this.r,0,Math.PI*2); g.stroke();

      g.save(); g.globalAlpha = 0.25;
      g.beginPath(); g.arc(this.x - this.r*0.35, this.y - this.r*0.35, this.r*0.3, 0, Math.PI*2);
      g.fillStyle = '#fff'; g.fill(); g.restore();
    }
    hit(px,py){ const dx=px-this.x, dy=py-this.y; return dx*dx + dy*dy <= this.r*this.r; }
  }

  class Particle {
    constructor(x,y){ this.x=x; this.y=y; this.vx=(Math.random()-.5)*320; this.vy=(Math.random()-.5)*320; this.life=1; this.r=2+Math.random()*3; }
    update(dt){ this.x+=this.vx*dt; this.y+=this.vy*dt; this.vy+=420*dt; this.life-=1.25*dt; }
    draw(g){ g.globalAlpha=Math.max(0,this.life); g.beginPath(); g.arc(this.x,this.y,this.r,0,Math.PI*2); g.fillStyle='#fff'; g.fill(); g.globalAlpha=1; }
  }
  const burst = (x,y) => { for (let i=0;i<24;i++) state.particles.push(new Particle(x,y)); };

  // ---------- Spawn ----------
  function spawn(){
    const w = canvas.width/DPR, h = canvas.height/DPR, r = state.fixedRadius;
    state.circle = new Target(r + Math.random()*(w-2*r), r + Math.random()*(h-2*r), r);
  }
  function schedule(){
    const life = Math.max(state.minLifetime, state.currentLife ?? state.baseLifetime);
    state.nextDeadline = performance.now() + life;
  }

  // ---------- Input ----------
  canvas.addEventListener('pointerdown', (e) => {
    if (!state.running) return;
    const b = canvas.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;

    if (state.circle?.hit(x,y)) {
      Haptics.hit();
      window.SFX?.pop?.();
      burst(state.circle.x, state.circle.y);
      state.score++;
      updateHUD();
      state.currentLife = Math.max(state.minLifetime, (state.currentLife ?? state.baseLifetime) * state.lifePerHit);

      const newLevel = getLevel(state.score);
      if (newLevel !== state.level) {
        state.level = newLevel;
        state.currentLife = Math.max(state.minLifetime, state.currentLife * state.levelLifeFactor);
      }

      spawn(); schedule();
    } else {
      Haptics.miss();
      window.SFX?.miss?.();
      state.nextDeadline -= 150;
      state.shakeT = .3;
    }
  }, { passive:true });

  // ---------- Loop ----------
  function loop(t){
    const now = t || performance.now();
    const dt = Math.min(.033, (now - state.lastTime)/1000);
    state.lastTime = now;

    const targetHue = (state.baseHue + state.level * state.hueStep) % 360;
    state.hue = approachHue(state.hue, targetHue, 1 - Math.exp(-dt * 3));

    if (timerFill) {
      const h1 = state.hue, h2 = (h1 + 48) % 360;
      timerFill.style.background = `linear-gradient(90deg, hsl(${h1} 90% 60%), hsl(${h2} 90% 65%))`;
    }

    if (!Number.isFinite(state.bgHueApplied) || Math.abs(state.hue - state.bgHueApplied) > 0.5) {
      applyBackground(state.hue);
    }

    ctx.clearRect(0,0,canvas.width,canvas.height);

    if (state.running) {
      state.circle?.update(dt);
      state.circle?.draw(ctx);

      for (let i=state.particles.length-1; i>=0; i--){
        const p = state.particles[i];
        p.update(dt);
        p.draw(ctx);
        if (p.life <= 0) state.particles.splice(i,1);
      }

      const ttl = Math.max(0, state.nextDeadline - now);
      const denom = Math.max(state.minLifetime, state.currentLife ?? state.baseLifetime);
      const k = Math.max(0, Math.min(1, ttl / denom));
      if (timerFill) timerFill.style.transform = `scaleX(${k})`;

      if (ttl <= 0) endGame();

      if (state.shakeT > 0) {
        state.shakeT -= dt;
        const s = state.shakeT * 10;
        canvas.style.transform = `translate(${(Math.random()-0.5)*s}px, ${(Math.random()-0.5)*s}px)`;
      } else {
        canvas.style.transform = '';
      }
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- Start / End ----------
  function startGame(){
    overlay?.classList.add('overlay--closed');
    hide(gameover);
    state.running = true;
    state.score = 0;
    state.level = 0;
    state.particles.length = 0;
    state.shakeT = 0;
    state.hue = state.baseHue;
    state.bgHueApplied = NaN;
    state.currentLife = state.baseLifetime;
    applyBackground(state.hue);
    spawn();
    schedule();
    updateHUD();
    window.SFX?.start?.();
    Haptics.start();
  }

  function endGame(){
    state.running = false;
    try { if (state.score > Number(localStorage.getItem(LS_BEST) || 0)) localStorage.setItem(LS_BEST, String(state.score)); } catch {}
    if (finalScoreEl) finalScoreEl.textContent = state.score;
    show(gameover);
    window.SFX?.fail?.();
    Haptics.over();

    if (token) {
      fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ token, score: state.score })
      }).catch(()=>{});
    }
  }

  function openMainMenu(){
    state.running = false;
    state.circle = null;
    state.particles.length = 0;
    state.shakeT = 0;
    canvas.style.transform = '';
    if (timerFill) timerFill.style.transform = 'scaleX(1)';
    overlay?.classList.remove('overlay--closed');
    hide(gameover);
  }

  // ---------- Share ----------
  function share(){
    const shareText = `Мой счёт: ${state.score} в SC Tap!`;
    const shareUrl = location.href.split('?')[0];
    try {
      if (typeof TelegramGameProxy !== 'undefined' && TelegramGameProxy.shareScore) {
        TelegramGameProxy.shareScore();
      } else if (navigator.share) {
        navigator.share({ title:'SC Tap', text:shareText, url:shareUrl }).catch(()=>{});
      } else {
        const u = new URL('https://t.me/share/url');
        u.searchParams.set('text', shareText);
        u.searchParams.set('url', shareUrl);
        window.open(u.toString(), '_blank');
      }
    } catch {
      (async () => {
        try { await navigator.clipboard.writeText(`${shareText} ${shareUrl}`); alert('Ссылка скопирована'); }
        catch { prompt('Скопируйте ссылку:', `${shareText} ${shareUrl}`); }
      })();
    }
  }

  // ---------- Leaders ----------
  const esc = s=>String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  async function loadLeaders(limit=20){
    if (!leadersList) return;
    leadersList.innerHTML = '<div style="opacity:.75;padding:8px">Загрузка…</div>';
    if (!token) { leadersList.innerHTML = '<div style="opacity:.75;padding:8px">Откройте игру через Play в Telegram</div>'; return; }
    try{
      const r = await fetch('/api/highscores?token=' + encodeURIComponent(token));
      const d = await r.json();
      if (!d.ok || !Array.isArray(d.result)) throw 0;
      const scope = d.scope || 'global';
      const headerHtml = `<div class="leaders-header" style="padding:8px 12px;font-weight:600;text-align:center;border-bottom:1px solid rgba(255,255,255,0.04);margin-bottom:6px;">
        ${scope === 'chat' ? '💬 Топ игроков этого чата' : '🌍 Глобальный рейтинг'}
      </div>`;
      leadersList.innerHTML = headerHtml + (d.result.slice(0,limit).map((row,i)=>{
        const name = (row.user?.username ? '@'+row.user.username : `${row.user?.first_name||''} ${row.user?.last_name||''}`.trim()) || 'Игрок';
        return `<div class="row" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;margin:4px 0;background: ${i===0 ? 'linear-gradient(90deg,#00000022,#ffd70022)' : 'transparent'}">
          <div style="width:28px;text-align:right;font-weight:600">${i+1}.</div>
          <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
          <div style="font-weight:600">${row.score}</div>
        </div>`;
      }).join(''));
    } catch {
      leadersList.innerHTML = '<div style="opacity:.75;padding:8px">Ошибка загрузки :(</div>';
    }
  }

  function openLeaders(){ show(leaders); loadLeaders(); }
  function closeLeaders(){ hide(leaders); }

  // ---------- UI ----------
  btnStart?.addEventListener('click', startGame);
  btnAgain?.addEventListener('click', startGame);
  btnMenu?.addEventListener('click', openMainMenu);
  btnShare?.addEventListener('click', share);
  btnTop?.addEventListener('click', openLeaders);
  btnCloseTop?.addEventListener('click', closeLeaders);
  btnHow?.addEventListener('click', ()=>show(howModal));
  btnOk?.addEventListener('click', ()=>hide(howModal));
  btnX?.addEventListener('click', ()=>hide(howModal));
  btnInvite?.addEventListener('click', ()=>Telegram?.WebApp?.openTelegramLink?.('https://t.me/share/url?url=' + encodeURIComponent(location.href.split('?')[0])));

  // ---------- Sounds ----------
  const AudioC = window.AudioContext || window.webkitAudioContext;
  if (AudioC) {
    const ac = new AudioC();
    function beep(f, dur, v=0.15){
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      o.connect(g);
      g.connect(ac.destination);
      g.gain.value = v;
      o.start();
      o.stop(ac.currentTime + dur);
    }
    window.SFX = {
      pop: ()=>beep(880,0.06),
      miss:()=>beep(120,0.15),
      fail:()=>beep(80,0.3),
      start:()=>beep(440,0.12)
    };
  }

  // ---------- Auto-run for debug ----------
  if (qs.has('autostart')) startGame();
})();
