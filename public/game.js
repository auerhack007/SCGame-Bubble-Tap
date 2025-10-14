// public/game.js

// --- Anti-zoom (pinch, ctrl+wheel, double-tap) --- //
(() => {
  // Блок pinch-zoom (iOS Safari жесты)
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => {
    document.addEventListener(ev, e => e.preventDefault(), { passive: false });
  });

  // Блок pinch через scale на touchmove (старые WebKit)
  document.addEventListener('touchmove', e => {
    if (e.scale && e.scale !== 1) e.preventDefault();
  }, { passive: false });

  // Блок double-tap zoom
  let lastTouchEnd = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  // Блок ctrl/cmd + колесо и ctrl/cmd + +/-/=
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
  const $ = (s) => document.querySelector(s);

  const canvas = $('#game');
  const ctx = canvas.getContext('2d');

  // overlay (bottom sheet)
  const overlay     = $('#overlay');
  const btnStart    = $('#start');
  const btnInvite   = $('#invite');
  const btnHow      = $('#how');
  const btnTop      = $('#topbtn');
  const meAvatarTop = $('#meAvatarTop'); // аватар в шапке

  // HUD
  const scoreEl   = $('#score');
  const timerFill = $('#timer-fill');

  // Game Over
  const gameover      = $('#gameover');
  const finalScoreEl  = $('#final-score');
  const btnAgain      = $('#again');
  const btnShare      = $('#share');
  const btnMenu       = $('#to-menu'); // "В меню", если есть в HTML

  // How modal
  const howModal  = $('#how-modal');
  const btnOk     = $('#modal-ok');
  const btnX      = $('#modal-close');

  // Leaders
  const leaders       = $('#leaders-panel');
  const leadersList   = $('#leaders-list');
  const btnCloseTop   = $('#close-top');

  // ---------- Utils ----------
  const DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const qs = new URLSearchParams(location.search);
  const getToken = () => qs.get('token');

  const show = (el) => { if (!el) return; el.classList.remove('hide'); el.style.removeProperty('display'); };
  const hide = (el) => { if (!el) return; el.classList.add('hide'); el.style.removeProperty('display'); };

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
    _v(p){ try { if ('vibrate' in navigator) navigator.vibrate(p); } catch {} },
    start(){ try { if (Telegram?.WebApp?.HapticFeedback?.impactOccurred) { Telegram.WebApp.HapticFeedback.impactOccurred('medium'); return; } } catch {} this._v(10); },
    hit(){   try { if (Telegram?.WebApp?.HapticFeedback?.impactOccurred) { Telegram.WebApp.HapticFeedback.impactOccurred('light');  return; } } catch {} this._v(15); },
    miss(){  try { if (Telegram?.WebApp?.HapticFeedback?.selectionChanged){ Telegram.WebApp.HapticFeedback.selectionChanged();     return; } } catch {} this._v(8); },
    over(){  try { if (Telegram?.WebApp?.HapticFeedback?.notificationOccurred){ Telegram.WebApp.HapticFeedback.notificationOccurred('error'); return; } } catch {} this._v([20,40,20]); }
  };

  // ---------- Avatar для шапки ----------
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

    // уровень = floor(score/10)
    level: 0,

    circle: null,
    nextDeadline: 0,
    lastTime: 0,

    // БАЗОВЫЕ НАСТРОЙКИ "СКОРОСТИ"
    baseLifetime: 2000,   // мс на уровне 0 (стартовая «жизнь» цели)
    minLifetime: 500,     // нижняя граница
    levelLifeFactor: 0.9, // каждые 10 очков — base *= 0.9 (ступенчато)

    // НОВОЕ: ПЛАВНОЕ УСКОРЕНИЕ ОТ КАЖДОГО ХИТА
    lifePerHit: 0.98,     // каждый точный тап: currentLife *= 0.98
    currentLife: null,    // актуальная «жизнь» цели, используется для дедлайна

    particles: [],
    shakeT: 0,
    fixedRadius: 48,

    // ПАЛИТРА: цвет круга/таймера + фон синхронизированы
    baseHue: 200,   // стартовый сине-голубой
    hue: 200,       // текущий (плавно аппроксимируется)
    hueStep: 36,    // на каждый уровень hue += 36 (10 уровней на оборот)

    // для оптимизации обновления фона
    bgHueApplied: NaN
  };

  // local best (только вверх)
  const LS_BEST = 'scgame_best';
  let best = Number(localStorage.getItem(LS_BEST) || 0);

  const updateHUD = () => { if (scoreEl) scoreEl.textContent = state.score; };

  // helpers
  const getLevel = (score) => Math.floor(score / 10);

  // hue интерполяция по кратчайшему пути
  function approachHue(current, target, t){
    let dh = (((target - current) % 360) + 540) % 360 - 180; // [-180, 180]
    return current + dh * t;
  }

  // фон: плавный radial-gradient на основе hue
  function applyBackground(h){
    const c1 = `hsl(${(h + 20) % 360} 55% 22%)`;
    const c2 = `hsl(${(h +  0) % 360} 60% 12%)`;
    const c3 = `hsl(${(h - 10) % 360} 70%  7%)`;
    document.body.style.background =
      `radial-gradient(1000px 600px at 20% 10%, ${c1} 0%, ${c2} 50%, ${c3} 100%)`;
    state.bgHueApplied = h;
  }

  // ---------- Entities ----------
  function easeOutBack(t){ const c1=1.70158, c3=c1+1; return 1 + c3*Math.pow(t-1,3) + c1*Math.pow(t-1,2); }

  class Target {
    constructor(x,y,r){ this.x=x; this.y=y; this.R=r; this.r=0; this.scale=0; this.glowT=Math.random()*6.28; }
    update(dt){ this.scale=Math.min(1,this.scale+dt*3); this.r=this.R*easeOutBack(this.scale); this.glowT+=2.1*dt; }
    draw(g){
      const h1 = state.hue;
      const h2 = (h1 + 48) % 360;

      // внешнее свечение
      const glowR = Math.max(this.r*1.25, this.R*1.25);
      const halo = g.createRadialGradient(this.x,this.y,glowR*0.12, this.x,this.y,glowR);
      halo.addColorStop(0, `hsla(${h1} 90% 65% / ${0.35 + 0.15*Math.sin(this.glowT)})`);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = halo;
      g.beginPath(); g.arc(this.x,this.y,glowR,0,Math.PI*2); g.fill();

      // САМА ЦЕЛЬ — НЕОНОВЫЙ КРУГ
      const core = g.createRadialGradient(this.x, this.y, this.r*0.1, this.x, this.y, this.r);
      core.addColorStop(0.0, '#ffffff');
      core.addColorStop(0.55, `hsl(${h2} 95% 70%)`);
      core.addColorStop(1.0, `hsl(${h1} 90% 62%)`);
      g.fillStyle = core;
      g.beginPath(); g.arc(this.x,this.y,this.r,0,Math.PI*2); g.fill();

      // пульсирующее кольцо
      g.lineWidth = 3;
      g.strokeStyle = `hsla(${h1} 100% 70% / ${0.6 + 0.4*Math.sin(this.glowT)})`;
      g.beginPath(); g.arc(this.x,this.y,this.r,0,Math.PI*2); g.stroke();

      // небольшой блик
      g.save();
      g.globalAlpha = 0.25;
      g.beginPath(); g.arc(this.x - this.r*0.35, this.y - this.r*0.35, this.r*0.3, 0, Math.PI*2);
      g.fillStyle = '#fff'; g.fill();
      g.restore();
    }
    hit(px,py){ const dx=px-this.x, dy=py-this.y; return dx*dx + dy*dy <= this.r*this.r; }
  }

  class Particle {
    constructor(x,y){ this.x=x; this.y=y; this.vx=(Math.random()-.5)*320; this.vy=(Math.random()-.5)*320; this.life=1; this.r=2+Math.random()*3; }
    update(dt){ this.x+=this.vx*dt; this.y+=this.vy*dt; this.vy+=420*dt; this.life-=1.25*dt; }
    draw(g){ g.globalAlpha=Math.max(0,this.life); g.beginPath(); g.arc(this.x,this.y,this.r,0,Math.PI*2); g.fillStyle='#fff'; g.fill(); g.globalAlpha=1; }
  }
  const burst = (x,y) => { for (let i=0;i<24;i++) state.particles.push(new Particle(x,y)); };

  // ---------- Spawn / timing ----------
  function spawn(){
    const w = canvas.width/DPR, h = canvas.height/DPR, r = state.fixedRadius;
    state.circle = new Target( r + Math.random()*(w-2*r), r + Math.random()*(h-2*r), r );
  }
  function schedule(){
    // ВАЖНО: используем текущую «жизнь» цели (currentLife), а не базовую
    const life = Math.max(state.minLifetime, state.currentLife ?? state.baseLifetime);
    state.nextDeadline = performance.now() + life;
  }

  // ---------- Input ----------
  canvas.addEventListener('pointerdown', (e) => {
    if (!state.running) return;
    const b = canvas.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;

    if (state.circle?.hit(x,y)) {
      window.SFX?.pop?.(); Haptics.hit(); burst(state.circle.x, state.circle.y);

      // очки
      state.score++;
      updateHUD();

      // плавное ускорение от КАЖДОГО попадания
      state.currentLife = Math.max(state.minLifetime, (state.currentLife ?? state.baseLifetime) * state.lifePerHit);

      // перерасчёт уровня (каждые 10 очков) + ДОП. ступенчатое ускорение
      const newLevel = getLevel(state.score);
      if (newLevel !== state.level) {
        state.level = newLevel;
        // дополнительно сокращаем currentLife на шаг уровня (однократно)
        state.currentLife = Math.max(state.minLifetime, state.currentLife * state.levelLifeFactor);
        // window.SFX?.level?.(); // если нужен звук уровня
      }

      spawn();
      schedule();
    } else {
      window.SFX?.miss?.(); Haptics.miss();
      // штраф по времени — дедлайн приближается
      state.nextDeadline -= 150;
      state.shakeT = .3;
    }
  }, { passive:true });

  // ---------- Loop ----------
  function loop(t){
    const now = t || performance.now();
    const dt  = Math.min(.033, (now - state.lastTime)/1000);
    state.lastTime = now;

    // Плавная смена палитры (уровни → hue-ступеньки, но с мягкой интерполяцией)
    const targetHue = (state.baseHue + state.level * state.hueStep) % 360;
    state.hue = approachHue(state.hue, targetHue, 1 - Math.exp(-dt * 3));

    // Таймер под текущую палитру
    if (timerFill) {
      const h1 = state.hue, h2 = (h1 + 48) % 360;
      timerFill.style.background = `linear-gradient(90deg, hsl(${h1} 90% 60%), hsl(${h2} 90% 65%))`;
    }

    // Фон: обновляем только при заметном изменении hue (экономим перерисовку)
    if (!Number.isFinite(state.bgHueApplied) || Math.abs(state.hue - state.bgHueApplied) > 0.5) {
      applyBackground(state.hue);
    }

    ctx.clearRect(0,0,canvas.width,canvas.height);

    if (state.running) {
      state.circle?.update(dt);
      state.circle?.draw(ctx);

      for (let i=state.particles.length-1; i>=0; i--){
        const p = state.particles[i]; p.update(dt); p.draw(ctx);
        if (p.life <= 0) state.particles.splice(i,1);
      }

      // таймер
      const ttl = Math.max(0, state.nextDeadline - now);
      const denom = Math.max(state.minLifetime, state.currentLife ?? state.baseLifetime);
      const k = Math.max(0, Math.min(1, ttl / denom));
      if (timerFill) timerFill.style.transform = `scaleX(${k})`;

      if (ttl <= 0) endGame();

      // шейк при промахе
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

  // ---------- Start / End / Menu ----------
  function startGame(){
    overlay?.classList.add('overlay--closed');   // спрятать sheet
    hide(gameover);

    state.running = true;
    state.score = 0;
    state.level = 0;
    state.particles.length = 0;
    state.shakeT = 0;
    state.hue = state.baseHue; // сброс палитры на стартовую
    state.bgHueApplied = NaN;  // форс-обновление фона на старте

    // стартовая «жизнь» для плавного ускорения
    state.currentLife = state.baseLifetime;

    // === сброс мелодии ===
    window.SFX?.resetMelody?.();

    // фон стартового уровня
    applyBackground(state.hue);

    spawn();
    schedule();
    updateHUD();

    // звук/хаптика
    window.SFX?.start?.();
    Haptics.start();
  }

  function endGame(){
    state.running = false;

    // локальный best — только вверх
    try { if (state.score > Number(localStorage.getItem(LS_BEST) || 0)) localStorage.setItem(LS_BEST, String(state.score)); } catch {}

    if (finalScoreEl) finalScoreEl.textContent = state.score;
    show(gameover);
    window.SFX?.fail?.(); Haptics.over();

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

    overlay?.classList.remove('overlay--closed'); // показать sheet
    hide(gameover);
  }

  // ---------- Share / Invite ----------
  function share(){
    const shareText = `Мой счёт: ${state.score} в SC Tap!`;
    const shareUrl = location.href.split('?')[0];
    try {
      // eslint-disable-next-line no-undef
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
  const esc = (s)=>String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
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
          <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
          <div style="margin-left:8px;white-space:nowrap">🏆 ${row.score}</div>
        </div>`;
      }).join('') || '<div style="opacity:.7;padding:8px">Пока пусто</div>');

    } catch (err) {
      leadersList.innerHTML = '<div style="opacity:.75;padding:8px">Не удалось загрузить рейтинг</div>';
    }
  }
  const openTop = ()=>{ show(leaders); loadLeaders(20); };
  const closeTop = ()=> hide(leaders);

  // ---------- Bindings ----------
  btnStart   ?.addEventListener('click', startGame);
  btnInvite  ?.addEventListener('click', share);
  btnHow     ?.addEventListener('click', ()=> show(howModal));
  btnOk      ?.addEventListener('click', ()=> hide(howModal));
  btnX       ?.addEventListener('click', ()=> hide(howModal));

  btnAgain   ?.addEventListener('click', ()=>{
    window.SFX?.resetMelody?.();
    hide(gameover);
    startGame();
  });

  btnShare   ?.addEventListener('click', share);
  btnMenu    ?.addEventListener('click', openMainMenu);

  btnTop     ?.addEventListener('click', openTop);
  btnCloseTop?.addEventListener('click', closeTop);
  leaders    ?.addEventListener('click', (e)=>{ if (e.target === leaders) closeTop(); });
  addEventListener('keydown', (e)=>{ if (e.key === 'Escape') { hide(howModal); closeTop(); } });

  // ---------- Send score on leave ----------
  addEventListener('pagehide', ()=>{
    if (!token) return;
    try {
      const payload = JSON.stringify({ token, score: state.score || 0 });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/score', new Blob([payload], { type:'application/json' }));
      } else {
        fetch('/api/score', { method:'POST', headers:{'Content-Type':'application/json'}, body: payload, keepalive:true }).catch(()=>{});
      }
    } catch {}
  });
})();
