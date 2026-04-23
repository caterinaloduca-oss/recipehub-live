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
        Object.keys(body.recipes).forEach(k => {
          const nr = body.recipes[k], or = old.recipes[k];
          if (!or) return;
          // Merge recipe media: combine both, dedupe by name, keep old images that aren't in the incoming list
          if (or.media && or.media.length) {
            if (!nr.media) nr.media = [];
            const nrNames = new Set(nr.media.map(m => m.name));
            or.media.forEach(m => {
              if (m.url && !nrNames.has(m.name)) nr.media.push(m);
            });
          }
          // Preserve SOP step images unless client is newer and explicitly cleared
          if (or.sopSteps && nr.sopSteps) {
            nr.sopSteps.forEach((s, i) => {
              const oldStep = or.sopSteps[i];
              if (oldStep && oldStep.visualImg && imgIsEmpty(s.visualImg) && !clientIsNewer(nr, or)) {
                s.visualImg = oldStep.visualImg;
              }
            });
          }
          // Merge QA files
          ['trialQA','prodQA'].forEach(stage => {
            if (or[stage] && or[stage].files && or[stage].files.length) {
              if (!nr[stage]) nr[stage] = { signed: false, files: [] };
              if (!nr[stage].files) nr[stage].files = [];
              const nrNames = new Set(nr[stage].files.map(f => f.name));
              or[stage].files.forEach(f => {
                if (f.url && !nrNames.has(f.name)) nr[stage].files.push(f);
              });
            }
          });
        });
      }
      // Build sync: if existing has a newer updatedAt than incoming, keep existing entirely.
      // Otherwise preserve photo when incoming is empty. Protects builds from stale pushes.
      if (body.builds && old.builds) {
        body.builds = body.builds.map(b => {
          const ob = old.builds.find(x => x.id === b.id);
          if (!ob) return b;
          if (!clientIsNewer(b, ob)) {
            // Stale push for this build — keep server's full record
            return { ...ob };
          }
          // Client is newer — preserve photo if they didn't send one
          if (ob.photo && imgIsEmpty(b.photo)) b.photo = ob.photo;
          return b;
        });
      }
      // Branch SOP sync: same protection — stale clients keep existing SOP unchanged
      if (body.branchSOPs && old.branchSOPs) {
        body.branchSOPs = body.branchSOPs.map(sop => {
          const os = old.branchSOPs.find(x => x.id === sop.id);
          if (!os) return sop;
          if (!clientIsNewer(sop, os)) {
            return { ...os };
          }
          if (os.steps && sop.steps) {
            sop.steps.forEach((s, i) => {
              const oldStep = os.steps[i];
              if (oldStep && oldStep.img && imgIsEmpty(s.img)) s.img = oldStep.img;
            });
          }
          return sop;
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
      if (old.commsLog && old.commsLog.length) {
        if (!body.commsLog) body.commsLog = [];
        const existingTs = new Set(body.commsLog.map(m => m.sentAt));
        old.commsLog.forEach(m => { if (m.sentAt && !existingTs.has(m.sentAt)) body.commsLog.push(m); });
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
    // Auto-clean: remove deleted Branch SOPs.
    // Merge server-side deletedSOPIds with incoming so server-recorded deletions persist
    // even when a stale client pushes data without them. Without this merge, a browser
    // with an old cache can resurrect deleted entries every time it syncs.
    if (existing && existing.data && Array.isArray(existing.data.deletedSOPIds)) {
      body.deletedSOPIds = Array.from(new Set([...(body.deletedSOPIds || []), ...existing.data.deletedSOPIds]));
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
    if (body.builds && body.deletedBuildIds && body.deletedBuildIds.length) {
      const deletedBuilds = new Set(body.deletedBuildIds);
      body.builds = body.builds.filter(b => !deletedBuilds.has(b.id));
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

  // If existing is newer for core fields, keep existing
  if (eTime > iTime) {
    ['name','version','brand','type','storage','yield','yieldNotes','batchSize','costKg',
     'ingredients','method','packaging','sopSteps','sensoryGate1','sensoryGate2'].forEach(f => {
      if (existing[f] !== undefined) result[f] = existing[f];
    });
    result.updatedAt = eTime;
  }

  // Always union-merge media
  result.media = unionByKey(existing.media, result.media, 'name');
  // Union-merge append-only logs
  result.changeLog = unionByKey(existing.changeLog, result.changeLog, 'date');
  result.versionHistory = unionByKey(existing.versionHistory, result.versionHistory, 'savedAt');
  // Preserve comments from both
  result.comments = unionByKey(existing.comments, result.comments, 'date');

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

  return result;
}

function mergeBuild(existing, incoming) {
  if (!existing) return incoming;
  const result = { ...incoming };
  const eTime = existing.updatedAt || '2000-01-01';
  const iTime = incoming.updatedAt || '2000-01-01';
  if (eTime > iTime) {
    ['name','brand','type','size','components','instructions','bakeTemp','bakeTime','sellingPrice','status','nutrition','tags'].forEach(f => {
      if (existing[f] !== undefined) result[f] = existing[f];
    });
    result.updatedAt = eTime;
  }
  // Preserve photo
  if (existing.photo && !result.photo) result.photo = existing.photo;
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
    data.savedAt = new Date().toISOString();
    const savedAt = db.setState(JSON.stringify(data), data.dataVersion || 0);
    res.json({ ok: true, savedAt, build: idx >= 0 ? data.builds[idx] : incoming });
  } catch (err) {
    console.error('POST /api/build error:', err);
    res.status(500).json({ error: 'Failed to save build: ' + err.message });
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
    const { event, recipe, build, run, user } = req.body;
    if (!event) return res.status(400).json({ error: 'event required' });

    const userName = user || 'Someone';
    let subject, html, recipients;

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
          <p>A production run has been created. Please schedule a date.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#1A5FA5;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">View Production Plan</a></p>`;
        break;

      case 'recipe-prod-trial':
        recipients = getEmailsByRole(['npd', 'factory', 'qa', 'purchasing']);
        subject = `Production Trial requested: ${recipe}`;
        html = `<h2 style="color:#1B2A4A;margin:0 0 12px">${recipe}</h2>
          <p><strong>${userName}</strong> sent this recipe to <span style="color:#6B2FA0;font-weight:600">Production Trial</span>.</p>
          <p>QA sign-off was completed. A production run has been created.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#6B2FA0;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open RecipeHub</a></p>`;
        break;

      case 'recipe-approved':
        recipients = getEmailsByRole(['npd', 'qa', 'factory', 'purchasing']);
        subject = `Recipe APPROVED: ${recipe}`;
        html = `<h2 style="color:#2D6A4F;margin:0 0 12px">${recipe} ✅</h2>
          <p><strong>${userName}</strong> approved this recipe for production.</p>
          <p style="background:#EBF5EE;padding:12px 16px;border-radius:6px;color:#2D6A4F;font-weight:500">This recipe is now cleared for full-scale production.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#2D6A4F;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">View Recipe</a></p>`;
        break;

      case 'qa-signoff':
        recipients = getEmailsByRole(['npd']);
        subject = `QA sign-off completed: ${recipe}`;
        html = `<h2 style="color:#1B2A4A;margin:0 0 12px">${recipe}</h2>
          <p><strong>${userName}</strong> completed QA sign-off for this recipe.</p>
          <p>The recipe can now be moved to the next stage.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#B8820A;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open RecipeHub</a></p>`;
        break;

      case 'run-scheduled':
        recipients = getEmailsByRole(['npd', 'factory']);
        subject = `Production run scheduled: ${recipe}`;
        html = `<h2 style="color:#1B2A4A;margin:0 0 12px">${recipe}</h2>
          <p><strong>${userName}</strong> scheduled a production run.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#1B2A4A;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">View Production Plan</a></p>`;
        break;

      case 'run-completed':
        recipients = getEmailsByRole(['npd', 'qa']);
        subject = `Production run completed: ${recipe}`;
        html = `<h2 style="color:#2D6A4F;margin:0 0 12px">${recipe}</h2>
          <p><strong>${userName}</strong> completed a production run.</p>
          <p>QA results and yield data are ready for review.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#2D6A4F;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Open RecipeHub</a></p>`;
        break;

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
    const safeBody = escHtml(html || '').replace(/\n/g, '<br>');
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

// Start
db.init();
app.listen(PORT, () => {
  console.log(`RecipeHub API running on port ${PORT}`);
});
