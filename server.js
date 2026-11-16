'use strict';
/*
 * «آیا این داستان واقعیست؟» — server for online rooms (one phone per player).
 * The server owns every room's state and runs all the timers; clients only send actions and draw
 * the state they receive. Rooms live in memory (no database). The rules themselves (lies, options,
 * scoring, the reveal) are in public/core.js, which the offline one-phone game uses too.
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const core = require('./public/core.js');

const BANK = core.buildBank(require('./data/bank.json'));
const hasBadWord = core.badWordChecker(require('./data/blocklist.json'));

const PORT = process.env.PORT || 3000;
const SCORES_SECONDS = Number(process.env.SCORES_SECONDS) || 9;
const MIN_PLAYERS = 2;
const EMPTY_ROOM_TTL = 5 * 60 * 1000;   // a room with nobody connected is removed after this
const LOBBY_DROP_MS = 45 * 1000;        // a player who leaves the lobby is removed after this
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';  // no I/O, they look like 1/0
const DEFAULT_SETTINGS = { mode: 'word', rounds: 7, writeSec: 60, chooseSec: 30, maxPlayers: 10 };
const LIMITS = { rounds: [1, 30], writeSec: [15, 300], chooseSec: [10, 180], maxPlayers: [2, 50] };

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// The bank and the hashed bad-word list, for the offline one-phone game.
app.use('/data', express.static(path.join(__dirname, 'data')));
app.get('/health', (_req, res) => res.send('ok'));
const server = http.createServer(app);
// Patient pings: phones on slow or patchy mobile data should not be dropped every few seconds.
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000 });

const rooms = new Map();

// ---------- helpers ----------
function newCode() {
  let code;
  do code = Array.from({ length: 4 }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join('');
  while (rooms.has(code));
  return code;
}

const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16);
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

function broadcast(room) {
  for (const p of room.players.values()) {
    if (!p.connected || !p.socketId) continue;
    io.to(p.socketId).emit('state', { ...core.viewState(room, p.id), code: room.code, now: Date.now() });
  }
}

// ---------- game flow ----------
function startGame(room) {
  for (const p of room.players.values()) p.score = 0;
  room.roundNo = 0;
  nextRound(room);
}

function nextRound(room) {
  core.newRound(room, BANK);
  setPhase(room, 'write', room.settings.writeSec, () => endWriting(room));
}

function endWriting(room) {
  core.finishWriting(room);
  setPhase(room, 'choose', room.settings.chooseSec, () => endChoosing(room));
}

function endChoosing(room) {
  const seconds = core.finishChoosing(room);
  setPhase(room, 'reveal', seconds, () => showScores(room));
}

function showScores(room) {
  if (room.roundNo >= room.settings.rounds) return setPhase(room, 'end', 0);
  setPhase(room, 'scores', SCORES_SECONDS, () => nextRound(room));
}

// Back to the lobby with the same players, scores cleared (used by «بازی دوباره» and «شروع دوباره»).
function backToLobby(room) {
  for (const p of [...room.players.values()]) { p.score = 0; if (!p.connected) room.players.delete(p.id); }
  room.round = null; room.roundNo = 0;
  setPhase(room, 'lobby', 0);
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
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 64;

  function attach(r, p) {
    room = r; player = p;
    p.connected = true;
    p.socketId = socket.id;
    if (p.dropTimer) { clearTimeout(p.dropTimer); p.dropTimer = null; }
    ensureHost(r);
    scheduleRoomCleanup(r);
    broadcast(r);
  }

  function nameProblem(r, name) {
    if (!name) return 'اسمت رو بنویس.';
    if (hasBadWord(name)) return 'این اسم مناسب نیست. یه اسم دیگه انتخاب کن 🙂';
    if (r && [...r.players.values()].some(p => core.normalize(p.name) === core.normalize(name))) return 'این اسم توی اتاق هست. یه اسم دیگه بزن.';
    return null;
  }

  socket.on('create', ({ playerId, name } = {}) => {
    name = cleanName(name);
    const problem = nameProblem(null, name);
    if (problem) return fail(problem);
    if (!validId(playerId)) return fail('شناسه نامعتبره.');
    const code = newCode();
    const r = { code, hostId: playerId, players: new Map(), settings: { ...DEFAULT_SETTINGS }, phase: 'lobby',
      roundNo: 0, round: null, used: { word: new Set(), story: new Set() }, timer: null, deadline: null };
    rooms.set(code, r);
    r.players.set(playerId, { id: playerId, name, score: 0, connected: false });
    attach(r, r.players.get(playerId));
  });

  socket.on('join', ({ playerId, name, code } = {}) => {
    const r = rooms.get(String(code || '').trim().toUpperCase());
    if (!r) return fail('اتاقی با این کد پیدا نشد.');
    if (!validId(playerId)) return fail('شناسه نامعتبره.');
    const existing = r.players.get(playerId);
    if (existing) return attach(r, existing);               // back after refresh / reconnect
    name = cleanName(name);
    const problem = nameProblem(r, name);
    if (problem) return fail(problem);
    if (r.phase !== 'lobby') return fail('این بازی شروع شده. صبر کن دور بعد تموم بشه.');
    if (r.players.size >= r.settings.maxPlayers) return fail(`اتاق پره (حداکثر ${r.settings.maxPlayers} نفر).`);
    r.players.set(playerId, { id: playerId, name, score: 0, connected: false });
    attach(r, r.players.get(playerId));
  });

  socket.on('resume', ({ playerId, code } = {}) => {
    const r = rooms.get(String(code || '').toUpperCase());
    const p = r && r.players.get(playerId);
    if (!p) return socket.emit('gone');
    attach(r, p);
  });

  socket.on('settings', (patch = {}) => {
    if (!isHost() || room.phase !== 'lobby') return;
    if (patch.mode === 'word' || patch.mode === 'story') room.settings.mode = patch.mode;
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      const v = parseInt(patch[k], 10);
      if (v >= lo && v <= hi) room.settings[k] = v;
    }
    if (room.settings.maxPlayers < room.players.size) room.settings.maxPlayers = room.players.size;
    broadcast(room);
  });

  socket.on('start', () => {
    if (!isHost() || !['lobby', 'end'].includes(room.phase)) return;
    if (connected(room).length < MIN_PLAYERS) return fail('حداقل ۲ نفر لازمه.');
    for (const p of [...room.players.values()]) if (!p.connected) room.players.delete(p.id);
    startGame(room);
  });

  socket.on('again', () => {
    if (isHost() && room.phase === 'end') backToLobby(room);
  });

  // «شروع دوباره» in the middle of a game: the host stops it and everyone goes back to the lobby.
  socket.on('restart', () => {
    if (isHost() && room.phase !== 'lobby') backToLobby(room);
  });

  socket.on('skip', () => {
    if (!isHost()) return;
    if (room.phase === 'reveal') showScores(room);
    else if (room.phase === 'scores') nextRound(room);
  });

  socket.on('lie', (text, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    if (!room || !player || room.phase !== 'write') return ack({ ok: false, msg: 'وقت نوشتن تموم شده.' });
    const raw = String(text || '');
    const problem = core.lieProblem(room, raw.trim(), hasBadWord);
    if (problem) return ack({ ok: false, msg: problem });
    const clean = core.cleanLie(room, raw);
    if (!clean) return ack({ ok: false, msg: 'یه چیزی بنویس!' });
    room.round.lies[player.id] = { text: clean, auto: false };
    ack({ ok: true });
    broadcast(room);
    checkAllDone(room);
  });

  socket.on('pick', (optionId, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    if (!room || !player || room.phase !== 'choose') return ack({ ok: false });
    const o = room.round.options.find(x => x.id === optionId);
    if (!o) return ack({ ok: false });
    if (o.authors.includes(player.id)) return ack({ ok: false, msg: 'این دروغ خودته! 😄' });
    room.round.picks[player.id] = optionId;
    ack({ ok: true });
    broadcast(room);
    checkAllDone(room);
  });

  socket.on('leave', () => {
    if (!room || !player) return;
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
