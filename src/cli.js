#!/usr/bin/env node
'use strict';
// tokentrimmer command line. Options come before the command; for `claude`, everything after it is
// passed to Claude Code unchanged:  tokentrimmer --mode balanced claude --resume
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const history = require('./history');

const VERSION = require('../package.json').version;
const MODES = ['safe', 'balanced', 'aggressive'];

const HELP = `tokentrimmer ${VERSION}: a local proxy that shrinks tool output in Claude Code / Anthropic / OpenAI requests.

Usage:
  tokentrimmer [options]                 start the proxy (same as: tokentrimmer start)
  tokentrimmer [options] claude [args]   run Claude Code through the proxy, starting it in the background if needed
  tokentrimmer doctor                    check the proxy and how Claude Code is routed
  tokentrimmer savings                   lifetime and daily savings (works without a running proxy)
  tokentrimmer stop                      stop a proxy started in the background by \`tokentrimmer claude\`

Options (each also has an environment variable):
  -p, --port <n>           port, default 8787                                   PORT
  --host <addr>            listen address, default 127.0.0.1                    HOST
  -m, --mode <mode>        safe (lossless, default) | balanced | aggressive     TOKENTRIMMER_MODE
  --dry-run                measure only, send requests unchanged                DRY_RUN=1
  --stale-after <n>        shrink tool results older than ~n messages (lossy)   TOKENTRIMMER_STALE_AFTER
  --retrieve               let Claude fetch shortened results back              TOKENTRIMMER_RETRIEVE=1
  --exclude-tools <a,b>    tool results never rewritten                         TOKENTRIMMER_EXCLUDE_TOOLS
  --no-verify              skip the per-request decode check                    TOKENTRIMMER_VERIFY=0
  --no-history             do not keep lifetime savings on disk                 TOKENTRIMMER_HISTORY=0
  --no-inspect             no before/after view in the dashboard                TOKENTRIMMER_INSPECT=0
  -h, --help               this help
  -v, --version            version

Lifetime savings (counts only, never content) are kept in ~/.tokentrimmer/stats.json
(set TOKENTRIMMER_HOME to move it). Dashboard: http://127.0.0.1:8787/
`;

function fail(msg) {
  console.error(`tokentrimmer: ${msg}\nRun \`tokentrimmer --help\` for usage.`);
  process.exit(2);
}

function parse(argv) {
  const o = { command: 'start', rest: [] };
  const value = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) fail(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith('--') && a.includes('=')) [a, inline] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)];
    const take = (name) => (inline !== null ? inline : value(i++, name));
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '-p': case '--port': o.port = Number(take(a)); if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) fail('--port must be a port number'); break;
      case '--host': o.host = take(a); break;
      case '-m': case '--mode': o.mode = take(a); if (!MODES.includes(o.mode)) fail(`--mode must be one of ${MODES.join(', ')}`); break;
      case '--dry-run': o.dryRun = true; break;
      case '--stale-after': o.staleAfter = Number(take(a)); if (!(o.staleAfter > 0)) fail('--stale-after must be a positive number'); break;
      case '--retrieve': o.retrieve = true; break;
      case '--exclude-tools': o.excludeTools = take(a).split(',').map((x) => x.trim()).filter(Boolean); break;
      case '--no-verify': o.verify = false; break;
      case '--no-history': o.history = false; break;
      case '--no-inspect': o.inspect = false; break;
      default:
        if (a.startsWith('-')) fail(`unknown option ${a}`);
        if (!['start', 'claude', 'doctor', 'savings', 'stop'].includes(a)) fail(`unknown command ${a}`);
        o.command = a;
        if (a === 'claude') {
          o.rest = argv.slice(i + 1);
          return o;
        }
    }
  }
  return o;
}

const portOf = (o) => Number(o.port ?? process.env.PORT ?? 8787);
const baseOf = (o) => `http://127.0.0.1:${portOf(o)}`;
const pidFile = (port) => path.join(history.homeDir(), `proxy-${port}.pid`);

async function health(base, ms = 1500) {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(ms) });
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch {
    return null;
  }
}

// Proxy settings from the parsed options; anything not given falls back to the environment.
function serverOptions(o) {
  const s = {};
  for (const k of ['port', 'host', 'mode', 'dryRun', 'staleAfter', 'retrieve', 'excludeTools', 'verify', 'inspect']) if (o[k] !== undefined) s[k] = o[k];
  const historyOn = o.history ?? process.env.TOKENTRIMMER_HISTORY !== '0';
  if (historyOn) s.historyFile = history.defaultFile();
  return s;
}

async function cmdStart(o) {
  const { start } = require('./proxy');
  try {
    await start(serverOptions(o));
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      const h = await health(baseOf(o));
      fail(h && h.name === 'tokentrimmer'
        ? `tokentrimmer ${h.version} is already running on port ${portOf(o)} (mode: ${h.mode})`
        : `port ${portOf(o)} is in use; pick another with --port`);
    }
    fail(e.message);
  }
}

// Start a proxy in the background (detached, logs to ~/.tokentrimmer/proxy-<port>.log) and wait for it.
async function startBackground(o) {
  const port = portOf(o);
  const dir = history.homeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(dir, `proxy-${port}.log`), 'a', 0o600);
  const args = [__filename, 'start', '--port', String(port)];
  if (o.host) args.push('--host', o.host);
  if (o.mode) args.push('--mode', o.mode);
  if (o.dryRun) args.push('--dry-run');
  if (o.staleAfter) args.push('--stale-after', String(o.staleAfter));
  if (o.retrieve) args.push('--retrieve');
  if (o.excludeTools) args.push('--exclude-tools', o.excludeTools.join(','));
  if (o.verify === false) args.push('--no-verify');
  if (o.history === false) args.push('--no-history');
  if (o.inspect === false) args.push('--no-inspect');
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  fs.writeFileSync(pidFile(port), String(child.pid), { mode: 0o600 });
  for (let i = 0; i < 100; i++) {
    const h = await health(baseOf(o), 500);
    if (h) return h;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`the proxy did not start; see ${path.join(dir, `proxy-${port}.log`)}`);
}

async function cmdClaude(o) {
  const base = baseOf(o);
  let h = await health(base);
  const env = { ...process.env, ANTHROPIC_BASE_URL: base };
  if (h && h.name !== 'tokentrimmer') fail(`something else is answering on port ${portOf(o)}; pick another with --port`);
  if (!h) {
    h = await startBackground(o);
    console.error(`tokentrimmer: started in the background on ${base} (mode: ${h.mode}); stop it with \`tokentrimmer stop\``);
  } else {
    // A proxy is already running with other settings: ask for this mode / dry run per request instead of restarting it.
    const extra = [];
    if (o.mode && o.mode !== h.mode) extra.push(`x-tokentrimmer-mode: ${o.mode}`);
    if (o.dryRun && !h.dryRun) extra.push('x-tokentrimmer-dry-run: 1');
    if (extra.length) {
      env.ANTHROPIC_CUSTOM_HEADERS = [env.ANTHROPIC_CUSTOM_HEADERS, ...extra].filter(Boolean).join('\n');
      const what = [o.mode && o.mode !== h.mode && `${o.mode} mode`, o.dryRun && !h.dryRun && 'dry run'].filter(Boolean).join(', ');
      console.error(`tokentrimmer: using the proxy already on ${base}, with ${what} for this session`);
    }
  }
  const child = spawn('claude', o.rest, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  child.on('error', (e) => fail(e.code === 'ENOENT' ? 'Claude Code (`claude`) was not found on your PATH' : e.message));
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {}); // Claude Code handles Ctrl-C itself
}

async function cmdStop(o) {
  const port = portOf(o);
  let pid;
  try {
    pid = Number(fs.readFileSync(pidFile(port), 'utf8'));
  } catch {
    const h = await health(baseOf(o));
    if (!h) return console.log(`tokentrimmer: no proxy running on port ${port}`);
    fail(`the proxy on port ${port} was not started by \`tokentrimmer claude\`; stop it where it runs (Ctrl-C)`);
  }
  // Only signal the saved process if a tokentrimmer proxy is really answering there (pids get reused).
  const h = await health(baseOf(o));
  if (!h || h.name !== 'tokentrimmer') {
    fs.rmSync(pidFile(port), { force: true });
    return console.log(`tokentrimmer: no proxy was running on port ${port}`);
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`tokentrimmer: stopped the proxy on port ${port}`);
  } catch {
    console.log(`tokentrimmer: the proxy on port ${port} was not started by \`tokentrimmer claude\`; stop it where it runs (Ctrl-C)`);
  }
  fs.rmSync(pidFile(port), { force: true });
}

const mark = { ok: '✓', warn: '!', bad: '✗' };

async function cmdDoctor(o) {
  const port = portOf(o);
  const base = baseOf(o);
  const out = [];
  const add = (level, text) => out.push([level, text]);
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 18 ? 'ok' : 'bad', `Node ${process.versions.node}${major >= 18 ? '' : ' (needs 18 or newer)'}`);

  const h = await health(base);
  if (h && h.name === 'tokentrimmer') {
    add('ok', `proxy ${h.version} running on ${base} (mode: ${h.mode}${h.dryRun ? ', dry run: nothing is compressed' : ''})`);
    if (h.version !== VERSION) add('warn', `this command is ${VERSION} but the running proxy is ${h.version}; restart it to update`);
    try {
      const s = await (await fetch(`${base}/stats`, { signal: AbortSignal.timeout(1500) })).json();
      if (!s.requests) add('warn', 'no requests seen yet: is your client pointed at it?');
      else add('ok', `${s.requests} requests so far, ${s.before ? Math.round((s.saved / s.before) * 100) : 0}% saved`);
      if (s.verifyFailed) add('warn', `${s.verifyFailed} rewrites failed the check and were sent unchanged (please report)`);
      if (s.recent && s.recent.some((r) => r.status >= 400)) add('warn', 'some recent requests got an error from the API (see the dashboard)');
    } catch { /* stats are optional */ }
  } else if (h) {
    add('bad', `port ${port} answers but it is not tokentrimmer`);
  } else {
    add('bad', `no proxy on ${base}: start one with \`tokentrimmer\` or \`tokentrimmer claude\``);
  }

  const envUrl = process.env.ANTHROPIC_BASE_URL;
  const pointsHere = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(u || '') && Number(new URL(u).port || 80) === port;
  if (!envUrl) add('warn', 'ANTHROPIC_BASE_URL is not set in this shell (fine if you use `tokentrimmer claude` or settings.json)');
  else add(pointsHere(envUrl) ? 'ok' : 'warn', `ANTHROPIC_BASE_URL=${envUrl}${pointsHere(envUrl) ? '' : ' does not point at this proxy'}`);

  const settings = path.join(require('node:os').homedir(), '.claude', 'settings.json');
  try {
    const j = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const u = j.env && j.env.ANTHROPIC_BASE_URL;
    if (u && pointsHere(u)) add(h ? 'ok' : 'bad', `~/.claude/settings.json routes every Claude Code session here${h ? '' : ', but the proxy is down, so Claude Code cannot connect'}`);
    else if (u) add('warn', `~/.claude/settings.json sets ANTHROPIC_BASE_URL=${u} (not this proxy)`);
    else add('ok', '~/.claude/settings.json does not route through a proxy (use `tokentrimmer claude` per session)');
  } catch {
    add('ok', 'no ~/.claude/settings.json override');
  }

  const which = spawn(process.platform === 'win32' ? 'where' : 'which', ['claude']);
  const found = await new Promise((r) => which.on('exit', (c) => r(c === 0)).on('error', () => r(false)));
  add(found ? 'ok' : 'warn', found ? 'Claude Code (`claude`) is on your PATH' : 'Claude Code (`claude`) not found on your PATH');

  const file = history.defaultFile();
  add('ok', fs.existsSync(file) ? `lifetime savings kept in ${file}` : 'no lifetime savings recorded yet');

  for (const [level, text] of out) console.log(`${mark[level]} ${text}`);
  const worst = out.some(([l]) => l === 'bad') ? 2 : out.some(([l]) => l === 'warn') ? 1 : 0;
  console.log(worst === 0 ? '\nAll good.' : worst === 1 ? '\nWorking, with warnings.' : '\nSomething needs fixing.');
  process.exit(worst);
}

function cmdSavings() {
  const file = history.defaultFile();
  if (!fs.existsSync(file)) {
    console.log(`No savings recorded yet (${file}). Run the proxy with \`tokentrimmer\` or \`tokentrimmer claude\`.`);
    return;
  }
  const d = history.read(file);
  const n = (x) => Math.round(x).toLocaleString('en-US');
  const pct = (s, b) => (b ? `${((s / b) * 100).toFixed(1)}%` : '0%');
  console.log(`Lifetime since ${d.since.slice(0, 10)}: ${n(d.requests)} requests, ~${n(d.saved)} tokens saved of ~${n(d.before)} (${pct(d.saved, d.before)})`);
  if (d.retrievals) console.log(`Retrievals: ${n(d.retrievals)}`);
  if (d.verifyFailed) console.log(`Rewrites that failed the check and were sent unchanged: ${n(d.verifyFailed)}`);
  const days = Object.keys(d.days).sort().slice(-14);
  if (days.length) {
    console.log('\nDay          Requests   Tokens before   Saved');
    for (const k of days) {
      const v = d.days[k];
      console.log(`${k}   ${String(n(v.requests)).padStart(8)}   ${String(n(v.before)).padStart(13)}   ${String(n(v.saved)).padStart(9)} (${pct(v.saved, v.before)})`);
    }
  }
  const techs = Object.entries(d.techniques).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (techs.length) console.log(`\nMost used: ${techs.map(([t, c]) => `${t} ${n(c)}`).join(', ')}`);
  console.log('\nToken counts are estimates (about 4 characters per token). The dashboard shows what the API reported.');
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) return console.log(HELP);
  if (o.version) return console.log(VERSION);
  if (o.command === 'start') return cmdStart(o);
  if (o.command === 'claude') return cmdClaude(o);
  if (o.command === 'doctor') return cmdDoctor(o);
  if (o.command === 'savings') return cmdSavings(o);
  if (o.command === 'stop') return cmdStop(o);
}

main().catch((e) => fail(e.message));
