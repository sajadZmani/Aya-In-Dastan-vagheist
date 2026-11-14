'use strict';
/*
 * Loads the question bank (data/bank.json). Players never get the bank: the browser only sees the
 * current question, and the real answer only at the reveal. The bank is fixed: there is no way
 * to add questions from the game.
 */
const { casual } = require('./text');
const raw = require('../data/bank.json');

// Both modes in one shape: { id, kind, prompt, topic, answer, lies }.
//  - word:  a sentence with a blank; the answer is one to three words.
//  - story: a topic; the answer is a whole true sentence. Every word question also becomes a
//    story (blank filled with the answer; its lies filled in give the ready-made fakes).
function build(raw) {
  const words = raw.words.map(q => ({ id: 'w' + q.id, kind: 'word', prompt: q.question, topic: null, answer: q.answer, lies: q.lies.slice() }));
  // Ready-made fakes per topic: each story's own twin plus the standalone fake stories.
  const byTopic = {};
  const addFake = (topic, text) => (byTopic[topic] = byTopic[topic] || []).push(text);
  for (const s of raw.stories) addFake(s.topic, s.fake);
  for (const f of raw.fakes || []) addFake(f.topic, f.text);
  const general = (raw.fakes || []).map(f => f.text);
  const stories = raw.stories.map(s => ({
    id: s.id, kind: 'story', prompt: s.topic, topic: s.topic, answer: casual(s.text),
    lies: [s.fake, ...byTopic[s.topic].filter(f => f !== s.fake)].map(casual),
  }));
  for (const q of raw.words) {
    stories.push({
      id: 'sw' + q.id, kind: 'story', prompt: 'واقعیت‌های عجیب', topic: 'واقعیت‌های عجیب',
      answer: casual(q.question.replace('___', q.answer).replace(/ است\./, 'ه')),
      lies: [...q.lies.map(l => q.question.replace('___', l).replace(/ است\./, 'ه')), ...general].map(casual),
    });
  }
  const freeze = list => Object.freeze(list.map(q => Object.freeze({ ...q, lies: Object.freeze(q.lies) })));
  return Object.freeze({ word: freeze(words), story: freeze(stories) });
}

module.exports = build(raw);
