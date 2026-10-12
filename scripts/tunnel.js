// exposes the bot's own web server (portal + /api/pair) at a public https URL
const lt = require('localtunnel');
const PORT = Number(process.env.PORT || 3000);
(async () => {
  try {
    const SUB = process.env.TUNNEL_SUB || 'saqimdpair';
    const t = await lt({ port: PORT, subdomain: SUB });
    console.log('[TUNNEL] PUBLIC_URL=' + t.url);
    t.on('close', () => { console.log('[TUNNEL] closed'); process.exit(0); });
    t.on('error', (e) => console.log('[TUNNEL] err', e.message));
    setInterval(() => {}, 60000);
  } catch (e) { console.log('[TUNNEL] fail:', e.message); process.exit(1); }
})();
