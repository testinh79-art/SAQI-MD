// writes the live pair URL into the repo so Saqib can always read the latest link
const fs = require('fs');
const url = process.argv[2] || '';
const out = { url, at: new Date().toISOString() };
try { fs.writeFileSync('PAIR-URL.json', JSON.stringify(out, null, 2)); } catch (e) {}
console.log('[PAIR-URL] ' + (url || 'none'));
