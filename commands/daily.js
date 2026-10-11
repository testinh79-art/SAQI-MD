/* SAQI-MD — DAILY: the everyday-use commands.
 * Saqib asked for "kaam ka" features — things people reach for every day.
 * Everything here runs on the bot's existing GEMINI_API_KEY, so no new service
 * and no new bill. Each command degrades with a clear message when the key is
 * missing instead of throwing.
 */
const config = require('../config');

const AI_MODELS = ['gemini-flash-lite-latest', config.GEMINI_MODEL, 'gemini-3.6-flash']
  .filter((v, i, a) => v && a.indexOf(v) === i);

async function gemini(parts, maxTokens = 900) {
  if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  let lastErr;
  for (const model of AI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: maxTokens } }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) { lastErr = new Error(`AI error ${res.status}`); continue; }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('');
      if (text) return text.trim();
      lastErr = new Error('Empty response');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('AI error');
}

/* Download the quoted/attached media as base64 so it can go to the AI. */
async function fetchMediaBase64(m, sock) {
  const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
  const q = m.quoted?.message || m.message;
  const inner = q?.imageMessage || q?.audioMessage || q?.videoMessage || q?.documentMessage;
  if (!inner) return null;
  const type = q.imageMessage ? 'image' : q.audioMessage ? 'audio' : q.videoMessage ? 'video' : 'document';
  const stream = await downloadContentFromMessage(inner, type);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks);
  return { base64: buf.toString('base64'), mime: inner.mimetype || (type === 'image' ? 'image/jpeg' : 'audio/ogg'), type, buf };
}

async function handler(m, sock) {
  switch (m.command) {
    /* ---------- TRANSLATE ---------- */
    case 'translate':
    case 'tr': {
      const text = (m.quoted?.text || m.arg || '').trim();
      if (!text) return m.reply(`❌ Give text, or reply to a message.\nExample: *${config.PREFIX}tr en Assalam o Alaikum*`);
      const parts = text.split(/\s+/);
      const LANGS = { en: 'English', ur: 'Urdu', hi: 'Hindi', ar: 'Arabic', fr: 'French', de: 'German', es: 'Spanish', tr: 'Turkish', zh: 'Chinese', ru: 'Russian', ps: 'Pashto', sd: 'Sindhi', bn: 'Bengali' };
      let target = 'English';
      let body = text;
      if (parts.length > 1 && LANGS[parts[0].toLowerCase()]) {
        target = LANGS[parts[0].toLowerCase()];
        body = parts.slice(1).join(' ');
      } else if (/[\u0600-\u06FF]/.test(text)) {
        target = 'English';
      } else {
        target = 'Urdu';
      }
      const out = await gemini([{ text: `Translate the following into ${target}. Reply with ONLY the translation, no notes, no quotes.\n\n${body}` }], 700);
      return m.reply(`🌐 *TRANSLATE → ${target}*\n\n${out}`);
    }

    /* ---------- SUMMARISE ---------- */
    case 'summary':
    case 'summarize':
    case 'tl;dr': {
      const text = (m.quoted?.text || m.arg || '').trim();
      if (!text) return m.reply(`❌ Reply to a long message, or paste text.\nExample: *${config.PREFIX}summary <long text>*`);
      const clipped = text.slice(0, 12000);
      const out = await gemini([{ text: `Summarise this in 5 short bullet points. Plain language, no preamble.\n\n${clipped}` }], 600);
      return m.reply(`📝 *SUMMARY*\n\n${out}`);
    }

    /* ---------- FIX GRAMMAR / REWRITE ---------- */
    case 'fix':
    case 'grammar': {
      const text = (m.quoted?.text || m.arg || '').trim();
      if (!text) return m.reply(`❌ Give text, or reply to a message.\nExample: *${config.PREFIX}fix i am go to market*`);
      const out = await gemini([{ text: `Fix the grammar and spelling. Reply with the corrected text on the first line, then a blank line, then a one-line note of what you changed. Language: keep it in the same language as the input.\n\n${text}` }], 600);
      return m.reply(`✍️ *CORRECTED*\n\n${out}`);
    }

    /* ---------- OCR: photo -> text ---------- */
    case 'ocr':
    case 'read': {
      const media = await fetchMediaBase64(m, sock);
      if (!media || media.type !== 'image') return m.reply(`❌ Reply to a *photo* with *${config.PREFIX}ocr* to pull the text out of it.`);
      const out = await gemini([
        { text: 'Extract ALL text from this image exactly as written. Preserve line breaks. If there is no text, say "No text found in this image." Reply with only the extracted text.' },
        { inline_data: { mime_type: media.mime, data: media.base64 } },
      ], 1200);
      return m.reply(`📄 *TEXT FROM IMAGE*\n\n${out}`);
    }

    /* ---------- IMAGE DESCRIPTION ---------- */
    case 'describe':
    case 'whatis': {
      const media = await fetchMediaBase64(m, sock);
      if (!media || media.type !== 'image') return m.reply(`❌ Reply to a *photo* with *${config.PREFIX}describe*.`);
      const out = await gemini([
        { text: 'Describe this image in 2-3 sentences. Be specific and factual. Then, if there is any text in it, add a line starting with "Text:".' },
        { inline_data: { mime_type: media.mime, data: media.base64 } },
      ], 500);
      return m.reply(`🖼️ *IMAGE*\n\n${out}`);
    }

    /* ---------- VOICE NOTE -> TEXT ---------- */
    case 'stt':
    case 'transcribe': {
      const media = await fetchMediaBase64(m, sock);
      if (!media || media.type !== 'audio') return m.reply(`❌ Reply to a *voice note* with *${config.PREFIX}stt* to turn it into text.`);
      const out = await gemini([
        { text: 'Transcribe this audio. Reply with only the transcript. If it is in Urdu or Roman Urdu, write it in the same form it was spoken. If you cannot hear it, say "Could not transcribe."' },
        { inline_data: { mime_type: media.mime, data: media.base64 } },
      ], 900);
      return m.reply(`🎙️ *TRANSCRIPT*\n\n${out}`);
    }

    /* ---------- ASK A QUESTION ABOUT A DOCUMENT ---------- */
    case 'ask': {
      const media = await fetchMediaBase64(m, sock);
      if (!media) return m.reply(`❌ Reply to a photo or document with *${config.PREFIX}ask <your question>*.`);
      const q = m.arg || 'What is this?';
      const out = await gemini([
        { text: `Answer this question about the attached file: ${q}` },
        { inline_data: { mime_type: media.mime, data: media.base64 } },
      ], 900);
      return m.reply(`💬 *ANSWER*\n\n${out}`);
    }

    /* ---------- QUICK IDEA / BRAINSTORM ---------- */
    case 'idea':
    case 'brainstorm': {
      const topic = (m.arg || '').trim();
      if (!topic) return m.reply(`❌ Give a topic.\nExample: *${config.PREFIX}idea YouTube video about cricket*`);
      const out = await gemini([{ text: `Give 7 short, practical ideas about: ${topic}. One line each, numbered, no preamble.` }], 700);
      return m.reply(`💡 *IDEAS*\n\n${out}`);
    }

    /* ---------- EXPLAIN SIMPLY ---------- */
    case 'explain': {
      const topic = (m.arg || '').trim();
      if (!topic) return m.reply(`❌ Give a topic.\nExample: *${config.PREFIX}explain photosynthesis*`);
      const out = await gemini([{ text: `Explain "${topic}" simply, as if to a school student. Under 150 words, plain language, no preamble.` }], 600);
      return m.reply(`📖 *EXPLAIN*\n\n${out}`);
    }

    /* ---------- TO-DO LIST (per chat, persisted in memory) ---------- */
    case 'todo': {
      const store = global.__todoStore || (global.__todoStore = new Map());
      const key = m.chat;
      const list = store.get(key) || [];
      const arg = (m.arg || '').trim();

      if (!arg) {
        if (!list.length) return m.reply(`📋 *TO-DO*\n\nEmpty. Add one with *${config.PREFIX}todo buy milk*`);
        return m.reply(`📋 *TO-DO* (${list.filter(t => !t.done).length} open)\n\n` +
          list.map((t, i) => `${t.done ? '✅' : '⬜'} ${i + 1}. ${t.text}`).join('\n') +
          `\n\n▸ *${config.PREFIX}todo done <number>*  ▸ *${config.PREFIX}todo clear*`);
      }
      if (/^clear$/i.test(arg)) { store.set(key, []); return m.reply('✅ To-do list cleared.'); }
      const dm = arg.match(/^done\s+(\d+)$/i);
      if (dm) {
        const i = Number(dm[1]) - 1;
        if (!list[i]) return m.reply('❌ No item with that number.');
        list[i].done = true;
        store.set(key, list);
        return m.reply(`✅ Done: *${list[i].text}*`);
      }
      if (list.length >= 50) return m.reply('❌ List is full (50 items). Clear it first.');
      list.push({ text: arg.slice(0, 200), done: false });
      store.set(key, list);
      return m.reply(`✅ Added: *${arg.slice(0, 200)}*\n▸ *${config.PREFIX}todo* to see the list`);
    }

    /* ---------- REMINDER ---------- */
    case 'remind':
    case 'reminder': {
      const a = (m.arg || '').trim();
      const mm = a.match(/^(\d+)\s*(s|m|h|d)\s+(.+)$/i);
      if (!mm) return m.reply(`❌ Format: *${config.PREFIX}remind 30m take medicine*\nUnits: s (seconds), m (minutes), h (hours), d (days)`);
      const n = Number(mm[1]);
      const unit = mm[2].toLowerCase();
      const what = mm[3].slice(0, 200);
      const ms = n * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]);
      if (ms > 7 * 86400000) return m.reply('❌ Maximum is 7 days.');
      const at = new Date(Date.now() + ms);
      setTimeout(() => {
        sock.sendMessage(m.chat, {
          text: `⏰ *REMINDER*\n\n${what}`,
          mentions: m.sender ? [m.sender] : [],
        }).catch(() => {});
      }, ms);
      return m.reply(`⏰ Reminder set.\n\n▸ *${what}*\n▸ In ${n}${unit} — at ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`);
    }
  }
}

module.exports.commands = [
  { name: 'translate', desc: 'Translate text between languages', category: 'DAILY', handler },
  { name: 'tr', desc: 'Translate (short form)', category: 'DAILY', handler, hidden: true },
  { name: 'summary', desc: 'Summarise a long message', category: 'DAILY', handler },
  { name: 'summarize', desc: 'Summarise a long message', category: 'DAILY', handler, hidden: true },
  { name: 'fix', desc: 'Fix grammar and spelling', category: 'DAILY', handler },
  { name: 'grammar', desc: 'Fix grammar and spelling', category: 'DAILY', handler, hidden: true },
  { name: 'ocr', desc: 'Read text out of a photo', category: 'DAILY', handler },
  { name: 'describe', desc: 'Describe a photo', category: 'DAILY', handler },
  { name: 'stt', desc: 'Turn a voice note into text', category: 'DAILY', handler },
  { name: 'transcribe', desc: 'Turn a voice note into text', category: 'DAILY', handler, hidden: true },
  { name: 'ask', desc: 'Ask a question about a file', category: 'DAILY', handler },
  { name: 'idea', desc: 'Brainstorm ideas on a topic', category: 'DAILY', handler },
  { name: 'explain', desc: 'Explain a topic simply', category: 'DAILY', handler },
  { name: 'todo', desc: 'To-do list for this chat', category: 'DAILY', handler },
  { name: 'remind', desc: 'Set a reminder (e.g. 30m)', category: 'DAILY', handler },
];
