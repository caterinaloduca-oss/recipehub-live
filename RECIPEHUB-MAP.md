# RecipeHub-App-v2.html — Section Map

Quick reference for navigating the ~12K-line single-file app.

---

## CSS (lines 13–628)

| Lines | Section |
|---|---|
| 13–52 | `:root` variables & base styles |
| 53–100 | Sidebar |
| 101–123 | Main area layout |
| 124–138 | Buttons |
| 139–158 | Cards, Stats row, Tables |
| 159–180 | Badges (`.badge-*` including `-pending-prod`, `-factory-trial`, `-prod-trial-run`, `-production`), Search/Filter bar |
| 181–234 | Form elements, Section dividers, SOP blocks, Shelf life timeline |
| 235–324 | Ingredient tags, EBS Sync, Autocomplete, Media upload, SOP step icons, Branch SOP cards |
| 325–434 | Report bars, Visual SOP flow, Packaging cost, Save toast, Print dropdown/overlay |
| 435–605 | Mobile responsive breakpoints |
| 606–628 | Sign-in page styles |

## HTML Body (lines 629–2170)

| Lines | Section |
|---|---|
| 629–745 | Sign-in page, Sidebar navigation (includes View-as dropdown, Stress/Cleanup/Report buttons) |
| 746–755 | Topbar (dynamic) + Preview role banner |
| 775–880 | `page-dashboard` — stat cards, pending actions, recent recipes, upcoming trials, activity log |
| 881–910 | `page-recipes` (Archived filter + toggle) |
| 911–944 | `page-ingredients` |
| 945–1101 | `page-qa` — Physical/Chemical 7 params, Micro 9 organisms, Allergens + Nutrition |
| 1102–1340 | `page-sop` (Factory SOPs) |
| 1341–1368 | `page-branch-sop` (includes `bsop-detail` dynamic area) |
| 1369–1426 | `page-reports` |
| 1427–1482 | `page-builds-costing` |
| 1483–1541 | `page-cost-control` |
| 1542–1569 | `page-production` (stat cards: Pending/Scheduled/Completed/Waste, 7-col table with `overflow-x:auto`) |
| 1570–1577 | `page-brands` |
| 1578–1621 | `page-builds` (Active/Discontinued filter, dynamic brand stats) |
| 1622–1989 | `page-workflow` — Recipe lifecycle, role cards, production run flow, approval checklist, build lifecycle, branch SOP lifecycle, access-by-role matrix |
| 1990–2164 | `page-users` |
| 2165–2170 | `page-recipe-detail` (dynamic) |

## JavaScript (lines 2171–12008)

### Core Systems

| Lines | Section |
|---|---|
| 2171–2200 | **Save / Load system** — `saveAllData()`, `loadAllData()`, localStorage. Production run migration (in-progress → pending/scheduled) on load |
| 2200–3060 | **Oracle EBS Items Master** — pre-loaded ingredient data |
| 3060–3140 | **EBS Ingredient Autocomplete** |
| 3140–3620 | **Auth** — sign-in (SSO + email), user roles, `beforeunload` save, backup import/export with data migration |
| 3620–3656 | **PAGES config** — page titles and topbar actions (includes `workflow` entry) |
| 3657–3720 | **Role enforcement** — `applyRoleRestrictions()`, `stripPageActions()`, `canAccessPage()`, `applySidebarPermissions()`. Editable pages per role: viewer=none, purchasing=ingredients, factory=production, qa=qa+builds+branch-sop+recipe-detail, npd=recipes+builds+sops+ingredients+brands |
| 3720–3760 | **Navigation** — `nav()`, `showPage()`, `goBack()`. Calls `applyRoleRestrictions()` after every page render |
| 3770–3860 | **Allergen system** + **Recipe tags** |
| 3860–3990 | **PDF Export** |
| 3997–4780 | **Recipe Detail data** — recipe data model, nutrition, detail rendering |

### Recipe Detail & Status

| Lines | Section |
|---|---|
| 4782–5380 | **Recipe detail view** — `viewRecipe()`. Topbar actions gated by `_isRD` (R&D/admin only). QA sign-off inputs always visible for QA role |
| 5382–5515 | **Recipe status workflow** — `setRecipeStatus()`. R&D-only gate. QA gates for trial→prod-trial. Approval gate: QA + cost + allergens + nutrition. Auto-creates production runs as Pending |
| 5516–5570 | **View-as preview** — `_previewRole`, `previewAs()`, `getCurrentUserRole()`, preview banner |
| 5570–5620 | **Archive recipe**, Export to Factory SOP |

### SOPs & Filters

| Lines | Section |
|---|---|
| 5620–5985 | **Factory SOP** — SOP management, visual flow builder, save/approve. `viewFactorySOP()` calls `applyRoleRestrictions()` |
| 5985–6050 | Filter: Recipes, Ingredients, Users |
| 6050–6100 | Modal system |
| 6100–6680 | New Recipe form, **Import External Recipes** |

### Versioning & Editing

| Lines | Section |
|---|---|
| 6680–6920 | **Versioning**, Batch log, Version comparison |
| 6920–7240 | **Edit Recipe** |
| 7240–7640 | New/Edit Ingredient, Edit/Remove User |

### Dynamic Brand UI

| Lines | Section |
|---|---|
| 7640–7770 | `populateBrandUI()`, `brandOptionsHTML()`, `getBrandColors()`, `buildBrandCards()`, `renderBrandDetail()` |

### Access Control

| Lines | Section |
|---|---|
| 7778–7833 | **ACCESS_PERMISSIONS** — all roles see all pages (except Users=admin). Action permissions per role for recipes, ingredients, QA, builds, SOPs, production, users |
| 7835–7890 | **Access Matrix UI** — `buildAccessMatrix()` (read-only for non-admin), `toggleAccess()` |
| 7890–7960 | Invite form |

### QA & Nutrition

| Lines | Section |
|---|---|
| 7960–8170 | **QA recipe switcher**, nutrition edit, nutrition calculations |
| 8170–8400 | QA print functions, `saveNutrition()` |

### Brands & Operations

| Lines | Section |
|---|---|
| 8400–8550 | Edit/Delete Brand, Delete Recipe |
| 8550–8900 | **Shelf Life Study**, QA page functions, Brand form |

### Dashboard

| Lines | Section |
|---|---|
| 8908–9025 | **`updateDashboardStats()`** — stat cards, pending actions (reviews, QA, SOPs, unscheduled runs, pending users), recent recipes, upcoming trials (sorted, days-waiting counter) |

### Activity Log

| Lines | Section |
|---|---|
| 9026–9050 | **`getCurrentUserName()`**, **`logActivity()`** — tracks user name, ISO timestamp, 200 entry limit |
| 9050–9120 | `renderActivityLog()` — shows user, date, time. `renderNotifications()` |

### Pizza Builds

| Lines | Section |
|---|---|
| 9122–9500 | **Builds management** — BUILDS_DATA, `viewBuild()` (calls `applyRoleRestrictions()`), costing, allergens, nutrition, active/discontinued, comparison, build detail |

### Production

| Lines | Section |
|---|---|
| 9870–9900 | `PRODUCTION_RUNS = []`, archive/unarchive |
| 9900–9960 | **`buildProductionTable()`** — 7-col table, date log tag, days-without-date counter, role-gated action buttons |
| 9960–10000 | `saveProductionRun()` — auto-status based on date (pending if no date, scheduled if date) |
| 10000–10070 | **Status flow** — `changeRunStatus()`, `setRunStatus()`. Pending→Scheduled (requires date), Scheduled→Completed (yield/waste form), On Hold. Legacy in-progress migration on modal open |
| 10070–10130 | `completeProductionRun()` — `completedAt` stamp. `editProductionRun()`, `saveEditRun()` — date change logging, auto-promote pending→scheduled. `showDateLog()` — date history modal |

### Branch SOPs

| Lines | Section |
|---|---|
| 11088–11560 | **Branch SOP** — BRANCH_SOPS, `viewBranchSOP()` (calls `applyRoleRestrictions()`), per-branch management, photos, allergens/nutrition from linked build, discontinued banner |

### Utilities & Init

| Lines | Section |
|---|---|
| 11560–11800 | **Build Import/Export** CSV, Sidebar badges, Duplicate Recipe |
| 11800–11920 | Refresh UI, Empty states, `applySidebarPermissions()` init |

### Stress Test (embedded)

| Lines | Section |
|---|---|
| 11943–12008 | **`stressTest`** — `generate()` (100 recipes, 50 builds, 30 runs, 20 SOPs), `report()` (localStorage usage), `cleanup()` (removes ST- prefix data). `loadStressTest()` — sidebar button handler |
