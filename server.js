// Show Planner: a tiny zero-dependency server for a band's shows and availability.
// Data lives in one JSON file. On Railway, mount a volume and set DATA_DIR to its path.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PASSCODE = (process.env.PASSCODE || '').trim();
const BAND_NAME = (process.env.BAND_NAME || '').trim();
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { rev: 1, shows: [], availability: {} };
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  db = { rev: raw.rev || 1, shows: Array.isArray(raw.shows) ? raw.shows : [], availability: raw.availability || {} };
} catch (e) {
  if (e.code !== 'ENOENT') console.error('Could not read data file, starting empty:', e.message);
}

let writing = Promise.resolve();
function persist() {
  db.rev += 1;
  const snapshot = JSON.stringify(db);
  writing = writing.then(() => new Promise((resolve) => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, snapshot, (err) => {
      if (err) { console.error('Write failed:', err.message); return resolve(); }
      fs.rename(tmp, DATA_FILE, (err2) => { if (err2) console.error('Rename failed:', err2.message); resolve(); });
    });
  }));
}

// ---------- validation helpers ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES = new Set(['free', 'maybe', 'busy']);
const SHOW_STATUSES = new Set(['confirmed', 'hold', 'idea']);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const time = (v) => (typeof v === 'string' && TIME_RE.test(v) ? v : '');
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const cleanName = (v) => { const n = str(v, 40).replace(/\s+/g, ' '); return RESERVED.has(n) ? '' : n; };

// An availability entry is either a status string or { s, from, to } with optional times.
function cleanEntry(v) {
  if (typeof v === 'string') return STATUSES.has(v) ? v : null;
  if (!v || typeof v !== 'object' || !STATUSES.has(v.s)) return null;
  const from = v.s === 'busy' ? '' : time(v.from);
  const to = v.s === 'busy' ? '' : time(v.to);
  if (!from && !to) return v.s;
  const e = { s: v.s };
  if (from) e.from = from;
  if (to) e.to = to;
  return e;
}

function cleanShow(input, prev) {
  const s = {
    id: prev ? prev.id : crypto.randomUUID(),
    type: input.type === 'practice' ? 'practice' : 'show',
    date: typeof input.date === 'string' && DATE_RE.test(input.date) ? input.date : '',
    venue: str(input.venue, 100) || (input.type === 'practice' ? 'Practice' : ''),
    city: str(input.city, 80),
    address: str(input.address, 200),
    status: SHOW_STATUSES.has(input.status) ? input.status : 'confirmed',
    loadIn: time(input.loadIn),
    soundcheck: time(input.soundcheck),
    doors: time(input.doors),
    setStart: time(input.setStart),
    setEnd: time(input.setEnd),
    contact: str(input.contact, 120),
    pay: str(input.pay, 60),
    notes: str(input.notes, 2000),
    schedule: (Array.isArray(input.schedule) ? input.schedule : []).slice(0, 40)
      .map((it) => ({ time: time(it && it.time), label: str(it && it.label, 80), note: str(it && it.note, 300) }))
      .filter((it) => it.label),
    createdBy: prev ? prev.createdBy : cleanName(input.by),
    updatedBy: cleanName(input.by),
    createdAt: prev ? prev.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
  if (!s.date) return { error: 'A valid date is required.' };
  if (!s.venue) return { error: 'A venue name is required.' };
  return { show: s };
}

// ---------- http helpers ----------
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 200 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!PASSCODE) return true;
  const given = Buffer.from(String(req.headers['x-passcode'] || ''));
  const want = Buffer.from(PASSCODE);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function state() {
  return { rev: db.rev, bandName: BAND_NAME, shows: db.shows, availability: db.availability };
}

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 404, 'Not found');
  fs.readFile(file, (err, buf) => {
    if (err) {
      // Single-page app: fall back to index.html
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => e2 ? send(res, 404, 'Not found') : send(res, 200, html, { 'Content-Type': TYPES['.html'] }));
    }
    send(res, 200, buf, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/health') return send(res, 200, { ok: true });
  if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n');
  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, p);
  }

  if (p === '/api/config' && req.method === 'GET') return send(res, 200, { needsPasscode: !!PASSCODE, bandName: BAND_NAME });
  if (!authorized(req)) return send(res, 401, { error: 'Wrong passcode.' });

  try {
    if (p === '/api/state' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since'));
      if (since && since === db.rev) return send(res, 200, { rev: db.rev, unchanged: true });
      return send(res, 200, state());
    }

    // Replace one person's availability: { name, dates: { 'YYYY-MM-DD': 'free'|'maybe'|'busy' } }
    if (p === '/api/availability' && req.method === 'PUT') {
      const body = await readBody(req);
      const name = cleanName(body.name);
      if (!name) return send(res, 400, { error: 'Name is required.' });
      const dates = {};
      for (const [d, v] of Object.entries(body.dates || {})) {
        const e = DATE_RE.test(d) ? cleanEntry(v) : null;
        if (e) dates[d] = e;
      }
      if (Object.keys(dates).length > 1500) return send(res, 400, { error: 'Too many dates.' });
      db.availability[name] = dates;
      persist();
      return send(res, 200, state());
    }

    // Remove a person entirely
    const personMatch = p.match(/^\/api\/people\/(.+)$/);
    if (personMatch && req.method === 'DELETE') {
      const name = cleanName(decodeURIComponent(personMatch[1]));
      if (name && Object.prototype.hasOwnProperty.call(db.availability, name)) delete db.availability[name];
      persist();
      return send(res, 200, state());
    }

    if (p === '/api/shows' && req.method === 'POST') {
      const body = await readBody(req);
      const { show, error } = cleanShow(body);
      if (error) return send(res, 400, { error });
      if (db.shows.length >= 2000) return send(res, 400, { error: 'Too many shows stored.' });
      db.shows.push(show);
      persist();
      return send(res, 200, state());
    }

    const showMatch = p.match(/^\/api\/shows\/([\w-]+)$/);
    if (showMatch) {
      const idx = db.shows.findIndex((s) => s.id === showMatch[1]);
      if (idx === -1) return send(res, 404, { error: 'That show no longer exists.' });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const { show, error } = cleanShow(body, db.shows[idx]);
        if (error) return send(res, 400, { error });
        db.shows[idx] = show;
        persist();
        return send(res, 200, state());
      }
      if (req.method === 'DELETE') {
        db.shows.splice(idx, 1);
        persist();
        return send(res, 200, state());
      }
    }

    return send(res, 404, { error: 'Not found.' });
  } catch (e) {
    return send(res, 400, { error: e.message === 'too large' ? 'Request too large.' : 'Bad request.' });
  }
});

server.listen(PORT, () => {
  console.log(`Show Planner running on port ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  if (!PASSCODE) console.warn('No PASSCODE set: anyone with the link can view and edit.');
});

function shutdown() { server.close(); writing.then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
