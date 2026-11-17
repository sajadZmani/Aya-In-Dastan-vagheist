/*
 * «آیا این داستان واقعیست؟» — client.
 * Each round every player writes one sentence about anything and secretly marks it true or false;
 * the others vote true/false on every sentence; each wrong vote is a point for the writer.
 * Online rooms: draws the state the server sends; the server decides everything.
 * One-phone game: runs entirely on this phone (the Offline engine below, with the same rules from
 * core.js), so it works without internet once the site has been opened once.
 */
'use strict';

const $app = document.getElementById('app');
// socket.io's script doesn't load without internet; then only the one-phone game is available.
// Starts with HTTP polling and upgrades to WebSocket when the network allows it, so networks
// that block or break WebSocket still work.
const socket = window.io ? io({ reconnectionDelay: 500, reconnectionDelayMax: 3000, timeout: 15000 }) : null;
const netbar = document.getElementById('netbar');
const fa = n => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#3b82f6', '#ef4444', '#14b8a6', '#f97316', '#a855f7', '#0ea5e9'];
const REVEAL_STEP = AyaCore.REVEAL_STEP_SECONDS * 1000;
const MAX_LEN = 160;

// ---------- storage (wrapped: private windows can throw) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
let playerId = store.get('ayaa.id');
if (!playerId) {
  playerId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  store.set('ayaa.id', playerId);
}

let state = null;       // last state (from the server, or from the offline game)
let clockOffset = 0;    // server time - local time
let lastKey = '';
let showRules = false;
let confettiDone = false;
let editing = false;    // «عوضش کن» pressed after a sentence was sent
let draft = { text: '', truth: null };   // the sentence being written
let voteDraft = {};     // votes being chosen: { sentenceId: true/false }
// One-phone game: the setup form before it starts, and who confirmed they're holding the phone.
let setup = null;       // { names: [...], rounds }
let gate = null;        // id of the player who tapped «منم» for this turn
let showMenu = false;   // the «⋯» menu during a game (leave / restart)

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- offline one-phone game ----------
// The whole game on this phone: the players are names typed in at the start, the phone is passed
// around, and there are no timers for writing and voting. Saved after every step, so a refresh
// or a closed tab carries on where it was.
const Offline = (() => {
  let hasBadWord = null, room = null, timer = null;
  const SCORES_SECONDS = 9;

  async function load() {
    if (hasBadWord) return;
    const res = await fetch('/data/blocklist.json');
    if (!res.ok) throw new Error('blocklist');
    hasBadWord = AyaCore.badWordChecker(await res.json());
  }

  function save() {
    if (!room) return store.del('ayaa.offline');
    store.set('ayaa.offline', JSON.stringify({ ...room, players: [...room.players.values()] }));
  }

  // Whose turn it is to write or vote: the first player in order who hasn't yet.
  function turn() {
    const r = room.round;
    const list = [...room.players.values()];
    if (room.phase === 'write') return list.find(p => !r.statements[p.id]) || null;
    if (room.phase === 'vote') return list.find(p => !r.votes[p.id] || !AyaCore.votedAll(room, p.id)) || null;
    return null;
  }

  function push() {
    save();
    const t = turn();
    const s = AyaCore.viewState(room, t ? t.id : null);
    s.offline = true; s.local = true;
    s.me = { id: 'me', name: '' };
    s.turn = t ? { id: t.id, name: t.name } : null;
    s.now = Date.now();
    applyState(s);
  }

  function setPhase(phase, seconds) {
    clearTimeout(timer);
    room.phase = phase;
    room.deadline = seconds ? Date.now() + seconds * 1000 : null;
    schedule();
    push();
  }

  // Timers only run between rounds (reveal, scores); after a refresh they pick up where they were.
  function schedule() {
    clearTimeout(timer);
    if (!room.deadline) return;
    const next = room.phase === 'reveal' ? showScores : room.phase === 'scores' ? nextRound : null;
    if (next) timer = setTimeout(next, Math.max(0, room.deadline - Date.now()));
  }

  function nextRound() { AyaCore.newRound(room); setPhase('write', 0); }
  function showScores() {
    if (room.roundNo >= room.settings.rounds) return setPhase('end', 0);
    setPhase('scores', SCORES_SECONDS);
  }

  async function start(names, settings) {
    await load();
    room = {
      players: new Map(names.map((name, i) => ['p' + i, { id: 'p' + i, name, score: 0 }])),
      settings: { rounds: settings.rounds },
      hostId: 'me', phase: 'write', roundNo: 0, round: null, deadline: null,
    };
    nextRound();
  }

  async function restore() {
    let saved = null;
    try { saved = JSON.parse(store.get('ayaa.offline') || 'null'); } catch (e) {}
    if (!saved || !saved.round || !saved.round.statements) return false;   // nothing, or a game of the old kind
    await load();
    room = { ...saved, players: new Map(saved.players.map(p => [p.id, p])) };
    schedule();
    push();
    return true;
  }

  function quit() { clearTimeout(timer); room = null; save(); }

  // The same actions the server takes from a socket.
  function handle(event, payload, ack) {
    ack = ack || (() => {});
    if (!room) return ack({ ok: false });
    const t = turn();
    if (event === 'statement' && room.phase === 'write' && t) {
      const { text, truth } = payload || {};
      if (typeof truth !== 'boolean') return ack({ ok: false, msg: 'بگو این جمله راسته یا دروغ ✅❌' });
      const clean = AyaCore.cleanStatement(text);
      const problem = AyaCore.statementProblem(clean, hasBadWord);
      if (problem) return ack({ ok: false, msg: problem });
      room.round.statements[t.id] = { text: clean, truth };
      ack({ ok: true });
      if (turn()) return push();
      AyaCore.finishWriting(room);
      setPhase('vote', 0);
    } else if (event === 'votes' && room.phase === 'vote' && t) {
      room.round.votes[t.id] = AyaCore.cleanVotes(room, t.id, payload);
      if (!AyaCore.votedAll(room, t.id)) return ack({ ok: false, msg: 'به همه‌ی جمله‌ها رأی بده 🙂' });
      ack({ ok: true });
      if (turn()) return push();
      setPhase('reveal', AyaCore.finishVoting(room));
    } else if (event === 'skip') {
      if (room.phase === 'reveal') showScores(); else if (room.phase === 'scores') nextRound();
    } else if (event === 'again' || event === 'restart') {
      for (const p of room.players.values()) p.score = 0;
      room.roundNo = 0;
      nextRound();
    }
  }

  return { start, restore, quit, handle, active: () => !!room };
})();

// Sends an action: to the offline game while one runs on this phone, otherwise to the server.
function send(event, payload, ack) {
  if (Offline.active()) return Offline.handle(event, payload, ack);
  if (!socket || !socket.connected) return toast('اینترنت وصل نیست 📡');
  if (ack) socket.emit(event, payload, ack); else socket.emit(event, payload);
}

function applyState(s) {
  clockOffset = s.now - Date.now();
  const turnId = s.turn ? s.turn.id : null;
  if (!state || state.phase !== s.phase || state.roundNo !== s.roundNo || (state.turn ? state.turn.id : null) !== turnId) {
    if (!state || state.phase !== s.phase) { confettiDone = false; showMenu = false; }
    editing = false;
    draft = { text: '', truth: null };
    voteDraft = {};
  }
  state = s;
  setup = null;
  if (!s.offline) store.set('ayaa.room', s.code);
  render();
}

// ---------- socket ----------
if (socket) {
  socket.on('connect', () => {
    netbar.hidden = true;
    const code = store.get('ayaa.room');
    if (code && !Offline.active()) socket.emit('resume', { playerId, code });
    else if (!state) render(true);
  });
  socket.on('gone', () => { store.del('ayaa.room'); if (!Offline.active()) { state = null; render(true); } });
  socket.on('problem', msg => toast(msg));
  socket.on('disconnect', () => { if (!Offline.active() && store.get('ayaa.room')) netbar.hidden = false; });
  socket.io.on('reconnect_attempt', () => { if (!Offline.active() && store.get('ayaa.room')) netbar.hidden = false; });
  socket.on('state', s => { if (!Offline.active()) applyState(s); });
}

// Asks the server for the room again (after the phone wakes up, or when the screen looks stuck).
let lastResume = 0;
function refresh() {
  const code = store.get('ayaa.room');
  if (!code || !socket || Offline.active()) return;
  if (!socket.connected) { socket.connect(); return; }
  if (Date.now() - lastResume < 4000) return;
  lastResume = Date.now();
  socket.emit('resume', { playerId, code });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', refresh);
window.addEventListener('pageshow', refresh);
// Watchdog: if a phase's time ran out a few seconds ago and nothing new came, fetch the state.
setInterval(() => {
  if (state && !state.offline && state.deadline && Date.now() + clockOffset > state.deadline + 5000) refresh();
}, 2000);

// ---------- helpers ----------
const isHost = () => state && state.me && state.hostId === state.me.id;
const secondsLeft = () => state && state.deadline ? Math.max(0, Math.ceil((state.deadline - (Date.now() + clockOffset)) / 1000)) : 0;
const av = (name, i) => `<span class="av" style="background:${COLORS[i % COLORS.length]}">${esc([...name][0] || '?')}</span>`;
const names = list => list.length === 1 ? list[0] : list.slice(0, -1).join('، ') + ' و ' + list[list.length - 1];
const youName = () => state.local && state.turn ? esc(state.turn.name) + '، ' : '';

function revealIndex() {
  if (!state || state.phase !== 'reveal' || !state.reveal || !state.reveal.length) return 0;
  const total = Math.ceil(state.reveal.length * REVEAL_STEP / 1000 + 1.5) * 1000;
  const elapsed = Date.now() + clockOffset - (state.deadline - total);
  return Math.max(0, Math.min(state.reveal.length - 1, Math.floor(elapsed / REVEAL_STEP)));
}

// Redraw only when what is on screen really changes, so typing is never interrupted.
function viewKey() {
  if (!state) return setup ? 'setup|' + setup.names.length + '|' + setup.rounds : 'home' + showRules;
  const s = state;
  const base = [s.phase, s.roundNo, s.hostId, showMenu];
  if (s.phase === 'lobby') base.push(JSON.stringify(s.settings), JSON.stringify(s.players.map(p => [p.name, p.connected])));
  if (s.local && s.turn) base.push(s.turn.id, gate === s.turn.id);
  if (s.phase === 'write') base.push(JSON.stringify(s.mine), editing, draft.truth);
  if (s.phase === 'vote') base.push(JSON.stringify(s.myVotes), JSON.stringify(voteDraft));
  if (s.phase === 'reveal') base.push(revealIndex());
  return base.join('|');
}

function render(force) {
  const key = viewKey();
  if (force || key !== lastKey) {
    lastKey = key;
    const view = !state ? (setup ? localSetup : home)
      : (state.local && state.turn && gate !== state.turn.id) ? passPhone
      : { lobby, write, vote, reveal, scores, end }[state.phase];
    $app.innerHTML = view();
    bind();
  }
  tick();
}

// Updates the timer and the "who is done" list without redrawing the rest.
function tick() {
  const t = document.querySelector('.timer > div');
  const sec = document.querySelector('.secs');
  if (t && state && state.deadline) {
    const total = state.phase === 'write' ? state.settings.writeSec : state.phase === 'vote' ? state.settings.chooseSec : 9;
    const left = secondsLeft();
    t.style.width = Math.min(100, left / total * 100) + '%';
    t.parentElement.classList.toggle('low', left <= 10);
    if (sec) sec.textContent = fa(left);
  }
  const ul = document.getElementById('donelist');
  if (ul && state) {
    const html = state.players.map((p, i) => `<li class="${p.done ? 'done' : ''} ${p.connected ? '' : 'off'}">${av(p.name, i)}<span class="nm">${esc(p.name)}</span></li>`).join('');
    if (ul.innerHTML !== html) ul.innerHTML = html;
  }
}
render(true);
Offline.restore().catch(() => {});
setInterval(() => { if (state && state.phase === 'reveal') render(); else tick(); }, 250);

// Keeps the site's files on the phone so the one-phone game opens without internet.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------- views ----------
const RULES = `<ol class="rules">
  <li>هر راند هر کی یه جمله درباره‌ی هر چیزی می‌نویسه: درباره‌ی خودش، دوستاش، یه واقعیت علمی یا یه نکته‌ی خفن.</li>
  <li>خودش مخفیانه می‌گه این جمله <b>✅ راسته</b> یا <b>❌ دروغه</b>.</li>
  <li>بقیه بدون اینکه بدونن مال کیه، به هر جمله رأی می‌دن: راسته یا دروغه؟</li>
  <li>هر کی به جمله‌ی تو رأی اشتباه بده، <b>یه امتیاز</b> برای تو.</li>
  <li>آخر بازی هر کی بیشتر از همه بقیه رو گول زده باشه برنده‌ست! 😈</li>
  <li>کلمه‌ی بد ممنوعه 😇</li></ol>`;

function home() {
  const name = esc(store.get('ayaa.name') || '');
  return `
  <div class="logo"><span class="emoji">🤥</span><h1>آیا این داستان واقعیست؟</h1><p>یه جمله بگو، بقیه رو گول بزن!</p></div>
  <div class="card">
    <label for="name">اسمت چیه؟</label>
    <input id="name" type="text" maxlength="16" placeholder="مثلاً سارا" value="${name}" autocomplete="nickname">
    <button class="btn yellow" data-act="create">🎉 ساختن اتاق جدید</button>
    <button class="btn green" data-act="local">📱 بازی با یک گوشی</button>
    <p class="or">یا با کد وارد شو</p>
    <div class="row">
      <input id="code" class="code" type="text" maxlength="4" placeholder="ABCD" autocomplete="off" autocapitalize="characters">
      <button class="btn pink" data-act="join" style="margin-top:0">ورود</button>
    </div>
  </div>
  <button class="linkbtn" data-act="rules">${showRules ? 'بستن راهنما' : 'چطوری بازی کنیم؟'}</button>
  ${showRules ? `<div class="card">${RULES}</div>` : ''}`;
}

// One-phone game: names and rounds, then the game starts at once.
function localSetup() {
  const st = setup;
  return `
  <div class="logo" style="margin:8px 0 14px"><span class="emoji" style="font-size:48px">📱</span><h1 style="font-size:26px">بازی با یک گوشی</h1>
    <p>گوشی دست‌به‌دست می‌چرخه و هر کی نوبتش شد، جمله‌ش رو می‌نویسه</p></div>
  <div class="card">
    <h2>بازیکن‌ها (${fa(st.names.length)} نفر)</h2>
    <div class="names">${st.names.map((n, i) => `<div class="namerow">${av(n || '?', i)}
      <input type="text" maxlength="16" data-name="${i}" value="${esc(n)}" placeholder="اسم بازیکن ${fa(i + 1)}" autocomplete="off">
      ${st.names.length > 2 ? `<button class="x" data-del="${i}" aria-label="حذف">✕</button>` : ''}</div>`).join('')}</div>
    ${st.names.length < 20 ? '<button class="btn ghost" data-act="addname">➕ بازیکن جدید</button>' : ''}
  </div>
  <div class="card">
    <h2>⚙️ تنظیمات بازی</h2>
    <div class="setrow"><span>تعداد راندها</span><div class="mini"><button data-lrounds="-1" aria-label="کمتر">−</button><b>${fa(st.rounds)}</b><button data-lrounds="1" aria-label="بیشتر">+</button></div></div>
    <button class="btn green" data-act="startlocal">🚀 شروع بازی</button>
  </div>
  <button class="linkbtn" data-act="home">بازگشت</button>`;
}

// Between turns: hand the phone over without showing what the last player wrote or voted.
function passPhone() {
  const s = state, t = s.turn;
  const what = s.phase === 'write' ? 'جمله‌ت رو بنویسی' : 'به جمله‌ها رأی بدی';
  const i = s.players.findIndex(p => p.id === t.id);
  return `${topbar()}
  <div class="card center pass">
    <div class="muted">گوشی رو بده به</div>
    <div class="passname">${av(t.name, i)} ${esc(t.name)}</div>
    <p class="muted">تا ${what}. بقیه نگاه نکنن 🙈</p>
    <button class="btn yellow" data-act="iam">👋 من ${esc(t.name)} هستم</button>
  </div>
  <div class="card"><ul class="players" id="donelist"></ul></div>`;
}

function lobby() {
  const s = state;
  const st = s.settings;
  const enough = s.players.filter(p => p.connected).length >= 2;
  const setting = (key, label, shown, step) => `<div class="setrow"><span>${label}</span>
    ${isHost() ? `<div class="mini"><button data-set="${key}" data-step="${-step}" aria-label="کمتر">−</button><b>${shown}</b><button data-set="${key}" data-step="${step}" aria-label="بیشتر">+</button></div>` : `<b>${shown}</b>`}</div>`;
  return `
  <div class="logo" style="margin:8px 0 14px"><h1 style="font-size:26px">آیا این داستان واقعیست؟</h1></div>
  <div class="card roomcode">
    <div class="muted">کد اتاق</div>
    <div class="big">${esc(s.code)}</div>
    <div class="muted small">این کد رو به دوستات بده تا وارد بشن</div>
    <button class="btn ghost" data-act="share">📋 کپی لینک دعوت</button>
  </div>
  <div class="card">
    <h2>بازیکن‌ها (${fa(s.players.length)} از ${fa(st.maxPlayers)})</h2>
    <ul class="players">${s.players.map((p, i) => `<li class="${p.connected ? '' : 'off'}">${av(p.name, i)}<span class="nm">${esc(p.name)}</span>${p.id === s.hostId ? '👑' : ''}</li>`).join('')}</ul>
  </div>
  <div class="card">
    <h2>⚙️ تنظیمات بازی</h2>
    ${setting('rounds', 'تعداد راندها', fa(st.rounds), 1)}
    ${setting('writeSec', 'زمان نوشتن', fa(st.writeSec) + ' ثانیه', 15)}
    ${setting('chooseSec', 'زمان رأی دادن', fa(st.chooseSec) + ' ثانیه', 15)}
    ${setting('maxPlayers', 'حداکثر بازیکن', fa(st.maxPlayers) + ' نفر', 1)}
  </div>
  <div class="card center">
    ${isHost()
      ? `<button class="btn green" data-act="start" ${enough ? '' : 'disabled'} style="margin-top:0">🚀 شروع بازی</button>
         ${enough ? '' : '<p class="muted small">حداقل ۲ نفر لازمه</p>'}`
      : '<p class="muted" style="margin:0">منتظر میزبان 👑 برای شروع<span class="dots"></span></p>'}
  </div>
  <button class="linkbtn" data-act="rules">${showRules ? 'بستن راهنما' : 'چطوری بازی کنیم؟'}</button>
  ${showRules ? `<div class="card">${RULES}</div>` : ''}
  <button class="linkbtn" data-act="leave">خروج از اتاق</button>`;
}

// «⋯» during a game: start over (host or the one-phone game) or leave.
function menuHtml() {
  if (!showMenu) return '';
  return `<div class="sheet-bg" data-act="menu"></div>
  <div class="sheet" role="dialog" aria-label="منو">
    ${isHost() ? `<button class="btn yellow" data-act="restart">🔁 شروع دوباره${state.offline ? '' : ' (برگشت به لابی)'}</button>
      <p class="muted small center">امتیازهای این بازی پاک می‌شه${state.offline ? ' و از راند اول شروع می‌شه' : ' و همه برمی‌گردن به لابی'}.</p>` : ''}
    <button class="btn pink" data-act="leave">🚪 خروج از بازی</button>
    <button class="btn ghost" data-act="menu">ادامه‌ی بازی</button>
  </div>`;
}

function topbar() {
  const s = state;
  const timed = s.deadline && (s.phase === 'write' || s.phase === 'vote');
  return `${menuHtml()}<div class="topbar">
    <button class="pill menu-btn" data-act="menu" aria-label="منو">⋯</button>
    <span class="pill">راند ${fa(s.roundNo)} از ${fa(s.totalRounds)}</span>
    ${timed ? '<span class="secs"></span>' : ''}
  </div>
  ${timed ? '<div class="timer"><div></div></div>' : ''}`;
}

const truthBadge = t => t ? '<span class="tf yes">✅ راست</span>' : '<span class="tf no">❌ دروغ</span>';

function write() {
  const s = state;
  if (s.mine && !editing) {
    return `${topbar()}
    <div class="card center"><div class="muted">جمله‌ت ثبت شد 😈</div>
      <div class="said">«${esc(s.mine.text)}»</div>${truthBadge(s.mine.truth)}
      ${s.local ? '' : '<button class="btn ghost" data-act="rewrite">✏️ عوضش کن</button>'}</div>
    <div class="waiting">منتظر بقیه<span class="dots"></span></div>
    <div class="card"><ul class="players" id="donelist"></ul></div>`;
  }
  return `${topbar()}
  <div class="card">
    <label for="say">${youName()}یه جمله بنویس 🤔</label>
    <p class="muted small" style="margin:0 0 8px">درباره‌ی هر چیزی: خودت، دوستات، یه واقعیت علمی، یه نکته‌ی خفن…</p>
    <textarea id="say" maxlength="${MAX_LEN}" rows="3" placeholder="مثلاً: من بچه که بودم یه بار توی آسانسور گیر کردم">${esc(draft.text)}</textarea>
    <div class="muted small" style="margin:12px 0 6px;font-weight:700">این جمله…</div>
    <div class="tfpick">
      <button class="${draft.truth === true ? 'on yes' : ''}" data-truth="1">✅ راسته</button>
      <button class="${draft.truth === false ? 'on no' : ''}" data-truth="0">❌ دروغه</button>
    </div>
    <p class="muted small center" style="margin:8px 0 0">فقط خودت می‌دونی 🤫</p>
    <button class="btn pink" data-act="say">ثبت جمله</button>
  </div>
  <div class="card"><ul class="players" id="donelist"></ul></div>`;
}

function vote() {
  const s = state;
  const sent = s.myVotes && Object.keys(s.myVotes).length && !s.local;
  if (sent) {
    return `${topbar()}
    <div class="card center"><div class="said" style="font-size:22px">رأی‌هات ثبت شد 🗳️</div></div>
    <div class="waiting">منتظر بقیه<span class="dots"></span></div>
    <div class="card"><ul class="players" id="donelist"></ul></div>`;
  }
  const others = s.statements.filter(x => !x.mine);
  const left = others.filter(x => typeof voteDraft[x.id] !== 'boolean').length;
  return `${topbar()}
  <div class="waiting" style="margin-top:0">${youName()}کدوم راسته، کدوم دروغ؟ 🤔</div>
  <div class="votes">
    ${s.statements.map(x => x.mine ? `<div class="vcard mine"><div class="vt">${esc(x.text)}</div><div class="muted small">جمله‌ی خودته 😎</div></div>`
      : `<div class="vcard"><div class="vt">${esc(x.text)}</div>
        <div class="tfpick small">
          <button class="${voteDraft[x.id] === true ? 'on yes' : ''}" data-vote="${esc(x.id)}" data-v="1">✅ راسته</button>
          <button class="${voteDraft[x.id] === false ? 'on no' : ''}" data-vote="${esc(x.id)}" data-v="0">❌ دروغه</button>
        </div></div>`).join('')}
  </div>
  <button class="btn green" data-act="sendvotes" ${left ? 'disabled' : ''}>${left ? `هنوز ${fa(left)} تا مونده` : '🗳️ ثبت رأی‌ها'}</button>
  ${s.local ? '' : '<div class="card" style="margin-top:16px"><ul class="players" id="donelist"></ul></div>'}`;
}

function reveal() {
  const s = state, i = revealIndex(), step = s.reveal[i];
  const dots = s.reveal.map((_, k) => `<i class="${k <= i ? 'on' : ''}"></i>`).join('');
  const who = step.fooled.length
    ? `<b>${esc(names(step.fooled))}</b> گول ${step.fooled.length > 1 ? 'خوردن' : 'خورد'}! 😂`
    : 'هیچ‌کس گول نخورد 😎';
  return `${topbar()}
  <div class="card reveal-card" data-step="${i}">
    <div class="muted">جمله‌ی <b>${esc(step.author)}</b></div>
    <div class="answer long">«${esc(step.text)}»</div>
    <div><span class="stamp ${step.truth ? 'truth' : 'lie'}">${step.truth ? '✅ راست بود!' : '❌ دروغ بود!'}</span></div>
    <div class="who">${who}</div>
    ${step.fooled.length ? `<div><span class="plus">+${fa(step.fooled.length)} برای ${esc(step.author)}</span></div>` : ''}
    <div class="progress-dots">${dots}</div>
  </div>
  ${isHost() ? '<button class="linkbtn" data-act="skip">رد شدن ⏭</button>' : ''}`;
}

function boardHtml(showGain) {
  const s = state;
  const sorted = s.players.slice().sort((a, b) => b.score - a.score);
  const medal = ['🥇', '🥈', '🥉'];
  return `<ul class="board">${sorted.map((p, k) => {
    const g = s.gains && s.gains[p.id];
    return `<li style="animation-delay:${k * 0.07}s"><span class="rank">${medal[k] || fa(k + 1)}</span><span class="nm">${esc(p.name)}${p.connected ? '' : ' 💤'}</span>
      ${showGain && g ? `<span class="gain">+${fa(g)}</span>` : ''}<span class="sc">${fa(p.score)} 😈</span></li>`;
  }).join('')}</ul>`;
}

// Every sentence of the round: who wrote it, true or false, and who fell for it.
function summaryHtml() {
  const s = state;
  if (!s.summary || !s.summary.length) return '';
  return `<div class="card"><h2>🗳️ جمله‌های این راند</h2>
    <ul class="summary">${s.summary.map(o => `<li class="${o.truth ? 'truth' : ''}">
      <div class="st">${esc(o.text)}</div>
      <div class="meta"><span>${esc(o.author)} · ${truthBadge(o.truth)}</span>
        <span class="votes">${fa(o.fooled.length)} گول خورد</span></div>
      ${o.fooled.length ? `<div class="voters">${o.fooled.map(v => `<span>${esc(v)}</span>`).join('')}</div>` : ''}
    </li>`).join('')}</ul></div>`;
}

function scores() {
  return `${topbar()}
  ${summaryHtml()}
  <div class="card"><h2>🏆 جدول امتیاز</h2><p class="muted small" style="margin-top:-6px">هر 😈 یعنی یه نفر رو گول زده</p>${boardHtml(true)}</div>
  <div class="waiting">راند بعدی تا چند لحظه‌ی دیگه<span class="dots"></span></div>
  ${isHost() ? '<button class="linkbtn" data-act="skip">برو راند بعد ⏭</button>' : ''}`;
}

function end() {
  const s = state;
  const top = Math.max(...s.players.map(p => p.score));
  const winners = s.players.filter(p => p.score === top).map(p => p.name);
  setTimeout(() => { if (!confettiDone) { confettiDone = true; confetti(); } }, 50);
  return `
  <div class="winner"><span class="crown">👑</span><h2>${esc(names(winners))}</h2>
    <p>${winners.length > 1 ? 'مساوی شدن و با هم بردن!' : 'بیشتر از همه گول زد!'} 🎉 ${fa(top)} رأی اشتباه</p></div>
  <div class="card"><h2>نتیجه‌ی نهایی</h2>${boardHtml(true)}</div>
  ${summaryHtml()}
  ${isHost() ? '<button class="btn yellow" data-act="again">🔁 بازی دوباره</button>' : '<div class="waiting">منتظر میزبان برای بازی دوباره<span class="dots"></span></div>'}
  <button class="linkbtn" data-act="leave">خروج</button>`;
}

// Leaves the game (online room or the one on this phone) and goes back to the home screen.
function leaveGame() {
  showMenu = false;
  if (Offline.active()) Offline.quit();
  else if (socket && socket.connected) socket.emit('leave');
  store.del('ayaa.room');
  state = null;
  gate = null;
  netbar.hidden = true;
  history.replaceState(null, '', '/');
  render(true);
}

// Online play needs the server; without internet only the one-phone game is there.
function online() {
  if (socket && navigator.onLine !== false) return true;
  toast('برای بازی آنلاین اینترنت لازمه. «بازی با یک گوشی» بدون اینترنت هم کار می‌کنه 📱');
  return false;
}

// ---------- actions ----------
function bind() {
  const nameEl = document.getElementById('name');
  const codeEl = document.getElementById('code');
  const sayEl = document.getElementById('say');
  const params = new URLSearchParams(location.search);
  if (codeEl && params.get('room')) codeEl.value = params.get('room').toUpperCase().slice(0, 4);
  if (codeEl) codeEl.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  if (sayEl) {
    sayEl.addEventListener('input', () => { draft.text = sayEl.value; });
    if (!draft.text) sayEl.focus({ preventScroll: true });
  }

  $app.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'create') {
      const name = nameEl.value.trim();
      if (!name) return toast('اول اسمت رو بنویس ✍️');
      store.set('ayaa.name', name);
      if (!online()) return;
      send('create', { playerId, name });
    } else if (act === 'join') joinRoom();
    else if (act === 'local') {
      let saved = [];
      try { saved = JSON.parse(store.get('ayaa.localNames') || '[]'); } catch (e) {}
      const mine = nameEl.value.trim();
      setup = { names: saved.length >= 2 ? saved : [mine, ''], rounds: Number(store.get('ayaa.localRounds')) || 3 };
      render(true);
    }
    else if (act === 'home') { readNames(); setup = null; render(true); }
    else if (act === 'addname') { readNames(); setup.names.push(''); render(true); const l = $app.querySelectorAll('[data-name]'); l[l.length - 1].focus(); }
    else if (act === 'startlocal') {
      readNames();
      const list = setup.names.map(n => n.trim()).filter(Boolean);
      if (list.length < 2) return toast('حداقل ۲ تا اسم بنویس ✍️');
      if (new Set(list.map(AyaCore.normalize)).size !== list.length) return toast('دو تا اسم یکسانه. اسم‌ها باید فرق کنن.');
      store.set('ayaa.localNames', JSON.stringify(list));
      store.set('ayaa.localRounds', String(setup.rounds));
      store.del('ayaa.room');
      gate = null;
      Offline.start(list, { rounds: setup.rounds }).catch(() => toast('بار اول باید با اینترنت باز بشه تا بازی روی گوشی ذخیره بشه 📡'));
    }
    else if (act === 'iam') { gate = state.turn.id; render(true); }
    else if (act === 'rules') { showRules = !showRules; render(true); }
    else if (act === 'start') send('start');
    else if (act === 'say') submitStatement();
    else if (act === 'rewrite') { editing = true; draft = { text: state.mine.text, truth: state.mine.truth }; render(true); }
    else if (act === 'sendvotes') {
      send('votes', voteDraft, res => { if (res && !res.ok && res.msg) toast(res.msg); });
    }
    else if (act === 'skip') send('skip');
    else if (act === 'again') send('again');
    else if (act === 'share') {
      const url = location.origin + '/?room=' + state.code;
      if (navigator.share) navigator.share({ title: 'آیا این داستان واقعیست؟', text: 'بیا بازی! کد اتاق: ' + state.code, url }).catch(() => {});
      else if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('لینک کپی شد 📋'), () => toast(url));
      else toast(url);
    }
    else if (act === 'leave') leaveGame();
    else if (act === 'menu') { showMenu = !showMenu; render(true); }
    else if (act === 'restart') { showMenu = false; send('restart'); render(true); }
  }));

  $app.querySelectorAll('[data-truth]').forEach(b => b.addEventListener('click', () => {
    if (sayEl) draft.text = sayEl.value;
    draft.truth = b.dataset.truth === '1';
    render(true);
  }));
  $app.querySelectorAll('[data-vote]').forEach(b => b.addEventListener('click', () => {
    voteDraft[b.dataset.vote] = b.dataset.v === '1';
    if (navigator.vibrate) navigator.vibrate(15);
    render(true);
  }));

  $app.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { readNames(); setup.names.splice(+b.dataset.del, 1); render(true); }));
  $app.querySelectorAll('[data-lrounds]').forEach(b => b.addEventListener('click', () => {
    readNames(); setup.rounds = Math.max(1, Math.min(30, setup.rounds + Number(b.dataset.lrounds))); render(true);
  }));
  $app.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.set;
    send('settings', { [k]: state.settings[k] + Number(b.dataset.step) });
  }));

  function readNames() {
    if (!setup) return;
    $app.querySelectorAll('[data-name]').forEach(el => { setup.names[+el.dataset.name] = el.value; });
  }

  function joinRoom() {
    const name = nameEl.value.trim();
    const code = codeEl.value.trim().toUpperCase();
    if (!name) return toast('اول اسمت رو بنویس ✍️');
    if (code.length !== 4) return toast('کد اتاق ۴ حرفیه');
    store.set('ayaa.name', name);
    if (!online()) return;
    send('join', { playerId, name, code });
  }

  function submitStatement() {
    const text = sayEl.value.trim();
    if (!text) return toast('یه جمله بنویس!');
    if (typeof draft.truth !== 'boolean') return toast('بگو این جمله راسته یا دروغ ✅❌');
    send('statement', { text, truth: draft.truth }, res => {
      if (res.ok) { editing = false; render(true); return; }
      toast(res.msg);
      if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
    });
  }
}

// ---------- confetti ----------
function confetti() {
  const c = document.getElementById('confetti'), ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bits = Array.from({ length: 160 }, () => ({
    x: Math.random() * innerWidth, y: -20 - Math.random() * innerHeight * 0.6,
    vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3.5, r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3, w: 6 + Math.random() * 6, h: 8 + Math.random() * 8,
    color: COLORS[Math.floor(Math.random() * COLORS.length)].replace('#8b5cf6', '#fde047'),
  }));
  const startT = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    bits.forEach(b => {
      b.x += b.vx; b.y += b.vy; b.r += b.vr; b.vy += 0.03;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.color;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
    });
    if (t - startT < 5000) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(startT);
}
