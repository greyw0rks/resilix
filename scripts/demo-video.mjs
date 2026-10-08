#!/usr/bin/env node
//
// Records a demo video of the console running against a live Canton ledger.
//
// It drives a headless Chromium over the DevTools Protocol: clicks the real
// buttons, waits, and captures the page as a screencast. Captions are injected
// into the DOM rather than burned in afterwards, so they sit in the app's own
// font and are timed by the same clock as the actions that produce them.
//
// Frames arrive only when the page changes, so each frame carries its arrival
// time and the encoder holds it for that long — the video's pacing is the real
// pacing, not a fixed frame rate.
//
// Prereqs: a live ledger (`npm run ledger:up`) and the app running in live mode
// with the current .env.local (`npm run build && npx next start -p 3200`).
// Usage:   node scripts/demo-video.mjs [--keep]
// Output:  brag-output/demo.mp4 (plus .jpg poster and .srt captions)

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const APP_URL = process.env.DEMO_URL ?? 'http://localhost:3200';
const OUT_DIR = process.env.DEMO_OUT_DIR ?? 'brag-output';
const OUT_MP4 = path.join(OUT_DIR, 'demo.mp4');
const OUT_SRT = path.join(OUT_DIR, 'demo.srt');
const OUT_POSTER = path.join(OUT_DIR, 'demo.jpg');
const FRAMES = '/tmp/canton-demo-frames';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const VIEWPORT = { width: 1920, height: 1080 };

// Playwright's bundled headless shell; the app's own Chromium is not installed
// in this repo. Override with CHROME_BIN if yours lives elsewhere.
const CANDIDATE_BROWSERS = [
  process.env.CHROME_BIN,
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`,
].filter(Boolean);

const CHROME = CANDIDATE_BROWSERS.find((p) => existsSync(p));
const CHROME_LIBS = `${process.env.HOME}/.local/chromedeps/root/usr/lib/x86_64-linux-gnu`;

const log = (...a) => console.log('   ', ...a);
const ms = (s) => new Promise((r) => setTimeout(r, s * 1000));

// --- CDP client -------------------------------------------------------------
// One browser websocket, flattened sessions, promise-per-command.

function connectCDP(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const cdp = {
      ws,
      nextId: 0,
      pending: new Map(),
      listeners: new Map(),
      sessionId: null,
    };
    ws.onopen = () => resolve(cdp);
    ws.onerror = () => reject(new Error(`could not open ${url}`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = cdp.pending.get(msg.id);
        if (!p) return;
        cdp.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        return;
      }
      for (const h of cdp.listeners.get(msg.method) ?? []) h(msg.params ?? {});
    };
    cdp.send = (method, params = {}, sessionId = cdp.sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++cdp.nextId;
        cdp.pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    cdp.on = (method, h) => {
      const a = cdp.listeners.get(method) ?? [];
      a.push(h);
      cdp.listeners.set(method, a);
    };
  });
}

// --- page helpers -----------------------------------------------------------

const CAPTION_ID = '__demo_caption';

const SET_CAPTION = (text) => `(() => {
  let el = document.getElementById('${CAPTION_ID}');
  if (!el) {
    el = document.createElement('div');
    el.id = '${CAPTION_ID}';
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:30px', 'transform:translateX(-50%)',
      'max-width:1500px', 'padding:16px 30px', 'border-radius:14px',
      'background:rgba(7,11,18,0.9)', 'border:1px solid rgba(255,255,255,0.14)',
      'color:#e2e8f0', 'font:500 27px/1.4 Inter,system-ui,-apple-system,sans-serif',
      'text-align:center', 'z-index:2147483647',
      'box-shadow:0 16px 48px rgba(0,0,0,0.55)'
    ].join(';');
    document.body.appendChild(el);
  }
  el.textContent = ${JSON.stringify(text)};
  return true;
})()`;

const CLICK = (match, { exact = false } = {}) => `(() => {
  const m = ${JSON.stringify(match)};
  const els = [...document.querySelectorAll('button,a')];
  const hit = els.find(e => {
    const t = (e.textContent || '').replace(/\\s+/g, ' ').trim();
    return ${exact ? 't === m' : 't.includes(m)'};
  });
  if (!hit) return 'NOT-FOUND::' + m;
  if (hit.disabled) return 'DISABLED::' + m;
  hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
  hit.click();
  return 'OK';
})()`;

const SCROLL_TO = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'NOT-FOUND::' + ${JSON.stringify(selector)};
  const y = el.getBoundingClientRect().top + window.scrollY - 90;
  window.scrollTo({ top: y, behavior: 'smooth' });
  return 'OK';
})()`;

const READY = `(() => {
  const t = document.body.innerText || '';
  return t.includes('Shared control') && t.includes('Distributed hosting');
})()`;

// --- capture ----------------------------------------------------------------

async function main() {
  if (!CHROME) {
    console.error('No Chromium found. Set CHROME_BIN, or install Playwright\'s headless shell.');
    process.exit(1);
  }

  const live = await fetch('http://localhost:7575/v2/state/connected-synchronizers')
    .then((r) => r.ok)
    .catch(() => false);
  if (!live) {
    console.error('No ledger at :7575 — run `npm run ledger:up` first.');
    process.exit(1);
  }

  await rm(FRAMES, { recursive: true, force: true });
  await mkdir(FRAMES, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  console.log('==> launching headless Chromium');
  const chrome = spawn(
    CHROME,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      `--remote-debugging-port=${CDP_PORT}`,
      'about:blank',
    ],
    {
      env: { ...process.env, LD_LIBRARY_PATH: [CHROME_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let chromeErr = '';
  chrome.stderr.on('data', (d) => (chromeErr += d.toString()));

  const bail = (code) => {
    chrome.kill('SIGKILL');
    process.exit(code);
  };

  // Wait for the DevTools endpoint.
  let version;
  for (let i = 0; i < 40; i++) {
    try {
      version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
      break;
    } catch {
      await ms(0.5);
    }
  }
  if (!version?.webSocketDebuggerUrl) {
    console.error('Chromium never opened a DevTools endpoint.\n' + chromeErr);
    bail(1);
  }

  const cdp = await connectCDP(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  cdp.sessionId = sessionId;

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  };

  // Recorded before capture starts, so it is a pure navigation.
  await cdp.send('Page.navigate', { url: APP_URL });
  for (let i = 0; i < 60; i++) {
    if (await evaluate(READY).catch(() => false)) break;
    await ms(0.5);
  }
  if (!(await evaluate(READY).catch(() => false))) {
    console.error(`The console never finished loading at ${APP_URL}. Is the app running in live mode?`);
    bail(1);
  }
  log('console loaded, ledger state read');

  // --- frames ---
  const frames = [];
  const t0 = Date.now();
  let dropped = 0;
  let writing = Promise.resolve();
  cdp.on('Page.screencastFrame', (p) => {
    const file = `f${String(frames.length).padStart(6, '0')}.jpg`;
    frames.push({ file, t: (Date.now() - t0) / 1000 });
    // Frames must be written in order; the timeline is appended synchronously
    // above, so serialising the writes here is enough.
    writing = writing
      .then(() => writeFile(path.join(FRAMES, file), Buffer.from(p.data, 'base64')))
      .catch(() => dropped++);
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 90,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });

  // --- scripted scenes ---
  const cues = [];
  const scene = async (text, seconds) => {
    cues.push({ t: (Date.now() - t0) / 1000, text });
    log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${text}`);
    await evaluate(SET_CAPTION(text));
    await ms(seconds);
  };
  const act = async (label, expr) => {
    const result = await evaluate(expr).catch((e) => 'ERROR::' + e.message);
    if (result !== 'OK') log(`  !! ${label}: ${result}`);
    return result;
  };

  // 1 — the question
  await scene('Every institutional application has privileged actions.', 6);
  await scene('Guarded by one signer, or one operator — a single point of control.', 8);
  await scene('So: what happens when that operator disappears?', 6);

  // 2 — what this is
  await act('scroll to applications', SCROLL_TO('#applications'));
  await scene('Canton Resilience — a reusable control layer for Canton applications.', 8);
  await scene('Policy, multi-party approval, resilient hosting, and audit.', 6);
  await scene('The header reads json-api. Every click from here is a real Daml command.', 8);

  // 3 — shared control
  await act('scroll to approvals', SCROLL_TO('#approvals'));
  await scene('Shared control: two of three parties must approve this transfer.', 6);
  await act('approve alice', CLICK('Alice'));
  await scene('Alice approves. One of two — execution is still blocked.', 7);
  await scene('And that block is on the ledger, not in this UI.', 5);
  await act('approve bob', CLICK('Bob'));
  await scene('Bob — a different operator, a different party. Quorum met.', 8);

  // 4 — distributed hosting
  await act('scroll to hosting', SCROLL_TO('#hosting'));
  await scene('Independently: three hosting operators, two must stay online.', 7);
  await scene('Each operator reports its own node. No admin acts for it.', 6);
  await act('node A offline', CLICK('Node A'));
  await scene('Node A goes down. Two of three — the application stays available.', 8);
  await scene('One operator disappearing is not an incident.', 5);
  await act('node B offline', CLICK('Node B'));
  await scene('Node B too. One of three — below threshold, and now unavailable.', 7);
  await scene('The contract itself refuses to execute below threshold.', 7);

  // 5 — recovery, then who signs
  await act('node B online', CLICK('Node B'));
  await scene('Bring the operator back, and it is permitted again.', 7);
  await act('connect wallet', CLICK('Connect Grofty'));
  await scene('The approval and the execution are authorized by the user\'s own Canton party.', 7);
  await act('demo signer', CLICK('Use the demo signer'));
  await scene('No wallet in this browser — and the console says so rather than pretending.', 9);
  await act('execute', CLICK('Execute'));
  await scene('Executed, and recorded on the ledger.', 8);

  // 6 — audit, and that it is not local state
  await act('scroll to audit', SCROLL_TO('#audit'));
  await scene('Every request, approval, hosting change and execution is an immutable AuditRecord.', 8);
  await scene('Including the operator count at the moment of execution.', 6);
  await act('reload', `(() => { location.reload(); return 'OK'; })()`);
  await ms(1.5);
  for (let i = 0; i < 60; i++) {
    if (await evaluate(READY).catch(() => false)) break;
    await ms(0.5);
  }
  await scene('Hard refresh — approvals, hosting and audit all come back.', 8);
  await scene('None of it was local UI state.', 5);

  // 7 — close
  await act('scroll to top', `(() => { window.scrollTo({top:0,behavior:'smooth'}); return 'OK'; })()`);
  await scene('Canton Resilience: decentralized control, enforced by the ledger — and proven on one.', 9);

  await writing;
  await cdp.send('Page.stopScreencast').catch(() => {});
  const duration = (Date.now() - t0) / 1000;
  console.log(`==> captured ${frames.length} frames over ${duration.toFixed(1)}s (${dropped} write errors)`);
  if (frames.length < 20) {
    console.error('Too few frames to encode — the page never rendered.');
    bail(1);
  }

  // --- encode ---
  // Each frame is held until the next one arrives, so the video keeps the real
  // pacing of the actions rather than a nominal frame rate. Paths are absolute
  // because ffmpeg resolves concat entries relative to the list file.
  const abs = (f) => path.join(FRAMES, f);
  const concat = frames
    .map((f, i) => {
      const next = frames[i + 1];
      const hold = next ? Math.max(0.04, next.t - f.t) : 0.5;
      return `file '${abs(f.file)}'\nduration ${hold.toFixed(3)}`;
    })
    .join('\n');
  await writeFile('/tmp/canton-demo-concat.txt', `${concat}\nfile '${abs(frames.at(-1).file)}'\n`);

  console.log('==> encoding');
  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', '/tmp/canton-demo-concat.txt',
    '-vf', 'fps=30,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart',
    OUT_MP4,
  ]);

  // Poster: the frame that carries the quorum, so the still says something.
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(duration * 0.45), '-i', OUT_MP4, '-frames:v', '1', '-q:v', '3', OUT_POSTER]);

  await writeFile(OUT_SRT, toSrt(cues, duration));

  const size = (await stat(OUT_MP4)).size;
  console.log(`==> wrote ${OUT_MP4} (${(size / 1e6).toFixed(1)} MB, ${duration.toFixed(0)}s)`);
  console.log(`==> wrote ${OUT_POSTER} and ${OUT_SRT}`);
  console.log(`    frames left in ${FRAMES} (rm -rf to clean)`);

  chrome.kill('SIGKILL');
  process.exit(0);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// Minimal SRT from the cue list: the captions are the narration, so a subtitle
// track makes the video usable as a silent artifact too.
function toSrt(cues, duration) {
  const stamp = (s) => {
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(Math.floor(s % 60)).padStart(2, '0');
    const msec = String(Math.round((s % 1) * 1000)).padStart(3, '0');
    return `${h}:${m}:${sec},${msec}`;
  };
  return cues
    .map((c, i) => {
      const end = cues[i + 1]?.t ?? duration;
      return `${i + 1}\n${stamp(c.t)} --> ${stamp(end)}\n${c.text}\n`;
    })
    .join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
