'use strict';
/*
 * Loads the question bank. It is stored encrypted (data/questions.enc, AES-256-GCM) and is
 * decrypted in the server's memory with the password in QUESTIONS_KEY (.env). Players never get
 * the bank: the browser only sees the current question, and the real answer only at the reveal.
 * The bank is fixed: there is no way to add questions from the game or by hand.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function load() {
  const pw = process.env.QUESTIONS_KEY;
  if (!pw) throw new Error('QUESTIONS_KEY تنظیم نشده. فایل .env رو بساز (از روی .env.example).');
  const box = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'questions.enc'), 'utf8'));
  const key = crypto.scryptSync(pw, Buffer.from(box.salt, 'base64'), 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  try {
    const raw = JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
    return build(raw);
  } catch (e) {
    throw new Error('رمز QUESTIONS_KEY اشتباهه یا فایل سؤال‌ها خراب شده.');
  }
}

// Both modes in one shape: { id, kind, prompt, topic, answer, lies }.
//  - word:  a sentence with a blank; the answer is one to three words.
//  - story: a topic; the answer is a whole true sentence. Every word question also becomes a
//    story (blank filled with the answer; its lies filled in give the ready-made fakes).
function build(raw) {
  const words = raw.words.map(q => ({ id: 'w' + q.id, kind: 'word', prompt: q.question, topic: null, answer: q.answer, lies: q.lies.slice() }));
  const byTopic = {};
  for (const s of raw.stories) (byTopic[s.topic] = byTopic[s.topic] || []).push(s.fake);
  const stories = raw.stories.map(s => ({
    id: s.id, kind: 'story', prompt: s.topic, topic: s.topic, answer: s.text,
    lies: [s.fake, ...byTopic[s.topic].filter(f => f !== s.fake).slice(0, 3)],
  }));
  for (const q of raw.words) {
    stories.push({
      id: 'sw' + q.id, kind: 'story', prompt: 'واقعیت‌های عجیب', topic: 'واقعیت‌های عجیب',
      answer: q.question.replace('___', q.answer), lies: q.lies.map(l => q.question.replace('___', l)),
    });
  }
  const freeze = list => Object.freeze(list.map(q => Object.freeze({ ...q, lies: Object.freeze(q.lies) })));
  return Object.freeze({ word: freeze(words), story: freeze(stories) });
}

module.exports = load();
