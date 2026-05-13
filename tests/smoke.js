#!/usr/bin/env node
/**
 * RecipeHub smoke tests — run on every push by GitHub Actions, and
 * locally via `node tests/smoke.js`. The point is not exhaustive
 * coverage; the point is to catch the specific classes of bug that
 * have actually bitten us:
 *
 *   1. JS in RecipeHub-App-v2.html doesn't parse (boot crash → app
 *      renders the shell but no data loads). Cate hit this on
 *      2026-05-12 when a `var X = {...}` declared AFTER a top-level
 *      call made X undefined at call time.
 *   2. server/index.js doesn't parse (PM2 restart fails, API 502).
 *   3. A function is defined twice — last definition silently wins.
 *      (Memory: feedback_replace_dont_duplicate.md)
 *   4. The HTML references a DOM id that doesn't exist (filter chip
 *      containers, sidebar diag etc.) — silently breaks the feature.
 *
 * Exit code 0 = all checks pass.
 * Exit code 1 = at least one check failed (logs which).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'RecipeHub-App-v2.html');
const SERVER_PATH = path.join(ROOT, 'server/index.js');

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const pass = (msg) => { console.log('PASS:', msg); };

// ── 1. HTML loads ────────────────────────────────────────────────
const html = (() => {
  try { return fs.readFileSync(HTML_PATH, 'utf8'); }
  catch (e) { fail('Could not read RecipeHub-App-v2.html: ' + e.message); process.exit(1); }
})();
pass(`Read RecipeHub-App-v2.html (${html.length.toLocaleString()} bytes)`);

// ── 2. Every <script> block parses ────────────────────────────────
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
let parseFails = 0;
scripts.forEach((m, i) => {
  try { new Function(m[1]); }
  catch (e) {
    fail(`HTML <script> block #${i} parse error: ${e.message.split('\n')[0]}`);
    parseFails++;
  }
});
if (!parseFails) pass(`All ${scripts.length} HTML <script> blocks parse`);

// ── 3. server/index.js parses ─────────────────────────────────────
try {
  const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');
  new Function(serverSource);   // throws on syntax error
  pass('server/index.js parses');
} catch (e) {
  fail('server/index.js parse error: ' + (e.message.split('\n')[0] || e.message));
}

// ── 4. No duplicate TOP-LEVEL function definitions ────────────────
// Only top-level functions live on the global namespace; the risk is
// two `function X()` declarations at column 0, where the second
// silently overwrites the first. Nested function declarations
// (indented, inside another function) are scoped to their parent
// and are safe — those are NOT flagged.
const allJs = scripts.map(m => m[1]).join('\n');
const topLevelFnDefs = {};
// Match function declarations that begin a line with no leading whitespace.
const topFnRe = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
let m;
while ((m = topFnRe.exec(allJs))) {
  const name = m[1];
  topLevelFnDefs[name] = (topLevelFnDefs[name] || 0) + 1;
}
const topDupes = Object.entries(topLevelFnDefs).filter(([_, n]) => n > 1);
if (topDupes.length === 0) {
  pass(`No duplicate top-level function definitions (${Object.keys(topLevelFnDefs).length} unique)`);
} else {
  topDupes.forEach(([name, count]) => {
    fail(`Top-level function "${name}" defined ${count} times — last wins silently. Rename or delete extras.`);
  });
}
// We still want a count of every function (for the handler check below).
const fnDefs = {};
const fnDefRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
while ((m = fnDefRe.exec(allJs))) {
  fnDefs[m[1]] = (fnDefs[m[1]] || 0) + 1;
}

// ── 5. Every inline onclick handler refers to a defined function ──
// Catches typos like onclick="_clearRecipFilter(..." (missing 'e').
// Only checks the leading identifier before '(' so it ignores arrows
// like `() => doThing()`.
// Only on* event-attribute names — not "onmouseover" inside a style URL,
// not CSS color functions. We require the attribute to be preceded by
// whitespace AND followed by ="...". The previous regex also matched
// substrings inside style="..." values (rgba(...) was tripping).
const onclickRe = /(?:^|\s)on(?:click|change|input|blur|focus|submit|dragover|dragleave|drop|dragstart|dragend|mouseover|mouseout|keydown)="([^"]+)"/g;
const inlineHandlerNames = new Set();
let h;
while ((h = onclickRe.exec(html))) {
  const code = h[1];
  // Split into statements + match identifiers ONLY at the start of a statement
  // or after operators like ; or && / || / ? / :. Skip identifiers preceded by
  // a member-access dot, an equals sign or quote (those are method calls or
  // values inside strings like 'rgba(...)').
  const stmts = code.split(/;|&&|\|\|/);
  stmts.forEach(stmt => {
    const idMatch = stmt.match(/(?:^|\s|\?|:|,|\()\s*([A-Za-z_$][\w$]*)\s*\(/);
    if (idMatch && idMatch[1]) inlineHandlerNames.add(idMatch[1]);
  });
}
// Whitelist global / browser-builtin / DOM-method handlers
const browserBuiltins = new Set([
  'alert','confirm','prompt','setTimeout','setInterval','parseInt','parseFloat',
  'String','Number','Boolean','Array','Object','Date','Math','JSON','console',
  'event','document','window','this','if','for','while','return','var','let','const',
  'function','new','delete','typeof','void','true','false','null','undefined',
  'fetch','localStorage','sessionStorage','encodeURIComponent','decodeURIComponent',
  'Promise','async','await',
]);
const handlerMisses = [];
inlineHandlerNames.forEach(name => {
  if (browserBuiltins.has(name)) return;
  // Function defined in our own JS?
  if (fnDefs[name]) return;
  // Defined as `var name = function`?
  const varFnRe = new RegExp('(?:var|let|const|window\\.)\\s+' + name + '\\s*=', 'g');
  if (varFnRe.test(allJs)) return;
  // It might be a method like obj.method(...) — we already trimmed those above
  handlerMisses.push(name);
});
if (handlerMisses.length === 0) {
  pass(`All ${inlineHandlerNames.size} inline event handlers reference defined functions`);
} else {
  handlerMisses.forEach(n => fail(`Inline event handler "${n}(...)" has no matching function definition (typo?)`));
}

// ── 6. Build/deploy placeholder is in the HTML ────────────────────
if (html.includes('__RH_BUILD__')) {
  pass('rh-build meta placeholder present (will be stamped at deploy)');
} else {
  fail('Missing <meta name="rh-build" content="__RH_BUILD__"> — deploy stamp won\'t fire');
}

// ── 7. Hardcoded admin email matches the documented admin ─────────
// Cate's email is the only hardcoded admin; if that changes we want
// to know (it gates 'cannot lock self out' behavior).
if (html.includes('caterina.loduca@dailyfoodsa.com')) {
  pass('Hardcoded admin email present (Caterina)');
} else {
  fail('Hardcoded admin fallback "caterina.loduca@dailyfoodsa.com" is missing — admin lockout risk');
}

// ── 8. Summary ────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log(`✅ Smoke OK — ${Object.keys(fnDefs).length} functions checked, ${inlineHandlerNames.size} inline handlers validated`);
  process.exit(0);
} else {
  console.error(`❌ ${failures} check(s) failed — see above`);
  process.exit(1);
}
