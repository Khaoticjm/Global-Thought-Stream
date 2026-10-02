// ═══════════════════════════════════════════════════════
// Sphinx Global · Global Thought Stream
// Proxy Server v2 — TTS + Real SHA-256 HOB Chain + Audit
// ═══════════════════════════════════════════════════════
//
// SETUP:
//   1. npm install express cors node-fetch dotenv better-sqlite3
//   2. Create .env from .env.example
//   3. node proxy-server-v2.js
//
// What's new in v2:
//   - Real SHA-256 HOB Block chain using Node crypto module
//   - SQLite persistence via better-sqlite3 (zero config)
//   - GET /api/audit/hob — full chain with access tier filtering
//   - GET /api/audit/hob/:id — single block lookup
//   - POST /api/hob/add — browser calls this on each turn
//   - Chain integrity verified on every audit request
//   - GDPR: user_id never stored as plaintext (SHA-256 hashed)
// ═══════════════════════════════════════════════════════

'use strict';

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fetch    = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const http     = require('http');
const FormData = require('form-data');

// ── WebSocket — lazy load ─────────────────────────────
let WebSocketServer = null;
function getWSS() {
  if (WebSocketServer) return WebSocketServer;
  try {
    const { WebSocketServer: WSS } = require('ws');
    WebSocketServer = WSS;
    return WSS;
  } catch(e) {
    console.warn('[WS] ws package not installed — run: npm install ws');
    return null;
  }
}

// ── Stripe — lazy load ────────────────────────────────
let stripe = null;
function getStripe() {
  if (stripe) return stripe;
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_KEY) return null;
  try { stripe = require('stripe')(STRIPE_KEY); return stripe; }
  catch(e) { console.warn('[Stripe] not installed — run: npm install stripe'); return null; }
}

// ── Multer for multipart audio uploads ───────────────
let multer = null;
function getMulter() {
  if (multer) return multer;
  try {
    multer = require('multer');
    return multer;
  } catch(e) {
    console.warn('[Transcribe] multer not installed — run: npm install multer');
    return null;
  }
}

// ── SQLite — lazy load so server still starts without it ──
let db = null;
function getDB() {
  if (db) return db;
  try {
    const Database = require('better-sqlite3');
    const dbPath = process.env.DB_PATH || path.join(__dirname, 'gts_audit.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS hob_chain (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        hob_id       TEXT    NOT NULL UNIQUE,
        session_id   TEXT    NOT NULL,
        user_id_hash TEXT    NOT NULL,
        timestamp_utc TEXT   NOT NULL,
        lang_from    TEXT    NOT NULL,
        lang_to      TEXT    NOT NULL,
        switch_type  TEXT    NOT NULL DEFAULT 'unknown',
        continuity_score REAL NOT NULL,
        embedding_hash   TEXT NOT NULL,
        integrity_chain  TEXT NOT NULL,
        anomaly_flag     INTEGER NOT NULL DEFAULT 0,
        dialect_tag      TEXT,
        created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_session ON hob_chain(session_id);
      CREATE INDEX IF NOT EXISTS idx_ts      ON hob_chain(created_at);

      CREATE TABLE IF NOT EXISTS users (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        token           TEXT    NOT NULL UNIQUE,
        email           TEXT    NOT NULL UNIQUE,
        name            TEXT    NOT NULL DEFAULT '',
        tier            TEXT    NOT NULL DEFAULT 'free',
        stripe_customer TEXT,
        stripe_sub      TEXT,
        daily_count     INTEGER NOT NULL DEFAULT 0,
        daily_reset     TEXT    NOT NULL DEFAULT (date('now')),
        total_turns     INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_token ON users(token);
      CREATE INDEX IF NOT EXISTS idx_email ON users(email);
    `);
    console.log('[DB] SQLite ready:', dbPath);
    return db;
  } catch (e) {
    console.warn('[DB] better-sqlite3 unavailable — using in-memory store.');
    console.warn('     Users and HOB chain will not persist across restarts.');
    // Return a lightweight in-memory shim so the server stays functional
    return getMemDB();
  }
}

// ── In-memory fallback chain ──────────────────────────
const memChain = [];

// ── In-memory DB shim (mirrors better-sqlite3 API) ───
// Used when better-sqlite3 native binary is unavailable.
// Data persists only for the current server session.
let _memDB = null;
function getMemDB() {
  if (_memDB) return _memDB;
  const tables = { hob_chain: [], users: [] };
  let autoId = { hob_chain: 1, users: 1 };

  function parseWhere(where, params) {
    // Very simple: "col=? AND col2=?" with positional params
    if (!where) return () => true;
    const parts = where.split(/\s+AND\s+/i);
    return (row) => parts.every((p, i) => {
      const col = p.split(/\s*=\s*/)[0].trim();
      return row[col] === params[i];
    });
  }

  const stmt = (sql) => {
    const s = sql.trim();
    return {
      run(...args) {
        const ins = s.match(/^INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
        if (ins) {
          const tbl = ins[1], cols = ins[2].split(',').map(c=>c.trim());
          const row = { id: autoId[tbl]++ };
          cols.forEach((c,i) => row[c] = args[i]);
          if (!tables[tbl]) tables[tbl] = [];
          tables[tbl].push(row);
          return { lastInsertRowid: row.id, changes: 1 };
        }
        const upd = s.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)/i);
        if (upd) {
          const tbl = upd[1];
          const setParts = upd[2].split(',').map(p => p.split('=')[0].trim());
          const whereStr = upd[3];
          const setCount = setParts.length;
          const setArgs  = args.slice(0, setCount);
          const whereArgs= args.slice(setCount);
          const fn = parseWhere(whereStr, whereArgs);
          let changes = 0;
          (tables[tbl] || []).forEach(row => {
            if (fn(row)) { setParts.forEach((c,i) => row[c] = setArgs[i]); changes++; }
          });
          return { changes };
        }
        return { changes: 0, lastInsertRowid: null };
      },
      get(...args) {
        const sel = s.match(/^SELECT .+ FROM (\w+)(?: WHERE (.+?))?(?:\s+ORDER|\s+LIMIT|$)/i);
        if (sel) {
          const tbl = sel[1], where = sel[2];
          const fn = parseWhere(where, args);
          return (tables[tbl] || []).find(fn) || undefined;
        }
        return undefined;
      },
      all(...args) {
        const sel = s.match(/^SELECT .+ FROM (\w+)(?: WHERE (.+?))?(?:\s+ORDER|\s+LIMIT|$)/i);
        if (sel) {
          const tbl = sel[1], where = sel[2];
          const fn = parseWhere(where, args);
          let rows = (tables[tbl] || []).filter(fn);
          const lim = s.match(/LIMIT (\d+)/i);
          if (lim) rows = rows.slice(0, parseInt(lim[1]));
          return rows;
        }
        return [];
      },
    };
  };

  _memDB = {
    prepare: (sql) => stmt(sql),
    exec:    ()    => {},
    pragma:  ()    => {},
    close:   ()    => {},
  };
  console.log('[DB] Using in-memory store (better-sqlite3 not compiled).');
  return _memDB;
}

// ── SHA-256 helpers ───────────────────────────────────
function sha256(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function buildIntegrityChain(prevHash, embeddingHash) {
  return sha256(`${prevHash}|${embeddingHash}`);
}

function buildEmbeddingHash(lang, score, ts) {
  return sha256(`${lang}|${score.toFixed(4)}|${ts}`);
}

// ── Get the last block's integrity chain hash ─────────
function getLatestChainHash(sessionId) {
  const database = getDB();
  if (database) {
    const row = database
      .prepare('SELECT integrity_chain FROM hob_chain WHERE session_id=? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId);
    return row?.integrity_chain || '0'.repeat(64);
  }
  const sessionBlocks = memChain.filter(b => b.session_id === sessionId);
  return sessionBlocks.length
    ? sessionBlocks[sessionBlocks.length - 1].integrity_chain
    : '0'.repeat(64);
}

// ── Verify chain integrity ────────────────────────────
function verifyChain(blocks) {
  for (let i = 1; i < blocks.length; i++) {
    const expected = buildIntegrityChain(
      blocks[i - 1].integrity_chain,
      blocks[i].embedding_hash
    );
    if (expected !== blocks[i].integrity_chain) {
      return { valid: false, broken_at: blocks[i].hob_id, index: i };
    }
  }
  return { valid: true, broken_at: null };
}

// ── Express setup ─────────────────────────────────────
const app = express();

// Trust Railway/Render/Heroku proxy — required for rate limiting and HTTPS detection
app.set('trust proxy', 1);
const PORT          = process.env.PORT || 3000;
const API_KEY       = process.env.ELEVENLABS_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY    = process.env.GEMINI_API_KEY;
const STRIPE_KEY    = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const CLAUDE_MODEL  = process.env.CLAUDE_MODEL  || 'claude-sonnet-4-20250514';
const GEMINI_MODEL  = process.env.GEMINI_MODEL  || 'gemini-1.5-flash';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '1DC6VAfJKAscIyFOOTRa';
const MODEL_ID = process.env.ELEVENLABS_MODEL    || 'eleven_multilingual_v2';
const APP_URL  = process.env.APP_URL || `http://localhost:${PORT}`;

// ── Admin token — set ADMIN_SECRET in .env ────────────
// Used to create admin accounts and bypass rate limits
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

function isAdmin(req) {
  const secret = req.headers['x-admin-secret'] || req.query.admin_secret;
  return ADMIN_SECRET && secret === ADMIN_SECRET;
}

// ── Trial and tier configuration ─────────────────────
const FREE_TRIAL_DAYS    = parseInt(process.env.FREE_TRIAL_DAYS   || '14');  // days before free expires
const FREE_DAILY_LIMIT   = parseInt(process.env.FREE_DAILY_LIMIT  || '20');  // messages/day on free trial
const FREE_TOTAL_LIMIT   = parseInt(process.env.FREE_TOTAL_LIMIT  || '100'); // total messages before upgrade required

const TIERS = {
  free:       { daily_limit: FREE_DAILY_LIMIT, total_limit: FREE_TOTAL_LIMIT, trial_days: FREE_TRIAL_DAYS, label: 'Starter',      price_id: null },
  pro:        { daily_limit: 2000,             total_limit: -1,               trial_days: -1,             label: 'Professional', price_id: process.env.STRIPE_PRO_PRICE_ID  || null },
  enterprise: { daily_limit: -1,               total_limit: -1,               trial_days: -1,             label: 'Enterprise',   price_id: process.env.STRIPE_ENT_PRICE_ID  || null },
  admin:      { daily_limit: -1,               total_limit: -1,               trial_days: -1,             label: 'Admin',        price_id: null },
};

// ── Features gated by tier ────────────────────────────
const ALL_FEATURES = ['chat','speak','hob','verify','transcribe','export',
  'multi_speaker','translation','webhook','api_access'];
const TIER_FEATURES = {
  free:       ['chat','speak','hob'],
  pro:        ['chat','speak','hob','verify','transcribe','export','multi_speaker','translation'],
  enterprise: ALL_FEATURES,
  admin:      ALL_FEATURES,
};

if (!API_KEY) {
  console.warn('\n⚠️   ELEVENLABS_API_KEY not set — voice synthesis will use browser TTS fallback.\n');
}
if (!ANTHROPIC_KEY) console.warn('\n⚠️   ANTHROPIC_API_KEY not set — /api/chat will return errors.\n');
if (!GEMINI_KEY)    console.warn('\n⚠️   GEMINI_API_KEY not set — /api/transcribe will use Claude fallback.\n');
if (!STRIPE_KEY)    console.warn('\n⚠️   STRIPE_SECRET_KEY not set — payments will be unavailable.\n');

// ── Helmet — security headers ─────────────────────────
try {
  const helmet = require('helmet');
  app.use(helmet({
    contentSecurityPolicy: false, // disabled — app uses inline scripts
    crossOriginEmbedderPolicy: false,
  }));
  console.log('[Security] helmet headers active');
} catch(e) {
  console.warn('[Security] helmet not installed — run: npm install helmet');
}

// ── CORS — lock to allowed origins ───────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : null; // null = allow all (safe on localhost, lock down on deploy)

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, mobile apps, same-origin)
    if (!origin) return cb(null, true);
    // Allow localhost always (dev)
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return cb(null, true);
    // If ALLOWED_ORIGINS set, enforce it
    if (ALLOWED_ORIGINS && !ALLOWED_ORIGINS.includes(origin)) {
      console.warn(`[CORS] Blocked origin: ${origin}`);
      return cb(new Error('CORS policy: origin not allowed'), false);
    }
    cb(null, true);
  },
  credentials: true,
}));

// ── Request rate limiter — brute force protection ─────
try {
  const rateLimit = require('express-rate-limit');

  // Global limiter — 300 requests per minute per IP
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — slow down.', code: 'rate_limited' },
    skip: (req) => req.path === '/health', // don't limit health checks
  });

  // Strict limiter for auth endpoints — 20 per 15 minutes per IP
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many auth attempts — try again in 15 minutes.', code: 'rate_limited' },
  });

  // Chat limiter — 60 requests per minute per IP (per-user daily limits still apply)
  const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many messages — please wait a moment.', code: 'rate_limited' },
  });

  app.use(globalLimiter);
  app.use('/api/register',  authLimiter);
  app.use('/api/checkout',  authLimiter);
  app.use('/api/chat',      chatLimiter);
  app.use('/api/verify',    chatLimiter);
  console.log('[Security] rate limiting active');
} catch(e) {
  console.warn('[Security] express-rate-limit not installed — run: npm install express-rate-limit');
}

// ── Input sanitization middleware ─────────────────────
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    sanitizeObj(req.body);
  }
  next();
});

function sanitizeStr(str) {
  if (typeof str !== 'string') return str;
  // Strip null bytes and dangerous control characters
  // Keep newlines (\n \r) and tabs — needed for multilingual text
  return str.replace(/\0/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, 8000);
}

function sanitizeObj(obj, depth = 0) {
  if (depth > 5) return; // prevent deep recursion attacks
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      obj[key] = sanitizeStr(obj[key]);
    } else if (Array.isArray(obj[key])) {
      obj[key] = obj[key].slice(0, 100); // cap arrays at 100 items
      obj[key].forEach((item, i) => {
        if (typeof item === 'string') obj[key][i] = sanitizeStr(item);
        else if (typeof item === 'object' && item !== null) sanitizeObj(item, depth + 1);
      });
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      sanitizeObj(obj[key], depth + 1);
    }
  }
}

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname)));

// ── Token generation ──────────────────────────────────
function generateToken() {
  return 'gts_' + crypto.randomBytes(24).toString('hex');
}

// ── Auth middleware ───────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers['x-gts-token'] || req.headers['authorization']?.replace('Bearer ','');
  if (!token) { req.user = null; return next(); }
  const db = getDB();
  if (!db) { req.user = null; return next(); }
  const user = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
  if (!user) { req.user = null; return next(); }
  const today = new Date().toISOString().slice(0, 10);
  if (user.daily_reset !== today) {
    db.prepare('UPDATE users SET daily_count=0, daily_reset=? WHERE id=?').run(today, user.id);
    user.daily_count = 0;
    user.daily_reset = today;
  }
  req.user = user;
  next();
}
app.use(authMiddleware);

// ── Rate limit check ──────────────────────────────────
function checkRateLimit(user) {
  if (!user) return { allowed: false, reason: 'unauthenticated' };
  if (user.tier === 'admin' || user.tier === 'enterprise') return { allowed: true };

  const tier = TIERS[user.tier] || TIERS.free;

  // ── Trial expiry check (free tier only) ──────────────
  if (user.tier === 'free' && tier.trial_days > 0) {
    const createdAt  = user.created_at * 1000; // convert to ms
    const daysSince  = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
    if (daysSince > tier.trial_days) {
      return {
        allowed: false,
        reason:  'trial_expired',
        days:    Math.floor(daysSince),
        limit:   tier.trial_days,
        message: `Your ${tier.trial_days}-day free trial has ended. Upgrade to Pro to continue.`,
      };
    }
  }

  // ── Total message cap (free tier only) ───────────────
  if (user.tier === 'free' && tier.total_limit > 0) {
    if (user.total_turns >= tier.total_limit) {
      return {
        allowed: false,
        reason:  'total_limit',
        used:    user.total_turns,
        limit:   tier.total_limit,
        message: `You've used all ${tier.total_limit} free messages. Upgrade to Pro to continue.`,
      };
    }
  }

  // ── Daily limit check ────────────────────────────────
  if (tier.daily_limit !== -1 && user.daily_count >= tier.daily_limit) {
    return {
      allowed: false,
      reason:  'daily_limit',
      limit:   tier.daily_limit,
      tier:    user.tier,
      message: `You've reached your daily limit of ${tier.daily_limit} messages. Upgrade to Pro for 2,000/day.`,
    };
  }

  // ── All checks passed ────────────────────────────────
  const tier_obj   = TIERS[user.tier] || TIERS.free;
  const trialDaysLeft = user.tier === 'free' && tier_obj.trial_days > 0
    ? Math.max(0, tier_obj.trial_days - Math.floor((Date.now() - user.created_at * 1000) / (1000 * 60 * 60 * 24)))
    : null;

  return { allowed: true, trial_days_left: trialDaysLeft };
}

// ── Feature gate check ────────────────────────────────
function checkFeature(user, feature) {
  const tier = user?.tier || 'free';
  if (tier === 'admin' || tier === 'enterprise') return true;
  return (TIER_FEATURES[tier] || TIER_FEATURES.free).includes(feature);
}

// ── Increment turn counter ────────────────────────────
function incrementTurns(user) {
  const db = getDB();
  if (!db || !user) return;
  db.prepare('UPDATE users SET daily_count=daily_count+1, total_turns=total_turns+1, updated_at=? WHERE id=?')
    .run(Math.floor(Date.now()/1000), user.id);
}

// ════════════════════════════════════════════════════════
// AUTH — REGISTER
// POST /api/register  { email, name }
// Returns: { token, tier, daily_limit, features }
// ════════════════════════════════════════════════════════
app.post('/api/register', (req, res) => {
  const { email, name = '' } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email is required' });
  }
  const db = getDB();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  // Return existing token if already registered
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) {
    return res.json({
      token:       existing.token,
      tier:        existing.tier,
      name:        existing.name,
      daily_limit: TIERS[existing.tier]?.daily_limit ?? 50,
      daily_used:  existing.daily_count,
      features:    TIER_FEATURES[existing.tier] || TIER_FEATURES.free,
    });
  }

  const token = generateToken();
  db.prepare('INSERT INTO users (token, email, name) VALUES (?, ?, ?)').run(
    token, email.toLowerCase().trim(), name.trim()
  );
  console.log(`[Auth] New user: ${email.toLowerCase().trim()} (free)`);
  res.json({
    token,
    tier:        'free',
    name:        name.trim(),
    daily_limit: TIERS.free.daily_limit,
    daily_used:  0,
    features:    TIER_FEATURES.free,
  });
});

// ════════════════════════════════════════════════════════
// AUTH — GET CURRENT USER
// GET /api/me  (requires X-GTS-Token)
// ════════════════════════════════════════════════════════
app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Invalid or missing token' });
  const tier     = TIERS[req.user.tier] || TIERS.free;
  const isFreeTier = req.user.tier === 'free';

  // Calculate trial days remaining
  let trial_days_left  = null;
  let trial_expired    = false;
  if (isFreeTier && tier.trial_days > 0) {
    const daysSince   = (Date.now() - req.user.created_at * 1000) / (1000 * 60 * 60 * 24);
    trial_days_left   = Math.max(0, Math.ceil(tier.trial_days - daysSince));
    trial_expired     = daysSince > tier.trial_days;
  }

  res.json({
    email:           req.user.email,
    name:            req.user.name,
    tier:            req.user.tier,
    tier_label:      tier.label,
    daily_limit:     tier.daily_limit,
    daily_used:      req.user.daily_count,
    total_turns:     req.user.total_turns,
    total_limit:     tier.total_limit,
    trial_days:      tier.trial_days,
    trial_days_left,
    trial_expired,
    features:        TIER_FEATURES[req.user.tier] || TIER_FEATURES.free,
    stripe_sub:      req.user.stripe_sub || null,
  });
});

// ════════════════════════════════════════════════════════
// STRIPE — CREATE CHECKOUT SESSION
// POST /api/checkout  { tier: 'pro'|'enterprise' }
// Returns: { url } — redirect to Stripe Checkout
// ════════════════════════════════════════════════════════
app.post('/api/checkout', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  const s = getStripe();
  if (!s) return res.status(503).json({ error: 'Payments not configured. Add STRIPE_SECRET_KEY to .env' });

  const { tier = 'pro' } = req.body;
  const priceId = TIERS[tier]?.price_id;
  if (!priceId) {
    return res.status(400).json({ error: `No price configured for tier: ${tier}. Add STRIPE_${tier.toUpperCase()}_PRICE_ID to .env` });
  }

  try {
    // Create or retrieve Stripe customer
    let customerId = req.user.stripe_customer;
    if (!customerId) {
      const customer = await s.customers.create({ email: req.user.email, name: req.user.name, metadata: { gts_token: req.user.token } });
      customerId = customer.id;
      getDB()?.prepare('UPDATE users SET stripe_customer=? WHERE id=?').run(customerId, req.user.id);
    }

    const session = await s.checkout.sessions.create({
      customer:   customerId,
      mode:       'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata:   { gts_token: req.user.token, tier },
      success_url: `${APP_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}`,
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch(e) {
    console.error('[Stripe] checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// STRIPE — CUSTOMER PORTAL (manage / cancel subscription)
// POST /api/portal
// ════════════════════════════════════════════════════════
app.post('/api/portal', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  const s = getStripe();
  if (!s) return res.status(503).json({ error: 'Payments not configured' });
  if (!req.user.stripe_customer) return res.status(400).json({ error: 'No billing account found' });

  try {
    const session = await s.billingPortal.sessions.create({
      customer:   req.user.stripe_customer,
      return_url: APP_URL,
    });
    res.json({ url: session.url });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// STRIPE — WEBHOOK
// POST /webhook/stripe  (raw body — Stripe signature verified)
// Handles: checkout.session.completed, customer.subscription.deleted
// ════════════════════════════════════════════════════════
app.post('/webhook/stripe', async (req, res) => {
  const s = getStripe();
  if (!s) return res.status(503).send('Stripe not configured');

  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      event = s.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } else {
      // Dev mode without webhook secret — parse raw body directly
      event = JSON.parse(req.body.toString());
      console.warn('[Stripe] Webhook received without signature verification — set STRIPE_WEBHOOK_SECRET in production');
    }
  } catch(e) {
    console.error('[Stripe] Webhook signature failed:', e.message);
    return res.status(400).send(`Webhook error: ${e.message}`);
  }

  const db = getDB();
  if (!db) return res.status(503).send('Database unavailable');

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const token   = session.metadata?.gts_token;
    const tier    = session.metadata?.tier || 'pro';
    const subId   = session.subscription;
    if (token) {
      db.prepare('UPDATE users SET tier=?, stripe_sub=?, updated_at=? WHERE token=?')
        .run(tier, subId, Math.floor(Date.now()/1000), token);
      console.log(`[Stripe] ✓ Upgraded ${token.slice(0,16)}… → ${tier}`);
    }
  }

  if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    if (sub.status === 'canceled' || sub.status === 'unpaid') {
      db.prepare('UPDATE users SET tier=\'free\', stripe_sub=NULL, updated_at=? WHERE stripe_sub=?')
        .run(Math.floor(Date.now()/1000), sub.id);
      console.log(`[Stripe] Subscription ${sub.id} → downgraded to free`);
    }
  }

  res.json({ received: true });
});

// ════════════════════════════════════════════════════════
// ── Root — serve main app at / and /app ──────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'sphinx_global_unified_v2.html'));
});
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'sphinx_global_unified_v2.html'));
});

// ── Setup wizard — serve setup.html at /setup ────────
// ════════════════════════════════════════════════════════
app.get('/setup', (req, res) => {
  const setupPath = path.join(__dirname, 'setup.html');
  if (fs.existsSync(setupPath)) {
    res.sendFile(setupPath);
  } else {
    res.status(404).send('Setup wizard not found. Make sure setup.html is in the same folder as proxy-server-v2.js.');
  }
});

// ════════════════════════════════════════════════════════
// ADMIN — UPDATE .ENV KEYS (write to disk)
// POST /api/admin/update-env
// Header: X-Admin-Secret
// Body: { anthropic?, gemini?, elevenlabs? }
// ════════════════════════════════════════════════════════
app.post('/api/admin/update-env', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Admin access required' });

  const { anthropic, gemini, elevenlabs } = req.body;
  const envPath = path.join(__dirname, '.env');

  try {
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const setKey = (content, key, value) => {
      if (!value) return content;
      const re = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${value}`;
      return re.test(content) ? content.replace(re, line) : content + `\n${line}`;
    };
    if (anthropic)  envContent = setKey(envContent, 'ANTHROPIC_API_KEY', anthropic);
    if (gemini)     envContent = setKey(envContent, 'GEMINI_API_KEY', gemini);
    if (elevenlabs) envContent = setKey(envContent, 'ELEVENLABS_API_KEY', elevenlabs);
    fs.writeFileSync(envPath, envContent);
    console.log('[Admin] .env updated — restart server to apply new keys');
    res.json({ ok: true, message: 'Keys saved. Restart the server to apply them.' });
  } catch(e) {
    res.status(500).json({ error: 'Could not write .env: ' + e.message });
  }
});

// ════════════════════════════════════════════════════════
// ADMIN — BOOTSTRAP ADMIN ACCOUNT
// POST /api/admin/bootstrap
// Header: X-Admin-Secret: <ADMIN_SECRET from .env>
// Body:   { email, name? }
// Creates (or upgrades) a user to admin tier.
// Run once to create your own account.
// ════════════════════════════════════════════════════════
app.post('/api/admin/bootstrap', (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(503).json({
      error: 'Admin not configured',
      detail: 'Set ADMIN_SECRET in your .env file to enable admin access.',
    });
  }
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }

  const { email, name = 'Admin' } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const db = getDB();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) {
    // Upgrade existing user to admin
    db.prepare('UPDATE users SET tier=\'admin\', name=?, updated_at=? WHERE email=?')
      .run(name.trim(), Math.floor(Date.now()/1000), email.toLowerCase().trim());
    const updated = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
    console.log(`[Admin] Upgraded ${email} to admin tier`);
    return res.json({
      message: 'Upgraded to admin',
      token: updated.token,
      tier:  updated.tier,
      email: updated.email,
    });
  }

  const token = generateToken();
  db.prepare('INSERT INTO users (token, email, name, tier) VALUES (?, ?, ?, \'admin\')')
    .run(token, email.toLowerCase().trim(), name.trim());
  console.log(`[Admin] Created admin account: ${email}`);
  res.json({
    message: 'Admin account created',
    token,
    tier:  'admin',
    email: email.toLowerCase().trim(),
    note:  'Save this token — it grants unlimited access to all features.',
  });
});

// ════════════════════════════════════════════════════════
// ADMIN — LIST USERS
// GET /api/admin/users
// Header: X-Admin-Secret: <ADMIN_SECRET>
// ════════════════════════════════════════════════════════
app.get('/api/admin/users', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Admin access required' });
  const db = getDB();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  const users = db.prepare(`
    SELECT id, email, name, tier, daily_count, daily_reset, total_turns,
           stripe_sub, created_at
    FROM users ORDER BY created_at DESC LIMIT 100
  `).all();

  res.json({
    count: users.length,
    users: users.map(u => ({
      ...u,
      token_hint: '(hidden)',
      created: new Date(u.created_at * 1000).toISOString().slice(0,10),
    })),
  });
});

// ════════════════════════════════════════════════════════
// ADMIN — SET USER TIER
// POST /api/admin/set-tier
// Header: X-Admin-Secret: <ADMIN_SECRET>
// Body:   { email, tier: 'free'|'pro'|'enterprise'|'admin' }
// ════════════════════════════════════════════════════════
app.post('/api/admin/set-tier', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Admin access required' });
  const { email, tier } = req.body;
  const validTiers = ['free','pro','enterprise','admin'];
  if (!email || !validTiers.includes(tier)) {
    return res.status(400).json({ error: `tier must be one of: ${validTiers.join(', ')}` });
  }
  const db = getDB();
  const result = db.prepare('UPDATE users SET tier=?, updated_at=? WHERE email=?')
    .run(tier, Math.floor(Date.now()/1000), email.toLowerCase().trim());
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  console.log(`[Admin] Set ${email} → ${tier}`);
  res.json({ message: `${email} → ${tier}`, changes: result.changes });
});

// ════════════════════════════════════════════════════════
// HEALTH
// ════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  const database = getDB();
  const userCount = database ? (database.prepare('SELECT COUNT(*) as n FROM users').get()?.n || 0) : 0;
  res.json({
    status:         'ok',
    version:        '3.0.0',
    auth:           !!database,
    payments:       !!STRIPE_KEY,
    claude_ready:   !!ANTHROPIC_KEY,
    gemini_ready:   !!GEMINI_KEY,
    narrativepure:  !!(ANTHROPIC_KEY || GEMINI_KEY),
    dual_model:     !!(ANTHROPIC_KEY && GEMINI_KEY),
    user_count:     userCount,
    hob_db:         database ? 'sqlite' : 'memory',
  });
});

// ════════════════════════════════════════════════════════
// TTS PROXY
// ════════════════════════════════════════════════════════
app.post('/api/speak', async (req, res) => {
  const { text, language_code = 'en', voice_settings } = req.body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: 'text exceeds 5000 character limit' });
  }

  const payload = {
    text: text.trim(),
    model_id: MODEL_ID,
    language_code,
    voice_settings: voice_settings || {
      stability: 0.5, similarity_boost: 0.8,
      style: 0.3,     use_speaker_boost: true,
    },
  };

  try {
    console.log(`[TTS] → lang=${language_code} "${text.slice(0, 50)}…"`);
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
      {
        method: 'POST',
        headers: {
          'xi-api-key':   API_KEY,
          'Content-Type': 'application/json',
          'Accept':       'audio/mpeg',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!upstream.ok) {
      const err = await upstream.text();
      console.error(`[TTS] upstream error ${upstream.status}:`, err);
      return res.status(upstream.status).json({ error: 'Voice service error', status: upstream.status });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    upstream.body.pipe(res);

  } catch (err) {
    console.error('[TTS] proxy error:', err.message);
    res.status(500).json({ error: 'Proxy error', detail: err.message });
  }
});

// ════════════════════════════════════════════════════════
// CLAUDE CHAT PROXY  (auth + rate limited)
// POST /api/chat
// ════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required', code: 'unauthenticated' });
  }
  const limit = checkRateLimit(req.user);
  if (!limit.allowed) {
    const tierLabel = TIERS[req.user.tier]?.label || 'Free';
    return res.status(429).json({
      error:   'Daily limit reached',
      code:    'rate_limited',
      limit:   limit.limit,
      tier:    req.user.tier,
      message: `${tierLabel} tier allows ${limit.limit} messages per day. Upgrade for more.`,
    });
  }
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({
      error: 'Claude not configured',
      detail: 'ANTHROPIC_API_KEY is not set on the server.',
    });
  }
  const { messages, system, max_tokens = 1000 } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  // Sanitise — only pass role + content to Anthropic
  const sanitised = messages.map(m => ({
    role:    m.role === 'user' ? 'user' : 'assistant',
    content: typeof m.content === 'string' ? m.content.slice(0, 8000) : String(m.content),
  }));

  // Must start with user turn
  if (sanitised[0]?.role !== 'user') {
    return res.status(400).json({ error: 'First message must be role:user' });
  }

  const payload = {
    model:      CLAUDE_MODEL,
    max_tokens,
    messages:   sanitised,
  };
  if (system && typeof system === 'string') {
    payload.system = system.slice(0, 4000);
  }

  try {
    console.log(`[Chat] → ${sanitised.length} turns, model=${CLAUDE_MODEL}`);

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error('[Chat] Anthropic error', upstream.status, data?.error?.message);
      return res.status(upstream.status).json({
        error:  data?.error?.type    || 'anthropic_error',
        detail: data?.error?.message || 'Unknown error from Anthropic API',
      });
    }

    const reply = data.content?.[0]?.text || '';
    console.log(`[Chat] ← ${reply.length} chars (user: ${req.user.email}, tier: ${req.user.tier})`);
    incrementTurns(req.user);

    res.json({
      reply,
      model:       data.model,
      usage:       data.usage,
      tier:        req.user.tier,
      daily_used:  (req.user.daily_count || 0) + 1,
      daily_limit: TIERS[req.user.tier]?.daily_limit ?? 50,
    });

  } catch (err) {
    console.error('[Chat] proxy error:', err.message);
    res.status(500).json({ error: 'Proxy error', detail: err.message });
  }
});

// ════════════════════════════════════════════════════════
// AUDIO TRANSCRIPTION — Phase 1 multi-model router
// POST /api/transcribe  (multipart/form-data)
//
// Fields:
//   audio      — audio file (MP3, WAV, M4A, OGG, WEBM, ≤25MB)
//   language   — BCP-47 hint e.g. "en", "ig", "ar" (optional)
//   session_id — for HOB logging (optional)
//
// Returns:
//   { transcript, language, duration_sec, model, confidence,
//     word_count, segments? }
//
// Model routing:
//   GEMINI_API_KEY present  → Gemini 1.5 Flash (primary)
//   GEMINI_API_KEY absent   → Claude text fallback (metadata only)
// ════════════════════════════════════════════════════════
(function setupTranscribeRoute() {
  const multerLib = getMulter();
  if (!multerLib) {
    // Register a stub that explains what to install
    app.post('/api/transcribe', (req, res) => {
      res.status(503).json({
        error: 'multer not installed',
        detail: 'Run: npm install multer form-data  then restart the server.',
      });
    });
    return;
  }

  // Store in memory (no disk writes — audio never persists on the server)
  const upload = multerLib({
    storage: multerLib.memoryStorage(),
    limits:  { fileSize: 25 * 1024 * 1024 }, // 25 MB
    fileFilter: (req, file, cb) => {
      const allowed = ['audio/mpeg','audio/mp3','audio/wav','audio/x-wav',
        'audio/mp4','audio/x-m4a','audio/ogg','audio/webm',
        'audio/flac','audio/aac','video/webm'];
      if(allowed.includes(file.mimetype) || file.mimetype.startsWith('audio/')) {
        cb(null, true);
      } else {
        cb(new Error(`Unsupported file type: ${file.mimetype}`));
      }
    },
  });

  app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'audio file is required (field name: audio)' });
    }

    const langHint   = req.body.language || 'en';
    const sessionId  = req.body.session_id || null;
    const fileBytes  = req.file.buffer;
    const fileMime   = req.file.mimetype || 'audio/mpeg';
    const fileName   = req.file.originalname || 'upload.mp3';
    const fileSizeKB = (req.file.size / 1024).toFixed(0);

    console.log(`[Transcribe] ${fileName} (${fileSizeKB}KB, ${fileMime}) lang=${langHint}`);

    // ── Route 1: Gemini 1.5 Flash (primary) ──────────
    if (GEMINI_KEY) {
      try {
        const transcript = await _transcribeWithGemini(
          fileBytes, fileMime, fileName, langHint
        );
        console.log(`[Transcribe] Gemini → ${transcript.transcript.length} chars`);
        return res.json({ ...transcript, model: GEMINI_MODEL });
      } catch (e) {
        console.error('[Transcribe] Gemini error:', e.message, '— falling back to Claude');
        // Fall through to Claude fallback
      }
    }

    // ── Route 2: Claude fallback (no Gemini key / Gemini error) ──
    try {
      const transcript = await _transcribeWithClaude(
        fileBytes, fileMime, fileName, fileSizeKB, langHint
      );
      console.log(`[Transcribe] Claude fallback → ${transcript.transcript.length} chars`);
      return res.json({ ...transcript, model: CLAUDE_MODEL + ' (fallback)' });
    } catch (e) {
      console.error('[Transcribe] Claude fallback error:', e.message);
      return res.status(500).json({ error: 'Transcription failed', detail: e.message });
    }
  });
})();

// ── Gemini transcription implementation ──────────────────
async function _transcribeWithGemini(fileBytes, mimeType, fileName, langHint) {
  const base64Audio = fileBytes.toString('base64');
  const langNames   = {
    en:'English', ig:'Igbo', yo:'Yoruba', ar:'Arabic', zh:'Mandarin Chinese',
    fr:'French', es:'Spanish', sw:'Swahili', ha:'Hausa', am:'Amharic'
  };
  const langName = langNames[langHint] || langHint;

  const prompt = [
    `Transcribe this audio file accurately and completely.`,
    langHint !== 'en' ? `The audio is likely in ${langName} — preserve all diacritics and special characters exactly.` : '',
    `Return a JSON object with exactly these fields:`,
    `{`,
    `  "transcript": "<full verbatim transcription>",`,
    `  "language": "<detected ISO 639-1 code, e.g. en>",`,
    `  "duration_sec": <estimated duration in seconds as a number>,`,
    `  "confidence": <0.0-1.0 confidence score>,`,
    `  "word_count": <integer word count>,`,
    `  "segments": [{"start_sec": 0, "end_sec": 5, "text": "..."}]`,
    `}`,
    `Return ONLY the JSON — no markdown, no explanation.`,
  ].filter(Boolean).join('\n');

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Audio } },
      ]
    }],
    generationConfig: {
      temperature:     0.1,  // low temp for accurate transcription
      responseMimeType: 'application/json',
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(60000), // audio can take longer
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

  let parsed;
  try {
    // Strip any accidental markdown fences
    const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(clean);
  } catch(e) {
    // If JSON parse fails, treat entire text as transcript
    parsed = { transcript: raw, language: langHint, confidence: 0.7 };
  }

  return {
    transcript:   String(parsed.transcript   || ''),
    language:     String(parsed.language     || langHint),
    duration_sec: Number(parsed.duration_sec || 0),
    confidence:   Number(parsed.confidence   || 0.8),
    word_count:   Number(parsed.word_count   || 0),
    segments:     Array.isArray(parsed.segments) ? parsed.segments : [],
    source:       'gemini',
  };
}

// ── Claude fallback — sends metadata, returns context + prompt ──
// Used when Gemini is unavailable. Cannot transcribe raw audio but
// provides a helpful acknowledgement and prompts the user.
async function _transcribeWithClaude(fileBytes, mimeType, fileName, fileSizeKB, langHint) {
  if (!ANTHROPIC_KEY) {
    return {
      transcript:   '',
      language:     langHint,
      duration_sec: 0,
      confidence:   0,
      word_count:   0,
      segments:     [],
      source:       'none',
      error:        'No transcription keys configured. Add GEMINI_API_KEY to .env for real transcription.',
    };
  }

  const prompt = `The user uploaded an audio file: "${fileName}" (${fileSizeKB}KB, type: ${mimeType}).
Real-time transcription requires a Gemini API key which is not configured.
Acknowledge the upload warmly, explain that transcription is not available yet, and ask them to paste or type the content they want to discuss. Keep it brief — 2 sentences.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  const text = data.content?.[0]?.text || 'Audio file received. Transcription requires Gemini API key.';

  return {
    transcript:   text,
    language:     langHint,
    duration_sec: 0,
    confidence:   0,
    word_count:   0,
    segments:     [],
    source:       'claude_fallback',
  };
}

// ════════════════════════════════════════════════════════
// NARRATIVEPURE™ — DUAL-MODEL VERIFICATION  (Phase 2)
// POST /api/verify
//
// Body: { text, context?, lang?, session_id? }
//   text     — the statement(s) to verify (max 4000 chars)
//   context  — prior conversation context (optional)
//   lang     — language hint (default 'en')
//   session_id — for HOB logging
//
// Returns: {
//   verdict:       'verified' | 'disputed' | 'uncertain' | 'unverifiable'
//   consensus:     0.0–1.0  (agreement between models)
//   confidence:    0.0–1.0  (combined confidence)
//   flags:         string[]  (specific issues found)
//   claude:        { verdict, reasoning, confidence }
//   gemini:        { verdict, reasoning, confidence } | null
//   divergence:    boolean   (models disagreed significantly)
//   hob_logged:    boolean
//   models_used:   string[]
// }
//
// Model routing:
//   Both keys present  → parallel Claude + Gemini, consensus scored
//   Gemini only        → Gemini solo (falls back gracefully)
//   Claude only        → Claude solo
//   Neither            → 503
// ════════════════════════════════════════════════════════
app.post('/api/verify', async (req, res) => {
  // Feature gate: verify requires pro or enterprise
  if (req.user && !checkFeature(req.user, 'verify')) {
    return res.status(403).json({
      error:   'NarrativePure™ requires Pro tier',
      code:    'feature_gated',
      upgrade: true,
    });
  }

  const {
    text,
    context    = '',
    lang       = 'en',
    session_id = null,
  } = req.body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!ANTHROPIC_KEY && !GEMINI_KEY) {
    return res.status(503).json({
      error: 'No verification models configured',
      detail: 'Add ANTHROPIC_API_KEY and/or GEMINI_API_KEY to .env',
    });
  }

  const snippet = text.slice(0, 120);
  console.log(`[Verify] "${snippet}…" lang=${lang}`);

  // ── Run models in parallel ──────────────────────────
  const [claudeResult, geminiResult] = await Promise.allSettled([
    ANTHROPIC_KEY ? _verifyWithClaude(text, context, lang)  : Promise.resolve(null),
    GEMINI_KEY    ? _verifyWithGemini(text, context, lang)  : Promise.resolve(null),
  ]);

  const claude = claudeResult.status === 'fulfilled' ? claudeResult.value : null;
  const gemini = geminiResult.status === 'fulfilled' ? geminiResult.value : null;

  if (claudeResult.status === 'rejected') {
    console.error('[Verify] Claude error:', claudeResult.reason?.message);
  }
  if (geminiResult.status === 'rejected') {
    console.error('[Verify] Gemini error:', geminiResult.reason?.message);
  }

  if (!claude && !gemini) {
    return res.status(500).json({ error: 'Both verification models failed' });
  }

  // ── Compute consensus ───────────────────────────────
  const result = _computeConsensus(claude, gemini);
  const modelsUsed = [
    claude ? CLAUDE_MODEL : null,
    gemini ? GEMINI_MODEL : null,
  ].filter(Boolean);

  // ── Log to HOB chain ─────────────────────────────────
  let hobLogged = false;
  if (session_id && getDB()) {
    try {
      const embHash = sha256(`verify|${result.verdict}|${result.consensus.toFixed(3)}|${Date.now()}`);
      const prevChain = getLatestChainHash(session_id);
      const intChain  = buildIntegrityChain(prevChain, embHash);
      getDB().prepare(`
        INSERT INTO hob_chain
          (hob_id, session_id, user_id_hash, timestamp_utc, lang_from, lang_to,
           switch_type, continuity_score, embedding_hash, integrity_chain,
           anomaly_flag, dialect_tag)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        crypto.randomUUID(), session_id,
        sha256('narrativepure|' + session_id),
        new Date().toISOString(),
        lang, lang,
        'narrativepure_verify',
        result.consensus,
        embHash, intChain,
        result.verdict === 'disputed' ? 1 : 0,
        `verdict:${result.verdict}|models:${modelsUsed.join('+')}`
      );
      hobLogged = true;
      console.log(`[Verify] HOB logged — verdict=${result.verdict} consensus=${result.consensus.toFixed(2)}`);
    } catch (e) {
      console.warn('[Verify] HOB log failed:', e.message);
    }
  }

  res.json({
    ...result,
    claude:      claude  ? { verdict: claude.verdict,  reasoning: claude.reasoning,  confidence: claude.confidence  } : null,
    gemini:      gemini  ? { verdict: gemini.verdict,  reasoning: gemini.reasoning,  confidence: gemini.confidence  } : null,
    models_used: modelsUsed,
    hob_logged:  hobLogged,
  });
});

// ── Claude verification ──────────────────────────────────
async function _verifyWithClaude(text, context, lang) {
  const prompt = _buildVerifyPrompt(text, context, lang);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 600,
      system: 'You are NarrativePure™ — a precision fact-verification engine for multilingual content. Respond only with valid JSON matching the schema provided. No markdown, no preamble.',
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const data = await res.json();
  return _parseVerifyResponse(data.content?.[0]?.text || '{}');
}

// ── Gemini verification ──────────────────────────────────
async function _verifyWithGemini(text, context, lang) {
  const prompt = _buildVerifyPrompt(text, context, lang);
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: 'You are NarrativePure™ — a precision fact-verification engine for multilingual content. Respond only with valid JSON matching the schema provided. No markdown, no preamble.' }] },
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return _parseVerifyResponse(raw);
}

// ── Shared prompt builder ────────────────────────────────
function _buildVerifyPrompt(text, context, lang) {
  const langNames = {
    en:'English',ig:'Igbo',yo:'Yoruba',ar:'Arabic',zh:'Mandarin',
    fr:'French',es:'Spanish',sw:'Swahili',ha:'Hausa',am:'Amharic'
  };
  return [
    context ? `Conversation context:\n${context.slice(0,1000)}\n\n` : '',
    `Statement to verify (language: ${langNames[lang] || lang}):\n"${text.slice(0,2000)}"`,
    `\nAnalyse the statement for factual accuracy, logical consistency, and narrative drift.`,
    `Respond with ONLY this JSON schema — no other text:`,
    `{`,
    `  "verdict": "verified" | "disputed" | "uncertain" | "unverifiable",`,
    `  "confidence": 0.0 to 1.0,`,
    `  "reasoning": "one concise sentence explaining your verdict",`,
    `  "flags": ["specific issue 1", "specific issue 2"],`,
    `  "claims": [{"claim": "...", "status": "supported"|"unsupported"|"needs_context"}]`,
    `}`,
    ``,
    `Verdict definitions:`,
    `- verified: claims are accurate and consistent with established knowledge`,
    `- disputed: one or more claims contradict known facts or are misleading`,
    `- uncertain: claims cannot be confirmed or denied without more context`,
    `- unverifiable: claims are subjective, opinion-based, or untestable`,
  ].join('\n');
}

// ── Parse and normalise verify response ──────────────────
function _parseVerifyResponse(raw) {
  try {
    const clean = raw.replace(/^```json\s*/i,'').replace(/```\s*$/,'').trim();
    const p = JSON.parse(clean);
    const validVerdicts = ['verified','disputed','uncertain','unverifiable'];
    return {
      verdict:    validVerdicts.includes(p.verdict) ? p.verdict : 'uncertain',
      confidence: Math.min(1, Math.max(0, Number(p.confidence) || 0.5)),
      reasoning:  String(p.reasoning || ''),
      flags:      Array.isArray(p.flags)  ? p.flags.slice(0,6)  : [],
      claims:     Array.isArray(p.claims) ? p.claims.slice(0,8) : [],
    };
  } catch(e) {
    return { verdict:'uncertain', confidence:0.4, reasoning:'Parse error', flags:[], claims:[] };
  }
}

// ── Compute consensus between two model results ──────────
function _computeConsensus(claude, gemini) {
  // Single model — return directly
  if (!claude && gemini) return { ...gemini,  consensus: gemini.confidence,  divergence: false };
  if (!gemini && claude) return { ...claude,  consensus: claude.confidence,  divergence: false };

  // Both models — compute agreement
  const sameVerdict   = claude.verdict === gemini.verdict;
  const verdictWeight = { verified:0, disputed:1, uncertain:2, unverifiable:3 };
  const vDiff = Math.abs(
    (verdictWeight[claude.verdict] ?? 2) - (verdictWeight[gemini.verdict] ?? 2)
  );

  // Consensus score: average confidence weighted by verdict agreement
  const avgConf  = (claude.confidence + gemini.confidence) / 2;
  const agreeBonus = sameVerdict ? 0.15 : 0;
  const consensus  = Math.min(1, avgConf + agreeBonus);

  // Final verdict: if models agree use that; if one says disputed, lean disputed
  let verdict;
  if (sameVerdict) {
    verdict = claude.verdict;
  } else if (claude.verdict === 'disputed' || gemini.verdict === 'disputed') {
    verdict = 'disputed';
  } else if (claude.verdict === 'verified' && gemini.verdict === 'uncertain') {
    verdict = 'uncertain';
  } else if (gemini.verdict === 'verified' && claude.verdict === 'uncertain') {
    verdict = 'uncertain';
  } else {
    verdict = 'uncertain';
  }

  // Merge flags (deduplicate)
  const flags = [...new Set([...claude.flags, ...gemini.flags])].slice(0, 8);

  // Merge claims
  const claimsMap = new Map();
  [...(claude.claims||[]), ...(gemini.claims||[])].forEach(c => {
    if (!claimsMap.has(c.claim)) claimsMap.set(c.claim, c);
  });

  return {
    verdict,
    consensus:  parseFloat(consensus.toFixed(3)),
    confidence: parseFloat(avgConf.toFixed(3)),
    flags,
    claims:     [...claimsMap.values()].slice(0, 8),
    divergence: !sameVerdict && vDiff >= 2,
  };
}

// ════════════════════════════════════════════════════════
// HOB BLOCK — ADD
// POST /api/hob/add
// Body: { session_id, user_id, lang_from, lang_to,
//         continuity_score, switch_type?, dialect_tag? }
// Returns: { hob_id, integrity_chain, embedding_hash,
//            continuity_score, anomaly_flag, block_number }
// ════════════════════════════════════════════════════════
app.post('/api/hob/add', (req, res) => {
  const {
    session_id, user_id = 'anonymous',
    lang_from = 'en', lang_to = 'en',
    continuity_score = 1.0,
    switch_type = 'unknown',
    dialect_tag = null,
  } = req.body;

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  const ts           = new Date().toISOString();
  const hob_id       = crypto.randomUUID();
  const user_id_hash = sha256(user_id + session_id); // pseudonymise — never store raw
  const embedding_hash = buildEmbeddingHash(lang_to, continuity_score, ts);
  const prevChain    = getLatestChainHash(session_id);
  const integrity_chain = buildIntegrityChain(prevChain, embedding_hash);
  const anomaly_flag = continuity_score < 0.65 ? 1 : 0;

  const block = {
    hob_id, session_id, user_id_hash, timestamp_utc: ts,
    lang_from, lang_to, switch_type,
    continuity_score: parseFloat(continuity_score.toFixed(4)),
    embedding_hash, integrity_chain,
    anomaly_flag, dialect_tag,
  };

  // Persist
  const database = getDB();
  if (database) {
    try {
      database.prepare(`
        INSERT INTO hob_chain
          (hob_id, session_id, user_id_hash, timestamp_utc, lang_from, lang_to,
           switch_type, continuity_score, embedding_hash, integrity_chain,
           anomaly_flag, dialect_tag)
        VALUES
          (@hob_id,@session_id,@user_id_hash,@timestamp_utc,@lang_from,@lang_to,
           @switch_type,@continuity_score,@embedding_hash,@integrity_chain,
           @anomaly_flag,@dialect_tag)
      `).run(block);
    } catch (e) {
      console.error('[HOB] insert error:', e.message);
    }
  } else {
    memChain.push(block);
  }

  const blockNumber = database
    ? (database.prepare('SELECT COUNT(*) as n FROM hob_chain WHERE session_id=?').get(session_id)?.n || 1)
    : memChain.filter(b => b.session_id === session_id).length;

  console.log(`[HOB] ·${blockNumber} ${lang_from}→${lang_to} score=${continuity_score.toFixed(2)} ${anomaly_flag ? '⚠ anomaly' : '✓'}`);

  res.json({
    hob_id, integrity_chain, embedding_hash,
    continuity_score: block.continuity_score,
    anomaly_flag: !!anomaly_flag,
    block_number: blockNumber,
    timestamp_utc: ts,
  });
});

// ════════════════════════════════════════════════════════
// HOB AUDIT — GET CHAIN
// GET /api/audit/hob?session_id=&tier=&lang=&from=&limit=
// tier: internal (default) | enterprise | user
// ════════════════════════════════════════════════════════
app.get('/api/audit/hob', (req, res) => {
  const { session_id, tier = 'internal', lang, from, limit = 100 } = req.query;

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  const database = getDB();
  let blocks;

  if (database) {
    let sql = 'SELECT * FROM hob_chain WHERE session_id=?';
    const params = [session_id];
    if (lang) { sql += ' AND (lang_from=? OR lang_to=?)'; params.push(lang, lang); }
    if (from) { sql += ' AND timestamp_utc >= ?'; params.push(from); }
    sql += ' ORDER BY created_at ASC LIMIT ?';
    params.push(parseInt(limit) || 100);
    blocks = database.prepare(sql).all(...params);
  } else {
    blocks = memChain
      .filter(b => b.session_id === session_id)
      .filter(b => !lang || b.lang_from === lang || b.lang_to === lang)
      .slice(0, parseInt(limit) || 100);
  }

  // Verify chain integrity
  const integrity = verifyChain(blocks);

  // Filter fields by access tier
  const filtered = blocks.map(b => {
    const base = {
      hob_id:          b.hob_id,
      timestamp_utc:   b.timestamp_utc,
      lang_from:       b.lang_from,
      lang_to:         b.lang_to,
      continuity_score: b.continuity_score,
    };
    if (tier === 'user') return base;
    // enterprise_audit adds:
    const ent = {
      ...base,
      switch_type:     b.switch_type,
      embedding_hash:  b.embedding_hash,
      integrity_chain: b.integrity_chain,
      anomaly_flag:    !!b.anomaly_flag,
      dialect_tag:     b.dialect_tag,
    };
    if (tier === 'enterprise') return ent;
    // internal adds everything
    return { ...ent, session_id: b.session_id, user_id_hash: b.user_id_hash };
  });

  res.json({
    session_id,
    block_count:      blocks.length,
    chain_valid:      integrity.valid,
    chain_broken_at:  integrity.broken_at,
    anomaly_count:    blocks.filter(b => b.anomaly_flag).length,
    storage:          database ? 'sqlite' : 'memory',
    blocks:           filtered,
  });
});

// ════════════════════════════════════════════════════════
// HOB — SINGLE BLOCK LOOKUP
// GET /api/audit/hob/:hob_id
// ════════════════════════════════════════════════════════
app.get('/api/audit/hob/:hob_id', (req, res) => {
  const { hob_id } = req.params;
  const database = getDB();
  const block = database
    ? database.prepare('SELECT * FROM hob_chain WHERE hob_id=?').get(hob_id)
    : memChain.find(b => b.hob_id === hob_id);

  if (!block) return res.status(404).json({ error: 'HOB block not found' });
  res.json({ ...block, anomaly_flag: !!block.anomaly_flag });
});

// ════════════════════════════════════════════════════════
// AUDIT SUMMARY
// GET /api/audit/summary?session_id=
// ════════════════════════════════════════════════════════
app.get('/api/audit/summary', (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  const database = getDB();
  if (!database) {
    const blocks = memChain.filter(b => b.session_id === session_id);
    return res.json({
      total_blocks: blocks.length,
      anomaly_count: blocks.filter(b => b.anomaly_flag).length,
      avg_score: blocks.length ? (blocks.reduce((a, b) => a + b.continuity_score, 0) / blocks.length).toFixed(3) : null,
      languages: [...new Set(blocks.map(b => b.lang_to))],
      storage: 'memory',
    });
  }

  const stats = database.prepare(`
    SELECT COUNT(*) as total, SUM(anomaly_flag) as anomalies,
           AVG(continuity_score) as avg_score,
           MIN(timestamp_utc) as first_turn, MAX(timestamp_utc) as last_turn
    FROM hob_chain WHERE session_id=?
  `).get(session_id);

  const langs = database.prepare(
    'SELECT DISTINCT lang_to FROM hob_chain WHERE session_id=?'
  ).all(session_id).map(r => r.lang_to);

  res.json({
    total_blocks:  stats.total,
    anomaly_count: stats.anomalies,
    avg_score:     stats.avg_score ? parseFloat(stats.avg_score).toFixed(3) : null,
    languages:     langs,
    first_turn:    stats.first_turn,
    last_turn:     stats.last_turn,
    storage:       'sqlite',
  });
});

// ── Start server ──────────────────────────────────────
getDB(); // init DB on startup

const httpServer = http.createServer(app);

// ════════════════════════════════════════════════════════
// WEBSOCKET VOICE STREAMING  —  ws://localhost:3000/ws/voice
//
// Message types (client → server):
//   { type:'auth',   token }
//   { type:'chat',   text, lang, system, history, token }
//   { type:'cancel' }
//
// Message types (server → client):
//   { type:'token',  text }           — streaming Claude token
//   { type:'done',   usage }          — stream complete
//   { type:'error',  error }          — something failed
//   { type:'interim',text }           — typing indicator echo
// ════════════════════════════════════════════════════════
const WSS = getWSS();
if (WSS) {
  const wss = new WSS({ server: httpServer, path: '/ws/voice' });

  wss.on('connection', (ws, req) => {
    let wsUser    = null;
    let cancelled = false;
    let activeController = null;

    console.log(`[WS] Client connected from ${req.socket.remoteAddress}`);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch(e) { ws.send(JSON.stringify({ type:'error', error:'Invalid JSON' })); return; }

      // ── Auth ────────────────────────────────────────
      if (msg.type === 'auth') {
        const token = msg.token;
        if (!token) return;
        const db   = getDB();
        const user = db ? db.prepare('SELECT * FROM users WHERE token=?').get(token) : null;
        if (user) {
          wsUser = user;
          console.log(`[WS] Authenticated: ${user.email} (${user.tier})`);
        }
        return;
      }

      // ── Cancel ──────────────────────────────────────
      if (msg.type === 'cancel') {
        cancelled = true;
        if (activeController) activeController.abort();
        return;
      }

      // ── Chat — stream Claude response ───────────────
      if (msg.type === 'chat') {
        if (!ANTHROPIC_KEY) {
          ws.send(JSON.stringify({ type:'error', error:'ANTHROPIC_API_KEY not configured' }));
          return;
        }

        // Auth check
        const token  = msg.token || null;
        const db     = getDB();
        let   user   = wsUser;
        if (!user && token && db) {
          user = db.prepare('SELECT * FROM users WHERE token=?').get(token);
        }
        if (!user) {
          ws.send(JSON.stringify({ type:'error', error:'unauthenticated', code:'unauthenticated' }));
          return;
        }

        // Rate limit check
        const limit = checkRateLimit(user);
        if (!limit.allowed) {
          ws.send(JSON.stringify({ type:'error', error:`Daily limit reached (${limit.limit}/day)`, code:'rate_limited' }));
          return;
        }

        // Build message history — sanitise
        let history = Array.isArray(msg.history) ? msg.history.slice(-12) : [];
        history.push({ role:'user', content: String(msg.text || '') });
        // Ensure starts with user turn
        while (history.length > 0 && history[0].role !== 'user') history.shift();

        cancelled        = false;
        activeController = new AbortController();

        try {
          const upstreamRes = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            headers: {
              'x-api-key':         ANTHROPIC_KEY,
              'anthropic-version': '2023-06-01',
              'Content-Type':      'application/json',
            },
            body: JSON.stringify({
              model:      CLAUDE_MODEL,
              max_tokens: 1000,
              stream:     true,
              system:     msg.system || 'You are a helpful multilingual assistant.',
              messages:   history,
            }),
            signal: activeController.signal,
          });

          if (!upstreamRes.ok) {
            const errText = await upstreamRes.text();
            ws.send(JSON.stringify({ type:'error', error:`Claude ${upstreamRes.status}: ${errText.slice(0,200)}` }));
            return;
          }

          // ── Stream response tokens ──────────────────
          let fullText = '';
          let usage    = null;
          const reader = upstreamRes.body;

          // Node stream — read SSE lines
          let sseBuffer = '';
          for await (const chunk of reader) {
            if (cancelled) break;
            if (ws.readyState !== 1 /* OPEN */) break;

            sseBuffer += chunk.toString('utf8');
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              try {
                const evt = JSON.parse(data);
                if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                  const token = evt.delta.text || '';
                  fullText += token;
                  ws.send(JSON.stringify({ type:'token', text:token }));
                }
                if (evt.type === 'message_delta' && evt.usage) {
                  usage = evt.usage;
                }
              } catch(e) { /* skip malformed SSE line */ }
            }
          }

          if (!cancelled) {
            // Increment turn counter
            incrementTurns(user);
            ws.send(JSON.stringify({ type:'done', usage, reply: fullText }));
            console.log(`[WS] Stream complete — ${fullText.length} chars (${user.email})`);
          }

        } catch(err) {
          if (err.name === 'AbortError') {
            console.log('[WS] Stream cancelled by client');
          } else {
            console.error('[WS] Stream error:', err.message);
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type:'error', error:err.message }));
            }
          }
        }
      }
    });

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      cancelled = true;
      if (activeController) activeController.abort();
    });

    ws.on('error', (err) => {
      console.error('[WS] Socket error:', err.message);
    });
  });

  console.log('[WS] Voice streaming endpoint ready at ws://localhost:' + PORT + '/ws/voice');
} else {
  console.warn('[WS] WebSocket server disabled — install ws: npm install ws');
}

httpServer.listen(PORT, () => {
  const helmetOk   = (() => { try { require('helmet'); return true; } catch(e){ return false; } })();
  const rlOk       = (() => { try { require('express-rate-limit'); return true; } catch(e){ return false; } })();
  const corsLocked = !!ALLOWED_ORIGINS;
  console.log(`
╔══════════════════════════════════════════════════════╗
║   Sphinx Global · Global Thought Stream Proxy v3.2   ║
╠══════════════════════════════════════════════════════╣
║   HTTP        http://localhost:${String(PORT).padEnd(23)}║
║   WebSocket   ws://localhost:${String(PORT).padEnd(25)}║
║   Chat        /api/chat              (Claude proxy)  ║
║   WS Voice    /ws/voice              (streaming)     ║
║   Verify      /api/verify            (NarrativePure) ║
║   Setup       /setup                                 ║
║   Health      /health                                ║
╠══════════════════════════════════════════════════════╣
║   Claude      ${(ANTHROPIC_KEY ? '✓ ready' : '✗ ANTHROPIC_API_KEY missing').padEnd(39)}║
║   Gemini      ${(GEMINI_KEY ? '✓ ready  (' + GEMINI_MODEL + ')' : '✗ key missing').padEnd(39)}║
║   ElevenLabs  ${(API_KEY ? '✓ ready' : '✗ key missing — browser TTS active').padEnd(39)}║
║   WebSocket   ${(WSS ? '✓ streaming active' : '✗ install: npm install ws').padEnd(39)}║
╠══════════════════════════════════════════════════════╣
║   Security                                           ║
║   Helmet      ${(helmetOk   ? '✓ security headers active' : '✗ install: npm install helmet').padEnd(39)}║
║   Rate limit  ${(rlOk       ? '✓ brute-force protection on' : '✗ install: npm install express-rate-limit').padEnd(39)}║
║   CORS        ${(corsLocked ? '✓ locked to: ' + (ALLOWED_ORIGINS||[]).join(',') : '⚠ open (set ALLOWED_ORIGINS= in .env for prod)').padEnd(39)}║
║   Input san.  ${'✓ active — null bytes + control chars stripped'.padEnd(39)}║
║   HTTPS       ${(process.env.APP_URL?.startsWith('https') ? '✓ configured' : '⚠ HTTP only — use Railway/Render for HTTPS').padEnd(39)}║
╚══════════════════════════════════════════════════════╝
  `);
});
