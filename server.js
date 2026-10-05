/* SAQI-MD — Pairing Server (Vercel-ready + standalone)
 *
 * GET  /            -> web UI (public/index.html)
 * POST /api/pair    -> {number} -> {ok, id, code}
 * GET  /pair?phone= -> JSON API (same kaam, URL-only access)
 * GET  /api/status/:id -> {ok, status, code, linked}
 *
 * v4: Vercel-safe lazy init — har require getApp() ke andar hota hy, aur koi bhi
 * boot error 500 me plainly report hota hy (FUNCTION_INVOCATION_FAILED ka pata nahi,
 * asli error dikhta hy). Standalone (node server.js) par wahi purana server chalta hy.
 * Worker (index.js) bhi is module ko require kar sakta hy (app use milta hy).
 */

let _app = null;

async function getApp() {
  if (_app) return _app;

  const express = require('express');
  const path = require('path');
  const crypto = require('crypto');
  const pino = require('pino');
  const config = require('./config');
  const { useMongoAuthState } = require('./lib/mongoSession');
  // Baileys ESM hy — pehle se bundle kiya hua CJS use karo (Vercel-proof)
  const { makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = require('./lib/baileys-bundle.cjs');

  const app = express();
  app.use(express.json());
  const logger = pino({ level: 'silent' });

  const pairings = new Map(); // id -> entry
  const TTL = 5 * 60 * 1000;
  let active = null; // singleton lock

  const fmt = (code) => String(code).match(/.{1,4}/g).join('-');

  function closeActive() {
    if (!active) return;
    try { active.sock.end(); } catch {}
    pairings.delete(active.id);
    active = null;
  }

  // Vercel serverless: response ke baad process mar jata hy — pairing handshake
  // complete karne ke liye event-loop ko zinda rakho.
  function holdServerlessAlive(ms) {
    const end = Date.now() + ms;
    const t = setInterval(() => { if (Date.now() > end) clearInterval(t); }, 5000);
    if (t.unref) t.unref(); // standalone server par process band nahi karna
  }

  async function createPairing(number) {
    closeActive();
    const id = crypto.randomBytes(8).toString('hex');
    // multi-user: har number ka apna session — isi se worker use uthata hy
    const sessionId = `${config.SESSION_PREFIX}:${number}`;

    const { state, saveCreds } = await useMongoAuthState(config.MONGODB_URI, sessionId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      markOnlineOnConnect: true,
      syncFullHistory: false,
    });

    const entry = { id, sock, code: null, number, status: 'connecting', createdAt: Date.now(), __attempts: 0 };
    pairings.set(id, entry);
    active = entry;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect } = u;
      if (connection === 'open') {
        entry.status = 'linked';
        console.log(`[PAIR] ${number} LINKED — session saved (${config.MONGODB_URI ? 'MongoDB' : 'file'})`);
        active = null;
        holdServerlessAlive(10 * 1000); // ek dafa save ho gaya, ab free
      }
      if (connection === 'close' && entry.status !== 'linked') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          entry.status = 'logged_out';
          return;
        }
        entry.status = 'reconnecting';
        setTimeout(() => {
          if (pairings.get(id) === entry) requestCode(entry).catch(() => {});
        }, 2000);
      }
    });

    setTimeout(() => {
      const cur = pairings.get(id);
      if (cur && cur.status !== 'linked') {
        try { cur.sock.end(); } catch {}
        pairings.delete(id);
        if (active === cur) active = null;
      }
    }, TTL);

    holdServerlessAlive(config.PAIR_SOCKET_TTL_MS);
    await requestCode(entry);
    return entry;
  }

  async function requestCode(entry) {
    const attempt = ++entry.__attempts;
    if (attempt > 5) { entry.status = 'error'; return; }
    if (entry.status === 'linked' || !pairings.has(entry.id)) return;

    // FAST PATH: socket pehle se WhatsApp se juda ho to foran code mango.
    // Pehle yahan har dafa fixed 3s sleep hoti thi — isi se code late aata tha.
    // Ab sirf tab intezar karte hain jab socket abhi tayyar na ho, aur wo bhi
    // chhote-chhote steps me (200ms), taake jitni jaldi socket ready ho utni jaldi
    // code nikal jaye — average 3s+ ki jaga ~0.5-1.5s.
    if (!entry.sock?.ws?.isOpen) {
      const deadline = Date.now() + 8000; // socket ready hone ka max intezar
      while (Date.now() < deadline) {
        if (entry.status === 'linked' || !pairings.has(entry.id)) return;
        if (entry.sock?.ws?.isOpen) break;
        await new Promise(r => setTimeout(r, 200));
      }
    }
    if (entry.status === 'linked' || !pairings.has(entry.id)) return;

    try {
      const code = await entry.sock.requestPairingCode(entry.number);
      entry.code = code;
      entry.status = 'code_ready';
      console.log(`[PAIR] ${entry.number} -> ${fmt(code)} (attempt ${attempt}, ${Date.now() - entry.createdAt}ms)`);
    } catch (e) {
      console.log(`[PAIR] code fail (attempt ${attempt}): ${e.message}`);
      if (attempt < 5) setTimeout(() => requestCode(entry).catch(() => {}), 1200);
      else entry.status = 'error';
    }
  }

  // ---------- Mongo pair-queue (Vercel 60s cap ka hal) ----------
  // Vercel serverless par baileys socket 60s me mar jata hy — is liye pairing ka
  // asli kaam 24/7 worker karta hy. Portal sirf request queue karta hy aur code
  // Mongo se uthata hy. File-mode (bina Mongo) par purana direct flow chalta hy.
  const mongoose = require('mongoose');
  let _prModel = null;
  async function queueDB() {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    }
    if (!_prModel) {
      const s = new mongoose.Schema({ _id: String, number: String, status: String, code: String, createdAt: Date }, { collection: 'pair_requests' });
      _prModel = mongoose.models.PairRequest || mongoose.model('PairRequest', s);
    }
    return _prModel;
  }

  // ---------- routes ----------
  // MAINT: stale pair_requests saaf karo (dead code cache ka ilaaj). Key-protected.
  app.all('/api/maintenance/pair-clear', async (req, res) => {
    const key = String(req.query.key || req.body?.key || '');
    if (key !== (config.SESSION_PREFIX || 'saqi-md')) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    try {
      if (!config.MONGODB_URI) return res.json({ ok: true, mode: 'file', cleared: 0 });
      const PR = await queueDB();
      const before = await PR.find({}).lean();
      const r = await PR.deleteMany({});
      console.log(`[MAINT] pair_requests cleared: ${r.deletedCount}`);
      return res.json({ ok: true, cleared: r.deletedCount, before: before.map(d => ({ id: d._id, status: d.status, code: d.code, createdAt: d.createdAt })) });
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }
  });

  app.post('/api/pair', async (req, res) => {
    const number = String(req.body?.number || '').replace(/[^0-9]/g, '');
    if (!number || number.length < 10 || number.length > 15) {
      return res.json({ ok: false, error: 'Number ghalat hy — country code ke sath likho (e.g. 92300XXXXXXX)' });
    }
    try {
      if (config.MONGODB_URI) {
        const PR = await queueDB();
        const ex = await PR.findById(number).lean().catch(() => null);
        // BUG FIX: pehle `ready` doc 10 min tak cache hota tha — magar us code ka
        // socket 5 min me mar jata hy, to user ko DEAD code milta rehta tha aur
        // link kabhi nahi hota. Ab: sirf `linked` ya 90s se kam purana `pending`
        // reuse karo. `ready`/`error`/purana sab force-refresh ho kar naya code le.
        const age = ex ? Date.now() - new Date(ex.createdAt || 0).getTime() : Infinity;
        const reuse = ex && (
          ex.status === 'linked' ||
          (ex.status === 'pending' && age < 90 * 1000)
        );
        if (reuse) {
          return res.json({ ok: true, id: number, code: ex.code || null, status: ex.status });
        }
        await PR.findOneAndUpdate(
          { _id: number },
          { number, status: 'pending', code: null, createdAt: new Date() },
          { upsert: true }
        );
        return res.json({ ok: true, id: number, code: null, status: 'pending' });
      }
      const entry = await createPairing(number);
      // FAST PATH: agar code pehle hi ban gaya to foran wapis do (front-end ko
      // ek bhi poll cycle ka intezar nahi karna padega).
      if (entry.code) return res.json({ ok: true, id: entry.id, code: fmt(entry.code) });
      // warna 4s tak khud intezar karo — zyada tar cases me code itni dair me aa jata hy,
      // is se front-end ko turant milta hy (Vercel par 60s limit hy, 4s safe hy).
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (entry.code || entry.status === 'linked' || entry.status === 'error') break;
        await new Promise(r => setTimeout(r, 150));
      }
      if (entry.code) return res.json({ ok: true, id: entry.id, code: fmt(entry.code) });
      res.json({ ok: true, id: entry.id, code: null, status: entry.status });
    } catch (e) {
      console.error('[PAIR] create fail:', e.message);
      res.json({ ok: false, error: 'Server busy hy — thori dair baad try karo.' });
    }
  });

  app.get('/pair', async (req, res) => {
    const number = String(req.query.phone || '').replace(/[^0-9]/g, '');
    if (!number || number.length < 10) {
      return res.json({ ok: false, error: 'Use /pair?phone=92300XXXXXXX' });
    }
    try {
      const entry = await createPairing(number);
      res.json({ ok: true, id: entry.id, code: entry.code ? fmt(entry.code) : null, status: entry.status });
    } catch (e) {
      res.json({ ok: false, error: 'Server busy hy — thori dair baad try karo.' });
    }
  });

  app.get('/api/status/:id', async (req, res) => {
    try {
      if (config.MONGODB_URI) {
        const PR = await queueDB();
        const doc = await PR.findById(req.params.id).lean().catch(() => null);
        if (!doc) return res.json({ ok: false, status: 'expired' });
        // BUG FIX: 'ready' par atka hua doc jo 6 min se purana hy = pairing waqt par nahi hui,
        // session safai ho chuki hy. Use 'expired' report karo taake user naya code le sake.
        const age = Date.now() - new Date(doc.createdAt || 0).getTime();
        if (doc.status === 'ready' && age > 6 * 60 * 1000) {
          // purana code MAT do — front-end use dikha dega aur user dead code try karta rahega
          return res.json({ ok: true, status: 'expired', code: null, linked: false });
        }
        return res.json({ ok: true, status: doc.status, code: doc.code || null, linked: doc.status === 'linked' });
      }
    } catch (e) {
      return res.json({ ok: false, status: 'expired' });
    }
    const e = pairings.get(req.params.id);
    if (!e) return res.json({ ok: false, status: 'expired' });
    if (!e.code && e.status !== 'linked' && Date.now() - e.createdAt < 90 * 1000) {
      return res.json({ ok: true, status: 'starting', code: null });
    }
    res.json({ ok: true, status: e.status, code: e.code ? fmt(e.code) : null, linked: e.status === 'linked' });
  });

  // HEALTH: pehle ye hamesha ok:true deta tha — chahe koi session zinda na ho. Railway
  // ko pata nahi chalta tha ke bot mar chuka hy. Ab asli halat batata hy: kitne sessions
  // mojood hain, kitne connected hain. `healthy` sirf tab true hy jab koi session ho aur
  // wo juda hua ho (ya koi session ho hi na — naya setup).
  app.get('/health', (req, res) => {
    let sessionsInfo = { total: 0, connected: 0, healthy: true };
    try {
      const S = global.__SAQI_SESSIONS;
      if (S && typeof S.size === 'number') {
        let conn = 0;
        for (const [, e] of S) { if (e && e.user) conn++; }
        sessionsInfo = { total: S.size, connected: conn, healthy: S.size === 0 || conn > 0 };
      }
    } catch {}
    res.json({
      ok: true,
      service: 'saqi-md-pair',
      build: 'v18-stable',
      active: !!active,
      sessions: sessionsInfo.total,
      connected: sessionsInfo.connected,
      healthy: sessionsInfo.healthy,
      uptime: Math.round(process.uptime()),
      heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  _app = app;
  return app;
}

// Export: agar worker ise `app.use()` se mount karta hy to usay asli EXPRESS APP
// chahiye — warna `app(req,res)` poora request kha jata hy aur `next()` kabhi call nahi
// hota, jis se worker ke baad ke routes (/health, /diag/*) DEAD ho jate hain.
// Is liye hum function par `.expressApp` laga dete hain; worker usay prefer karta hy.
const _export = async (req, res) => {
  try {
    const app = await getApp();
    app(req, res);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      stack: String(e.stack || '').split('\n').slice(0, 5).join('\n'),
    });
  }
};
// worker.js mount ke liye: `const portal = require('./server'); portal.expressApp`
_export.expressApp = getApp;
module.exports = _export;

const PORT = process.env.PORT || 3000;
if (require.main === module && process.env.VERCEL !== '1') { // standalone + worker mount ke ilawa
  getApp().then((app) => {
    app.listen(PORT, () => console.log(`[SAQI-MD] Pairing portal: http://localhost:${PORT}`));
  }).catch((e) => { console.error('[SAQI-MD] portal fail:', e); process.exit(1); });
}
