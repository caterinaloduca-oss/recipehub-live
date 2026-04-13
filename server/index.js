const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'Q6LuvWGdHgETdfv4kFSHnzcxthg0_LTGhGytrwn35uY';
const GATEWAY_URL = 'https://gateway.dailyfoodsa.com/mcp';
const GATEWAY_KEY = 'df_svc_ls8XudEeqGUeLMIF4nFBVYhjMO668s-T4nqbAYOHyqM';
const USDA_API_KEY = process.env.USDA_API_KEY || 'JJy37GOw4VaboMD3l8o1gyVlYMCQYUmkUjDEakl9';

// ── EMAIL NOTIFICATIONS ──
const nodemailer = require('nodemailer');
const MAIL_FROM = 'caterina.loduca@dailyfoodsa.com';
const MAIL_TRANSPORT = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: MAIL_FROM, pass: 'thqw gzkd wklg ovyf' },
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

app.use(cors());
app.use(express.json({ limit: '50mb' }));

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
const { execSync } = require('child_process');
function queryGateway(source, sql) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'query', arguments: { source, sql } },
    id: Date.now(),
  });
  const escaped = payload.replace(/'/g, "'\\''");
  const cmd = `curl -s --max-time 30 -X POST "${GATEWAY_URL}" ` +
    `-H "Content-Type: application/json" ` +
    `-H "Accept: application/json, text/event-stream" ` +
    `-H "Authorization: Bearer ${GATEWAY_KEY}" ` +
    `-d '${escaped}'`;
  const text = execSync(cmd, { encoding: 'utf8', timeout: 35000 });
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
    const savedAt = db.setState(JSON.stringify(body), body.dataVersion || 0);
    res.json({ ok: true, savedAt });
  } catch (err) {
    console.error('POST /api/data error:', err);
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// ── EBS PRICE ENDPOINTS ──

// GET /api/ebs/prices — all ingredient prices with supplier info
app.get('/api/ebs/prices', requireAuth, (req, res) => {
  try {
    // Get items with avg price
    const items = queryGateway('RedShift', `
      SELECT DISTINCT inv_item_id, description, recipe_unit, avg_purchase_price, allergens, expiry_days
      FROM maestroksa.v_inventory_items
      WHERE avg_purchase_price > 0 AND available = 'Y'
      ORDER BY description
    `);

    // Get vendor prices
    const vendors = queryGateway('RedShift', `
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
app.get('/api/ebs/search', requireAuth, (req, res) => {
  try {
    const raw = (req.query.q || '').trim();
    if (!raw || raw.length < 2) return res.json({ results: [] });
    // Sanitize: only allow letters, numbers, spaces, hyphens
    const q = raw.replace(/[^a-zA-Z0-9 \-]/g, '').toLowerCase();
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
    const vendorData = queryGateway('RedShift', `
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
      const glData = queryGateway('RedShift', `
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
        recipients = getEmailsByRole(['factory']);
        subject = `Factory Trial requested: ${recipe}`;
        html = `<h2 style="color:#1B2A4A;margin:0 0 12px">${recipe}</h2>
          <p><strong>${userName}</strong> sent this recipe to <span style="color:#1A5FA5;font-weight:600">Factory Trial</span>.</p>
          <p>A production run has been created. Please schedule a date.</p>
          <p style="margin-top:16px"><a href="https://recipehub.dailyfoodsa.com" style="background:#1A5FA5;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">View Production Plan</a></p>`;
        break;

      case 'recipe-prod-trial':
        recipients = getEmailsByRole(['factory', 'qa']);
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

app.post('/api/library/upload', requireAuth, (req, res) => {
  try {
    const { id, fileName, data } = req.body;
    if (!id || !fileName || !data) return res.status(400).json({ error: 'id, fileName, data required' });
    // data is a base64 data URL
    const matches = data.match(/^data:(.+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Invalid file data' });
    const buffer = Buffer.from(matches[2], 'base64');
    const ext = fileName.split('.').pop().toLowerCase();
    const safeName = id + '.' + ext;
    fs.writeFileSync(DOCS_DIR + '/' + safeName, buffer);
    res.json({ ok: true, url: '/docs/' + safeName });
  } catch (err) {
    console.error('Library upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// ── COMMUNICATIONS ──

// POST /api/comms/send — send email to recipients
app.post('/api/comms/send', requireAuth, (req, res) => {
  try {
    const { to, subject, html, sentBy } = req.body;
    if (!to || !to.length || !subject) {
      return res.status(400).json({ error: 'to and subject required' });
    }
    const recipients = Array.isArray(to) ? to : [to];
    const fullHtml = `<h2 style="color:#1B2A4A;margin:0 0 12px">${subject}</h2>
      ${html}
      <hr style="border:none;border-top:1px solid #E8E6E1;margin:20px 0" />
      <p style="font-size:11px;color:#999">Sent by ${sentBy || 'Admin'} via <a href="https://recipehub.dailyfoodsa.com">RecipeHub</a></p>`;

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
