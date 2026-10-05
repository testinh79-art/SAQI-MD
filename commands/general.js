/* SAQI-MD — MAIN: menu, ping, owner card, githubstalk, fetch, anime
 * (alive/uptime UTILITY me hain — JAWAD sequence ke mutabiq)
 */
const config = require('../config');
const { animeImage } = require('../lib/anime-pack');
const { fmtUptime } = require('../lib/functions');

const startAt = Date.now();

// category cache — registry boot ke baad static, dobara scan nahi karna
let __cats = null;
function collectCommands() {
  if (__cats) return __cats;
  const fs = require('fs');
  const path = require('path');
  const cats = {};
  for (const f of fs.readdirSync(__dirname).filter(x => x.endsWith('.js'))) {
    try {
      const mod = require(path.join(__dirname, f));
      for (const c of mod.commands) {
        if (c.hidden) continue;
        const cat = (c.category || 'GENERAL').toUpperCase();
        (cats[cat] = cats[cat] || []).push({ name: c.name, desc: c.desc || '' });
      }
    } catch {}
  }
  __cats = cats;
  return cats;
}

const MENU_PER_PAGE = 220;
function catBody(cat, page) {
  const list = collectCommands()[cat] || [];
  const pages = Math.ceil(list.length / MENU_PER_PAGE);
  page = Math.max(1, Math.min(page || 1, pages));
  const slice = list.slice((page - 1) * MENU_PER_PAGE, page * MENU_PER_PAGE);
  let b = `\`\`\`\n${slice.map(c => '. ' + c.name).join('\n')}\`\`\``;
  if (pages > 1) b += `\n▸ Page ${page}/${pages} — .menu ${cat.toLowerCase()} ${page + 1}`;
  return b;
}

async function handler(m, sock) {
  switch (m.command) {
    case 'menu':
    case 'help': {
      const cats = collectCommands();
      const total = Object.values(cats).reduce((a, c) => a + c.length, 0);
      const up = Math.floor((Date.now() - startAt) / 1000);

      // ── PREMIUM MENU ────────────────────────────────────────────────────────
      // Design usool: WhatsApp monospace font sirf ```blocks``` me milta hy, aur
      // wahan emoji theek nahi dikhte. Is liye: header/box me sajawat, andar ki
      // list plain. Emoji har line par nahi — sirf category ke sath (clean look).
      // 43k commands poora bhejna bekaar hy — sirf asli kaam wali categories.
      const catIcon = {
        MAIN: '🏠', DOWNLOAD: '⬇️', AI: '🤖', OWNER: '👑', GROUP: '👥',
        TOOLS: '🧰', SEARCH: '🔎', FUN: '🎮', ANIME: '🌸', SOUND: '🔊',
        LOGO: '🎨', SETTING: '⚙️', SETTINGS: '⚙️', UTILITY: '📦',
        OTHER: '📁', STUDY: '📚', TEXT: '✍️', GAMES: '🎯', PROD: '📋',
        MISC: '🔧', OPS: '🛠️', BOT: '🤖',
        // pehle ye missing the — grey diamond ▫️ dikhta tha
        PRODUCTIVITY: '⚡', AUDIO: '🎵', ADMIN: '🛡️', EXTRA: '📦',
        SECURITY: '🔒', FILES: '📁', CRYPTO: '💰', ISLAMIC: '🕌',
        MODERATION: '🛡️', ZODIAC: '♈', SCIENCE: '🔬', FOOD: '🍽️',
        UNITS: '📐', SOCIAL: '💬', WIKI: '📖', FONT: '🔤',
        NAMAZ: '🕋', 'GROUP TOOLS': '👥', STATUS: '📊', CONFIG: '⚙️',
        STICKER: '🖼️', FACTS: '💡', QUOTES: '❝', TEMPERATURE: '🌡️',
        JOKES: '😂',
      };
      const icon = (c) => catIcon[c] || '▫️';

      if (!m.arg) {
        // Fake command packs (x2/x3/x4/x5 — ~41k dummy) hata diye. Ab bachi
        // categories asli hain; sirf ADMIN/FUN/EXTRA (aliases + misc shortcuts)
        // bare hain. 200 ka cutoff rakha hy taake TOOLS/GROUP jaise kaam wale
        // packs core me rahen.
        const sorted = Object.keys(cats).sort((a, b) => cats[b].length - cats[a].length);
        const core = sorted.filter(c => cats[c].length <= 200);
        const bulk = sorted.filter(c => cats[c].length > 200);
        const L = 32; // box ki andar ki chaurai

        const row = (cat) => {
          const n = String(cats[cat].length);
          const name = cat.length > 17 ? cat.slice(0, 17) : cat;
          const gap = Math.max(1, L - 4 - name.length - n.length);
          return `│ ${icon(cat)} ${name}${' '.repeat(gap)}${n} │`;
        };
        const bar = '─'.repeat(L);
        const title = `⚡ ${config.BOT_NAME}`;
        const pad = Math.max(0, Math.floor((L - title.length) / 2));

        let txt = '';
        txt += `┏${bar}┓\n`;
        txt += `┃${' '.repeat(pad)}${title}${' '.repeat(Math.max(0, L - pad - title.length))}┃\n`;
        txt += `┗${bar}┛\n`;
        txt += `  ┌───────────── ✦ ─────────────┐\n`;
        txt += `   👑 Owner    : ${config.OWNER_NAME}\n`;
        txt += `   ⚙️ Prefix   : ${config.PREFIX}\n`;
        txt += `   📦 Commands : ${total.toLocaleString('en-US')}\n`;
        txt += `   ⏱️ Uptime   : ${fmtUptime(up)}\n`;
        txt += `   🟢 Status   : Online\n`;
        txt += `  └───────────── ✦ ─────────────┘\n\n`;
        txt += `┏━━━━━「 *MENU* 」━━━━━┓\n`;
        txt += core.map(row).join('\n') + '\n';
        txt += `┗━━━━━━━━━━━━━━━━━━━━━━━━┛\n`;
        if (bulk.length) {
          txt += `\n┏━━━━「 *BULK PACKS* 」━━━━┓\n`;
          txt += bulk.map(row).join('\n') + '\n';
          txt += `┗━━━━━━━━━━━━━━━━━━━━━━━━┛\n`;
        }
        txt += `\n┏━━━━━「 *HOW TO USE* 」━━━━━┓\n`;
        txt += `│ ${config.PREFIX}menu <category>          │\n`;
        txt += `│ ${config.PREFIX}menu all                 │\n`;
        txt += `│ ${config.PREFIX}details <command>        │\n`;
        txt += `┗━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n`;
        txt += `_${config.BOT_NAME} v${config.BOT_VERSION} • ${config.OWNER_NAME}_`;
        return m.reply(txt);
      }

      // .menu all — sab categories, compact
      if (m.arg.trim().toLowerCase() === 'all') {
        const all = Object.keys(cats).sort()
          .map(c => {
            const n = String(cats[c].length);
            const name = c.length > 16 ? c.slice(0, 16) : c;
            return `│ ${icon(c)} ${name}${' '.repeat(Math.max(1, 20 - name.length - n.length))}${n} │`;
          }).join('\n');
        return m.reply(`┏━━━━「 *SAB CATEGORIES* 」━━━━┓\n${all}\n┗━━━━━━━━━━━━━━━━━━━━━━━┛`);
      }

      // .menu <category> [page]
      const parts = m.arg.trim().split(/\s+/);
      const want = parts[0].toUpperCase();
      const cat = Object.keys(cats).find(c => c === want || c.replace(/\s+/g, '') === want);
      if (!cat) {
        const matches = Object.keys(cats).filter(c => c.includes(want));
        return m.reply(`❌ Category "${parts[0]}" nahi mili.${matches.length ? `\n\nKya matlab tha:\n${matches.map(c => `▸ ${config.PREFIX}menu ${c.toLowerCase()}`).join('\n')}` : ''}\n\nSab dekhne ke liye: ${config.PREFIX}menu`);
      }
      const body = catBody(cat, parseInt(parts[1]) || 1);
      const count = cats[cat].length;
      return m.reply(`┏━━━━「 ${icon(cat)} *${cat}* 」━━━━┓\n│ 📦 ${count} commands\n┗━━━━━━━━━━━━━━━━━━━━━┛\n\n${body}\n\n_${config.BOT_NAME} v${config.BOT_VERSION}_`);
    }

    case 'ping':
    case 'speed': {
      const t0 = Date.now();
      const sent = await sock.sendMessage(m.chat, { text: '🏓 ...' }, { quoted: m });
      const latency = Date.now() - t0;
      const body = `┏━━━━「 🏓 *PONG* 」━━━━┓\n│\n│  ⚡ Speed  : *${latency}ms*\n│  ⏱️ Uptime : ${fmtUptime(Math.floor((Date.now() - startAt) / 1000))}\n│  🟢 Status : Online\n│\n┗━━━━━━━━━━━━━━━━━━━━━┛\n\n_${config.BOT_NAME} v${config.BOT_VERSION}_`;
      // edit optional hy — kuch clients/situations me edit support nahi hoti, aur
      // us surat me poora command crash ho jata tha. Ab edit fail ho to naya
      // message bhej dete hain.
      if (sent && sent.key) {
        try { return await sock.sendMessage(m.chat, { text: body, edit: sent.key }); } catch {}
      }
      return sock.sendMessage(m.chat, { text: body });
    }
    case 'ping2': {
      const t0 = Date.now();
      await m.reply(`🏓 *Pong v2!*\n⚡ ${Date.now() - t0}ms (approx)`);
      return;
    }
    case 'owner': {
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${config.OWNER_NAME}\nTEL;type=CELL;type=VOICE;waid=${config.OWNER_NUMBERS[0] || ''}:+${config.OWNER_NUMBERS[0] || ''}\nEND:VCARD`;
      return sock.sendMessage(m.chat, { contacts: { displayName: config.OWNER_NAME, contacts: [{ vcard }] } }, { quoted: m });
    }
    case 'githubstalk': {
      if (!m.arg) return m.reply(`❌ Username do. Example: ${config.PREFIX}githubstalk saqibiqbaltesting-ai`);
      const r = await fetch(`https://api.github.com/users/${encodeURIComponent(m.arg)}`).then(r => r.json());
      if (r.message) return m.reply('❌ User nahi mila.');
      return m.reply(`👤 *${r.name || r.login}*\n🔹 Username: ${r.login}\n📝 Bio: ${r.bio || '-'}\n📦 Public repos: ${r.public_repos}\n👥 Followers: ${r.followers}\n➡️ Following: ${r.following}\n📍 Location: ${r.location || '-'}\n🔗 ${r.html_url}`);
    }
    case 'fetch': {
      if (!/^https?:\/\//.test(m.arg)) return m.reply(`❌ URL do. Example: ${config.PREFIX}fetch https://example.com`);
      const res = await fetch(m.arg, { redirect: 'follow' });
      const body = (await res.text()).slice(0, 800);
      return m.reply(`🌐 *FETCH*\n\n▫️ Status: ${res.status} ${res.statusText}\n▫️ Content-Type: ${res.headers.get('content-type') || '-'}\n\n\`\`\`${body.replace(/```/g, '')}\`\`\``);
    }
    case 'anime': {
      const img = animeImage();
      if (!img) return m.reply('❌ Image pack mojood nahi.');
      return sock.sendMessage(m.chat, { image: { url: img }, caption: `🌸 ${config.BOT_NAME}` }, { quoted: m });
    }
  }
}

module.exports.commands = [
  { name: 'menu', desc: 'Poora menu', category: 'MAIN', handler },
  { name: 'help', desc: 'Poora menu', category: 'MAIN', handler },
  { name: 'ping', desc: 'Bot speed', category: 'MAIN', handler },
  { name: 'ping2', desc: 'Speed test v2', category: 'MAIN', handler },
  { name: 'speed', desc: 'Speed test', category: 'MAIN', handler, hidden: true },
  { name: 'owner', desc: 'Owner ka card', category: 'MAIN', handler },
  { name: 'githubstalk', desc: 'GitHub user info', category: 'MAIN', handler },
  { name: 'fetch', desc: 'URL fetch', category: 'MAIN', handler },
  { name: 'anime', desc: 'Random anime image', category: 'MAIN', handler },
];
