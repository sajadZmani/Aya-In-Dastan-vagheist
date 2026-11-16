/*
 * «آیا این داستان واقعیست؟» — the shared core.
 * The same file runs on the server (require) and in the browser (window.AyaCore), so online rooms
 * and the offline one-phone game follow exactly the same rules:
 *   - text: Persian normalising, "close enough" answers, the casual story look, the bad-word filter
 *   - bank: turning data/bank.json into questions for both modes
 *   - rounds: picking a question, filling in lies and options, scoring, the reveal and vote table
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AyaCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- text ----------
  const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

  // Lower-cases, unifies ي/ی ك/ک ة/ه أإآ/ا, digits, drops ZWNJ/diacritics/punctuation, collapses spaces.
  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[يى]/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/ة/g, 'ه')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ؤ/g, 'و')
      .replace(/[۰-۹]/g, d => String(FA_DIGITS.indexOf(d)))
      .replace(/[٠-٩]/g, d => String(AR_DIGITS.indexOf(d)))
      .replace(/[ً-ٰٟـ]/g, '')        // harakat, tatweel
      .replace(/[‌‍‎‏]/g, '')         // ZWNJ etc.: "می‌شه" == "میشه"
      .replace(/[.,،؛;:!?؟"'«»()\[\]{}\-_/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const compact = s => normalize(s).replace(/\s/g, '');

  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  // Same answer after normalising, or one typo away for a word (about one in twenty letters for a sentence).
  function isCloseTo(text, answer) {
    const a = compact(text), b = compact(answer);
    if (!a || !b) return false;
    if (a === b) return true;
    const longest = Math.max(a.length, b.length);
    if (longest < 5) return false;
    return levenshtein(a, b) <= Math.max(1, Math.floor(longest / 20));
  }

  // Story mode: every option gets the same chatty look (no punctuation, quotes or brackets,
  // half-spaces typed the way people type on a phone), so neat writing doesn't give the real one away.
  function casual(text) {
    return String(text || '')
      .replace(/[ً-ٰٟـ]/g, '')
      .replace(/ه‌ی(?=\s|$)/g, 'ه')                     // «زنده‌ی» -> «زنده»
      .replace(/(^|\s)(ن?می)‌/g, '$1$2')                 // «می‌شه» -> «میشه»
      .replace(/‌/g, ' ')
      .replace(/[.,،؛;:!?؟"'«»“”()\[\]{}…\-–—_/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Small synchronous SHA-256 (UTF-8), so the browser and the server hash words the same way.
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256hex(str) {
    const bytes = Array.from(unescape(encodeURIComponent(str)), c => c.charCodeAt(0));
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 0xff);
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const W = new Array(64);
    const rot = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < bytes.length; off += 64) {
      for (let t = 0; t < 16; t++) W[t] = (bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) | (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3];
      for (let t = 16; t < 64; t++) {
        const s0 = rot(W[t - 15], 7) ^ rot(W[t - 15], 18) ^ (W[t - 15] >>> 3);
        const s1 = rot(W[t - 2], 17) ^ rot(W[t - 2], 19) ^ (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let t = 0; t < 64; t++) {
        const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
        const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  // Rude words are kept only as hashes (data/blocklist.json), so none is written anywhere.
  // Whole-word hashes match one word (or two joined); "inside" hashes also match within a word.
  function badWordChecker(blocklist) {
    const hash = w => sha256hex('ayaa:' + w).slice(0, 16);
    const whole = new Set(blocklist.whole);
    const inside = new Map();
    for (const e of blocklist.inside) {
      const [len, h] = e.split(':');
      if (!inside.has(+len)) inside.set(+len, new Set());
      inside.get(+len).add(h);
    }
    return function hasBadWord(text) {
      const n = normalize(text);
      if (!n) return false;
      const c = n.replace(/\s/g, '');
      for (const [len, set] of inside) {
        for (let i = 0; i + len <= c.length; i++) if (set.has(hash(c.slice(i, i + len)))) return true;
      }
      const words = n.split(' ');
      for (let i = 0; i < words.length; i++) {
        if (whole.has(hash(words[i]))) return true;
        if (i + 1 < words.length && whole.has(hash(words[i] + words[i + 1]))) return true;
      }
      return false;
    };
  }

  // ---------- bank ----------
  // Both modes in one shape: { id, kind, prompt, topic, answer, lies, extra }.
  //  - word:  a sentence with a blank; the answer is one to three words.
  //  - story: a topic; the answer is a whole true sentence. Ready-made fakes are the story's own twin
  //    and the other fakes of its topic; `extra` (other topics' fake stories) is only a fallback.
  function buildBank(raw) {
    const words = raw.words.map(q => ({ id: 'w' + q.id, kind: 'word', prompt: q.question, topic: null, answer: q.answer, lies: q.lies.slice(), extra: [] }));
    const byTopic = {};
    const addFake = (topic, text) => (byTopic[topic] = byTopic[topic] || []).push(text);
    for (const s of raw.stories) addFake(s.topic, s.fake);
    for (const f of raw.fakes || []) addFake(f.topic, f.text);
    const stories = raw.stories.map(s => ({
      id: s.id, kind: 'story', prompt: s.topic, topic: s.topic, answer: casual(s.text),
      lies: [s.fake, ...byTopic[s.topic].filter(f => f !== s.fake)].map(casual),
      extra: (raw.fakes || []).filter(f => f.topic !== s.topic).map(f => casual(f.text)),
    }));
    return { word: words, story: stories };
  }

  // ---------- rounds ----------
  // A room is { players: Map(id -> {id, name, score}), settings: {mode, rounds}, roundNo, round, used }.
  // `used` is { word: Set, story: Set } of question ids the room (or the phone) has had already.
  const POINTS_TRUTH = 1000;
  const POINTS_FOOLED = 500;
  const REVEAL_STEP_SECONDS = 4.5;

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // A question the room has not had yet; only when every one is used does the bank start over.
  function pickQuestion(room, bank) {
    const mode = room.settings.mode;
    const used = room.used[mode];
    let pool = bank[mode].filter(q => !used.has(q.id));
    if (!pool.length) { used.clear(); pool = bank[mode].slice(); }
    const q = pool[Math.floor(Math.random() * pool.length)];
    used.add(q.id);
    return q;
  }

  function newRound(room, bank) {
    room.roundNo += 1;
    room.round = { q: pickQuestion(room, bank), lies: {}, picks: {}, options: [], reveal: [], gains: {}, summary: null };
  }

  // Checks a lie; returns an error message, or null when it is fine.
  function lieProblem(room, text, hasBadWord) {
    if (!text) return 'یه چیزی بنویس!';
    if (hasBadWord(text)) return 'کلمه‌ی بد ممنوعه! یه دروغ مؤدبانه بنویس 😇';
    if (isCloseTo(text, room.round.q.answer)) {
      return room.settings.mode === 'story' ? 'این همون داستان واقعیه! یه داستان دیگه بساز 🤫' : 'این جواب درسته! یه دروغ دیگه بنویس 🤫';
    }
    return null;
  }

  const cleanLie = (room, text) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, room.settings.mode === 'story' ? 160 : 40);
    return room.settings.mode === 'story' ? casual(t) : t;
  };

  // End of writing: ready-made lies for whoever wrote nothing, same lies merged, then the options.
  function finishWriting(room) {
    const r = room.round;
    const spare = shuffle(r.q.lies.filter(l => !Object.values(r.lies).some(x => compact(x.text) === compact(l))));
    for (const p of room.players.values()) {
      if (!r.lies[p.id] && spare.length) r.lies[p.id] = { text: spare.pop(), auto: true };
    }
    const byKey = new Map();
    for (const [pid, lie] of Object.entries(r.lies)) {
      const key = compact(lie.text);
      if (!byKey.has(key)) byKey.set(key, { id: 'o' + byKey.size, text: lie.text, authors: [], truth: false });
      byKey.get(key).authors.push(pid);
    }
    const lies = [...byKey.values()];
    // With few players add ready-made lies: the question's own first, then the rest of its topic,
    // then other topics. Story mode wants at least three lies so the real one is not easy to spot.
    const want = room.settings.mode === 'story' ? 3 : 2;
    for (const l of [r.q.lies[0], ...shuffle(r.q.lies.slice(1)), ...shuffle(r.q.extra || [])]) {
      if (lies.length >= want) break;
      if (!lies.some(x => compact(x.text) === compact(l))) lies.push({ id: 'o' + lies.length + 'h', text: l, authors: [], truth: false });
    }
    r.options = shuffle([...lies, { id: 'truth', text: r.q.answer, authors: [], truth: true }]);
  }

  // End of guessing: points, the reveal steps and the vote table. Returns the reveal's length in seconds.
  function finishChoosing(room) {
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
      for (const a of o.authors) add(a, pickers.length * POINTS_FOOLED * mult);
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
    r.summary = r.options.map(o => {
      const voters = pickersOf(o.id);
      return {
        text: o.text, truth: o.truth, votes: voters.length, voters: voters.map(name),
        authors: o.authors.map(a => name(a) + (r.lies[a] && r.lies[a].auto ? ' (خودکار)' : '')),
      };
    }).sort((x, y) => (y.truth - x.truth) || (y.votes - x.votes));
    r.gains = gains;
    return Math.ceil(ordered.length * REVEAL_STEP_SECONDS + 1.5);
  }

  // What a player's screen needs (without the room code and clock, which the caller adds).
  function viewState(room, forId) {
    const r = room.round;
    const me = room.players.get(forId);
    const s = {
      phase: room.phase,
      hostId: room.hostId,
      settings: room.settings,
      roundNo: room.roundNo,
      totalRounds: room.settings.rounds,
      double: room.roundNo === room.settings.rounds,
      deadline: room.deadline,
      players: [...room.players.values()].map(p => ({
        id: p.id, name: p.name, score: p.score, connected: p.connected !== false,
        done: r ? (room.phase === 'write' ? !!r.lies[p.id] : room.phase === 'choose' ? !!r.picks[p.id] : false) : false,
      })),
      me: me ? { id: me.id, name: me.name } : null,
    };
    if (r) {
      s.question = r.q.prompt;
      s.kind = r.q.kind;
      s.topic = r.q.topic || null;
      if (room.phase === 'write') s.myLie = r.lies[forId] ? r.lies[forId].text : null;
      if (room.phase === 'choose') {
        s.options = r.options.map(o => ({ id: o.id, text: o.text, mine: o.authors.includes(forId) }));
        s.myPick = r.picks[forId] || null;
      }
      if (room.phase === 'reveal' || room.phase === 'scores' || room.phase === 'end') {
        s.reveal = r.reveal;
        s.gains = r.gains;
        s.answer = r.q.answer;
        s.summary = r.summary;
      }
    }
    return s;
  }

  return {
    normalize, compact, isCloseTo, casual, sha256hex, badWordChecker,
    buildBank, shuffle, pickQuestion, newRound, lieProblem, cleanLie, finishWriting, finishChoosing, viewState,
    REVEAL_STEP_SECONDS,
  };
});
