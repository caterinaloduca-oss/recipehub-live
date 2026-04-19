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
    // Users: dedupe by email AND strip invalid @dailyfoodsa.com emails
    if (body.users) {
      body.users = dedupeById(body.users, 'email');
      body.users = body.users.filter(u => {
        const email = (u.email || '').toLowerCase().trim();
        return email.endsWith('@dailyfoodsa.com');
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
      if (body.recipes && old.recipes) {
        Object.keys(body.recipes).forEach(k => {
          const nr = body.recipes[k], or = old.recipes[k];
          if (!or) return;
          // Merge recipe media: combine both, dedupe by name, keep real images
          if (or.media && or.media.length) {
            if (!nr.media) nr.media = [];
            const nrNames = new Set(nr.media.map(m => m.name));
            or.media.forEach(m => {
              if (m.url && m.url.startsWith('data:') && !nrNames.has(m.name)) nr.media.push(m);
            });
          }
          // Preserve SOP step images
          if (or.sopSteps && nr.sopSteps) {
            nr.sopSteps.forEach((s, i) => {
              if (or.sopSteps[i] && or.sopSteps[i].visualImg && or.sopSteps[i].visualImg.startsWith('data:') && (!s.visualImg || s.visualImg === '[server]' || s.visualImg === 'null')) {
                s.visualImg = or.sopSteps[i].visualImg;
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
                if (f.url && f.url.startsWith('data:') && !nrNames.has(f.name)) nr[stage].files.push(f);
              });
            }
          });
        });
      }
      // Merge build photos
      if (body.builds && old.builds) {
        body.builds.forEach(b => {
          const ob = old.builds.find(x => x.id === b.id);
          if (ob && ob.photo && ob.photo.startsWith('data:') && (!b.photo || b.photo === '[server]' || b.photo === 'null')) {
            b.photo = ob.photo;
          }
        });
      }
      // Merge branch SOP step images
      if (body.branchSOPs && old.branchSOPs) {
        body.branchSOPs.forEach(sop => {
          const os = old.branchSOPs.find(x => x.id === sop.id);
          if (os && os.steps && sop.steps) {
            sop.steps.forEach((s, i) => {
              if (os.steps[i] && os.steps[i].img && os.steps[i].img.startsWith('data:') && (!s.img || s.img === '[server]' || s.img === 'null')) {
                s.img = os.steps[i].img;
              }
            });
          }
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
    // Auto-clean: remove deleted Branch SOPs
    if (body.branchSOPs && body.deletedSOPIds && body.deletedSOPIds.length) {
      const deletedSOPs = new Set(body.deletedSOPIds);
      body.branchSOPs = body.branchSOPs.filter(s => !deletedSOPs.has(s.id));
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
    ['name','version','brand','status','steps','buildRef','date'].forEach(f => {
      if (existing[f] !== undefined) result[f] = existing[f];
    });
    result.updatedAt = eTime;
  }
  // Preserve step images
  if (existing.steps && result.steps) {
    result.steps.forEach((s, i) => {
      if (existing.steps[i] && existing.steps[i].img && !s.img) s.img = existing.steps[i].img;
    });
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

// Parse pack-size in kg from an EBS item description.
// Handles: "1.5 Lit", "18 Liters", "5Kg", "700g", "10ml", and multi-pack "12 x 1L".
function parsePackKg(desc) {
  if (!desc) return null;
  // Multi-pack: "12 x 1L", "6x500g"
  const mp = desc.match(/(\d+)\s*[xX]\s*(\d+\.?\d*)\s*(kg|kgs|g|gr|grams?|ltr|litres?|liters?|ml)\b/i);
  if (mp) {
    const count = parseInt(mp[1], 10);
    const per = parseFloat(mp[2]);
    const u = mp[3].toLowerCase();
    const kg = unitToKg(per, u);
    if (kg) return count * kg;
  }
  const m = desc.match(/(\d+\.?\d*)\s*(kg|kgs|g|gr|grams?|ltr|litres?|liters?|ml)\b/i);
  if (!m) return null;
  return unitToKg(parseFloat(m[1]), m[2].toLowerCase());
}

function unitToKg(val, unit) {
  if (!val || val <= 0) return null;
  if (unit === 'kg' || unit === 'kgs') return val;
  if (unit === 'g' || unit === 'gr' || unit === 'gram' || unit === 'grams') return val / 1000;
  if (unit === 'ltr' || unit.startsWith('lit')) return val; // 1L ≈ 1kg for food liquids
  if (unit === 'ml') return val / 1000;
  return null;
}

// Normalise an EBS accounting_cost (SAR per pack) + UOM string + description → SAR per kg or per piece
function normalisePrice(cost, uom, desc) {
  const u = String(uom || '').toUpperCase();
  if (u === 'KG') return { unit: 'kg', perUnit: cost };
  if (u === 'G' || u === 'GR' || u === 'GRAM') return { unit: 'kg', perUnit: cost * 1000 };
  if (u === 'LTR' || u === 'LITRE' || u === 'LITER' || u === 'LIT') return { unit: 'kg', perUnit: cost }; // 1L ≈ 1kg for food liquids
  if (u === 'ML') return { unit: 'kg', perUnit: cost * 1000 };
  if (u === 'PCE' || u === 'EACH' || u === 'EA' || u === 'PC' || u === 'PCS') return { unit: 'piece', perUnit: cost };
  // Pack UOMs (BAG, BOT, CAN, PAL, X10, XO4, XO2, PCK, BOX, etc.) — infer kg from description pack size
  const packKg = parsePackKg(desc);
  if (packKg && packKg > 0) return { unit: 'kg', perUnit: cost / packKg };
  return { unit: u || 'pack', perUnit: cost };
}

// GET /api/ebs/prices — all ingredient prices (latest period per item, cached)
app.get('/api/ebs/prices', requireAuth, (req, res) => {
  try {
    const rows = db.getLatestPrices();
    const prices = rows.map(r => {
      const n = normalisePrice(r.accounting_cost, r.uom, r.item_desc);
      return {
        code: r.item_number,
        name: r.item_desc,
        unit: n.unit,
        uomSource: r.uom,
        periodCode: r.period_code,
        pricePerKg: n.unit === 'kg' ? n.perUnit : null,
        pricePerPiece: n.unit === 'piece' ? n.perUnit : null,
        accountingCost: r.accounting_cost,
        compnentCost: r.compnent_cost,
      };
    });
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

// GET /api/ebs/search?q=tomato — search by name or item_number, return normalised per-kg/piece cost
app.get('/api/ebs/search', requireAuth, (req, res) => {
  try {
    const raw = (req.query.q || '').trim();
    if (!raw || raw.length < 2) return res.json({ results: [] });
    const q = raw.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 100);
    if (!q) return res.json({ results: [] });
    const rows = db.searchPrices(q);
    const results = rows.map(r => {
      const n = normalisePrice(r.accounting_cost, r.uom, r.item_desc);
      return {
        code: r.item_number,
        name: r.item_desc,
        unit: n.unit,
        uomSource: r.uom,
        periodCode: r.period_code,
        pricePerKg: n.unit === 'kg' ? n.perUnit : null,
        pricePerPiece: n.unit === 'piece' ? n.perUnit : null,
        accountingCost: r.accounting_cost,
        // Back-compat shape for existing frontend callers:
        avgPrice: n.perUnit,
        purchasePrice: r.accounting_cost,
        originalUnit: r.uom,
        vendor: '',
        vendors: [],
      };
    });
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

// POST /api/ebs/sync-prices — pull full history from Oracle EBS into local cache
app.post('/api/ebs/sync-prices', requireAuth, async (req, res) => {
  const logId = db.logSyncStart();
  try {
    // Gateway caps result sets at 5,000 rows — paginate by period_code (each period ~800 MATERIAL rows)
    const periodsRes = await queryGateway('erp_item_cost_riyadh', `
      SELECT DISTINCT period_code FROM data WHERE cost_component_class = 'MATERIAL' ORDER BY period_code
    `);
    const periods = (periodsRes.rows || []).map(r => r.period_code || r.PERIOD_CODE).filter(Boolean);

    let n = 0;
    for (const period of periods) {
      const priced = await queryGateway('erp_item_cost_riyadh', `
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
        // Derive start_date from period_code (MMM-YY) so latest-per-item sort works chronologically
        start_date: periodToDate(r.period_code || r.PERIOD_CODE),
      }));
      n += db.upsertCostRows(costRows);
    }

    // POS→ERP bridge. Primary source: pos_erp_item_map (Oracle-maintained, canonical).
    // Fallback: v_inventory_items.export_id for items not in the map (denormalised copy, can lag).
    const bridgeRes = await queryGateway('pos_erp_item_map', `
      SELECT POS_ITEM_ID, POS_ITEM_DESCRIPTION, ERP_ITEM_ID, ERP_ITEM_UNIT,
             PG_ITEM_UNIT, PRIMARY_UOM, CONV_FACTOR_PG_UOM_TO_ERP_PUOM, STATUS, ITEM_TYPE
      FROM data
      WHERE STATUS = 'Active' AND ERP_ITEM_ID IS NOT NULL
    `);
    const bridgeRows = (bridgeRes.rows || []).map(r => ({
      inv_item_id: String(r.POS_ITEM_ID || r.pos_item_id),
      description: r.POS_ITEM_DESCRIPTION || r.pos_item_description,
      recipe_unit: r.PG_ITEM_UNIT || r.pg_item_unit,
      stockroom_unit: r.PRIMARY_UOM || r.primary_uom,
      equivalence: r.CONV_FACTOR_PG_UOM_TO_ERP_PUOM || r.conv_factor_pg_uom_to_erp_puom,
      export_id: String(r.ERP_ITEM_ID || r.erp_item_id || '').trim(),
    })).filter(r => r.inv_item_id && r.export_id);

    // Fallback rows from v_inventory_items for POS items NOT in the bridge (covers legacy items)
    const knownIds = new Set(bridgeRows.map(r => r.inv_item_id));
    const fallbackRes = await queryGateway('RedShift', `
      SELECT inv_item_id, description, recipe_unit, stockroom_unit, equivalence, export_id
      FROM (
        SELECT inv_item_id, description, recipe_unit, stockroom_unit, equivalence,
               TRIM(export_id) AS export_id, ts,
               ROW_NUMBER() OVER (
                 PARTITION BY inv_item_id
                 ORDER BY
                   CASE WHEN TRIM(export_id) ~ '^[A-Za-z]' THEN 0 ELSE 1 END,
                   ts DESC NULLS LAST,
                   branch_id
               ) AS rn
        FROM maestroksa.v_inventory_items
        WHERE export_id IS NOT NULL AND TRIM(export_id) <> ''
      ) t
      WHERE rn = 1
    `);
    const fallbackRows = (fallbackRes.rows || [])
      .map(r => ({
        inv_item_id: String(r.inv_item_id),
        description: r.description,
        recipe_unit: r.recipe_unit,
        stockroom_unit: r.stockroom_unit,
        equivalence: r.equivalence,
        export_id: (r.export_id || '').trim(),
      }))
      .filter(r => !knownIds.has(r.inv_item_id));

    const mapRows = bridgeRows.concat(fallbackRows);
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

// GET /api/ingredients/from-pos — distinct items used in POS recipes (food + packaging only),
// each joined to v_inventory_items export_id + latest EBS cost
app.get('/api/ingredients/from-pos', requireAuth, async (req, res) => {
  try {
    // Pull distinct (inv_item_id, family) pairs from v_recipes (template branch only).
    // Exclusions:
    //  - sub-recipe components (items that are themselves sale_items) — composite recipe stages, not raw ingredients
    //  - finished goods (FG* prefix) — sale items, not ingredients
    //  - orphan test IDs (7xx legacy) — null description / available='N' / dead rows
    //  - explicit placeholders containing FAKE
    const r = await queryGateway('RedShift', `
      SELECT DISTINCT r.inv_item_id, r.inv_item_description, r.sale_item_family_group
      FROM maestroksa.v_recipes r
      WHERE r.branch_id = -1
        AND r.inv_item_description IS NOT NULL
        AND TRIM(r.inv_item_description) <> ''
        AND r.inv_item_id NOT LIKE 'FG%'
        AND UPPER(r.inv_item_description) NOT LIKE '%FAKE%'
        AND r.inv_item_id NOT IN (
          SELECT DISTINCT sale_item_id FROM maestroksa.v_recipes WHERE branch_id = -1
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
      const price = latest ? normalisePrice(latest.accounting_cost, latest.uom, latest.item_desc) : null;
      return {
        invItemId: invId,
        name: a.name,
        families: Array.from(a.families),
        erpCode,
        recipeUnit: map ? map.recipe_unit : null,
        stockroomUnit: map ? map.stockroom_unit : null,
        equivalence: map ? map.equivalence : null,
        latestCost: latest ? {
          periodCode: latest.period_code,
          accountingCost: latest.accounting_cost,
          uom: latest.uom,
          pricePerKg: price && price.unit === 'kg' ? price.perUnit : null,
          pricePerPiece: price && price.unit === 'piece' ? price.perUnit : null,
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
          const n = normalisePrice(latest.accounting_cost, latest.uom, latest.item_desc);
          price = {
            itemNumber: map.export_id,
            itemDesc: latest.item_desc,
            uom: latest.uom,
            periodCode: latest.period_code,
            accountingCost: latest.accounting_cost,
            pricePerKg: n.unit === 'kg' ? n.perUnit : null,
            pricePerPiece: n.unit === 'piece' ? n.perUnit : null,
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
    const safeName = key.replace(/[^a-zA-Z0-9._-]/g, '_') + '.jpg';
    fs.writeFileSync(IMG_DIR + '/' + safeName, buffer);
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
