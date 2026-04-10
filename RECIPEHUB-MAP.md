# RecipeHub-App-v2.html — Section Map

Quick reference for navigating the ~11.3K-line single-file app.

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
| 159–180 | Badges, Search/Filter bar |
| 181–208 | Form elements, Section dividers, Result cells |
| 209–234 | SOP blocks, Shelf life timeline |
| 235–267 | Ingredient category tags, EBS Sync & Autocomplete, brand-dot base (dynamic CSS injected by `populateBrandDotCSS()`) |
| 268–324 | Media upload, SOP step icons, Branch SOP cards |
| 325–362 | Report bars, Visual SOP flow, Packaging cost |
| 363–434 | Save toast, Print dropdown, Print overlay |
| 435–605 | Mobile responsive breakpoints |
| 606–628 | Sign-in page styles |

## HTML Body (lines 629–1797)

| Lines | Section |
|---|---|
| 629–734 | Sign-in page, Sidebar navigation |
| 735–758 | Topbar (dynamic) |
| 759–868 | `page-dashboard` |
| 869–898 | `page-recipes` (includes Archived filter + toggle) |
| 899–932 | `page-ingredients` |
| 933–1089 | `page-qa` — QA & Shelf Life (Physical/Chemical 7 params, Micro 9 organisms, Allergens + Nutrition side by side) |
| 1090–1327 | `page-sop` (Factory SOPs) |
| 1328–1356 | `page-branch-sop` |
| 1357–1414 | `page-reports` |
| 1415–1470 | `page-builds-costing` |
| 1471–1532 | `page-cost-control` |
| 1533–1558 | `page-production` (includes brand filter dropdown + dynamic stat cards) |
| 1559–1566 | `page-brands` (auto-wrap grid for any number of brands) |
| 1567–1610 | `page-builds` (includes Active/Discontinued filter, dynamic brand stats) |
| 1611–1787 | `page-users` |
| 1788–1818 | `page-recipe-detail` |

## JavaScript (lines 1819–11297)

### Core Systems

| Lines | Section |
|---|---|
| 1818–1828 | **Save / Load system** — `saveAllData()`, `loadAllData()`, localStorage persistence |
| 1824–2686 | **Oracle EBS Items Master** — pre-loaded ingredient data from gateway.dailyfoodsa.com |
| 2687–2759 | **EBS Ingredient Autocomplete** — search-as-you-type from EBS data |
| 2760–3340 | **Auth** — sign-in (SSO + email), user roles, permissions, `beforeunload` save handler |
| 3341–3398 | **Allergen system** — allergen tagging, auto-detection, and display |
| 3399–3424 | **Recipe tags** |
| 3425–3546 | **PDF Export** |
| 3547–3925 | **Recipe Detail data** — recipe data model, nutrition seeding, detail rendering |

### Recipes & SOPs

| Lines | Section |
|---|---|
| 3926–3993 | Build recipes table (with archive show/hide toggle) |
| 3994–4014 | SOP icon helper |
| 4015–4054 | Media upload (photos) |
| 4055–4294 | **Print functions** — print recipes, SOPs, reports |
| 4295–4331 | Auto cost calculator |
| 4332–4914 | **Recipe detail view** — full recipe display with ingredients, method, costing, allergens, nutrition |
| 4915–5042 | **Recipe status workflow** — draft/review/approved states |
| 5043–5076 | **Archive recipe** — archive/unarchive (approved only) |
| 5077–5092 | Export to Factory SOP |
| 5093–5620 | **Factory SOP list** — SOP management, visual flow builder |
| 5621–5698 | SOP save / approve workflow |

### Filters & Forms

| Lines | Section |
|---|---|
| 5699–5719 | Filter: Recipes (includes Archived status filter) |
| 5720–5734 | Filter: Ingredients |
| 5735–5747 | Filter: Users |
| 5748–5761 | Modal system |
| 5762–5823 | New Recipe form (brand dropdown populated dynamically) |
| 5824–6141 | **Import External Recipes** — CSV/file import |

### Versioning & Editing

| Lines | Section |
|---|---|
| 6142–6262 | **Versioning** — recipe version history |
| 6263–6321 | Batch log |
| 6322–6372 | Version comparison |
| 6373–6686 | **Edit Recipe** — recipe edit form and save logic (brand dropdown via `brandOptionsHTML()`) |
| 6687–6766 | New Ingredient form |
| 6767–6823 | Edit Ingredient (inline) |
| 6824–6883 | Edit User |
| 6884–7070 | Remove User |

### Dynamic Brand UI & Brand Cards

| Lines | Section |
|---|---|
| 7071–7126 | **Dynamic Brand UI** — `populateBrandUI()`, `populateBrandDotCSS()`, `populateBrandDropdowns()`, `brandOptionsHTML()`, `getBrandColors()`, `populateBrandCheckboxes()`, `populateBuildsBrandStats()` |
| 7127–7157 | **Brand cards** — `buildBrandCards()`, `renderBrandDetail()` |

### Users & Access

| Lines | Section |
|---|---|
| 7158–7260 | **Users** — `ROLE_META`, `USERS_DATA`, user list, table rendering |
| 7261–7460 | **Access Control Matrix** — role-based permissions |
| 7461–7555 | Invite form |

### QA & Nutrition

| Lines | Section |
|---|---|
| 7556–7590 | **QA recipe switcher** — `populateQARecipeDropdown()`, `updateQARecipe()` (dynamic from RECIPE_DB), allergen overrides |
| 7591–7615 | Recipe detail nutrition edit |
| 7616–7700 | Nutrition calculations, `getQACurrentNPD()` |
| 7701–7910 | QA print functions, `saveNutrition()` |

### Brands & Operations

| Lines | Section |
|---|---|
| 7911–7993 | Edit Brand, Delete Brand |
| 7994–8030 | Delete Recipe |
| 8031–8163 | **Shelf Life Study** — data-backed shelf life tracking |
| 8164–8310 | QA page functions |
| 8311–8360 | Brand form (create new brand, calls `populateBrandUI()`) |
| 8361–8478 | View Brand Recipe |
| 8479–8561 | **Activity Log & Notifications** |

### Pizza Builds & Production

| Lines | Section |
|---|---|
| 8562–9314 | **Pizza Builds** — build management, costing, allergens, nutrition, active/discontinued toggle, comparison, brand dropdown via `brandOptionsHTML()` |
| 9315–9496 | **Production Planning + Waste** — `PRODUCTION_RUNS` (starts empty), brand filter, dynamic stat cards with contextual sub-labels |
| 9497–9499 | Reports & Analytics (header) |
| 9500–10468 | **Savings Goal Tracker** — cost savings tracking and reports |

### Branch SOPs & Utilities

| Lines | Section |
|---|---|
| 10469–10955 | **Branch SOP** — per-branch SOP management with photos, allergens/nutrition from linked build, discontinued banner, brand colors via `getBrandColors()` |
| 10956–11180 | **Build Import / Export** — CSV import/export for builds |
| 11181–11204 | Sidebar badges (notification counts) |
| 11205–11234 | Duplicate Recipe |
| 11235–11269 | Refresh UI after data changes |
| 11270–11297 | Empty states |
