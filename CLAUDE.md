# CLAUDE.md — Daily Food SA Workspace

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

This is the **Daily Food SA** internal tools workspace containing three independent applications:

- **RecipeHub** (`recipe hub/`) — Recipe management platform for food manufacturing
- **SensoryHub** (`sensoryhub/`) — Sensory Master Tester Championship management app
- **Taste Check** (`Sensory Hub/tastecheck/`) — Weekly sensory evaluation recording tool

All apps are internal tools for Daily Food SA employees, authenticated via `@dailyfoodsa.com` email addresses.

## RecipeHub

Single-file HTML application (`RecipeHub-App-v2.html`, ~12.7K lines) + Node/Express backend (`server/`).

- **Full docs**: See `recipe hub/CLAUDE.md` for architecture, workflows, roles, and critical rules
- **Section map**: See `recipe hub/RECIPEHUB-MAP.md` for line-by-line navigation
- **Live**: `recipehub.dailyfoodsa.com`
- **Deploy**: Push to `main` triggers GitHub Actions SCP to VPS
- **Backend**: Node/Express + SQLite on VPS port 3002, bearer token auth, nginx proxy at `/api/`

### Key Workflows
- **Recipe lifecycle**: Draft → In Review → Factory Trial → Prod Trial → Approved (R&D drives, QA gates). **Factory must assign a Recipe ID (e.g. `211_BCS v1`) before R&D can move Factory Trial → Prod Trial** — the NPD code stays as historical tracker
- **Production runs**: Pending → Scheduled → Completed (Factory manages dates/completion)
- **Food cost**: Ingredient cost (auto from DB or manual override) → yield-adjusted → portion cost → food cost %
- **Branch SOPs**: Color-coded per brand, components with 2nd shelf life, print view. Deleting a Build now cascade-deletes its linked Branch SOPs
- **7 roles**: Admin, R&D (`npd`), QA, Factory, OPS, Purchasing, Viewer — OPS is branches-only (never include in factory/recipe/QA permissions)

### Key Data Conventions
- **`npd` field** is the recipe's primary key. Two formats live in prod: `YYYY-NNN` for R&D-pipeline recipes (auto-generated), and `211_XXX` / `212_XXX` for factory codes (Meat / Bakery lines) brought in via bulk import
- **`recipeId`** is the versioned factory code (`211_BCS v1`), assigned by Factory at the Trial-Passed gate; displayed as a green chip on the recipe detail
- **Ingredient shape** carries `itemCode` (Oracle EBS code, e.g. `RMADT0013`) and `type` (Main / Packaging / Batter / Predust / …) alongside `name` + `pct`. Rendered as a small grey pill next to the ingredient name
- **Bulk-import tag**: imported recipes carry `source: "bulk_import_2026-04"` + `importedAt`. Filter by that field for surgical rollback, never by the `[IMPORT]` title prefix (user-editable). 153 factory recipes imported 2026-04-23 via `~/recipe-hub-dev/bulk_import_recipes.py`; full backup + snapshot + rollback plan in `~/recipe-hub-dev/backups/` and `~/recipe-hub-dev/ROLLBACK.md`
- **Delete protection**: `deletedRecipeIds`, `deletedSOPIds`, `deletedBuildIds` are merged server-side on every `POST /api/data` — stale tabs cannot resurrect deleted entries. Seed-re-add paths on client also filter against these lists
- **Factory SOP data model** (3 distinct fields on a recipe):
  - `r.method` = kitchen recipe instructions (list of `{title, text}`) — came from the Excel import
  - `r.sopStandardBlocks` = list of shared-block **ids** toggled ON for this recipe. Unset → falls back to library's `defaultOn` set
  - `r.sopSteps` = recipe-specific production steps, shape `{title, text, icons?, params?, ccp?, warning?}`. Icons use short keys: `temp / time / weight / hygiene / danger / check / photo / tip`. Params use `{l, v}` (not `{name, value}`). CCP is a string like `"CCP 8"`
- **Shared Blocks library** (`data.sopStandardBlocks`, 22 blocks live as of 2026-04-24): 11 pre-prod (3.0, 3.1, 3.1b, 3.2–3.9) + 11 post-prod (3.10–3.20). Block shape: `{id, num, title, position:"pre"|"post", body, ccp, oprp, defaultOn, annexures:[{code,name}], tags}`. Editing the library is blob-level (POST `/api/data`) — there's no dedicated `/api/sop/blocks` endpoint
- **Factory SOP rollout artifacts** (all in `~/recipe-hub-dev/`, gitignored):
  - Phase 0 (blocks seed): `ROLLBACK_blocks.md`, `backups/existing_blocks_snapshot.json`
  - Phase A (toggles): `ROLLBACK_toggles.md`, `block_toggle_log.csv` (153 rows), `backups/existing_toggles_snapshot.json`
  - Phase B (production steps): `ROLLBACK_productionsteps.md`, `production_steps_log.csv` (76 rows), `backups/existing_production_steps_snapshot.json`
  - Phase C (images) — pending

### Quick Start
1. Edit `RecipeHub-App-v2.html` and push. No install needed for the frontend.
2. Server: `cd server && npm install && node index.js`
3. Use `RECIPEHUB-MAP.md` to find the right section — don't read the full file.

## SensoryHub

Vite + React 19 app with Express + SQLite backend on VPS (pm2).

- **Full docs**: See `sensoryhub/CLAUDE.md` for details
- **Section map**: See `sensoryhub/SENSORYHUB-MAP.md` for App.jsx navigation
- **Live**: `sensoryhub.dailyfoodsa.com`
- **Local path**: `/Users/caterina/Desktop/Documents/Projects/sensoryhub/` (not under `Sensory Hub/` anymore)
- **Backend**: `/opt/sensoryhub-api/` on VPS 80.238.219.206, port 3001, pm2 process `sensoryhub-api`, nginx proxy at `/api/`
- **Auth**: bearer token (`API_TOKEN` env) — must match `VITE_API_TOKEN` baked into frontend build

### Quick Start
```bash
cd sensoryhub && npm install
cd server && npm start          # Backend on :3001
cd .. && npm run dev             # Frontend on :5174 (or 5173)
```

### Before Deploying
1. Bump `APP_VERSION` in `src/App.jsx` (format: `YYYYMMDD-HHMM`)
2. `VITE_API_TOKEN=<prod-token> npx vite build` — token must match backend's `API_TOKEN`
3. `rsync -avz dist/ root@80.238.219.206:/var/www/sensoryhub/` — **do NOT use `--delete`**: session PDFs (e.g. `session1_scans.pdf`) live at the webroot and would be wiped.

### Backend Deploy (when server/ changes)
1. Snapshot DB first: `ssh root@80.238.219.206 "TS=\$(date +%Y%m%d-%H%M%S); cd /opt/sensoryhub-api/data && cp sensoryhub.db sensoryhub.db.bak-\$TS && cp sensoryhub.db-wal sensoryhub.db-wal.bak-\$TS && cp sensoryhub.db-shm sensoryhub.db-shm.bak-\$TS"`
2. `rsync -avz server/server.js server/package.json server/package-lock.json root@80.238.219.206:/opt/sensoryhub-api/`
3. `ssh root@80.238.219.206 "cd /opt/sensoryhub-api && npm install && pm2 restart sensoryhub-api --update-env"`
4. **SMTP password rotation**: use the in-app **Settings ⚙️ → Email / SMTP** tab (stored in `smtp_config` table, test-before-save). Only edit `/opt/sensoryhub-api/ecosystem.config.cjs` if the in-app flow is broken.

### Notable Features (v2026-04-19)
- Hash routing: `/#rsvp`, `/#checkin` deep-link to those pages
- Comms: emails can attach real meeting invites (ICS with method REQUEST, per-recipient ATTENDEE line). Toggled per-comm via `includeInvite` flag; templates available via Quick Template row
- Survey Templates (admin): Triangle / Hedonic-JAR / Comparative — **Apply / Edit / Duplicate / Preview** per card; duplicates get new id `copy-{ts}` and open editor
- **Email / SMTP in-app config**: admin rotates Gmail app password without SSH; DB overrides env vars
- **Send-email auth fix**: Communications → Send now includes Bearer token (was silently 401'ing)
- Staff flag (`p.staff===true`) excludes participant from leaderboards/quotas/surveys but keeps them in comms recipients

## Taste Check

Vite + React 19 app with Express backend. Lightweight sensory evaluation recorder.

- **Full docs**: See `Sensory Hub/tastecheck/CLAUDE.md` for architecture, deployment, and data model
- **Section map**: See `Sensory Hub/tastecheck/TASTECHECK-MAP.md` for App.jsx navigation
- **Live**: `tastecheck.dailyfoodsa.com` (pending DNS)

### Quick Start
```bash
cd "Sensory Hub/tastecheck" && npm install
cd server && npm start          # Backend on :3003
cd .. && npm run dev             # Frontend on :5173
```

### Before Deploying
1. Bump `APP_VERSION` in `src/App.jsx` (format: `YYYYMMDD-HHMM`)
2. `npx vite build`
3. `rsync -avz --delete dist/ root@80.238.219.206:/var/www/tastecheck/dist/`
4. `rsync -avz --exclude='node_modules' --exclude='data' --exclude='uploads' server/ root@80.238.219.206:/var/www/tastecheck/server/`
5. If server code changed: `ssh root@80.238.219.206 "cd /var/www/tastecheck/server && npm install && pm2 restart tastecheck-api"`

## Shared Patterns

- All apps use **single-file architectures** — avoid splitting unless explicitly asked
- All use **Outfit** (headings) and **DM Sans** (body) font families
- Admin access keyed to `caterina.loduca@dailyfoodsa.com`
- No app uses TypeScript, external UI libraries, or CSS frameworks
- SensoryHub and Taste Check share the same VPS, Google OAuth client ID, and patterns

## Known Pain Points

- **RecipeHub file size**: ~12.7K lines. Use the section map. Read only what you need.
- **RecipeHub sync**: Server-backed (SQLite), last-write-wins. localStorage as offline fallback.
- **Variable hoisting**: A single `let`/`const` before definition kills ALL JS in RecipeHub.
- **SensoryHub prod backend is at `/opt/sensoryhub-api/`**, NOT in the repo — rsync updates to that path, not `/var/www/sensoryhub/server/` (which doesn't exist). pm2 process is `sensoryhub-api`.
- **SensoryHub local path**: `/Users/caterina/Desktop/Documents/Projects/sensoryhub/` (was previously `Sensory Hub/sensoryhub/` — moved out on 2026-04-19).
- **Taste Check has a production backend**: Express + SQLite on VPS port 3003, managed by pm2.
- **No tests in any app**: Deploy without automated verification. Be careful.
- **GitHub Actions can fail**: VPS SSH times out. Deploy manually with `scp`/`rsync` if needed.
- **RecipeHub server auto-deploy is HTML-only**: Push to `main` only deploys `RecipeHub-App-v2.html`. Changes to `server/*.js` need manual `rsync` to `/var/www/recipehub/server/` + `systemctl restart recipehub-api` on VPS.
- **RecipeHub `mergeRecipe()` is last-writer-wins**: the per-recipe `POST /api/recipe/:npd` endpoint will overwrite colliding fields if `incoming.updatedAt > existing.updatedAt`. Never POST a colliding `npd` unless you explicitly want to replace it. The bulk import uses a preflight existence-Set to enforce create-only client-side.
