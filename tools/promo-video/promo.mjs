#!/usr/bin/env node
// Builds the VidVNC promo video from code: voiceover, music, picture, mix and captions.
//
//   node tools/promo-video/promo.mjs setup     install the tools into .deps/promo-video
//   node tools/promo-video/promo.mjs voices    female voice samples
//   node tools/promo-video/promo.mjs draft     the next numbered draft: cut (30 fps), storyboard, audio
//   node tools/promo-video/promo.mjs final     the next numbered final cut (60 fps)
//
// Outputs go to out/promo-video/ (ignored by git). Runs on Windows, macOS and Linux with
// Node 20+, Python 3.10+ and Chrome or Edge (or CHROMIUM=/path/to/chrome); ffmpeg comes
// from ffmpeg-static unless FFMPEG names one. See README.md.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  createWriteStream,
  copyFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES, DURATION } from './timeline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const cache = process.env.PROMO_CACHE || path.join(repo, '.deps', 'promo-video');
const outRoot = process.env.PROMO_OUT || path.join(repo, 'out', 'promo-video');
const win = process.platform === 'win32';

// Every draft and final cut gets the next numbered folder (drafts/05, final/01) and is never
// overwritten. In it, build-info.txt and commit.url link back to the commit that built it, so
// any revision can be rebuilt exactly.
const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).stdout?.trim();
function outDir(group) {
  const parent = path.join(outRoot, group);
  mkdirSync(parent, { recursive: true });
  const last = Math.max(0, ...readdirSync(parent).map((f) => (/^\d+$/.test(f) ? Number(f) : 0)));
  const d = path.join(parent, String(last + 1).padStart(2, '0'));
  mkdirSync(d);
  const commit = git('rev-parse', 'HEAD') || 'unknown';
  const remote = (git('remote', 'get-url', 'origin') || 'https://github.com/kiforsbe/vidvnc')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
  const url = `${remote}/commit/${commit}`;
  const dirty = git('status', '--porcelain', '--', 'tools/promo-video');
  if (dirty) console.warn('warning: tools/promo-video has uncommitted changes; commit them first');
  writeFileSync(
    path.join(d, 'build-info.txt'),
    `commit: ${commit}${dirty ? ' (plus uncommitted changes)' : ''}\n` +
      `link: ${url}\n` +
      `command: promo.mjs ${process.argv.slice(2).join(' ')}\n` +
      `built: ${new Date().toISOString()}\n`,
  );
  writeFileSync(path.join(d, 'commit.url'), `[InternetShortcut]\r\nURL=${url}\r\n`);
  console.log(`Output: ${d}`);
  return d;
}
const venvPython = path.join(cache, 'venv', win ? 'Scripts/python.exe' : 'bin/python');

const PINS = {
  npm: ['playwright-core@1.56.1', 'ffmpeg-static@5.2.0', 'three@0.180.0'],
  pip: ['kokoro-onnx==0.6.1', 'soundfile==0.13.1', 'numpy>=2,<3'],
  models: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/',
  modelFiles: ['kokoro-v1.0.onnx', 'voices-v1.0.bin'],
};
const VOICES = ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'bf_emma', 'bf_isabella'];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0)
    throw new Error(
      `${path.basename(cmd)} ${args[0] ?? ''} failed (${r.status ?? r.error?.message})`,
    );
}
function download(url, file) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return download(res.headers.location, file).then(resolve, reject);
        if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`));
        const f = createWriteStream(file);
        res.pipe(f);
        f.on('finish', () => f.close(resolve));
        f.on('error', reject);
      })
      .on('error', reject);
  });
}
const nodeRequire = () => createRequire(path.join(cache, 'node', 'package.json'));
const ffmpeg = () => process.env.FFMPEG || nodeRequire()('ffmpeg-static');
const py = (script, ...args) => run(venvPython, ['-I', path.join(here, script), ...args]);

async function setup() {
  mkdirSync(path.join(cache, 'node'), { recursive: true });
  mkdirSync(path.join(cache, 'models'), { recursive: true });
  const npm = win ? 'npm.cmd' : 'npm';
  if (!existsSync(path.join(cache, 'node', 'package.json')))
    writeFileSync(path.join(cache, 'node', 'package.json'), '{ "private": true }\n');
  run(npm, ['install', '--no-audit', '--no-fund', '--silent', ...PINS.npm], {
    cwd: path.join(cache, 'node'),
    shell: win,
  });
  if (!existsSync(venvPython))
    run(win ? 'py' : 'python3', [...(win ? ['-3'] : []), '-m', 'venv', path.join(cache, 'venv')]);
  run(venvPython, ['-m', 'pip', 'install', '--quiet', ...PINS.pip]);
  for (const f of PINS.modelFiles) {
    const dest = path.join(cache, 'models', f);
    if (!existsSync(dest)) {
      console.log(`downloading ${f}`);
      await download(PINS.models + f, dest);
    }
  }
  console.log(`Tools ready in ${cache}`);
}

// ---- picture --------------------------------------------------------------------------------
// The page is served over a local HTTP server; /assets/ maps onto files already in the repo.
const ASSETS = {
  'fonts/': path.join(repo, 'site/fonts/'),
  'mac/': path.join(repo, 'docs/images/macos-host/'),
  'win/': path.join(repo, 'docs/images/windows-host/'),
  'icon.png': path.join(
    repo,
    'apps/macos-host/VidVNC/Assets.xcassets/AppIcon.appiconset/icon_256x256@2x.png',
  ),
};
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
let eqFile = null; // the desktop track's spectrum, written by music.py for the visualiser
function serve() {
  const server = http
    .createServer((req, res) => {
      const u = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
      let file = null;
      // the page and its modules: the engine, the scenes and the timeline
      if (u === 'film.html') file = path.join(here, 'engine', u);
      else if (/^(engine|scenes)\/[\w.-]+\.mjs$/.test(u) || u === 'timeline.mjs')
        file = path.join(here, u);
      else if (u === 'eq.json') file = eqFile;
      else if (u.startsWith('vendor/')) file = path.join(cache, 'node', 'node_modules', u.slice(7));
      else if (u.startsWith('assets/')) {
        const rest = u.slice(7);
        for (const [prefix, target] of Object.entries(ASSETS)) {
          if (rest === prefix) file = target;
          else if (prefix.endsWith('/') && rest.startsWith(prefix))
            file = path.join(target, rest.slice(prefix.length));
        }
      }
      if (!file || file.includes('..') || !existsSync(file)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      });
      res.end(readFileSync(file));
    })
    .listen(0, '127.0.0.1');
  return new Promise((r) => server.once('listening', () => r(server)));
}
async function openPage() {
  const { chromium } = nodeRequire()('playwright-core');
  const tries = process.env.CHROMIUM
    ? [{ executablePath: process.env.CHROMIUM }]
    : [{ channel: 'chrome' }, { channel: 'msedge' }, {}];
  let browser, last;
  for (const t of tries) {
    try {
      browser = await chromium.launch({
        ...t,
        args: ['--force-color-profile=srgb', '--hide-scrollbars'],
      });
      break;
    } catch (e) {
      last = e;
    }
  }
  if (!browser)
    throw new Error(
      `No Chromium found; install Chrome or Edge, or set CHROMIUM. (${last?.message.split('\n')[0]})`,
    );
  const server = await serve();
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/film.html`);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  await page.evaluate(() => window.ready);
  const shot = async (t, type) => {
    await page.evaluate((t) => window.render(t), t);
    return page.screenshot(type === 'png' ? { type } : { type, quality: 95 });
  };
  return {
    shot,
    close: async () => {
      await browser.close();
      server.close();
    },
  };
}
// One still per moment the timeline names, named after its scene: frame-02-race.png, or
// frame-09-security-1.png when a scene has several.
async function stills(dir) {
  mkdirSync(dir, { recursive: true });
  const p = await openPage();
  for (const s of SCENES)
    for (const [i, t] of s.stills.entries()) {
      const n = s.stills.length > 1 ? `-${i + 1}` : '';
      const name = `frame-${s.file.replace(/\.mjs$/, '')}${n}.png`;
      writeFileSync(path.join(dir, name), await p.shot(t, 'png'));
    }
  await p.close();
}
// storyboard/index.html: each scene's stills with the voiceover lines spoken over it, so the
// storyboard reads like a script. Open it in any browser.
function storyboardPage(dir) {
  const vo = JSON.parse(readFileSync(path.join(here, 'voiceover.json'), 'utf8')).lines;
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const secs = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  const rows = SCENES.map((s) => {
    const name = s.file.replace(/\.mjs$/, '');
    const imgs = s.stills
      .map((_, i) => `<img src="frame-${name}${s.stills.length > 1 ? `-${i + 1}` : ''}.png">`)
      .join('');
    const lines = vo
      .filter((l) => l.at >= s.start && l.at < s.end)
      .map((l) => `<p><span>${secs(l.at)}</span>${esc(l.caption || l.text)}</p>`)
      .join('');
    return (
      `<section><h2>${name.slice(0, 2)} · ${esc(s.id)} <small>${secs(s.start)} to ${secs(s.end)}</small></h2>` +
      `<div class="imgs">${imgs}</div>${lines || '<p class="none">No voiceover</p>'}</section>`
    );
  }).join('');
  writeFileSync(
    path.join(dir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>VidVNC promo storyboard</title><style>` +
      `body{margin:0 auto;max-width:1100px;padding:24px;background:#0a0f1c;color:#e6ebf5;font:16px system-ui,sans-serif}` +
      `section{margin:0 0 40px}h2{font-size:20px;margin:0 0 10px}small{color:#8693ab;font-weight:400;margin-left:8px}` +
      `.imgs{display:flex;gap:8px}.imgs img{flex:1;min-width:0;border-radius:8px}` +
      `p{margin:10px 0;font-size:18px;line-height:1.4}p span{color:#8693ab;font:14px monospace;margin-right:12px}` +
      `.none{color:#8693ab;font-style:italic}</style><h1>VidVNC promo storyboard</h1>${rows}`,
  );
}
async function contactSheet(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('frame-'))
    .sort();
  const list = path.join(dir, 'frames.txt');
  writeFileSync(
    list,
    files.map((f) => `file '${path.join(dir, f).replace(/\\/g, '/')}'`).join('\n'),
  );
  const rows = Math.ceil(files.length / 3);
  run(ffmpeg(), [
    '-loglevel',
    'error',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-vf',
    `scale=640:360,tile=3x${rows}:padding=8:color=0x0a0f1c`,
    '-frames:v',
    '1',
    path.join(dir, 'contact-sheet.png'),
  ]);
  rmSync(list);
}
async function video(file, fps, duration = DURATION) {
  const p = await openPage();
  const ff = spawn(
    ffmpeg(),
    [
      '-loglevel',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      String(fps),
      '-c:v',
      'mjpeg',
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '17',
      '-pix_fmt',
      'yuv420p',
      file,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const n = Math.round(duration * fps);
  for (let i = 0; i < n; i++) {
    const buf = await p.shot(i / fps, 'jpeg');
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % (fps * 10) === 0) console.log(`  picture ${Math.round(i / fps)} s of ${duration} s`);
  }
  ff.stdin.end();
  await new Promise((res, rej) =>
    ff.on('close', (c) => (c ? rej(new Error(`ffmpeg exited ${c}`)) : res())),
  );
  await p.close();
}

// ---- sound ----------------------------------------------------------------------------------
function sound(work) {
  console.log('== voiceover');
  py(
    'voiceover.py',
    cache,
    path.join(here, 'voiceover.json'),
    path.join(work, 'vo.wav'),
    path.join(work, 'vo.srt'),
    String(DURATION),
  );
  console.log('== music');
  eqFile = path.join(work, 'eq.json');
  const cues = path.join(work, 'timeline.json'); // music.py places its cues on the scenes
  writeFileSync(cues, JSON.stringify({ duration: DURATION, scenes: SCENES }));
  py('music.py', path.join(work, 'music.wav'), cues, eqFile);
  console.log('== mix'); // the music ducks under the voice, then the mix is levelled for the web (-14 LUFS)
  run(ffmpeg(), [
    '-loglevel',
    'error',
    '-y',
    '-i',
    path.join(work, 'music.wav'),
    '-i',
    path.join(work, 'vo.wav'),
    '-filter_complex',
    '[1:a]aresample=44100,pan=stereo|c0=c0|c1=c0,volume=1.6[vo];[vo]asplit=2[vo1][vo2];' +
      '[0:a]volume=0.45[mu];[mu][vo1]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=450[duck];' +
      '[duck][vo2]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=9',
    '-ar',
    '48000',
    '-t',
    String(DURATION),
    path.join(work, 'mix.wav'),
  ]);
}

// A draft holds the cut at 30 fps, its captions, the storyboard (one still per shot and a
// contact sheet) and the audio stems; a final cut holds the film at 60 fps and its captions.
async function film(kind) {
  const fps = kind === 'final' ? 60 : 30;
  const out = outDir(kind === 'final' ? 'final' : 'drafts');
  const work = path.join(cache, `work-${kind}`);
  mkdirSync(work, { recursive: true });
  sound(work); // first: the storyboard and picture read the music's spectrum
  if (kind === 'draft') {
    console.log('== storyboard');
    const board = path.join(out, 'storyboard');
    await stills(board);
    await contactSheet(board);
    storyboardPage(board);
  }
  console.log(`== picture (${fps} fps)`);
  await video(path.join(work, 'picture.mp4'), fps);
  console.log('== mux');
  run(ffmpeg(), [
    '-loglevel',
    'error',
    '-y',
    '-i',
    path.join(work, 'picture.mp4'),
    '-i',
    path.join(work, 'mix.wav'),
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    '-movflags',
    '+faststart',
    path.join(out, 'vidvnc-promo.mp4'),
  ]);
  copyFileSync(path.join(work, 'vo.srt'), path.join(out, 'vidvnc-promo.en.srt'));
  if (kind === 'draft') {
    const audio = path.join(out, 'audio');
    mkdirSync(audio);
    for (const [from, to] of [
      ['vo.wav', 'voiceover.wav'],
      ['music.wav', 'music.wav'],
      ['mix.wav', 'mix.wav'],
    ])
      copyFileSync(path.join(work, from), path.join(audio, to));
  }
  console.log(`Wrote ${out}`);
}

async function voices() {
  const out = path.join(outRoot, 'voice-samples');
  const work = path.join(cache, 'work-voices');
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });
  py('voice-samples.py', cache, work, ...VOICES);
  VOICES.forEach((v, i) => {
    const label = v.replace(/^af_/, 'american-').replace(/^bf_/, 'british-');
    run(ffmpeg(), [
      '-loglevel',
      'error',
      '-y',
      '-i',
      path.join(work, `${v}.wav`),
      '-af',
      'loudnorm=I=-16:TP=-1.5',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      path.join(out, `voice-${i + 1}-${label}.m4a`),
    ]);
  });
  console.log(`Wrote ${out}`);
}

const cmd = process.argv[2];
const steps = {
  setup,
  voices,
  draft: () => film('draft'),
  final: () => film('final'),
};
if (!steps[cmd]) {
  console.error('usage: promo.mjs setup | voices | draft | final');
  process.exit(2);
}
await steps[cmd]();
