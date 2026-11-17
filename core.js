/*
 * «آیا این داستان واقعیست؟» — the shared core.
 * The game's rules, in one place (window.AyaCore in the browser; also loadable with require in Node):
 *   - text: Persian normalising, "close enough" answers, the casual story look, the bad-word filter
 *   - rounds: sentences marked true/false, votes, scoring, the reveal and the round table
 * (The old word and story question bank stays in data/bank.json but is not used for now.)
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

  // ---------- rounds ----------
  // Every round, each player writes one sentence about anything (themselves, a friend, a fact)
  // and secretly marks it true or false. Everyone votes true/false on the others' sentences.
  // Each wrong vote on your sentence is a point for you: whoever fools the most votes wins.
  //
  // A room is { players: Map(id -> {id, name, score}), settings: {rounds}, roundNo, round, phase }.
  // round = { statements: {pid: {text, truth}}, votes: {pid: {sid: bool}}, order: [{id, author}],
  //           reveal: [...], summary: [...], gains: {pid: n} }
  const MAX_LEN = 160;

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function newRound(room) {
    room.roundNo += 1;
    room.round = { statements: {}, votes: {}, order: [], reveal: [], revealStep: 0, summary: null, gains: {} };
  }

  const cleanStatement = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);

  // Checks a sentence; returns an error message, or null when it is fine.
  function statementProblem(text, hasBadWord) {
    if (!text) return 'یه جمله بنویس!';
    if (compact(text).length < 4) return 'یه کم بیشتر بنویس 🙂';
    if (hasBadWord(text)) return 'کلمه‌ی بد ممنوعه! یه جمله‌ی مؤدبانه بنویس 😇';
    return null;
  }

  // End of writing: the sentences in random order, without names.
  function finishWriting(room) {
    const r = room.round;
    r.order = shuffle(Object.keys(r.statements)).map((author, i) => ({ id: 's' + i, author }));
  }

  // The sentences a player has to vote on: everyone's but their own.
  const toVote = (room, pid) => room.round.order.filter(o => o.author !== pid);
  const votedAll = (room, pid) => toVote(room, pid).every(o => typeof (room.round.votes[pid] || {})[o.id] === 'boolean');

  // Keeps only real votes (true/false) on sentences that aren't the player's own.
  function cleanVotes(room, pid, votes) {
    const out = {};
    for (const o of toVote(room, pid)) if (votes && typeof votes[o.id] === 'boolean') out[o.id] = votes[o.id];
    return out;
  }

  // Everyone has written (write phase) or voted on every sentence (vote phase). Nothing moves on
  // by itself: when this is true, someone presses «بعدی».
  function allDone(room) {
    const r = room.round, list = [...room.players.values()];
    if (!r || !list.length) return false;
    if (room.phase === 'write') return list.every(p => r.statements[p.id]);
    if (room.phase === 'vote') return list.every(p => r.votes[p.id] && votedAll(room, p.id));
    return false;
  }

  // A player who leaves in the middle of a game is taken out of the round too.
  function removeFromRound(room, pid) {
    const r = room.round;
    if (!r) return;
    delete r.statements[pid];
    delete r.votes[pid];
    if (room.phase === 'vote') {
      const gone = r.order.filter(o => o.author === pid).map(o => o.id);
      r.order = r.order.filter(o => o.author !== pid);
      for (const v of Object.values(r.votes)) for (const id of gone) delete v[id];
    }
  }

  // End of voting: points, the reveal steps (shown one by one with «بعدی») and the round table.
  function finishVoting(room) {
    const r = room.round;
    const name = pid => (room.players.get(pid) || { name: '؟' }).name;
    const gains = {};
    const steps = r.order.map(o => {
      const st = r.statements[o.author];
      const fooled = [], right = [];
      for (const [pid, v] of Object.entries(r.votes)) {
        if (pid === o.author || typeof v[o.id] !== 'boolean') continue;
        (v[o.id] === st.truth ? right : fooled).push(name(pid));
      }
      gains[o.author] = (gains[o.author] || 0) + fooled.length;
      return { text: st.text, truth: st.truth, author: name(o.author), authorId: o.author, fooled, right };
    });
    for (const [pid, n] of Object.entries(gains)) {
      const p = room.players.get(pid);
      if (p) p.score += n;
    }
    r.reveal = steps;
    r.summary = steps.slice().sort((a, b) => b.fooled.length - a.fooled.length);
    r.gains = gains;
    r.revealStep = 0;
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
      allDone: allDone(room),
      players: [...room.players.values()].map(p => ({
        id: p.id, name: p.name, score: p.score, connected: p.connected !== false,
        done: r ? (room.phase === 'write' ? !!r.statements[p.id] : room.phase === 'vote' ? votedAll(room, p.id) && !!r.votes[p.id] : false) : false,
      })),
      me: me ? { id: me.id, name: me.name } : null,
    };
    if (r) {
      if (room.phase === 'write') s.mine = r.statements[forId] || null;
      if (room.phase === 'vote') {
        s.statements = r.order.map(o => ({ id: o.id, text: r.statements[o.author].text, mine: o.author === forId }));
        s.myVotes = r.votes[forId] || null;
      }
      if (room.phase === 'reveal' || room.phase === 'scores' || room.phase === 'end') {
        s.reveal = r.reveal;
        s.revealStep = r.revealStep || 0;
        s.gains = r.gains;
        s.summary = r.summary;
      }
    }
    return s;
  }

  return {
    normalize, compact, isCloseTo, casual, sha256hex, badWordChecker,
    shuffle, newRound, cleanStatement, statementProblem, finishWriting, toVote, votedAll, cleanVotes, allDone, removeFromRound,
    finishVoting, viewState,
  };
});
