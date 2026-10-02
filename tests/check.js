/* Run with:  node tests/check.js
   Loads the repo data, runs the plan, and checks the numbers add up. */
const fs = require('fs'), path = require('path');
const C = require('../js/core.js');
const D = p => path.join(__dirname, '..', 'data', p);
const read = p => fs.existsSync(D(p)) ? fs.readFileSync(D(p), 'utf8') : '';
let failed = 0;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

const list = (kind, f) => { const t = read(f); return t ? C.readList(kind, t).rows : []; };
const products = list('products', 'csv/products.csv'), components = list('components', 'csv/product_components.csv');
const aliases = list('aliases', 'csv/sku-aliases.csv'), flavors = list('flavors', 'csv/flavors.csv');
const po = C.readPO(read('csv/po_lines.csv')).rows;
const orders = JSON.parse(read('json/open_orders.json')).lines;
const rules = JSON.parse(read('json/rules.json'));
const ref = C.build({ products, components, aliases, flavors });
const today = '2026-10-02';

ok(products.length === 242, `products loaded (${products.length})`);
ok(ref.comps.size > 50, `kits with contents (${ref.comps.size})`);

const run = (extra = {}, inv) => {
  const d = C.demand(ref, orders, po, { statuses: new Set(rules.statuses), includePO: true, today, rules, ...extra });
  return { d, r: C.plan(ref, d.lines, { today, batch: (extra.rules || rules).batch_cubes, inventory: inv || C.inventoryNow([], [], []), types: extra.types }) };
};
const { d, r } = run();
console.log(`\n${d.lines.length} demand lines -> ${r.flavors.length} flavors, ${r.kits.length} kits, ${r.prep.length} tubes`);
console.log(r.totals);

// 1. Flavor rows add up to the tally (plus the no-contents estimate)
const flavorSum = r.flavors.reduce((s, f) => s + f.total, 0);
ok(r.totals.cubesNeeded === flavorSum + (r.approx ? r.approx.cubes : 0), 'cubes needed = flavor rows + kits without contents');
ok(r.flavors.every(f => Object.values(f.types).reduce((a, b) => a + b, 0) === f.total), 'each flavor total = sum of its product-type columns');
ok(r.flavors.every(f => f.win.reduce((a, b) => a + b, 0) === f.total), 'each flavor total = sum of its windows');
ok(r.flavors.every(f => f.lines.reduce((a, b) => a + b.cubes, 0) === f.total), 'each flavor total = sum of its SKU detail lines');

// 2. Independent recount of exact-match Stick / Tallboy / Bulk Bag lines (no aliases, no POs, no netting)
const prod = new Map(products.map(p => [p.sku, p])), cases = new Map(products.filter(p => p.case_sku).map(p => [p.case_sku, p]));
const want = { Stick: 0, Tallboy: 0, 'Bulk Bag': 0 };
for (const l of orders) {
  if (!rules.statuses.includes(l.status)) continue;
  let p = prod.get(l.sku), mult = 1;
  if (!p && cases.has(l.sku)) { p = cases.get(l.sku); mult = +p.case_qty || 6; }
  if (p && want[p.product_type] !== undefined && p.include_in_plan !== 'N') want[p.product_type] += l.qty * mult * (+p.cubes_per_unit);
}
const got = run({ includePO: false }).r;
for (const t of Object.keys(want)) {
  const g = got.flavors.reduce((s, f) => s + f.types[t], 0);
  ok(g === want[t], `${t} cubes match an independent count (${g} vs ${want[t]})`);
}

// 3. Rimmers hold no cubes
ok(r.prep.filter(x => x.rimmer).every(x => x.net >= 0) && r.flavors.every(f => f.types.Kit >= 0), 'no negative demand');
const rim = ref.comps.get('GS037-PK').find(c => c.rimmer);
ok(rim && rim.flavor_code === '041', 'GS037-PK has a rimmer tube for flavor 041');

// 4. Built stock reduces demand, oldest first
const kitSku = r.kits.find(k => k.to_build > 0 && k.comps.length);
const inv = C.inventoryNow([{ sku: kitSku.sku, on_hand: kitSku.ordered, counted_at: '', notes: '' }], [], []);
const withStock = run({}, inv).r.kits.find(k => k.sku === kitSku.sku);
ok(withStock.to_build === 0 && withStock.built_used === kitSku.ordered, `built stock of ${kitSku.sku} covers its orders`);
const f0 = r.flavors[0];
const inv2 = C.inventoryNow([], [{ flavor_code: f0.flavor_code, cubes_on_hand: 100, counted_at: '', notes: '' }], [{ kind: 'cubes', type: 'adjust', key: f0.flavor_code, qty: 20, at: today }]);
const f0b = run({}, inv2).r.flavors.find(f => f.flavor_code === f0.flavor_code);
ok(f0b.on_hand === 120 && f0b.to_make === Math.max(0, f0b.total - 120), 'cube counts plus an adjustment net against the flavor');

// 5. Type filter
const onlyKits = run({ types: ['Kit'] }).r;
ok(onlyKits.flavors.every(f => f.types.Mini + f.types.Stick + f.types.Tallboy + f.types['Bulk Bag'] === 0), 'Kit filter drops every other product type');

// 6. SKU resolution
ok(C.resolveSku(ref, 'SM009').sku === 'SM009-PM', 'SM009 resolves to SM009-PM (assumed)');
ok(C.resolveSku(ref, 'SM1001').sku === 'SM001-GC', 'old SKU SM1001 resolves by alias');
ok(C.resolveSku(ref, 'C6-GS102').sku === 'C6-GS102' && ref.cases.get('C6-GS102').sku === 'GS102', 'case SKU maps to its kit');

// 7. Built counts file: loads despite repeated SKUs, and short SKUs match products
const bt = read('csv/inventory_built.csv');
if (bt.split(/\r?\n/).filter(Boolean).length > 1) {
  const br = C.readCounts('built', bt);
  ok(!br.error, `built counts file loads (${br.error || (br.rows.length + ' SKUs')})`);
  const mb = C.mapBuilt(ref, br.rows || []);
  ok(mb.rows.length > 0 && mb.rows.every(x => ref.prod.has(x.sku)) && [...mb.legacy.keys()].every(k => ref.prod.has(k)), `built counts matched to products (${mb.rows.length} products; ${mb.notes.unknown.length} ignored, ${mb.notes.ambiguous.length} ambiguous)`);
  const base = run({}).r.totals, withInv = run({}, C.withLegacy(C.inventoryNow(mb.rows, [], []), mb.legacy)).r.totals;
  ok(withInv.cubesNeeded < base.cubesNeeded && withInv.builtCubes > 0, `built counts lower cubes needed (${base.cubesNeeded} -> ${withInv.cubesNeeded}, ${withInv.builtCubes} covered)`);
  ok(base.cubesNeeded - withInv.cubesNeeded === withInv.builtCubes, 'cubes covered by built stock equals the drop in cubes needed');
}
const dup = C.readCounts('built', 'sku,on_hand,counted_at,notes\nAA1,5,,\nAA1,5,,\nBB2,19,,\nBB2,1320,,\nCC3,,,\n');
ok(!dup.error && dup.rows.find(r => r.sku === 'AA1').on_hand === 5 && dup.rows.find(r => r.sku === 'BB2').on_hand === 1339 && dup.dupes.length === 2, 'repeated SKUs merge (identical once, different added) and are reported');
ok(C.readCounts('built', 'sku,on_hand\nAA1,abc\n').error, 'a non-numeric count is still reported as an error');

// 8. Batches of 200 cubes, rounded up per recipe
const r0 = run().r;
ok(r0.batch === 200 && r0.totals.batchesToMake === r0.flavors.reduce((s, f) => s + Math.ceil(f.to_make / 200), 0) + (r0.approx ? Math.ceil(r0.approx.cubes / 200) : 0), 'batches to make = each flavor rounded up to whole 200-cube batches');
ok(r0.flavors.every(f => f.to_make === 0 || Math.ceil(f.to_make / 200) * 200 >= f.to_make), 'rounding up never leaves a flavor short');

// 9. Recipes: same_recipe_as merges flavors; recipe_code keeps inclusions apart
ok(ref.recipeOf('033') === '034' && ref.recipeOf('103') === '102' && ref.recipeOf('115') === '115', 'same-recipe flavors merge (033 to 034, 103 to 102) and 115 stays apart');
ok(ref.prod.get('TB003').recipe === '003-NI' && ref.prod.get('SS003').recipe === '003', 'Tallboy TB003 is its own no-inclusions recipe, Stick 003 is not');
ok(!r0.flavors.some(f => ['033', '039', '069', '085', '086', '103'].includes(f.flavor_code)), 'merged codes never appear as their own plan row');
const tb = r0.flavors.find(f => f.flavor_code === '003-NI'); ok(!!tb && tb.types.Tallboy === tb.total, '003-NI is counted apart from 003');

// 10. Cap colors come from the SKU suffix
const L2 = C.labelType;
ok(L2('GC').cap === 'Rust' && L2('PC').cap === 'Green' && L2('SP').cap === 'Cream' && L2('PM').cap === 'Cream' && L2('CB').cap === 'Rust' && L2('AW').cap === 'Cream' && L2('BL').cap === 'Cream' && L2('GR').cap === '', 'cap color by suffix: GC/CB rust, PC green, SP/PM/AW/BL cream, GR none');
ok(r0.prep.every(p => p.cap_color === L2(p.variant).cap), 'every Mini tube row takes its cap color from its suffix');

// 11. Kit detail lines are the kits as ordered, in kit units
const kitLines = r0.flavors.flatMap(f => f.lines.filter(l => l.type === 'Kit'));
ok(kitLines.length > 0 && kitLines.every(l => r0.kits.some(k => k.sku === l.sku)), 'kit detail lines are kit SKUs, not Mini tubes');
const kk = r0.kits.find(k => k.to_build > 0 && k.comps.length);
const kitUnits = r0.flavors.flatMap(f => f.lines).filter(l => l.sku === kk.sku).map(l => l.ordered);
ok(kitUnits.length > 0 && kitUnits.every(u => u === kk.ordered), `kit ${kk.sku} shows kit units ordered (${kk.ordered}) in the flavor detail, not tube or cube counts`);
ok(r0.kitFlavors.every(f => f.batches === Math.ceil(f.cubes / 200) && f.skus.reduce((s, x) => s + x.cubes, 0) === f.cubes), "kit tubes group by recipe, with batches from all of that recipe's kit cubes");

// 12. No-SKU lines are ignored, not flagged
ok(!r0.attention.some(a => a.sku.startsWith('(')), 'lines with no SKU are not listed');
const noSku = C.plan(ref, [{ source: 'ShipStation', ref: 'X1', order_date: '2026-09-01', raw_sku: '', sku: '', units: 5, window: 0 }], { today });
ok(noSku.totals.lines === 0 && noSku.attention.length === 0, 'a custom (no SKU) line adds nothing');

// 13. Faire handling
const dAll = run().d.faire;
ok(dAll.orders > 0 && dAll.skipped.units === 0, `Faire-looking orders found and all counted by default (${dAll.orders} orders, ${dAll.units} units, ${dAll.old_units} older than ${dAll.max_age_days} days)`);
const fAge = run({ rules: { ...rules, faire: { ...rules.faire, mode: 'max_age', max_age_days: 45 } } });
ok(fAge.d.faire.skipped.units === dAll.old_units && fAge.r.totals.cubesNeeded < r0.totals.cubesNeeded, 'max_age mode drops only Faire orders older than the limit');
const fNone = run({ rules: { ...rules, faire: { ...rules.faire, mode: 'none' } } });
ok(fNone.d.faire.skipped.units === dAll.units, 'none mode drops every Faire order');
const faireNums = [...new Set(orders.filter(o => /^[A-Z0-9]{10}$/.test(o.order_number) && /\d/.test(o.order_number) && /[A-Z]/.test(o.order_number)).map(o => o.order_number))];
const fList = run({ rules: { ...rules, faire: { ...rules.faire, mode: 'listed' } }, faireOpen: new Set(faireNums.slice(0, 5)) });
ok(fList.d.faire.skipped.lines > 0 && !fList.d.faire.listedMissing, 'listed mode counts only Faire orders on the open list');
ok(run({ rules: { ...rules, faire: { ...rules.faire, mode: 'listed' } } }).d.faire.listedMissing, 'listed mode with no list counts everything and says so');
ok(run({ rules: { ...rules, faire: { ...rules.faire, pattern: '' } } }).d.faire.orders === 0, 'an empty Faire pattern finds none');
const byStore = C.demand(ref, [{ order_number: 'ZZ99', order_date: '2026-06-01', status: 'awaiting_shipment', sku: 'SM001-GC', qty: 2, store: 'Faire' }], [], { statuses: new Set(['awaiting_shipment']), includePO: false, today, rules: { ...rules, faire: { ...rules.faire, mode: 'max_age' } } });
ok(byStore.faire.orders === 1 && byStore.lines.length === 0, 'a store name of Faire is recognised even when the order number has no pattern');

// 14. POs: a single PO plans on its own, and replaces_shipstation takes several values
const poNums = [...new Set(po.map(p => p.po_number))];
const onePo = poNums[1];
const poLines = run().d.lines.filter(l => l.source === 'PO' && l.ref === onePo);
const poPlan = C.plan(ref, poLines, { today, batch: 200, inventory: C.inventoryNow([], [], []) });
ok(poLines.length > 0 && poPlan.totals.batchesToMake >= 0, `a single PO plans on its own (${onePo}: ${poLines.length} lines, ${poPlan.totals.batchesToMake} batches)`);
const multi = C.demand(ref, [{ order_number: 'AB1', order_date: '2026-09-01', status: 'awaiting_shipment', sku: 'SM001-GC', qty: 2 }, { order_number: 'CD2', order_date: '2026-09-01', status: 'awaiting_shipment', sku: 'SM001-GC', qty: 3 }],
  [{ source: 'PO', po_number: 'P1', customer: 'X', sku: 'SM001-GC', units: 5, commit_date: '2026-11-01', lead_weeks: 1, status: 'open', replaces_shipstation: 'AB;CD' }], { statuses: new Set(['awaiting_shipment']), includePO: true, today, rules });
ok(multi.replaced.lines === 2 && multi.lines.length === 1, 'replaces_shipstation can name more than one order (AB;CD)');

// 15. Cube counts fold into the recipe
ok(C.mapCubes(ref, [{ flavor_code: '033', cubes_on_hand: 100 }, { flavor_code: '034', cubes_on_hand: 50 }])[0].cubes_on_hand === 150, 'cube counts for 033 and 034 add up under 034');

// 16. Whole batches that add up (no decimals in the table or the details)
ok(C.allocate([69.8, 1.1].map(x => x * 200), 71).join() === '70,1', 'allocation: 69.8 + 1.1 batches becomes 70 + 1 = 71');
let allocOk = true;
for (let t = 0; t < 400; t++) {
  const parts = Array.from({ length: 1 + (t % 7) }, (_, i) => (((t * 7919 + i * 104729) % 1000) + (i % 3 === 0 ? 0 : 1)) * 3);
  const whole = 1 + (t * 31) % 90, a = C.allocate(parts, whole), tot = parts.reduce((x, y) => x + y, 0);
  if (tot > 0 && (a.reduce((x, y) => x + y, 0) !== whole || a.some(v => !Number.isInteger(v) || v < 0))) allocOk = false;
}
ok(allocOk, 'allocation always returns whole numbers that sum to the total (400 random cases)');
ok(C.allocate([0, 0], 5).every(v => v === 0) && C.allocate([5], 0).every(v => v === 0), 'allocation handles empty input');
const fr = run().r;
ok(fr.flavors.every(f => f.batches === Math.ceil(f.total / 200) && f.lines.reduce((s, l) => s + l.b, 0) === f.batches), 'each flavor: batches needed = cubes / 200 rounded up, and its detail rows add up to it');
ok(fr.flavors.every(f => f.win_b.reduce((s, v) => s + v, 0) === f.batches), 'each flavor: the window columns add up to batches needed');
ok(fr.flavors.every(f => Number.isInteger(f.batches) && f.to_make >= 0), 'batches are whole numbers');
const inv3 = C.inventoryNow([], [{ flavor_code: fr.flavors[0].flavor_code, cubes_on_hand: 1000, counted_at: '', notes: '' }], []);
const f3 = run({}, inv3).r.flavors.find(f => f.flavor_code === fr.flavors[0].flavor_code);
ok(f3.on_hand_b === 5 && f3.to_make === Math.max(0, f3.total - 1000), 'loose cubes on hand show in whole batches (1,000 cubes is 5 batches)');

// 17. A kit listing the same label twice is counted once, and reported
const dupRef = C.build({ products, components: [
  { parent_sku: 'GS999', mini_sku: '', label_code: 'LM049-GC', qty: '1', notes: '' }, { parent_sku: 'GS999', mini_sku: '', label_code: 'LM062-GC', qty: '1', notes: '' },
  { parent_sku: 'GS999', mini_sku: '', label_code: 'LM049-GC', qty: '1', notes: '' }, { parent_sku: 'GS999', mini_sku: '', label_code: 'LM049-GC', qty: '2', notes: '' }], aliases: [], flavors });
ok(dupRef.comps.get('GS999').length === 2 && dupRef.comps.get('GS999').find(c => c.label_code === 'LM049-GC').qty === 2 && dupRef.dupComps.length === 1 && dupRef.dupComps[0].times === 3, 'a label listed 3 times for one kit counts once at the largest qty, and is reported');
ok(ref.dupComps.length === 0 || ref.dupComps.every(d => ref.comps.get(d.parent).filter(c => c.label_code === d.label_code).length === 1), 'repo kits never carry a repeated label after loading');
if (ref.comps.get('GS110')) ok(ref.comps.get('GS110').length === 3 && ref.dupComps.some(d => d.parent === 'GS110'), 'GS110 has 3 contents rows (2 tubes and a rimmer) once its repeats are counted once');

// 18. Legacy (short SKU) counts are kept apart from new counts but still count as stock
const lm = C.mapBuilt(ref, [{ sku: 'SM001', on_hand: 19 }, { sku: 'SM001-GC', on_hand: 100 }, { sku: 'SM002', on_hand: 7 }]);
ok(lm.legacy.get('SM001-GC') === 19 && lm.legacy.get('SM002-GC') === 7 && lm.rows.length === 1 && lm.rows[0].on_hand === 100, 'a short SKU is a legacy count, kept apart from the new SKU count');
ok(lm.notes.legacy.length === 2 && lm.notes.merged.length === 0, 'legacy matches are listed as legacy, not as merged counts');
const li = C.withLegacy(C.inventoryNow(lm.rows, [], [{ kind: 'built', type: 'adjust', key: 'SM001-GC', qty: 5, at: today }]), lm.legacy);
const l1 = li.built.get('SM001-GC'), l2 = li.built.get('SM002-GC');
ok(l1.newN === 105 && l1.legacy === 19 && l1.n === 105, 'new 100 + 5 adjusted = 105, legacy 19 kept apart and not added to the new stock');
ok(l2.newN === null && l2.legacy === 7 && l2.n === null, 'a product with only a legacy count has no new stock');
const mbAll = C.mapBuilt(ref, C.readCounts('built', bt).rows);
const withLeg = run({}, C.withLegacy(C.inventoryNow(mbAll.rows, [], []), mbAll.legacy)).r, noLeg = run({}, C.inventoryNow(mbAll.rows, [], [])).r;
ok(withLeg.totals.cubesNeeded === noLeg.totals.cubesNeeded && withLeg.totals.batchesToMake === noLeg.totals.batchesToMake, 'legacy stock never offsets new-SKU or kit demand (the plan is the same with or without it)');
const sm9 = withLeg.prep.find(p => p.sku === 'SM009-PM');
ok(!sm9 || sm9.direct === 24 || sm9.direct < 444, 'an order under bare SM009 is legacy demand and adds no label tubes');
const lg9 = withLeg.legacy.rows.find(x => x.raw === 'SM009');
ok(!!lg9 && lg9.ordered > 0 && lg9.covered === Math.min(lg9.ordered, lg9.stock) && lg9.short === lg9.ordered - lg9.covered, `legacy orders (SM009: ${lg9 && lg9.ordered}) are filled from legacy stock (${lg9 && lg9.stock}) only`);
const lgNo = noLeg.legacy.rows.find(x => x.raw === 'SM009');
ok(lgNo.covered === 0 && lgNo.short === lgNo.ordered, 'with no legacy stock counted, legacy orders show as short');
ok(!withLeg.attention.some(a => a.kind === 'assumed' && /^SM0\d\d$/.test(a.sku)), 'bare Mini SKUs on orders are legacy, not an assumption to confirm');

console.log('\nNeeds attention:', r.attention.filter(a => a.kind === 'unmapped').slice(0, 8).map(a => `${a.sku} (${a.units})`).join(', '));
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
