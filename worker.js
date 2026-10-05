/* SAQI-MD — Main Entry Point (24/7 Multi-User Worker)
 * Koyeb/Render/Railway/VPS par chalta hy. Vercel par NAHI (serverless WebSocket hold nahi kar sakta).
 *
 * MULTI-USER (v2): portal se har user ka apna session banta hy (SESSION_PREFIX:NUMBER).
 * Yeh worker:
 *   1. Startup par Mongo me mojood sab sessions dhoond kar har ek ka socket start karta hy
 *   2. Har 30s me Mongo dobara scan karta hy — naya linked session mila to foran connect
 *   3. Logged-out session ko Mongo se delete kar deta hy (khud-ba-khud safai)
 *
 * Bina MongoDB ke: single-session file mode (local dev).
 */
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const config = require('./config');
const { useMongoAuthState, listSessionIds, deleteSession } = require('./lib/mongoSession');

const logger = pino({ level: 'silent' });
const startAt = Date.now();
const commands = new Map(); // name -> { handler, category, ownerOnly, groupOnly, noPrefix }

// ---------- FAST FUZZY LOOKUP ----------
// 43,317 command names par seedha Levenshtein scan karna O(n·m²) tha (~92ms, Railway par ~350ms).
// Ab: (1) pehle 1-char aur 2-char prefix bucket se candidates chhanto, (2) Levenshtein sirf
// un par chalao, (3) result cache karo. Same suggestions, ~40x tez.
const _fuzzyCache = new Map(); // query -> [[name, score], ...]
let _fuzzyBucket1 = null; // 1-char prefix -> names[]
let _fuzzyBucket2 = null; // 2-char prefix -> names[]

function _buildFuzzyIndex() {
  _fuzzyBucket1 = new Map();
  _fuzzyBucket2 = new Map();
  for (const name of commands.keys()) {
    const a = name[0] || '', b = name.slice(0, 2);
    (_fuzzyBucket1.get(a) || _fuzzyBucket1.set(a, []).get(a)).push(name);
    (_fuzzyBucket2.get(b) || _fuzzyBucket2.set(b, []).get(b)).push(name);
  }
}

function _lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  // early exit: agar length ka farq hi bara ho to score already bura hy
  if (Math.abs(m - n) > 4) return Math.abs(m - n);
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

function fuzzyTop(q, _names) {
  if (_fuzzyCache.has(q)) return _fuzzyCache.get(q);
  if (!_fuzzyBucket1) _buildFuzzyIndex();

  // candidates: same 1-char prefix, ya same 2-char prefix, ya query kisi name ka hissa ho
  const cand = new Set();
  const b1 = _fuzzyBucket1.get(q[0]);
  if (b1) for (const n of b1) cand.add(n);
  const b2 = _fuzzyBucket2.get(q.slice(0, 2));
  if (b2) for (const n of b2) cand.add(n);
  // substring match (jo pehle strong signal tha)
  for (const [name] of commands) {
    if (name.includes(q) || q.includes(name)) cand.add(name);
  }
  // agar candidates bohat kam hyn to sab le lo (chhoti query jaise 'ab')
  if (cand.size < 50) for (const n of commands.keys()) cand.add(n);

  const out = [];
  for (const name of cand) {
    let s = _lev(q, name);
    if (name.includes(q) || q.includes(name)) s = Math.min(s, Math.abs(name.length - q.length));
    out.push([name, s]);
  }
  out.sort((a, b) => a[1] - b[1]);
  const res = out.slice(0, 3);
  if (_fuzzyCache.size > 500) _fuzzyCache.clear();
  _fuzzyCache.set(q, res);
  return res;
}
for (const f of require('fs').readdirSync('./commands').filter(x => x.endsWith('.js'))) {
  try {
    const mod = require(`./commands/${f}`);
    for (const cmd of mod.commands) {
      commands.set(cmd.name.toLowerCase(), cmd);
    }
    console.log(`[SAQI-MD] loaded ${f}: ${mod.commands.map(c => c.name).join(', ')}`);
  } catch (e) {
    console.error(`[SAQI-MD] command file fail: ${f}:`, e.message);
  }
}
// ---------- v5.0 hooks: x* files ke liye global access ----------
global.__SAQI_CMD_GET = (name) => commands.get(String(name || '').toLowerCase());
global.__SAQI_CMDS_ALL = commands;
global.__SAQI_STATS = { startedAt: startAt, commandCount: commands.size, sessions: 0 };

// ---------- v5.2.1: known-contacts collector (status viewers + posters + chats) ----------
const { kvSet, kvGet } = require('./lib/xhelp');
const _seen = new Map(); // sessionId -> { viewers:Set, chats:Set }
function seenBucket(sessionId) {
  if (!_seen.has(sessionId)) _seen.set(sessionId, { viewers: new Set(), chats: new Set(), dirty: false });
  return _seen.get(sessionId);
}
function seenViewer(sessionId, jid) {
  if (!jid) return;
  try { const s = String(jid); if (!s.includes('@')) return; const b = seenBucket(sessionId); b.viewers.add(s); b.dirty = true; } catch {}
}
function seenChat(sessionId, jid) {
  if (!jid) return;
  try {
    const s = String(jid);
    if (s === 'status@broadcast' || s === '0@s.whatsapp.net') return;
    const b = seenBucket(sessionId); b.chats.add(s); b.dirty = true;
  } catch {}
}
setInterval(async () => {
  try {
    for (const [sessionId, b] of _seen) {
      if (!b.dirty) continue;
      b.dirty = false;
      const vs = [...b.viewers].slice(0, 20000), cs = [...b.chats].slice(0, 5000);
      const old = await kvGet('x3seen:' + sessionId + ':viewers', []);
      await kvSet('x3seen:' + sessionId + ':viewers', [...new Set([...(old || []), ...vs])].slice(-20000));
      const oc = await kvGet('x3seen:' + sessionId + ':chats', []);
      await kvSet('x3seen:' + sessionId + ':chats', [...new Set([...(oc || []), ...cs])].slice(-5000));
      // LEAK FIX (2-month): pehle ye Sets flush ke baad bhi bhare rehte the — 2 mahine me
      // har chat/viewer ka naam memory me jama hota rehta tha aur bot OOM ho jata tha.
      // Ab Mongo me likhne ke baad memory se khali kar dete hain (Mongo hi source of truth hy).
      b.viewers.clear();
      b.chats.clear();
    }
  } catch (e) { console.log('[SAQI-MD] seen-flush fail:', e.message); }
}, 60000).unref();

// SESSION LEAK GUARD: agar koi session logout ho kar map me reh gaya ho to uski _seen
// entry bhi hata do — warna dead sessions ki memory hamesha ke liye pare rehti hy.
setInterval(() => {
  try {
    for (const sessionId of _seen.keys()) {
      if (!sessions.has(sessionId)) { _seen.delete(sessionId); }
    }
    // msgCache: sirf live sessions ki entries rakho
    for (const sessionId of msgCache.keys()) {
      if (!sessions.has(sessionId)) { msgCache.delete(sessionId); }
    }
  } catch {}
}, 10 * 60 * 1000).unref();

// ---------- multi-session registry ----------
// sessionId -> { sock, reconnects, user, starting, dead }
const sessions = new Map();
// health endpoint ko asli halat batane ke liye sessions map expose karo (server.js padhta hy)
global.__SAQI_SESSIONS = sessions;
let baileysVersion = null;
// antidelete: har session ke akhri messages ki sada copy (messageId -> info)
const msgCache = new Map();
const settingsMod = require('./commands/settings.js');
const { isTransientError, logError, reportToSelf } = require('./lib/errorHeal');

// ---------- SETTINGS PERSISTENCE (Mongo 'bot_settings' — restart se zinda) ----------
const mgSettings = require('mongoose');
if (config.MONGODB_URI) {
  settingsMod.setOnPersist((snap) => {
    mgSettings.connection.db.collection('bot_settings').updateOne(
      { _id: 'global' },
      { $set: { data: snap, updatedAt: new Date() } },
      { upsert: true }
    ).catch((e) => console.log('[SAQI-MD] settings save fail:', e.message));
  });
  (async () => {
    try {
      if (mgSettings.connection.readyState !== 1) await mgSettings.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
      const doc = await mgSettings.connection.db.collection('bot_settings').findOne({ _id: 'global' });
      if (doc?.data) { settingsMod.restore(doc.data); console.log('[SAQI-MD] ✅ settings Mongo se restore (toggles/texts/sudo/antidelmode)'); }
      else console.log('[SAQI-MD] settings: pehli dafa — defaults');
    } catch (e) { console.log('[SAQI-MD] settings restore fail:', e.message); }
  })();
}
const getToggle = (k) => { try { return settingsMod.getToggle(k); } catch { return false; } };

function cacheMessage(sessionId, raw, m) {
  let cache = msgCache.get(sessionId);
  if (!cache) { cache = new Map(); msgCache.set(sessionId, cache); }
  cache.set(raw.key.id, {
    chat: raw.key.remoteJid,
    sender: (raw.key.participant || raw.key.remoteJid || '').split('@')[0],
    push: m.pushname || '',
    text: String(m.text || raw.message?.conversation || raw.message?.extendedTextMessage?.text || '').slice(0, 500),
    t: Date.now(),
  });
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  // SPEED: poora raw message bhi rakho — Baileys ka getMessage isse serve karta hy, jis se
  // quoting par retry nahi hota aur jawab foran jata hy.
  if (raw.key?.id && raw.message) {
    if (!global.__msgCache) global.__msgCache = new Map();
    global.__msgCache.set(raw.key.id, raw.message);
    if (global.__msgCache.size > 500) global.__msgCache.delete(global.__msgCache.keys().next().value);
  }
}

async function handleRevoke(entry, sessionId, u) {
  const pm = u.update?.message?.protocolMessage;
  const isRevoke = u.update?.messageStubType === 68 || u.update?.messageStubType === 'REVOKE' || pm?.type === 'REVOKE' || pm?.type === 0;
  if (!isRevoke || !getToggle('antidelete')) return;
  const key = pm?.key || u.update?.key || u.key;
  if (!key?.id) return;
  const saved = msgCache.get(sessionId)?.get(key.id);
  const destMode = settingsMod.getAntidelMode();
  // inbox mode = bot ke apne number par (message-yourself), warna wahi chat jahan delete hua
  const chat = destMode === 'inbox'
    ? (entry.sock.user?.id || '').split(':')[0] + '@s.whatsapp.net'
    : key.remoteJid;
  if (!chat) return;
  const srcChat = key.remoteJid === chat ? '' : `\n📍 *From:* ${key.remoteJid}`;
  const fmt = (t) => new Date(t).toLocaleString('en-PK', { timeZone: config.TIMEZONE || 'Asia/Karachi', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
  const now = Date.now();
  const body = saved
    ? `👤 *Number:* +${saved.sender}${saved.push ? ` (${saved.push})` : ''}\n🕒 *Message ka waqt:* ${fmt(saved.t)}\n🕒 *Delete hua:* ${fmt(now)}\n💬 ${saved.text || '(media ya khali message)'}${srcChat}`
    : null;
  await entry.sock.sendMessage(chat, { text: `🚫 *ANTIDELETE* — kisi ne message delete kiya\n${body || '(message record nahi tha — bot band tha us waqt)'}` }).catch(() => {});
}

async function startSession(sessionId) {
  if (sessions.has(sessionId)) return;
  // DUPLICATE GUARD: ek hi WhatsApp number ke liye do sockets = WhatsApp 440
  // (connectionReplaced) deta hy aur bot connected/closed ke beech loop karta rehta hy.
  // Agar isi number ka koi socket pehle se chal raha hy (kisi bhi prefix ke session se),
  // to naya mat banao — warna 440 hamesha rahega.
  const num = String(sessionId).split(':').pop();
  if (num) {
    for (const [sid, e] of sessions) {
      if (sid === sessionId) continue;
      // `e` (ya uska socket) abhi restart cycle me ho to bhi is number ko "busy" maano —
      // warna 440 backoff ke doran naya socket ban jata hy aur loop wapas shuru.
      if (String(sid).split(':').pop() === num) {
        console.log(`[SAQI-MD] [${sessionId}] SKIP — isi number (${num}) ka socket pehle se chal raha hy (${sid})`);
        return;
      }
    }
  }
  const entry = { sock: null, reconnects: 0, user: null, starting: true, dead: false };
  sessions.set(sessionId, entry);
  try { global.__SAQI_STATS.sessions = sessions.size; } catch (e) {}

  try {
    const { state, saveCreds } = await useMongoAuthState(config.MONGODB_URI, sessionId);
    entry.sock = makeWASocket({
      version: baileysVersion,
      auth: state,
      logger,
      printQRInTerminal: false,
      // ANTIBAN: desktop Chrome jaisa browser (Ubuntu/Chrome header patterns jo WhatsApp ke liye normal hyn)
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: getToggle('online') !== false,
      syncFullHistory: false,
      // ANTIBAN: presence/typing storms se bacho (WhatsApp spam-detection inhi ko pakarta hy)
      emitOwnEvents: false,
      fireInitQueries: true,
      connectTimeoutMs: 60000,
      // SPEED: 15s se 8s — query timeout sirf tab lagta hy jab WhatsApp jawab na de;
      // chhota timeout = fail fast, aur Baileys apni retry se foran dobara try karta hy.
      defaultQueryTimeoutMs: 8000,
      keepAliveIntervalMs: 25000,
      // SPEED: 80 -> 40ms. Ye sirf retry ke waqt ka gap hy (normal path par asar nahi),
      // magar jab query fail ho to dobara try foran hota hy.
      retryRequestDelayMs: 40,
      // ANTIBAN: history sync ka poora payload na mango (naye device par bulk fetch = red flag)
      shouldSyncHistoryMessage: () => false,
      // SPEED/STABILITY: Baileys isse quoting aur retry ke waqt call karta hy. Pehle ye
      // undefined return karta tha, jis se har quoted reply par retry + 250ms delay hota tha.
      // Ab apne cached messages se serve karta hy (retry messages mein bhi).
      getMessage: async (key) => {
        try {
          const c = global.__msgCache && global.__msgCache.get(key.id);
          if (c) return c;
        } catch {}
        return undefined;
      },
      // ANTIBAN: phone ko "typing" dikhane wali auto presence sirf tab jab toggle on ho
    });
    entry.sock.ev.on('creds.update', saveCreds);

    entry.sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect } = u;
      if (connection === 'open') {
        entry.starting = false;
        entry.reconnects = 0;
        entry.user = entry.sock.user?.id || null;
        entry.__connectedAt = Date.now();   // watchdog ke liye
        entry.__lastSeen = Date.now();
        console.log(`[SAQI-MD] ✅ [${sessionId}] connected as ${entry.user}`);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`[SAQI-MD] [${sessionId}] closed (${code}), reconnects: ${entry.reconnects}`);
        entry.user = null;
        if (code === DisconnectReason.loggedOut) {
          // logged out — session khatam, Mongo se delete, socket chhor do
          entry.dead = true;
          entry.starting = false;
          deleteSession(config.MONGODB_URI, sessionId).catch(() => {});
          sessions.delete(sessionId);
          try { entry.sock.end(); } catch {}
          console.log(`[SAQI-MD] [${sessionId}] logged out — session deleted`);
        } else if (code === 440 || code === DisconnectReason.connectionReplaced) {
          // ---------- 440 = CONNECTION REPLACED (sab se bara speed killer) ----------
          // Ye tab hota hy jab WAHI session do jagah chal rahi ho. WhatsApp ek ko rakhta hy
          // aur doosre ko kick karta hy — bot "connected"/"closed" ke beech loop karta rehta
          // hy, aur jab user command bhejta hy to us waqt bot disconnected hota hy →
          // WhatsApp timeout = "3 second lag".
          //
          // BUG JO YAHAN THA (aur loop hamesha ke liye bana deta tha):
          //   entry.sock.end() khud apne aap 'connection.update' -> 'close' fire karta hy.
          //   Us dobara aane wale close par bhi code 440 hota tha, aur `sessions.get(id) !== entry`
          //   check fail hota tha (kyunke hum ne abhi delete nahi kiya) — natija: DO timers,
          //   DO sockets, aur 440 hamesha. Ab:
          //   1. ek hi restart chalega (entry.__restarting flag)
          //   2. map se PEHLE delete, phir socket end — taake dobara close handler skip kare
          //   3. agar baar baar 440 aa raha hy to backoff barhta jayega (5s -> 5 min)
          if (entry.__restarting) return; // is entry ka restart pehle se chal raha hy
          entry.__restarting = true;
          console.log(`[SAQI-MD] [${sessionId}] 440 conflict — duplicate socket band kar ke dobara jur rahe hain`);
          // ASLI BUG JO YAHAN THA (aur loop ko hamesha ke liye zinda rakhta tha):
          //   Yahan `sessions.delete(sessionId)` kiya jata tha. Uske baad 3-second wala
          //   `syncSessions` chalta, dekhta ke `sessions` me ye id nahi hy (magar Mongo me
          //   hy), aur FORAN naya socket bana deta — us waqt tak is 440 ka backoff timer
          //   bhi pending hota. Natija: do sockets, dono ek doosre ko 440 dete, loop kabhi
          //   khatam nahi hota. Ab session ko map me HI rakhte hain (dead + restarting
          //   mark kar ke) taake sync use dobara na uthaye; sirf restart ke waqt replace hota hy.
          entry.dead = true;
          try { entry.sock?.end(); } catch {}
          entry.reconnects++;
          // bar bar 440 = asli duplicate kisi aur jagah zinda hy. Backoff tezi se barhao
          // (5s, 10s, 20s, 40s, ... max 5 min) taake WhatsApp ko settle hone ka waqt mile.
          const delay = Math.min(5000 * Math.pow(2, Math.min(entry.reconnects - 1, 6)), 300000);
          console.log(`[SAQI-MD] [${sessionId}] 440 backoff ${Math.round(delay / 1000)}s (try ${entry.reconnects})`);
          setTimeout(() => {
            sessions.delete(sessionId); // ab sync dobara utha sakta hy
            startSession(sessionId).catch((e) => console.error(`[SAQI-MD] [${sessionId}] 440 restart fail:`, e.message));
          }, delay);
        } else {
          // LONG-LIFE RECONNECT (2-month ka hal):
          // Pehle yahan MAX_RECONNECTS ke baad session hamesha ke liye chhor diya
          // jata tha — 50 failures = session dead, dobara pair karna padta tha.
          // Ab koi hard limit nahi: backoff 3s se 60s tak barhta hy, phir 60s par
          // ruk jata hy aur session hamesha retry karta rehta hy. Is se:
          //   - network down / WhatsApp outage / phone offline — sab khud theek ho jata hy
          //   - 2 mahine (ya zyada) tak session zinda rehta hy
          // Sirf asli loggedOut par session khatam hota hy (wo upar handle hota hy).
          entry.reconnects++;
          // 20 failures ke baad "sustained backoff" — 60s par cap, magar chalta rehta hy
          const delay = Math.min(entry.reconnects * 3000, 60000);
          if (entry.reconnects % 20 === 0) {
            console.log(`[SAQI-MD] [${sessionId}] ${entry.reconnects} reconnects — ab 60s backoff par chalta rahega (session zinda hy)`);
          }
          setTimeout(() => {
            if (sessions.get(sessionId) !== entry || entry.dead) return;
            sessions.delete(sessionId);
            startSession(sessionId).catch((e) => console.error(`[SAQI-MD] [${sessionId}] restart fail:`, e.message));
          }, delay);
        }
      }
    });

    entry.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // SELF-CHAT FIX: pehle sirf `type === 'notify'` handle hota tha. WhatsApp jab
      // bot apne hi number ko message bhejta hy (ya bot khud apne aap ko likhta hy)
      // to usse `type: 'append'` ke saath deliver karta hy — is liye self-chat me
      // commands bilkul nahi chalti thin. Ab dono accept hain. Apne bheje hue
      // (fromMe) messages ko neeche handleMessage khud filter karta hy (BAE5 guard),
      // is liye loop nahi banega.
      if (type !== 'notify' && type !== 'append') return;
      for (const raw of messages) {
        try {
          entry.__lastSeen = Date.now();   // watchdog: traffic aa rahi hy = socket zinda
          // delete-revoke protocol message bhi yahan aa sakta hy
          const pm = raw.message?.protocolMessage;
          if (pm && (pm.type === 'REVOKE' || pm.type === 0)) { await handleRevoke(entry, sessionId, { update: { message: { protocolMessage: pm }, key: pm.key } }); continue; }
          if (raw.message?.ephemeralMessage?.message?.protocolMessage) { const p2 = raw.message.ephemeralMessage.message.protocolMessage; if (p2.type === 'REVOKE' || p2.type === 0) { await handleRevoke(entry, sessionId, { update: { message: { protocolMessage: p2 }, key: p2.key } }); continue; } }

          const m = smsg(entry.sock, raw);
          seenChat(sessionId, raw.key.remoteJid); // har chat (individual + group) collect

          // status @broadcast: statusview/statusemoji/statuslike/antistatus
          if (String(raw.key.remoteJid) === 'status@broadcast') {
            seenViewer(sessionId, raw.key.participant); // status poster ko yaad rakho
            if (getToggle('antistatus')) continue; // status par bilkul react nahi
            if (getToggle('statusview')) await entry.sock.readMessages([raw.key]).catch(() => {});
            const likeIt = getToggle('statuslike');
            if (getToggle('statusemoji') || likeIt) {
              const emo = likeIt ? '❤️' : ['❤️', '🔥', '👍', '😂', '😮', '🌈'][Math.floor(Math.random() * 6)];
              await entry.sock.sendMessage('status@broadcast', { react: { text: emo, key: raw.key } }).catch(() => {});
            }
            continue;
          }

          // autoreact: har aam message par reaction
          if (getToggle('autoreact') && !m.command && !m.isOwner) {
            await entry.sock.sendMessage(m.chat, { react: { text: ['❤️', '🔥', '👍', '😂', '😮', '😢', '🙏'][Math.floor(Math.random() * 7)], key: raw.key } }).catch(() => {});
          }

          if (m.command) {
            try { await handleMessage(entry.sock, raw, m); } catch (e) { console.error(`[SAQI-MD] [${sessionId}] message error:`, e); }
            continue;
          }

          // antidelete cache (sirf normal chats)
          if (raw.key?.id) cacheMessage(sessionId, raw, m);

          // autoread toggle
          if (getToggle('autoread')) await entry.sock.readMessages([raw.key]).catch(() => {});

          // antilink: group me link par message delete
          if (getToggle('antilink') && m.text && /chat\.whatsapp\.com|https?:\/\//i.test(m.text) && String(raw.key.remoteJid).endsWith('@g.us') && !m.isOwner) {
            try {
              await entry.sock.sendMessage(raw.key.remoteJid, { delete: raw.key });
              await entry.sock.sendMessage(raw.key.remoteJid, { text: `🚫 *Antilink* — link delete kar diya (${m.pushname || 'user'})` });
            } catch {}
            continue;
          }

          // mentionreply: aam messages par user ka zikr ke sath jawab nahi — ye sirf cache/autoread path hy
          void m;
        } catch (e) {
          console.error(`[SAQI-MD] [${sessionId}] upsert error:`, e.message);
        }
      }
    });
    entry.sock.ev.on('messages.update', (ups) => { for (const u of ups) {
      try { // status viewer receipt: participant = jis ne mera status dekha
        const k = u.key || {};
        if (String(k.remoteJid) === 'status@broadcast' && k.participant) seenViewer(sessionId, k.participant);
      } catch {}
      handleRevoke(entry, sessionId, u).catch(() => {});
    } });

    // antical: call reject + anticalmsg: caller ko message
    entry.sock.ev.on('call', async (calls) => {
      for (const c of calls || []) {
        try {
          if (getToggle('antical') && c.from) await entry.sock.rejectCall(c.id, c.from).catch(() => {});
          if (getToggle('anticalmsg') && c.from) await entry.sock.sendMessage(c.from, { text: '📵 Main abhi call receive nahi kar sakta — *message* karo, foran jawab milay ga.' }).catch(() => {});
        } catch {}
      }
    });

    // welcome/goodbye: group members aane/jaane par
    entry.sock.ev.on('group-participants.update', async (u) => {
      try {
        if (u.action === 'add' && getToggle('welcome')) {
          for (const p of u.participants || []) {
            const num = p.split('@')[0];
            const txt = (settingsMod.getText('welcome') || `┏━━━━「 🎉 *WELCOME* 」━━━━┓\n│\n│  ✦ Assalam-o-Alaikum\n│  ✦ *@user*\n│\n│  📍 {group} me khush aamdeed!\n│  🌟 Umeed hy aap ka waqt acha guzrega\n│\n┗━━━━━━━━━━━━━━━━━━━━━┛\n\n_${config.BOT_NAME}_`)
              .replaceAll('@user', num).replaceAll('{group}', 'Group');
            await entry.sock.sendMessage(u.id, { text: txt, mentions: [p] }).catch(() => {});
          }
        }
        if ((u.action === 'remove' || u.action === 'leave') && getToggle('goodbye')) {
          for (const p of u.participants || []) {
            const num = p.split('@')[0];
            const txt = (settingsMod.getText('goodbye') || `┏━━━━「 👋 *GOODBYE* 」━━━━┓\n│\n│  ✦ *@user* ne group chhora\n│\n│  🤲 Allah Hafiz — dobara aana!\n│\n┗━━━━━━━━━━━━━━━━━━━━━┛\n\n_${config.BOT_NAME}_`)
              .replaceAll('@user', num);
            await entry.sock.sendMessage(u.id, { text: txt, mentions: [p] }).catch(() => {});
          }
        }
      } catch {}
    });
  } catch (e) {
    console.error(`[SAQI-MD] [${sessionId}] start fail:`, e.message);
    sessions.delete(sessionId);
  }
  return entry;
}

// Mongo me naye sessions dhoondo (portal se link hua user) aur unhe start karo
async function syncSessions() {
  if (!config.MONGODB_URI) return; // file mode: sirf single session
  try {
    const ids = await listSessionIds(config.MONGODB_URI, config.SESSION_PREFIX);
    // DUPLICATE CLEANUP (440 ka pakka ilaaj): agar isi number ke liye koi session pehle se
    // chal raha hy, to naye wale ko START mat karo — balke uska Mongo doc DELETE kar do.
    // Warna dono sockets WhatsApp se jurte hain, WhatsApp ek ko 440 (connectionReplaced)
    // de deta hy, aur bot connected/closed ke beech loop karta rehta hy.
    const liveNums = new Set();
    for (const [sid, e] of sessions) {
      if (e && e.user) liveNums.add(String(sid).split(':').pop());
    }
    for (const id of ids) {
      if (sessions.has(id)) continue;
      const num = String(id).split(':').pop();
      if (liveNums.has(num)) {
        console.log(`[SAQI-MD] [${id}] duplicate (number ${num} pehle se live) — Mongo se delete kar rahe hain`);
        deleteSession(config.MONGODB_URI, id).catch(() => {});
        continue;
      }
      if (sessions.size >= config.MAX_SESSIONS) {
        console.error(`[SAQI-MD] session limit hit (${sessions.size}/${config.MAX_SESSIONS}) — ${id} skip ho gaya. MAX_SESSIONS barhao.`);
        continue;
      }
      await startSession(id);
    }
  } catch (e) {
    console.error('[SAQI-MD] session sync fail:', e.message);
  }
}

// ---------- message handler ----------
const { smsg } = require('./lib/serialize.mjs');

async function handleMessage(sock, raw, pre) {
  if (!raw.message) return;
  if (raw.key.id.startsWith('BAE5') && raw.key.id.length === 16) return; // bot ka apna bheja hua
  if (raw.key.remoteJid === 'status@broadcast') return;
  // LOOP GUARD: bot jo khud bhejta hy usse dobara command na samjho. Self-chat me
  // (`append` type) bot ka apna reply bhi wapas aata hy — agar wo bhi parse ho jaye
  // to bot apne hi jawab par jawab deta rehta hy (infinite loop). Is liye: apne
  // bheje hue message ko sirf tab chalao jab usme PREFIX ho (yaani user ne khud
  // likha ho) — aur agar wo already hamara reply lagta hy to chhor do.
  if (raw.key.fromMe) {
    const selfText = raw.message?.conversation || raw.message?.extendedTextMessage?.text || '';
    // sirf prefix wale messages (asli command) chalenge; baaqi sab (hamare replies) skip
    if (!String(selfText).startsWith(config.PREFIX)) return;
  }

  const m = pre || smsg(sock, raw); // SPEED: caller ne pehle se smsg kar diya ho to dobara na karo
  if (!m.command) return;
  // SPEED: ye dono network calls WhatsApp server par jati hain. Pehle await hoti thin,
  // is liye HAR command se pehle 150-400ms zaya hota tha. Ab fire-and-forget — reply
  // foran jata hai, presence/read background me update hoti rehti hai.
  if (config.AUTO_READ || getToggle('autoread')) sock.readMessages([raw.key]).catch(() => {});
  // .online on → presence available = online + message DELIVERED (double GREY tick).
  // Read (blue tick) sirf .autoread on hone par — online aur read ab alag hyn.
  if (getToggle('online')) sock.sendPresenceUpdate('available', m.chat).catch(() => {});

  // private mode: sirf owner + sudo
  const senderNum = (m.sender || '').split('@')[0];
  if (config.MODE === 'private' && !m.isOwner && !settingsMod.isSudo(senderNum)) return;
  // adminaction: groups me sirf admins ke commands
  if (getToggle('adminaction') && m.isGroup && !m.isAdmin && !m.isOwner) return;

  const cmd = commands.get(m.command);
  if (!cmd) {
    // common alternate naam — seedha sahi command par bhej do
    const ALIASES = {
      autorecording: 'recording', autotype: 'autotyping', autodelete: 'antidelete',
      antidel: 'antidelete', antideletemode: 'antidelmode',
      delmode: 'antidelmode', anticall: 'antical', autorespond: 'autoreply',
      welkom: 'welcome', goodbye2: 'goodbye', stiker: 'sticker', stc: 'sticker',
      ytd: 'video', ytl: 'song', yt: 'video', weather: 'wthr', ai2: 'ai', bot: 'menu',
      cmd: 'menu', commands: 'menu', help: 'menu', halp: 'menu',
    };
    const alias = ALIASES[m.command.toLowerCase()];
    const ac = alias && commands.get(alias);
    if (ac) return ac.handler({ ...m, command: alias });
    // ---------- AUTO-REPAIR ----------
    // 1) user ne space daal diya (".dist karachi lahore", ".wthr karachi"): pehla lafz command, baqi arg
    const rawArg = String(m.rawArg || '').trim();
    if (rawArg) {
      const joined = (m.command.toLowerCase() + rawArg.toLowerCase().replace(/\s+/g, ''));
      const noSpace = commands.get(joined);
      if (noSpace) return noSpace.handler({ ...m, command: joined, arg: '' });
      const asArg = commands.get(joined.replace(/2/g, '2'));
      if (asArg) return asArg.handler({ ...m, command: joined, arg: '' });
    }
    // 2) common synonyms jo seedha maap hyn
    const SYN = {
      weather: 'wthr', mausam: 'wthr', temp: 'temperature', translate: 'translate',
      convert: 'convert', calculator: 'calc', calc: 'calc', sticker: 'sticker',
      song: 'song', music: 'play', video: 'video', download: 'video',
      distance: 'dist', doori: 'dist', time: 'time', waqt: 'time',
      namaz: 'namaz', prayer: 'namaz', quran: 'surah', surah: 'surah',
      crypto: 'btc2usd', rate: 'btc2usd', currency: 'convert', element: 'element',
      zodiac: 'zodiac', rashi: 'zodiac', recipe: 'recipe', joke: 'joke',
      fact: 'fact', quote: 'quote', font: 'font', synonym: 'syn', antonym: 'ant',
      wiki: 'wikenglish', wikipedia: 'wikenglish', country: 'countrypk',
      flag: 'flagpk', capital: 'capitalpk', university: 'unipk',
    };
    const syn = SYN[m.command.toLowerCase()];
    if (syn) {
      const sc = commands.get(syn);
      // agar exact synonym command mojood hy to chalao
      if (sc) return sc.handler({ ...m, command: syn, arg: rawArg || m.arg });
      // warna synonym + arg jor kar dekho — ".temp lahore" -> temperaturelahore,
      // ".wthr karachi" -> wthrkarachi, ".rashi aries" -> zodiacaries
      const argTxt = String(rawArg || m.arg || '').trim().toLowerCase().replace(/\s+/g, '');
      if (argTxt) {
        const joined = syn + argTxt;
        const jc = commands.get(joined);
        if (jc) return jc.handler({ ...m, command: joined, arg: '' });
        // aur agar user ne aisa likha jo family prefix se match karta hy (".wthr karachi")
        const fam = commands.get(m.command.toLowerCase() + argTxt);
        if (fam) return fam.handler({ ...m, command: m.command.toLowerCase() + argTxt, arg: '' });
      }
    }
    // 3) dist/time/namaz/tr/comp/font jaise families: prefix match, phir sahi variant dhoondo
    const q0 = m.command.toLowerCase();
    const FAM = [
      { p: /^dist/, arg: rawArg.toLowerCase().replace(/[^a-z]/g, '') , make: (a) => 'dist' + a },
      { p: /^time/, arg: rawArg.toLowerCase().replace(/[^a-z]/g, ''), make: (a) => 'time' + a },
      { p: /^namaz/, arg: rawArg.toLowerCase().replace(/[^a-z]/g, ''), make: (a) => 'namaz' + a },
      { p: /^zodiac/, arg: rawArg.toLowerCase().replace(/[^a-z]/g, ''), make: (a) => 'zodiac' + a },
      { p: /^element/, arg: rawArg.toLowerCase().replace(/[^a-z]/g, ''), make: (a) => 'element' + a },
      { p: /^font/, arg: rawArg.toLowerCase().replace(/[^a-z]/g, ''), make: (a) => 'font' + a },
      { p: /^recipe/, arg: rawArg.toLowerCase().replace(/[^a-z]/g, ''), make: (a) => 'recipe' + a },
    ];
    for (const f of FAM) {
      if (f.p.test(q0) && f.arg) {
        const c2 = commands.get(f.make(f.arg));
        if (c2) return c2.handler({ ...m, command: f.make(f.arg), arg: '' });
      }
    }
    // 4) "karachi lahore" bina dist ke → distkarachi2lahore / distlahore2karachi
    if (rawArg && /\s/.test(rawArg)) {
      const parts2 = rawArg.toLowerCase().split(/\s+/).filter(Boolean);
      if (parts2.length === 2) {
        const [A, B] = parts2;
        for (const cand of ['dist' + A + '2' + B, 'dist' + B + '2' + A, 'comp' + A + '2' + B]) {
          const c3 = commands.get(cand);
          if (c3) return c3.handler({ ...m, command: cand, arg: '' });
        }
      }
    }
    // fuzzy suggest: user ki ghalat command ke sab se qareeb sahi command
    const q = m.command.toLowerCase();
    const scored = fuzzyTop(q, commands.keys());
    const top = scored.filter(([, s]) => s <= Math.max(3, Math.floor(q.length / 2)));
    const hint = top.length ? `\n\n💡 Kya murad tha:\n${top.map(([n]) => `▫️ *${config.PREFIX}${n}*`).join('\n')}` : `\n\n💡 Sahi naam ke liye *${config.PREFIX}menu* dekho.`;
    return m.reply(`❌ *${config.PREFIX}${m.command}* mojood nahi hy.${hint}`);
  }
  if (cmd.ownerOnly && !m.isOwner) return m.reply('❌ Ye command sirf *owner* ke liye hy.');
  if (cmd.groupOnly && !m.isGroup) return m.reply('❌ Ye command sirf *group* me chalti hy.');

  // mentionreply: har reply ke shuru me user ka naam
  if (getToggle('mentionreply') && m.pushname) {
    const orig = m.reply.bind(m);
    m.reply = (t, ...a) => orig(typeof t === 'string' ? `*@${m.pushname}*\n\n${t}` : t, ...a);
  }

  // ---------- PREMIUM SPEED ----------
  // self-learning: jo command 1.2s se zyada le, agle par foran "⚡ Processing..." ack
  const slowCmds = global.__slowCmds || (global.__slowCmds = new Set(
    // starter set (network/media commands pehli dafa se hi instant ack)
    ['song','play','music','video','ytmp3','ytmp4','tiktok','tiktoksearch','facebook','fb','instagram','igdl','ig','capcut','gdrive','mediafire','megadl','apk','ai','gpt','gemini','chatgpt','sticker','s','attp','tomp3','tts','quote']
  ));
  if (slowCmds.has(m.command)) {
    // SPEED: ack ko await na karo — warna asli jawab ack ke baad ruk jata hai (do round trips)
    sock.sendMessage(m.chat, { text: `⚡ *Processing...*` }, { quoted: m }).catch(() => {});
  }

  console.log(`[CMD] ${m.command} | ${m.pushname} | ${m.isGroup ? 'group' : 'dm'}`);
  try {
    // recording / autotyping presence — SPEED: ye bhi network call hai, await karne se
    // har command se pehle extra delay aata tha. Background me bhej do.
    if (getToggle('recording')) sock.sendPresenceUpdate('recording', m.chat).catch(() => {});
    else if (getToggle('autotyping')) sock.sendPresenceUpdate('composing', m.chat).catch(() => {});
    const t0 = Date.now();
    // ---------- 1-SECOND GUARANTEE ----------
    // Masla: network commands (wthr, btc2usd, translate, downloader) API ka intezar karte hain.
    // Agar API slow ho to user 5-10s tak khamosh baithta hy. Hal: 900ms ka soft deadline —
    // agar us waqt tak jawab nahi bana to foran ek "kaam ho raha hy" message jata hy, aur
    // asli jawab jab tayyar ho kar aata hy. Is se user ko 1s ke andar kuch na kuch milta hy.
    let _replied = false;
    const _origReply = m.reply.bind(m);
    m.reply = (t, ...a) => { _replied = true; return _origReply(t, ...a); };
    const _softTimer = setTimeout(() => {
      if (_replied) return;
      sock.sendMessage(m.chat, { text: `⏳ *${m.command}* par kaam ho raha hy...` }).catch(() => {});
    }, 900);

    await cmd.handler(m, sock);
    clearTimeout(_softTimer);
    const dt = Date.now() - t0;
    if (dt > 1200 && !slowCmds.has(m.command)) {
      slowCmds.add(m.command);
      console.log(`[SPEED] ${m.command} slow (${dt}ms) — ab instant ack milega`);
    }
  } catch (e) {
    console.error(`[CMD-ERR] ${m.command}:`, e);
    const emsg = String(e.message || e).slice(0, 200);

    // 1) TRANSIENT error (network/timeout/429/503) → khud ek dafa retry, user ko pata bhi na chale
    if (!m.__retried && isTransientError(emsg)) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await cmd.handler({ ...m, __retried: true }, sock);
        return; // retry chal gaya — error report ki zaroorat nahi
      } catch (e2) {
        console.error(`[CMD-RETRY-FAIL] ${m.command}:`, String(e2.message).slice(0, 120));
      }
    }

    // 2) error Mongo me likho + user ke apne number (yourself) par report bhejo
    logError({ command: m.command, chat: m.chat, isGroup: !!m.isGroup, sender: m.sender, error: emsg });
    await reportToSelf(sock,
      `⚠️ *BOT ERROR*\n\n🔹 Command: ${config.PREFIX}${m.command}\n🔹 Chat: ${m.isGroup ? 'Group' : 'DM'}\n🔹 Error: \`${emsg.slice(0, 150)}\`\n🕒 ${new Date().toLocaleString('en-PK', { timeZone: config.TIMEZONE })}\n\n🤖 Bot khud retry kar chuka hy — phir bhi ye aya, to main ise theek kar dunga.`);

    // 3) user ko saaf jawab
    await m.reply(`❌ *Error* aya — bot ne khud report kar di hy, jaldi theek ho jayega.\n\`\`\`${emsg.slice(0, 120)}\`\`\``).catch(() => {});
  }
}

// ---------- pairing queue (Vercel 60s cap ka hal) ----------
// Portal (Vercel) sirf pair_requests me 'pending' doc dalta hy; ASLI pairing socket
// yahan 24/7 worker par chalta hy — koi 60s limit nahi, is liye "could not link"
// wala masla khatam. Doc statuses: pending -> ready (code mil gaya) -> linked / error.
const mongoose = require('mongoose');
let _prModel = null;
function pairModel() {
  if (!_prModel) {
    const s = new mongoose.Schema({ _id: String, number: String, status: String, code: String, createdAt: Date }, { collection: 'pair_requests' });
    _prModel = mongoose.models.PairRequest || mongoose.model('PairRequest', s);
  }
  return _prModel;
}
const fmtCode = (c) => String(c).match(/.{1,4}/g).join('-');
let pairingBusy = false;

async function processPairQueue() {
  if (!config.MONGODB_URI || pairingBusy) return;
  pairingBusy = true;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    }
    const PR = pairModel();

    // purane adhoore requests ki safai (15 min se purana)
    await PR.deleteMany({ createdAt: { $lt: new Date(Date.now() - 15 * 60 * 1000) } });

    const pend = await PR.find({ status: 'pending', createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } })
      .sort({ createdAt: 1 }).limit(1).lean();
    if (!pend.length) return;
    const doc = pend[0];
    const number = doc.number;
    const sessionId = `${config.SESSION_PREFIX}:${number}`;

    // already linked? (dobara pair karne ki koshish)
    const existing = sessions.get(sessionId);
    if (existing && existing.user) {
      await PR.updateOne({ _id: number }, { status: 'linked' });
      return;
    }
    // dead/atki hui entry ho to hata do — warna pairing socket block reh jati hy
    if (existing && !existing.user) {
      try { existing.sock?.end(); } catch {}
      sessions.delete(sessionId);
      await new Promise((r) => setTimeout(r, 400));
    }

    console.log(`[PAIR-Q] ${number} ke liye pairing socket start`);
    const entry = await startSession(sessionId);
    if (!entry || !entry.sock) throw new Error('session start fail');

    // socket ke WhatsApp tak pohanchne ka intezar — adaptive (fixed 3s ki jagah)
    let code = null;
    for (let i = 0; i < 3 && !code; i++) {
      // ws khulne ka intezar (max 8s, 400ms check) — khulne ke baad chhota settle
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const wsOpen = entry.sock.ws && entry.sock.ws.readyState === 1;
        if (wsOpen) { await new Promise((r) => setTimeout(r, 600)); break; }
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!sessions.has(sessionId)) break; // logged out / removed
      try { code = await entry.sock.requestPairingCode(number); }
      catch (e) { console.log(`[PAIR-Q] code try ${i + 1} fail: ${e.message}`); }
    }
    if (!code) {
      await PR.updateOne({ _id: number }, { status: 'error' });
      console.log(`[PAIR-Q] ${number} — code nahi ban saka`);
      return; // session rehta hy; sync/loggedOut khud safai karega
    }
    await PR.updateOne({ _id: number }, { code: fmtCode(code), status: 'ready' });
    console.log(`[PAIR-Q] ${number} -> ${fmtCode(code)}`);

    // linked hone ka intezar (5 min) — BACKGROUND me (v5.4.1: queue block na ho, agla number foran)
    (async () => {
      const tw = Date.now();
      while (Date.now() - tw < 5 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 2500));
        const cur = sessions.get(sessionId);
        if (cur && cur.user) {
          await PR.updateOne({ _id: number }, { status: 'linked' }).catch(() => {});
          console.log(`[PAIR-Q] ${number} LINKED ✅`);
          // SPEED: link hone ke foran baad session pehle se live hy (isi socket par), is liye
          // pehli command ka jawab bhi foran aata hy — sync interval ka intezar nahi.
          try { if (!sessions.has(sessionId) && cur) sessions.set(sessionId, cur); } catch {}
          return;
        }
        if (!cur) break; // session khatam (loggedOut)
      }
      const cur = sessions.get(sessionId);
      if (cur && !cur.user) {
        sessions.delete(sessionId);
        await deleteSession(config.MONGODB_URI, sessionId).catch(() => {});
        try { cur.sock.end(); } catch {}
        await PR.updateOne({ _id: number }, { status: 'error' }).catch(() => {});
        console.log(`[PAIR-Q] ${number} — pairing timeout, safai ho gayi`);
      }
    })().catch(() => {});
    return;
  } catch (e) {
    console.error('[PAIR-Q] error:', e.message);
  } finally {
    pairingBusy = false;
  }
}

// ---------- anti-crash ----------
// ---------- 2-MONTH RELIABILITY: process kabhi na mare ----------
// Ek bhi unhandled error pehle poore bot ko gira sakta tha (Railway container restart =
// sab sessions ka reconnect = user ko "bot off" lagta hy). Ab har error log hota hy,
// bot chalta rehta hy. Sirf asli memory-crisis par restart (OOM se bachne ke liye).
let _errCount = 0, _errWindowStart = Date.now();
process.on('uncaughtException', (e) => {
  _errCount++;
  console.error('[uncaught]', e && e.message ? e.message : e);
  // agar 5 min me 200+ errors aayein to kuch bunyadi toota hy — saaf restart behtar hy
  if (Date.now() - _errWindowStart > 5 * 60 * 1000) { _errCount = 1; _errWindowStart = Date.now(); }
  else if (_errCount > 200) { console.error('[FATAL] error storm — restart'); process.exit(1); }
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandled]', e && e.message ? e.message : e);
});
// memory leak guard: agar heap 900MB se upar jaye to restart (Railway limit se pehle)
setInterval(() => {
  try {
    const mb = process.memoryUsage().heapUsed / 1024 / 1024;
    if (mb > 900) { console.error(`[FATAL] heap ${Math.round(mb)}MB — restart`); process.exit(1); }
  } catch {}
}, 5 * 60 * 1000).unref();

// ---------- health endpoint (Koyeb/Render ko chahiye) ----------
const app = express();

// IMPORTANT: ye route server.js mount se PEHLE aana chahiye. server.js ka export ek
// Vercel-style middleware hy jo kabhi next() nahi call karta — is liye agar use pehle
// mount kiya to wo SAB requests kha jata tha aur ye route chalta hi nahi tha (/health
// purana "v17-fresh" hi dikhata rehta tha). Ab asli health PEHLE register hota hy.
app.get('/health', (req, res) => {
  let total = 0, conn = 0;
  try {
    const S = global.__SAQI_SESSIONS;
    if (S && typeof S.size === 'number') {
      total = S.size;
      for (const [, e] of S) { if (e && e.user) conn++; }
    }
  } catch {}
  res.json({
    ok: true,
    service: 'saqi-md-pair',
    build: 'v18-stable',
    sessions: total,
    connected: conn,
    healthy: total === 0 || conn > 0,
    uptime: Math.round(process.uptime()),
    heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

// Pairing portal ab mount — baqi sab routes (/, /pair, /api/*) server.js ke andar hain.
// NOTE: `app.use(require('./server'))` galat tha — wo export ek Vercel-style handler hy jo
// `next()` call nahi karta, is liye ye file ke BAAD wale sab routes (/health, /diag/*) dead
// ho jate the. Ab asli Express app mount hota hy (async, is liye ek chhota bridge).
const portal = require('./server');
if (portal && portal.expressApp) {
  portal.expressApp().then((portalApp) => {
    app.use(portalApp);
    console.log('[SAQI-MD] pairing portal mount ho gaya');
  }).catch((e) => console.error('[SAQI-MD] portal mount fail:', e.message));
} else {
  app.use(portal);
}

// ---------- DIAGNOSTIC: Mongo me kitne session docs hain (440 duplicate dhoondhne ke liye) ----------
// Ye batata hy ke kya ek hi number ke liye ek se zyada session doc mojood hain — jo 440
// (connectionReplaced) ki sab se aam wajah hy. Token se protected.
app.get('/diag/sessions', async (req, res) => {
  const key = String(req.query.key || '');
  if (!config.MONGODB_URI || key !== String(config.SESSION_PREFIX)) return res.status(403).json({ ok: false });
  try {
    // BUG FIX: pehle `models.Session` dhoondha jata tha jo is process me kabhi register
    // nahi hota (asli model 'baileys_sessions' hy, lib/mongoSession.js) — is liye ye
    // endpoint hamesha credsDocs:[] dikhata tha aur lagta tha creds gayab hain.
    const conn = require('mongoose').connection;
    const ids = await listSessionIds(config.MONGODB_URI, config.SESSION_PREFIX);
    const all = conn.readyState === 1
      ? (await conn.db.collection('baileys_sessions').find({ _id: /creds$/ }).project({ _id: 1 }).toArray()).map(d => d._id)
      : [];
    res.json({ ok: true, prefix: config.SESSION_PREFIX, sessionIds: ids, credsDocs: all, inMemory: [...sessions.keys()] });
  } catch (e) { res.json({ ok: false, err: e.message }); }
});

// ---------- live test hook (LOCALHOST ONLY) — session ke apne chat me command bhej kar asli jawab pakarta hy ----------
app.get('/livetest', async (req, res) => {
  // localhost-only tha — Railway par is liye kabhi call hi nahi ho sakta tha.
  // Ab: localhost allowed, ya ?key=<SESSION_PREFIX> do (wahi key jo /diag/sessions use karta hy).
  const ip = req.socket.remoteAddress || '';
  const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
  if (!isLocal && String(req.query.key || '') !== String(config.SESSION_PREFIX)) return res.status(403).json({ ok: false, err: 'forbidden' });
  const num = String(req.query.num || '').replace(/[^0-9]/g, '');
  const text = String(req.query.text || '');
  const sid = config.SESSION_PREFIX + ':' + num;
  const entry = sessions.get(sid);
  if (!entry || !entry.sock || !entry.user) return res.status(404).json({ ok: false, err: 'session not connected' });
  const toNum = String(req.query.to || '').replace(/[^0-9]/g, '');
  const tEntryPre = toNum ? sessions.get(config.SESSION_PREFIX + ':' + toNum) : null;
  const toLid = tEntryPre && tEntryPre.sock && tEntryPre.sock.user && tEntryPre.sock.user.lid ? String(tEntryPre.sock.user.lid).split(':')[0] + '@lid' : null;
  const targetJid = req.query.sendto || toLid || (toNum ? toNum + '@s.whatsapp.net' : (String(entry.sock.user.id).split(':')[0].split('@')[0] + '@s.whatsapp.net'));
  const replys = [];
  const caps = [];
  const mkCap = (tag) => ({ messages }) => {
    for (const raw of messages) {
      try {
        const t = raw.message?.conversation || raw.message?.extendedTextMessage?.text || raw.message?.imageMessage?.caption || '';
        if (!t) continue;
        caps.push(tag + '|fm=' + !!raw.key.fromMe + '|' + String(raw.key.remoteJid).slice(0, 24) + '|' + t.slice(0, 60));
        const fromBot = toNum ? !raw.key.fromMe : raw.key.fromMe;
        if (fromBot) replys.push(t);
      } catch {}
    }
  };
  const cap1 = mkCap('from');
  entry.sock.ev.on('messages.upsert', cap1);
  const tEntry = toNum ? sessions.get(config.SESSION_PREFIX + ':' + toNum) : null;
  const cap2 = tEntry ? mkCap('target') : null;
  if (cap2) tEntry.sock.ev.on('messages.upsert', cap2);
  var sendErr = null, sendKey = null;
  const updCap = ({ messages }) => { try { for (const u of messages) if (u.key && (u.status || u.update)) sendKey = 'status:' + u.status; } catch {} };
  entry.sock.ev.on('messages.update', updCap);
  try {
    const sent = await Promise.race([
      entry.sock.sendMessage(targetJid, { text }, {}),
      new Promise((_, rej) => setTimeout(() => rej(new Error('send timeout')), 8000)),
    ]);
    sendKey = sent && sent.key ? sent.key.id : 'nosend';
  } catch (e) { sendErr = e.message; }
  await new Promise(r => setTimeout(r, parseInt(req.query.wait) || 9000));
  entry.sock.ev.off('messages.update', updCap);
  entry.sock.ev.off('messages.upsert', cap1);
  if (cap2) tEntry.sock.ev.off('messages.upsert', cap2);
  if (res.headersSent) return;
  res.json({ ok: true, sent: text, to: toNum || 'self', replies: replys.slice(0, 4), caps: caps.slice(0, 10), sendErr, sendKey, fromUser: entry.sock.user, toUser: tEntry ? (tEntry.sock.user || null) : null });
});

// BUG FIX: pehle ye route JSON return karta tha aur portal ki index.html ko
// shadow kar deta tha — user ko website ke bajaye raw JSON dikhta tha.
// Ab website serve hoti hy; JSON status /status par chala gaya.
app.get('/status', (req, res) => res.json({
  bot: config.BOT_NAME,
  status: 'running',
  sessions: sessions.size,
  connected: [...sessions.values()].filter(s => s.user).length,
  uptime: Math.floor((Date.now() - startAt) / 1000),
  commands: commands.size,
}));
// EADDRINUSE-safe listen (Oct 3 fix): pehle port conflict par poora worker
// crash hota tha -> 3 users ke sessions bhi gir jate the. Ab sirf health
// endpoint skip hota hy, bot zinda rehta hy.
const httpServer = app.listen(config.PORT, () => console.log(`[SAQI-MD] health endpoint on :${config.PORT}`));
httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[SAQI-MD] port ${config.PORT} already in use — health endpoint skip, bot chalta rahega`);
  } else {
    console.error('[SAQI-MD] http server error:', e.message);
  }
});

// (portal upar mount ho chuka hy — app.use(require('./server')))

// ---------- go ----------
(async () => {
  try {
    baileysVersion = (await fetchLatestBaileysVersion()).version;
  } catch { baileysVersion = undefined; }

  if (config.MONGODB_URI) {
    console.log(`[SAQI-MD] multi-user mode (MongoDB) — sessions scan ho rahe hain`);
    await syncSessions();
    // SPEED: pehle 30s tha — pairing ke baad bot ko 30s tak pata nahi chalta tha ke naya
    // user juda hy, aur us window mein bheji gayi command ka koi jawab nahi aata (WhatsApp
    // timeout = "3 second lag"). Ab 3s — naya session lagbhag foran uth jata hai.
    setInterval(syncSessions, 3 * 1000).unref();
    setInterval(processPairQueue, 1000).unref(); // pairing requests (portal queue se) — fast pickup

    // ---------- WATCHDOG (2-month reliability) ----------
    // Masla: session "zinda" dikhta hy magar socket silently mar chuka hota hy
    // (network flap, WhatsApp side disconnect). Pehle aisa session hamesha ke liye
    // atka reh jata tha — user ko lagta bot off ho gaya, halanki process chal raha tha.
    // Hal: har 60s check karo — jo session 3 min se connected nahi, usko zabardasti
    // restart karo. Is se bot khud ko theek kar leta hy, bina kisi ko chhune.
    // (Pehle 5 min check / 10 min threshold tha — bot 10 min tak dead reh sakta tha.)
    setInterval(() => {
      const now = Date.now();
      for (const [sessionId, entry] of sessions) {
        if (!entry.user) continue;              // already reconnecting — upar handle ho raha hy
        if (entry.dead || entry.__restarting) continue; // 440 restart chal raha hy — use chhero
        const last = entry.__lastSeen || entry.__connectedAt || now;
        if (now - last > 3 * 60 * 1000) {
          console.log(`[SAQI-MD] [${sessionId}] watchdog: 3 min se silent — restart`);
          sessions.delete(sessionId);
          try { entry.sock?.end(); } catch {}
          startSession(sessionId).catch(() => {});
        }
      }
    }, 60 * 1000).unref();

    // ---------- SESSION GUARDIAN (2-month) ----------
    // Watchdog sirf un sessions ko dekhta hy jo `sessions` map me hyn. Agar koi session
    // map se hi nikal jaye (loggedOut ke ilawa kisi wajah se), to Mongo me session mojood
    // hote hue bhi bot dead reh jata hy. Ye guardian har 60s Mongo aur memory compare karta
    // hy aur kisi bhi missing session ko wapas utha leta hy — bot khud ko heal karta hy.
    setInterval(async () => {
      try {
        const ids = await listSessionIds(config.MONGODB_URI, config.SESSION_PREFIX);
        for (const id of ids) {
          if (sessions.has(id)) continue;
          if (sessions.size >= config.MAX_SESSIONS) break;
          console.log(`[SAQI-MD] guardian: ${id} memory me nahi tha — wapas utha rahe hain`);
          startSession(id).catch(() => {});
        }      } catch (e) { /* agla cycle dekhega */ }
    }, 60 * 1000).unref();
  } else {
    console.log(`[SAQI-MD] single-session file mode (MONGODB_URI nahi diya gaya)`);
    await startSession(config.SESSION_ID);
  }
})().catch((e) => { console.error('[SAQI-MD] FATAL:', e); process.exit(1); });
