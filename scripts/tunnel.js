// exposes the bot's own web server (portal + /api/pair) at a public https URL
const lt = require('localtunnel');
const PORT = Number(process.env.PORT || 3000);
(async () => {
  try {
    const SUB = process.env.TUNNEL_SUB || 'saqimdpair';
    let t = null;
    for (const sub of [SUB, undefined]) {
      for (let i = 0; i < 4 && !t; i++) {
        try { t = await lt(sub ? { port: PORT, subdomain: sub } : { port: PORT }); }
        catch (e) { console.log('[TUNNEL] try', sub || 'random', 'fail:', e.message); await new Promise(r => setTimeout(r, 3000)); }
      }
      if (t) break;
    }
    if (!t) { console.log('[TUNNEL] FAIL — koi tunnel nahi bana'); process.exit(1); }
    console.log('[TUNNEL] PUBLIC_URL=' + t.url);
    t.on('close', () => { console.log('[TUNNEL] closed'); process.exit(0); });
    t.on('error', (e) => console.log('[TUNNEL] err', e.message));
    setInterval(() => {}, 60000);
  } catch (e) { console.log('[TUNNEL] fail:', e.message); process.exit(1); }
})();
