# RecipeHub Stress Test Checklist

## Setup

1. Open `recipehub.dailyfoodsa.com` in Chrome
2. Open DevTools Console (Cmd+Opt+J)
3. Paste the contents of `stress-test.js` into the console
4. Run `stressTest.generate()` to inject test data
5. Note the localStorage usage % from the report

---

## A. Performance (after generating test data)

- [ ] **Dashboard loads** — pending actions, recent recipes, upcoming trials all render
- [ ] **Recipes page** — table renders all recipes without freezing
- [ ] **Recipes filter** — type a search term, check it filters within 1-2 seconds
- [ ] **Production page** — table renders, stat cards update
- [ ] **Builds page** — all builds render, brand stats update
- [ ] **Branch SOP page** — table renders
- [ ] **Page navigation** — click through all sidebar pages, no lag > 1 second
- [ ] **Activity log** — dashboard log shows entries with user names and dates
- [ ] **Print/PDF** — open print preview on a recipe, check it doesn't crash

## B. localStorage Limits

- [ ] **Run `stressTest.report()`** — note the % usage
- [ ] **Generate more**: `stressTest.generate({recipes:200, builds:100})` — check if save still works
- [ ] **Check for save failure toast** — if localStorage is full, does the app alert?
- [ ] **Refresh page** — does all data survive the refresh?
- [ ] **Export backup** — click Export in sidebar. Does the JSON download complete?
- [ ] **Import backup** — save the export, clear localStorage, re-import. All data intact?

## C. Recipe Workflow Gates

- [ ] **Draft → In Review** — works (R&D/admin only)
- [ ] **In Review → Factory Trial** — works, creates production run as Pending
- [ ] **Factory Trial → Prod Trial WITHOUT QA sign-off** — should be BLOCKED with toast
- [ ] **Factory Trial → Prod Trial WITH QA sign-off** — works, creates second production run
- [ ] **Prod Trial → Approved WITHOUT QA sign-off** — should be BLOCKED
- [ ] **Prod Trial → Approved WITHOUT costing** — should be BLOCKED with "missing: costing"
- [ ] **Prod Trial → Approved WITHOUT allergens** — should be BLOCKED with "missing: allergens"
- [ ] **Prod Trial → Approved WITHOUT nutrition** — should be BLOCKED with "missing: nutrition"
- [ ] **Prod Trial → Approved with ALL data** — works, recipe shows as Approved

## D. Production Run Flow

- [ ] **Auto-created run** — appears as Pending with no date
- [ ] **Days without date** — shows "Xd without date" on runs with `createdAt`
- [ ] **Edit run, set date** — auto-promotes from Pending → Scheduled
- [ ] **Date change** — change date again, check `dateLog` counter (amber "2x")
- [ ] **Click date counter** — shows date history modal
- [ ] **Status → Scheduled without date** — should be BLOCKED with toast, opens edit form
- [ ] **Status → Completed** — opens yield/waste form, stamps `completedAt`
- [ ] **Completed run** — only shows Archive button (no Status/Edit)
- [ ] **On Hold** — available from Pending and Scheduled, not from Completed

## E. Role Enforcement (use "View as" dropdown)

### Viewer
- [ ] All pages visible in sidebar
- [ ] ZERO action buttons on any page (no Edit, New, Status, Delete, Archive)
- [ ] Recipe detail — no Edit/SOP/More/Status buttons
- [ ] Can click recipes to view detail (read-only)

### Purchasing
- [ ] All pages visible
- [ ] Ingredients page — can see Add/Edit buttons
- [ ] Recipes page — NO action buttons
- [ ] Recipe detail — NO Edit/SOP/More buttons
- [ ] Builds page — NO action buttons
- [ ] Production page — NO action buttons

### Factory
- [ ] All pages visible
- [ ] Production page — can see Schedule/Edit/Status/Complete buttons
- [ ] Recipes page — NO action buttons
- [ ] Builds page — NO action buttons
- [ ] Branch SOP page — NO action buttons

### QA
- [ ] All pages visible
- [ ] QA page — can add test points, edit results
- [ ] Recipe detail — can see QA sign-off section, fill in results, click Sign Off
- [ ] Recipe detail — NO Edit/SOP/More/Status topbar buttons
- [ ] Builds page — can see edit buttons
- [ ] Branch SOP page — can see edit buttons
- [ ] Production page — NO action buttons

### R&D (npd)
- [ ] All pages visible
- [ ] Recipes — can create, edit, move stages, approve
- [ ] Builds — can create, edit, discontinue
- [ ] Branch SOPs — can create, edit
- [ ] Factory SOPs — can edit steps
- [ ] Ingredients — can add/edit
- [ ] Production page — NO action buttons (factory's domain)
- [ ] Users page — NOT visible in sidebar

### Admin
- [ ] Everything works — all buttons visible on all pages
- [ ] Users & Access page visible and functional
- [ ] "View as" dropdown works

## F. Data Integrity

- [ ] **Save → Refresh → Verify** — add a recipe manually, refresh, it's still there
- [ ] **Backup export** — export JSON, check file size
- [ ] **Backup import** — import the JSON on a different browser/incognito, all data loads
- [ ] **Status migration** — any old `in-progress` runs should auto-migrate to `pending` or `scheduled`
- [ ] **Activity log user tracking** — perform an action, check log shows your name

## G. Edge Cases

- [ ] **Empty recipe name** — try to create a recipe with no name, should be blocked
- [ ] **Empty build name** — same, should be blocked
- [ ] **Double-click status** — rapidly click status change, check no duplicate production runs
- [ ] **Very long recipe name** — create a recipe with 200-char name, check it truncates in tables
- [ ] **Modal while role switching** — open a modal, switch role via "View as", check no crash
- [ ] **Archive & restore** — archive a production run, show archived, restore it

## Cleanup

1. Run `stressTest.cleanup()` in console to remove all test data
2. Run `stressTest.report()` to verify localStorage is back to normal size
3. Refresh and verify the app works with original data only

---

## Results

| Category | Pass | Fail | Notes |
|---|---|---|---|
| A. Performance | | | |
| B. localStorage | | | |
| C. Workflow Gates | | | |
| D. Production Flow | | | |
| E. Role Enforcement | | | |
| F. Data Integrity | | | |
| G. Edge Cases | | | |
