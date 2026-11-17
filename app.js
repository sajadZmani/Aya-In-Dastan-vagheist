/*
 * «آیا این داستان واقعیست؟» — the whole game, on one phone passed from hand to hand.
 * Each round every player writes one sentence about anything and secretly marks it true or false;
 * the others vote true/false on every sentence; each wrong vote is a point for the writer.
 * No server: the rules are in core.js, the game runs in the browser and is saved on the phone,
 * and sw.js keeps the files so it opens without internet once the site has been opened once.
 */
'use strict';

const $app = document.getElementById('app');
const fa = n => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#3b82f6', '#ef4444', '#14b8a6', '#f97316', '#a855f7', '#0ea5e9'];
const MAX_LEN = 160;

// ---------- storage (wrapped: private windows can throw) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

let state = null;       // what the screen shows (from the game below)
let lastKey = '';
let showRules = false;
let confettiDone = false;
let draft = { text: '', truth: null };   // the sentence being written
let voteDraft = {};     // votes being chosen: { sentenceId: true/false }
// The setup form before a game starts, and who confirmed they're holding the phone.
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

// ---------- the game ----------
// The players are names typed in at the start and the phone is passed around. Nothing runs on a
// timer. Saved after every step, so a refresh or a closed tab carries on where it was.
const Offline = (() => {
  let hasBadWord = null, room = null;

  function load() {
    if (!hasBadWord) hasBadWord = AyaCore.badWordChecker(window.AYAA_BLOCKLIST);
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
    s.me = { id: 'me', name: '' };
    s.turn = t ? { id: t.id, name: t.name } : null;
    s.now = Date.now();
    applyState(s);
  }

  function setPhase(phase) { room.phase = phase; push(); }
  function nextRound() { AyaCore.newRound(room); setPhase('write'); }

  // «بعدی»: the same steps as on the server.
  function next() {
    const r = room.round;
    if (room.phase === 'write') {
      if (!AyaCore.allDone(room)) return toast('هنوز همه ننوشتن ✍️');
      AyaCore.finishWriting(room); setPhase('vote');
    } else if (room.phase === 'vote') {
      if (!AyaCore.allDone(room)) return toast('هنوز همه رأی ندادن 🗳️');
      AyaCore.finishVoting(room); setPhase('reveal');
    } else if (room.phase === 'reveal') {
      if (r.revealStep < r.reveal.length - 1) { r.revealStep += 1; push(); }
      else setPhase(room.roundNo >= room.settings.rounds ? 'end' : 'scores');
    } else if (room.phase === 'scores') nextRound();
  }

  function start(names, settings) {
    load();
    room = {
      players: new Map(names.map((name, i) => ['p' + i, { id: 'p' + i, name, score: 0 }])),
      settings: { rounds: settings.rounds },
      hostId: 'me', phase: 'write', roundNo: 0, round: null,
    };
    nextRound();
  }

  function restore() {
    let saved = null;
    try { saved = JSON.parse(store.get('ayaa.offline') || 'null'); } catch (e) {}
    if (!saved || !saved.round || !saved.round.statements) return false;   // nothing, or a game of the old kind
    load();
    room = { ...saved, players: new Map(saved.players.map(p => [p.id, p])) };
    push();
    return true;
  }

  function quit() { room = null; save(); }

  // What the buttons do.
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
      push();
    } else if (event === 'votes' && room.phase === 'vote' && t) {
      room.round.votes[t.id] = AyaCore.cleanVotes(room, t.id, payload);
      if (!AyaCore.votedAll(room, t.id)) return ack({ ok: false, msg: 'به همه‌ی جمله‌ها رأی بده 🙂' });
      ack({ ok: true });
      push();
    } else if (event === 'next') next(); else if (event === 'again' || event === 'restart') {
      for (const p of room.players.values()) p.score = 0;
      room.roundNo = 0;
      nextRound();
    }
  }

  return { start, restore, quit, handle, active: () => !!room };
})();

// Sends an action to the game.
function send(event, payload, ack) {
  if (Offline.active()) Offline.handle(event, payload, ack);
}

function applyState(s) {
  const turnId = s.turn ? s.turn.id : null;
  if (!state || state.phase !== s.phase || state.roundNo !== s.roundNo || (state.turn ? state.turn.id : null) !== turnId) {
    if (!state || state.phase !== s.phase) { confettiDone = false; showMenu = false; }
    draft = { text: '', truth: null };
    voteDraft = {};
  }
  state = s;
  setup = null;
  render();
}

// ---------- helpers ----------
const av = (name, i) => `<span class="av" style="background:${COLORS[i % COLORS.length]}">${esc([...name][0] || '?')}</span>`;
const names = list => list.length === 1 ? list[0] : list.slice(0, -1).join('، ') + ' و ' + list[list.length - 1];
const youName = () => state.turn ? esc(state.turn.name) + '، ' : '';

function revealIndex() {
  if (!state || !state.reveal || !state.reveal.length) return 0;
  return Math.min(state.revealStep || 0, state.reveal.length - 1);
}

// Redraw only when what is on screen really changes, so typing is never interrupted.
function viewKey() {
  if (!state) return 'setup|' + setup.names.length + '|' + setup.rounds + '|' + showRules;
  const s = state;
  const base = [s.phase, s.roundNo, s.hostId, showMenu, s.allDone];
  if (s.turn) base.push(s.turn.id, gate === s.turn.id);
  if (s.phase === 'write') base.push(draft.truth);
  if (s.phase === 'vote') base.push(JSON.stringify(s.myVotes), JSON.stringify(voteDraft));
  if (s.phase === 'reveal') base.push(revealIndex());
  return base.join('|');
}

function render(force) {
  const key = viewKey();
  if (force || key !== lastKey) {
    lastKey = key;
    const view = !state ? home
      : (state.turn && gate !== state.turn.id) ? passPhone
      : { write, vote, reveal, scores, end }[state.phase];
    $app.innerHTML = view();
    bind();
  }
  tick();
}

// Updates the "who is done" list without redrawing the rest.
function tick() {
  const ul = document.getElementById('donelist');
  if (ul && state) {
    const html = state.players.map((p, i) => `<li class="${p.done ? 'done' : ''} ${p.connected ? '' : 'off'}">${av(p.name, i)}<span class="nm">${esc(p.name)}</span></li>`).join('');
    if (ul.innerHTML !== html) ul.innerHTML = html;
  }
}
newSetup();
render(true);
Offline.restore();

// Keeps the site's files on the phone so the game opens without internet (not when opened from disk).
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- views ----------
const RULES = `<ol class="rules">
  <li>هر راند هر کی یه جمله درباره‌ی هر چیزی می‌نویسه: درباره‌ی خودش، دوستاش، یه واقعیت علمی یا یه نکته‌ی خفن.</li>
  <li>خودش مخفیانه می‌گه این جمله <b>✅ راسته</b> یا <b>❌ دروغه</b>.</li>
  <li>بقیه بدون اینکه بدونن مال کیه، به هر جمله رأی می‌دن: راسته یا دروغه؟</li>
  <li>هر کی به جمله‌ی تو رأی اشتباه بده، <b>یه امتیاز</b> برای تو.</li>
  <li>آخر بازی هر کی بیشتر از همه بقیه رو گول زده باشه برنده‌ست! 😈</li>
  <li>کلمه‌ی بد ممنوعه 😇</li></ol>`;

// The first screen: players' names and rounds, then the game starts.
function newSetup() {
  let saved = [];
  try { saved = JSON.parse(store.get('ayaa.localNames') || '[]'); } catch (e) {}
  setup = { names: saved.length >= 2 ? saved : ['', ''], rounds: Number(store.get('ayaa.localRounds')) || 3 };
}

function home() {
  const st = setup;
  return `
  <div class="logo"><span class="emoji">🤥</span><h1>آیا این داستان واقعیست؟</h1><p>یه جمله بگو، بقیه رو گول بزن!</p></div>
  <div class="card">
    <h2>بازیکن‌ها (${fa(st.names.length)} نفر)</h2>
    <div class="names">${st.names.map((n, i) => `<div class="namerow">${av(n || '?', i)}
      <input type="text" maxlength="16" data-name="${i}" value="${esc(n)}" placeholder="اسم بازیکن ${fa(i + 1)}" autocomplete="off">
      ${st.names.length > 2 ? `<button class="x" data-del="${i}" aria-label="حذف">✕</button>` : ''}</div>`).join('')}</div>
    ${st.names.length < 20 ? '<button class="btn ghost" data-act="addname">➕ بازیکن جدید</button>' : ''}
  </div>
  <div class="card">
    <div class="setrow" style="border-top:0;padding-top:0"><span>تعداد راندها</span><div class="mini"><button data-lrounds="-1" aria-label="کمتر">−</button><b>${fa(st.rounds)}</b><button data-lrounds="1" aria-label="بیشتر">+</button></div></div>
    <button class="btn green" data-act="startlocal">🚀 شروع بازی</button>
    <p class="muted small center" style="margin:10px 0 0">📱 گوشی دست‌به‌دست می‌چرخه و هر کی نوبتش شد، جمله‌ش رو می‌نویسه</p>
  </div>
  <button class="linkbtn" data-act="rules">${showRules ? 'بستن راهنما' : 'چطوری بازی کنیم؟'}</button>
  ${showRules ? `<div class="card">${RULES}</div>` : ''}`;
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

// «⋯» during a game: start over or leave.
function menuHtml() {
  if (!showMenu) return '';
  return `<div class="sheet-bg" data-act="menu"></div>
  <div class="sheet" role="dialog" aria-label="منو">
    <button class="btn yellow" data-act="restart">🔁 شروع دوباره</button>
    <p class="muted small center">امتیازهای این بازی پاک می‌شه و از راند اول با همین اسم‌ها شروع می‌شه.</p>
    <button class="btn pink" data-act="leave">🚪 خروج از بازی</button>
    <button class="btn ghost" data-act="menu">ادامه‌ی بازی</button>
  </div>`;
}

function topbar() {
  const s = state;
  return `${menuHtml()}<div class="topbar">
    <button class="pill menu-btn" data-act="menu" aria-label="منو">⋯</button>
    <span class="pill">راند ${fa(s.roundNo)} از ${fa(s.totalRounds)}</span>
  </div>`;
}

// Nothing moves on by itself: whoever holds the phone presses «بعدی».
const nextBtn = label => `<button class="btn green" data-act="next">${label}</button>`;

// Everyone has written / voted: nothing happens until someone presses «بعدی».
function allDoneScreen(title, label) {
  return `${topbar()}
  <div class="card center"><div class="said" style="font-size:24px">${title}</div></div>
  ${nextBtn(label)}
  <div class="card" style="margin-top:16px"><ul class="players" id="donelist"></ul></div>`;
}

const truthBadge = t => t ? '<span class="tf yes">✅ راست</span>' : '<span class="tf no">❌ دروغ</span>';

function write() {
  const s = state;
  if (s.allDone) return allDoneScreen('همه نوشتن! ✍️', '▶ بریم رأی بدیم');
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
  if (s.allDone) return allDoneScreen('همه رأی دادن! 🗳️', '▶ بریم سراغ جواب‌ها');
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
  <button class="btn green" data-act="sendvotes" ${left ? 'disabled' : ''}>${left ? `هنوز ${fa(left)} تا مونده` : '🗳️ ثبت رأی‌ها'}</button>`;
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
  ${nextBtn(i < s.reveal.length - 1 ? '▶ جمله‌ی بعدی' : s.roundNo >= s.totalRounds ? '🏆 نتیجه‌ی نهایی' : '▶ جدول امتیاز')}`;
}

function boardHtml(showGain) {
  const s = state;
  const sorted = s.players.slice().sort((a, b) => b.score - a.score);
  const medal = ['🥇', '🥈', '🥉'];
  return `<ul class="board">${sorted.map((p, k) => {
    const g = s.gains && s.gains[p.id];
    return `<li style="animation-delay:${k * 0.07}s"><span class="rank">${medal[k] || fa(k + 1)}</span><span class="nm">${esc(p.name)}</span>
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
  ${nextBtn('▶ راند بعدی')}`;
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
  <button class="btn yellow" data-act="again">🔁 بازی دوباره</button>
  <button class="linkbtn" data-act="leave">بازیکن‌های جدید</button>`;
}

// Ends the game on this phone and goes back to the first screen (players' names).
function leaveGame() {
  showMenu = false;
  Offline.quit();
  state = null;
  gate = null;
  newSetup();
  render(true);
}

// ---------- actions ----------
function bind() {
  const sayEl = document.getElementById('say');
  if (sayEl) {
    sayEl.addEventListener('input', () => { draft.text = sayEl.value; });
    if (!draft.text) sayEl.focus({ preventScroll: true });
  }

  $app.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'addname') { readNames(); setup.names.push(''); render(true); const l = $app.querySelectorAll('[data-name]'); l[l.length - 1].focus(); }
    else if (act === 'startlocal') {
      readNames();
      const list = setup.names.map(n => n.trim()).filter(Boolean);
      if (list.length < 2) return toast('حداقل ۲ تا اسم بنویس ✍️');
      if (new Set(list.map(AyaCore.normalize)).size !== list.length) return toast('دو تا اسم یکسانه. اسم‌ها باید فرق کنن.');
      store.set('ayaa.localNames', JSON.stringify(list));
      store.set('ayaa.localRounds', String(setup.rounds));
      gate = null;
      Offline.start(list, { rounds: setup.rounds });
    }
    else if (act === 'iam') { gate = state.turn.id; render(true); }
    else if (act === 'rules') { showRules = !showRules; render(true); }
    else if (act === 'say') submitStatement();
    else if (act === 'sendvotes') {
      send('votes', voteDraft, res => { if (res && !res.ok && res.msg) toast(res.msg); });
    }
    else if (act === 'next') send('next');
    else if (act === 'again') send('again');
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
  function readNames() {
    if (!setup) return;
    $app.querySelectorAll('[data-name]').forEach(el => { setup.names[+el.dataset.name] = el.value; });
  }

  function submitStatement() {
    const text = sayEl.value.trim();
    if (!text) return toast('یه جمله بنویس!');
    if (typeof draft.truth !== 'boolean') return toast('بگو این جمله راسته یا دروغ ✅❌');
    send('statement', { text, truth: draft.truth }, res => {
      if (res.ok) return;
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
