/* SAQI-MD — MongoDB-backed Baileys Auth State
 * Baileys ka useMultiFileAuthState iska file-system version hy — yahan wahi state
 * MongoDB me save hoti hy taake pair hone ke baad restart par dobara pair na karna pade.
 *
 * Usage:
 *   const { state, saveCreds } = await useMongoAuthState(uri, sessionId)
 * Agar MONGODB_URI khali ho to file-system fallback use hota hy (local dev ke liye).
 *
 * Multi-user (v2):
 *   listSessionIds(uri, prefix)  -> Mongo me mojood sab session ids
 *   deleteSession(uri, sessionId) -> logged-out session ki safai
 */
const mongoose = require('mongoose');

// Baileys ESM hy — bundle kiya hua CJS (Vercel-proof)
let _baileys = null;
function _b() {
  if (!_baileys) _baileys = require('./baileys-bundle.cjs');
  return _baileys;
}

const SessionModel = mongoose.models.baileys_sessions ||
  mongoose.model('baileys_sessions', new mongoose.Schema({
    _id: String,
    data: mongoose.Schema.Types.Mixed,
  }, { strict: false }));

async function _connect(uri) {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  }
}

// In-memory auth state — serverless (Vercel) par filesystem read-only hota hy,
// is liye file fallback wahan crash karta hy. Ye memory version kabhi crash nahi
// karta; pairing tootegi nahi, bas session restart par nahi bachega (jo MongoDB
// ka kaam hy). Read-only FS ya koi bhi FS error par yahan gir jate hain.
function useMemoryAuthState() {
  const { initAuthCreds } = _b();
  const store = { creds: initAuthCreds(), keys: {} };
  return {
    state: {
      creds: store.creds,
      keys: {
        async get(type, ids) {
          const doc = store.keys[type] || {};
          const out = {};
          for (const k of ids) if (doc[k]) out[k] = doc[k];
          return out;
        },
        async set(data) {
          for (const type of Object.keys(data)) {
            store.keys[type] = Object.assign(store.keys[type] || {}, data[type]);
          }
        },
      },
    },
    saveCreds: async () => {},
  };
}

async function useMongoAuthState(uri, sessionId = 'saqi-md-session') {
  const { BufferJSON, initAuthCreds, useMultiFileAuthState } = _b();
  if (!uri) {
    // ---- file fallback (local dev / bina Mongo) ----
    // Vercel par FS read-only hy -> mkdir fail hota hy. Us surat me memory state.
    try {
      return await useMultiFileAuthState('./session');
    } catch (e) {
      console.error('[AUTH] file fallback fail (' + e.code + '), memory state use kar rahe hain');
      return useMemoryAuthState();
    }
  }

  await _connect(uri);

  const read = async (id) => {
    const doc = await SessionModel.findOne({ _id: id }).lean();
    if (!doc) return null;
    return JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver);
  };
  const write = async (id, data) => {
    await SessionModel.updateOne(
      { _id: id },
      { $set: { data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) } },
      { upsert: true }
    );
  };

  const creds = (await read(`${sessionId}:creds`)) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const doc = (await read(`${sessionId}:keys-${type}`)) || {};
          const out = {};
          for (const k of ids) if (doc[k]) out[k] = doc[k];
          return out;
        },
        async set(data) {
          for (const type of Object.keys(data)) {
            const id = `${sessionId}:keys-${type}`;
            const doc = (await read(id)) || {};
            Object.assign(doc, data[type]);
            await write(id, doc);
          }
        },
        async clear() {
          // Baileys 7 me use nahi hota, safety ke liye
        },
      },
    },
    saveCreds: () => write(`${sessionId}:creds`, creds),
  };
}

// Portal se bane sab sessions ki list (multi-user worker ke liye)
async function listSessionIds(uri, prefix) {
  if (!uri) return [];
  await _connect(uri);
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const docs = await SessionModel.find({ _id: { $regex: `^${esc}:.*:creds$` } }).lean();
  return docs.map(d => d._id.slice(0, -(':creds'.length)));
}

// Logged-out / reset session ko poori tarah delete karna
async function deleteSession(uri, sessionId) {
  if (!uri) return;
  await _connect(uri);
  await SessionModel.deleteMany({ _id: { $regex: `^${sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:|$)` } });
}

module.exports = { useMongoAuthState, listSessionIds, deleteSession };
