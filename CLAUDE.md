# CLAUDE.md — RecipeHub

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

**RecipeHub** is the recipe management platform for **Daily Food SA** — a food manufacturing company with 5 brands (Maestro, Mad, Pinzatta, Tivo, Telliano). The app manages the full lifecycle from recipe creation to production approval.

Hosted at `recipehub.dailyfoodsa.com`. Internal tool for `@dailyfoodsa.com` employees.

## Architecture

Single-file HTML application (`RecipeHub-App-v2.html`, ~11.9K lines). All CSS, HTML, and JavaScript live in one file. No build step — the HTML file is the entire app.

- **State**: All data persisted to `localStorage` via `saveAllData()` / `loadAllData()`
- **UI**: Vanilla JS with DOM manipulation. Sidebar navigation switches between pages
- **Styling**: CSS custom properties in `:root` (navy/gold/sage theme, Outfit + DM Sans fonts)
- **Data gateway**: Connects to Oracle EBS via MCP gateway at `gateway.dailyfoodsa.com`

### Pages

Dashboard, Recipes, Ingredients, QA Lab Results, Factory SOP, Branch SOP, Product Builds, Production Plan, Brands, Workflow, Reports, Builds Costing, KPI & Goals, Users & Access

## Deployment

- GitHub Actions (`.github/workflows/deploy.yml`) SCPs the HTML file to VPS on push to `main`
- VPS: `80.238.219.206:/var/www/recipehub/`
- CNAME in repo root points to `recipehub.dailyfoodsa.com`
- `RecipeHub-Landing.html` is a separate marketing page, not the app

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

## Production Run Lifecycle

```
Pending → Scheduled → Completed → Archive
```

- **Pending**: Auto-created when R&D sends recipe to trial. No date yet. `createdAt` timestamp starts the "days without date" counter.
- **Scheduled**: Factory sets a date (auto-promotes from Pending on edit). Date change log tracks every reschedule with `dateLog` array.
- **Completed**: Factory marks done. `completedAt` timestamp recorded. Yield/waste captured.
- **On Hold**: Available from Pending or Scheduled states.

## Role-Based Access Control

All 6 roles can **view every page** (except Users & Access = admin only). Editing is restricted:

| Role | Can Edit |
|---|---|
| **Admin** | Everything + user management |
| **R&D (npd)** | Recipes, builds, SOPs, branch SOPs, ingredients, brands |
| **QA** | QA results, QA sign-off, builds, branch SOPs |
| **Factory** | Production plan only (schedule/edit/complete runs) |
| **Purchasing** | Ingredients only (add/edit, supplier pricing) |
| **Viewer** | Nothing — read-only everywhere |

Enforcement: `applyRoleRestrictions()` runs after every page render. `viewRecipe()` gates topbar actions via `_isRD`. "View as" dropdown in sidebar lets admin preview any role.

## Critical Rules

### Variable Hoisting
**Never reference `let`/`const` variables before their definition line.** A reference-before-definition error kills ALL JavaScript, making the entire app appear empty.

### Single Save Function
**All localStorage writes must go through `saveAllData()`.** Never create a second save path with its own field list — this caused a data loss bug.

### Dynamic Brand System
**All brand-dependent UI is generated from the `BRANDS` array.** Never hardcode brand names. Use:
- `brandOptionsHTML(selected)` — `<option>` HTML for `<select>`
- `getBrandColors()` — `{brandName: color}` map
- `populateBrandUI()` — master sync for all brand UI

### No Hardcoded Seed Data
**Data arrays persisted to localStorage should start empty** (e.g. `PRODUCTION_RUNS = []`). Exceptions: `RECIPE_DB`, `BRANDS`, `BUILDS_DATA`, and `BRANCH_SOPS` use smart merge logic.

### Production Run Migration
On load, old statuses are migrated: `in-progress` → `scheduled` (if has date) or `pending` (if no date). Runs without `createdAt` get it backfilled.

## Activity Log

`logActivity(type, icon, message, detail, forRole)` records every action with:
- `user` — current user name via `getCurrentUserName()`
- `ts` — ISO timestamp
- 200 entry limit

Rendered on dashboard and in notifications panel.

## QA Page

Recipe dropdown is **dynamically populated from `RECIPE_DB`** via `populateQARecipeDropdown()`. Never hardcode recipe lists.

**Physical & Chemical** (7 params): pH, Water Activity, Moisture, Titratable Acidity, Salt/NaCl, Brix, Viscosity.

**Microbiology** (9 organisms): Aerobic Plate Count (TPC), E. coli, Coliform, Enterobacteriaceae, Staphylococcus aureus, Yeasts & Moulds, Salmonella, E. coli O157, Listeria monocytogenes.

## Session Startup

1. The app is a single HTML file — no install or build needed. Just edit and push.
2. See `RECIPEHUB-MAP.md` for a line-by-line section map.
3. The Oracle EBS MCP gateway may not auto-connect. Fall back to `curl` if needed.

## Known Pain Points

- **localStorage only**: ~5MB limit. Data differs between devices/browsers. App alerts on save failure.
- **File size**: ~11.9K lines. Use `RECIPEHUB-MAP.md` to jump to sections. Read only what you need.
- **No tests**: Changes deploy without automated verification. Be careful with refactors.
- **GitHub Actions deploy can fail**: VPS SSH sometimes times out. Deploy manually with `scp` if needed.
