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
    const list = JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
    return Object.freeze(list.map(q => Object.freeze({ ...q, lies: Object.freeze(q.lies.slice()) })));
  } catch (e) {
    throw new Error('رمز QUESTIONS_KEY اشتباهه یا فایل سؤال‌ها خراب شده.');
  }
}

module.exports = load();
