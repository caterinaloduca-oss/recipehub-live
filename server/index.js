require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'changeme';
const GATEWAY_URL = process.env.GATEWAY_URL || 'https://gateway.dailyfoodsa.com/mcp';
const GATEWAY_KEY = process.env.GATEWAY_KEY || 'changeme';
const USDA_API_KEY = process.env.USDA_API_KEY || 'changeme';

// ── EMAIL NOTIFICATIONS ──
const nodemailer = require('nodemailer');
const MAIL_FROM = process.env.MAIL_FROM || 'caterina.loduca@dailyfoodsa.com';
const MAIL_TRANSPORT = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: MAIL_FROM, pass: process.env.GMAIL_APP_PASSWORD || 'changeme' },
});

function sendNotification(to, subject, html) {
  if (!to || !to.length) return;
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  MAIL_TRANSPORT.sendMail({
    from: `"RecipeHub" <${MAIL_FROM}>`,
    to: recipients,
    subject: `[RecipeHub] ${subject}`,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1B2A4A;padding:16px 24px;border-radius:8px 8px 0 0">
        <span style="color:white;font-size:18px;font-weight:700">RecipeHub</span>
      </div>
      <div style="padding:24px;border:1px solid #E8E6E1;border-top:none;border-radius:0 0 8px 8px">
        ${html}
        <hr style="border:none;border-top:1px solid #E8E6E1;margin:20px 0" />
        <p style="font-size:11px;color:#999">This is an automated notification from <a href="https://recipehub.dailyfoodsa.com">RecipeHub</a></p>
      </div>
    </div>`,
  }).then(() => {
    console.log(`Email sent to ${recipients}: ${subject}`);
  }).catch(err => {
    console.error(`Email failed to ${recipients}:`, err.message);
  });
}

// Get email addresses by role from saved data
function getEmailsByRole(roles) {
  const state = db.getState();
  if (!state || !state.data || !state.data.users) return [];
  const roleSet = new Set(Array.isArray(roles) ? roles : [roles]);
  // Admin always gets everything
  roleSet.add('admin');
  return state.data.users
    .filter(u => u.active && u.email && roleSet.has(u.role))
    .map(u => u.email);
}

app.use(cors({ origin: ['https://recipehub.dailyfoodsa.com', 'http://localhost:5500', 'http://127.0.0.1:5500'] }));
app.use(express.json({ limit: '10mb' }));
// PDF render takes inlined-image HTML which can run 5–25MB depending on the
// number of step photos. Use a larger limit JUST for that endpoint.
const pdfRenderJson = express.json({ limit: '40mb' });

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Rate limiting
const rateLimit = require('express-rate-limit');
app.use('/api/comms/', rateLimit({ windowMs: 60000, max: 10, message: { error: 'Too many requests' } }));
app.use('/api/notify', rateLimit({ windowMs: 60000, max: 20, message: { error: 'Too many requests' } }));
app.use('/api/ebs/', rateLimit({ windowMs: 60000, max: 300, message: { error: 'Too many requests' } }));
app.use('/api/img/', rateLimit({ windowMs: 60000, max: 50, message: { error: 'Too many requests' } }));
app.use('/api/qa/media/', rateLimit({ windowMs: 60000, max: 20, message: { error: 'Too many requests' } }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Auth middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  const query = req.query.key;
  const token = auth ? auth.replace(/^Bearer\s+/i, '') : query;
  if (token !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Query the MCP gateway (via curl to match the client fingerprint the key was locked to)
async function queryGateway(source, sql) {
  const payload = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'query', arguments: { source, sql } },
    id: Date.now(),
  };
  const resp = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': 'Bearer ' + GATEWAY_KEY,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('Gateway returned non-JSON: ' + text.slice(0, 200)); }
  if (json.result?.content?.[0]?.text) {
    const data = JSON.parse(json.result.content[0].text);
    if (data.error) throw new Error(data.error);
    return data;
  }
  if (json.result?.isError) {
    const msg = json.result.content?.[0]?.text || 'Unknown gateway error';
    throw new Error(msg);
  }
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  throw new Error('Unexpected gateway response: ' + JSON.stringify(json).slice(0, 300));
}

// Health check (no auth needed)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// GET /api/data — load the shared app state
// PDF rendering via headless Chrome (Puppeteer). Lazy-load on first call so
// the server starts fast — Puppeteer initialisation is ~1s. Reuse the same
// browser instance across requests; restart it if it dies.
let _browser = null;
async function _getBrowser() {
  if (_browser && _browser.isConnected && _browser.isConnected()) return _browser;
  const puppeteer = require('puppeteer');
  _browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  // Replace the cached handle if Chrome exits unexpectedly
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

// Render any HTML to a PDF and stream it back. Body: { html, filename, options }.
// options.format defaults to 'A4', options.landscape to true (matches the SOP
// print preview's @page rule). Same-content endpoint also lets us reuse this
// for recipe / build PDFs later without extra plumbing.
app.post('/api/pdf/render', pdfRenderJson, requireAuth, async (req, res) => {
  let page = null;
  try {
    const html = String((req.body && req.body.html) || '');
    if (!html) return res.status(400).json({ error: 'html required' });
    const filename = String((req.body && req.body.filename) || 'document.pdf').replace(/[^A-Za-z0-9 _.\-]/g, '_');
    const opts = (req.body && req.body.options) || {};
    const browser = await _getBrowser();
    page = await browser.newPage();
    // emulateMediaType('print') applies @media print rules in the source HTML
    // (we already use them for break-inside:avoid + @page sizing).
    await page.emulateMediaType('print');
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdf = await page.pdf({
      format: opts.format || 'A4',
      landscape: opts.landscape !== false,           // default landscape
      printBackground: true,                         // honour background colours / images
      margin: opts.margin || { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' },
      preferCSSPageSize: true,                       // let the source @page rules win when set
    });
    // Puppeteer 24+ returns Uint8Array; res.send treats it as JSON unless we
    // explicitly wrap it as a Buffer.
    const pdfBuf = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdfBuf.length));
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.end(pdfBuf);
  } catch (err) {
    console.error('PDF render failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'PDF render failed: ' + err.message });
  } finally {
    if (page) try { await page.close(); } catch (e) {}
  }
});

// Version probe — returns the deployed HTML file's mtime (epoch ms). The
// client polls this periodically and prompts a reload when its loaded version
// is older than the server's current. Cheap (just an fs.stat); safe to poll
// every 60 seconds.
const HTML_PATHS = [
  '/var/www/recipehub/RecipeHub-App-v2.html',
  '/var/www/recipehub/index.html',
];
app.get('/api/version', (req, res) => {
  try {
    let latest = 0;
    // Primary source: the <meta name="rh-build" content="MS_TIMESTAMP"> tag
    // stamped into the HTML at deploy time. Reading the meta (not the file
    // mtime) is what lets a tab compare "the version *I* loaded" vs "the
    // version on disk now" correctly — see the matching JS in the client.
    for (const p of HTML_PATHS) {
      try {
        const buf = fs.readFileSync(p, { encoding: 'utf8' });
        // Only scan the first 2KB — the meta tag is in <head>.
        const head = buf.slice(0, 2000);
        const m = head.match(/<meta\s+name=["']rh-build["']\s+content=["'](\d+)["']/);
        if (m) {
          const v = Number(m[1]);
          if (v > latest) latest = v;
        } else {
          // No meta yet (file from before the change) — fall back to mtime
          // so old clients with the previous detector still get *something*.
          const st = fs.statSync(p);
          if (st.mtimeMs > latest) latest = st.mtimeMs;
        }
      } catch (e) { /* file may not exist on dev — ignore */ }
    }
    // Falls back to process start time if we can't read either file
    if (!latest) latest = Date.now() - process.uptime() * 1000;
    res.json({ htmlVersion: Math.floor(latest) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/data', requireAuth, (req, res) => {
  try {
    const state = db.getState();
    if (!state) return res.json({ data: null });
    res.json(state);
  } catch (err) {
    console.error('GET /api/data error:', err);
    res.status(500).json({ error: 'Failed to load data' });
  }
});

// Deduplicate arrays by ID field before saving
function dedupeById(arr, idField) {
  if (!Array.isArray(arr)) return arr;
  const seen = new Set();
  return arr.filter(item => {
    const id = item[idField || 'id'];
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// POST /api/data — save the shared app state
app.post('/api/data', requireAuth, (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid data' });
    }
    // Observability for the blob-write path. Every per-entity-coverable
    // field that lands in this body — when posted by a non-admin — is a
    // candidate for migration to its own POST /api/x/:id endpoint. We log
    // (don't reject) so existing flows keep working while we collect data
    // on which paths still need migration. After zero warnings for a few
    // days, flip this to a hard reject.
    try {
      const writerEmail = (req.headers['x-rh-user'] || '').toString().toLowerCase();
      const writerRole = writerEmail ? _roleForEmail(writerEmail) : '(anonymous)';
      if (writerRole !== 'admin') {
        const PROTECTED = ['recipes','users','builds','brands','substitutionRequests','branchSOPs','productionRuns','ingredients','savingsProjects'];
        const touched = PROTECTED.filter(f => body[f] !== undefined);
        if (touched.length) {
          console.warn('[blob-write-warn] ' + (writerEmail || '?') + ' (' + writerRole + ') posted /api/data with protected fields: ' + touched.join(','));
          try {
            db.auditAppend({
              user_email: writerEmail || '(anonymous)',
              action: 'system.blob_write_warning',
              target_type: 'data',
              target_id: '/api/data',
              target_label: 'fields: ' + touched.join(','),
              ip: req.ip || '',
              meta: { fields: touched, role: writerRole },
            });
          } catch (auditErr) { /* audit shouldn't block the write */ }
        }
      }
    } catch (warnErr) { /* observability code must never break the write */ }
    // Server-side deduplication — prevent duplicate IDs AND duplicate names from persisting
    if (body.branchSOPs) {
      body.branchSOPs = dedupeById(body.branchSOPs, 'id');
      const seenNames = new Set();
      body.branchSOPs = body.branchSOPs.filter(s => {
        const key = (s.name || '').toLowerCase().trim();
        if (seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      });
    }
    if (body.builds) body.builds = dedupeById(body.builds, 'id');
    if (body.productionRuns) body.productionRuns = dedupeById(body.productionRuns, 'id');
    // Users: dedupe by email AND strip invalid @dailyfoodsa.com emails.
    // Also: if server has a user with a newer updatedAt, preserve that record.
    // Prevents stale clients from reverting role changes / field edits.
    if (body.users) {
      body.users = dedupeById(body.users, 'email');
      body.users = body.users.filter(u => (u.email || '').toLowerCase().trim().endsWith('@dailyfoodsa.com'));
      const existingUsers = ((db.getState() || {}).data || {}).users || [];
      const srvByEmail = {};
      existingUsers.forEach(u => { if (u.email) srvByEmail[u.email.toLowerCase()] = u; });
      body.users = body.users.map(u => {
        const srv = srvByEmail[(u.email || '').toLowerCase()];
        if (!srv) return u;
        const s = srv.updatedAt || '';
        const c = u.updatedAt || '';
        return (s && (!c || s > c)) ? srv : u;
      });
    }
    // Merge images: never overwrite a real image with null/empty/placeholder
    const existing = db.getState();
    if (existing && existing.data) {
      const old = existing.data;

      // ── STALE-TAB DETECTION ──
      // If client's dataVersion is behind the server's, treat the post as STALE
      // and force a merge-by-id on every key array. Only fully-trusted (current
      // version) clients can shrink arrays; stale tabs can only ADD or UPDATE.
      // Genuine deletes must travel through the explicit deletedXIds lists,
      // which we already honor for recipes / SOPs / builds / commsLog / users.
      //
      // The client currently sends a hardcoded DATA_VERSION constant (6). The
      // server auto-increments its own version on every POST below, so within
      // a few saves clientVersion < serverVersion is permanently true and the
      // merge logic acts as a global safety net. Adds & updates flow through;
      // deletes need explicit deletedXIds tracking.
      const serverVersion = (existing.dataVersion || 0);
      const clientVersion = (body.dataVersion || 0);
      const isStaleTab = serverVersion > 0 && clientVersion < serverVersion;
      if (isStaleTab) {
        console.warn('[stale-tab] client dataVersion=' + clientVersion + ' < server=' + serverVersion + ' — forcing per-id merge on all arrays');
      }
      // Auto-increment server's dataVersion so the next post is also flagged.
      body.dataVersion = serverVersion + 1;

      // Helper: read the id from an entry. Supports objects keyed by string
      // field name, AND arrays-of-arrays where idField is a number index
      // (ingredients are stored as flat arrays: [id, name, supplier, code, ...]).
      const idOf = (x, idField) => {
        if (!x || idField == null) return null;
        // Function form: caller provides a custom keyer (e.g. r => r[3]+'|'+r[1]
        // for ingredients, where the unique key is code+name not just code).
        if (typeof idField === 'function') return idField(x);
        const v = (typeof idField === 'number') ? x[idField] : x[idField];
        return v;
      };
      const guardArray = (key, idField, deletedSet) => {
        const oldArr = old[key];
        const newArr = body[key];
        if (!Array.isArray(oldArr) || oldArr.length < 4) return;
        if (!Array.isArray(newArr)) {
          body[key] = oldArr.slice();
          console.warn('[guardArray] ' + key + ' omitted by client; restored ' + oldArr.length + ' from server');
          return;
        }
        const lostHalf = newArr.length < oldArr.length * 0.5;
        const shrinking = newArr.length < oldArr.length;
        const shouldMerge = lostHalf || (isStaleTab && shrinking);
        if (shouldMerge) {
          if (idField != null) {
            const seen = new Set(newArr.map(x => idOf(x, idField)).filter(v => v != null && v !== ''));
            const merged = newArr.slice();
            oldArr.forEach(x => {
              const id = idOf(x, idField);
              if (id == null || id === '' || seen.has(id)) return;
              if (deletedSet && deletedSet.has(id)) return;
              merged.push(x);
            });
            body[key] = merged;
            const why = isStaleTab && !lostHalf ? 'stale-tab' : 'drop>50%';
            console.warn('[guardArray] ' + key + ' (' + why + ') ' + oldArr.length + ' → ' + newArr.length + '; merged back to ' + merged.length);
          } else {
            body[key] = oldArr.slice();
            console.warn('[guardArray] ' + key + ' dropped from ' + oldArr.length + ' to ' + newArr.length + '; restored (no idField)');
          }
        }
      };
      // Build deletion sets early so guardArray can respect them when re-adding
      const _commsDeleted = new Set([
        ...(body.deletedCommsLogDates || []),
        ...((existing && existing.data && existing.data.deletedCommsLogDates) || []),
      ]);
      // Users: ALWAYS merge by email regardless of length drop. Stale tabs with
      // an older user list were silently deleting newly-added users (going from
      // 13 → 12 doesn't trigger the 50% drop guard). Now any server user that
      // isn't in the posted list AND isn't in deletedUserEmails is re-added.
      // Diagnosed 2026-05-03 after Alvin Vega kept disappearing.
      //
      // Per-user last-writer-wins (added 2026-05-12): before the absent-user
      // re-add pass, walk the incoming users and reject any whose updatedAt is
      // OLDER than the server's existing record for that email. Without this,
      // a stale tab can demote a recently-edited user (access flips, role
      // changes) just by including their old record in its /api/data POST.
      // Hit by the QA team Branch-SOP access reverting to OFF on 2026-05-12.
      {
        const oldByEmail = new Map();
        (Array.isArray(old.users) ? old.users : []).forEach(u => {
          const em = String((u && u.email) || '').toLowerCase();
          if (em) oldByEmail.set(em, u);
        });
        let prevented = 0;
        if (Array.isArray(body.users)) {
          body.users = body.users.map(u => {
            const em = String((u && u.email) || '').toLowerCase();
            if (!em) return u;
            const o = oldByEmail.get(em);
            if (!o) return u;
            const oldTs = String(o.updatedAt || '');
            const newTs = String(u.updatedAt || '');
            // Server's record is strictly newer — keep it, drop the stale
            // incoming. Equal timestamps + missing timestamps fall through to
            // the incoming version (no regression on legit fresh writes).
            if (oldTs && oldTs > newTs) {
              prevented++;
              return o;
            }
            return u;
          });
        }
        if (prevented) console.warn('[mergeUsers] kept ' + prevented + ' server record(s) whose updatedAt was newer than the incoming post');
      }
      {
        const oldUsers = Array.isArray(old.users) ? old.users : [];
        const newUsers = Array.isArray(body.users) ? body.users.slice() : oldUsers.slice();
        const deletedSet = new Set([
          ...(body.deletedUserEmails || []),
          ...(old.deletedUserEmails || []),
        ].map(e => String(e || '').toLowerCase()));
        const seen = new Set(newUsers.map(u => String((u && u.email) || '').toLowerCase()).filter(Boolean));
        let reAdded = 0;
        oldUsers.forEach(u => {
          const em = String((u && u.email) || '').toLowerCase();
          if (!em || seen.has(em) || deletedSet.has(em)) return;
          newUsers.push(u);
          reAdded++;
        });
        if (reAdded) console.warn('[mergeUsers] re-added ' + reAdded + ' server-only user(s) absent from client post');
        body.users = newUsers;
      }
      // Ingredients are flat arrays [id, name, supplier, code, ...] — code at idx 3.
      // deletedIngredientCodes lets us persist "this code was really deleted, do
      // NOT re-add it from server" — same pattern as deletedRecipeIds etc.
      // The list lives server-side; clients that don't post it inherit it from
      // the previous saved state so stale tabs can't accidentally clear it.
      const _ingDeletedArr = Array.from(new Set([
        ...(Array.isArray(body.deletedIngredientCodes) ? body.deletedIngredientCodes : []),
        ...(Array.isArray(old.deletedIngredientCodes) ? old.deletedIngredientCodes : []),
      ]));
      const _ingDeleted = new Set(_ingDeletedArr);
      body.deletedIngredientCodes = _ingDeletedArr; // persist the merged list back
      if (_ingDeleted.size && Array.isArray(body.ingredients)) {
        const before = body.ingredients.length;
        body.ingredients = body.ingredients.filter(r => !(Array.isArray(r) && r.length > 3 && _ingDeleted.has(r[3])));
        if (body.ingredients.length !== before) {
          console.warn('[ingredients] filtered ' + (before - body.ingredients.length) + ' codes via deletedIngredientCodes');
        }
      }
      // deletedIngredientAliases: same pattern but keyed by NAME (idx 1), so
      // stale tabs cannot re-add a typo'd alias for an ERP code we still keep.
      // Used when an item has multiple aliases and we canonicalize down to one.
      //
      // Reconcile lift: client may post `removeDeletedIngredientAliases: [name, …]`
      // signalling that the user explicitly re-added the name through the Reconcile
      // modal. Those names get subtracted from the union before the strip filter
      // runs — otherwise the alias is wiped and the user's reconcile work
      // disappears (Cate hit this 10× before we found it on 2026-05-10).
      const _liftSet = new Set(
        (Array.isArray(body.removeDeletedIngredientAliases) ? body.removeDeletedIngredientAliases : [])
          .map(s => String(s || '').toLowerCase().trim())
          .filter(Boolean)
      );
      const _aliasDeletedArr = Array.from(new Set([
        ...(Array.isArray(body.deletedIngredientAliases) ? body.deletedIngredientAliases : []),
        ...(Array.isArray(old.deletedIngredientAliases) ? old.deletedIngredientAliases : []),
      ])).filter(n => !_liftSet.has(String(n || '').toLowerCase().trim()));
      const _aliasDeleted = new Set(_aliasDeletedArr);
      body.deletedIngredientAliases = _aliasDeletedArr;
      delete body.removeDeletedIngredientAliases;  // consumed
      if (_liftSet.size) {
        console.log('[ingredients] reconcile lift removed ' + _liftSet.size + ' name(s) from deletedIngredientAliases');
      }
      if (_aliasDeleted.size && Array.isArray(body.ingredients)) {
        const before = body.ingredients.length;
        body.ingredients = body.ingredients.filter(r => !(Array.isArray(r) && r.length > 1 && _aliasDeleted.has(r[1])));
        if (body.ingredients.length !== before) {
          console.warn('[ingredients] filtered ' + (before - body.ingredients.length) + ' alias names via deletedIngredientAliases');
        }
      }
      // Ingredients: composite key (code + name) so multiple alias rows for the
      // same code (e.g. "Salt" + "Iodized Salt" + "Saudi Sea Salt" all on
      // RMADT0013) all survive a stale-tab merge. Reconciliation aliases were
      // disappearing when the merge deduped by code only.
      const _ingKey = r => (Array.isArray(r) && r.length > 3) ? (String(r[3]||'') + '|' + String(r[1]||'').toLowerCase()) : null;
      // _ingDeleted is keyed by code, so wrap it so the deletion check works
      // when the key is the composite — extract the code half before lookup.
      const _ingDeletedComposite = { has: k => { if (typeof k !== 'string') return false; const code = k.split('|')[0]; return _ingDeleted.has(code); } };
      guardArray('ingredients', _ingKey, _ingDeletedComposite);
      guardArray('builds', 'id');
      // Branch SOPs: ALWAYS merge alive entries by id regardless of total length.
      // Many tenants have <4 SOPs and guardArray's length>=4 threshold disables
      // protection at exactly the moment we need it (a single dropped SOP gets
      // through). Any SOP on the server that isn't in the body — and isn't in
      // the authoritative deletedSOPIds — is re-added.
      {
        const oldSOPs = Array.isArray(old.branchSOPs) ? old.branchSOPs : [];
        const newSOPs = Array.isArray(body.branchSOPs) ? body.branchSOPs.slice() : oldSOPs.slice();
        const killSet = new Set([
          ...((Array.isArray(old.deletedSOPIds)) ? old.deletedSOPIds : []),
        ]);
        const seen = new Set(newSOPs.map(s => s && s.id).filter(Boolean));
        let reAdded = 0;
        oldSOPs.forEach(s => {
          if (!s || !s.id) return;
          if (seen.has(s.id) || killSet.has(s.id)) return;
          newSOPs.push(s);
          reAdded++;
        });
        if (reAdded) console.warn('[mergeBranchSOPs] re-added ' + reAdded + ' server-only SOP(s) absent from client post');
        body.branchSOPs = newSOPs;
      }
      guardArray('branchSOPs', 'id');
      guardArray('brands', 'id');
      guardArray('productionRuns', 'id');
      guardArray('commsLog', 'date', _commsDeleted);
      guardArray('savingsProjects', null);
      guardArray('substitutionRequests', 'id');
      // Recipes: same guard but recipes is a dict keyed by npd, not an array
      if (old.recipes && typeof old.recipes === 'object' && Object.keys(old.recipes).length >= 4) {
        if (!body.recipes || typeof body.recipes !== 'object') {
          body.recipes = {};
          Object.keys(old.recipes).forEach(k => { body.recipes[k] = old.recipes[k]; });
          console.warn('[guardArray] recipes omitted by client; restored ' + Object.keys(body.recipes).length + ' from server');
        }
      }

      // Never lose recipes — merge missing ones back (unless explicitly deleted)
      if (old.recipes && body.recipes) {
        const deleted = new Set(body.deletedRecipeIds || []);
        Object.keys(old.recipes).forEach(npd => {
          if (!body.recipes[npd] && !deleted.has(npd)) body.recipes[npd] = old.recipes[npd];
        });
      }
      // Merge recipe images
      // Helper: is an image field "missing" — placeholder text or empty. A real URL
      // (data: or /docs/img/) counts as present.
      const imgIsEmpty = v => !v || v === '[server]' || v === 'null' || v === 'undefined';
      // Helper: does the client explicitly want to clear an image? True when their record
      // was updated after the server's (updatedAt wins). Otherwise treat null as staleness
      // and restore from server. Prevents stale clients from reverting photo uploads.
      const clientIsNewer = (cli, srv) => {
        const c = (cli && cli.updatedAt) || '';
        const s = (srv && srv.updatedAt) || '';
        return c && c > s;
      };

      if (body.recipes && old.recipes) {
        // Per-recipe merge through the same mergeRecipe used by /api/recipe/:npd.
        // Without this, a stale tab posting full /api/data could clobber methods,
        // ingredients, status, etc. — Cate hit this on 2026-05-10 (20 sauces lost
        // method steps because a stale tab from 2026-04-24 won the full-blob race).
        // Now: same concurrency rules apply whether you save via the per-entity
        // endpoint or the bulk one.
        Object.keys(body.recipes).forEach(k => {
          const nr = body.recipes[k], or = old.recipes[k];
          if (!or) return;  // brand new recipe in body, leave alone
          body.recipes[k] = mergeRecipe(or, nr);
        });
      }
      // Helper passthrough — still used by the builds merge path below.
      // (Was previously the recipe-image clear/restore helper; now lives outside
      // the recipe block since mergeRecipe handles those internally.)
      // Build sync: if existing has a newer updatedAt than incoming, keep existing entirely.
      // Per-build merge through mergeBuild — same concurrency-aware logic as
      // /api/build/:id. Without this, a stale tab posting full /api/data could
      // clobber components, sellingPrice, audit fields. Now: same merge rules
      // whether you save via per-entity endpoint or the bulk one. (Mirror of the
      // recipes fix that landed earlier today after the 65-legacy-SOP loss.)
      if (body.builds && old.builds) {
        body.builds = body.builds.map(b => {
          const ob = old.builds.find(x => x.id === b.id);
          if (!ob) return b;  // brand new build, leave alone
          return mergeBuild(ob, b);
        });
      }
      // Per-branchSOP merge through mergeBranchSOP — same protection.
      if (body.branchSOPs && old.branchSOPs) {
        body.branchSOPs = body.branchSOPs.map(sop => {
          const os = old.branchSOPs.find(x => x.id === sop.id);
          if (!os) return sop;
          return mergeBranchSOP(os, sop);
        });
      }
    }
    // Merge library docs and comms log — combine, dedupe by URL or timestamp
    if (existing && existing.data) {
      const old = existing.data;
      if (old.libraryDocs && old.libraryDocs.length) {
        if (!body.libraryDocs) body.libraryDocs = [];
        const existingUrls = new Set(body.libraryDocs.map(d => d.url));
        old.libraryDocs.forEach(d => { if (d.url && !existingUrls.has(d.url)) body.libraryDocs.push(d); });
      }
      // commsLog: field-level merge by date.
      // Don't re-add old entries that aren't in body (admin delete needs to stick),
      // but for entries that exist in both, fill in any fields the client didn't send
      // (e.g. body/recipientEmails backfilled on the server). Otherwise a stale tab
      // posting a slim commsLog wipes the enriched fields.
      if (old.commsLog && old.commsLog.length) {
        if (!body.commsLog) body.commsLog = [];
        const oldByDate = {};
        old.commsLog.forEach(m => { if (m && m.date) oldByDate[m.date] = m; });
        body.commsLog.forEach(m => {
          if (!m || !m.date) return;
          const o = oldByDate[m.date];
          if (!o) return;
          // Copy any field present on the server entry but undefined on the incoming one.
          Object.keys(o).forEach(k => { if (m[k] === undefined) m[k] = o[k]; });
          // Treat empty arrays/strings as "not sent" — prefer server's enriched value.
          if (Array.isArray(o.recipientEmails) && o.recipientEmails.length &&
              (!Array.isArray(m.recipientEmails) || !m.recipientEmails.length)) {
            m.recipientEmails = o.recipientEmails;
          }
          if (typeof o.body === 'string' && o.body.length && !m.body) m.body = o.body;
        });
      }
      if (old.activityLog && old.activityLog.length) {
        if (!body.activityLog) body.activityLog = [];
        const existingAct = new Set(body.activityLog.map(a => a.time));
        old.activityLog.forEach(a => { if (a.time && !existingAct.has(a.time)) body.activityLog.push(a); });
        body.activityLog = body.activityLog.slice(-200);
      }
      // Merge production runs by ID (skip runs for deleted recipes)
      if (old.productionRuns && old.productionRuns.length) {
        if (!body.productionRuns) body.productionRuns = [];
        const existingIds = new Set(body.productionRuns.map(r => r.id));
        const recipeIds = new Set(Object.keys(body.recipes || {}));
        const deletedIds = new Set(body.deletedRecipeIds || []);
        old.productionRuns.forEach(r => {
          if (r.id && !existingIds.has(r.id) && (!r.npd || recipeIds.has(r.npd)) && !deletedIds.has(r.npd)) {
            body.productionRuns.push(r);
          }
        });
      }
    }
    // Auto-clean: remove production runs for deleted recipes
    if (body.productionRuns && body.recipes) {
      const validRecipes = new Set(Object.keys(body.recipes));
      const deletedRecipes = new Set(body.deletedRecipeIds || []);
      body.productionRuns = body.productionRuns.filter(r => !r.npd || (validRecipes.has(r.npd) && !deletedRecipes.has(r.npd)));
    }
    // Kill list for production runs — server-authoritative (same pattern as
    // branchSOPs). /api/data ignores any body.deletedProductionRunIds and only
    // honors the server's existing list, so stale tabs can't kill alive runs
    // by replaying old local state. The DELETE /api/productionrun/:id endpoint
    // is the only way to retire a run.
    if (existing && existing.data && Array.isArray(existing.data.deletedProductionRunIds)) {
      body.deletedProductionRunIds = existing.data.deletedProductionRunIds.slice();
    } else {
      body.deletedProductionRunIds = [];
    }
    if (Array.isArray(body.productionRuns) && body.deletedProductionRunIds.length) {
      const killedRuns = new Set(body.deletedProductionRunIds);
      body.productionRuns = body.productionRuns.filter(r => !killedRuns.has(r && r.id));
    }
    // Aliveness merge for productionRuns — re-add any server-side run absent
    // from the body and not in the kill list (low-count safe; matches branchSOPs).
    if (existing && existing.data && Array.isArray(existing.data.productionRuns)) {
      const oldRuns = existing.data.productionRuns;
      const newRuns = Array.isArray(body.productionRuns) ? body.productionRuns.slice() : oldRuns.slice();
      const killSet = new Set(body.deletedProductionRunIds);
      const seen = new Set(newRuns.map(r => r && r.id).filter(Boolean));
      let reAdded = 0;
      oldRuns.forEach(r => {
        if (!r || !r.id) return;
        if (seen.has(r.id) || killSet.has(r.id)) return;
        newRuns.push(r);
        reAdded++;
      });
      if (reAdded) console.warn('[mergeProductionRuns] re-added ' + reAdded + ' server-only run(s) absent from client post');
      body.productionRuns = newRuns;
    }
    // Auto-clean: remove deleted Branch SOPs.
    //
    // /api/data is the bulk-sync path; it MUST NOT be allowed to kill a SOP
    // that is currently alive on the server, because stale tabs would replay
    // their old local kill lists indefinitely. Dedicated kill endpoint
    // (DELETE /api/branchsop/:id) is the only way to retire a SOP.
    //
    // Rule: server's existing.deletedSOPIds is authoritative. Body's
    // deletedSOPIds is ignored for kill-list mutation. Stripping uses the
    // server-authoritative list so dead entries can't get resurrected by a
    // stale client that still has them in branchSOPs.
    if (existing && existing.data && Array.isArray(existing.data.deletedSOPIds)) {
      body.deletedSOPIds = existing.data.deletedSOPIds.slice();
    } else {
      body.deletedSOPIds = [];
    }
    if (body.branchSOPs && body.deletedSOPIds && body.deletedSOPIds.length) {
      const deletedSOPs = new Set(body.deletedSOPIds);
      body.branchSOPs = body.branchSOPs.filter(s => !deletedSOPs.has(s.id));
    }
    // Same protection for deletedRecipeIds
    if (existing && existing.data && Array.isArray(existing.data.deletedRecipeIds)) {
      body.deletedRecipeIds = Array.from(new Set([...(body.deletedRecipeIds || []), ...existing.data.deletedRecipeIds]));
      if (body.recipes) {
        const deletedRecs = new Set(body.deletedRecipeIds);
        Object.keys(body.recipes).forEach(k => { if (deletedRecs.has(k)) delete body.recipes[k]; });
      }
    }
    // Same protection for deletedBuildIds. Without this, a stale client that still has
    // a deleted build in its local BUILDS_DATA will resurrect it on the next push.
    if (existing && existing.data && Array.isArray(existing.data.deletedBuildIds)) {
      body.deletedBuildIds = Array.from(new Set([...(body.deletedBuildIds || []), ...existing.data.deletedBuildIds]));
    }
    // Same protection for deletedCommsLogDates — admin deletes of comms log entries
    // were getting resurrected by guardArray() when commsLog dropped >50%.
    if (existing && existing.data && Array.isArray(existing.data.deletedCommsLogDates)) {
      body.deletedCommsLogDates = Array.from(new Set([...(body.deletedCommsLogDates || []), ...existing.data.deletedCommsLogDates]));
    }
    if (body.commsLog && body.deletedCommsLogDates && body.deletedCommsLogDates.length) {
      const deletedDates = new Set(body.deletedCommsLogDates);
      body.commsLog = body.commsLog.filter(m => !m || !deletedDates.has(m.date));
    }
    if (body.builds && body.deletedBuildIds && body.deletedBuildIds.length) {
      const deletedBuilds = new Set(body.deletedBuildIds);
      body.builds = body.builds.filter(b => !deletedBuilds.has(b.id));
    }
    // Same protection for brands, substitutionRequests and libraryDocs —
    // added 2026-05-13 along with their DELETE endpoints so a stale tab can
    // no longer resurrect a deleted entity through the /api/data full-blob path.
    if (existing && existing.data && Array.isArray(existing.data.deletedBrandIds)) {
      body.deletedBrandIds = Array.from(new Set([...(body.deletedBrandIds || []), ...existing.data.deletedBrandIds]));
    }
    if (body.brands && body.deletedBrandIds && body.deletedBrandIds.length) {
      const deletedBrands = new Set(body.deletedBrandIds);
      body.brands = body.brands.filter(b => b && !deletedBrands.has(b.id));
    }
    if (existing && existing.data && Array.isArray(existing.data.deletedSubstitutionIds)) {
      body.deletedSubstitutionIds = Array.from(new Set([...(body.deletedSubstitutionIds || []), ...existing.data.deletedSubstitutionIds]));
    }
    if (body.substitutionRequests && body.deletedSubstitutionIds && body.deletedSubstitutionIds.length) {
      const deletedSubs = new Set(body.deletedSubstitutionIds);
      body.substitutionRequests = body.substitutionRequests.filter(r => r && !deletedSubs.has(r.id));
    }
    if (existing && existing.data && Array.isArray(existing.data.deletedLibraryDocIds)) {
      body.deletedLibraryDocIds = Array.from(new Set([...(body.deletedLibraryDocIds || []), ...existing.data.deletedLibraryDocIds]));
    }
    if (body.libraryDocs && body.deletedLibraryDocIds && body.deletedLibraryDocIds.length) {
      const deletedDocs = new Set(body.deletedLibraryDocIds);
      body.libraryDocs = body.libraryDocs.filter(d => d && !deletedDocs.has(d.id));
    }
    const savedAt = db.setState(JSON.stringify(body), body.dataVersion || 0);
    res.json({ ok: true, savedAt });
  } catch (err) {
    console.error('POST /api/data error:', err);
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// ── Per-item merge helpers ──
function unionByKey(oldArr, newArr, key) {
  if (!oldArr || !oldArr.length) return newArr || [];
  if (!newArr || !newArr.length) return oldArr;
  const seen = new Set(newArr.map(x => x[key]));
  const merged = [...newArr];
  oldArr.forEach(x => { if (x[key] && !seen.has(x[key])) merged.push(x); });
  return merged;
}

function mergeRecipe(existing, incoming) {
  if (!existing) return incoming;
  const result = { ...incoming };
  const eTime = existing.updatedAt || '2000-01-01';
  const iTime = incoming.updatedAt || '2000-01-01';

  // If existing is newer for core fields, keep existing.
  // `status` is in here so a stale tab posting an old status string can't
  // overwrite a newer one. Cate hit this 2026-05-17: Pizza Donut 2026-240
  // was bounced trial → draft, then a stale tab silently flipped it back
  // to trial because status wasn't protected. Legitimate transitions bump
  // updatedAt and so go through the incoming-newer branch (this block is
  // skipped), where incoming.status wins as expected.
  if (eTime > iTime) {
    ['name','version','brand','type','storage','yield','yieldNotes','batchSize','costKg',
     'ingredients','method','packaging','sopSteps','sensoryGate1','sensoryGate2','status',
     // 'archived'/'discontinued' are also in preserve-when-undefined below, but
     // that path only fires when incoming omits the field. A stale tab that
     // explicitly carries `archived:false` would otherwise still win. Adding
     // them here closes the gap when existing is newer.
     'archived','discontinued'].forEach(f => {
      if (existing[f] !== undefined) result[f] = existing[f];
    });
    result.updatedAt = eTime;
  }

  // Always union-merge media (deletes go through the bulk /api/data path, not here)
  result.media = unionByKey(existing.media, result.media, 'name');
  // Union-merge append-only logs (audit trails — never delete)
  result.changeLog = unionByKey(existing.changeLog, result.changeLog, 'date');
  result.versionHistory = unionByKey(existing.versionHistory, result.versionHistory, 'savedAt');
  // factorySopArchive (Legacy SOP PDFs): append-only audit; union by dfcCode so
  // any client posting a recipe without this field doesn't wipe historical
  // attachments. (65 legacy SOPs got dropped on 2026-05-10 because incoming
  // bodies lacked the field — restore + cleanup scripts overwrote them.)
  result.factorySopArchive = unionByKey(existing.factorySopArchive, result.factorySopArchive, 'dfcCode');
  // Preserve flag fields if incoming doesn't carry them. Same with importFlags.
  // These are user/system metadata, not formulation data — implicit-clear via
  // omission is almost always wrong (stale tab posts that don't know about the
  // flag would silently clear it).
  ['flag','sopFlag','qaFlag','qasFlag','sopApproval','sopStatus','sopVersion','factorySopArchived','importFlags','source','importedAt','fgItemCode','fgDescription','recipeId','tags',
   // Lifecycle flags — same shape as on mergeBuild. Without these, archiving a
   // recipe and then navigating away (which can trigger a bulk save from a
   // stale tab missing the flag) silently un-archives it on the server. Cate
   // reported the bug 2026-05-17 ("archived keep on popping back out").
   'archived','discontinued',
   // QA-owned fields — preserved when incoming lacks them so a non-QA user
   // saving the recipe can never wipe QA work. trialQA / prodQA / prod-trialQA
   // already have explicit signed/files protection above; these are the rest:
   'qaLab','shelfLife','qasStatus','qas','qasApproval','qasBypass','sensoryGate1','sensoryGate2','sopApprovalHistory']
    .forEach(f => {
      if (result[f] === undefined && existing[f] !== undefined) result[f] = existing[f];
    });
  // Comments: respect deletes when the client is newer. Stale tabs still get protected
  // because their updatedAt is older than the server's, so we union them in.
  const _commentsClientWins = (incoming.updatedAt || '') > (existing.updatedAt || '');
  result.comments = _commentsClientWins
    ? (Array.isArray(incoming.comments) ? incoming.comments : [])
    : unionByKey(existing.comments, result.comments, 'date');

  // QA: preserve signed data
  ['trialQA', 'prodQA', 'prod-trialQA'].forEach(stage => {
    if (existing[stage] && existing[stage].signed && (!result[stage] || !result[stage].signed)) {
      result[stage] = existing[stage];
    }
    if (existing[stage] && existing[stage].files && existing[stage].files.length) {
      if (!result[stage]) result[stage] = { signed: false, files: [] };
      if (!result[stage].files) result[stage].files = [];
      const names = new Set(result[stage].files.map(f => f.name));
      existing[stage].files.forEach(f => { if (f.url && !names.has(f.name)) result[stage].files.push(f); });
    }
  });

  // Status: never regress unless explicitly newer
  const statusOrder = { draft:0, review:1, trial:2, 'prod-trial':3, approved:4 };
  if ((statusOrder[existing.status]||0) > (statusOrder[result.status]||0) && iTime <= eTime) {
    result.status = existing.status;
  }

  // Preserve images that incoming doesn't have
  if (existing.sopSteps && result.sopSteps) {
    result.sopSteps.forEach((s, i) => {
      if (existing.sopSteps[i] && existing.sopSteps[i].visualImg && !s.visualImg) {
        s.visualImg = existing.sopSteps[i].visualImg;
      }
    });
  }

  // Legacy SOP invariant (Cate's rule, baked in 2026-05-10):
  // A recipe with a legacy SOP PDF attached is, by definition, in production
  // — the historical Manufacturing Process doc IS the approved spec. So:
  //   - sopStatus must be 'approved' (no draft / pending)
  //   - recipe stage cannot be 'draft' (bump to 'approved')
  // Higher recipe stages (review / trial / prod-trial / approved) stay as-is
  // so an in-flight rework doesn't get force-bumped past its current gate.
  // Skip if not archived — archived recipes can sit at any stage / status.
  if (Array.isArray(result.factorySopArchive) && result.factorySopArchive.length > 0) {
    if (result.sopStatus !== 'approved') {
      result.sopStatus = 'approved';
      if (!result.sopApproval || !result.sopApproval.approved) {
        const ts = result.updatedAt || new Date().toISOString();
        const signoff = { by: 'Legacy SOP', at: ts };
        result.sopApproval = { prepared: { ...signoff }, reviewed: { ...signoff }, approved: { ...signoff } };
      }
      if (!result.sopVersion) result.sopVersion = '1.0';
    }
    // Status auto-bump from draft → approved only fires when this is the
    // FIRST time a status is set on the recipe (e.g. importing a Legacy SOP
    // PDF and the recipe has no prior status). If the existing record
    // already had a status, the user is explicitly transitioning — most
    // commonly a version-bump on an approved recipe (Nuha's "bounce out"
    // bug 2026-05-11: editing an approved Onion Topping with a Legacy SOP
    // attached kept reverting status='draft' back to 'approved' on save).
    if (result.status === 'draft' && !result.archived && (!existing || !existing.status)) {
      result.status = 'approved';
    }
  }

  return result;
}

function mergeBuild(existing, incoming) {
  if (!existing) return incoming;
  const result = { ...incoming };
  const eTime = existing.updatedAt || '2000-01-01';
  const iTime = incoming.updatedAt || '2000-01-01';
  if (eTime > iTime) {
    ['name','brand','type','size','components','instructions','bakeTemp','bakeTime','sellingPrice','status','launchStatus','active','nutrition','tags','allergens'].forEach(f => {
      if (existing[f] !== undefined) result[f] = existing[f];
    });
    result.updatedAt = eTime;
  }
  // Preserve photo
  if (existing.photo && !result.photo) result.photo = existing.photo;
  // Union-merge append-only audit logs (changeLog by date, comments by date).
  // Builds may not always carry these — unionByKey is a no-op when both are absent.
  if (existing.changeLog || result.changeLog) {
    result.changeLog = unionByKey(existing.changeLog, result.changeLog, 'date');
  }
  if (existing.comments || result.comments) {
    result.comments = unionByKey(existing.comments, result.comments, 'date');
  }
  // Preserve-when-undefined: stale tabs / scripts posting bodies without these
  // fields can no longer silently clear them. Same pattern as mergeRecipe.
  ['archived','discontinued','photo','nutrition','tags','createdBy','createdAt',
   'flag','launchStatus','active','allergens']
    .forEach(f => {
      if (result[f] === undefined && existing[f] !== undefined) result[f] = existing[f];
    });
  return result;
}

function mergeBranchSOP(existing, incoming) {
  if (!existing) return incoming;
  const result = { ...incoming };
  const eTime = existing.updatedAt || '2000-01-01';
  const iTime = incoming.updatedAt || '2000-01-01';
  if (eTime > iTime) {
    // Existing is newer — preserve its fields EXCEPT steps, which merge per-step so
    // that a later photo upload (which may not bump updatedAt) still lands.
    ['name','version','brand','status','buildRef','date'].forEach(f => {
      if (existing[f] !== undefined) result[f] = existing[f];
    });
    // Steps: use incoming steps as base, fall back to existing per-field when incoming is empty
    if (existing.steps && incoming.steps) {
      result.steps = incoming.steps.map((s, i) => {
        const e = existing.steps[i] || {};
        return {
          img: s && s.img ? s.img : (e.img || null),
          text: s && s.text ? s.text : (e.text || ''),
          portions: s && s.portions ? s.portions : (e.portions || ''),
          ...s,
        };
      });
    } else if (existing.steps) {
      result.steps = existing.steps;
    }
    result.updatedAt = eTime;
  } else {
    // Incoming is newer — take it wholesale, but still back-fill missing step images
    // from existing (protects against a payload that accidentally stripped one).
    if (existing.steps && result.steps) {
      result.steps.forEach((s, i) => {
        if (existing.steps[i] && existing.steps[i].img && !s.img) s.img = existing.steps[i].img;
      });
    }
  }
  // Union-merge audit logs (no-op if neither side has them)
  if (existing.changeLog || result.changeLog) {
    result.changeLog = unionByKey(existing.changeLog, result.changeLog, 'date');
  }
  if (existing.comments || result.comments) {
    result.comments = unionByKey(existing.comments, result.comments, 'date');
  }
  // Preserve-when-undefined for audit / shelf-life data — branch SOPs carry
  // per-component shelf-life maps that stale tabs would otherwise wipe.
  // Also preserves manual allergens / nutrition fields (Cate's call 2026-05-10
  // — these are now SOP-level, not auto-populated from build).
  ['archived','componentShelfLife','componentShelfLifeOpen','componentNotes',
   'createdBy','createdAt','flag','allergens','nutrition']
    .forEach(f => {
      if (result[f] === undefined && existing[f] !== undefined) result[f] = existing[f];
    });
  return result;
}

// ── Per-item save endpoints ──
app.post('/api/recipe/:npd', requireAuth, (req, res) => {
  try {
    const { npd } = req.params;
    const incoming = req.body.recipe;
    if (!incoming) return res.status(400).json({ error: 'recipe required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!data.recipes) data.recipes = {};
    data.recipes[npd] = mergeRecipe(data.recipes[npd], incoming);
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, recipe: data.recipes[npd] });
  } catch (err) {
    console.error('POST /api/recipe error:', err);
    res.status(500).json({ error: 'Failed to save recipe: ' + err.message });
  }
});

// Per-ingredient upsert. ING_DATA rows are flat arrays where row[1] is the
// display name and row[3] is the Oracle code; (code, name) is the composite
// key used everywhere else (matches guardArray + memory feedback_ingredients_composite_merge_key).
//
// Body: { row: [...], opts?: { liftAlias?: bool, liftCode?: bool } }
//   - liftAlias: removes row[1] from deletedIngredientAliases (use after a
//                Reconcile add, where the alias name was previously killed)
//   - liftCode:  removes row[3] from deletedIngredientCodes (rare — only used
//                when intentionally bringing back a code that was killed)
//
// On a row collision (same code + name), the existing row is replaced. New
// rows append. Saves and returns the canonical stored row.
app.post('/api/ingredient', requireAuth, (req, res) => {
  try {
    const incoming = req.body.row;
    const opts = req.body.opts || {};
    if (!Array.isArray(incoming) || incoming.length < 4) {
      return res.status(400).json({ error: 'row required as flat array (length >= 4)' });
    }
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.ingredients)) data.ingredients = [];

    const code = String(incoming[3] || '').trim();
    const name = String(incoming[1] || '').trim();
    if (!code || !name) return res.status(400).json({ error: 'row[1] (name) and row[3] (code) are both required' });

    // Lift kill-list entries if requested
    if (opts.liftAlias && Array.isArray(data.deletedIngredientAliases)) {
      const before = data.deletedIngredientAliases.length;
      data.deletedIngredientAliases = data.deletedIngredientAliases.filter(
        a => String(a || '').trim().toLowerCase() !== name.toLowerCase()
      );
      if (data.deletedIngredientAliases.length !== before) {
        console.log('[ingredient.upsert] lifted alias from kill list:', name);
      }
    }
    if (opts.liftCode && Array.isArray(data.deletedIngredientCodes)) {
      const before = data.deletedIngredientCodes.length;
      data.deletedIngredientCodes = data.deletedIngredientCodes.filter(c => c !== code);
      if (data.deletedIngredientCodes.length !== before) {
        console.log('[ingredient.upsert] lifted code from kill list:', code);
      }
    }

    // Find existing row by (code, name) composite key
    const idx = data.ingredients.findIndex(r =>
      Array.isArray(r) && r.length > 3
      && String(r[3] || '').trim() === code
      && String(r[1] || '').trim().toLowerCase() === name.toLowerCase()
    );
    let stored;
    if (idx >= 0) {
      stored = incoming.slice();
      data.ingredients[idx] = stored;
    } else {
      stored = incoming.slice();
      data.ingredients.push(stored);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, row: stored, mode: idx >= 0 ? 'updated' : 'created' });
  } catch (err) {
    console.error('POST /api/ingredient error:', err);
    res.status(500).json({ error: 'Failed to save ingredient: ' + err.message });
  }
});

// Delete one ingredient row, identified by (code, name). Adds the alias name
// to deletedIngredientAliases so /api/data can't resurrect it on a stale-tab
// post. Use opts.killCode = true to also add the code to deletedIngredientCodes
// (use sparingly — it kills ALL rows for that code, not just this alias).
app.delete('/api/ingredient', requireAuth, (req, res) => {
  try {
    // DELETE doesn't always have a body — accept query strings too
    const code = String((req.body && req.body.code) || req.query.code || '').trim();
    const name = String((req.body && req.body.name) || req.query.name || '').trim();
    const killCode = (req.body && req.body.killCode) || req.query.killCode === 'true';
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.ingredients)) data.ingredients = [];
    const before = data.ingredients.length;
    data.ingredients = data.ingredients.filter(r =>
      !(Array.isArray(r) && r.length > 3
        && String(r[3] || '').trim() === code
        && String(r[1] || '').trim().toLowerCase() === name.toLowerCase())
    );
    if (!Array.isArray(data.deletedIngredientAliases)) data.deletedIngredientAliases = [];
    if (!data.deletedIngredientAliases.includes(name)) data.deletedIngredientAliases.push(name);
    if (killCode) {
      if (!Array.isArray(data.deletedIngredientCodes)) data.deletedIngredientCodes = [];
      if (!data.deletedIngredientCodes.includes(code)) data.deletedIngredientCodes.push(code);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, removed: before - data.ingredients.length });
  } catch (err) {
    console.error('DELETE /api/ingredient error:', err);
    res.status(500).json({ error: 'Failed to delete ingredient: ' + err.message });
  }
});

// Per-brand upsert. Brand carries id, name, color, targetFC, archived. Stored
// in data.brands as an array; lookup by id.
app.post('/api/brand/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const incoming = req.body.brand;
    if (!incoming) return res.status(400).json({ error: 'brand required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.brands)) data.brands = [];
    const idx = data.brands.findIndex(b => b && b.id === id);
    let merged;
    if (idx >= 0) {
      const existing = data.brands[idx];
      const eTime = existing.updatedAt || '2000-01-01';
      const iTime = incoming.updatedAt || '2000-01-01';
      merged = { ...incoming };
      if (eTime > iTime) {
        ['name','color','targetFC','sellingMargin','archived'].forEach(f => {
          if (existing[f] !== undefined) merged[f] = existing[f];
        });
        merged.updatedAt = eTime;
      }
      // Preserve-when-undefined for incoming saves missing fields
      ['archived','color','targetFC','sellingMargin'].forEach(f => {
        if (merged[f] === undefined && existing[f] !== undefined) merged[f] = existing[f];
      });
      data.brands[idx] = merged;
    } else {
      merged = incoming;
      data.brands.push(merged);
    }
    // Aliveness wins: explicit save lifts the id out of deletedBrandIds.
    if (Array.isArray(data.deletedBrandIds) && data.deletedBrandIds.includes(id)) {
      data.deletedBrandIds = data.deletedBrandIds.filter(x => x !== id);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, brand: merged });
  } catch (err) {
    console.error('POST /api/brand error:', err);
    res.status(500).json({ error: 'Failed to save brand: ' + err.message });
  }
});

app.delete('/api/brand/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.deletedBrandIds)) data.deletedBrandIds = [];
    if (!data.deletedBrandIds.includes(id)) data.deletedBrandIds.push(id);
    if (Array.isArray(data.brands)) {
      data.brands = data.brands.filter(b => b && b.id !== id);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, killed: id });
  } catch (err) {
    console.error('DELETE /api/brand error:', err);
    res.status(500).json({ error: 'Failed to delete brand: ' + err.message });
  }
});

// Per-user upsert by email. The /api/data path already has a users-by-email
// merge that protects against stale-tab user-list shrinkage; this endpoint is
// for explicit user edits (role change, access toggle, password reset).
app.post('/api/user/:email', requireAuth, (req, res) => {
  try {
    const email = String(req.params.email || '').toLowerCase();
    const incoming = req.body.user;
    if (!incoming) return res.status(400).json({ error: 'user required' });
    if (!incoming.email || incoming.email.toLowerCase() !== email) {
      return res.status(400).json({ error: 'user.email must match URL email' });
    }
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.users)) data.users = [];
    const idx = data.users.findIndex(u => u && String((u.email || '')).toLowerCase() === email);
    let merged;
    if (idx >= 0) {
      const existing = data.users[idx];
      const eTime = existing.updatedAt || '2000-01-01';
      const iTime = incoming.updatedAt || '2000-01-01';
      merged = { ...existing, ...incoming };
      if (eTime > iTime) {
        ['name','role','active','phone','department'].forEach(f => {
          if (existing[f] !== undefined) merged[f] = existing[f];
        });
        merged.updatedAt = eTime;
      }
      // Access map merges field-by-field; existing wins per-key when newer
      if (existing.access || incoming.access) {
        merged.access = { ...(existing.access || {}), ...(incoming.access || {}) };
      }
      // Preserve-when-undefined for admin-granted flags (fullRights). Stops a
      // stale client that doesn't know about the flag from clearing it.
      if (merged.fullRights === undefined && existing.fullRights !== undefined) {
        merged.fullRights = existing.fullRights;
      }
      data.users[idx] = merged;
    } else {
      merged = incoming;
      data.users.push(merged);
    }
    // Explicit save is an "alive" signal — lift this email out of the
    // deletedUserEmails kill list so a stale tab can't immediately re-kill
    // them via the next /api/data merge.
    if (Array.isArray(data.deletedUserEmails) && data.deletedUserEmails.length) {
      data.deletedUserEmails = data.deletedUserEmails.filter(e => String(e || '').toLowerCase() !== email);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, user: merged });
  } catch (err) {
    console.error('POST /api/user error:', err);
    res.status(500).json({ error: 'Failed to save user: ' + err.message });
  }
});

// DELETE /api/user/:email — removes a user from the active list AND appends
// the email to deletedUserEmails so the merge in POST /api/data can't re-add
// them. Same "aliveness wins" pattern used for SOPs and production runs:
// the kill list is the source of truth, and a subsequent POST /api/user/:email
// for the same email lifts it back out of the list.
app.delete('/api/user/:email', requireAuth, (req, res) => {
  try {
    const email = String(req.params.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.deletedUserEmails)) data.deletedUserEmails = [];
    if (!data.deletedUserEmails.map(e => String(e || '').toLowerCase()).includes(email)) {
      data.deletedUserEmails.push(email);
    }
    if (Array.isArray(data.users)) {
      data.users = data.users.filter(u => u && String((u.email || '')).toLowerCase() !== email);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, killed: email });
  } catch (err) {
    console.error('DELETE /api/user error:', err);
    res.status(500).json({ error: 'Failed to delete user: ' + err.message });
  }
});

// Per-savingsProject upsert (KPI & Goals). Identified by id.
app.post('/api/savingsproject/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const incoming = req.body.project;
    if (!incoming) return res.status(400).json({ error: 'project required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.savingsProjects)) data.savingsProjects = [];
    const idx = data.savingsProjects.findIndex(p => p && p.id === id);
    let merged;
    if (idx >= 0) {
      merged = { ...data.savingsProjects[idx], ...incoming };
      data.savingsProjects[idx] = merged;
    } else {
      merged = incoming;
      data.savingsProjects.push(merged);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, project: merged });
  } catch (err) {
    console.error('POST /api/savingsproject error:', err);
    res.status(500).json({ error: 'Failed to save project: ' + err.message });
  }
});

// Substitution request upsert (Purchasing → R&D/QA/Factory ingredient swap
// workflow). Identified by id; same approval state can be touched by multiple
// roles, so the existing union-merge + preserve-when-undefined patterns
// elsewhere apply here too.
app.post('/api/substitution/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const incoming = req.body.request;
    if (!incoming) return res.status(400).json({ error: 'request required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.substitutionRequests)) data.substitutionRequests = [];
    const idx = data.substitutionRequests.findIndex(r => r && r.id === id);
    let merged;
    if (idx >= 0) {
      const existing = data.substitutionRequests[idx];
      merged = { ...existing, ...incoming };
      // Approvals merge per-role: existing approval wins unless incoming explicitly sets ok=true on a role
      if (existing.approvals && incoming.approvals) {
        merged.approvals = { ...existing.approvals };
        Object.keys(incoming.approvals).forEach(role => {
          const inc = incoming.approvals[role] || {};
          const exi = existing.approvals[role] || {};
          merged.approvals[role] = (inc.ok && !exi.ok) ? inc : { ...exi, ...inc };
        });
      }
      // Comments union by their timestamp key (substitutionRequests use `at`,
      // not `date`). Audit log — never delete.
      if (Array.isArray(existing.comments) || Array.isArray(incoming.comments)) {
        const seen = new Set();
        merged.comments = [];
        [].concat(Array.isArray(existing.comments) ? existing.comments : [],
                  Array.isArray(incoming.comments) ? incoming.comments : []).forEach(c => {
          if (!c) return;
          const key = c.at || c.date;
          if (!key || seen.has(key)) return;
          seen.add(key);
          merged.comments.push(c);
        });
      }
      data.substitutionRequests[idx] = merged;
    } else {
      merged = incoming;
      data.substitutionRequests.unshift(merged);
    }
    // Aliveness wins: explicit save lifts the id out of deletedSubstitutionIds.
    if (Array.isArray(data.deletedSubstitutionIds) && data.deletedSubstitutionIds.includes(id)) {
      data.deletedSubstitutionIds = data.deletedSubstitutionIds.filter(x => x !== id);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, request: merged });
  } catch (err) {
    console.error('POST /api/substitution error:', err);
    res.status(500).json({ error: 'Failed to save substitution: ' + err.message });
  }
});

app.delete('/api/substitution/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.deletedSubstitutionIds)) data.deletedSubstitutionIds = [];
    if (!data.deletedSubstitutionIds.includes(id)) data.deletedSubstitutionIds.push(id);
    if (Array.isArray(data.substitutionRequests)) {
      data.substitutionRequests = data.substitutionRequests.filter(r => r && r.id !== id);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, killed: id });
  } catch (err) {
    console.error('DELETE /api/substitution error:', err);
    res.status(500).json({ error: 'Failed to delete substitution: ' + err.message });
  }
});

// DELETE /api/library/:id — kills a library document. The on-disk file
// uploaded via /api/library/upload stays (cheap to keep, not exposed in UI
// once the entry is gone). Same kill-list pattern as everywhere else.
app.delete('/api/library/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.deletedLibraryDocIds)) data.deletedLibraryDocIds = [];
    if (!data.deletedLibraryDocIds.includes(id)) data.deletedLibraryDocIds.push(id);
    if (Array.isArray(data.libraryDocs)) {
      data.libraryDocs = data.libraryDocs.filter(d => d && d.id !== id);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, killed: id });
  } catch (err) {
    console.error('DELETE /api/library error:', err);
    res.status(500).json({ error: 'Failed to delete library doc: ' + err.message });
  }
});

// Append one commsLog entry. Comms log is append-only audit history; we
// dedupe by `date` (ISO timestamp) — duplicate sends won't double-log.
// Stale-tab clobber on commsLog (entry vanishes after a sync) is the failure
// this endpoint blocks: server appends and persists; subsequent /api/data
// merges keep it via the existing union-by-date logic.
app.post('/api/comms/log', requireAuth, (req, res) => {
  try {
    const entry = req.body.entry;
    if (!entry || !entry.date) return res.status(400).json({ error: 'entry.date required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.commsLog)) data.commsLog = [];
    // If the date is already present (duplicate send), update the entry rather than re-appending
    const idx = data.commsLog.findIndex(e => e && e.date === entry.date);
    if (idx >= 0) data.commsLog[idx] = entry;
    else data.commsLog.unshift(entry);   // newest first matches client convention
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, entry });
  } catch (err) {
    console.error('POST /api/comms/log error:', err);
    res.status(500).json({ error: 'Failed to append comms log: ' + err.message });
  }
});

app.post('/api/build/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const incoming = req.body.build;
    if (!incoming) return res.status(400).json({ error: 'build required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!data.builds) data.builds = [];
    const idx = data.builds.findIndex(b => b.id === id);
    if (idx >= 0) {
      data.builds[idx] = mergeBuild(data.builds[idx], incoming);
    } else {
      data.builds.push(incoming);
    }
    // Aliveness wins: explicit save lifts the id out of the kill list, so a
    // stale tab can't immediately re-kill the build on the next /api/data merge.
    if (Array.isArray(data.deletedBuildIds) && data.deletedBuildIds.includes(id)) {
      data.deletedBuildIds = data.deletedBuildIds.filter(x => x !== id);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, build: idx >= 0 ? data.builds[idx] : incoming });
  } catch (err) {
    console.error('POST /api/build error:', err);
    res.status(500).json({ error: 'Failed to save build: ' + err.message });
  }
});

// DELETE /api/build/:id — remove from builds[] AND append to deletedBuildIds.
// Note: does NOT cascade-delete linked Branch SOPs — the client should call
// DELETE /api/branchsop/:id for each linked SOP itself, so each killed entity
// gets its own audit trail.
app.delete('/api/build/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.deletedBuildIds)) data.deletedBuildIds = [];
    if (!data.deletedBuildIds.includes(id)) data.deletedBuildIds.push(id);
    if (Array.isArray(data.builds)) {
      data.builds = data.builds.filter(b => b && b.id !== id);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, killed: id });
  } catch (err) {
    console.error('DELETE /api/build error:', err);
    res.status(500).json({ error: 'Failed to delete build: ' + err.message });
  }
});

// Per-run save — preserve-when-undefined for status / missingIngredients /
// blockedAt / blockedBy / blockedNote / previousStatus so a non-flag-aware
// save can never silently clear an RM-blocked flag. (Two flags vanished this
// morning when a stale tab posted runs with status='pending' and no
// missingIngredients — that's how we lost BBQ + Korean BBQ flags.)
app.post('/api/productionrun/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const incoming = req.body.run;
    if (!incoming) return res.status(400).json({ error: 'run required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.productionRuns)) data.productionRuns = [];
    // Refuse to revive a run that's been explicitly killed (use a fresh id instead)
    if (Array.isArray(data.deletedProductionRunIds) && data.deletedProductionRunIds.includes(id)) {
      return res.status(409).json({ error: 'Run id is in the kill list — pick a different id' });
    }
    const idx = data.productionRuns.findIndex(r => r && r.id === id);
    let merged;
    if (idx >= 0) {
      const existing = data.productionRuns[idx];
      const eTime = existing.updatedAt || '2000-01-01';
      const iTime = incoming.updatedAt || '2000-01-01';
      merged = { ...incoming };
      // If existing newer, preserve formulation/identity fields
      if (eTime > iTime) {
        ['recipe','npd','brand','runType','batchSize','date','time','operator','notes'].forEach(f => {
          if (existing[f] !== undefined) merged[f] = existing[f];
        });
        merged.updatedAt = eTime;
      }
      // Always preserve when incoming lacks them — stale saves shouldn't wipe flags / audit / archived
      ['status','missingIngredients','blockedAt','blockedBy','blockedNote','previousStatus',
       'archived','completedAt','waste','yield','dateLog','comments','parentRunId','childRunIds','stageLabel'].forEach(f => {
        if (merged[f] === undefined && existing[f] !== undefined) merged[f] = existing[f];
      });
      data.productionRuns[idx] = merged;
    } else {
      merged = incoming;
      data.productionRuns.push(merged);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, run: merged });
  } catch (err) {
    console.error('POST /api/productionrun error:', err);
    res.status(500).json({ error: 'Failed to save production run: ' + err.message });
  }
});

// Explicit Production Run delete — adds the ID to the server's authoritative
// kill list and removes the run from productionRuns. /api/data ignores the
// body's deletedProductionRunIds, so this endpoint is the only path that can
// retire a run.
app.delete('/api/productionrun/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.deletedProductionRunIds)) data.deletedProductionRunIds = [];
    if (!data.deletedProductionRunIds.includes(id)) data.deletedProductionRunIds.push(id);
    if (Array.isArray(data.productionRuns)) {
      data.productionRuns = data.productionRuns.filter(r => r && r.id !== id);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, killed: id });
  } catch (err) {
    console.error('DELETE /api/productionrun error:', err);
    res.status(500).json({ error: 'Failed to delete production run: ' + err.message });
  }
});

// Explicit Branch SOP delete — adds the ID to the server's authoritative kill
// list and removes the SOP from branchSOPs. /api/data ignores the body's
// deletedSOPIds, so this endpoint is the only path that can retire a SOP.
app.delete('/api/branchsop/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!Array.isArray(data.deletedSOPIds)) data.deletedSOPIds = [];
    if (!data.deletedSOPIds.includes(id)) data.deletedSOPIds.push(id);
    if (Array.isArray(data.branchSOPs)) {
      data.branchSOPs = data.branchSOPs.filter(s => s && s.id !== id);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, killed: id });
  } catch (err) {
    console.error('DELETE /api/branchsop error:', err);
    res.status(500).json({ error: 'Failed to delete branch SOP: ' + err.message });
  }
});

app.post('/api/branchsop/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const incoming = req.body.sop;
    if (!incoming) return res.status(400).json({ error: 'sop required' });
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    if (!data.branchSOPs) data.branchSOPs = [];
    const idx = data.branchSOPs.findIndex(s => s.id === id);
    if (idx >= 0) {
      data.branchSOPs[idx] = mergeBranchSOP(data.branchSOPs[idx], incoming);
    } else {
      data.branchSOPs.push(incoming);
    }
    // Explicit save of a SOP is a "this is alive" signal — lift it out of the
    // delete kill list so a stale tab can't immediately re-kill it on the next
    // /api/data full-blob sync.
    if (Array.isArray(data.deletedSOPIds) && data.deletedSOPIds.includes(id)) {
      data.deletedSOPIds = data.deletedSOPIds.filter(x => x !== id);
    }
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, sop: idx >= 0 ? data.branchSOPs[idx] : incoming });
  } catch (err) {
    console.error('POST /api/branchsop error:', err);
    res.status(500).json({ error: 'Failed to save branch SOP: ' + err.message });
  }
});

// ── EBS PRICE ENDPOINTS (Oracle EBS — Riyadh org, cached in SQLite) ──

// Given an EBS accounting_cost (SAR per stockroom UOM) and the v_inventory_items conversion
// (recipe_unit + equivalence = recipe_units per stockroom_unit), compute the cost per recipe
// unit AND — where the recipe unit implies a mass/volume — a per-kg figure for costing.
//
// Example: Sunflower Oil, stockroom_cost=9.347 SAR/BOT, equivalence=1.5 (1 Bottle = 1.5 Ltr),
//          recipe_unit='ltr' → cost_per_recipe_unit = 9.347/1.5 = 6.23 SAR/Ltr → per_kg ≈ 6.23.
function priceForRecipe(cost, stockroomUom, recipeUnit, equivalence) {
  const out = {
    stockroomCost: cost != null ? Number(cost) : null,
    stockroomUom: stockroomUom || null,
    recipeUnit: recipeUnit || null,
    equivalence: equivalence != null ? Number(equivalence) : null,
    costPerRecipeUnit: null,
    pricePerKg: null,
    pricePerPiece: null,
  };
  if (out.stockroomCost == null || !out.equivalence || out.equivalence <= 0) return out;
  const perRecipe = out.stockroomCost / out.equivalence;
  out.costPerRecipeUnit = perRecipe;
  const u = String(recipeUnit || '').toLowerCase().trim();
  if (u === 'kg' || u === 'kgs')                                        out.pricePerKg = perRecipe;
  else if (u === 'gramm' || u === 'gram' || u === 'g' || u === 'grams') out.pricePerKg = perRecipe * 1000;
  else if (u === 'ltr' || u === 'lit' || u === 'litre' || u === 'liter' || u === 'liters' || u === 'litres') out.pricePerKg = perRecipe; // 1L ≈ 1kg for food liquids
  else if (u === 'ml')                                                  out.pricePerKg = perRecipe * 1000;
  else if (u === 'each' || u === 'pce' || u === 'pc' || u === 'pcs' || u === 'piece' || u === 'package' || u === 'pack') out.pricePerPiece = perRecipe;
  return out;
}

// GET /api/ebs/prices — all ingredient prices (latest period per item, cached)
app.get('/api/ebs/prices', requireAuth, (req, res) => {
  try {
    const rows = db.getLatestPrices();
    // For /api/ebs/prices we don't have a recipe_unit context (these are raw EBS items) — return
    // stockroom cost + UOM as the canonical fields. Consumers that have a POS mapping should hit
    // /api/ingredients/from-pos which normalises to recipe UOM.
    const prices = rows.map(r => ({
      code: r.item_number,
      name: r.item_desc,
      unit: r.uom,
      uomSource: r.uom,
      periodCode: r.period_code,
      accountingCost: r.accounting_cost,
      compnentCost: r.compnent_cost,
    }));
    const log = db.getSyncLog(1)[0];
    res.json({
      count: prices.length,
      lastSync: log ? log.finished_at : null,
      source: 'erp_item_cost_riyadh (Oracle EBS, org 110)',
      prices,
    });
  } catch (err) {
    console.error('EBS prices error:', err);
    res.status(500).json({ error: 'Failed to fetch EBS prices: ' + err.message });
  }
});

// GET /api/items/status — returns { code: status } map for every item in items_master.
// Used client-side to drive the Active/Inactive filter on the Ingredients DB.
// Cached in-memory for 10 min so we don't hammer the gateway on every page render.
let _itemStatusCache = { at: 0, map: null };
app.get('/api/items/status', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    if (_itemStatusCache.map && (now - _itemStatusCache.at) < 10 * 60 * 1000) {
      return res.json({ count: Object.keys(_itemStatusCache.map).length, cached: true, map: _itemStatusCache.map });
    }
    const r = await queryGateway('items_master', `SELECT ITEM_CODE, STATUS FROM data`);
    const map = {};
    for (const row of (r.rows || [])) {
      const c = (row.ITEM_CODE || '').trim();
      if (c) map[c] = row.STATUS || 'Unknown';
    }
    _itemStatusCache = { at: now, map };
    res.json({ count: Object.keys(map).length, cached: false, map });
  } catch (err) {
    console.error('items status error:', err);
    res.status(500).json({ error: 'Failed to fetch item status: ' + err.message });
  }
});

// GET /api/ebs/search?q=tomato — search by name or item_number, return raw stockroom price.
// Callers that need recipe-unit cost should pair this with pos_erp_item_map / ebs_item_map.
app.get('/api/ebs/search', requireAuth, (req, res) => {
  try {
    const raw = (req.query.q || '').trim();
    if (!raw || raw.length < 2) return res.json({ results: [] });
    const q = raw.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 100);
    if (!q) return res.json({ results: [] });
    const rows = db.searchPrices(q);
    const results = rows.map(r => ({
      code: r.item_number,
      name: r.item_desc,
      unit: r.uom,
      uomSource: r.uom,
      periodCode: r.period_code,
      accountingCost: r.accounting_cost,
      // Back-compat for the autocomplete/ingredient form — avgPrice = raw stockroom cost:
      avgPrice: r.accounting_cost,
      purchasePrice: r.accounting_cost,
      originalUnit: r.uom,
      vendor: '',
      vendors: [],
    }));
    res.json({ results });
  } catch (err) {
    console.error('EBS search error:', err);
    res.status(500).json({ error: 'Failed to search EBS: ' + err.message });
  }
});

// GET /api/ebs/price-history/:itemNumber — all periods for one item
app.get('/api/ebs/price-history/:itemNumber', requireAuth, (req, res) => {
  try {
    const item = String(req.params.itemNumber || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (!item) return res.status(400).json({ error: 'itemNumber required' });
    const rows = db.getPriceHistory(item);
    res.json({ itemNumber: item, count: rows.length, history: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history: ' + err.message });
  }
});

// POST /api/ebs/sync-prices — pull full history from Oracle EBS (all warehouse orgs) into local cache
app.post('/api/ebs/sync-prices', requireAuth, async (req, res) => {
  const logId = db.logSyncStart();
  try {
    // erp_item_cost_all_orgs carries 9 orgs; gateway row cap is now unlimited for npd role.
    // Paginate by period_code anyway so one slow query doesn't exceed the 30s HTTP timeout.
    const periodsRes = await queryGateway('erp_item_cost_all_orgs', `
      SELECT DISTINCT period_code FROM data WHERE cost_component_class = 'MATERIAL' ORDER BY period_code
    `);
    const periods = (periodsRes.rows || []).map(r => r.period_code || r.PERIOD_CODE).filter(Boolean);

    let n = 0;
    for (const period of periods) {
      const priced = await queryGateway('erp_item_cost_all_orgs', `
        SELECT item_number, item_desc, uom, cost_component_class,
               compnent_cost, accounting_cost, period_code, organization_code
        FROM data
        WHERE cost_component_class = 'MATERIAL' AND period_code = '${period.replace(/'/g, "''")}'
      `);
      const costRows = (priced.rows || []).map(r => ({
        item_number: r.item_number || r.ITEM_NUMBER,
        item_desc: r.item_desc || r.ITEM_DESC,
        uom: r.uom || r.UOM,
        cost_component_class: r.cost_component_class || r.COST_COMPONENT_CLASS || 'MATERIAL',
        compnent_cost: r.compnent_cost != null ? r.compnent_cost : r.COMPNENT_COST,
        accounting_cost: r.accounting_cost != null ? r.accounting_cost : r.ACCOUNTING_COST,
        period_code: r.period_code || r.PERIOD_CODE,
        organization_code: r.organization_code || r.ORGANIZATION_CODE,
        start_date: periodToDate(r.period_code || r.PERIOD_CODE),
      }));
      n += db.upsertCostRows(costRows);
    }

    // Build the POS→ERP map by merging TWO sources:
    //   - v_inventory_items (RedShift): carries the real recipe_unit / stockroom_unit / equivalence
    //     conversion factors that the kitchen uses. Pick the branch row with a letter-prefixed
    //     export_id and non-null equivalence.
    //   - pos_erp_item_map (Oracle_EBS): the canonical ERP_ITEM_ID bridge. When present it wins
    //     over v_inventory_items.export_id for the export_id field, but we keep v_inventory_items'
    //     recipe_unit / equivalence because pos_erp_item_map's CONV_FACTOR is POS↔ERP UOM
    //     (usually 1:1) not recipe↔stockroom.
    // 1) Canonical POS→ERP bridge from pos_erp_item_map (usually small, ~1,255 rows)
    const bridgeRes = await queryGateway('pos_erp_item_map', `
      SELECT POS_ITEM_ID, ERP_ITEM_ID
      FROM data
      WHERE STATUS = 'Active' AND ERP_ITEM_ID IS NOT NULL
    `);
    const bridgeByPos = {};
    for (const b of (bridgeRes.rows || [])) {
      const pos = String(b.POS_ITEM_ID || b.pos_item_id || '');
      const erp = String(b.ERP_ITEM_ID || b.erp_item_id || '').trim();
      if (pos && erp) bridgeByPos[pos] = erp;
    }

    // 2) v_inventory_items: keep every (inv_item_id, export_id) pair with its conversion factors
    //    so we can match the exact row whose export_id == bridge ERP code (same pack size = correct equivalence).
    const invRes = await queryGateway('RedShift', `
      SELECT inv_item_id, MAX(description) AS description, recipe_unit, stockroom_unit,
             equivalence, TRIM(export_id) AS export_id
      FROM maestroksa.v_inventory_items
      WHERE description IS NOT NULL
        AND TRIM(export_id) IS NOT NULL
        AND TRIM(export_id) <> ''
      GROUP BY inv_item_id, recipe_unit, stockroom_unit, equivalence, TRIM(export_id)
    `);
    // Group by inv_item_id
    const invByPos = {};
    for (const r of (invRes.rows || [])) {
      const invId = String(r.inv_item_id);
      if (!invByPos[invId]) invByPos[invId] = [];
      invByPos[invId].push({
        description: r.description,
        recipe_unit: r.recipe_unit,
        stockroom_unit: r.stockroom_unit,
        equivalence: Number(r.equivalence) || 0,
        export_id: (r.export_id || '').trim(),
      });
    }

    // 3) Combine: prefer the variant whose export_id has actual cost data in our local cache
    //    (Riyadh org 110 may not stock the bridge's canonical ERP code — e.g. POS 942 → bridge
    //    RMOLT0012 (1.5L pack) but Riyadh only carries RMOLT0001 (1.8L) / RMOLT0002 (18L tin)).
    const pricedErpCodes = new Set(
      db.getLatestPrices().map(p => p.item_number)
    );
    const allPosIds = new Set([...Object.keys(bridgeByPos), ...Object.keys(invByPos)]);
    const mapRows = [];
    for (const invId of allPosIds) {
      const bridgeErp = bridgeByPos[invId];
      const variants = invByPos[invId] || [];
      // Rank candidates: [has cost in cache? 0:1, matches bridge? 0:1, has equivalence>0? 0:1]
      const sorted = variants.slice().sort((a, b) => {
        const aPriced = pricedErpCodes.has(a.export_id) ? 0 : 1;
        const bPriced = pricedErpCodes.has(b.export_id) ? 0 : 1;
        if (aPriced !== bPriced) return aPriced - bPriced;
        const aBridge = (bridgeErp && a.export_id === bridgeErp) ? 0 : 1;
        const bBridge = (bridgeErp && b.export_id === bridgeErp) ? 0 : 1;
        if (aBridge !== bBridge) return aBridge - bBridge;
        const aEq = (a.equivalence > 0) ? 0 : 1;
        const bEq = (b.equivalence > 0) ? 0 : 1;
        return aEq - bEq;
      });
      let pick = sorted[0] || null;
      // If no v_inventory_items variant at all, still emit a map row using the bridge code (no conversion data)
      if (!pick && bridgeErp) {
        mapRows.push({ inv_item_id: invId, description: null, recipe_unit: null, stockroom_unit: null, equivalence: null, export_id: bridgeErp });
        continue;
      }
      if (!pick) continue;
      // Prefer the picked row's export_id when it's priced; else fall back to the bridge
      let exportId = pricedErpCodes.has(pick.export_id) ? pick.export_id : (bridgeErp || pick.export_id);
      if (!exportId) continue;
      mapRows.push({
        inv_item_id: invId,
        description: pick.description,
        recipe_unit: pick.recipe_unit,
        stockroom_unit: pick.stockroom_unit,
        equivalence: pick.equivalence,
        export_id: exportId,
      });
    }
    const m = db.upsertItemMap(mapRows);

    db.logSyncEnd(logId, n + m, null);
    res.json({ ok: true, costRows: n, mapRows: m, finishedAt: new Date().toISOString() });
  } catch (err) {
    db.logSyncEnd(logId, 0, String(err.message || err));
    console.error('EBS sync error:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// Convert Oracle period_code "MMM-YY" into an ISO date on day 01 (so lexicographic sort works)
function periodToDate(period) {
  if (!period) return null;
  const m = String(period).match(/^([A-Z]{3})-(\d{2})$/i);
  if (!m) return null;
  const months = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
  const mm = months[m[1].toUpperCase()]; if (!mm) return null;
  const yy = parseInt(m[2], 10);
  const yyyy = yy < 70 ? 2000 + yy : 1900 + yy;
  return yyyy + '-' + mm + '-01';
}

// GET /api/ebs/sync-log — recent sync runs for admin UI
app.get('/api/ebs/sync-log', requireAuth, (req, res) => {
  res.json({ log: db.getSyncLog(10) });
});

// GET /api/ingredients/ebs-catalog?q=... — search the full EBS cost cache for mapping UI
app.get('/api/ingredients/ebs-catalog', requireAuth, (req, res) => {
  try {
    const raw = (req.query.q || '').trim();
    const q = raw.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60);
    if (!q || q.length < 1) return res.json({ results: [] });
    const rows = db.searchPrices(q);
    res.json({
      results: rows.map(r => ({
        itemNumber: r.item_number,
        description: r.item_desc,
        uom: r.uom,
        latestCost: r.accounting_cost,
        periodCode: r.period_code,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

// POST /api/ingredients/map  { invItemId, erpItemNumber, notes } — user maps POS item → ERP
app.post('/api/ingredients/map', requireAuth, (req, res) => {
  try {
    const { invItemId, erpItemNumber, notes, mappedBy } = req.body || {};
    if (!invItemId || !erpItemNumber) return res.status(400).json({ error: 'invItemId and erpItemNumber required' });
    db.setLocalMap(String(invItemId), String(erpItemNumber), mappedBy || null, notes || null);
    res.json({ ok: true, invItemId: String(invItemId), erpItemNumber: String(erpItemNumber) });
  } catch (err) {
    res.status(500).json({ error: 'Save failed: ' + err.message });
  }
});

// DELETE /api/ingredients/map/:invItemId — clear a user-set mapping
app.delete('/api/ingredients/map/:invItemId', requireAuth, (req, res) => {
  try {
    db.deleteLocalMap(String(req.params.invItemId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  }
});

// GET /api/ingredients/map — list all user-set mappings
app.get('/api/ingredients/map', requireAuth, (req, res) => {
  res.json({ maps: db.listLocalMaps() });
});

// ERP item-code prefix → category. Oracle EBS item codes are 10-char codes whose first 4
// chars encode the item's true type (RMOL = Raw Material → Oil, SFSA = Semi-Finished → Sauce,
// FGBE = Finished Good → Beverage, PMPX = Packing Material, COHC = Cleaning/Hygiene, etc.).
// This is authoritative — when an item is mapped to an ERP code we trust the prefix over
// the POS sale_item_family_group (which is misleading — e.g. Can Opener tagged "Sauces"
// because it appears as a line in a sauce sale item's recipe).
const ERP_PREFIX_CATEGORIES = {
  // Raw Materials
  RMOL: 'Oil',
  RMMP: 'Meat & Protein',
  RMDP: 'Dairy',
  RMSA: 'Sauce',
  RMTO: 'Topping',
  RMSE: 'Seasoning',
  RMAD: 'Additive',
  RMGP: 'Grain & Flour',
  RMBR: 'Bread & Crumbs',
  RMPD: 'Dough',
  RMSD: 'Side Dish',
  RMDS: 'Dessert',
  RMBV: 'Beverage',
  // Semi-Finished (CPP-made)
  SFSA: 'Sauce',
  SFTO: 'Topping',
  SFCR: 'Crust',
  SFSD: 'Side Dish',
  SFDS: 'Dessert',
  SFPA: 'Pasta',
  SFSL: 'Salad',
  SFDP: 'Dip',
  SFPZ: 'Pizza',
  SFBD: 'Burger Dough',
  SFMA: 'Mac & Cheese',
  SFSE: 'Seasoning',
  // Finished Goods
  FGBE: 'Beverage',
  FGSA: 'Dip',
  FGAP: 'Appetizer',
  // Non-food families (all PM*/CO*/CA*/SV* prefixes collapse to these)
};
const ERP_PREFIX2_NONFOOD = {
  PM: 'Packing Material',
  CO: 'Operating Supply',  // covers cleaning (COHC), uniforms (COUN), tools (COOT), marketing (COMA, COMF), stationery (COPS), etc.
  CA: 'Equipment',
  SV: 'Service',
};

// Lightweight keyword fallback — used only when we have no ERP code (POS-only items)
const NAME_KEYWORD_RULES = [
  { cat: 'Equipment',        re: /\b(chair|table|bench|shelf|rack|door|ladder|oven|heater|power supply|adapter|lighter|fridge|freezer|scale)\b/i },
  { cat: 'Uniform',          re: /\b(t-shirt|tshirt|apron|cap( |$)|hair net|beard net|arm sleeve|uniform|coat)\b/i },
  { cat: 'Cleaning',         re: /\b(cleaner|soap|sanitizer|sanitiser|detergent|degreaser|ecoshine|oasis|food saf|vanoquad|solitare|dishwash|hydrion|scoring pad)\b/i },
  { cat: 'Beverage',         re: /\b(7up|7 up|pepsi|mirinda|mountain dew|cetrus|coke|sprite|fanta|juice|lipton|aqua|tropicana|water 20|water aqua)\b/i },
  { cat: 'Tool',             re: /\b(opener|cutter|timer|thermometer|pan cover|pan (?:large|medium|small)|ring|tongs?|ladle|spatula|spoon|scoop|gripper|scrapper|board|tray|measuring cup|shovel|showel|plier|screwdriver|wiper|brush|broom|bin|bucket|mop|dispenser|basket|screen|stand|spray bottle|peel|server|sieve|whisk|knife|pi(?:e)? server|dust pan|glove|flycatcher)\b/i },
  { cat: 'Packing Material', re: /\b(bag|box|container|foil|paper|wrap|plastic roll|plastic spoon|sticker|inliner|flyer|napkin|thermal roll|cashier roll|tissue|roll \(|packaging|pouch|sleeve|cling|carton|label|cup ?\&|solo cup|bottles? \(sauce)\b/i },
];

function classifyCategory(name, families, erpCode) {
  // 1) ERP prefix wins when we have a real ERP code (letter-prefixed)
  if (erpCode && /^[A-Za-z]/.test(String(erpCode))) {
    const s4 = String(erpCode).substr(0, 4).toUpperCase();
    if (ERP_PREFIX_CATEGORIES[s4]) return ERP_PREFIX_CATEGORIES[s4];
    const s2 = s4.substr(0, 2);
    if (ERP_PREFIX2_NONFOOD[s2]) return ERP_PREFIX2_NONFOOD[s2];
  }
  // 2) Name keyword fallback (for POS-only items without an ERP code)
  const n = String(name || '');
  for (const rule of NAME_KEYWORD_RULES) { if (rule.re.test(n)) return rule.cat; }
  // 3) POS family fallback — first real food family wins
  const fams = Array.isArray(families) ? families : [];
  const firstFood = fams.find(f => f && f !== 'Non-food');
  if (firstFood) {
    const foodMap = { 'Sauces': 'Sauce', 'Toppings': 'Topping', 'Side Dishes': 'Side Dish', 'Crusts': 'Crust', 'Beverages': 'Beverage' };
    return foodMap[firstFood] || firstFood;
  }
  if (fams.indexOf('Non-food') > -1) return 'Packing Material';
  return 'Food';
}

// GET /api/ingredients/from-pos — distinct items used in POS recipes (food + packaging only),
// each joined to v_inventory_items export_id + latest EBS cost
app.get('/api/ingredients/from-pos', requireAuth, async (req, res) => {
  try {
    // Pull distinct (inv_item_id, family) pairs from v_recipes (template branch only).
    // Exclusions:
    //  - finished goods (FG* prefix) — sale items, not ingredients
    //  - sub-recipe stages (inv_item_id ending in 'R' per POS naming convention)
    //  - explicit placeholders containing FAKE
    //  - inv_item_ids that themselves have an ingredient BOM (i.e. they're composite recipes, not raw items)
    const r = await queryGateway('RedShift', `
      SELECT DISTINCT r.inv_item_id, r.inv_item_description, r.sale_item_family_group
      FROM maestroksa.v_recipes r
      WHERE r.branch_id = -1
        AND r.inv_item_description IS NOT NULL
        AND TRIM(r.inv_item_description) <> ''
        AND r.inv_item_id NOT LIKE 'FG%'
        AND r.inv_item_id NOT LIKE '%R'
        AND UPPER(r.inv_item_description) NOT LIKE '%FAKE%'
        AND r.inv_item_id NOT IN (
          SELECT sale_item_id
          FROM maestroksa.v_recipes
          WHERE branch_id = -1
          GROUP BY sale_item_id
          HAVING COUNT(DISTINCT inv_item_id) > 1
             OR MAX(CASE WHEN sale_item_id <> inv_item_id THEN 1 ELSE 0 END) = 1
        )
    `);
    // Aggregate by inv_item_id: collect families + pick any description
    const agg = {};
    for (const row of (r.rows || [])) {
      const id = String(row.inv_item_id);
      if (!agg[id]) agg[id] = { name: row.inv_item_description, families: new Set() };
      if (row.sale_item_family_group) agg[id].families.add(row.sale_item_family_group);
    }
    const items = Object.keys(agg).map(invId => {
      const a = agg[invId];
      const map = db.getItemMap(invId);
      const erpCode = map && map.export_id ? map.export_id : null;
      let latest = null;
      if (erpCode) {
        const hist = db.getPriceHistory(erpCode);
        const mat = hist.find(h => (h.cost_component_class || 'MATERIAL') === 'MATERIAL');
        if (mat) latest = mat;
      }
      // Normalise EBS cost (per stockroom UOM) → recipe-unit price using v_inventory_items equivalence
      const p = latest
        ? priceForRecipe(latest.accounting_cost, latest.uom, map && map.recipe_unit, map && map.equivalence)
        : null;
      const famsArr = Array.from(a.families);
      return {
        invItemId: invId,
        name: a.name,
        families: famsArr,
        category: classifyCategory(a.name, famsArr, erpCode),
        erpCode,
        recipeUnit: map ? map.recipe_unit : null,
        stockroomUnit: map ? map.stockroom_unit : null,
        equivalence: map ? map.equivalence : null,
        latestCost: latest ? {
          periodCode: latest.period_code,
          organizationCode: latest.organization_code,
          stockroomCost: latest.accounting_cost,  // raw EBS price per stockroom UOM
          stockroomUom: latest.uom,
          costPerRecipeUnit: p ? p.costPerRecipeUnit : null,  // price normalised to recipe UOM
          recipeUnit: p ? p.recipeUnit : null,
          pricePerKg: p ? p.pricePerKg : null,
          pricePerPiece: p ? p.pricePerPiece : null,
          // Back-compat field name still used by some callers:
          accountingCost: latest.accounting_cost,
          uom: latest.uom,
        } : null,
      };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json({
      count: items.length,
      source: 'maestroksa.v_recipes (branch_id=-1) + ebs_item_map + ebs_cost_history',
      items,
    });
  } catch (err) {
    console.error('ingredients/from-pos error:', err);
    res.status(500).json({ error: 'Failed: ' + err.message });
  }
});

// GET /api/pos-recipe/:saleItemId — full BOM from v_recipes with EBS pricing joined via export_id
app.get('/api/pos-recipe/:saleItemId', requireAuth, async (req, res) => {
  try {
    const raw = String(req.params.saleItemId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
    if (!raw) return res.status(400).json({ error: 'saleItemId required' });
    // Template BOM (branch_id = -1)
    const bom = await queryGateway('RedShift', `
      SELECT sale_item_id, sale_item_description, sale_item_family_group, line_nbr,
             inv_item_id, inv_item_description, quantity, recipe_unit, optional, order_type, charged, yield
      FROM maestroksa.v_recipes
      WHERE sale_item_id = '${raw}' AND branch_id = -1
      ORDER BY line_nbr, inv_item_id
    `);
    const lines = (bom.rows || []).map(r => {
      const map = db.getItemMap(String(r.inv_item_id));
      let price = null;
      if (map && map.export_id) {
        const hist = db.getPriceHistory(map.export_id);
        const latest = hist && hist.length ? hist[0] : null;
        if (latest) {
          const p = priceForRecipe(latest.accounting_cost, latest.uom, map.recipe_unit, map.equivalence);
          price = {
            itemNumber: map.export_id,
            itemDesc: latest.item_desc,
            uom: latest.uom,
            periodCode: latest.period_code,
            stockroomCost: latest.accounting_cost,
            costPerRecipeUnit: p.costPerRecipeUnit,
            recipeUnit: p.recipeUnit,
            pricePerKg: p.pricePerKg,
            pricePerPiece: p.pricePerPiece,
            // Back-compat:
            accountingCost: latest.accounting_cost,
          };
        }
      }
      return {
        line: r.line_nbr,
        posInvItemId: r.inv_item_id,
        name: r.inv_item_description,
        quantity: r.quantity,
        recipeUnit: r.recipe_unit,
        optional: r.optional === 'Y',
        orderType: r.order_type,
        yield: r.yield,
        saleItem: { id: r.sale_item_id, name: r.sale_item_description, family: r.sale_item_family_group },
        erpMap: map ? { exportId: map.export_id, equivalence: map.equivalence, stockroomUnit: map.stockroom_unit } : null,
        price,
      };
    });
    res.json({ saleItemId: raw, count: lines.length, lines });
  } catch (err) {
    console.error('pos-recipe error:', err);
    res.status(500).json({ error: 'Failed to fetch BOM: ' + err.message });
  }
});

// ── WORKFLOW NOTIFICATIONS ──

// POST /api/notify — send workflow notification
app.post('/api/notify', requireAuth, (req, res) => {
  try {
    const { event, recipe, build, run, user, ingredients: incomingIngredients, batchSize } = req.body;
    if (!event) return res.status(400).json({ error: 'event required' });

    const userName = user || 'Someone';
    let subject, html, recipients;

    // Resolve ingredient codes server-side from app_state.ingredients (Oracle pattern only).
    // The client may post with empty/wrong codes if its ING_DATA is stale — server is authoritative.
    const oraclePat = /^[A-Z]{2,}\d+$/;
    const _ingDb = ((db.getState() || {}).data || {}).ingredients || [];
    const _nameToCode = {};
    for (const row of _ingDb) {
      if (!Array.isArray(row) || row.length < 4) continue;
      const code = String(row[3] || '').trim();
      if (!oraclePat.test(code)) continue;
      const nm = String(row[1] || '').toLowerCase().trim();
      if (nm && !_nameToCode[nm]) _nameToCode[nm] = code;
    }
    const ingredients = Array.isArray(incomingIngredients)
      ? incomingIngredients.map(i => {
          const nm = String(i && i.name || '').toLowerCase().trim();
          const stored = String(i && i.itemCode || '').trim();
          // Trust client only if it's an Oracle code; else look up server-side.
          const code = oraclePat.test(stored) ? stored : (_nameToCode[nm] || '');
          return { name: i.name || '', pct: Number(i.pct || 0), itemCode: code };
        })
      : null;

    // Build a Purchasing-focused HTML block listing ingredients + estimated kg per batch.
    // Used by the Factory Trial and Production Trial notifications. Trims to top 20 entries.
    const ingredientsBlock = (() => {
      if (!Array.isArray(ingredients) || !ingredients.length) return '';
      const batchKg = (() => {
        const m = (batchSize || '').match(/(\d+(?:\.\d+)?)/);
        return m ? parseFloat(m[1]) : null;
      })();
      const escape = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      // Oracle EBS codes only — POS numeric codes are masked. Defends against stale clients.
      const oraclePat = /^[A-Z]{2,}\d+$/;
      const rows = ingredients.map(i => {
        const pct = Number(i.pct || 0);
        const kg = batchKg ? (batchKg * pct / 100).toFixed(2) : null;
        const rawCode = String(i.itemCode || '').trim();
        const code = oraclePat.test(rawCode) ? rawCode : '';
        return `<tr>
          <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:12px">${escape(i.name)}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:11px;font-family:monospace;color:#666">${code ? escape(code) : '—'}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:12px;text-align:right;font-family:monospace">${pct.toFixed(2)}%</td>
          ${kg !== null ? `<td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:12px;text-align:right;font-family:monospace;color:#1A5FA5;font-weight:600">${kg} kg</td>` : ''}
        </tr>`;
      }).join('');
      // Tailor the headline + note per stage:
      //   factory-trial → "may still change" warning
      //   prod-trial    → no warning (formula stable)
      //   approved      → "final approved formulation" headline, no warning
      const isApproved = event === 'recipe-approved';
      const formulaLockNote = event === 'recipe-factory-trial'
        ? `<div style="font-size:11px;color:#8a4500;margin-bottom:10px;padding:6px 10px;background:rgba(255,255,255,0.6);border-left:3px solid #d47000;border-radius:4px"><strong>⚠ Note:</strong> Ingredients are not definitive until Production Trial. The formula may change between Factory Trial and Prod Trial.</div>`
        : (isApproved
          ? `<div style="font-size:11px;color:#1F4811;margin-bottom:10px;padding:6px 10px;background:rgba(255,255,255,0.6);border-left:3px solid #2D6A4F;border-radius:4px"><strong>✅ Final formulation:</strong> this is the approved recipe locked in for production. Use this as the source of truth for procurement, costing, and quality records.</div>`
          : '');
      const blockBg = isApproved ? '#EBF5EE' : '#FEF3E2';
      const blockBorder = isApproved ? '#C8E6C9' : '#F5D5A0';
      const blockTitleColor = isApproved ? '#2D6A4F' : '#8a4500';
      const blockTitle = isApproved ? '📋 Final approved formulation' : '📦 Purchasing — ingredients to procure';
      const batchNote = isApproved
        ? (batchKg ? `Reference batch size on the recipe: <strong>${batchKg} kg</strong>. Per-run weights scale from this %.` : 'Per-run quantities scale from the % column.')
        : (batchKg ? `<strong>Estimate only:</strong> figures below assume a ${batchKg} kg batch. Confirm the real numbers once the run is on the Production Plan.` : 'Approximate quantities pending batch size — confirm once Production Plan is defined.');
      return `
        <div style="margin-top:18px;padding:14px 16px;background:${blockBg};border:1px solid ${blockBorder};border-radius:8px">
          <div style="font-size:13px;font-weight:600;color:${blockTitleColor};margin-bottom:8px">${blockTitle}</div>
          <div style="font-size:11px;color:${blockTitleColor};margin-bottom:10px">${batchNote}</div>
          ${formulaLockNote}
          <table style="width:100%;border-collapse:collapse;background:white;border-radius:6px;overflow:hidden">
            <thead><tr>
              <th style="padding:6px 8px;background:#fcfaf5;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#8a4500;text-align:left;border-bottom:1.5px solid #F5D5A0">Ingredient</th>
              <th style="padding:6px 8px;background:#fcfaf5;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#8a4500;text-align:left;border-bottom:1.5px solid #F5D5A0">EBS Code</th>
              <th style="padding:6px 8px;background:#fcfaf5;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#8a4500;text-align:right;border-bottom:1.5px solid #F5D5A0">%</th>
              ${batchKg ? `<th style=\"padding:6px 8px;background:#fcfaf5;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#8a4500;text-align:right;border-bottom:1.5px solid #F5D5A0\">Est. kg</th>` : ''}
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    })();

    switch (event) {
      case 'recipe-review':
        recipients = getEmailsByRole(['npd']);
        subject = `Recipe sent for review: ${recipe}`;
        html = `<h2 style="color:#1B2A4A;margin:0 0 12px">${recipe}</h2>
          <p><strong>${userName}</strong> sent this recipe for review.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#B8820A;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open RecipeHub</a></p>`;
        break;

      case 'recipe-factory-trial':
        recipients = getEmailsByRole(['npd', 'factory', 'qa', 'purchasing']);
        subject = `Factory Trial requested: ${recipe}`;
        html = `<h2 style="color:#1B2A4A;margin:0 0 12px">${recipe}</h2>
          <p><strong>${userName}</strong> sent this recipe to <span style="color:#1A5FA5;font-weight:600">Factory Trial</span>.</p>
          <p>A production run has been created. Factory — please schedule a date. Purchasing — please confirm ingredient availability.</p>
          ${ingredientsBlock}
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#1A5FA5;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">View Production Plan</a></p>`;
        break;

      case 'recipe-prod-trial':
        recipients = getEmailsByRole(['npd', 'factory', 'qa', 'purchasing']);
        subject = `Production Trial requested: ${recipe}`;
        html = `<h2 style="color:#1B2A4A;margin:0 0 12px">${recipe}</h2>
          <p><strong>${userName}</strong> sent this recipe to <span style="color:#6B2FA0;font-weight:600">Production Trial</span>.</p>
          <p>QA sign-off was completed. A production run has been created. Purchasing — full-scale batch, please plan procurement.</p>
          ${ingredientsBlock}
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#6B2FA0;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open RecipeHub</a></p>`;
        break;

      case 'recipe-approved':
        recipients = getEmailsByRole(['npd', 'qa', 'factory', 'purchasing']);
        subject = `Recipe APPROVED: ${recipe}`;
        html = `<h2 style="color:#2D6A4F;margin:0 0 12px">${recipe} ✅</h2>
          <p><strong>${userName}</strong> approved this recipe for production.</p>
          <p style="background:#EBF5EE;padding:12px 16px;border-radius:6px;color:#2D6A4F;font-weight:500">This recipe is now cleared for full-scale production.</p>
          ${ingredientsBlock}
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#2D6A4F;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">View Recipe</a></p>`;
        break;

      case 'qa-signoff': {
        recipients = getEmailsByRole(['npd', 'qa', 'factory', 'purchasing']);
        const stageLabel = (req.body.stage === 'prod-trial' || req.body.stage === 'prodQA')
          ? 'Production Trial'
          : (req.body.stage === 'trial' || req.body.stage === 'trialQA')
            ? 'Factory Trial'
            : 'this stage';
        const conditional = !!req.body.conditional;
        const conditions = req.body.conditions || '';
        subject = `QA sign-off — ${recipe}${conditional ? ' (with conditions)' : ''}`;
        html = `<h2 style="color:#1B2A4A;margin:0 0 12px">${recipe}</h2>
          <p><strong>${userName}</strong> completed <strong>${stageLabel}</strong> QA sign-off${conditional ? ' <span style="color:#8a4500">(approved with conditions)</span>' : ''}.</p>
          ${conditional && conditions ? `<p style="background:#FEF3E2;padding:10px 14px;border-left:3px solid #d47000;border-radius:4px;font-size:13px"><strong>Conditions / corrective actions:</strong> ${String(conditions).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</p>` : ''}
          <p>R&D can move the recipe to the next stage. QA, Factory, Purchasing — heads-up.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#B8820A;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open RecipeHub</a></p>`;
        break;
      }

      case 'qa-bypass': {
        recipients = getEmailsByRole(['npd', 'qa', 'factory', 'purchasing']);
        const stageLabel = (req.body.stage === 'prod-trial' || req.body.stage === 'prodQA')
          ? 'Production Trial'
          : (req.body.stage === 'trial' || req.body.stage === 'trialQA')
            ? 'Factory Trial'
            : 'this stage';
        const reason = req.body.reason || '(no reason given)';
        const escapedReason = String(reason).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
        subject = `⚡ QA bypass — ${recipe} (${stageLabel})`;
        html = `<h2 style="color:#8a4500;margin:0 0 12px">⚡ QA bypass on ${recipe}</h2>
          <p><strong>${userName}</strong> bypassed the <strong>${stageLabel}</strong> QA sign-off without QA signature.</p>
          <p style="background:#FEF3E2;padding:10px 14px;border-left:3px solid #d47000;border-radius:4px;font-size:13px"><strong>Reason on record:</strong> ${escapedReason}</p>
          <p>This bypass is auditable. The recipe can move to the next stage; QA, Factory, Purchasing — review the reason and raise an objection now if the move shouldn't stand.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#B8820A;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open RecipeHub</a></p>`;
        break;
      }

      case 'run-scheduled': {
        recipients = getEmailsByRole(['npd', 'qa', 'purchasing']);
        const r2 = req.body.run || {};
        const dateStr = r2.date || '—';
        const timeStr = r2.time ? ` at <strong>${r2.time}</strong>` : '';
        const batchStr = r2.batchSize ? r2.batchSize : '—';
        const runType = r2.runType || 'Production';
        subject = `Production run scheduled: ${recipe} · ${dateStr}${r2.time ? ' ' + r2.time : ''}`;
        html = `<h2 style="color:#1B2A4A;margin:0 0 12px">${recipe}</h2>
          <p><strong>${userName}</strong> scheduled a <strong>${runType}</strong> run.</p>
          <table style="border-collapse:collapse;margin:12px 0;font-size:13px">
            <tr><td style="padding:6px 12px;color:#666">Date</td><td style="padding:6px 12px;font-weight:600"><strong>${dateStr}</strong>${timeStr}</td></tr>
            <tr><td style="padding:6px 12px;color:#666">Batch size</td><td style="padding:6px 12px">${batchStr}</td></tr>
            <tr><td style="padding:6px 12px;color:#666">Type</td><td style="padding:6px 12px">${runType}</td></tr>
          </table>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#1B2A4A;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">View Production Plan</a></p>`;
        break;
      }

      case 'run-completed':
        recipients = getEmailsByRole(['npd', 'qa']);
        subject = `Production run completed: ${recipe}`;
        html = `<h2 style="color:#2D6A4F;margin:0 0 12px">${recipe}</h2>
          <p><strong>${userName}</strong> completed a production run.</p>
          <p>QA results and yield data are ready for review.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#2D6A4F;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open RecipeHub</a></p>`;
        break;

      case 'run-blocked': {
        // Factory flagged a Trial run as blocked because raw materials are missing.
        // Reach all four teams so Purchasing acts and R&D / QA know the timeline slips.
        recipients = getEmailsByRole(['npd', 'qa', 'factory', 'purchasing']);
        const r3 = req.body.run || {};
        const runType = r3.runType || 'Trial';
        const dateStr = r3.date || '—';
        const note = req.body.note || '';
        const escape = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        const missing = Array.isArray(req.body.missingIngredients) ? req.body.missingIngredients : [];
        const missingRows = missing.map(m => `<tr>
          <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:12px">${escape(m.name)}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #eee;font-size:11px;font-family:monospace;color:#666">${escape(m.itemCode || '—')}</td>
        </tr>`).join('');
        const missingBlock = missing.length ? `
          <div style="margin-top:14px;padding:14px 16px;background:#FCE7E5;border:1px solid #F5B5B0;border-radius:8px">
            <div style="font-size:13px;font-weight:600;color:#8C1A1A;margin-bottom:8px">📦 Missing materials</div>
            <table style="width:100%;border-collapse:collapse;background:white;border-radius:6px;overflow:hidden">
              <thead><tr>
                <th style="padding:6px 8px;background:#fef2f2;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#8C1A1A;text-align:left;border-bottom:1.5px solid #F5B5B0">Ingredient</th>
                <th style="padding:6px 8px;background:#fef2f2;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#8C1A1A;text-align:left;border-bottom:1.5px solid #F5B5B0">EBS Code</th>
              </tr></thead>
              <tbody>${missingRows}</tbody>
            </table>
          </div>` : '';
        subject = `📦 ${runType} needs RM: ${recipe}`;
        html = `<h2 style="color:#8A4500;margin:0 0 12px">📦 ${recipe} — ${runType} needs RM</h2>
          <p><strong>${userName}</strong> (Factory) flagged this run as needing raw materials. The trial will proceed once the materials below are received.</p>
          <table style="border-collapse:collapse;margin:12px 0;font-size:13px">
            <tr><td style="padding:6px 12px;color:#666">Scheduled date</td><td style="padding:6px 12px;font-weight:600">${escape(dateStr)}${r3.time ? ' ' + escape(r3.time) : ''}</td></tr>
            <tr><td style="padding:6px 12px;color:#666">Run type</td><td style="padding:6px 12px">${escape(runType)}</td></tr>
          </table>
          ${missingBlock}
          ${note ? `<p style="margin-top:14px;background:#FFF8E0;padding:10px 14px;border-left:3px solid #d47000;border-radius:4px;font-size:13px"><strong>Factory note:</strong> ${escape(note)}</p>` : ''}
          <p style="margin-top:16px"><strong>Purchasing</strong> — please escalate procurement. <strong>Factory</strong> will mark the run unblocked once materials are physically on the line.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#8A4500;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">View Production Plan</a></p>`;
        break;
      }

      case 'run-unblocked': {
        recipients = getEmailsByRole(['npd', 'qa', 'factory', 'purchasing']);
        const r4 = req.body.run || {};
        const runType = r4.runType || 'Trial';
        const dateStr = r4.date || '—';
        const note = req.body.note || '';
        const escape = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        subject = `✓ ${runType} materials in — ${recipe}`;
        html = `<h2 style="color:#2D6A4F;margin:0 0 12px">✓ ${recipe} — materials in</h2>
          <p><strong>${userName}</strong> (Factory) confirmed materials are in. The run is back on schedule.</p>
          <table style="border-collapse:collapse;margin:12px 0;font-size:13px">
            <tr><td style="padding:6px 12px;color:#666">Scheduled date</td><td style="padding:6px 12px;font-weight:600">${escape(dateStr)}${r4.time ? ' ' + escape(r4.time) : ''}</td></tr>
            <tr><td style="padding:6px 12px;color:#666">Run type</td><td style="padding:6px 12px">${escape(runType)}</td></tr>
          </table>
          ${note ? `<p style="background:#EBF5EE;padding:10px 14px;border-left:3px solid #2D6A4F;border-radius:4px;font-size:13px">${escape(note)}</p>` : ''}
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#2D6A4F;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">View Production Plan</a></p>`;
        break;
      }

      case 'sub-created': {
        recipients = getEmailsByRole(['npd', 'qa', 'factory']);
        const sub = req.body.sub || {};
        const reason = sub.reason || '—';
        const detail = sub.reasonDetail || '';
        const affectedN = (sub.affectedRecipes || []).length;
        const delta = sub.costImpact;
        const deltaStr = (delta == null) ? '—' : `${delta >= 0 ? '+' : ''}${Number(delta).toFixed(2)} SAR`;
        subject = `Substitution request: ${sub.currentName || '?'} → ${sub.proposedName || '?'}`;
        html = `<h2 style="color:#1B2A4A;margin:0 0 12px">Ingredient substitution request</h2>
          <p><strong>${userName}</strong> (Purchasing) raised a request to swap an ingredient.</p>
          <table style="border-collapse:collapse;margin:12px 0">
            <tr><td style="padding:6px 12px;font-size:12px;color:#666">Current</td><td style="padding:6px 12px;font-size:13px;font-weight:600">${sub.currentName||''} <span style="font-family:monospace;color:#999">(${sub.currentCode||''})</span></td></tr>
            <tr><td style="padding:6px 12px;font-size:12px;color:#666">Proposed</td><td style="padding:6px 12px;font-size:13px;font-weight:600">${sub.proposedName||''} <span style="font-family:monospace;color:#999">(${sub.proposedCode||''})</span></td></tr>
            <tr><td style="padding:6px 12px;font-size:12px;color:#666">Reason</td><td style="padding:6px 12px;font-size:13px">${reason}${detail ? ' — ' + detail : ''}</td></tr>
            <tr><td style="padding:6px 12px;font-size:12px;color:#666">Affected recipes</td><td style="padding:6px 12px;font-size:13px">${affectedN}</td></tr>
            <tr><td style="padding:6px 12px;font-size:12px;color:#666">Cost delta</td><td style="padding:6px 12px;font-size:13px">${deltaStr}</td></tr>
          </table>
          <p style="background:#FEF3E2;padding:10px 14px;border-left:3px solid #d47000;border-radius:4px;font-size:13px">QA — lab retest is required before this can be approved.</p>
          <p>R&D, QA, and Factory each need to sign off in the Substitutions page.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#B8820A;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open Substitutions</a></p>`;
        break;
      }

      case 'sub-rd-approved': {
        // R&D done; QA's turn (lab retest)
        recipients = getEmailsByRole(['qa', 'purchasing']);
        const sub = req.body.sub || {};
        subject = `Your turn (QA): ${sub.currentName || '?'} → ${sub.proposedName || '?'}`;
        html = `<h2 style="color:#1B2A4A;margin:0 0 12px">R&D approved — QA, your turn</h2>
          <p><strong>${userName}</strong> (R&D) confirmed the formulation fit.</p>
          <p><strong>${sub.currentName||''}</strong> → <strong>${sub.proposedName||''}</strong></p>
          <p style="background:#FEF3E2;padding:10px 14px;border-left:3px solid #d47000;border-radius:4px;font-size:13px"><strong>QA action required:</strong> run the lab retest (allergens, shelf life, micro), then sign off on the request.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#B8820A;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open Substitutions</a></p>`;
        break;
      }

      case 'sub-qa-approved': {
        // QA done; Factory's turn (sign-off)
        recipients = getEmailsByRole(['factory', 'purchasing']);
        const sub = req.body.sub || {};
        subject = `Your turn (Factory sign-off): ${sub.currentName || '?'} → ${sub.proposedName || '?'}`;
        html = `<h2 style="color:#1B2A4A;margin:0 0 12px">QA cleared — Factory, your sign-off</h2>
          <p><strong>${userName}</strong> (QA) signed off after the lab retest.</p>
          <p><strong>${sub.currentName||''}</strong> → <strong>${sub.proposedName||''}</strong></p>
          <p>Factory — confirm any production-line constraints and sign off to close the loop.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#B8820A;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open Substitutions</a></p>`;
        break;
      }

      case 'sub-approved': {
        // Final state — Factory sign-off completes the chain
        recipients = getEmailsByRole(['npd', 'qa', 'factory', 'purchasing']);
        const sub = req.body.sub || {};
        subject = `Substitution APPROVED: ${sub.currentName || '?'} → ${sub.proposedName || '?'}`;
        html = `<h2 style="color:#2D6A4F;margin:0 0 12px">Substitution approved ✅</h2>
          <p>All three sign-offs (R&D → QA → Factory) are in. The swap is cleared.</p>
          <p><strong>${sub.currentName||''}</strong> → <strong>${sub.proposedName||''}</strong></p>
          <p>R&D — please rewire affected recipes and mark the request as <em>Implemented</em> when done.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#2D6A4F;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open Substitutions</a></p>`;
        break;
      }

      case 'sub-rejected': {
        recipients = getEmailsByRole(['purchasing']);
        const sub = req.body.sub || {};
        const rej = sub.rejection || {};
        subject = `Substitution rejected: ${sub.currentName || '?'} → ${sub.proposedName || '?'}`;
        html = `<h2 style="color:#C0392B;margin:0 0 12px">Substitution rejected</h2>
          <p><strong>${rej.byName || rej.by || '?'}</strong> (${rej.role || '?'}) rejected the request.</p>
          <p><strong>${sub.currentName||''}</strong> → <strong>${sub.proposedName||''}</strong></p>
          ${rej.reason ? `<p style="background:#FCE7E5;padding:10px 14px;border-radius:4px;font-size:13px"><strong>Reason:</strong> ${rej.reason}</p>` : ''}
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#1B2A4A;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open Substitutions</a></p>`;
        break;
      }

      case 'flag-mention': {
        // A user @-mentioned others in a flag note. req.body fields:
        //   mentions: [email, …]     — addresses parsed out of the flag text
        //   flagText:  string         — the full note
        //   entity:   'recipe' | 'factory-sop' | 'branch-sop'
        //   subject:  string          — what was flagged (recipe name / SOP id / …)
        //   link:     URL fragment    — where to land the user in the app
        //   askedBy:  display name
        const mentions = Array.isArray(req.body.mentions) ? req.body.mentions : [];
        if (!mentions.length) return res.json({ ok: true, sent: false, reason: 'No @mentions' });
        recipients = mentions.filter(e => typeof e === 'string' && e.includes('@'));
        const flagText = String(req.body.flagText || '');
        const subjectThing = String(req.body.subject || '(no subject)');
        const entityLabel = ({recipe:'Recipe', 'factory-sop':'Factory SOP', 'branch-sop':'Branch SOP'})[req.body.entity] || 'Item';
        const link = String(req.body.link || 'https://recipehub.dailyfoodsa.com');
        const askedBy = String(req.body.askedBy || userName);
        const escape = (s) => String(s||'').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
        subject = `🚩 ${askedBy} mentioned you on ${entityLabel}: ${subjectThing}`;
        html = `<h2 style="color:#D4700A;margin:0 0 12px">🚩 You were mentioned in a flag</h2>
          <p><strong>${escape(askedBy)}</strong> flagged <strong>${escape(entityLabel)}: ${escape(subjectThing)}</strong> and mentioned you.</p>
          <div style="margin:12px 0;padding:14px 16px;background:#FFF6E5;border-left:4px solid #D4700A;border-radius:4px;font-size:14px;color:#1B2A4A;white-space:pre-wrap">${escape(flagText)}</div>
          <p style="margin-top:16px"><a href="${escape(link)}" style="background:#D4700A;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open in RecipeHub</a></p>
          <p style="font-size:11px;color:#888;margin-top:18px">You're getting this because <code>@${escape((mentions[0]||'').split('@')[0])}</code> appeared in the flag text. Reply directly to the sender to discuss.</p>`;
        break;
      }

      case 'sub-implemented': {
        recipients = getEmailsByRole(['purchasing', 'qa', 'factory']);
        const sub = req.body.sub || {};
        subject = `Substitution implemented: ${sub.currentName || '?'} → ${sub.proposedName || '?'}`;
        html = `<h2 style="color:#2D6A4F;margin:0 0 12px">Substitution implemented</h2>
          <p>R&D has rewired the affected recipes to use the new ingredient.</p>
          <p><strong>${sub.currentName||''}</strong> → <strong>${sub.proposedName||''}</strong></p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#2D6A4F;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open RecipeHub</a></p>`;
        break;
      }

      default:
        return res.json({ ok: true, sent: false, reason: 'Unknown event' });
    }

    if (recipients && recipients.length) {
      sendNotification(recipients, subject, html);
      res.json({ ok: true, sent: true, to: recipients.length + ' recipients' });
    } else {
      res.json({ ok: true, sent: false, reason: 'No recipients for this role' });
    }
  } catch (err) {
    console.error('Notify error:', err);
    res.status(500).json({ error: 'Failed to send notification: ' + err.message });
  }
});

// ── DOCUMENT LIBRARY ──
const fs = require('fs');
const DOCS_DIR = '/var/www/recipehub/docs';
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

// General image upload — saves to /docs/img/ and returns URL
const IMG_DIR = '/var/www/recipehub/docs/img';
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

app.post('/api/img/upload', requireAuth, (req, res) => {
  try {
    const { key, data } = req.body;
    if (!key || !data) return res.status(400).json({ error: 'key and data required' });
    const matches = data.match(/^data:(image\/(jpeg|png|gif|webp));base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Invalid image — only JPEG, PNG, GIF, WebP allowed' });
    const buffer = Buffer.from(matches[3], 'base64');
    if (buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Image too large — max 5MB' });
    // Append timestamp so every upload gets a fresh URL — otherwise overwriting the same
    // filename returns the same URL and the browser shows the cached (old) image.
    const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeName = safeKey + '-' + Date.now() + '.jpg';
    fs.writeFileSync(IMG_DIR + '/' + safeName, buffer);
    // Clean up older files with the same key prefix (keep last 3 revisions so rollback/merge
    // still works if a stale client pushes an old URL)
    try {
      const all = fs.readdirSync(IMG_DIR).filter(f => f.startsWith(safeKey + '-') && f.endsWith('.jpg'));
      all.sort();
      if (all.length > 3) {
        all.slice(0, all.length - 3).forEach(f => { try { fs.unlinkSync(IMG_DIR + '/' + f); } catch (e) {} });
      }
    } catch (e) { /* non-fatal */ }
    res.json({ ok: true, url: '/docs/img/' + safeName });
  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// ── QA media upload (photos / videos / files attached to QA Lab Results per recipe) ──
const QA_MEDIA_DIR = '/var/www/recipehub/docs/qa-media';
if (!fs.existsSync(QA_MEDIA_DIR)) fs.mkdirSync(QA_MEDIA_DIR, { recursive: true });

// 70 MB JSON body to fit a 50 MB binary as base64 (~67 MB on the wire).
const qaMediaJson = express.json({ limit: '70mb' });

app.post('/api/qa/media/upload', qaMediaJson, requireAuth, (req, res) => {
  try {
    const { key, data } = req.body;
    if (!key || !data) return res.status(400).json({ error: 'key and data required' });
    const matches = data.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Invalid data URL' });
    const mime = matches[1];
    const allowed = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
      'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
      'application/pdf': 'pdf',
    };
    if (!(mime in allowed)) return res.status(400).json({ error: 'MIME not allowed: ' + mime });
    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 50 * 1024 * 1024) return res.status(400).json({ error: 'Media too large — max 50MB' });
    const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeName = safeKey + '-' + Date.now() + '.' + allowed[mime];
    fs.writeFileSync(QA_MEDIA_DIR + '/' + safeName, buffer);
    res.json({ ok: true, url: '/docs/qa-media/' + safeName, mime, bytes: buffer.length });
  } catch (err) {
    console.error('QA media upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

app.post('/api/library/upload', requireAuth, (req, res) => {
  try {
    const { id, fileName, data } = req.body;
    if (!id || !fileName || !data) return res.status(400).json({ error: 'id, fileName, data required' });
    // data is a base64 data URL
    const matches = data.match(/^data:(.+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Invalid file data' });
    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'File too large — max 10MB' });
    const ext = fileName.split('.').pop().toLowerCase();
    const ALLOWED_EXTS = ['pdf','doc','docx','xls','xlsx','csv','txt','jpg','jpeg','png','gif'];
    if (!ALLOWED_EXTS.includes(ext)) return res.status(400).json({ error: 'File type not allowed' });
    const safeName = id.replace(/[^a-zA-Z0-9._-]/g, '_') + '.' + ext;
    fs.writeFileSync(DOCS_DIR + '/' + safeName, buffer);
    res.json({ ok: true, url: '/docs/' + safeName });
  } catch (err) {
    console.error('Library upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// ── COMMUNICATIONS ──

// POST /api/comms/send — send email to recipients
// Sanitize HTML to prevent injection in emails
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

app.post('/api/comms/send', requireAuth, (req, res) => {
  try {
    const { to, subject, html, sentBy } = req.body;
    if (!to || !to.length || !subject) {
      return res.status(400).json({ error: 'to and subject required' });
    }
    const recipients = Array.isArray(to) ? to : [to];
    const safeSubject = escHtml(subject);
    // html is built by the authenticated frontend (sendCommsMessage in RecipeHub-App-v2.html)
    // and already contains safe HTML (<p>, <br>, optional <a>). Do not double-escape.
    const safeBody = String(html || '');
    const safeSentBy = escHtml(sentBy || 'Admin');
    const fullHtml = `<h2 style="color:#1B2A4A;margin:0 0 12px">${safeSubject}</h2>
      <div style="font-size:14px;line-height:1.6;color:#333">${safeBody}</div>
      <hr style="border:none;border-top:1px solid #E8E6E1;margin:20px 0" />
      <p style="font-size:11px;color:#999">Sent by ${safeSentBy} via <a href="https://recipehub.dailyfoodsa.com">RecipeHub</a></p>`;

    sendNotification(recipients, subject, fullHtml);
    res.json({ ok: true, sent: recipients.length });
  } catch (err) {
    console.error('Comms send error:', err);
    res.status(500).json({ error: 'Failed to send: ' + err.message });
  }
});

// ── NUTRITION API (USDA FoodData Central) ──

// GET /api/nutrition/search?q=tomato — search USDA for nutritional data
app.get('/api/nutrition/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ results: [] });

    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(q)}&pageSize=8&dataType=Foundation,SR%20Legacy&api_key=${USDA_API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!data.foods || !data.foods.length) return res.json({ results: [] });

    const results = data.foods.map(food => {
      const nut = {};
      (food.foodNutrients || []).forEach(n => {
        const name = (n.nutrientName || '').toLowerCase();
        const val = n.value || 0;
        if (name.includes('energy') && (n.unitName === 'KCAL' || name.includes('kcal'))) nut.energy = val;
        else if (name === 'protein') nut.protein = val;
        else if (name === 'total lipid (fat)') nut.fat = val;
        else if (name.includes('fatty acids, total saturated')) nut.satfat = val;
        else if (name === 'carbohydrate, by difference') nut.carbs = val;
        else if (name.includes('sugars, total')) nut.sugars = val;
        else if (name.includes('fiber, total')) nut.fibre = val;
        else if (name.includes('sodium')) nut.sodium = val;
      });
      return {
        name: food.description,
        category: food.foodCategory || '',
        nutrition: nut,
      };
    });

    res.json({ results });
  } catch (err) {
    console.error('Nutrition search error:', err);
    res.status(500).json({ error: 'Failed to search USDA: ' + err.message });
  }
});

// GET /api/nutrition/recipe?npd=2025-001 — calculate nutrition for a whole recipe from USDA data
app.get('/api/nutrition/recipe', requireAuth, async (req, res) => {
  try {
    const npd = req.query.npd;
    if (!npd) return res.status(400).json({ error: 'npd required' });

    // Get recipe data from server
    const state = db.getState();
    if (!state || !state.data || !state.data.recipes || !state.data.recipes[npd]) {
      return res.status(404).json({ error: 'Recipe not found' });
    }
    const recipe = state.data.recipes[npd];
    if (!recipe.ingredients || !recipe.ingredients.length) {
      return res.json({ nutrition: null, message: 'No ingredients' });
    }

    const totalPct = recipe.ingredients.reduce((s, i) => s + i.pct, 0);
    if (totalPct === 0) return res.json({ nutrition: null });

    // Look up each ingredient in USDA
    const totals = { energy: 0, protein: 0, fat: 0, satfat: 0, carbs: 0, sugars: 0, fibre: 0, sodium: 0 };
    let matched = 0;
    const details = [];

    // Common ingredient name mappings for better USDA matches
    const USDA_NAME_MAP = {
      'chilled water': 'water',
      'water': 'water',
      'iodized salt': 'salt',
      'salt': 'salt',
      'sunflower oil': 'oil sunflower',
      'vegetable oil': 'oil vegetable',
      'olive oil': 'oil olive',
      'garlic puree': 'garlic raw',
      'onion vegetable': 'onion raw',
      'tomato paste': 'tomato paste canned',
      'whole peeled tomato': 'tomato canned whole',
      'patent flour': 'wheat flour white',
      'rice flour': 'rice flour white',
      'tapioca flour': 'tapioca',
      'potato starch': 'potato starch',
      'dry yeast': 'yeast dry',
      'milk powder': 'milk dry nonfat',
      'brown sugar': 'sugar brown',
    };

    function cleanIngName(name) {
      return name
        .replace(/\([^)]*\)/g, ' ')      // remove parentheses content
        .replace(/\b\d+\.?\d*\s*(kg|g|gr|ml|ltr|oz)\b/gi, ' ')  // remove weights
        .replace(/[-_]/g, ' ')
        .replace(/\b(knorr|mutti|avebe|al.osra|freshly)\b/gi, ' ')  // remove common brand names
        .replace(/\s+/g, ' ')
        .trim();
    }

    for (const ing of recipe.ingredients) {
      const fraction = ing.pct / totalPct;
      const grams = fraction * 1000;

      try {
        let cleanName = cleanIngName(ing.name);
        // Check name map for better USDA search terms
        const lc = cleanName.toLowerCase();
        for (const [key, val] of Object.entries(USDA_NAME_MAP)) {
          if (lc.includes(key) || lc === key) { cleanName = val; break; }
        }
        const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(cleanName)}&pageSize=3&dataType=Foundation,SR%20Legacy&api_key=${USDA_API_KEY}`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.foods && data.foods.length) {
          // Pick the best match: prefer results whose name contains key words from the ingredient
          const words = cleanName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          let food = data.foods[0];
          let bestScore = 0;
          for (const f of data.foods) {
            const desc = f.description.toLowerCase();
            const score = words.filter(w => desc.includes(w)).length;
            if (score > bestScore) { bestScore = score; food = f; }
          }
          const nut = {};
          (food.foodNutrients || []).forEach(n => {
            const name = (n.nutrientName || '').toLowerCase();
            const val = n.value || 0;
            if (name.includes('energy') && (n.unitName === 'KCAL' || name.includes('kcal'))) nut.energy = val;
            else if (name === 'protein') nut.protein = val;
            else if (name === 'total lipid (fat)') nut.fat = val;
            else if (name.includes('fatty acids, total saturated')) nut.satfat = val;
            else if (name === 'carbohydrate, by difference') nut.carbs = val;
            else if (name.includes('sugars, total')) nut.sugars = val;
            else if (name.includes('fiber, total')) nut.fibre = val;
            else if (name.includes('sodium')) nut.sodium = val;
          });

          // USDA values are per 100g — scale to actual grams in recipe
          const scale = grams / 100;
          Object.keys(nut).forEach(k => { totals[k] += nut[k] * scale; });
          matched++;
          details.push({ ingredient: ing.name, grams: Math.round(grams), usda: food.description, per100g: nut });
        } else {
          details.push({ ingredient: ing.name, grams: Math.round(grams), usda: null });
        }
      } catch (e) {
        details.push({ ingredient: ing.name, grams: Math.round(grams), usda: null, error: e.message });
      }
    }

    // Convert totals to per 100g of recipe (totals are per 1000g)
    const per100g = {};
    Object.keys(totals).forEach(k => {
      per100g[k] = Math.round(totals[k] / 10 * 10) / 10; // per 100g, 1 decimal
    });

    res.json({
      recipe: recipe.name,
      npd,
      matched: matched + '/' + recipe.ingredients.length,
      nutritionPer100g: per100g,
      details,
    });
  } catch (err) {
    console.error('Recipe nutrition error:', err);
    res.status(500).json({ error: 'Failed to calculate nutrition: ' + err.message });
  }
});

// ── AUDIT LOG ──
// Helper: resolve role for a given email by reading current state.users
function _roleForEmail(email) {
  if (!email) return null;
  if (email.toLowerCase() === 'caterina.loduca@dailyfoodsa.com') return 'admin';
  const state = db.getState();
  const users = (state && state.data && state.data.users) || [];
  const u = users.find(x => x.email && x.email.toLowerCase() === email.toLowerCase());
  return u ? (u.role || 'viewer') : null;
}

// POST /api/audit/event — fire-and-forget event recording
// Body: { user_email, action, target_type?, target_id?, target_label?, meta? }
app.post('/api/audit/event', requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.action) return res.status(400).json({ error: 'action required' });
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').slice(0, 500);
    db.auditWrite({
      user_email:   b.user_email || '',
      action:       String(b.action).slice(0, 80),
      target_type:  b.target_type ? String(b.target_type).slice(0, 40) : null,
      target_id:    b.target_id   ? String(b.target_id).slice(0, 200)   : null,
      target_label: b.target_label ? String(b.target_label).slice(0, 300) : null,
      ip,
      user_agent: ua,
      meta: b.meta || null,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('audit write failed:', err.message);
    res.status(500).json({ error: 'audit write failed' });
  }
});

// GET /api/audit/events — admin only. Filters: user, action, actionPrefix, from, to, limit
app.get('/api/audit/events', requireAuth, (req, res) => {
  try {
    const requesterEmail = (req.query.as || '').toString();
    if (_roleForEmail(requesterEmail) !== 'admin') {
      return res.status(403).json({ error: 'admin only' });
    }
    const events = db.auditList({
      user:         req.query.user,
      action:       req.query.action,
      actionPrefix: req.query.actionPrefix,
      from:         req.query.from,
      to:           req.query.to,
      limit:        req.query.limit,
    });
    res.json({ events, counts: db.auditCounts() });
  } catch (err) {
    console.error('audit list failed:', err.message);
    res.status(500).json({ error: 'audit list failed' });
  }
});

// ─── Columbo the inspector — passive anomaly sweep ───
// GET /api/inspector/sweep — admin only. Reads the current data blob and
// returns a list of suspicious things (percentages that don't sum, broken
// references, kill-list zombies, etc.) so we catch data drift before users
// trip over it. Cate's idea — named for the squinting detective.
//
// The check list is deliberately conservative: only flag things that are
// almost certainly wrong, never opinionated style issues. Each anomaly has
// a `link` describing where the user should go to fix it.
app.get('/api/inspector/sweep', requireAuth, (req, res) => {
  try {
    const requesterEmail = (req.query.as || '').toString();
    if (_roleForEmail(requesterEmail) !== 'admin') {
      return res.status(403).json({ error: 'admin only' });
    }
    const state = db.getState();
    if (!state || !state.data) return res.status(500).json({ error: 'No data on server' });
    const data = state.data;
    const anomalies = [];
    const push = (kind, severity, entityType, entityId, message, link) => {
      anomalies.push({ kind, severity, entityType, entityId, message, link });
    };

    const recipes = data.recipes || {};
    const recipeIds = new Set(Object.keys(recipes));
    const builds = Array.isArray(data.builds) ? data.builds : [];
    const branchSOPs = Array.isArray(data.branchSOPs) ? data.branchSOPs : [];
    const users = Array.isArray(data.users) ? data.users : [];
    const productionRuns = Array.isArray(data.productionRuns) ? data.productionRuns : [];

    // ── A. Recipe quantities don't sum to 100% ──
    // Only 100% is accepted now (Cate 2026-05-18). Previously also accepted
    // 1000g and 1.0, but those conventions weren't being used in practice and
    // were causing confusion.
    // Empty drafts and archived recipes are exempt.
    const VALID_TOTALS = [
      { target: 100, tol: 0.5, label: '100%' },
    ];
    Object.entries(recipes).forEach(([npd, r]) => {
      if (!r || r.archived) return;
      const ings = Array.isArray(r.ingredients) ? r.ingredients : [];
      if (ings.length < 2) return;
      const sum = ings.reduce((s, i) => s + (parseFloat(i && i.pct) || 0), 0);
      if (sum === 0) return;
      // Pass if within tolerance of ANY valid total.
      let nearest = VALID_TOTALS[0];
      let nearestRelDiff = Infinity;
      let passes = false;
      for (const t of VALID_TOTALS) {
        const absDiff = Math.abs(sum - t.target);
        if (absDiff <= t.tol) { passes = true; break; }
        const relDiff = absDiff / t.target;  // for "closest" reporting
        if (relDiff < nearestRelDiff) { nearestRelDiff = relDiff; nearest = t; }
      }
      if (passes) return;
      // How far off, as a percentage of the nearest target.
      const offPct = (Math.abs(sum - nearest.target) / nearest.target) * 100;
      const severity = offPct >= 1.0 ? 'high' : 'medium';
      push('recipe.pct_sum', severity, 'recipe', npd,
        `${r.name || npd}: quantities sum to ${sum.toFixed(2)} — closest valid total is ${nearest.label}, off by ${offPct.toFixed(2)}%`,
        'recipes/' + npd);
    });

    // ── B. Recipe ingredients missing an Oracle code ──
    // Only count rows where the name is non-empty. Items the user is still
    // typing are not flagged.
    Object.entries(recipes).forEach(([npd, r]) => {
      if (!r || r.archived || r.status === 'draft') return;
      const ings = Array.isArray(r.ingredients) ? r.ingredients : [];
      const missing = ings.filter(i => i && i.name && !i.itemCode);
      if (missing.length > 0) {
        push('recipe.missing_codes', 'medium', 'recipe', npd,
          `${r.name || npd}: ${missing.length} ingredient${missing.length===1?'':'s'} have no Oracle code — cost lookup will be blank`,
          'recipes/' + npd);
      }
    });

    // ── C. Builds with components referencing non-existent recipes ──
    builds.forEach(b => {
      if (!b || b.archived) return;
      (b.components || []).forEach(c => {
        if (c && c.ref && !recipeIds.has(c.ref)) {
          push('build.broken_ref', 'high', 'build', b.id,
            `${b.name || b.id}: component "${c.item || c.name || '(unnamed)'}" references recipe ${c.ref} which no longer exists`,
            'builds/' + b.id);
        }
      });
    });

    // ── D. Branch SOPs whose linked build is gone ──
    const buildIds = new Set(builds.map(b => b && b.id).filter(Boolean));
    branchSOPs.forEach(s => {
      if (!s || s.archived) return;
      if (s.buildRef && !buildIds.has(s.buildRef)) {
        push('sop.orphaned', 'medium', 'branch_sop', s.id,
          `${s.name || s.id}: linked build ${s.buildRef} doesn't exist anymore`,
          'branch-sop/' + s.id);
      }
    });

    // ── E. Users with no role or no email ──
    users.forEach(u => {
      if (!u) return;
      if (!u.email) {
        push('user.no_email', 'high', 'user', u.name || '(unnamed)',
          `User "${u.name || '(unnamed)'}" has no email — cannot sign in`,
          'users');
      } else if (!u.role) {
        push('user.no_role', 'medium', 'user', u.email,
          `${u.name || u.email}: no role set — defaults to viewer`,
          'users');
      }
    });

    // ── F. Kill-list zombies — id is in deletedXIds AND in the active array ──
    // This means a previous delete didn't fully clean up. Server merge should
    // filter on every read, but a stale tab could have re-added.
    const checkZombie = (killArr, activeArr, idField, kind, kindLabel) => {
      const kill = new Set(killArr || []);
      if (!kill.size) return;
      (activeArr || []).forEach(item => {
        if (!item) return;
        const id = idField === 'email' ? String((item.email || '')).toLowerCase()
                                       : item[idField];
        if (id && kill.has(id)) {
          push(kind, 'high', kindLabel.toLowerCase(), id,
            `${kindLabel} "${id}" is in the kill list AND still in the active list — zombie`,
            kindLabel.toLowerCase() + 's');
        }
      });
    };
    checkZombie(data.deletedRecipeIds,         Object.values(recipes),     'npd',     'zombie.recipe',      'Recipe');
    checkZombie(data.deletedBuildIds,          builds,                     'id',      'zombie.build',       'Build');
    checkZombie(data.deletedUserEmails,        users,                      'email',   'zombie.user',        'User');
    checkZombie(data.deletedBrandIds,          data.brands || [],          'id',      'zombie.brand',       'Brand');
    checkZombie(data.deletedSOPIds,            branchSOPs,                 'id',      'zombie.branchsop',   'BranchSOP');
    checkZombie(data.deletedProductionRunIds,  productionRuns,             'id',      'zombie.run',         'ProductionRun');
    checkZombie(data.deletedSubstitutionIds,   data.substitutionRequests || [], 'id', 'zombie.substitution','Substitution');
    checkZombie(data.deletedLibraryDocIds,     data.libraryDocs || [],     'id',      'zombie.library',     'Library');

    // ── G. Production runs pointing at non-existent recipes ──
    productionRuns.forEach(run => {
      if (!run || run.archived) return;
      // run.recipe is the display name; we don't have a back-reference to the
      // NPD, so this check is best-effort. Skip for now to avoid false
      // positives. If we add run.recipeNpd later, re-enable here.
    });

    // ── H. Duplicate recipe NPDs (case-insensitive) ──
    const seenNpd = new Map();
    Object.keys(recipes).forEach(npd => {
      const lc = String(npd || '').toLowerCase();
      if (seenNpd.has(lc) && seenNpd.get(lc) !== npd) {
        push('recipe.duplicate_npd', 'high', 'recipe', npd,
          `Two recipes share the same NPD when compared case-insensitively: "${seenNpd.get(lc)}" vs "${npd}"`,
          'recipes/' + npd);
      } else {
        seenNpd.set(lc, npd);
      }
    });

    // ── I. Archived recipe still in mid-workflow status ──
    // An archived recipe should normally be 'approved' (or 'discontinued',
    // which is a separate flag). Anything else means it was archived
    // mid-flow and will leak into dashboard counts that look at status
    // alone. Surfaced 2026-05-18 — five Halloumi-Slice / Orange-Sauce style
    // recipes were archived while status='review' and the Pending Actions
    // widget was pulling them forward as if they still needed sign-off.
    Object.entries(recipes).forEach(([npd, r]) => {
      if (!r || !r.archived) return;
      const s = r.status || 'draft';
      if (s !== 'approved') {
        push('recipe.archived_midflow', 'low', 'recipe', npd,
          `${r.name || npd}: archived while status='${s}'. Either restore-and-approve, or leave as-is — but it'll keep being filtered out of the active stats.`,
          'recipes/' + npd);
      }
    });

    // ── J. Duplicate recipe NAMES among non-archived recipes ──
    // Names should be unique among live recipes — caught the 2026-261 vs
    // 2026-263 'Hasawi Lemon Marinade (25%)' mistake earlier today, where
    // Cate created a new recipe under the same name without archiving the
    // old one first. Archived dupes are exempt (intentional renames).
    const seenName = new Map();
    Object.entries(recipes).forEach(([npd, r]) => {
      if (!r || r.archived) return;
      const nm = String(r.name || '').trim().toLowerCase();
      if (!nm) return;
      if (seenName.has(nm)) {
        const other = seenName.get(nm);
        push('recipe.duplicate_name', 'medium', 'recipe', npd,
          `${r.name}: another live recipe (${other}) shares this exact name. Pick one to archive or rename.`,
          'recipes/' + npd);
      } else {
        seenName.set(nm, npd);
      }
    });

    // ── K. Open production runs whose cached recipe name is stale ──
    // The rename-cascade keeps pr.recipe in sync with recipes[pr.npd].name
    // for open runs. If they drift, either the cascade failed or someone
    // edited the run directly. Surface so we can re-sync.
    productionRuns.forEach(pr => {
      if (!pr || pr.archived) return;
      if (pr.status === 'completed' || pr.status === 'cancelled') return; // frozen on purpose
      const npd = pr.npd;
      if (!npd || !recipes[npd]) return;
      const live = recipes[npd].name || '';
      const cached = pr.recipe || '';
      if (cached && live && cached.trim() !== live.trim()) {
        push('run.stale_name', 'low', 'production_run', pr.id,
          `Run ${pr.id} caches recipe name "${cached}" but the live recipe is now "${live}". Edit the recipe and save to re-trigger the rename cascade.`,
          'recipes/' + npd);
      }
    });

    // ── L. Non-draft recipe with no ingredients ──
    // A recipe that's passed Draft should have at least an ingredient list.
    // Empty formulation past Draft means something was rushed through or
    // the data got wiped.
    Object.entries(recipes).forEach(([npd, r]) => {
      if (!r || r.archived) return;
      if (!r.status || r.status === 'draft') return;
      const n = Array.isArray(r.ingredients) ? r.ingredients.length : 0;
      if (n === 0) {
        push('recipe.empty_ingredients', 'high', 'recipe', npd,
          `${r.name || npd}: status='${r.status}' but has no ingredients. Either move back to Draft or fill in the formulation.`,
          'recipes/' + npd);
      }
    });

    // ── M. Active build with a component whose cached recipe name is stale ──
    // Sister check to run.stale_name. The rename cascade keeps c.item in sync
    // with the live recipe.name for non-archived builds; if they drift, the
    // cascade missed an entity or someone edited a component directly.
    builds.forEach(b => {
      if (!b || b.archived || !Array.isArray(b.components)) return;
      b.components.forEach(c => {
        if (!c || !c.ref || !c.item) return;
        const sub = recipes[c.ref];
        if (!sub || !sub.name) return;
        if (String(c.item).trim() !== String(sub.name).trim()) {
          push('build.stale_name', 'low', 'build', b.id,
            `Build "${b.name || b.id}" has a component cached as "${c.item}" but recipe ${c.ref} is now called "${sub.name}". Save the recipe to re-trigger the rename cascade.`,
            'builds/' + b.id);
        }
      });
    });

    // ── N. Overdue production runs ──
    // A run that was scheduled for a past date but never moved to completed
    // is workflow rot. Either it ran (mark completed), got delayed (push
    // the date forward), or got abandoned (cancel it). Either way the
    // current state is misleading.
    const _today = new Date(); _today.setHours(0, 0, 0, 0);
    productionRuns.forEach(pr => {
      if (!pr || pr.archived) return;
      if (pr.status !== 'pending' && pr.status !== 'scheduled') return;
      if (!pr.date) return;
      const d = new Date(pr.date);
      if (isNaN(d.getTime())) return;
      d.setHours(0, 0, 0, 0);
      if (d < _today) {
        const days = Math.round((_today - d) / 86400000);
        push('run.overdue', days >= 14 ? 'medium' : 'low', 'production_run', pr.id,
          `Run ${pr.id} (${pr.recipe || pr.npd || '—'}) was scheduled for ${pr.date} — ${days} day${days===1?'':'s'} ago — and is still ${pr.status}. Either complete it, reschedule, or cancel.`,
          'recipes/' + (pr.npd || ''));
      }
    });

    // ── O. Discontinued recipe referenced by a live build ──
    // If a recipe is marked discontinued, it shouldn't be shipping in any
    // active build. Either un-discontinue the recipe (it's actually still
    // in use) or remove it from the build.
    builds.forEach(b => {
      if (!b || b.archived || !Array.isArray(b.components)) return;
      b.components.forEach(c => {
        if (!c || !c.ref) return;
        const sub = recipes[c.ref];
        if (sub && sub.discontinued) {
          push('recipe.discontinued_in_active_build', 'medium', 'build', b.id,
            `Build "${b.name || b.id}" still uses discontinued recipe ${c.ref} (${sub.name}). Either re-activate the recipe or swap the component.`,
            'builds/' + b.id);
        }
      });
    });

    // ── P. Composite recipe with a missing or archived sub-recipe ──
    // Composite recipes (recipeKind='composite') roll up cost from their
    // sub-recipes via c.subNpd. If a sub is deleted or archived, the cost
    // silently drops to 0 for that component — a quiet way for the total
    // cost to drift wrong without anyone noticing.
    Object.entries(recipes).forEach(([npd, r]) => {
      if (!r || r.archived) return;
      if (r.recipeKind !== 'composite') return;
      const components = Array.isArray(r.components) ? r.components : [];
      components.forEach(c => {
        if (!c || !c.subNpd) return;
        const sub = recipes[c.subNpd];
        if (!sub) {
          push('composite.missing_subrecipe', 'high', 'recipe', npd,
            `${r.name || npd}: composite component points at recipe ${c.subNpd} which no longer exists. Cost roll-up is incomplete.`,
            'recipes/' + npd);
        } else if (sub.archived) {
          push('composite.missing_subrecipe', 'medium', 'recipe', npd,
            `${r.name || npd}: composite component references archived sub-recipe ${c.subNpd} (${sub.name}). Cost roll-up still works but the sub is out of circulation.`,
            'recipes/' + npd);
        }
      });
    });

    // ── Q. Approved recipe missing required downstream metadata ──
    // Approval should mean the recipe is ready for production. Missing
    // batchSize means downstream views (kitchen sheet, SOP, cost calc)
    // won't display correctly.
    // yield + shelfLife checks suppressed per Cate 2026-05-18 — they're
    // valid concerns but not currently being maintained, so flagging
    // them was just noise.
    Object.entries(recipes).forEach(([npd, r]) => {
      if (!r || r.archived) return;
      if (r.status !== 'approved') return;
      const missing = [];
      if (!r.batchSize) missing.push('batchSize');
      if (missing.length) {
        push('recipe.approved_missing_fields', 'medium', 'recipe', npd,
          `${r.name || npd}: approved but missing ${missing.join(', ')}. Downstream views (kitchen sheet, SOP, cost) won't render fully.`,
          'recipes/' + npd);
      }
    });

    // Group by kind for the count summary
    const counts = anomalies.reduce((acc, a) => { acc[a.kind] = (acc[a.kind] || 0) + 1; return acc; }, {});
    res.json({
      ranAt: new Date().toISOString(),
      total: anomalies.length,
      counts,
      anomalies,
    });
  } catch (err) {
    console.error('inspector sweep failed:', err.message);
    res.status(500).json({ error: 'inspector sweep failed: ' + err.message });
  }
});

// 180-day retention purge — runs at startup and every 24h
function _runAuditPurge() {
  try {
    const removed = db.auditPurge(180);
    if (removed) console.log(`audit_log: purged ${removed} rows older than 180 days`);
  } catch (e) {
    console.error('audit purge failed:', e.message);
  }
}

// Start
db.init();
_runAuditPurge();
setInterval(_runAuditPurge, 24 * 60 * 60 * 1000);
app.listen(PORT, () => {
  console.log(`RecipeHub API running on port ${PORT}`);
});
