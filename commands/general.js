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

/* Center a string inside a fixed-width box row. */
function center(text, width) {
  const t = String(text);
  if (t.length >= width) return t.slice(0, width);
  const pad = Math.floor((width - t.length) / 2);
  return ' '.repeat(pad) + t + ' '.repeat(width - t.length - pad);
}

/* Time-of-day mood. Saqib asked for this: energetic in the morning, calmer at
   night. Timezone comes from config.TIMEZONE (Asia/Karachi by default) so the
   mood matches HIS clock, not the server's UTC. */
const MOODS = [
  { from: 5,  to: 11, key: 'morning', label: 'Energetic  ☀️',  greet: 'Good morning' },
  { from: 11, to: 16, key: 'day',     label: 'Focused  🎯',    greet: 'Good afternoon' },
  { from: 16, to: 20, key: 'evening', label: 'Warm  🌆',       greet: 'Good evening' },
  { from: 20, to: 24, key: 'night',   label: 'Calm  🌙',       greet: 'Good night' },
  { from: 0,  to: 5,  key: 'latenight', label: 'Quiet  🌌',    greet: 'Still awake' },
];
function currentMood() {
  let hour = new Date().getHours();
  try {
    const tz = config.TIMEZONE || 'Asia/Karachi';
    hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()));
  } catch {}
  if (hour === 24) hour = 0;
  return MOODS.find(m => hour >= m.from && hour < m.to) || MOODS[1];
}

const MENU_PER_PAGE = 40;

/* One command row, aligned: name on the left, description on the right.
   Monospace only survives inside ``` blocks on WhatsApp, so the list itself is
   plain and the alignment is done with spaces. */
function cmdRow(c, prefix) {
  const name = prefix + c.name;
  const desc = (c.desc || '').slice(0, 34);
  if (!desc) return name;
  const gap = Math.max(2, 26 - name.length);
  return name + ' '.repeat(gap) + desc;
}

function catBody(cat, page) {
  const list = collectCommands()[cat] || [];
  const pages = Math.max(1, Math.ceil(list.length / MENU_PER_PAGE));
  page = Math.max(1, Math.min(page || 1, pages));
  const slice = list.slice((page - 1) * MENU_PER_PAGE, page * MENU_PER_PAGE);
  let b = '```\n' + slice.map(c => cmdRow(c, config.PREFIX)).join('\n') + '\n```';
  if (pages > 1) b += `\n> Page *${page}* of *${pages}*  —  next: *${config.PREFIX}menu ${cat.toLowerCase()} ${page + 1}*`;
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
        DAILY: '⭐',
      };
      const icon = (c) => catIcon[c] || '▫️';

      if (!m.arg) {
        const sorted = Object.keys(cats).sort((a, b) => cats[b].length - cats[a].length);
        const core = sorted.filter(c => cats[c].length <= 200);
        const bulk = sorted.filter(c => cats[c].length > 200);
        const L = 30; // inner box width

        const row = (cat) => {
          const n = String(cats[cat].length);
          const name = cat.length > 16 ? cat.slice(0, 16) : cat;
          const gap = Math.max(1, L - 3 - name.length - n.length);
          return `│ ${icon(cat)} ${name}${' '.repeat(gap)}${n} │`;
        };
        const bar = '─'.repeat(L);

        let txt = '';
        txt += `┏${bar}┓\n`;
        txt += `┃${center(config.BOT_NAME, L)}┃\n`;
        txt += `┃${center('P R E M I U M   E D I T I O N', L)}┃\n`;
        txt += `┗${bar}┛\n`;
        txt += `\n`;
        txt += `   👑  Owner     :  ${config.OWNER_NAME}\n`;
        txt += `   ⚙️  Prefix    :  ${config.PREFIX}\n`;
        txt += `   📦  Commands  :  ${total.toLocaleString('en-US')}\n`;
        txt += `   ⏱️  Uptime    :  ${fmtUptime(up)}\n`;
        txt += `   🟢  Status    :  Online\n`;
        txt += `   🌙  Mood      :  ${currentMood().label}\n`;
        txt += `\n`;
        txt += `┏━━━━━「 COMMAND CATEGORIES 」━━━━━┓\n`;
        txt += core.map(row).join('\n') + '\n';
        txt += `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n`;
        if (bulk.length) {
          txt += `\n┏━━━━━━「 BULK PACKS 」━━━━━━┓\n`;
          txt += bulk.map(row).join('\n') + '\n';
          txt += `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n`;
        }
        txt += `\n┏━━━━━━「 HOW TO USE 」━━━━━━┓\n`;
        txt += `│ ${(config.PREFIX + 'menu <category>').padEnd(26)} │\n`;
        txt += `│ ${(config.PREFIX + 'menu all').padEnd(26)} │\n`;
        txt += `│ ${(config.PREFIX + 'details <command>').padEnd(26)} │\n`;
        txt += `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n`;
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
        return m.reply(`┏━━━━「 *ALL CATEGORIES* 」━━━━┓\n${all}\n┗━━━━━━━━━━━━━━━━━━━━━━━━┛`);
      }

      // .menu <category> [page]
      const parts = m.arg.trim().split(/\s+/);
      const want = parts[0].toUpperCase();
      const cat = Object.keys(cats).find(c => c === want || c.replace(/\s+/g, '') === want);
      if (!cat) {
        const matches = Object.keys(cats).filter(c => c.includes(want));
        return m.reply(`❌ No category named *${parts[0]}*.${matches.length ? `\n\nDid you mean:\n${matches.map(c => `▸ ${config.PREFIX}menu ${c.toLowerCase()}`).join('\n')}` : ''}\n\nSee everything with: *${config.PREFIX}menu*`);
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
      const body = `┏━━━━「 🏓 *PONG* 」━━━━┓\n│\n│  ⚡ Speed  : *${latency}ms*\n│  ⏱️ Uptime : ${fmtUptime(Math.floor((Date.now() - startAt) / 1000))}\n│  🌙 Mood   : ${currentMood().label}\n│  🟢 Status : Online\n│\n┗━━━━━━━━━━━━━━━━━━━━━┛\n\n_${config.BOT_NAME} v${config.BOT_VERSION}_`;
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
      if (!m.arg) return m.reply(`❌ Give a username. Example: *${config.PREFIX}githubstalk saqibiqbaltesting-ai*`);
      const r = await fetch(`https://api.github.com/users/${encodeURIComponent(m.arg)}`).then(r => r.json());
      if (r.message) return m.reply('❌ User not found.');
      return m.reply(`👤 *${r.name || r.login}*\n🔹 Username: ${r.login}\n📝 Bio: ${r.bio || '-'}\n📦 Public repos: ${r.public_repos}\n👥 Followers: ${r.followers}\n➡️ Following: ${r.following}\n📍 Location: ${r.location || '-'}\n🔗 ${r.html_url}`);
    }
    case 'fetch': {
      if (!/^https?:\/\//.test(m.arg)) return m.reply(`❌ Give a URL. Example: *${config.PREFIX}fetch https://example.com*`);
      const res = await fetch(m.arg, { redirect: 'follow' });
      const body = (await res.text()).slice(0, 800);
      return m.reply(`🌐 *FETCH*\n\n▫️ Status: ${res.status} ${res.statusText}\n▫️ Content-Type: ${res.headers.get('content-type') || '-'}\n\n\`\`\`${body.replace(/```/g, '')}\`\`\``);
    }
    case 'anime': {
      const img = animeImage();
      if (!img) return m.reply('❌ Image pack not available.');
      return sock.sendMessage(m.chat, { image: { url: img }, caption: `🌸 ${config.BOT_NAME}` }, { quoted: m });
    }
  }
}

module.exports.commands = [
  { name: 'menu', desc: 'Full command menu', category: 'MAIN', handler },
  { name: 'help', desc: 'Full command menu', category: 'MAIN', handler },
  { name: 'ping', desc: 'Bot response speed', category: 'MAIN', handler },
  { name: 'ping2', desc: 'Speed test (v2)', category: 'MAIN', handler },
  { name: 'speed', desc: 'Speed test', category: 'MAIN', handler, hidden: true },
  { name: 'owner', desc: 'Owner contact card', category: 'MAIN', handler },
  { name: 'githubstalk', desc: 'GitHub user info', category: 'MAIN', handler },
  { name: 'fetch', desc: 'Fetch a URL', category: 'MAIN', handler },
  { name: 'anime', desc: 'Random anime image', category: 'MAIN', handler },
];
