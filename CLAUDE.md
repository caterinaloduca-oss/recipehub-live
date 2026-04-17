# CLAUDE.md — RecipeHub

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

**RecipeHub** is the recipe management platform for **Daily Food SA** — a food manufacturing company with 6 brands (Maestro, Mad, Pinzatta, Tivo, Telliano, Mano di Pasta). The app manages the full lifecycle from recipe creation to production approval.

Hosted at `recipehub.dailyfoodsa.com`. Internal tool for `@dailyfoodsa.com` employees.

## Architecture

Single-file HTML application (`RecipeHub-App-v2.html`, ~15K lines) + Node/Express backend (`server/`, ~850 lines).

- **State**: Dual persistence — `localStorage` (instant/offline) + shared server via `saveAllData()` / `syncFromServer()`
- **Backend**: Node/Express + SQLite on VPS at port 3002, proxied via nginx at `/api/`
- **Integrations**: Oracle EBS via MCP gateway (`gateway.dailyfoodsa.com`), USDA FoodData Central (nutrition), Gmail (notifications)
- **UI**: Vanilla JS with DOM manipulation. Sidebar navigation switches between pages
- **Styling**: CSS custom properties in `:root` (navy/gold/sage theme, Outfit + DM Sans fonts)

### Server (`server/`)

Node/Express API with SQLite storing the entire app state as a single JSON document.

- `server/index.js` — Express app with endpoints for data, EBS search, USDA nutrition, email notifications, document library, communications
- `server/db.js` — SQLite setup, single-row document store with WAL mode
- `server/data/recipehub.db` — SQLite database file (gitignored)
- **Gateway key**: `df_svc_ls8XudEeqGUeLMIF4nFBVYhjMO668s-T4nqbAYOHyqM` (IP-locked to VPS)
- **USDA key**: `JJy37GOw4VaboMD3l8o1gyVlYMCQYUmkUjDEakl9`
- **Systemd**: `recipehub-api.service` on VPS, auto-restarts, port 3002
- **Nginx**: `/api/` proxied to `127.0.0.1:3002`, `/server/` blocked (403), `/docs/` serves library uploads, no-cache headers on HTML to prevent stale deploys

### Server Endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/health` | GET | No | Health check |
| `/api/data` | GET | Yes | Load shared app state |
| `/api/data` | POST | Yes | Save shared app state (with server-side dedup) |
| `/api/ebs/search?q=` | GET | Yes | Search EBS for ingredients with per-kg pricing |
| `/api/nutrition/search?q=` | GET | Yes | Search USDA for nutritional data |
| `/api/nutrition/recipe?npd=` | GET | Yes | Calculate full recipe nutrition from USDA |
| `/api/notify` | POST | Yes | Send workflow email notification |
| `/api/comms/send` | POST | Yes | Send admin email to team |
| `/api/library/upload` | POST | Yes | Upload document to library |
| `/api/img/upload` | POST | Yes | Upload image file, returns URL path |
| `/api/recipe/:npd` | POST | Yes | Save single recipe by NPD code (per-item save) |
| `/api/build/:id` | POST | Yes | Save single build by ID (per-item save) |
| `/api/branchsop/:id` | POST | Yes | Save single Branch SOP by ID (per-item save) |

### Sync Mechanism

- `saveAllData()` saves to localStorage immediately, then POSTs to server (throttled, 3s)
- `saveAllDataNow()` saves immediately (no throttle) — used for photo uploads
- `forceRefreshFromServer()` pulls from server instantly and rebuilds all UI (Refresh Data button)
- `_hasLoadedFromServer` flag prevents pushing empty data before first sync
- `syncFromServer()` pulls from server every 2 minutes, hydrates if server is newer
- Sync skips if `_localDirty`, `_savingToServer`, or `_sopEditTimer` active
- `beforeunload` uses `navigator.sendBeacon()` for last-save attempt
- Auto-save timer DISABLED — only user actions trigger saves (prevents idle laptops overwriting data)
- **Per-item saves**: recipes, builds, and Branch SOPs save individually via dedicated endpoints — prevents multi-user overwrites
- Server deduplicates Branch SOPs (by ID + name), Builds (by ID), Users (by email, @dailyfoodsa.com only)

### Server-Side Merge (Multi-User)

The POST `/api/data` endpoint merges incoming data with existing server data to prevent overwrites:
- **Images**: recipe media, SOP step photos, build photos, Branch SOP step photos — preserves existing if incoming is null/empty
- **Media arrays**: recipe media, QA files — combines by filename, dedupes
- **Library docs**: combined by URL, deduped
- **Comms log**: combined by timestamp, deduped
- **Activity log**: combined by timestamp, capped at 200 entries

### Image Storage

Images upload to `/api/img/upload` → saved as files in `/docs/img/` on VPS disk, served by nginx. Data stores URL paths (e.g. `/docs/img/build-BLD-001.jpg`), not base64. Compressed to 600px max, quality 0.6 via canvas before upload.

### Pages (sidebar order)

**Main**: Overview, Recipes, Product Builds, Ingredients DB
**Quality & Production**: QA Lab Results, Factory SOP, Branch SOP, Production Plan
**Analytics**: Recipe Analytics, Build Analytics, Brands, KPI & Goals
**Settings**: Workflow, Communications, Library, Users & Access

## Deployment

- GitHub Actions (`.github/workflows/deploy.yml`) SCPs the HTML file to VPS on push to `main`
- VPS: `80.238.219.206:/var/www/recipehub/`
- **Manual deploy**: `scp RecipeHub-App-v2.html root@80.238.219.206:/var/www/recipehub/` + copy to `index.html`
- **Server deploy**: `scp server/index.js` to VPS + `systemctl restart recipehub-api`
- `RecipeHub-Landing.html` is a separate marketing page

## Recipe Lifecycle

```
Draft → In Review → Factory Trial → Production Trial → Approved
         (R&D)        (R&D)            (R&D)            (R&D)
                                    ↑ QA sign-off     ↑ QA sign-off
                                                      + Cost + Allergens + Nutrition
```

- Email notifications sent at every stage change
- Moving to Factory Trial or Prod Trial auto-creates a Production Run

## Food Cost System

Each recipe has a **Food Cost** section with 5 columns: Cost/kg, Portion Cost, Selling Price, Food Cost %, Yield.

- **Ingredient cost chain**: recipe override (`i.costPerKg`) → ING_DATA cost/kg (row[11]) → ING_DATA raw cost (row[5]) → EBS cache → null
- **`_calcActualCostPerKg(r)`**: theoretical cost / yield
- **`updateFoodCost(npd)`**: live updates, debounced save (1s)
- Ingredient costs are clickable in the recipe detail view

## Factory SOPs

Factory SOP lives on each recipe as three composable layers, printed/viewed via **Factory SOP → click recipe**.

### Layers

- **Standard Blocks** (`SOP_STANDARD_BLOCKS`) — shared preamble/closing blocks (Receiving, Re-palletizing, Sifting, Weighing, CIP, Metal Detector, FG Freezer/Chiller). Edited once by admin in the "Edit Library" modal, toggled on/off per recipe via `r.sopStandardBlocks` (array of block IDs). Each block carries `position: 'pre' | 'post'`, `oprp`, `ccp`, `body`, and `annexures[{code, name}]`.
- **Recipe-specific steps** (`r.sopSteps`) — the variable middle. Each step has `params[]`, `icons[]`, `ccp`, `warning`, `visualImg`, `media[]`.
- **Flowchart** (`r.sopFlowchart`) — auto-generated from enabled blocks + sopSteps, editable in a modal (🔀 Flowchart button). User overrides persist; "↻ Regenerate" rebuilds from scratch. Numbering (3.1, 3.2, …) is **computed sequentially** by `_computeSOPNumbering(r)` — never trust a block's static `num` for display.

### Approval chain (`r.sopApproval`)

Three-stage document approval — each signer authenticates from their own account.

| Stage | Field | Role | Advances status to |
|---|---|---|---|
| 1 | `prepared` | R&D / NPD (or admin) | `pending-review` |
| 2 | `reviewed` | Factory Manager (or admin) | `pending-approval` |
| 3 | `approved` | QA Manager (or admin) | `approved` (recipe also set to `approved`) |

Each stage stores `{by, email, at}`. Stages lock until the previous is signed. Approved SOPs lock; edits spawn a new version. Use `signSOPStage(npd, stage)` — not legacy `submitSOPForApproval` / `approveSOPRelease` (still present as back-compat shims). Role gate: `_canSignStage(stage)`.

**Batch sign-off** (Supervisor / QA Tech / Batch No.) is NOT in app state — it's pen-and-paper on the printed Batch Ticket.

### Print modes

Single "🖨️ Print ▾" dropdown on the SOP header → 7 modes via `openPrint(npd, mode)`:

| Mode | Content | Orientation |
|---|---|---|
| `full` | Cover + flowchart + standard blocks + batch ticket + recipe steps + annexure + sign-off | Portrait |
| `full-text` | Same, no images | Portrait |
| `factory` | Classic 2-col SOP with pictures (existing layout) | Landscape |
| `factory-text` | Same, no images | Landscape |
| `flowchart` | Flowchart only | Portrait |
| `batch` | Ingredient weigh-sheet with **Code** (from ING_DATA lookup), Lot, Expiry, Weighed-by | Landscape |
| `cover` | Prepared/Reviewed/Approved signature table + version history | Portrait |
| `annexure` | Auto-compiled DFC-* form references from enabled blocks | Portrait |

Orientation is set via a dynamically injected `<style id="print-page-style">` — browsers can't selector `@page` by class. Default `.print-sheet` is portrait (210×297mm); `.print-sheet.landscape` switches to 297×210mm.

## Branch SOPs

- **Brand colors** (`BSOP_BRAND_COLORS`): Maestro/Maestro KSA=green, Pinzatta=pink, Tivo=purple, Telliano=yellow, Mano di Pasta=navy, Mad=red
- **Components table**: Type, Item, Weight, Tool/Qty, 2nd Shelf Life, After Opening
- **Portioning tools** (`PORTIONING_TOOLS`): Ladles, scoops, drizzles with auto-weight calculation
- Print view is color-coded with full component details
- Step photos can be uploaded and steps reordered with arrows

## Production Plan

- Shows sent date, days waiting, scheduled date with change tracking
- Comments per production run
- Batch size editable before scheduling

## Ingredients DB — "Used In"

- Each ingredient has a **Used in** button that finds all recipes and builds using that ingredient
- Quick cross-reference for cost impact analysis

## User Profile

- Users can click their name in the sidebar to edit their own profile (name, phone, department, title)
- No role change — that remains Admin-only

## Email Notifications

Gmail via nodemailer (`caterina.loduca@dailyfoodsa.com`). Triggers:
- Recipe status changes (review, trial, approved) — notifies R&D + QA + Admin
- QA sign-offs — notifies recipe creator + Admin
- Production run scheduled/completed — notifies Factory + R&D + Admin
- **Factory SOP stage signed** (`sop-stage` event) — each stage notifies the next signer
- Admin sends Communications — notifies selected role group or individual
- Production plan comments — notifies relevant parties

## Critical Rules

### Variable Hoisting
**Never reference `let`/`const`/`var` variables before their assignment line.** All global arrays (`COMMS_LOG`, `LIBRARY_DOCS`, `BSOP_BRAND_COLORS`, `PORTIONING_TOOLS`) must be declared before the init block.

### Empty Data Guard
**`saveAllData()` will not push to server if `_hasLoadedFromServer` is false and data is empty.** This prevents a fresh browser from wiping the server.

### Server-Side Dedup & Merge
The POST `/api/data` endpoint deduplicates and merges — see "Server-Side Merge" section above.

### Force Clean
A one-time `localStorage.clear()` runs on first load (controlled by `_rh_cleaned` flag). Bump `_forceCleanVersion` to trigger another wipe across all browsers.

### Seed Data Merge
`BUILDS_DATA` and `BRANCH_SOPS` have hardcoded seed data. On load/sync, seed items are preserved if not present in server data (merge by ID). `RECIPE_DB` starts empty — all recipes come from server.

## Roles & Permissions

- **Admin** (`caterina.loduca@dailyfoodsa.com`): full access, "View as" role switcher
- **R&D (npd)**: recipes, ingredients, builds, Branch SOP, Factory SOP, brands, comms, library uploads
- **QA**: QA lab, builds, Branch SOP, recipe detail, comms
- **Factory**: production plan, comms
- **Purchasing**: ingredients, comms
- **Viewer**: read-only everywhere, no comms
- **KPI & Goals**: restricted to `caterina.loduca@dailyfoodsa.com` and `subhanshu.pathak@dailyfoodsa.com` only
- Default for unknown/unauthenticated users: **Viewer**
- "View as" dropdown hidden for non-admins
- Modal buttons excluded from role stripping (`stripPageActions` skips `#modal-overlay`)


## Deletion Protection

- **Recipes**: server never loses recipes on full-blob save. `deletedRecipeIds` array tracks explicitly deleted recipes so they don't resurrect from stale browser pushes.
- **Branch SOPs**: `deletedSOPIds` array tracks deleted SOPs. Server auto-strips them on every save.
- **Production Runs**: server auto-cleans orphan runs (for deleted recipes) on every save.

## Ingredient Database

- **599 items** from Oracle EBS / Redshift with real vendor prices
- Categories from Redshift: Food, Sauce, Dough, Cheese, Meat, Vegetable, Dip, Side, Drink, Packing Material, Non-Food, Smallware, Disposable, Stationery, Marketing, Uniform
- **438 items with per-kg cost** calculated from `purchase_price / equivalence`
- "Used in" button shows all recipes/builds using an ingredient
- Prices sourced from `maestroksa.v_inventory_items` joined with `v_inventory_items_vendors`
- GL cost fallback from `erp.inv_item_cost`

## Recipe Import

- Recipes can be imported from HTML files with ingredient tables and method steps
- Format: ingredient name + percentage per line, steps as Title: Description
- POS sub-recipes available from `maestroksa.v_recipes` (23 formulations for crusts, sauces, toppings, sides)
- Creator tracked via `createdBy` and `createdAt` fields

## Branch SOP Import

- Can extract from PDF files using PyMuPDF (fitz)
- Images extracted by size (top 8 = step photos, skip logos)
- Product name extracted by largest font size on page
- Uploaded to server via `/api/img/upload`
- SOP code, version, date parsed from footer text (e.g. "M-PS-225 V-01 dt 27/11/2025")

## Factory SOP Generation

- Sauce recipes auto-reference **Tetra Pak High Shear Batch Mixer B200-200VAA**
- Equipment prep step includes machine name, CIP temp, vessel capacity
- Mixing/blending/emulsification steps auto-append machine reference
- Applies to types: Sauce, Dip, Blend, Marinade, Dressing, Spread

## Cache Prevention

- Nginx: `no-cache, no-store, must-revalidate` + `Pragma: no-cache` + `Expires: 0` on all HTML
- ETag disabled, `if_modified_since off` — always returns 200, never 304
- Frontend clears service workers and Cache API on every page load
- "Refresh Data" button force-pulls from server without page reload

## Communications

- Draft system: save drafts to localStorage, load and send later
- Send targets: Everyone, All Team (no viewers), by role, All Viewers, Individual
- Viewer access: can see comms page and receive emails, cannot send

## Security

- API bearer token auth on all `/api/data` endpoints
- Gateway key IP-locked to VPS
- `/server/` path blocked in nginx
- Security headers: X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy
- EBS search input sanitized (alphanumeric only)
- CORS open (internal tool)

## Known Pain Points

- **File size**: ~13.5K lines. Use line numbers from grep, don't read the full file.
- **No tests**: Deploy without automated verification.
- **Multi-user sync**: ~12 users, server-side merge protects images/docs/logs but text data is still last-write-wins.
- **EBS per-kg conversion**: Only works for items with `recipe_unit='kg'`. Others need manual cost/kg entry.
- **USDA matching**: Name-based search, not always accurate. Best for common ingredients.
