# CLAUDE.md — RecipeHub

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

**RecipeHub** is the recipe management platform for **Daily Food SA** — a food manufacturing company with 6 brands (Maestro, Mad, Pinzatta, Tivo, Telliano, Mano di Pasta). The app manages the full lifecycle from recipe creation to production approval.

Hosted at `recipehub.dailyfoodsa.com`. Internal tool for `@dailyfoodsa.com` employees.

## Architecture

Single-file HTML application (`RecipeHub-App-v2.html`, ~12K lines). All CSS, HTML, and JavaScript live in one file. No build step — the HTML file is the entire app.

- **State**: Dual persistence — `localStorage` (instant/offline) + shared server via `saveAllData()` / `loadAllData()` / `syncFromServer()`
- **Backend**: Node/Express + SQLite on VPS at port 3002, proxied via nginx at `/api/`
- **UI**: Vanilla JS with DOM manipulation. Sidebar navigation switches between pages
- **Styling**: CSS custom properties in `:root` (navy/gold/sage theme, Outfit + DM Sans fonts)
- **Data gateway**: Oracle EBS via MCP gateway at `gateway.dailyfoodsa.com` (requires API key from IT)

### Server (`server/`)

Minimal Node/Express API with SQLite storing the entire app state as a single JSON document.

- `server/index.js` — Express app with `GET /api/data` and `POST /api/data`, bearer token auth
- `server/db.js` — SQLite setup, single-row document store with WAL mode
- `server/data/recipehub.db` — SQLite database file (gitignored, created automatically)
- **API key**: Set in `index.js` and client-side `API_KEY` constant. Required on all `/api/data` requests.
- **Systemd**: `recipehub-api.service` on VPS, auto-restarts, port 3002
- **Nginx**: `/api/` proxied to `127.0.0.1:3002`, `/server/` blocked (403)

### Sync Mechanism

- `saveAllData()` saves to localStorage immediately, then POSTs to server (throttled, 3s)
- `syncFromServer()` pulls from server every 30 seconds, hydrates if server is newer
- Sync skips if `_localDirty` (unsaved local changes) or `_savingToServer` (POST in flight)
- `beforeunload` uses `navigator.sendBeacon()` for reliable last-save
- `_hydrateFromData()` replaces all in-memory arrays from a data blob (shared logic for load + sync)

### Pages

Dashboard, Recipes, Ingredients, QA Lab Results, Factory SOP, Branch SOP, Product Builds, Production Plan, Brands, Workflow, Reports, Builds Costing, KPI & Goals, Users & Access

## Deployment

- GitHub Actions (`.github/workflows/deploy.yml`) SCPs the HTML file to VPS on push to `main`
- VPS: `80.238.219.206:/var/www/recipehub/`
- CNAME in repo root points to `recipehub.dailyfoodsa.com`
- `RecipeHub-Landing.html` is a separate marketing page, not the app
- **Server deploy**: `scp server/*.js` to VPS + `systemctl restart recipehub-api`
- **Manual HTML deploy**: `scp RecipeHub-App-v2.html root@80.238.219.206:/var/www/recipehub/` + copy to `index.html`

## Recipe Lifecycle

```
Draft → In Review → Factory Trial → Production Trial → Approved
         (R&D)        (R&D)            (R&D)            (R&D)
                                    ↑ QA sign-off     ↑ QA sign-off
                                                      + Cost + Allergens + Nutrition
```

- **Only R&D (npd) and Admin** can move recipes through stages
- **Factory Trial → Prod Trial** requires QA sign-off
- **Prod Trial → Approved** requires QA sign-off + costing + allergens + nutrition filled
- Sensory evaluation is tracked outside RecipeHub; R&D confirms before approving
- Moving to Factory Trial or Prod Trial auto-creates a Production Run as Pending

## Food Cost System

Each recipe has a **Food Cost** section in the detail view with 5 columns:

| Cost / kg | Portion Cost | Selling Price | Food Cost % | Yield |
|---|---|---|---|---|
| Yield-adjusted | Enter grams | Enter SAR | Auto (target <30%) | Enter % |

- **Ingredient cost lookup**: Auto-matches ingredient name to `ING_DATA` for price per kg
- **Manual override**: Click any cost cell in the ingredient table → `editIngCost()` stores `i.costPerKg` on the ingredient
- **`_calcIngCostTotal(r)`**: Theoretical cost per kg (before yield)
- **`_calcActualCostPerKg(r)`**: Actual cost = theoretical / yield
- **`updateFoodCost(npd)`**: Live updates Food Cost section, debounced save (1s)
- **`_getIngPrice(i)`**: Returns override → DB lookup → null
- Imported recipes can match DB ingredients via autocomplete in the edit form

## Production Run Lifecycle

```
Pending → Scheduled → Completed → Archive
```

- **Pending**: Auto-created when R&D sends recipe to trial. No date.
- **Scheduled**: Factory sets a date (auto-promotes from Pending on edit).
- **Completed**: Factory marks done. `completedAt` stamped. Yield/waste captured.
- **On Hold**: Available from Pending or Scheduled. Not from Completed.

## Branch SOPs

- **Brand colors** (`BSOP_BRAND_COLORS`): Maestro=green, Pinzatta=pink, Tivo=purple, Telliano=yellow, Mano di Pasta=navy, Mad=red
- **Components table**: Shows linked build's components with Type, Item, Weight, Tool/Qty, and **2nd Shelf Life** column
- **2nd Shelf Life**: QA-managed per SOP, stored in `sop.componentShelfLife` (object keyed by item name). Dropdown with common durations + Custom option.
- **Print**: Color-coded header/borders per brand, full components table with shelf life, allergens, nutrition
- `viewBranchSOP()` and `printBranchSOP()` both use `BSOP_BRAND_COLORS`

## Role-Based Access Control

All 6 roles can **view every page** (except Users & Access = admin only). Editing is restricted per role:

| Role | Can Edit |
|---|---|
| **Admin** | Everything + user management |
| **R&D (npd)** | Recipes, builds, SOPs (factory + branch), ingredients, brands |
| **QA** | QA results, QA sign-off, builds, branch SOPs |
| **Factory** | Production plan only (schedule/edit/complete runs) |
| **Purchasing** | Ingredients only (add/edit, supplier pricing) |
| **Viewer** | Nothing — read-only everywhere |

### Enforcement

- `applyRoleRestrictions()` runs after every page render and dynamic detail view
- `stripPageActions(pageId)` hides buttons only on pages the role CANNOT edit
- `viewRecipe()` gates topbar actions (Edit/SOP/More) via `_isRD` check
- `viewBuild()`, `viewBranchSOP()`, `viewFactorySOP()` all call `applyRoleRestrictions()` after rendering
- Access matrix checkboxes are read-only for non-admin

## Activity Log

`logActivity(type, icon, message, detail, forRole)` records every action with:
- `user` — current user name via `getCurrentUserName()`
- `ts` — ISO timestamp
- 200 entry limit

## Critical Rules

### Variable Hoisting
**Never reference `let`/`const` variables before their definition line.** A reference-before-definition error kills ALL JavaScript, making the entire app blank. `BSOP_BRAND_COLORS` must be defined before any init calls that reference it.

### Single Save Function
**All localStorage writes must go through `saveAllData()`.** It saves to localStorage AND posts to server.

### Dynamic Brand System
**All brand-dependent UI is generated from the `BRANDS` array.** Never hardcode brand names. Branch SOP colors use `BSOP_BRAND_COLORS` (separate from `getBrandColors()`).

### No Hardcoded Seed Data
**Data arrays persisted to localStorage should start empty** (e.g. `PRODUCTION_RUNS = []`). Exceptions: `RECIPE_DB`, `BRANDS`, `BUILDS_DATA`, `BRANCH_SOPS` use smart merge logic. Deleted recipes are tracked in `_deletedRecipeIds` to prevent re-adding on load.

### Sync Safety
- `_localDirty` flag prevents sync from overwriting unsaved local changes
- `_savingToServer` flag prevents sync during active POST
- `updateFoodCost()` uses debounced save (1s) to avoid hammering the server
- Never delete existing recipe values from empty input fields — only update when value > 0

### API Security
- All `/api/data` requests require `Authorization: Bearer <API_KEY>` header
- `sendBeacon` uses `?key=` query param (can't set headers)
- `/server/` path blocked in nginx (403)
- Security headers: X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy

## QA Page

Recipe dropdown is **dynamically populated from `RECIPE_DB`** via `populateQARecipeDropdown()`. Never hardcode recipe lists.

**Physical & Chemical** (7 params): pH, Water Activity, Moisture, Titratable Acidity, Salt/NaCl, Brix, Viscosity.

**Microbiology** (9 organisms): Aerobic Plate Count (TPC), E. coli, Coliform, Enterobacteriaceae, Staphylococcus aureus, Yeasts & Moulds, Salmonella, E. coli O157, Listeria monocytogenes.

## Session Startup

1. The app is a single HTML file — no install or build needed. Just edit and push.
2. See `RECIPEHUB-MAP.md` for a line-by-line section map.
3. Server: `cd server && npm install && node index.js` (port 3002)
4. The Oracle EBS MCP gateway requires an API key from IT (pending).

## Known Pain Points

- **File size**: ~12K lines. Use `RECIPEHUB-MAP.md` to jump to sections. Read only what you need.
- **No tests**: Changes deploy without automated verification. Use the embedded stress test for manual QA.
- **GitHub Actions deploy can fail**: VPS SSH sometimes times out. Deploy manually with `scp` if needed.
- **Role enforcement is UI-only**: `stripPageActions` hides buttons but doesn't block API calls. Fine for internal tool.
- **Last-write-wins sync**: ~10 users, no conflict resolution. Sync every 30s with dirty-check guards.
