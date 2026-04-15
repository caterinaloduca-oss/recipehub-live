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
      // Merge production runs by ID
      if (old.productionRuns && old.productionRuns.length) {
        if (!body.productionRuns) body.productionRuns = [];
        const existingIds = new Set(body.productionRuns.map(r => r.id));
        old.productionRuns.forEach(r => { if (r.id && !existingIds.has(r.id)) body.productionRuns.push(r); });
      }
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

// ── EBS PRICE ENDPOINTS ──

// GET /api/ebs/prices — all ingredient prices with supplier info
app.get('/api/ebs/prices', requireAuth, async (req, res) => {
  try {
    // Get items with avg price
    const items = await queryGateway('RedShift', `
      SELECT DISTINCT inv_item_id, description, recipe_unit, avg_purchase_price, allergens, expiry_days
      FROM maestroksa.v_inventory_items
      WHERE avg_purchase_price > 0 AND available = 'Y'
      ORDER BY description
    `);

    // Get vendor prices
    const vendors = await queryGateway('RedShift', `
      SELECT v.item_id, v.purchase_price, v.vendor_name
      FROM maestroksa.v_inventory_items_vendors v
      WHERE v.purchase_price > 0
      ORDER BY v.item_id
    `);

    // Build vendor map (item_id -> [{vendor, price}])
    const vendorMap = {};
    for (const v of vendors.rows) {
      if (!vendorMap[v.item_id]) vendorMap[v.item_id] = [];
      // Avoid duplicate vendor entries
      const exists = vendorMap[v.item_id].find(x => x.vendor === v.vendor_name && x.price === v.purchase_price);
      if (!exists) {
        vendorMap[v.item_id].push({ vendor: v.vendor_name, price: v.purchase_price });
      }
    }

    // Merge into a clean response
    const prices = [];
    const seen = new Set();
    for (const item of items.rows) {
      const key = item.inv_item_id + '|' + item.description;
      if (seen.has(key)) continue;
      seen.add(key);
      prices.push({
        code: item.inv_item_id,
        name: item.description,
        unit: item.recipe_unit,
        avgPrice: item.avg_purchase_price,
        allergens: item.allergens,
        expiryDays: item.expiry_days,
        vendors: vendorMap[item.inv_item_id] || [],
      });
    }

    res.json({
      count: prices.length,
      updatedAt: new Date().toISOString(),
      prices,
    });
  } catch (err) {
    console.error('EBS prices error:', err);
    res.status(500).json({ error: 'Failed to fetch EBS prices: ' + err.message });
  }
});

// GET /api/ebs/search?q=tomato — search items by name, return per-kg price
app.get('/api/ebs/search', requireAuth, async (req, res) => {
  try {
    const raw = (req.query.q || '').trim();
    if (!raw || raw.length < 2) return res.json({ results: [] });
    // Sanitize: only allow letters, numbers, spaces — no SQL-significant chars
    const q = raw.replace(/[^a-zA-Z0-9 ]/g, '').toLowerCase().slice(0, 100);
    if (!q) return res.json({ results: [] });

    // Helper: try to extract weight in kg from description (e.g. "700g", "2.5KG", "10 Ltr", "4.25 kg/can")
    function parseWeightKg(desc) {
      // Match patterns like "700g", "700 g", "2.5kg", "10 Ltr", "4.25 kg/can"
      const m = desc.match(/(\d+\.?\d*)\s*(kg|g|gr|gram|ltr|litre|liter|ml)\b/i);
      if (!m) return null;
      const val = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      if (unit === 'kg') return val;
      if (unit === 'g' || unit === 'gr' || unit === 'gram') return val / 1000;
      if (unit === 'ltr' || unit === 'litre' || unit === 'liter') return val; // 1 ltr ≈ 1 kg
      if (unit === 'ml') return val / 1000;
      return null;
    }

    // Also check for multiplier like "X12", "6x", etc.
    function parseMultiplier(desc) {
      const m = desc.match(/\b[xX](\d+)\b|\b(\d+)\s*[xX]\s*\d/);
      if (m) return parseInt(m[1] || m[2]) || 1;
      return 1;
    }

    // Primary: vendor prices with equivalence → per-kg cost
    const vendorData = await queryGateway('RedShift', `
      SELECT DISTINCT i.inv_item_id, i.description, i.recipe_unit, i.equivalence,
             i.stockroom_unit, v.purchase_price, v.vendor_unit, v.vendor_name
      FROM maestroksa.v_inventory_items i
      JOIN maestroksa.v_inventory_items_vendors v ON v.item_id = i.inv_item_id
      WHERE v.purchase_price > 0 AND i.equivalence > 0
        AND LOWER(i.description) LIKE '%${q}%'
      LIMIT 40
    `);

    const map = {};
    for (const r of vendorData.rows) {
      let pricePerKg = null;
      if (r.recipe_unit === 'kg' && r.equivalence > 0) {
        // Direct: purchase_price / equivalence = SAR per kg
        pricePerKg = r.purchase_price / r.equivalence;
      } else if (r.recipe_unit === 'ltr' && r.equivalence > 0) {
        // 1 ltr ≈ 1 kg for most food liquids
        pricePerKg = r.purchase_price / r.equivalence;
      } else {
        // Try to parse weight from description
        const wt = parseWeightKg(r.description);
        const mult = parseMultiplier(r.stockroom_unit || '');
        if (wt && wt > 0) {
          const totalKg = wt * mult * (r.equivalence || 1);
          pricePerKg = r.purchase_price / totalKg;
        }
      }

      const key = r.inv_item_id;
      if (!map[key] || (pricePerKg && pricePerKg > (map[key].pricePerKg || 0))) {
        map[key] = {
          code: r.inv_item_id,
          name: r.description,
          unit: 'kg',
          originalUnit: r.recipe_unit,
          equivalence: r.equivalence,
          purchasePrice: r.purchase_price,
          pricePerKg: pricePerKg,
          avgPrice: pricePerKg || r.purchase_price,
          vendor: r.vendor_name,
          vendors: [],
        };
      }
      const exists = map[key].vendors.find(x => x.vendor === r.vendor_name);
      if (!exists) map[key].vendors.push({ vendor: r.vendor_name, price: r.purchase_price });
    }

    // Fallback: GL cost for items not found via vendor route
    try {
      const glData = await queryGateway('RedShift', `
        SELECT item, description, uom, gl_cost
        FROM erp.inv_item_cost
        WHERE LOWER(description) LIKE '%${q}%' AND gl_cost > 0
        ORDER BY start_date DESC
        LIMIT 20
      `);
      for (const r of glData.rows) {
        if (!map[r.item]) {
          const cost = parseFloat(r.gl_cost) || 0;
          let pricePerKg = null;
          const uom = (r.uom || '').toUpperCase();
          if (uom === 'KG') {
            pricePerKg = cost;
          } else {
            // Try weight from description
            const wt = parseWeightKg(r.description);
            if (wt && wt > 0) pricePerKg = cost / wt;
          }
          map[r.item] = {
            code: r.item,
            name: r.description,
            unit: pricePerKg ? 'kg' : (r.uom || 'unit'),
            originalUnit: r.uom,
            pricePerKg: pricePerKg,
            avgPrice: pricePerKg || cost,
            vendor: '',
            vendors: [],
          };
        }
      }
    } catch (e) { /* GL fallback is optional */ }

    res.json({ results: Object.values(map) });
  } catch (err) {
    console.error('EBS search error:', err);
    res.status(500).json({ error: 'Failed to search EBS: ' + err.message });
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
