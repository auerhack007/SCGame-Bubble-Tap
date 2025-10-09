// server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Telegraf, Markup } = require('telegraf');

// ── ENV ───────────────────────────────────────────────────────────────────────
const BOT_TOKEN       = process.env.BOT_TOKEN;
const GAME_SHORT_NAME = process.env.GAME_SHORT_NAME || 'scgame';
const GAME_URL        = process.env.GAME_URL || 'http://localhost:3000';
const JWT_SECRET      = process.env.JWT_SECRET || 'dev-secret';
const PORT            = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');

// ── INIT ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPERS ───────────────────────────────────────────────────────────────────
function makeJwtPayloadFromQuery(ctx) {
  const q = ctx.callbackQuery;
  const payload = { user_id: ctx.from.id };
  if (q.inline_message_id) payload.inline_message_id = q.inline_message_id;
  else if (q.message) {
    payload.chat_id = q.message.chat.id;
    payload.message_id = q.message.message_id;
  }
  return payload;
}

// ── BOT HANDLERS ─────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  await ctx.replyWithGame(GAME_SHORT_NAME, {
    reply_markup: Markup.inlineKeyboard([[Markup.button.game('▶️ Играть')]]),
  });
});
bot.command('play', async (ctx) => {
  await ctx.replyWithGame(GAME_SHORT_NAME, {
    reply_markup: Markup.inlineKeyboard([[Markup.button.game('▶️ Играть')]]),
  });
});

bot.on('callback_query', async (ctx) => {
  const q = ctx.callbackQuery;
  if (q.game_short_name !== GAME_SHORT_NAME) {
    try { await ctx.answerCbQuery(); } catch(_) {}
    return;
  }

  const payload = makeJwtPayloadFromQuery(ctx);
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' });
  const launchUrl = `${GAME_URL}/index.html?token=${encodeURIComponent(token)}`;

  try {
    await ctx.answerGameQuery(launchUrl);
  } catch (err) {
    console.warn('answerGameQuery failed:', err?.description || err);
    try {
      await ctx.replyWithGame(GAME_SHORT_NAME, {
        reply_markup: Markup.inlineKeyboard([[Markup.button.game('▶️ Играть')]]),
      });
    } catch (e2) {
      console.error('replyWithGame fallback failed:', e2);
      try { await ctx.answerCbQuery('Нажмите кнопку ещё раз'); } catch (_) {}
    }
  }
});

// ── SCORE (force:false — не понижаем рекорд) ─────────────────────────────────
app.post('/api/score', async (req, res) => {
  try {
    const { token, score } = req.body;
    if (typeof token !== 'string' || typeof score !== 'number') {
      return res.status(400).json({ ok: false, error: 'Bad payload' });
    }

    let data;
    try { data = jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).json({ ok: false, error: 'Bad token' }); }

    const apiPayload = {
      user_id: data.user_id,
      score: Math.max(0, Math.floor(score)),
      force: false,                // ВАЖНО: не понижаем рекорд
      disable_edit_message: false,
    };

    if (data.inline_message_id) apiPayload.inline_message_id = data.inline_message_id;
    else if (data.chat_id && data.message_id) {
      apiPayload.chat_id = data.chat_id;
      apiPayload.message_id = data.message_id;
    } else {
      return res.status(400).json({ ok: false, error: 'No message context' });
    }

    const result = await bot.telegram.callApi('setGameScore', apiPayload);
    res.json({ ok: true, result });
  } catch (e) {
    console.error('setGameScore error', e);
    res.status(500).json({ ok: false, error: 'setGameScore failed' });
  }
});

// ── HIGHSCORES ────────────────────────────────────────────────────────────────
app.get('/api/highscores', async (req, res) => {
  try {
    const { token } = req.query;
    if (typeof token !== 'string') return res.status(400).json({ ok: false, error: 'No token' });

    let data;
    try { data = jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).json({ ok: false, error: 'Bad token' }); }

    const apiPayload = { user_id: data.user_id };
    if (data.inline_message_id) apiPayload.inline_message_id = data.inline_message_id;
    else if (data.chat_id && data.message_id) {
      apiPayload.chat_id = data.chat_id;
      apiPayload.message_id = data.message_id;
    } else {
      return res.status(400).json({ ok: false, error: 'No message context' });
    }

    const table = await bot.telegram.callApi('getGameHighScores', apiPayload);
    res.json({ ok: true, result: table });
  } catch (e) {
    console.error('getGameHighScores error', e);
    res.status(500).json({ ok: false, error: 'getGameHighScores failed' });
  }
});

// ── AVATAR PROXY (TG → same-origin для canvas) ───────────────────────────────
const avatarCache = new Map();
const AVATAR_TTL_MS = 12 * 60 * 60 * 1000; // 12h

app.get('/api/me-avatar', async (req, res) => {
  try {
    const { token } = req.query;
    if (typeof token !== 'string') return res.status(400).send('No token');

    let data;
    try { data = jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).send('Bad token'); }

    const userId = data.user_id;
    if (!userId) return res.status(400).send('No user');

    const now = Date.now();
    const cached = avatarCache.get(userId);
    if (cached && (now - cached.ts) < AVATAR_TTL_MS) {
      res.set('Cache-Control', 'public, max-age=43200');
      res.set('Content-Type', cached.contentType || 'image/jpeg');
      return res.send(cached.buffer);
    }

    const photos = await bot.telegram.getUserProfilePhotos(userId, { limit: 1 });
    if (!photos.total_count || !photos.photos?.length) return res.redirect('/img/head.png');

    const best = photos.photos[0].at(-1);
    const file = await bot.telegram.callApi('getFile', { file_id: best.file_id });
    if (!file.file_path) return res.redirect('/img/head.png');

    const tgUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const r = await fetch(tgUrl);
    if (!r.ok) throw new Error('fetch tg file failed');

    const buf = Buffer.from(await r.arrayBuffer());
    const ctype = r.headers.get('content-type') || 'image/jpeg';
    avatarCache.set(userId, { buffer: buf, contentType: ctype, ts: now });

    res.set('Cache-Control', 'public, max-age=43200');
    res.set('Content-Type', ctype);
    res.send(buf);
  } catch (e) {
    console.error('avatar error', e);
    res.redirect('/img/head.png');
  }
});

// ── MISC ─────────────────────────────────────────────────────────────────────
app.get('/api/ping', (_req, res) => res.json({ ok: true }));

// ── START ────────────────────────────────────────────────────────────────────
bot.launch();
app.listen(PORT, () => {
  console.log(`HTTP server running: http://localhost:${PORT}`);
  console.log(`Game URL for Telegram: ${GAME_URL}/index.html`);
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
