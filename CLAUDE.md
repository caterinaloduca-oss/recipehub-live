# CLAUDE.md — RecipeHub

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

**RecipeHub** is the recipe management platform for **Daily Food SA** — a food manufacturing company with 6 brands (Maestro, Mad, Pinzatta, Tivo, Telliano, Mano di Pasta). The app manages the full lifecycle from recipe creation to production approval.

Hosted at `recipehub.dailyfoodsa.com`. Internal tool for `@dailyfoodsa.com` employees.

## Architecture

Single-file HTML application (`RecipeHub-App-v2.html`, ~14K lines) + Node/Express backend (`server/`, ~750 lines).

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
