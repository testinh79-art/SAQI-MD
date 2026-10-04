/* SAQI-MD — Helper functions (media conversion, formatting, misc) */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

// ---- formatting ----
function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600),
        m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
  return `${d ? d + 'd ' : ''}${h}h ${m}m ${s}s`;
}

function mono(txt) { return `\`\`\`${txt}\`\`\``; }

// ---- temp files ----
const tmpFiles = [];
function tmpFile(ext) {
  const f = path.join(os.tmpdir(), `saqimd_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  tmpFiles.push(f);
  return f;
}
function cleanup(...files) {
  for (const f of files) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
}

// ---- ffmpeg runner (execFile-only: no shell injection) ----
function runFFmpeg(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.slice(0, 300) || err.message));
      resolve();
    });
  });
}

// image/video -> sticker webp (512x512, 10s max for video)
async function toSticker(inputBuffer, isVideo = false) {
  const inp = tmpFile(isVideo ? 'mp4' : 'jpg');
  const out = tmpFile('webp');
  fs.writeFileSync(inp, inputBuffer);
  await runFFmpeg(isVideo
    ? ['-i', inp, '-t', '10', '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2,fps=12', '-an', '-c:v', 'libwebp', '-quality', '80', out]
    : ['-i', inp, '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2', '-c:v', 'libwebp', '-quality', '85', out]);
  const buf = fs.readFileSync(out);
  cleanup(inp, out);
  return buf;
}

// video -> mp3
async function toMP3(inputBuffer) {
  const inp = tmpFile('bin');
  const out = tmpFile('mp3');
  fs.writeFileSync(inp, inputBuffer);
  await runFFmpeg(['-i', inp, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', out]);
  const buf = fs.readFileSync(out);
  cleanup(inp, out);
  return buf;
}

// YouTube search (no API key) -> first videoId + title
async function ytSearch(query) {
  const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  const html = await res.text();
  const re = /"videoRenderer":\{"videoId":"(.{11})".*?"text":"(.*?)"/;
  const m = html.match(re);
  if (!m) return null;
  return { id: m[1], title: m[2].replace(/\\u0026/g, '&').replace(/\\"/g, '"'), url: `https://youtu.be/${m[1]}` };
}

// YouTube download: khud-hosted cobalt instance (config.COBALT_API) se.
// PUBLIC converters (oceansaver, vevioz, api.cobalt.tools) sab MAR chuke hyn —
// YouTube ne inko block kar diya, aur cobalt.tools ka main instance Nov 2024 se
// shutdown hy. Is liye apni cobalt service Railway par chal rahi hy.
// cobalt v11 API: POST / -> { status:"tunnel", url, filename } ya { status:"redirect", url }
async function ytDownload(videoId, type = 'mp3') {
  const base = (config.COBALT_API || '').trim();
  if (!base) return null;
  const body = {
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoQuality: '720',
    audioFormat: 'mp3',
    filenameStyle: 'basic',
  };
  if (type === 'mp3') body.downloadMode = 'audio';
  else { body.downloadMode = 'auto'; body.videoQuality = '720'; }
  try {
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const j = await r.json().catch(() => null);
    if (!j) return null;
    if (j.status === 'tunnel' || j.status === 'redirect' || j.status === 'stream') return j.url || null;
    // purane cobalt versions / error shapes
    if (j.url) return j.url;
    if (j.status === 'error') console.error('[ytDownload] cobalt:', j.error?.code || j.text || 'error');
  } catch (e) { console.error('[ytDownload]', e.message); }
  return null;
}

module.exports = { fmtUptime, mono, tmpFile, cleanup, runFFmpeg, toSticker, toMP3, ytSearch, ytDownload };
