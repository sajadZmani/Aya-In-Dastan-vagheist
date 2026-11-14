'use strict';
/*
 * «آیا این داستان واقعیست؟» — server.
 * The server owns every room's state and runs all the timers; clients only send actions
 * and draw whatever state they receive. Rooms live in memory (no database).
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { normalize, compact, isCloseTo, hasBadWord } = require('./lib/text');
// Reads .env (QUESTIONS_KEY, PORT) without extra packages.
try {
  for (const line of require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch (e) { /* no .env: use real environment variables */ }
const QUESTIONS = require('./lib/questions');

const PORT = process.env.PORT || 3000;
const WRITE_SECONDS = Number(process.env.WRITE_SECONDS) || 60;
const CHOOSE_SECONDS = Number(process.env.CHOOSE_SECONDS) || 30;
const REVEAL_STEP_SECONDS = Number(process.env.REVEAL_STEP_SECONDS) || 4.5;
const SCORES_SECONDS = Number(process.env.SCORES_SECONDS) || 9;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const EMPTY_ROOM_TTL = 5 * 60 * 1000;   // a room with nobody connected is removed after this
const LOBBY_DROP_MS = 45 * 1000;        // a player who leaves the lobby is removed after this
const POINTS_TRUTH = 1000;
const POINTS_FOOLED = 500;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';  // no I/O, they look like 1/0

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });

const rooms = new Map();

// ---------- helpers ----------
const shuffle = arr => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function newCode() {
  let code;
  do code = Array.from({ length: 4 }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join('');
  while (rooms.has(code));
  return code;
}

const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16);
const cleanText = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40);
const connected = room => [...room.players.values()].filter(p => p.connected);

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function setPhase(room, phase, seconds, next) {
  clearTimer(room);
  room.phase = phase;
  room.deadline = seconds ? Date.now() + seconds * 1000 : null;
  if (seconds) room.timer = setTimeout(next, seconds * 1000);
  broadcast(room);
}

// ---------- state sent to clients ----------
function publicState(room, forId) {
  const me = room.players.get(forId);
  const r = room.round;
  const s = {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    settings: room.settings,
    roundNo: room.roundNo,
    totalRounds: room.settings.rounds,
    double: room.roundNo === room.settings.rounds,
    deadline: room.deadline,
    now: Date.now(),
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected,
      done: r ? (room.phase === 'write' ? !!r.lies[p.id] : room.phase === 'choose' ? !!r.picks[p.id] : false) : false,
    })),
    me: me ? { id: me.id, name: me.name } : null,
  };
  if (r) {
    s.question = r.q.question;
    if (room.phase === 'write') s.myLie = r.lies[forId] ? r.lies[forId].text : null;
    if (room.phase === 'choose') {
      s.options = r.options.map(o => ({ id: o.id, text: o.text, mine: o.authors.includes(forId) }));
      s.myPick = r.picks[forId] || null;
    }
    if (room.phase === 'reveal' || room.phase === 'scores' || room.phase === 'end') {
      s.reveal = r.reveal;
      s.gains = r.gains;
      s.answer = r.q.answer;
    }
  }
  return s;
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', publicState(room, p.id));
  }
}

// ---------- game flow ----------
function pickQuestion(room) {
  let pool = QUESTIONS.filter(q => !room.used.has(q.id));
  if (!pool.length) { room.used.clear(); pool = QUESTIONS.slice(); }
  const q = pool[crypto.randomInt(pool.length)];
  room.used.add(q.id);
  return q;
}

function startGame(room) {
  for (const p of room.players.values()) p.score = 0;
  room.roundNo = 0;
  nextRound(room);
}

function nextRound(room) {
  room.roundNo += 1;
  room.round = { q: pickQuestion(room), lies: {}, picks: {}, options: [], reveal: [], gains: {} };
  setPhase(room, 'write', WRITE_SECONDS, () => endWriting(room));
}

function endWriting(room) {
  const r = room.round;
  // Anyone who wrote nothing gets one of the ready-made lies.
  const spare = shuffle(r.q.lies.filter(l => !Object.values(r.lies).some(x => compact(x.text) === compact(l))));
  for (const p of room.players.values()) {
    if (!r.lies[p.id] && spare.length) r.lies[p.id] = { text: spare.pop(), auto: true };
  }
  // Same lies from different players become one option with several authors.
  const byKey = new Map();
  for (const [pid, lie] of Object.entries(r.lies)) {
    const key = compact(lie.text);
    if (!byKey.has(key)) byKey.set(key, { id: 'o' + byKey.size, text: lie.text, authors: [], truth: false });
    byKey.get(key).authors.push(pid);
  }
  const lies = [...byKey.values()];
  // With very few lies, add ready-made ones so there is something to choose from.
  for (const l of r.q.lies) {
    if (lies.length >= 2) break;
    if (!byKey.has(compact(l))) lies.push({ id: 'o' + lies.length + 'h', text: l, authors: [], truth: false });
  }
  r.options = shuffle([...lies, { id: 'truth', text: r.q.answer, authors: [], truth: true }]);
  setPhase(room, 'choose', CHOOSE_SECONDS, () => endChoosing(room));
}

function endChoosing(room) {
  const r = room.round;
  const mult = room.roundNo === room.settings.rounds ? 2 : 1;
  const gains = {};
  const add = (pid, n) => { gains[pid] = (gains[pid] || 0) + n; };
  const pickersOf = id => Object.keys(r.picks).filter(pid => r.picks[pid] === id);
  const name = pid => (room.players.get(pid) || { name: '؟' }).name;

  const steps = [];
  for (const o of r.options) {
    if (o.truth) continue;
    const pickers = pickersOf(o.id);
    for (const a of o.authors) for (let i = 0; i < pickers.length; i++) add(a, POINTS_FOOLED * mult);
    // Lies nobody fell for are skipped, unless nobody fell for anything.
    if (pickers.length) steps.push({ text: o.text, truth: false, authors: o.authors.map(name), house: !o.authors.length, pickers: pickers.map(name), points: pickers.length * POINTS_FOOLED * mult });
  }
  const finders = pickersOf('truth');
  finders.forEach(pid => add(pid, POINTS_TRUTH * mult));
  const ordered = shuffle(steps);
  ordered.push({ text: r.q.answer, truth: true, authors: [], pickers: finders.map(name), points: POINTS_TRUTH * mult });

  for (const [pid, n] of Object.entries(gains)) {
    const p = room.players.get(pid);
    if (p) p.score += n;
  }
  r.reveal = ordered;
  r.gains = gains;
  setPhase(room, 'reveal', Math.ceil(ordered.length * REVEAL_STEP_SECONDS + 1.5), () => showScores(room));
}

function showScores(room) {
  if (room.roundNo >= room.settings.rounds) return setPhase(room, 'end', 0);
  setPhase(room, 'scores', SCORES_SECONDS, () => nextRound(room));
}

// Move on early when every connected player is done.
function checkAllDone(room) {
  const r = room.round, on = connected(room);
  if (!r || !on.length) return;
  if (room.phase === 'write' && on.every(p => r.lies[p.id])) endWriting(room);
  else if (room.phase === 'choose' && on.every(p => r.picks[p.id])) endChoosing(room);
}

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected) return;
  const next = connected(room)[0];
  if (next) room.hostId = next.id;
}

function scheduleRoomCleanup(room) {
  if (room.cleanup) clearTimeout(room.cleanup);
  room.cleanup = null;
  if (connected(room).length) return;
  room.cleanup = setTimeout(() => {
    if (connected(room).length) return;
    clearTimer(room);
    rooms.delete(room.code);
  }, EMPTY_ROOM_TTL);
}

// ---------- sockets ----------
io.on('connection', socket => {
  let room = null, player = null;
  const fail = msg => socket.emit('problem', msg);
  const isHost = () => room && player && room.hostId === player.id;

  function attach(r, p) {
    room = r; player = p;
    p.connected = true;
    p.socketId = socket.id;
    if (p.dropTimer) { clearTimeout(p.dropTimer); p.dropTimer = null; }
    ensureHost(r);
    scheduleRoomCleanup(r);
    broadcast(r);
  }

  socket.on('create', ({ playerId, name } = {}) => {
    name = cleanName(name);
    if (!name) return fail('اسمت رو بنویس.');
    if (hasBadWord(name)) return fail('این اسم مناسب نیست. یه اسم دیگه انتخاب کن 🙂');
    if (typeof playerId !== 'string' || playerId.length > 64) return fail('شناسه نامعتبره.');
    const code = newCode();
    const r = { code, hostId: playerId, players: new Map(), settings: { rounds: 7 }, phase: 'lobby', roundNo: 0, round: null, used: new Set(), timer: null, deadline: null };
    rooms.set(code, r);
    r.players.set(playerId, { id: playerId, name, score: 0, connected: false });
    attach(r, r.players.get(playerId));
  });

  socket.on('join', ({ playerId, name, code } = {}) => {
    code = String(code || '').trim().toUpperCase();
    const r = rooms.get(code);
    if (!r) return fail('اتاقی با این کد پیدا نشد.');
    if (typeof playerId !== 'string' || playerId.length > 64) return fail('شناسه نامعتبره.');
    const existing = r.players.get(playerId);
    if (existing) return attach(r, existing);               // back after refresh / reconnect
    name = cleanName(name);
    if (!name) return fail('اسمت رو بنویس.');
    if (hasBadWord(name)) return fail('این اسم مناسب نیست. یه اسم دیگه انتخاب کن 🙂');
    if (r.phase !== 'lobby') return fail('این بازی شروع شده. صبر کن دور بعد تموم بشه.');
    if (r.players.size >= MAX_PLAYERS) return fail('اتاق پره (حداکثر ۱۰ نفر).');
    if ([...r.players.values()].some(p => normalize(p.name) === normalize(name))) return fail('این اسم توی اتاق هست. یه اسم دیگه بزن.');
    r.players.set(playerId, { id: playerId, name, score: 0, connected: false });
    attach(r, r.players.get(playerId));
  });

  socket.on('resume', ({ playerId, code } = {}) => {
    const r = rooms.get(String(code || '').toUpperCase());
    const p = r && r.players.get(playerId);
    if (!p) return socket.emit('gone');
    attach(r, p);
  });

  socket.on('settings', ({ rounds } = {}) => {
    if (!isHost() || room.phase !== 'lobby') return;
    rounds = parseInt(rounds, 10);
    if (rounds >= 3 && rounds <= 15) room.settings.rounds = rounds;
    broadcast(room);
  });

  socket.on('start', () => {
    if (!isHost() || !['lobby', 'end'].includes(room.phase)) return;
    if (connected(room).length < MIN_PLAYERS) return fail('حداقل ۳ نفر لازمه.');
    // Players who left during the last game are dropped before a new one.
    for (const p of [...room.players.values()]) if (!p.connected) room.players.delete(p.id);
    startGame(room);
  });

  socket.on('again', () => {
    if (!isHost() || room.phase !== 'end') return;
    for (const p of [...room.players.values()]) { p.score = 0; if (!p.connected) room.players.delete(p.id); }
    room.round = null; room.roundNo = 0;
    setPhase(room, 'lobby', 0);
  });

  socket.on('skip', () => {
    if (!isHost()) return;
    if (room.phase === 'reveal') showScores(room);
    else if (room.phase === 'scores') nextRound(room);
  });

  socket.on('lie', (text, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    if (!room || room.phase !== 'write') return ack({ ok: false, msg: 'وقت نوشتن تموم شده.' });
    text = cleanText(text);
    if (!text) return ack({ ok: false, msg: 'یه چیزی بنویس!' });
    if (hasBadWord(text)) return ack({ ok: false, msg: 'کلمه‌ی بد ممنوعه! یه دروغ مؤدبانه بنویس 😇' });
    if (isCloseTo(text, room.round.q.answer)) return ack({ ok: false, msg: 'این جواب درسته! یه دروغ دیگه بنویس 🤫' });
    room.round.lies[player.id] = { text, auto: false };
    ack({ ok: true });
    broadcast(room);
    checkAllDone(room);
  });

  socket.on('pick', (optionId, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    if (!room || room.phase !== 'choose') return ack({ ok: false });
    const o = room.round.options.find(x => x.id === optionId);
    if (!o) return ack({ ok: false });
    if (o.authors.includes(player.id)) return ack({ ok: false, msg: 'این دروغ خودته! 😄' });
    room.round.picks[player.id] = optionId;
    ack({ ok: true });
    broadcast(room);
    checkAllDone(room);
  });

  socket.on('leave', () => {
    if (!room) return;
    const r = room, p = player;
    room = null; player = null;
    if (r.phase === 'lobby' || r.phase === 'end') r.players.delete(p.id); else p.connected = false;
    ensureHost(r);
    scheduleRoomCleanup(r);
    broadcast(r);
    checkAllDone(r);
  });

  socket.on('disconnect', () => {
    if (!room || !player || player.socketId !== socket.id) return;
    const r = room, p = player;
    p.connected = false;
    if (r.phase === 'lobby') {
      p.dropTimer = setTimeout(() => {
        if (!p.connected && r.phase === 'lobby') { r.players.delete(p.id); ensureHost(r); broadcast(r); }
      }, LOBBY_DROP_MS);
    }
    ensureHost(r);
    scheduleRoomCleanup(r);
    broadcast(r);
    checkAllDone(r);
  });
});

server.listen(PORT, () => {
  console.log(`«آیا این داستان واقعیست؟» روی http://localhost:${PORT} اجرا شد`);
});
