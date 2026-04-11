# RecipeHub-App-v2.html — Section Map

Quick reference for navigating the ~11.9K-line single-file app.

---

## CSS (lines 13–628)

| Lines | Section |
|---|---|
| 13–52 | `:root` variables & base styles |
| 53–100 | Sidebar |
| 101–123 | Main area layout |
| 124–138 | Buttons |
| 139–151 | Cards |
| 145–158 | Stats row & Tables |
| 159–180 | Badges (`.badge-*`), Search/Filter bar |
| 181–208 | Form elements, Section dividers, Result cells |
| 209–234 | SOP blocks, Shelf life timeline |
| 235–267 | Ingredient category tags, EBS Sync & Autocomplete, brand-dot base |
| 268–324 | Media upload, SOP step icons, Branch SOP cards |
| 325–362 | Report bars, Visual SOP flow, Packaging cost |
| 363–434 | Save toast, Print dropdown, Print overlay |
| 435–605 | Mobile responsive breakpoints |
| 606–628 | Sign-in page styles |

## HTML Body (lines 629–2170)

| Lines | Section |
|---|---|
| 629–745 | Sign-in page, Sidebar navigation (includes Workflow nav item) |
| 746–755 | Topbar (dynamic) + Preview banner |
| 775–880 | `page-dashboard` — stat cards, pending actions, recent recipes, upcoming trials, activity log |
| 881–910 | `page-recipes` (includes Archived filter + toggle) |
| 911–944 | `page-ingredients` |
| 945–1101 | `page-qa` — QA & Shelf Life (Physical/Chemical 7 params, Micro 9 organisms, Allergens + Nutrition) |
| 1102–1336 | `page-sop` (Factory SOPs) |
| 1337–1368 | `page-branch-sop` |
| 1369–1426 | `page-reports` |
| 1427–1482 | `page-builds-costing` |
| 1483–1541 | `page-cost-control` |
| 1542–1569 | `page-production` (stat cards: Pending/Scheduled/Completed/Waste, 7-col table) |
| 1570–1577 | `page-brands` |
| 1578–1621 | `page-builds` (Active/Discontinued filter, dynamic brand stats) |
| 1622–1989 | `page-workflow` — Recipe lifecycle, role cards, production run flow, approval checklist, build/SOP lifecycles, access matrix |
| 1990–2164 | `page-users` |
| 2165–2170 | `page-recipe-detail` |

## JavaScript (lines 2171–11916)

### Core Systems

| Lines | Section |
|---|---|
| 2171–2200 | **Save / Load system** — `saveAllData()`, `loadAllData()`, localStorage persistence |
| 2200–3060 | **Oracle EBS Items Master** — pre-loaded ingredient data from gateway |
| 3060–3140 | **EBS Ingredient Autocomplete** — search-as-you-type |
| 3140–3620 | **Auth** — sign-in (SSO + email), user roles, permissions, `beforeunload` save, data migration |
| 3620–3650 | **PAGES config** — page titles and topbar actions |
| 3652–3695 | **Role enforcement** — `applyRoleRestrictions()`, `canAccessPage()`, `applySidebarPermissions()` |
| 3695–3770 | **Navigation** — `nav()`, `showPage()`, `goBack()` |
| 3770–3830 | **Allergen system** — allergen tagging, auto-detection |
| 3830–3860 | **Recipe tags** |
| 3860–3990 | **PDF Export** |
| 3997–4780 | **Recipe Detail data** — recipe data model, nutrition, detail rendering |

### Recipe Detail & Status

| Lines | Section |
|---|---|
| 4782–5380 | **Recipe detail view** — `viewRecipe()`, full recipe display with ingredients, method, costing, allergens, nutrition, QA section, role-gated topbar actions |
| 5382–5515 | **Recipe status workflow** — `setRecipeStatus()`, R&D-only gate, QA gates, approval gate (QA + cost + allergens + nutrition), auto-create production runs |
| 5516–5560 | **View-as preview** — `_previewRole`, `previewAs()`, `getCurrentUserRole()` |
| 5560–5600 | **Archive recipe** — archive/unarchive (approved only) |
| 5600–5620 | Export to Factory SOP |

### SOPs & Filters

| Lines | Section |
|---|---|
| 5620–6160 | **Factory SOP list** — SOP management, visual flow builder, save/approve |
| 6160–6200 | Filter: Recipes (includes Archived status filter) |
| 6200–6220 | Filter: Ingredients |
| 6220–6240 | Filter: Users |
| 6240–6280 | Modal system |
| 6280–6360 | New Recipe form (brand dropdown populated dynamically) |
| 6360–6680 | **Import External Recipes** — CSV/file import |

### Versioning & Editing

| Lines | Section |
|---|---|
| 6680–6800 | **Versioning** — recipe version history |
| 6800–6860 | Batch log |
| 6860–6920 | Version comparison |
| 6920–7240 | **Edit Recipe** — recipe edit form and save logic |
| 7240–7330 | New Ingredient form |
| 7330–7390 | Edit Ingredient (inline) |
| 7390–7450 | Edit User |
| 7450–7640 | Remove User |

### Dynamic Brand UI & Cards

| Lines | Section |
|---|---|
| 7640–7700 | **Dynamic Brand UI** — `populateBrandUI()`, `populateBrandDotCSS()`, `brandOptionsHTML()`, `getBrandColors()` |
| 7700–7770 | **Brand cards** — `buildBrandCards()`, `renderBrandDetail()` |

### Users & Access Control

| Lines | Section |
|---|---|
| 7770–7780 | **ACCESS_PERMISSIONS** — role-based permission matrix (Pages, Recipe Actions, Ingredients, QA, Builds, SOPs, Production, Users) |
| 7830–7890 | **Access Matrix UI** — `buildAccessMatrix()`, `toggleAccess()` |
| 7890–7960 | Invite form |

### QA & Nutrition

| Lines | Section |
|---|---|
| 7960–8000 | **QA recipe switcher** — `populateQARecipeDropdown()`, `updateQARecipe()` |
| 8000–8030 | Recipe detail nutrition edit |
| 8030–8170 | Nutrition calculations, `getQACurrentNPD()` |
| 8170–8400 | QA print functions, `saveNutrition()` |

### Brands & Operations

| Lines | Section |
|---|---|
| 8400–8500 | Edit Brand, Delete Brand |
| 8500–8550 | Delete Recipe |
| 8550–8700 | **Shelf Life Study** — data-backed shelf life tracking |
| 8700–8890 | QA page functions |
| 8890–8910 | Brand form (create new brand) |
| 8908–9025 | **Dashboard** — `updateDashboardStats()` — stat cards, pending actions, recent recipes, upcoming trials |

### Activity Log & Notifications

| Lines | Section |
|---|---|
| 9026–9040 | `getCurrentUserName()`, `logActivity()` — user tracking, 200 entry limit |
| 9040–9100 | `renderActivityLog()` — shows user name, date, time per entry |
| 9100–9170 | `renderNotifications()` |

### Pizza Builds & Production

| Lines | Section |
|---|---|
| 9170–9870 | **Pizza Builds** — build management, costing, allergens, nutrition, active/discontinued, comparison |
| 9870–9880 | `PRODUCTION_RUNS = []` |
| 9891–9960 | **Production table** — `buildProductionTable()`, 7-col layout, date log tag, days-without-date counter, role-gated action buttons |
| 9960–10000 | `saveProductionRun()` — manual run creation, auto-status based on date |
| 10000–10060 | **Status flow** — `changeRunStatus()`, `setRunStatus()` — Pending→Scheduled→Completed, On Hold, gates (date required, completion form) |
| 10060–10100 | `completeProductionRun()`, `saveCompleteRun()` — yield/waste, `completedAt` stamp |
| 10100–10120 | `editProductionRun()`, `saveEditRun()` — date change logging, auto-promote pending→scheduled |
| 10097–10115 | `showDateLog()` — modal showing date change history |

### Branch SOPs & Utilities

| Lines | Section |
|---|---|
| 11088–11560 | **Branch SOP** — per-branch SOP management with photos, allergens/nutrition from linked build, discontinued banner |
| 11560–11790 | **Build Import / Export** — CSV import/export for builds |
| 11790–11820 | Sidebar badges (notification counts) |
| 11820–11850 | Duplicate Recipe |
| 11850–11890 | Refresh UI after data changes |
| 11890–11916 | Empty states, `applySidebarPermissions()` init |
