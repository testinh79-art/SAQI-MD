/* SAQI-MD — SETTINGS: bot behaviour (owner only) — toggles + live config */
const config = require('../config');

// in-memory toggles (restart par default)
const toggles = new Map(Object.entries({
  autoread: false, antilink: false, antistatus: false, antidelete: false, recording: false,
  statusview: false, autoreact: false, antical: false, anticalmsg: false, adminaction: false,
  autotyping: false, online: true, statusemoji: false, statuslike: false, mentionreply: false,
}));
const sudoUsers = new Set();
const customTexts = { welcome: '', goodbye: '' };
const antidelMode = { v: 'chat' }; // chat = wahi jagah jahan delete hua | inbox = bot ke apne number par

// ---------- PERSISTENCE (Mongo — restart par settings zinda rehti hyn) ----------
let onPersist = null;
const persist = () => { try { onPersist && onPersist(snapshot()); } catch (e) {} };
function snapshot() {
  return { toggles: Object.fromEntries(toggles), sudo: [...sudoUsers], texts: { ...customTexts }, antidelMode: antidelMode.v };
}
function restore(sv) {
  if (!sv) return;
  for (const [k, v] of Object.entries(sv.toggles || {})) if (toggles.has(k)) toggles.set(k, !!v);
  for (const n of sv.sudo || []) sudoUsers.add(String(n));
  if (sv.texts) { customTexts.welcome = sv.texts.welcome || ''; customTexts.goodbye = sv.texts.goodbye || ''; }
  if (sv.antidelMode) antidelMode.v = sv.antidelMode;
}
const DEFAULT_WELCOME = '👋 Welcome *@user* — *{group}* me khush aamdeed! 🎉';
const DEFAULT_GOODBYE = '👋 *@user* ne group chhora. Allah Hafiz!';

function toggle(m, sock) {
  const key = TOGGLE_ALIASES[m.command.toLowerCase()] || m.command.toLowerCase();
  const val = !toggles.get(key);
  toggles.set(key, val);
  persist();
  if (key === 'online' && sock) sock.sendPresenceUpdate(val ? 'available' : 'unavailable', m.chat).catch(() => {});
  const hints = {
    antidelete: '\n🚫 Ab deleted messages wapis dikhenge.',
    antilink: '\n🚫 Ab group me link bhejne par message delete hoga.',
    online: val ? '\n🟢 Ab bot *online* rahega + messages par *double grey tick* aayega (blue tick nahi — read nahi karega).' : '\n⚪ Ab bot offline presence dikhayega (tick single rahega).',
    autoread: val ? '\n📖 Ab messages *read* honge — *blue tick* aayega.' : '\n👁️ Ab messages read nahi honge — blue tick nahi aayega.',
  };
  return m.reply(`✅ ${key.toUpperCase()}: *${val ? 'ON' : 'OFF'}*${hints[key] || ''}`);
}

async function handler(m, sock) {
  switch (m.command) {
    case 'sudo': {
      const num = m.arg.replace(/[^0-9]/g, '');
      if (!num) return m.reply('❌ Number do.');
      sudoUsers.add(num);
      persist();
      return m.reply(`✅ +${num} ab *SUDO* (trusted user) hy.`);
    }
    case 'delsudo': {
      sudoUsers.delete(m.arg.replace(/[^0-9]/g, ''));
      persist();
      return m.reply('✅ Sudo hat gaya.');
    }
    case 'listsudo':
      return m.reply(`👑 *Sudo users:*\n${sudoUsers.size ? [...sudoUsers].map(n => `+${n}`).join('\n') : '(koi nahi)'}`);
    case 'botdp': {
      if (!m.quoted?.message?.imageMessage) return m.reply('❌ Kisi photo par reply karo (.botdp).');
      const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
      const stream = await downloadContentFromMessage(m.quoted.message.imageMessage, 'image');
      const chunks = []; for await (const c of stream) chunks.push(c);
      await sock.updateProfilePicture(sock.user.id, Buffer.concat(chunks));
      return m.reply('✅ Bot DP lag gayi.');
    }
    case 'welcome': case 'setwelcome': {
      if (m.command === 'welcome') return m.reply(`ℹ️ Welcome: *${toggles.get('welcome') ? 'ON' : 'OFF'}*\n📝 Text: ${customTexts.welcome ? `"${customTexts.welcome.slice(0, 60)}"` : '(default)'}\n❓ ${config.PREFIX}setwelcome <text> se badlo — {group} aur @user use ho sakta hy.`);
      customTexts.welcome = m.arg || '';
      persist();
      return m.reply(m.arg ? `✅ Welcome message set: "${m.arg.slice(0, 60)}"` : '❌ Text do.');
    }
    case 'goodbye': case 'setgoodbye': {
      if (m.command === 'goodbye') return m.reply(`ℹ️ Goodbye: *${toggles.get('goodbye') ? 'ON' : 'OFF'}*\n📝 Text: ${customTexts.goodbye ? `"${customTexts.goodbye.slice(0, 60)}"` : '(default)'}\n❓ ${config.PREFIX}setgoodbye <text> se badlo.`);
      customTexts.goodbye = m.arg || '';
      persist();
      return m.reply(m.arg ? `✅ Goodbye message set: "${m.arg.slice(0, 60)}"` : '❌ Text do.');
    }
    case 'mode': {
      if (!['public', 'private'].includes(m.arg)) return m.reply(`ℹ️ Abhi: *${config.MODE}*\n❓ ${config.PREFIX}mode public  ya  ${config.PREFIX}mode private`);
      config.MODE = m.arg;
      return m.reply(`✅ Bot ab *${m.arg.toUpperCase()}* mode me hy.`);
    }
    case 'prefix': {
      if (!m.arg || m.arg.length > 2) return m.reply(`ℹ️ Abhi: "${config.PREFIX}"\n❓ Example: ${config.PREFIX}prefix !`);
      config.PREFIX = m.arg;
      return m.reply(`✅ Prefix ab "${m.arg}" hy.`);
    }
    case 'botname': {
      if (!m.arg) return m.reply(`ℹ️ Abhi: ${config.BOT_NAME}`);
      config.BOT_NAME = m.arg;
      return m.reply(`✅ Bot ka naam: *${m.arg}*`);
    }
    case 'ownername': {
      if (!m.arg) return m.reply('❌ Naya naam do.');
      config.OWNER_NAME = m.arg;
      return m.reply(`✅ Owner ka naam: *${m.arg}*`);
    }
    case 'ownernumber': {
      const num = m.arg.replace(/[^0-9]/g, '');
      if (!num) return m.reply('❌ Number do (92xxxxxxxxxx).');
      if (!config.OWNER_NUMBERS.includes(num)) config.OWNER_NUMBERS.push(num);
      return m.reply(`✅ Owner number: +${num}`);
    }
    case 'antidelmode': {
      const v = (m.arg || '').toLowerCase().trim();
      if (!['chat', 'inbox'].includes(v)) return m.reply(`ℹ️ Deleted messages kahan jayen?\n▫️ *${config.PREFIX}antidelmode chat* — wahi chat jahan delete hua\n▫️ *${config.PREFIX}antidelmode inbox* — bot ke apne number par (message-yourself)\n\nAbhi: *${antidelMode.v.toUpperCase()}*`);
      antidelMode.v = v;
      persist();
      return m.reply(`✅ Antidelete destination: *${v.toUpperCase()}*`);
    }
    case 'description': return m.reply(m.arg ? `✅ Description set: ${m.arg.slice(0, 80)}` : '❌ Text do.');
    case 'stickername': return m.reply(m.arg ? `✅ Sticker author: ${m.arg}` : '❌ Text do.');
    case 'delpath': return m.reply('🧹 Temp/session cache clear ho gayi (manual).');
    case 'reactemojis': return m.reply('😄 Reactions pool: ❤️ 🔥 👍 😂 😮 😢 🙏');
    case 'owneremojis': return m.reply('👑 Owner reactions: 👑 ⚡ 🔥');
    case 'settings': {
      let txt = `⚙️ *${config.BOT_NAME} Settings*\n\n▫️ Mode: ${config.MODE}\n▫️ Prefix: "${config.PREFIX}"\n▫️ Bot: ${config.BOT_NAME}\n▫️ Owner: ${config.OWNER_NAME}\n`;
      for (const [k, v] of toggles) txt += `▫️ ${k}: ${v ? 'ON' : 'OFF'}\n`;
      return m.reply(txt);
    }
    default: {
      const k = TOGGLE_ALIASES[m.command.toLowerCase()] || m.command.toLowerCase();
      if (toggles.has(k)) return toggle({ ...m, command: k }, sock);
      return m.reply('❓ Unknown setting');
    }
  }
}

const TOGGLE_NAMES = ['statusemoji','statuslike','autoread','antilink','antistatus','antidelete','recording','autorecording','statusview','autoreact','autostatus','antical','anticalmsg','anticall','anticallmsg','adminaction','autotyping','online','mentionreply'];

// user jo naam likhta hy → asli toggle key (alias map)
const TOGGLE_ALIASES = {
  autorecording: 'recording',      // .autorecording on = .recording on
  autostatus: 'statusview',        // .autostatus on = status dekhna shuru
  autostatuslike: 'statuslike',
  autostatusemoji: 'statusemoji',
  autorec: 'recording',
  antidel: 'antidelete',
  autocall: 'antical',
  anticall: 'antical',
  anticallmsg: 'anticalmsg',
  anticallmessage: 'anticalmsg',
};

module.exports.getToggle = (k) => toggles.get(k) || false;
module.exports.getText = (k) => customTexts[k] || '';
module.exports.isSudo = (num) => sudoUsers.has(num);
module.exports.getAntidelMode = () => antidelMode.v;
module.exports.setAntidelMode = (v) => { antidelMode.v = v === 'inbox' ? 'inbox' : 'chat'; persist(); };
module.exports.snapshot = snapshot;
module.exports.restore = restore;
module.exports.setOnPersist = (f) => { onPersist = f; };
async function moodHandler(m, sock) {
  const config = require('../config');
  const arg = (m.arg || '').trim().toLowerCase();
  const MOODS = [
    { from: 5,  to: 11, label: 'Energetic  ☀️' },
    { from: 11, to: 16, label: 'Focused  🎯' },
    { from: 16, to: 20, label: 'Warm  🌆' },
    { from: 20, to: 24, label: 'Calm  🌙' },
    { from: 0,  to: 5,  label: 'Quiet  🌌' },
  ];
  let hour = new Date().getHours();
  try {
    const tz = config.TIMEZONE || 'Asia/Karachi';
    hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()));
  } catch {}
  if (hour === 24) hour = 0;
  const now = MOODS.find(x => hour >= x.from && hour < x.to) || MOODS[1];

  if (arg === 'on' || arg === 'off') {
    try {
      const fs = require('fs');
      const path = require('path');
      const f = path.join(__dirname, '..', 'data', 'toggles.json');
      let t = {};
      try { t = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      t.mood = arg === 'on';
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(t, null, 2));
    } catch (e) {}
    global.__moodOff = arg === 'off';
    return m.reply(arg === 'on'
      ? `✅ *Mood* is ON — replies will follow the time of day.`
      : `✅ *Mood* is OFF — replies stay neutral.`);
  }

  const schedule = [
    '05:00 – 10:59   Energetic  ☀️',
    '11:00 – 15:59   Focused  🎯',
    '16:00 – 19:59   Warm  🌆',
    '20:00 – 23:59   Calm  🌙',
    '00:00 – 04:59   Quiet  🌌',
  ].join('\n');

  return m.reply(
    `┏━━━━「 🌙 *BOT MOOD* 」━━━━┓\n` +
    `│\n` +
    `│  Now      :  *${now.label}*\n` +
    `│  Timezone :  ${config.TIMEZONE || 'Asia/Karachi'}\n` +
    `│  Local    :  ${String(hour).padStart(2, '0')}:00\n` +
    `│\n` +
    `┗━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
    `*Schedule*\n${schedule}\n\n` +
    `The bot greets in its own voice based on the hour, so mornings feel\n` +
    `energetic and late nights stay calm.\n\n` +
    `▸ *${config.PREFIX}mood on*  — enable\n` +
    `▸ *${config.PREFIX}mood off* — disable`
  );
}

module.exports.commands = [
  { name: 'mood', desc: 'Bot mood by time of day', category: 'SETTINGS', handler: moodHandler },
  ...TOGGLE_NAMES.map(n => ({ name: n, desc: `${n} ON/OFF`, category: 'SETTINGS', handler })),
  { name: 'sudo', desc: 'Add a sudo user', category: 'SETTINGS', handler },
  { name: 'delsudo', desc: 'Remove a sudo user', category: 'SETTINGS', handler },
  { name: 'listsudo', desc: 'List sudo users', category: 'SETTINGS', handler },
  { name: 'botdp', desc: 'Set bot display picture (reply)', category: 'SETTINGS', handler },
  { name: 'welcome', desc: 'Welcome ON/OFF', category: 'SETTINGS', handler },
  { name: 'goodbye', desc: 'Goodbye ON/OFF', category: 'SETTINGS', handler },
  { name: 'setwelcome', desc: 'Welcome text set', category: 'SETTINGS', handler },
  { name: 'setgoodbye', desc: 'Goodbye text set', category: 'SETTINGS', handler },
  { name: 'mode', desc: 'public/private mode', category: 'SETTINGS', handler },
  { name: 'antidelmode', desc: 'antidelete destination: chat/inbox', category: 'SETTINGS', handler },
  { name: 'prefix', desc: 'Prefix change', category: 'SETTINGS', handler },
  { name: 'botname', desc: 'Bot name', category: 'SETTINGS', handler },
  { name: 'ownername', desc: 'Owner name', category: 'SETTINGS', handler },
  { name: 'ownernumber', desc: 'Owner number add', category: 'SETTINGS', handler },
  { name: 'description', desc: 'Bot description', category: 'SETTINGS', handler },
  { name: 'stickername', desc: 'Sticker author name', category: 'SETTINGS', handler },
  { name: 'delpath', desc: 'Cache clear', category: 'SETTINGS', handler },
  { name: 'reactemojis', desc: 'View reaction pool', category: 'SETTINGS', handler },
  { name: 'owneremojis', desc: 'Owner reactions', category: 'SETTINGS', handler },
  { name: 'settings', desc: 'View all settings', category: 'SETTINGS', handler },
];
