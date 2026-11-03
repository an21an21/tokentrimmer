'use strict';
const fs = require('node:fs');
const { compressRequest } = require('../src/messages');
const cases = require('./payloads');
const out = cases.map(([name, messages]) => {
  const tt = {};
  for (const mode of ['safe', 'balanced', 'aggressive']) {
    const r = compressRequest({ model: 'claude-sonnet-5-5', messages }, 'anthropic', { mode, keepRecent: 2, maxToolChars: 12000 });
    tt[mode] = r.body.messages;
  }
  return { name, original: messages, tokentrimmer: tt };
});
fs.writeFileSync(__dirname + '/out/cases.json', JSON.stringify(out));
console.log('exported', out.length, 'cases');
