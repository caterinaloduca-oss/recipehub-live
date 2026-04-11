// ═══════════════════════════════════════════════
// RecipeHub Stress Test — paste into browser console
// ═══════════════════════════════════════════════
// Run: stressTest.generate()   → inject test data
// Run: stressTest.report()     → check localStorage usage
// Run: stressTest.cleanup()    → remove all test data
// ═══════════════════════════════════════════════

var stressTest = (function() {

  var brands = ['Maestro','Mad','Pinzatta','Tivo','Telliano'];
  var types = ['Pizza Sauce','Marinade','Dressing','Seasoning','Dip','Mayo','Pesto','Glaze','Rub','Brine'];
  var statuses = ['draft','review','trial','prod-trial','approved'];
  var ingredients = ['Water','Salt','Sugar','Vinegar','Sunflower Oil','Olive Oil','Garlic Powder','Onion Powder','Paprika','Black Pepper','Cumin','Oregano','Basil','Thyme','Tomato Paste','Citric Acid','Xanthan Gum','Mustard Powder','Chilli Flakes','Lemon Juice','Soy Sauce','Honey','Corn Starch','Milk Powder','Cream Cheese'];
  var adjectives = ['Classic','Smoky','Spicy','Tangy','Creamy','Bold','Golden','Zesty','Rustic','Premium','Signature','Artisan','Gourmet','Traditional','Heritage','Fire-Roasted','Sun-Dried','Wild','Aged','Double'];
  var nouns = ['Blend','Mix','Base','Finish','Drizzle','Glaze','Rub','Marinade','Sauce','Dressing','Dip','Spread','Paste','Reduction','Infusion','Emulsion','Compound','Extract','Concentrate','Relish'];

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function randBetween(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
  function randFloat(a, b, dec) { return parseFloat((Math.random() * (b - a) + a).toFixed(dec || 2)); }
  function pad(n) { return String(n).padStart(3, '0'); }
  function randDate(daysBack) {
    var d = new Date();
    d.setDate(d.getDate() - Math.floor(Math.random() * daysBack));
    return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
  }
  function randISODate(daysBack) {
    var d = new Date();
    d.setDate(d.getDate() - Math.floor(Math.random() * daysBack));
    return d.toISOString();
  }
  function randFutureDate(daysAhead) {
    var d = new Date();
    d.setDate(d.getDate() + Math.floor(Math.random() * daysAhead));
    return d.toISOString().split('T')[0];
  }

  function makeRecipeName() {
    return pick(adjectives) + ' ' + pick(nouns);
  }

  function makeIngredients() {
    var count = randBetween(5, 12);
    var used = {};
    var list = [];
    var remaining = 100;
    for (var i = 0; i < count; i++) {
      var name;
      do { name = pick(ingredients); } while (used[name]);
      used[name] = true;
      var pct = (i === count - 1) ? parseFloat(remaining.toFixed(2)) : parseFloat((Math.random() * (remaining / (count - i) * 1.8)).toFixed(2));
      if (pct <= 0) pct = 0.1;
      remaining -= pct;
      if (remaining < 0) { pct += remaining; remaining = 0; }
      list.push({name: name, pct: parseFloat(pct.toFixed(2))});
    }
    return list;
  }

  function makeMethod() {
    var steps = randBetween(4, 8);
    var list = [];
    var verbs = ['Combine','Mix','Blend','Heat','Cool','Add','Incorporate','Stir','Whisk','Fold','Season','Emulsify','Reduce','Strain','Transfer'];
    for (var i = 0; i < steps; i++) {
      list.push({title: pick(verbs) + ' step ' + (i+1), text: 'Process description for step ' + (i+1) + '. Follow standard operating procedure.'});
    }
    return list;
  }

  // ── Generate test data ──
  function generate(opts) {
    opts = opts || {};
    var numRecipes = opts.recipes || 100;
    var numBuilds = opts.builds || 50;
    var numRuns = opts.runs || 30;
    var numSOPs = opts.sops || 20;
    var numLogs = opts.logs || 150;

    console.log('🧪 Stress test: generating ' + numRecipes + ' recipes, ' + numBuilds + ' builds, ' + numRuns + ' runs, ' + numSOPs + ' SOPs, ' + numLogs + ' log entries...');
    var t0 = performance.now();

    // ── Recipes ──
    var existingCount = Object.keys(RECIPE_DB).length;
    for (var i = 0; i < numRecipes; i++) {
      var npd = 'ST-' + pad(i + 1);
      var status = pick(statuses);
      var brand = pick(brands);
      var ings = makeIngredients();
      var recipe = {
        name: makeRecipeName() + ' #' + (i+1),
        npd: npd,
        brand: brand,
        type: pick(types),
        version: 'v1.' + randBetween(0, 5),
        costKg: status === 'approved' || Math.random() > 0.3 ? 'SAR ' + randFloat(5, 35, 2) : null,
        status: status,
        updated: randDate(60),
        catClass: 'cat-general',
        storage: pick(['Ambient','Chilled 2-8°C','Frozen −18°C']),
        shelfLife: pick(['3 Months','6 Months','9 Months','12 Months','18 Months']),
        yield: randFloat(0.85, 0.98, 2),
        packaging: [{name:'Standard Bucket 5kg', code:'PK-ST-'+pad(i), unitCost: randFloat(1, 4, 2), units:'per bucket'}],
        media: [],
        ingredients: ings,
        method: makeMethod(),
        sopSteps: [],
        allergens: Math.random() > 0.3 ? [pick(['Gluten','Milk','Egg','Soy','Mustard','Celery','Sesame'])] : [],
        nutrition: Math.random() > 0.3 ? {energy:randBetween(100,400),fat:randFloat(2,25),saturated:randFloat(0.5,10),carbs:randFloat(5,50),sugars:randFloat(1,15),fibre:randFloat(0,5),protein:randFloat(2,20),salt:randFloat(0.3,3)} : null,
        tags: [pick(['new','priority','seasonal','export','bulk'])],
        changeLog: [{date: randISODate(30), by: 'Stress Test', changes: 'Auto-generated test data'}],
      };
      // Add QA data for trial statuses
      if (status === 'trial' || status === 'prod-trial') {
        var qaKey = status + 'QA';
        recipe[qaKey] = {
          signed: Math.random() > 0.5,
          signedBy: Math.random() > 0.5 ? 'QA Tester' : '',
          signedAt: randDate(10),
          tpc: '<10,000', ym: '<100', col: '<10', ecoli: 'ND', sal: 'ND/25g',
          files: []
        };
      }
      RECIPE_DB[npd] = recipe;
    }
    console.log('  ✓ ' + numRecipes + ' recipes added (' + Object.keys(RECIPE_DB).length + ' total)');

    // ── Builds ──
    var existingBuilds = BUILDS_DATA.length;
    for (var j = 0; j < numBuilds; j++) {
      var buildBrand = pick(brands);
      BUILDS_DATA.push({
        id: 'ST-BLD-' + pad(j + 1),
        name: pick(adjectives) + ' ' + pick(['Margherita','Pepperoni','BBQ Chicken','Veggie Supreme','Hawaiian','Meat Feast','Diavola','Capricciosa','Four Cheese','Truffle']) + ' #' + (j+1),
        brand: buildBrand,
        type: pick(['Pizza','Sandwich','Pasta','Salad','Wrap']),
        size: pick(['Small','Medium','Large','Piano']),
        status: 'approved',
        active: Math.random() > 0.15,
        components: [
          {type:'Dough', item:'Test Dough', source:'sfg', weight:randBetween(180,300)+'g', tool:'', toolQty:'1 pc', cost:randFloat(1.5, 3)},
          {type:'Sauce', item:'Test Sauce', source:'recipe', ref:'ST-001', weight:randBetween(60,120)+'g', tool:'Ladle', toolQty:'4 oz × 1', cost:randFloat(0.5, 2)},
          {type:'Cheese', item:'Test Cheese', source:'ingredient', weight:randBetween(100,200)+'g', tool:'Scooper', toolQty:'½ oz × 2', cost:randFloat(2, 5)},
          {type:'Topping', item:'Test Topping', source:'ingredient', weight:randBetween(20,80)+'g', tool:'Hand', toolQty:'varies', cost:randFloat(0.1, 2)},
        ],
        instructions: 'Stretch dough. Spread sauce. Add cheese and toppings. Bake.',
        bakeTemp: '465°F (241°C)',
        bakeTime: randBetween(3, 6) + ' min',
        updated: randDate(30),
      });
    }
    console.log('  ✓ ' + numBuilds + ' builds added (' + BUILDS_DATA.length + ' total)');

    // ── Production Runs ──
    var existingRuns = PRODUCTION_RUNS.length;
    var runStatuses = ['pending','scheduled','completed','on-hold'];
    for (var k = 0; k < numRuns; k++) {
      var runStatus = pick(runStatuses);
      var hasDate = runStatus !== 'pending' || Math.random() > 0.6;
      var run = {
        id: 'ST-PR-' + pad(k + 1),
        date: hasDate ? randFutureDate(30) : '',
        recipe: pick(adjectives) + ' ' + pick(nouns) + ' #' + (k+1),
        npd: 'ST-' + pad(randBetween(1, numRecipes)),
        brand: pick(brands),
        batchSize: pick(['150 kg','300 kg','400 kg','500 kg','1000 kg']),
        operator: pick(['Dana Yousef','Subhanshu Tripathi','Ali Hassan','Mohammed Al-Rashid','']),
        status: runStatus,
        runType: pick(['Factory Trial','Production Trial','Production']),
        yield: runStatus === 'completed' ? randBetween(88, 98) + '%' : '',
        waste: runStatus === 'completed' ? randBetween(2, 12) + '%' : '',
        notes: 'Stress test run #' + (k+1),
        createdAt: randISODate(20),
        completedAt: runStatus === 'completed' ? randISODate(5) : undefined,
      };
      // Add date change log to some runs
      if (Math.random() > 0.6) {
        run.dateLog = [];
        var changes = randBetween(1, 5);
        for (var c = 0; c < changes; c++) {
          run.dateLog.push({from: randFutureDate(30), to: randFutureDate(30), at: randISODate(15)});
        }
      }
      PRODUCTION_RUNS.push(run);
    }
    console.log('  ✓ ' + numRuns + ' production runs added (' + PRODUCTION_RUNS.length + ' total)');

    // ── Branch SOPs ──
    var existingSOPs = BRANCH_SOPS.length;
    for (var m = 0; m < numSOPs; m++) {
      var sopSteps = [];
      var stepCount = randBetween(5, 10);
      for (var s = 0; s < stepCount; s++) {
        sopSteps.push({img: null, text: 'Step ' + (s+1) + ': Process description for assembly.', portions: randBetween(1, 4) + ' scoops'});
      }
      BRANCH_SOPS.push({
        id: 'ST-SOP-' + pad(m + 1),
        name: pick(adjectives) + ' ' + pick(['Ranch','BBQ','Pepperoni','Veggie','Classic','Supreme','Deluxe','Special','Loaded','Original']) + ' #' + (m+1),
        brand: pick(brands),
        version: 'V-0' + randBetween(1, 5),
        date: randDate(60),
        status: pick(['draft','review','approved']),
        buildRef: m < numBuilds ? 'ST-BLD-' + pad(m + 1) : '',
        steps: sopSteps,
      });
    }
    console.log('  ✓ ' + numSOPs + ' branch SOPs added (' + BRANCH_SOPS.length + ' total)');

    // ── Activity Log ──
    var logTypes = ['status','qa','production','builds','user'];
    var logIcons = ['📤','🔬','📅','🍕','👤','✅','🏭','📋','🔄','⏳'];
    var logMessages = ['Recipe status changed','QA signed off','Run scheduled','Build updated','User invited','Recipe approved','Factory trial started','SOP created','Status changed','Waiting for date'];
    for (var n = 0; n < numLogs; n++) {
      ACTIVITY_LOG.push({
        type: pick(logTypes),
        icon: pick(logIcons),
        message: pick(logMessages) + ' — test item #' + (n+1),
        detail: 'Stress test activity',
        user: pick(['Caterina Loduca','Dana Yousef','Naresh Kumar','Vikram Bishnoi','Test User']),
        time: String(randBetween(6,23)).padStart(2,'0') + ':' + String(randBetween(0,59)).padStart(2,'0'),
        date: randDate(30).split(' ').slice(0,2).join(' '),
        ts: randISODate(30),
        read: Math.random() > 0.5,
        forRole: 'all',
      });
    }
    if (ACTIVITY_LOG.length > 200) ACTIVITY_LOG.length = 200;
    console.log('  ✓ Activity log filled (' + ACTIVITY_LOG.length + ' entries)');

    // ── Save & measure ──
    var t1 = performance.now();
    console.log('  ⏱ Data generated in ' + Math.round(t1 - t0) + 'ms');

    try {
      saveAllData();
      console.log('  💾 saveAllData() succeeded');
    } catch(e) {
      console.error('  ❌ saveAllData() FAILED:', e.message);
    }

    report();

    // Refresh UI
    try {
      buildRecipesTable();
      buildBuildsTable();
      buildProductionTable();
      buildBranchSOPTable();
      updateDashboardStats();
      updateSidebarBadges();
      renderActivityLog();
      console.log('  🖥 UI refreshed');
    } catch(e) {
      console.error('  ⚠ UI refresh error:', e.message);
    }

    console.log('✅ Stress test complete. Navigate around and check for issues.');
  }

  // ── Report localStorage usage ──
  function report() {
    var key = 'recipehub_data_v1';
    var raw = localStorage.getItem(key);
    var bytes = raw ? new Blob([raw]).size : 0;
    var kb = (bytes / 1024).toFixed(1);
    var mb = (bytes / (1024 * 1024)).toFixed(2);
    var pct = ((bytes / (5 * 1024 * 1024)) * 100).toFixed(1);

    console.log('');
    console.log('📊 localStorage Report');
    console.log('─────────────────────');
    console.log('  Size:     ' + kb + ' KB (' + mb + ' MB)');
    console.log('  Capacity: ' + pct + '% of ~5 MB');
    console.log('  Recipes:  ' + Object.keys(RECIPE_DB).length);
    console.log('  Builds:   ' + BUILDS_DATA.length);
    console.log('  Runs:     ' + PRODUCTION_RUNS.length);
    console.log('  SOPs:     ' + BRANCH_SOPS.length);
    console.log('  Activity: ' + ACTIVITY_LOG.length);
    console.log('');

    if (parseFloat(pct) > 80) {
      console.warn('⚠️ localStorage is above 80% — approaching the ~5MB limit!');
    }
    if (parseFloat(pct) > 95) {
      console.error('🚨 localStorage is above 95% — saves will start failing!');
    }

    return {bytes: bytes, kb: parseFloat(kb), mb: parseFloat(mb), pct: parseFloat(pct)};
  }

  // ── Cleanup: remove all stress test data ──
  function cleanup() {
    console.log('🧹 Cleaning up stress test data...');

    // Remove test recipes (npd starts with ST-)
    var removed = 0;
    Object.keys(RECIPE_DB).forEach(function(k) {
      if (k.indexOf('ST-') === 0) { delete RECIPE_DB[k]; removed++; }
    });
    console.log('  ✓ Removed ' + removed + ' test recipes');

    // Remove test builds
    var beforeBuilds = BUILDS_DATA.length;
    for (var i = BUILDS_DATA.length - 1; i >= 0; i--) {
      if (BUILDS_DATA[i].id.indexOf('ST-') === 0) BUILDS_DATA.splice(i, 1);
    }
    console.log('  ✓ Removed ' + (beforeBuilds - BUILDS_DATA.length) + ' test builds');

    // Remove test production runs
    var beforeRuns = PRODUCTION_RUNS.length;
    for (var j = PRODUCTION_RUNS.length - 1; j >= 0; j--) {
      if (PRODUCTION_RUNS[j].id.indexOf('ST-') === 0) PRODUCTION_RUNS.splice(j, 1);
    }
    console.log('  ✓ Removed ' + (beforeRuns - PRODUCTION_RUNS.length) + ' test runs');

    // Remove test SOPs
    var beforeSOPs = BRANCH_SOPS.length;
    for (var k = BRANCH_SOPS.length - 1; k >= 0; k--) {
      if (BRANCH_SOPS[k].id.indexOf('ST-') === 0) BRANCH_SOPS.splice(k, 1);
    }
    console.log('  ✓ Removed ' + (beforeSOPs - BRANCH_SOPS.length) + ' test SOPs');

    // Clear activity log test entries
    for (var m = ACTIVITY_LOG.length - 1; m >= 0; m--) {
      if (ACTIVITY_LOG[m].detail === 'Stress test activity') ACTIVITY_LOG.splice(m, 1);
    }
    console.log('  ✓ Cleaned activity log');

    saveAllData();
    buildRecipesTable();
    buildBuildsTable();
    buildProductionTable();
    buildBranchSOPTable();
    updateDashboardStats();
    updateSidebarBadges();
    renderActivityLog();

    report();
    console.log('✅ Cleanup complete. All test data removed.');
  }

  return { generate: generate, report: report, cleanup: cleanup };

})();

console.log('');
console.log('🧪 RecipeHub Stress Test loaded');
console.log('────────────────────────────────');
console.log('  stressTest.generate()   → inject 100 recipes, 50 builds, 30 runs, 20 SOPs');
console.log('  stressTest.generate({recipes:200, builds:100, runs:50, sops:40, logs:200})');
console.log('  stressTest.report()     → check localStorage usage');
console.log('  stressTest.cleanup()    → remove all test data (ST- prefix)');
console.log('');
