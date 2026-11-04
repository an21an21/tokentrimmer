'use strict';
// Lifetime savings, kept across proxy restarts in a small JSON file (default ~/.tokentrimmer/stats.json,
// or $TOKENTRIMMER_HOME/stats.json). Only counts are stored, never request content.
// Several proxies may share the file (different ports), so each one adds its own deltas to whatever is
// on disk at flush time, and writes through a temporary file + rename.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEEP_DAYS = 90;

function homeDir() {
  return process.env.TOKENTRIMMER_HOME || path.join(os.homedir(), '.tokentrimmer');
}

function defaultFile() {
  return path.join(homeDir(), 'stats.json');
}

function empty() {
  return { since: new Date().toISOString(), requests: 0, before: 0, after: 0, saved: 0, verifyFailed: 0, retrievals: 0, techniques: {}, days: {} };
}

function read(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' ? { ...empty(), ...d, techniques: d.techniques || {}, days: d.days || {} } : empty();
  } catch {
    return empty();
  }
}

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

function addInto(target, delta) {
  for (const k of ['requests', 'before', 'after', 'saved', 'verifyFailed', 'retrievals']) target[k] = (target[k] || 0) + (delta[k] || 0);
  for (const [t, n] of Object.entries(delta.techniques || {})) target.techniques[t] = (target.techniques[t] || 0) + n;
  for (const [d, v] of Object.entries(delta.days || {})) {
    const cur = target.days[d] || (target.days[d] = { requests: 0, before: 0, after: 0, saved: 0 });
    for (const k of ['requests', 'before', 'after', 'saved']) cur[k] += v[k] || 0;
  }
  const keep = Object.keys(target.days).sort().slice(-KEEP_DAYS);
  target.days = Object.fromEntries(keep.map((d) => [d, target.days[d]]));
  return target;
}

// file: where to keep the history. Returns { record(entry), snapshot(), flush() }.
function createHistory(file, { flushMs = 5000 } = {}) {
  let pending = { ...empty(), days: {} };
  let dirty = false;
  let timer = null;
  let lastDisk = read(file);

  function flush() {
    if (!dirty) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const merged = addInto(read(file), pending);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
      fs.renameSync(tmp, file);
      lastDisk = merged;
      pending = { ...empty(), days: {} };
      dirty = false;
    } catch {
      // History is a convenience: never let a disk problem affect proxying.
    }
  }

  return {
    file,
    record(e) {
      const d = day();
      addInto(pending, {
        requests: 1, before: e.before, after: e.after, saved: e.saved, verifyFailed: e.verifyFailed ? 1 : 0,
        retrievals: e.retrievals || 0, techniques: e.techniques || {},
        days: { [d]: { requests: 1, before: e.before, after: e.after, saved: e.saved } },
      });
      dirty = true;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, flushMs);
        timer.unref();
      }
    },
    // Retrievals happen after the request was recorded.
    addRetrievals(n) {
      if (!n) return;
      pending.retrievals += n;
      dirty = true;
    },
    snapshot() {
      return addInto(JSON.parse(JSON.stringify(lastDisk)), pending);
    },
    flush,
  };
}

module.exports = { createHistory, read, defaultFile, homeDir };
