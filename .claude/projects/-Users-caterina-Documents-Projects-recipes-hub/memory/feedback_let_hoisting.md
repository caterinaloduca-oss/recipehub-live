---
name: Never reference let/const before definition
description: Critical JS bug - let/const variables in single-file HTML apps are not hoisted, IIFEs and top-level code must come AFTER variable definitions
type: feedback
---

Never reference `let` or `const` variables before their definition line in the HTML file. Unlike `function` declarations, `let`/`const` are NOT hoisted — accessing them before definition causes a fatal "Cannot access before initialization" error that kills ALL JS execution, making the entire app appear empty/broken.

**Why:** Caused a critical incident where the user lost visibility of all data (Branch SOPs, Production Runs, Builds all appeared empty) because a single IIFE referencing `SAVINGS_GOAL` was placed before the `let SAVINGS_GOAL` definition. The error killed script execution before table-building functions ran.

**How to apply:** When adding new `let`/`const` global variables to RecipeHub-App-v2.html, always place IIFEs and initialization code AFTER the variable definition. Wrap top-level init calls in try/catch to prevent one error from killing the whole app.
