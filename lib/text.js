'use strict';
/*
 * Text helpers: Persian normalisation, "close enough" matching, and the bad-word filter.
 * Like «آش», some players are kids, so names and lies with rude words are refused.
 */

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

function compact(s) { return normalize(s).replace(/\s/g, ''); }

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

// Same answer after normalising, or one typo away for longer answers.
function isCloseTo(text, answer) {
  const a = compact(text), b = compact(answer);
  if (!a || !b) return false;
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  return longest >= 5 && levenshtein(a, b) <= 1;
}

// Rude words. Only their hashes are kept (lib/blocklist.json), so no rude word is written in the code.
// Whole-word hashes match one word (or two joined); "inside" hashes also match within a word.
const crypto = require('crypto');
const BL = require('./blocklist.json');
const hash = w => crypto.createHash('sha256').update('ayaa:' + w).digest('hex').slice(0, 16);
const WHOLE_SET = new Set(BL.whole);
const INSIDE = new Map();   // length -> Set of hashes
for (const e of BL.inside) {
  const [len, h] = e.split(':');
  if (!INSIDE.has(+len)) INSIDE.set(+len, new Set());
  INSIDE.get(+len).add(h);
}

function hasBadWord(text) {
  const n = normalize(text);
  if (!n) return false;
  const c = n.replace(/\s/g, '');
  for (const [len, set] of INSIDE) {
    for (let i = 0; i + len <= c.length; i++) if (set.has(hash(c.slice(i, i + len)))) return true;
  }
  const words = n.split(' ');
  for (let i = 0; i < words.length; i++) {
    if (WHOLE_SET.has(hash(words[i]))) return true;
    if (i + 1 < words.length && WHOLE_SET.has(hash(words[i] + words[i + 1]))) return true;
  }
  return false;
}

module.exports = { normalize, compact, isCloseTo, hasBadWord };
