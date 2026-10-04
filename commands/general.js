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
      if (!m.arg) {
        // NAYA MENU (v6): saaf, emoji-free headers, asli commands upar.
        // 43k commands ka poora list bhejna bekaar hy — user ko kaam ki cheez chahiye.
        // Is liye: sirf wo categories dikhao jin me ASLI (dummy nahi) commands hain,
        // aur unki ginti ke sath. Dummy packs (x3/x4/x5) ko alag se niche rakha hy.
        const up = Math.floor((Date.now() - startAt) / 1000);
        const sorted = Object.keys(cats).sort((a, b) => cats[b].length - cats[a].length);

        // chhoti categories (asli kaam wali) aur bari (bulk packs) ko alag karo
        const core = sorted.filter(c => cats[c].length <= 300);
        const bulk = sorted.filter(c => cats[c].length > 300);

        const line = (cat) => `│ ${cat.padEnd(14)} ${String(cats[cat].length).padStart(6)}`;

        let txt = '';
        txt += `╭──────────────────────────────╮\n`;
        txt += `│   ⚡ ${config.BOT_NAME}${' '.repeat(Math.max(0, 20 - config.BOT_NAME.length))}│\n`;
        txt += `╰──────────────────────────────╯\n\n`;
        txt += `  Owner     : ${config.OWNER_NAME}\n`;
        txt += `  Prefix    : ${config.PREFIX}\n`;
        txt += `  Commands  : ${total.toLocaleString('en-US')}\n`;
        txt += `  Uptime    : ${fmtUptime(up)}\n\n`;
        txt += `━━━ *MAIN CATEGORIES* ━━━\n`;
        txt += `\`\`\`\n${core.map(line).join('\n')}\n\`\`\`\n`;
        if (bulk.length) {
          txt += `━━━ *BULK PACKS* ━━━\n`;
          txt += `\`\`\`\n${bulk.map(line).join('\n')}\n\`\`\`\n`;
        }
        txt += `\n*Kaise use karein*\n`;
        txt += `  ${config.PREFIX}menu <category>  — us category ki commands\n`;
        txt += `  ${config.PREFIX}details <naam>   — kisi bhi command ki detail\n`;
        txt += `  ${config.PREFIX}menu all        — sab categories\n\n`;
        txt += `_${config.BOT_NAME} v${config.BOT_VERSION} — ${config.OWNER_NAME}_`;
        return m.reply(txt);
      }

      // .menu all — sab categories ek sath (chhota, sirf ginti)
      if (m.arg.trim().toLowerCase() === 'all') {
        const all = Object.keys(cats).sort()
          .map(c => `│ ${c.padEnd(16)} ${String(cats[c].length).padStart(6)}`)
          .join('\n');
        return m.reply(`━━━ *SAB CATEGORIES* ━━━\n\`\`\`\n${all}\n\`\`\``);
      }
      // .menu <category> [page]
      const parts = m.arg.trim().split(/\s+/);
      const want = parts[0].toUpperCase();
      const cat = Object.keys(cats).find(c => c === want || c.replace(/\s+/g, '') === want);
      if (!cat) {
        const matches = Object.keys(cats).filter(c => c.includes(want));
        return m.reply(`❌ Category "${parts[0]}" nahi mili.${matches.length ? `\nKya matlab tha: ${matches.join(', ')}` : ''}\nSab dekhne ke liye: ${config.PREFIX}menu`);
      }
      const body = catBody(cat, parseInt(parts[1]) || 1);
      const count = cats[cat].length;
      return m.reply(`╭─〔 *${cat}* 〕─ ${count} commands ─⊷\n${body}\n> ${config.BOT_NAME}`);
    }

    case 'ping':
    case 'speed': {
      const t0 = Date.now();
      const sent = await sock.sendMessage(m.chat, { text: '🏓 ...' }, { quoted: m });
      const latency = Date.now() - t0;
      const body = `🏓 *Pong!*\n⚡ Speed: *${latency}ms*\n⏱️ Uptime: ${fmtUptime(Math.floor((Date.now() - startAt) / 1000))}`;
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
