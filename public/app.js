/* «آیا این داستان واقعیست؟» — client. Draws the state the server sends; the server decides everything. */
'use strict';

const $app = document.getElementById('app');
// Starts with HTTP polling and upgrades to WebSocket when the network allows it, so networks
// that block or break WebSocket still work.
const socket = io({ reconnectionDelay: 500, reconnectionDelayMax: 3000, timeout: 15000 });
const netbar = document.getElementById('netbar');
const fa = n => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#3b82f6', '#ef4444', '#14b8a6', '#f97316', '#a855f7', '#0ea5e9'];
const REVEAL_STEP = 4500;

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

let state = null;       // last state from the server
let clockOffset = 0;    // server time - local time
let lastKey = '';
let showRules = false;
let confettiDone = false;
let editingLie = false; // "عوضش کن" pressed after a lie was sent
// One-phone game: the setup form before it starts, and who confirmed they're holding the phone.
let setup = null;       // { names: [...], mode, rounds }
let gate = null;        // id of the player who tapped «منم» for this turn

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- socket ----------
socket.on('connect', () => {
  netbar.hidden = true;
  const code = store.get('ayaa.room');
  if (code) socket.emit('resume', { playerId, code });
  else if (!state) render(true);
});
socket.on('gone', () => { store.del('ayaa.room'); state = null; render(true); });
socket.on('problem', msg => toast(msg));
socket.on('disconnect', () => { netbar.hidden = false; });
socket.io.on('reconnect_attempt', () => { netbar.hidden = false; });

// Asks the server for the room again (after the phone wakes up, or when the screen looks stuck).
let lastResume = 0;
function refresh() {
  const code = store.get('ayaa.room');
  if (!code) return;
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
  if (state && state.deadline && Date.now() + clockOffset > state.deadline + 5000) refresh();
}, 2000);
socket.on('state', s => {
  clockOffset = s.now - Date.now();
  if (state && state.phase !== s.phase) { confettiDone = false; editingLie = false; }
  state = s;
  setup = null;
  store.set('ayaa.room', s.code);
  render();
});

// ---------- helpers ----------
const me = () => state && state.me;
const isHost = () => state && state.me && state.hostId === state.me.id;
const secondsLeft = () => state && state.deadline ? Math.max(0, Math.ceil((state.deadline - (Date.now() + clockOffset)) / 1000)) : 0;
const av = (name, i) => `<span class="av" style="background:${COLORS[i % COLORS.length]}">${esc([...name][0] || '?')}</span>`;
const names = list => list.length === 1 ? list[0] : list.slice(0, -1).join('، ') + ' و ' + list[list.length - 1];
const promptHtml = (fill) => state.kind === 'story'
  ? `<div class="topic">موضوع: ${esc(state.topic)}</div>${fill ? `<div class="story-true">«${esc(fill)}»</div>` : '<div class="muted">یه داستان کوتاه و باورپذیر درباره‌ی این موضوع بنویس. بین همه‌ی داستان‌ها فقط یکی واقعیه!</div>'}`
  : `<div class="question">${questionHtml(state.question, fill)}</div>`;
const questionHtml = (q, fill) => esc(q).replace('___', fill ? `<span class="blank filled">${esc(fill)}</span>` : '<span class="blank">؟</span>');

function revealIndex() {
  if (!state || state.phase !== 'reveal' || !state.reveal) return 0;
  const total = Math.ceil(state.reveal.length * REVEAL_STEP / 1000 + 1.5) * 1000;
  const elapsed = Date.now() + clockOffset - (state.deadline - total);
  return Math.max(0, Math.min(state.reveal.length - 1, Math.floor(elapsed / REVEAL_STEP)));
}

// Redraw only when what is on screen really changes, so typing is never interrupted.
function viewKey() {
  if (!state) return setup ? 'setup|' + setup.names.length + '|' + setup.mode + '|' + setup.rounds : 'home' + showRules;
  const s = state;
  const base = [s.phase, s.roundNo, s.hostId];
  if (s.phase === 'lobby') base.push(JSON.stringify(s.settings), JSON.stringify(s.players.map(p => [p.name, p.connected])));
  if (s.local && s.turn) base.push(s.turn.id, gate === s.turn.id);
  if (s.phase === 'write') base.push(s.myLie || '', editingLie);
  if (s.phase === 'choose') base.push(s.myPick || '');
  if (s.phase === 'reveal') base.push(revealIndex());
  return base.join('|');
}

function render(force) {
  const key = viewKey();
  if (force || key !== lastKey) {
    lastKey = key;
    const view = !state ? (setup ? localSetup : home) : (state.local && state.turn && gate !== state.turn.id) ? passPhone : { lobby, write, choose, reveal, scores, end }[state.phase];
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
    const total = state.phase === 'write' ? state.settings.writeSec : state.phase === 'choose' ? state.settings.chooseSec : 9;
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
setInterval(() => { if (state && state.phase === 'reveal') render(); else tick(); }, 250);

// ---------- views ----------
function home() {
  const name = esc(store.get('ayaa.name') || '');
  return `
  <div class="logo"><span class="emoji">🤥</span><h1>آیا این داستان واقعیست؟</h1><p>دروغ بساز، راستش رو پیدا کن!</p></div>
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
  ${showRules ? `<div class="card"><ol class="rules">
    <li><b>کلمه‌ای:</b> یه سؤال عجیب ولی واقعی با جای خالی میاد. <b>داستانی:</b> یه موضوع میاد و هر کی یه داستان الکی می‌سازه؛ بین همه فقط یکی واقعیه.</li>
    <li>هر کی یه دروغ باورپذیر می‌نویسه. زمان نوشتن و حدس زدن رو میزبان تنظیم می‌کنه.</li>
    <li>همه‌ی دروغ‌ها با جواب واقعی قاطی می‌شن و باید واقعی رو پیدا کنی. آخر هر راند همه می‌بینن هر جمله مال کی بود و چند رأی آورد.</li>
    <li>پیدا کردن جواب واقعی: <b>۱۰۰۰</b> امتیاز. هر کی گول دروغت رو بخوره: <b>۵۰۰</b> امتیاز برای تو.</li>
    <li>راند آخر امتیازها <b>دو برابره!</b></li>
    <li>کلمه‌ی بد ممنوعه 😇</li></ol></div>` : ''}`;
}

// One-phone game: names and settings, then the game starts at once.
function localSetup() {
  const st = setup;
  return `
  <div class="logo" style="margin:8px 0 14px"><span class="emoji" style="font-size:48px">📱</span><h1 style="font-size:26px">بازی با یک گوشی</h1>
    <p>گوشی دست‌به‌دست می‌چرخه و هر کی نوبتش شد، دروغش رو می‌نویسه</p></div>
  <div class="card">
    <h2>بازیکن‌ها (${fa(st.names.length)} نفر)</h2>
    <div class="names">${st.names.map((n, i) => `<div class="namerow">${av(n || '?', i)}
      <input type="text" maxlength="16" data-name="${i}" value="${esc(n)}" placeholder="اسم بازیکن ${fa(i + 1)}" autocomplete="off">
      ${st.names.length > 2 ? `<button class="x" data-del="${i}" aria-label="حذف">✕</button>` : ''}</div>`).join('')}</div>
    ${st.names.length < 20 ? '<button class="btn ghost" data-act="addname">➕ بازیکن جدید</button>' : ''}
  </div>
  <div class="card">
    <h2>⚙️ تنظیمات بازی</h2>
    <div class="seg" role="group" aria-label="حالت بازی">
      <button class="${st.mode === 'word' ? 'on' : ''}" data-lmode="word">🔤 کلمه‌ای<small>جای خالی رو پر کن</small></button>
      <button class="${st.mode === 'story' ? 'on' : ''}" data-lmode="story">📖 داستانی<small>یه داستان بساز</small></button>
    </div>
    <div class="setrow"><span>تعداد راندها</span><div class="mini"><button data-lrounds="-1" aria-label="کمتر">−</button><b>${fa(st.rounds)}</b><button data-lrounds="1" aria-label="بیشتر">+</button></div></div>
    <button class="btn green" data-act="startlocal">🚀 شروع بازی</button>
  </div>
  <button class="linkbtn" data-act="home">بازگشت</button>`;
}

// Between turns: hand the phone over without showing what the last player wrote or chose.
function passPhone() {
  const s = state, t = s.turn;
  const what = s.phase === 'write' ? (s.kind === 'story' ? 'داستان الکیت رو بنویسی' : 'دروغت رو بنویسی') : 'جواب واقعی رو حدس بزنی';
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
    <div class="seg" role="group" aria-label="حالت بازی">
      <button class="${st.mode === 'word' ? 'on' : ''}" data-mode="word" ${isHost() ? '' : 'disabled'}>🔤 کلمه‌ای<small>جای خالی رو پر کن</small></button>
      <button class="${st.mode === 'story' ? 'on' : ''}" data-mode="story" ${isHost() ? '' : 'disabled'}>📖 داستانی<small>یه داستان بساز</small></button>
    </div>
    ${setting('rounds', 'تعداد راندها', fa(st.rounds), 1)}
    ${setting('writeSec', 'زمان نوشتن', fa(st.writeSec) + ' ثانیه', 15)}
    ${setting('chooseSec', 'زمان حدس زدن', fa(st.chooseSec) + ' ثانیه', 5)}
    ${setting('maxPlayers', 'حداکثر بازیکن', fa(st.maxPlayers) + ' نفر', 1)}
  </div>
  <div class="card center">
    ${isHost()
      ? `<button class="btn green" data-act="start" ${enough ? '' : 'disabled'} style="margin-top:0">🚀 شروع بازی</button>
         ${enough ? '' : '<p class="muted small">حداقل ۲ نفر لازمه</p>'}`
      : '<p class="muted" style="margin:0">منتظر میزبان 👑 برای شروع<span class="dots"></span></p>'}
  </div>
  <button class="linkbtn" data-act="leave">خروج از اتاق</button>`;
}

function topbar() {
  const s = state;
  return `<div class="topbar">
    <span class="pill">راند ${fa(s.roundNo)} از ${fa(s.totalRounds)}</span>
    ${s.double ? '<span class="pill double">⭐ امتیاز دوبرابر</span>' : ''}
    ${s.deadline && (s.phase === 'write' || s.phase === 'choose') ? '<span class="secs"></span>' : ''}
  </div>
  ${s.deadline && (s.phase === 'write' || s.phase === 'choose') ? '<div class="timer"><div></div></div>' : ''}`;
}

function write() {
  const s = state;
  return `${topbar()}
  <div class="card">${promptHtml()}</div>
  ${s.myLie && !editingLie
    ? `<div class="card center"><div class="muted">دروغت ثبت شد 😈</div><div style="font-size:24px;font-weight:900;margin-top:6px">«${esc(s.myLie)}»</div>
        <button class="btn ghost" data-act="relie">✏️ عوضش کن</button></div>
       <div class="waiting">منتظر بقیه<span class="dots"></span></div>`
    : `<div class="card">
        ${s.kind === 'story'
          ? `<label for="lie">${s.local && s.turn ? esc(s.turn.name) + '، ' : ''}داستان الکیت رو بنویس</label>
             <textarea id="lie" maxlength="160" rows="3" placeholder="مثلاً: توی ژاپن یه جزیره هست که فقط خرگوش‌ها توش زندگی می‌کنن…"></textarea>`
          : `<label for="lie">${s.local && s.turn ? esc(s.turn.name) + '، ' : ''}یه جواب الکی ولی باورپذیر بنویس</label>
             <input id="lie" type="text" maxlength="40" placeholder="دروغت رو اینجا بنویس…" autocomplete="off" enterkeyhint="send">`}
        <button class="btn pink" data-act="lie">🤥 ثبت دروغ</button>
      </div>`}
  <div class="card"><ul class="players" id="donelist"></ul></div>`;
}

function choose() {
  const s = state;
  return `${topbar()}
  <div class="card">${s.kind === 'story' ? `<div class="topic">موضوع: ${esc(s.topic)}</div>` : `<div class="question">${questionHtml(s.question)}</div>`}</div>
  <div class="waiting" style="margin-top:0">${s.local && s.turn ? esc(s.turn.name) + '، ' : ''}${s.myPick ? 'انتخابت ثبت شد. می‌تونی عوضش کنی 👀' : s.kind === 'story' ? 'کدوم داستان واقعیه؟ 🤔' : 'کدوم جواب واقعیه؟ 🤔'}</div>
  <div class="options">
    ${s.options.map(o => `<button class="opt ${s.kind === 'story' ? 'long' : ''} ${o.mine ? 'mine' : ''} ${s.myPick === o.id ? 'picked' : ''}" data-pick="${esc(o.id)}" ${o.mine ? 'aria-disabled="true"' : ''}>${esc(o.text)}</button>`).join('')}
  </div>
  <div class="card" style="margin-top:16px"><ul class="players" id="donelist"></ul></div>`;
}

function reveal() {
  const s = state, i = revealIndex(), step = s.reveal[i];
  const dots = s.reveal.map((_, k) => `<i class="${k <= i ? 'on' : ''}"></i>`).join('');
  let who;
  if (step.truth) {
    who = step.pickers.length ? `<b>${esc(names(step.pickers))}</b> درست حدس ${step.pickers.length > 1 ? 'زدن' : 'زد'}! 🎯` : 'هیچ‌کس جواب واقعی رو پیدا نکرد! 😱';
  } else {
    const author = step.house ? 'دروغ آماده‌ی بازی' : `دروغ <b>${esc(names(step.authors))}</b>`;
    who = `این ${author} بود و <b>${esc(names(step.pickers))}</b> گولش رو ${step.pickers.length > 1 ? 'خوردن' : 'خورد'}! 😂`;
  }
  return `${topbar()}
  <div class="card">${s.kind === 'story' ? `<div class="topic">موضوع: ${esc(s.topic)}</div>` : `<div class="question" style="font-size:19px">${questionHtml(s.question, step.truth ? step.text : null)}</div>`}</div>
  <div class="card reveal-card" data-step="${i}">
    <div class="answer ${s.kind === 'story' ? 'long' : ''}">«${esc(step.text)}»</div>
    <div><span class="stamp ${step.truth ? 'truth' : 'lie'}">${step.truth ? '✅ واقعیه!' : '❌ دروغه!'}</span></div>
    <div class="who">${who}</div>
    ${step.pickers.length && !step.house ? `<div><span class="plus">+${fa(step.points)}${step.truth ? ' برای هر نفر' : step.authors.length ? '' : ''}</span></div>` : ''}
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
      ${showGain && g ? `<span class="gain">+${fa(g)}</span>` : ''}<span class="sc">${fa(p.score)}</span></li>`;
  }).join('')}</ul>`;
}

// Every option of the round: who wrote it and how many votes it got.
function summaryHtml() {
  const s = state;
  if (!s.summary) return '';
  return `<div class="card"><h2>🗳️ رأی‌های این راند</h2>
    ${s.kind === 'word' ? `<div class="muted small" style="margin-bottom:8px">${questionHtml(s.question, s.answer)}</div>` : ''}
    <ul class="summary">${s.summary.map(o => `<li class="${o.truth ? 'truth' : ''}">
      <div class="st">${o.truth ? '✅ ' : '🤥 '}${esc(o.text)}</div>
      <div class="meta"><span>${o.truth ? 'داستان واقعی' : o.authors.length ? 'نوشته‌ی ' + esc(names(o.authors)) : 'دروغ آماده‌ی بازی'}</span>
        <span class="votes">${fa(o.votes)} رأی</span></div>
      ${o.voters.length ? `<div class="voters">${o.voters.map(v => `<span>${esc(v)}</span>`).join('')}</div>` : ''}
    </li>`).join('')}</ul></div>`;
}

function scores() {
  return `${topbar()}
  ${summaryHtml()}
  <div class="card"><h2>🏆 جدول امتیاز</h2>${boardHtml(true)}</div>
  <div class="waiting">راند بعدی تا چند لحظه‌ی دیگه<span class="dots"></span></div>
  ${isHost() ? '<button class="linkbtn" data-act="skip">برو راند بعد ⏭</button>' : ''}`;
}

function end() {
  const s = state;
  const top = Math.max(...s.players.map(p => p.score));
  const winners = s.players.filter(p => p.score === top).map(p => p.name);
  setTimeout(() => { if (!confettiDone) { confettiDone = true; confetti(); } }, 50);
  return `
  <div class="winner"><span class="crown">👑</span><h2>${esc(names(winners))}</h2><p>${winners.length > 1 ? 'مساوی شدن و با هم بردن!' : 'استاد دروغ‌سازی شد!'} 🎉</p></div>
  <div class="card"><h2>نتیجه‌ی نهایی</h2>${boardHtml(true)}</div>
  ${summaryHtml()}
  ${isHost() ? '<button class="btn yellow" data-act="again">🔁 بازی دوباره</button>' : '<div class="waiting">منتظر میزبان برای بازی دوباره<span class="dots"></span></div>'}
  <button class="linkbtn" data-act="leave">خروج</button>`;
}

// ---------- actions ----------
function bind() {
  const nameEl = document.getElementById('name');
  const codeEl = document.getElementById('code');
  const lieEl = document.getElementById('lie');
  const params = new URLSearchParams(location.search);
  if (codeEl && params.get('room')) codeEl.value = params.get('room').toUpperCase().slice(0, 4);
  if (lieEl) {
    lieEl.focus({ preventScroll: true });
    lieEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitLie(); } });
  }
  if (codeEl) codeEl.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

  $app.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'create') {
      const name = nameEl.value.trim();
      if (!name) return toast('اول اسمت رو بنویس ✍️');
      store.set('ayaa.name', name);
      socket.emit('create', { playerId, name });
    } else if (act === 'join') joinRoom();
    else if (act === 'local') {
      let saved = [];
      try { saved = JSON.parse(store.get('ayaa.localNames') || '[]'); } catch (e) {}
      const mine = nameEl.value.trim();
      const names = saved.length >= 2 ? saved : [mine, ''];
      setup = { names, mode: store.get('ayaa.localMode') || 'word', rounds: 7 };
      render(true);
    }
    else if (act === 'home') { readNames(); setup = null; render(true); }
    else if (act === 'addname') { readNames(); setup.names.push(''); render(true); const l = $app.querySelectorAll('[data-name]'); l[l.length - 1].focus(); }
    else if (act === 'startlocal') {
      readNames();
      const names = setup.names.map(n => n.trim()).filter(Boolean);
      if (names.length < 2) return toast('حداقل ۲ تا اسم بنویس ✍️');
      store.set('ayaa.localNames', JSON.stringify(names));
      store.set('ayaa.localMode', setup.mode);
      gate = null;
      socket.emit('createLocal', { playerId, names, settings: { mode: setup.mode, rounds: setup.rounds } });
    }
    else if (act === 'iam') { gate = state.turn.id; render(true); }
    else if (act === 'rules') { showRules = !showRules; render(true); }
    else if (act === 'start') socket.emit('start');
    else if (act === 'lie') submitLie();
    else if (act === 'relie') { editingLie = true; render(true); }
    else if (act === 'skip') socket.emit('skip');
    else if (act === 'again') socket.emit('again');
    else if (act === 'share') {
      const url = location.origin + '/?room=' + state.code;
      if (navigator.share) navigator.share({ title: 'آیا این داستان واقعیست؟', text: 'بیا بازی! کد اتاق: ' + state.code, url }).catch(() => {});
      else if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('لینک کپی شد 📋'), () => toast(url));
      else toast(url);
    } else if (act === 'leave') {
      socket.emit('leave');
      store.del('ayaa.room');
      state = null;
      history.replaceState(null, '', '/');
      render(true);
    }
  }));

  $app.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { readNames(); setup.names.splice(+b.dataset.del, 1); render(true); }));
  $app.querySelectorAll('[data-lmode]').forEach(b => b.addEventListener('click', () => { readNames(); setup.mode = b.dataset.lmode; render(true); }));
  $app.querySelectorAll('[data-lrounds]').forEach(b => b.addEventListener('click', () => {
    readNames(); setup.rounds = Math.max(1, Math.min(30, setup.rounds + Number(b.dataset.lrounds))); render(true);
  }));

  $app.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.set;
    socket.emit('settings', { [k]: state.settings[k] + Number(b.dataset.step) });
  }));
  $app.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => socket.emit('settings', { mode: b.dataset.mode })));

  $app.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
    const opt = state.options.find(o => o.id === b.dataset.pick);
    if (opt && opt.mine) return toast('این دروغ خودته! 😄');
    socket.emit('pick', state.local ? { option: b.dataset.pick, as: state.turn.id } : b.dataset.pick, res => { if (res && !res.ok && res.msg) toast(res.msg); });
    if (navigator.vibrate) navigator.vibrate(20);
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
    socket.emit('join', { playerId, name, code });
  }

  function submitLie() {
    const text = lieEl.value.trim();
    if (!text) return toast('یه چیزی بنویس!');
    socket.emit('lie', state.local ? { text, as: state.turn.id } : text, res => {
      if (res.ok) { editingLie = false; render(true); return; }
      if (!res.ok) { toast(res.msg); lieEl.select(); if (navigator.vibrate) navigator.vibrate([40, 40, 40]); }
    });
  }
}

// ---------- confetti ----------
function confetti() {
  const c = document.getElementById('confetti'), ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
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
