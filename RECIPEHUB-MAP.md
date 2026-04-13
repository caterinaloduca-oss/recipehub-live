# RecipeHub-App-v2.html — Section Map

Quick reference for navigating the ~12.7K-line single-file app.

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

## HTML Body (lines 629–2200)

| Lines | Section |
|---|---|
| 629–745 | Sign-in page, Sidebar navigation (includes View-as dropdown, sync status, Stress/Cleanup/Report buttons) |
| 746–755 | Topbar (dynamic) + Preview role banner |
| 775–880 | `page-dashboard` — stat cards, pending actions, recent recipes, upcoming trials, activity log |
| 881–910 | `page-recipes` (Archived filter + toggle) |
| 911–944 | `page-ingredients` |
| 945–1103 | `page-qa` — Physical/Chemical 7 params, Micro 9 organisms, Allergens + Nutrition, Shelf Life Study |
| 1104–1340 | `page-sop` (Factory SOPs) |
| 1341–1368 | `page-branch-sop` (includes `bsop-detail` dynamic area) |
| 1369–1426 | `page-reports` |
| 1427–1482 | `page-builds-costing` |
| 1483–1541 | `page-cost-control` |
| 1542–1569 | `page-production` (stat cards: Pending/Scheduled/Completed/Waste, 7-col table) |
| 1570–1577 | `page-brands` |
| 1578–1621 | `page-builds` (Active/Discontinued filter, dynamic brand stats) |
| 1622–1989 | `page-workflow` — Recipe lifecycle, role cards, production run flow, approval checklist, build lifecycle, branch SOP lifecycle, access-by-role matrix |
| 1990–2164 | `page-users` |
| 2165–2200 | `page-recipe-detail` (dynamic) |

## JavaScript (lines 2201–12734)

### Core Systems

| Lines | Section |
|---|---|
| 2203–2217 | **Save / Load system** — `STORAGE_KEY`, `API_BASE`, `API_KEY`, sync flags (`_localDirty`, `_savingToServer`) |
| 2218–3080 | **Oracle EBS Items Master** — pre-loaded ingredient data |
| 3081–3153 | **EBS Ingredient Autocomplete** — `ebsAutocomplete()` searches EBS + local ING_DATA |
| 3154–3452 | **Auth** — sign-in (SSO + email), user roles, `beforeunload` save with `sendBeacon`, backup import/export with data migration |
| 3453–3478 | **`_saveToServer()`** — throttled POST to `/api/data` with bearer auth, dirty/saving flags |
| 3480–3503 | **`saveAllData()`** — builds data blob, saves localStorage, fires `_saveToServer()` |
| 3504–3668 | **`loadAllData()`** — loads from localStorage, smart merge for recipes/brands/SOPs, `_deletedRecipeIds` tracking |
| 3670–3760 | **`syncFromServer()`** — pulls from server every 30s, skips if dirty/saving, hydrates if server is newer |
| 3715–3760 | **`_hydrateFromData()`** — replaces all in-memory arrays from a server data blob |
| 3762–3800 | **PAGES config** — page titles and topbar actions |
| 3800–3860 | **Role enforcement** — `applyRoleRestrictions()`, `stripPageActions()`, `canAccessPage()`, `applySidebarPermissions()` |
| 3860–3920 | **Navigation** — `nav()`, `showPage()`, `goBack()` |
| 3954–4037 | **Allergen system** + **Recipe tags** |
| 4038–4160 | **PDF Export** |

### Recipe Data & Cost System

| Lines | Section |
|---|---|
| 4160–4450 | **Recipe Detail data** — `RECIPE_DB`, recipe data model, nutrition, QA history, batch logs |
| 4453 | **`_deletedRecipeIds`** — tracks deleted hardcoded recipe IDs to prevent re-merge |
| 4551–4610 | **`buildRecipesTable()`** — sorted newest-first by NPD code |
| 4914–4950 | **Auto Cost Calculator** — `calcRecipeCost()`, `updateRecipeCost()` |
| 4952–4990 | **`_getIngPrice()`**, **`_calcIngCostTotal()`**, **`_calcActualCostPerKg()`** — ingredient cost lookup chain (override → DB → null), yield-adjusted |
| 4990–5020 | **`editIngCost()`** — click-to-edit ingredient cost, stores `i.costPerKg` override |
| 5020–5076 | **`updateFoodCost()`** — live update Food Cost section, debounced save (1s), never deletes existing values |

### Recipe Detail & Status

| Lines | Section |
|---|---|
| 5077–5120 | **`toggleBakerPct()`** — Baker's % view with cost column |
| 5121–5750 | **`viewRecipe()`** — recipe detail with ingredients (cost column, clickable), **Food Cost section** (5 cols: Cost/kg, Portion, Selling Price, Food Cost %, Yield), method, photos, packaging, allergens, nutrition, production yield |
| 5753–5920 | **`setRecipeStatus()`** — R&D-only gate, QA gates, auto-creates production runs |
| 5920–5970 | **Archive recipe**, **`confirmDeleteRecipe()`** with `_deletedRecipeIds` tracking |
| 5970–6000 | **Export to Factory SOP** |

### SOPs & Filters

| Lines | Section |
|---|---|
| 5970–6500 | **Factory SOP** — SOP management, visual flow builder, save/approve |
| 6577–6625 | Filters: Recipes, Ingredients, Users |
| 6626–6640 | Modal system |
| 6640–6700 | New Recipe form |
| 6702–7288 | **Import External Recipes** |

### Versioning & Editing

| Lines | Section |
|---|---|
| 7289–7410 | **Versioning** |
| 7410–7470 | Batch log |
| 7469–7520 | Version comparison |
| 7520–7840 | **Edit Recipe** — ingredient name inputs have `ebsAutocomplete()` attached for DB search |
| 7838–7975 | New/Edit Ingredient |
| 7975–8035 | Edit/Remove User |

### Dynamic Brand UI

| Lines | Section |
|---|---|
| 8221–8350 | `populateBrandUI()`, `brandOptionsHTML()`, `getBrandColors()`, `buildBrandCards()`, `renderBrandDetail()` |

### Access Control

| Lines | Section |
|---|---|
| 8130–8220 | **ACCESS_PERMISSIONS**, **Access Matrix UI** |
| 8250–8300 | Invite form |

### QA & Nutrition

| Lines | Section |
|---|---|
| 8300–8550 | **QA recipe switcher**, nutrition edit, nutrition calculations, QA print |
| 8550–8900 | **Shelf Life Study**, QA page functions, Brand form |

### Dashboard & Activity

| Lines | Section |
|---|---|
| 8900–9050 | **`updateDashboardStats()`**, **`getCurrentUserName()`**, **`logActivity()`** |
| 9050–9120 | `renderActivityLog()`, `renderNotifications()` |

### Builds

| Lines | Section |
|---|---|
| 9120–9700 | **Builds management** — BUILDS_DATA, `viewBuild()`, costing, allergens, nutrition, comparison |

### Production

| Lines | Section |
|---|---|
| 9870–10200 | **Production runs** — `PRODUCTION_RUNS`, `buildProductionTable()`, status flow, completion, edit, date log |

### Reports

| Lines | Section |
|---|---|
| 10400–11700 | **Reports** — cost analysis, batch efficiency, bulk savings, cost trends, build cost breakdowns |

### Branch SOPs

| Lines | Section |
|---|---|
| 11737–11768 | **`BRANCH_SOPS`** data array |
| 11769–11778 | **`BSOP_BRAND_COLORS`** — Maestro=green, Pinzatta=pink, Tivo=purple, Telliano=yellow, Mano di Pasta=navy, Mad=red |
| 11822–11860 | **`getBranchSOPAllergenNutritionPrintHTML()`** — print version with components table + shelf life + brand colors |
| 11889–11970 | **`getBranchSOPAllergenNutritionHTML()`** — detail view with components table (5 cols including 2nd Shelf Life dropdown) + allergens + nutrition |
| 11975–12020 | **`buildBranchSOPTable()`** — list with colored brand dots |
| 12022–12060 | **`viewBranchSOP()`** — detail view with brand-colored header/borders, components, allergens, nutrition |
| 12079–12098 | **`setComponentShelfLife()`** — saves QA shelf life per component to `sop.componentShelfLife` |
| 12112–12250 | **`openBranchSOPForm()`**, SOP creation, step editing |
| 12276–12295 | **`deleteBranchSOP()`** |
| 12296–12310 | **`printBranchSOP()`** — color-coded print with components + shelf life |

### Utilities & Init

| Lines | Section |
|---|---|
| 12310–12660 | **Build Import/Export** CSV, Sidebar badges, Duplicate Recipe |
| 11797–11820 | Init block: build all tables, `syncFromServer()`, 30s sync interval |

### Stress Test (embedded)

| Lines | Section |
|---|---|
| 12669–12734 | **`stressTest`** — `generate()`, `report()`, `cleanup()`. Sidebar button handler |
