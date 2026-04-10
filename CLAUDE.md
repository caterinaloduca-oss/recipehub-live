# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **Daily Food SA** internal tools workspace containing two independent applications:

- **RecipeHub** (`recipe hub/`) — Recipe management platform for food manufacturing
- **SensoryHub** (`Sensory Hub/sensoryhub/`) — Sensory Master Tester Championship management app

Both apps are internal tools for Daily Food SA employees, authenticated via `@dailyfoodsa.com` email addresses.

## RecipeHub

### Architecture
Single-file HTML application (`RecipeHub-App-v2.html`, ~11K lines). All CSS, HTML, and JavaScript live in one file. There is no build step — the HTML file is the entire app.

- **State**: All data persisted to `localStorage` via `saveAllData()` / `loadAllData()`. **Critical**: ALL save paths must go through `saveAllData()` — never write to localStorage with a hardcoded field list (this caused a data loss bug where brands and other fields were silently wiped on refresh)
- **UI**: Vanilla JS with DOM manipulation. Sidebar navigation switches between pages (dashboard, recipes, ingredients, users, builds, production, branch SOPs, brands)
- **Styling**: CSS custom properties defined in `:root` (navy/gold/sage theme, Outfit + DM Sans fonts)
- **Data gateway**: Connects to Oracle EBS via MCP gateway at `gateway.dailyfoodsa.com` for live item/inventory data

### Deployment
- Hosted at `recipehub.dailyfoodsa.com` (CNAME in repo root)
- GitHub Actions workflow (`.github/workflows/deploy.yml`) SCPs the HTML file to the VPS on push to `main`, then copies it to `index.html`
- The landing page (`RecipeHub-Landing.html`) is a separate marketing/info page, not the app itself

### Critical: Variable Hoisting
**Never reference `let`/`const` variables before their definition line.** In a single-file HTML app, a reference-before-definition error kills ALL JavaScript execution, making the entire app appear empty. Always place IIFEs and initialization code after variable definitions.

### Critical: Single Save Function
**All localStorage writes must go through `saveAllData()`.** There must be no other code path that writes to `STORAGE_KEY` with its own field list. A `beforeunload` handler and a user-merge path previously had duplicate save logic that was missing newer fields (brands, activity log, savings, QA allergen overrides), causing silent data loss on every refresh.

### Critical: Dynamic Brand System
**All brand-dependent UI is generated dynamically from the `BRANDS` array.** Never hardcode brand names in dropdowns, CSS, checkboxes, color maps, or stat counters. Use the helper functions:
- `brandOptionsHTML(selected)` — returns `<option>` HTML for any brand `<select>`
- `getBrandColors()` — returns `{brandName: color}` map
- `populateBrandUI()` — master function that syncs all brand UI (dropdowns, CSS, checkboxes, builds stats). Called at init, on brand create/edit/delete, and on backup restore.

### Critical: No Hardcoded Seed Data in Arrays
**Data arrays that are persisted to localStorage should start empty** (e.g. `PRODUCTION_RUNS = []`). Hardcoded seed data reappears on every deploy if localStorage doesn't have that key, showing stale demo content. Exceptions: `RECIPE_DB`, `BRANDS`, `BUILDS_DATA`, and `BRANCH_SOPS` use smart merge logic that preserves hardcoded reference data while respecting saved state.

### QA Page
The QA recipe dropdown is **dynamically populated from `RECIPE_DB`** via `populateQARecipeDropdown()`. Never hardcode recipe lists or shorthand keys. The current recipe NPD is tracked in `_qaCurrentNPD`.

**Physical & Chemical panel** (7 parameters): pH, Water Activity, Moisture, Titratable Acidity, Salt/NaCl, Brix, Viscosity.

**Microbiology panel** (9 organisms): Aerobic Plate Count (TPC), E. coli, Coliform, Enterobacteriaceae, Staphylococcus aureus, Yeasts & Moulds, Salmonella, E. coli O157, Listeria monocytogenes.

## SensoryHub

### Architecture
Vite + React 19 app with an Express backend.

**Frontend** (`src/`):
- `App.jsx` (~2500 lines) — Single-component architecture containing all views, state, and CSS-in-JS
- `useServerState.jsx` — Custom hook providing server-synced state with localStorage fallback and 300ms debounced writes. Server data always wins over localStorage on load
- `api.js` — Thin fetch wrapper for the key-value API (`/api/data`, `/api/data/:key`, `/api/data/bulk`)
- `session1_responses.js`, `session2_responses.js` — Hardcoded participant response data for specific sessions

**Backend** (`server/`):
- Express 5 + better-sqlite3 key-value store (`server/server.js`)
- Single `kv` table with allowlisted keys (`sh_participants`, `sh_sessions`, `sh_champ`, `sh_sessionRegs`, `sh_surveys`, `sh_surveyResponses`, `sh_legends`, `sh_lastBackup`, `sh_comms`)
- Email sending via nodemailer/Gmail SMTP (requires `SMTP_USER` and `SMTP_PASS` env vars)
- Vite dev server proxies `/api` to `localhost:3001`

### Commands
```bash
# Frontend (from Sensory Hub/sensoryhub/)
npm run dev          # Vite dev server on :5173
npm run build        # Production build to dist/
npm run lint         # ESLint
npm run preview      # Preview production build

# Backend (from Sensory Hub/sensoryhub/server/)
npm start            # Express API on :3001
npm run seed         # Seed initial data
```

Both frontend and backend must run simultaneously for full functionality. The Vite config proxies `/api` requests to the Express server.

### Deployment
Deployed via rsync to a VPS at `sensoryhub.dailyfoodsa.com`. Backups are JSON exports committed to `backups/` via `backup.sh`.

## Session Startup Checklist

### RecipeHub
1. The app is a single HTML file — no install or build needed. Just edit and push.
2. The Oracle EBS MCP gateway (`gateway.dailyfoodsa.com`) may not auto-connect. If MCP tools aren't available, fall back to direct `curl` calls against the gateway endpoint.
3. See `RECIPEHUB-MAP.md` for a line-by-line section map of the 11K-line file.

### SensoryHub
1. Install deps if needed: `cd "Sensory Hub/sensoryhub" && npm install`
2. Start the backend: `cd "Sensory Hub/sensoryhub/server" && npm start` (port 3001)
3. Start the frontend: `cd "Sensory Hub/sensoryhub" && npm run dev` (port 5173)
4. See `SENSORYHUB-MAP.md` for a line-by-line section map of App.jsx.

### Before Deploying SensoryHub
1. **Bump `APP_VERSION`** on line 2350 of `src/App.jsx` (format: `YYYYMMDD-HHMM`). This clears localStorage on all user devices — forgetting this means users keep stale cached data.
2. Build: `npx vite build`
3. Deploy: `rsync -avz --delete dist/ root@80.238.219.206:/var/www/sensoryhub/`
4. Full deployment details in `DEPLOYMENT.md`.

## Known Pain Points

- **RecipeHub data reliability**: localStorage is the only persistence layer (~5MB limit). Data can differ between devices/browsers. With large datasets (100+ builds), storage can fill up — the app alerts on save failure. Always verify save/load consistency when touching data logic.
- **RecipeHub file size**: At ~11.2K lines, reading the full file eats context fast. Use `RECIPEHUB-MAP.md` to jump to the right section. Read only the lines you need.
- **Variable hoisting (RecipeHub)**: A single `let`/`const` referenced before its definition kills ALL JS in the file. The entire app goes blank. See the "Critical: Variable Hoisting" section above.
- **Single save function (RecipeHub)**: When adding new data types, add them to `saveAllData()` ONLY. Never create a second save path. See "Critical: Single Save Function" above.
- **GitHub Actions deploy can fail**: The VPS SSH connection sometimes times out. If the Action fails, deploy manually with `scp` (see `DEPLOYMENT.md`). Always verify the deploy landed by checking the live site.
- **SensoryHub production has no backend**: The Express server runs locally only. The production site at `sensoryhub.dailyfoodsa.com` uses localStorage. Don't build features that depend on the API being available in production.
- **No tests in either app**: Changes deploy without automated verification. Be careful with refactors.

## Shared Patterns

- Both apps use **single-file architectures** — avoid splitting into many component files unless explicitly asked
- Both use **Outfit** (headings) and **DM Sans** (body) font families
- Admin access is keyed to `caterina.loduca@dailyfoodsa.com`
- Neither app uses TypeScript, external UI libraries, or CSS frameworks
