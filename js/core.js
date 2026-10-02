/* Cube planning engine. No DOM access, so it runs in the browser and in Node (tests/check.js).

   The plan is keyed on FLAVOR CODE (the recipe). Every product that holds cubes turns into cubes of a flavor:
     Mini, Stick, Tallboy, Bulk Bag  -> units x cubes_per_unit, flavor from the product row
     Kit                             -> its component tubes (label_code), flavor from the label number
   LM / label codes only matter for Mini tubes, so they only appear in the tube prep table. */
(function (root) {
  'use strict';

  const TYPES = ['Mini', 'Stick', 'Tallboy', 'Bulk Bag', 'Kit'];
  const LATER = 5;                                   // windows 0-4 are weeks; 5 holds everything later
  /* batch_cubes: one production batch. faire: Faire orders land in ShipStation but are shipped from Faire, so they can sit open for months.
     mode: all (count them), max_age (ignore Faire orders older than max_age_days), listed (count only orders in faire_open_orders.csv), none (ignore). */
  const DEFAULT_RULES = {
    age_rules: [{ min_age: 60, window: 0 }, { min_age: 30, window: 1 }, { min_age: 14, window: 2 }, { min_age: 0, window: 3 }],
    statuses: ['awaiting_shipment', 'on_hold'],
    batch_cubes: 200,
    faire: { pattern: '^(?=.*[A-Z])(?=.*\\d)[A-Z0-9]{10}$', mode: 'all', max_age_days: 45 }
  };
  const withDefaults = r => ({ ...DEFAULT_RULES, ...(r || {}), faire: { ...DEFAULT_RULES.faire, ...((r || {}).faire || {}) } });

  /* The suffix of a label or Mini SKU (SM001-GC) says what kind of cube it is, and which cap goes on the tube. */
  const LABEL_TYPES = {
    GC: { name: 'Gourmet Cafe in a Cube', cap: 'Rust' },
    PC: { name: 'Premium Cocktail Mixer in a Cube', cap: 'Green' },
    SP: { name: 'Premium Spritz Mixer in a Cube', cap: 'Cream' },
    PM: { name: 'Premium Mimosa in a Cube', cap: 'Cream' },
    CB: { name: 'Craft Beverage Mixer in a Cube', cap: 'Rust' },
    AW: { name: 'Artisanal Wine Mixer in a Cube', cap: 'Cream' },
    BL: { name: 'Premium Bellini Mixer in a Cube', cap: 'Cream' },
    GR: { name: 'Gourmet Drink Rimmer', cap: '' }
  };
  const labelType = suf => LABEL_TYPES[String(suf || '').toUpperCase()] || { name: '', cap: '' };

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    const out = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = ''; if (row.some(x => x !== '')) out.push(row); row = [];
      } else f += c;
    }
    row.push(f); if (row.some(x => x !== '')) out.push(row);
    if (!out.length) return [];
    const h = out.shift().map(s => s.trim());
    return out.map(r => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? '').trim()])));
  }
  function toCSV(headers, rows) {
    const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [headers, ...rows.map(r => headers.map(h => r[h]))].map(r => r.map(cell).join(',')).join('\n') + '\n';
  }
  const headerOf = text => String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].split(',').map(s => s.trim().replace(/^"|"$/g, ''));

  /* ---------- Dates and windows ---------- */
  function iso(y, mo, d) { const dt = new Date(Date.UTC(y, mo - 1, d)); return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null; }
  function normDate(v) {
    const s = String(v || '').trim(); let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/))) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
    return null;
  }
  const day = s => new Date(s + 'T00:00:00Z');
  const addDays = (s, n) => { const d = day(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function weekStart(s) { const d = day(s); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); }
  const weeksBetween = (a, b) => Math.round((day(weekStart(b)) - day(weekStart(a))) / (7 * 864e5));

  /* ShipStation orders carry no due date, so order age decides the window. PO lines use their commit date.
     Window 0 is this week and includes anything past due. */
  function windowFor(line, today, rules) {
    const r = withDefaults(rules);
    let w;
    if (line.source === 'PO') w = Math.max(0, weeksBetween(today, line.commit_date) - (line.lead_weeks ?? 1));
    else {
      const age = (day(today) - day(line.order_date)) / 864e5;
      const list = r.age_rules.slice().sort((a, b) => b.min_age - a.min_age);
      w = (list.find(x => age >= x.min_age) || list[list.length - 1]).window;
    }
    return Math.min(w, LATER);
  }
  function windowLabel(i, today) {
    if (i >= LATER) return 'Later';
    const start = addDays(weekStart(today), 7 * i), end = addDays(start, 6);
    const f = (s, o) => day(s).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
    const same = start.slice(5, 7) === end.slice(5, 7);
    const range = `${f(start, { month: 'short', day: 'numeric' })}–${same ? f(end, { day: 'numeric' }) : f(end, { month: 'short', day: 'numeric' })}`;
    return i === 0 ? `Now: ${range}` : range;
  }

  /* ---------- Uploaded file checks ---------- */
  const FILES = {
    orders:     { headers: ['order_number', 'order_date', 'status', 'sku', 'qty'], required: ['order_number', 'order_date', 'sku', 'qty'] },
    po:         { headers: ['source', 'po_number', 'customer', 'sku', 'units', 'commit_date', 'commit_type', 'lead_weeks', 'status', 'replaces_shipstation', 'notes'], required: ['po_number', 'sku', 'units', 'commit_date'] },
    products:   { headers: ['sku', 'product_name', 'product_type', 'flavor_code', 'flavor_name', 'flavor_category', 'label_code', 'cap_color', 'cubes_per_unit', 'case_sku', 'case_qty', 'include_in_plan', 'active', 'notes', 'recipe_code'], required: ['sku', 'product_type'] },
    components: { headers: ['parent_sku', 'mini_sku', 'label_code', 'qty', 'notes'], required: ['parent_sku', 'label_code'] },
    aliases:    { headers: ['old_sku', 'new_sku', 'notes'], required: ['old_sku', 'new_sku'] },
    flavors:    { headers: ['flavor_code', 'flavor_name', 'notes', 'same_recipe_as'], required: ['flavor_code'] },
    faire:      { headers: ['order_number', 'notes'], required: ['order_number'] },
    built:      { headers: ['sku', 'on_hand', 'counted_at', 'notes'], required: ['sku', 'on_hand'] },
    cubes:      { headers: ['flavor_code', 'cubes_on_hand', 'counted_at', 'notes'], required: ['flavor_code', 'cubes_on_hand'] }
  };
  const ORDER_ALIASES = {
    order_number: ['order_number', 'order number', 'order - number', 'order #', 'ordernumber'],
    order_date: ['order_date', 'order date', 'date - order date', 'orderdate'],
    status: ['status', 'order status', 'order - status', 'orderstatus'],
    sku: ['sku', 'item sku', 'item - sku', 'item_sku'],
    qty: ['qty', 'quantity', 'item - qty', 'item qty', 'item_qty']
  };
  const missingMsg = (kind, miss) => `Missing column${miss.length > 1 ? 's' : ''}: ${miss.join(', ')}. The first row must be: ${FILES[kind].headers.join(',')}`;
  function finish(rows, problems) {
    if (problems.length) return { error: `${problems.length} row${problems.length > 1 ? 's' : ''} couldn't be read. ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '; …' : ''}` };
    return { rows };
  }
  function normStatus(s) { const k = String(s || '').trim().toLowerCase().replace(/[\s-]+/g, '_'); return k === '' ? 'awaiting_shipment' : k; }

  /* Orders keep only order number, date, status, SKU and qty. Any other column (names, addresses) is dropped. */
  function readOrders(text) {
    const raw = parseCSV(text); if (!raw.length) return { error: 'That file has no data rows.' };
    const keys = Object.keys(raw[0]), pick = {};
    for (const [f, names] of Object.entries(ORDER_ALIASES)) pick[f] = keys.find(k => names.includes(k.toLowerCase()));
    const miss = FILES.orders.required.filter(f => !pick[f]);
    if (miss.length) return { error: missingMsg('orders', miss) };
    const rows = [], problems = [];
    raw.forEach((r, i) => {
      const d = normDate(r[pick.order_date]), q = Number(r[pick.qty]);
      if (!d) problems.push(`Row ${i + 2}: order date "${r[pick.order_date]}" isn't a date`);
      else if (!Number.isFinite(q)) problems.push(`Row ${i + 2}: qty "${r[pick.qty]}" isn't a number`);
      else rows.push({ order_number: r[pick.order_number], order_date: d, status: pick.status ? normStatus(r[pick.status]) : 'awaiting_shipment', sku: r[pick.sku], qty: Math.round(q) });
    });
    return finish(rows, problems);
  }
  function readTable(kind, text) {
    const raw = parseCSV(text);
    const miss = FILES[kind].required.filter(h => !headerOf(text).includes(h));
    if (miss.length) return { error: missingMsg(kind, miss) };
    return { raw };
  }
  function readPO(text) {
    const t = readTable('po', text); if (t.error) return t;
    const rows = [], problems = [];
    t.raw.forEach((r, i) => {
      const d = normDate(r.commit_date), u = Number(r.units), lead = r.lead_weeks === '' || r.lead_weeks == null ? 1 : Number(r.lead_weeks);
      if (!r.sku) problems.push(`Row ${i + 2}: no SKU`);
      else if (!d) problems.push(`Row ${i + 2}: commit date "${r.commit_date}" isn't a date`);
      else if (!Number.isFinite(u)) problems.push(`Row ${i + 2}: units "${r.units}" isn't a number`);
      else if (!Number.isFinite(lead) || lead < 0) problems.push(`Row ${i + 2}: lead weeks "${r.lead_weeks}" must be 0 or more`);
      else rows.push({ ...Object.fromEntries(FILES.po.headers.map(k => [k, r[k] ?? ''])), units: Math.round(u), commit_date: d, lead_weeks: lead, status: (r.status || 'open').toLowerCase() });
    });
    return finish(rows, problems);
  }
  function readList(kind, text, opt) {               // products, components, aliases, flavors: keep every column as text
    const t = readTable(kind, text); if (t.error) return t;
    if (!t.raw.length && !(opt && opt.allowEmpty)) return { error: 'That file has no data rows.' };
    return { rows: t.raw.map(r => Object.fromEntries(FILES[kind].headers.map(k => [k, r[k] ?? '']))) };
  }
  function readCounts(kind, text) {                  // built: sku, on_hand   cubes: flavor_code, cubes_on_hand
    const t = readTable(kind, text); if (t.error) return t;
    const key = kind === 'built' ? 'sku' : 'flavor_code', val = kind === 'built' ? 'on_hand' : 'cubes_on_hand';
    const seen = new Map(), problems = [];
    t.raw.forEach((r, i) => {
      const k = r[key], v = r[val] === '' ? null : Number(r[val]);
      if (!k) problems.push(`Row ${i + 2}: no ${key}`);
      else if (v !== null && (!Number.isFinite(v) || v < 0)) problems.push(`Row ${i + 2}: count "${r[val]}" must be a number, 0 or more, or blank`);
      else {
        if (!seen.has(k)) seen.set(k, { first: r, vals: [] });
        if (v !== null) seen.get(k).vals.push(Math.round(v));
      }
    });
    if (problems.length) return finish([], problems);
    /* A SKU listed more than once is merged, never rejected. Identical repeats count once; different numbers are added together.
       Either way it's reported so the file can be corrected. */
    const rows = [], dupes = [];
    for (const [k, e] of seen) {
      let v = null;
      if (e.vals.length) {
        const same = e.vals.every(x => x === e.vals[0]);
        v = e.vals.length === 1 ? e.vals[0] : same ? e.vals[0] : e.vals.reduce((a, b) => a + b, 0);
        if (e.vals.length > 1) dupes.push({ key: k, values: e.vals, used: v, how: same ? 'identical rows, counted once' : 'different numbers, added together' });
      }
      rows.push({ [key]: k, [val]: v === null ? '' : v, counted_at: normDate(e.first.counted_at) || '', notes: e.first.notes || '' });
    }
    return { rows, dupes };
  }
  /* Built counts are matched to products the way orders are: exact SKU, case SKU (times the case size), alias, or sample.
     A short SKU with no suffix (SM001 for SM001-GC) is a LEGACY count: older stock, kept apart from the new SKU's count
     but still counted as stock for that product. Counts that can't be matched to one product aren't used, and are listed
     so they can be fixed. Blank counts mean "not counted". */
  function mapBuilt(ref, rows) {
    const out = new Map(), legacy = new Map(), notes = { assumed: [], ambiguous: [], unknown: [], merged: [], legacy: [] }, from = new Map();
    for (const r of rows || []) {
      if (r.on_hand === '' || r.on_hand == null) continue;
      let sku = r.sku, qty = +r.on_hand, isLegacy = false;
      if (!ref.prod.has(sku)) {
        const c = ref.cases.get(sku);
        if (c) { sku = c.sku; qty *= c.qty; notes.assumed.push({ from: r.sku, to: sku, qty: +r.on_hand, why: `case of ${c.qty}` }); }
        else {
          const x = resolveSku(ref, sku);
          if (x.unresolved) { notes.ambiguous.push({ sku: r.sku, qty, reason: x.unresolved }); continue; }
          if (!ref.prod.has(x.sku)) { notes.unknown.push({ sku: r.sku, qty }); continue; }
          if (x.via === 'prefix') { isLegacy = true; notes.legacy.push({ from: r.sku, to: x.sku, qty }); }
          else notes.assumed.push({ from: r.sku, to: x.sku, qty, why: x.via === 'alias' ? 'alias' : 'sample' });
          sku = x.sku;
        }
      }
      if (isLegacy) { legacy.set(sku, (legacy.get(sku) || 0) + qty); continue; }
      if (!from.has(sku)) from.set(sku, []);
      from.get(sku).push(r.sku);
      const e = out.get(sku) || { sku, on_hand: 0, counted_at: r.counted_at || '', notes: r.notes || '' };
      e.on_hand += qty; out.set(sku, e);
    }
    for (const [sku, srcs] of from) if (srcs.length > 1) notes.merged.push({ sku, from: srcs, total: out.get(sku).on_hand });
    return { rows: [...out.values()], legacy, notes };
  }
  /* Add legacy counts to an inventory. Legacy Minis are an older, unlabeled, different-size tube: they are NOT stock for the new SKU,
     so n (the stock the plan uses for new SKUs and kits) stays the new count. They only fill orders placed under the short SKU. */
  function withLegacy(inv, legacy) {
    for (const [sku, q] of legacy || []) {
      const x = inv.built.get(sku) || { n: null, counted_at: '', edits: 0 };
      x.legacy = q; inv.built.set(sku, x);
    }
    for (const x of inv.built.values()) { x.newN = x.n; if (x.legacy === undefined) x.legacy = 0; }
    return inv;
  }

  /* ---------- Inventory: uploaded or repo counts, then a log of in-app edits on top ---------- */
  /* base rows from readCounts(); log entries: { kind:'built'|'cubes', type:'set'|'adjust', key, qty, at, note } */
  function inventoryNow(baseBuilt, baseCubes, log) {
    const mk = (rows, key, val) => new Map((rows || []).map(r => [r[key], { n: r[val] === '' || r[val] == null ? null : +r[val], counted_at: r.counted_at || '', edits: 0 }]));
    const inv = { built: mk(baseBuilt, 'sku', 'on_hand'), cubes: mk(baseCubes, 'flavor_code', 'cubes_on_hand') };
    for (const e of log || []) {
      const m = inv[e.kind]; if (!m) continue;
      if (!m.has(e.key)) m.set(e.key, { n: null, counted_at: '', edits: 0 });
      const x = m.get(e.key);
      if (e.type === 'set') { x.n = e.qty; x.counted_at = String(e.at).slice(0, 10); } else x.n = Math.max(0, (x.n ?? 0) + e.qty);
      x.edits++;
    }
    return inv;
  }

  /* ---------- Reference data ---------- */
  const labelParts = code => { const m = /^LM(\d+)-([A-Z0-9]+)$/i.exec(String(code || '').trim()); return m ? { num: m[1], suf: m[2].toUpperCase() } : null; };
  const miniSkuFor = (label, given) => { const p = labelParts(label); return p ? `SM${p.num}-${p.suf}` : (given || ''); };

  /* Some flavors are the same recipe as another (033 is the same as 034), so they share cubes and batches.
     flavors.csv same_recipe_as does that. A recipe that differs only by inclusions is kept apart: give its products a
     recipe_code (TB003 uses 003-NI, "London Fog, no inclusions") and add that code to flavors.csv. */
  function build({ products, components, aliases, flavors }) {
    const same = new Map();
    for (const f of flavors || []) if (f.flavor_code && f.same_recipe_as) same.set(f.flavor_code.trim(), f.same_recipe_as.trim());
    const recipeOf = code => { let c = code, i = 0; while (same.has(c) && i++ < 10) c = same.get(c); return c; };
    const prod = new Map(), cases = new Map();
    for (const r of products) {
      const cpu = r.cubes_per_unit === '' || r.cubes_per_unit == null ? null : Number(r.cubes_per_unit);
      const p = { sku: r.sku.trim(), name: r.product_name, type: r.product_type, flavor_code: (r.flavor_code || '').trim(), flavor_name: r.flavor_name || '',
                  category: r.flavor_category || '', label_code: (r.label_code || '').trim(), cap_color: r.cap_color || '',
                  cubes_per_unit: Number.isFinite(cpu) ? cpu : null, case_sku: (r.case_sku || '').trim(), case_qty: +r.case_qty || 6, recipe_code: (r.recipe_code || '').trim(),
                  include: String(r.include_in_plan || 'Y').toUpperCase() !== 'N', active: String(r.active || 'Y').toUpperCase() !== 'N', notes: r.notes || '' };
      if (!p.sku) continue;
      p.recipe = (p.recipe_code || p.flavor_code) ? recipeOf(p.recipe_code || p.flavor_code) : '';
      prod.set(p.sku, p);
      if (p.case_sku) cases.set(p.case_sku, { sku: p.sku, qty: p.case_qty });
    }
    const comps = new Map(), warnings = [], seenComp = new Map(), dupComps = new Map();
    for (const c of components) {
      const lp = labelParts(c.label_code), given = (c.mini_sku || '').trim();
      const sku = miniSkuFor(c.label_code, given);
      const givenFixed = labelParts(given) ? miniSkuFor(given) : given;           // a label code typed into the mini_sku column
      if (given && lp && givenFixed !== sku) warnings.push({ parent: c.parent_sku, text: `mini_sku ${given} doesn't match label ${c.label_code}` });
      const e = { parent: c.parent_sku, label_code: c.label_code, mini_sku: sku, flavor_code: lp ? lp.num : '', variant: lp ? lp.suf : '',
                  qty: c.qty === '' || c.qty == null ? 1 : +c.qty || 1, rimmer: !!lp && lp.suf === 'GR', notes: c.notes || '' };
      /* The same label listed twice for one kit is treated as a repeated row, not two tubes: use qty for two of a kind.
         The larger qty is kept, and the repeat is reported so the file can be fixed. */
      const ck = e.parent + '|' + String(c.label_code).trim().toUpperCase();
      if (seenComp.has(ck)) {
        const first = seenComp.get(ck), d = dupComps.get(ck) || { parent: e.parent, label_code: e.label_code, qtys: [first.qty] };
        d.qtys.push(e.qty); dupComps.set(ck, d); first.qty = Math.max(first.qty, e.qty); continue;
      }
      seenComp.set(ck, e);
      if (!comps.has(e.parent)) comps.set(e.parent, []);
      comps.get(e.parent).push(e);
    }
    const dupList = [...dupComps.values()].map(d => ({ ...d, times: d.qtys.length, used: Math.max(...d.qtys) }));
    const names = new Map();                                                        // flavor_code -> name
    for (const p of prod.values()) if (p.flavor_code && !names.has(p.flavor_code)) {
      if (p.type === 'Mini' && p.flavor_name) names.set(p.flavor_code, p.flavor_name);
    }
    for (const p of prod.values()) if (p.flavor_code && !names.has(p.flavor_code)) {
      if (p.type === 'Bulk Bag' && p.name) names.set(p.flavor_code, p.name);
      else if (p.type === 'Stick' && p.name) names.set(p.flavor_code, p.name.split('|')[0].trim());
    }
    for (const f of flavors || []) if (f.flavor_code && f.flavor_name) names.set(f.flavor_code, f.flavor_name);
    const alias = new Map();
    (aliases || []).forEach(a => { if (a.old_sku && a.new_sku) alias.set(a.old_sku.trim().toUpperCase(), a.new_sku.trim()); });
    return { prod, cases, comps, names, alias, warnings, dupComps: dupList, recipeOf, same };
  }
  const flavorName = (ref, code) => ref.names.get(code) || '';

  /* Current SKU for an order SKU:
       1. a product SKU or a case SKU is used as is
       2. an old SKU in the aliases file becomes its new SKU
       3. a sample (ends in -S) is the same product as the SKU without -S
       4. a bare base SKU (SM009) matches the one product that starts with it (SM009-PM), flagged as assumed */
  function resolveSku(ref, sku) {
    const known = s => ref.prod.has(s) || ref.cases.has(s);
    if (!sku || known(sku)) return { sku, via: null };
    const a = ref.alias.get(sku.toUpperCase());
    if (a) return { sku: a, via: 'alias' };
    const keys = [...ref.prod.keys()];
    const starts = base => keys.filter(k => k.toUpperCase().startsWith(base.toUpperCase() + '-') && !/-S$/i.test(k));
    const m = sku.match(/^(.+)-S$/i);
    if (m) {
      const base = m[1];
      if (known(base)) return { sku: base, via: 'sample' };
      const hits = starts(base);
      if (hits.length === 1) return { sku: hits[0], via: 'sample' };
      return { sku, via: 'sample', unresolved: hits.length ? `Sample matches ${hits.length} products (${hits.join(', ')})` : `Sample of ${base}, which isn't in products` };
    }
    if (/^[A-Za-z]{2}\d+$/.test(sku)) {
      const hits = starts(sku);
      if (hits.length === 1) return { sku: hits[0], via: 'prefix' };
      if (hits.length > 1) return { sku, via: 'prefix', unresolved: `Matches ${hits.length} products (${hits.join(', ')}). Add an alias for the one you mean` };
    }
    return { sku, via: null };
  }

  /* ---------- Demand: ShipStation lines + PO lines, one list ---------- */
  /* opts: { statuses:Set, includePO:boolean, today, rules, faireOpen:Set|null } */
  function demand(ref, orders, poLines, opts) {
    const rules = withDefaults(opts.rules), fc = rules.faire;
    let faireRe = null; try { faireRe = fc.pattern ? new RegExp(fc.pattern) : null; } catch (e) { faireRe = null; }
    const isFaire = l => !!((l.store && /faire/i.test(l.store)) || (faireRe && faireRe.test(String(l.order_number))));
    const out = [], replaced = { lines: 0, units: 0, by: {} };
    const faire = { mode: fc.mode, max_age_days: fc.max_age_days, orders: new Set(), units: 0, old_orders: new Set(), old_units: 0, skipped: { lines: 0, units: 0 }, listedMissing: false, ages: { lt14: 0, lt30: 0, lt60: 0, gte60: 0 } };
    const pos = opts.includePO ? poLines.filter(p => p.status === 'open') : [];
    const resolve = (raw, source) => {                  // old/sample SKU -> current SKU, then case SKU -> its product. PO units are already finished units.
      const r = resolveSku(ref, raw), c = ref.cases.get(r.sku);
      const base = { via: r.via, unresolved: r.unresolved };
      return c ? { ...base, sku: c.sku, mult: source === 'ShipStation' ? c.qty : 1 } : { ...base, sku: r.sku, mult: 1 };
    };
    /* replaces_shipstation: a ShipStation order number, or the start of several (MO-PS). Separate more than one with ; */
    const repl = pos.filter(p => p.replaces_shipstation).flatMap(p => String(p.replaces_shipstation).split(/[;|]/).map(x => x.trim()).filter(Boolean).map(prefix => ({ prefix, po: p.po_number, sku: resolve(p.sku, 'PO').sku })));
    for (const l of orders) {
      if (!opts.statuses.has(l.status) || !(l.qty > 0)) continue;
      const r = resolve(l.sku, 'ShipStation');
      const hit = repl.find(x => String(l.order_number).startsWith(x.prefix) && x.sku === r.sku);
      if (hit) {
        replaced.lines++; replaced.units += l.qty * r.mult;
        const b = replaced.by[hit.po] || (replaced.by[hit.po] = { lines: 0, units: 0 }); b.lines++; b.units += l.qty * r.mult;
        continue;
      }
      if (isFaire(l)) {
        const age = (day(opts.today) - day(l.order_date)) / 864e5, units = l.qty * r.mult, old = age > fc.max_age_days;
        faire.orders.add(l.order_number); faire.units += units;
        faire.ages[age < 14 ? 'lt14' : age < 30 ? 'lt30' : age < 60 ? 'lt60' : 'gte60'] += units;
        if (old) { faire.old_units += units; faire.old_orders.add(l.order_number); }
        let skip = false;
        if (fc.mode === 'max_age') skip = old;
        else if (fc.mode === 'none') skip = true;
        else if (fc.mode === 'listed') { if (opts.faireOpen && opts.faireOpen.size) skip = !opts.faireOpen.has(String(l.order_number)); else faire.listedMissing = true; }
        if (skip) { faire.skipped.lines++; faire.skipped.units += units; continue; }
      }
      const d = { source: 'ShipStation', ref: l.order_number, order_date: l.order_date, raw_sku: l.sku, sku: r.sku, units: l.qty * r.mult, via: r.via, unresolved: r.unresolved };
      d.window = windowFor(d, opts.today, rules); out.push(d);
    }
    for (const p of pos) {
      if (!(p.units > 0)) continue;
      const r = resolve(p.sku, 'PO');
      const d = { source: 'PO', ref: p.po_number, customer: p.customer, order_date: p.commit_date, commit_date: p.commit_date, lead_weeks: p.lead_weeks,
                  raw_sku: p.sku, sku: r.sku, units: p.units, via: r.via, unresolved: r.unresolved };
      d.window = windowFor(d, opts.today, rules); out.push(d);
    }
    return { lines: out, replaced, faire: { ...faire, orders: faire.orders.size, old_orders: faire.old_orders.size } };
  }

  /* Split a whole number of batches across parts in proportion to their cubes, so the parts are whole numbers that add up
     to the total (largest remainder). Used to show batches without decimals in the details and by window. */
  function allocate(parts, whole) {
    const tot = parts.reduce((a, b) => a + b, 0);
    if (!(tot > 0) || !(whole > 0)) return parts.map(() => 0);
    const raw = parts.map(p => p / tot * whole), base = raw.map(v => Math.floor(v + 1e-9));
    let left = whole - base.reduce((a, b) => a + b, 0);
    const order = raw.map((v, i) => ({ i, f: v - base[i], p: parts[i] })).sort((a, b) => b.f - a.f || b.p - a.p || a.i - b.i);
    for (let k = 0; k < order.length && left > 0; k++, left--) base[order[k].i]++;
    return base;
  }

  /* ---------- Plan ---------- */
  /* opts: { today, batch, types:[...] | null, inventory:{built:Map, cubes:Map} }
     Cubes are grouped by RECIPE (flavor code after same_recipe_as and recipe_code). A batch is `batch` cubes of one recipe. */
  function plan(ref, lines, opts) {
    const size = opts.batch || DEFAULT_RULES.batch_cubes;
    const types = opts.types && opts.types.length < TYPES.length ? new Set(opts.types) : null;
    const invB = opts.inventory ? opts.inventory.built : new Map(), invC = opts.inventory ? opts.inventory.cubes : new Map();
    const stock = new Map([...invB].map(([k, v]) => [k, v.n || 0]));                // finished units, consumed oldest demand first
    const attention = new Map();
    const flag = (kind, sku, units, reason, fix, to) => {
      const k = kind + '|' + sku;
      if (!attention.has(k)) attention.set(k, { kind, sku, lines: 0, units: 0, reason, fix, to: to || '' });
      const a = attention.get(k); a.lines++; a.units += units;
    };
    const take = (sku, n) => { const s = stock.get(sku) || 0, u = Math.min(s, n); stock.set(sku, s - u); return u; };

    const entries = [];
    for (const l of lines) {
      if (!l.sku) continue;                              // a line with no SKU is a custom item, ignored
      const p = ref.prod.get(l.sku);
      if (!p) { flag('unmapped', l.raw_sku, l.units, l.unresolved || (l.via === 'alias' ? `Old SKU for ${l.sku}, which isn't in products` : 'Not in products'), ''); continue; }
      if (!p.include) { flag('excluded', l.raw_sku, l.units, 'include_in_plan is N in products', 'Set include_in_plan to Y to count it'); continue; }
      if (l.via && !l.unresolved && !(l.via === 'prefix' && p.type === 'Mini')) flag('assumed', l.raw_sku, l.units, l.via === 'alias' ? `Counted as ${l.sku} (alias)` : l.via === 'sample' ? `Sample, counted as ${l.sku}` : `Assumed to be ${l.sku}`, l.via === 'prefix' ? 'Add an alias to confirm it' : '', l.sku);
      if (types && !types.has(p.type)) continue;
      entries.push({ l, p });
    }
    entries.sort((a, b) => a.l.window - b.l.window || a.l.order_date.localeCompare(b.l.order_date) || String(a.l.ref).localeCompare(String(b.l.ref)));

    const kits = new Map(), tubesIn = [], direct = [], legacyRows = new Map();
    const lstock = new Map([...invB].filter(([, v]) => v.legacy).map(([k, v]) => [k, v.legacy]));
    const noContents = { units: 0, cubes: 0, win: new Array(LATER + 1).fill(0), skus: new Map() };
    let maxWindow = 0, builtCubes = 0, lineSeq = 0;
    const poU = { po: 0, ss: 0 }, orderSet = new Set();

    for (const { l, p } of entries) {
      /* An order placed under a bare Mini SKU (SM009) is for the legacy tube. It uses legacy stock only, has no label code, and is never part of kits. */
      if (p.type === 'Mini' && l.via === 'prefix') {
        const row = legacyRows.get(p.sku) || { sku: p.sku, raw: l.raw_sku, name: p.flavor_name || p.name, ordered: 0, covered: 0, short: 0, stock: (invB.get(p.sku) || {}).legacy || 0 };
        const have = lstock.get(p.sku) || 0, use = Math.min(have, l.units); lstock.set(p.sku, have - use);
        row.ordered += l.units; row.covered += use; row.short += l.units - use; legacyRows.set(p.sku, row); continue;
      }
      orderSet.add(l.source + ':' + l.ref); maxWindow = Math.max(maxWindow, l.window);
      if (l.source === 'PO') poU.po += l.units; else poU.ss += l.units;
      const lineId = ++lineSeq;
      if (p.type === 'Mini') { tubesIn.push({ sku: p.sku, label: p.label_code, flavor_code: p.recipe_code || p.flavor_code, variant: (labelParts(p.label_code) || {}).suf || p.category, rimmer: false,
                                              n: l.units, window: l.window, date: l.order_date, ref: l.ref, source: 'direct', cpt: p.cubes_per_unit ?? 6, lineId }); continue; }
      const used = take(p.sku, l.units), net = l.units - used;
      builtCubes += used * (p.type === 'Kit' ? ((ref.comps.get(p.sku) || []).reduce((a, c) => a + (c.rimmer ? 0 : 6) * c.qty, 0) || p.cubes_per_unit || 0) : (p.cubes_per_unit || 0));
      if (p.type === 'Kit') {
        if (!kits.has(p.sku)) {
          const list = ref.comps.get(p.sku) || [];
          const cubesPer = list.reduce((s, c) => s + (c.rimmer ? 0 : 6) * c.qty, 0);
          const status = !list.length ? 'No contents on file' : p.cubes_per_unit != null && cubesPer < p.cubes_per_unit ? 'Contents may be incomplete' : 'Counted';
          kits.set(p.sku, { sku: p.sku, name: p.name, dup: ref.dupComps.some(d => d.parent === p.sku), ordered: 0, po: 0, built_used: 0, to_build: 0, status, comps: list, cubes_per_kit: cubesPer, cpu: p.cubes_per_unit, win: new Array(LATER + 1).fill(0) });
        }
        const k = kits.get(p.sku); k.ordered += l.units; k.built_used += used; k.to_build += net; k.win[l.window] += net; if (l.source === 'PO') k.po += l.units;
        if (!k.comps.length) {
          const c = net * (p.cubes_per_unit || 0);
          noContents.units += net; noContents.cubes += c; noContents.win[l.window] += c;
          if (!noContents.skus.has(p.sku)) noContents.skus.set(p.sku, { sku: p.sku, type: 'Kit', ordered: 0, built: 0, net: 0, cubes: 0 });
          const d = noContents.skus.get(p.sku); d.ordered += l.units; d.built += used; d.net += net; d.cubes += c;
          if (net > 0 || used > 0) flag('contents', p.sku, l.units, 'Kit has no contents in product_components', 'Add its Mini tubes to components');
        } else if (k.status === 'Contents may be incomplete') flag('short', p.sku, l.units, `Contents hold ${k.cubes_per_kit} cubes, product says ${p.cubes_per_unit}`, 'Add a missing tube, or fix cubes_per_unit if it is wrong');
        for (const c of k.comps) if (net > 0) tubesIn.push({ sku: c.mini_sku, label: c.label_code, flavor_code: c.flavor_code, variant: c.variant, rimmer: c.rimmer,
                                                           n: net * c.qty, window: l.window, date: l.order_date, ref: l.ref, source: 'kit', kit: p.sku, cpt: c.rimmer ? 0 : 6,
                                                           lineId, kitUnits: l.units, kitBuilt: used, kitNet: net });
      } else {
        direct.push({ p, l, used, net });
      }
    }

    /* Mini tubes: direct Mini orders and kit tubes share one pool per Mini SKU; built minis cover the oldest demand first. */
    tubesIn.sort((a, b) => a.window - b.window || a.date.localeCompare(b.date) || String(a.ref).localeCompare(String(b.ref)));
    const prep = new Map();
    for (const t of tubesIn) {
      const used = take(t.sku, t.n); t.used = used; t.net = t.n - used; builtCubes += used * t.cpt;
      if (!prep.has(t.sku)) { const mp = ref.prod.get(t.sku); prep.set(t.sku, { sku: t.sku, label: t.label, name: mp ? mp.name : '', flavor_code: t.flavor_code, variant: t.variant, cap_color: labelType(t.variant).cap,
                                                                      rimmer: t.rimmer, direct: 0, in_kits: 0, gross: 0, built_used: 0, net: 0, known: !!mp }); }
      const r = prep.get(t.sku); r[t.source === 'direct' ? 'direct' : 'in_kits'] += t.n; r.gross += t.n; r.built_used += used; r.net += t.net;
    }

    /* Flavor rows: cubes by recipe and product type, by window */
    const fl = new Map();
    const row = key => {
      if (!fl.has(key)) fl.set(key, { flavor_code: key, name: flavorName(ref, key), codes: new Set(), types: Object.fromEntries(TYPES.map(t => [t, 0])), total: 0, win: new Array(LATER + 1).fill(0), lines: new Map() });
      return fl.get(key);
    };
    /* d: the SKU as it was ordered (a kit is listed as the kit, with kit units; a Mini as the Mini) */
    const addCubes = (code, type, cubes, window, d) => {
      const r = row(ref.recipeOf(code)); r.codes.add(code);
      r.types[type] += cubes; r.total += cubes; r.win[window] += cubes;
      if (!r.lines.has(d.sku)) r.lines.set(d.sku, { sku: d.sku, type, ordered: 0, built: 0, net: 0, cubes: 0, seen: new Set() });
      const x = r.lines.get(d.sku);
      if (d.id == null || !x.seen.has(d.id)) { x.ordered += d.ordered; x.built += d.built; x.net += d.net; if (d.id != null) x.seen.add(d.id); }
      x.cubes += cubes;
    };
    for (const { p, l, used, net } of direct) {
      const code = p.recipe_code || p.flavor_code;
      if (!code) { flag('unmapped', p.sku, l.units, 'Product has no flavor code', 'Add a flavor_code in products'); continue; }
      if (p.cubes_per_unit == null) { flag('unmapped', p.sku, l.units, 'Product has no cubes_per_unit', 'Add cubes_per_unit in products'); continue; }
      addCubes(code, p.type, net * p.cubes_per_unit, l.window, { sku: p.sku, ordered: l.units, built: used, net });
    }
    for (const t of tubesIn) {
      if (!t.flavor_code) { flag('unmapped', t.sku, t.n, 'Label code has no flavor number', 'Use a label like LM001-GC'); continue; }
      if (t.source === 'direct') addCubes(t.flavor_code, 'Mini', t.net * t.cpt, t.window, { sku: t.sku, ordered: t.n, built: t.used, net: t.net });
      else addCubes(t.flavor_code, 'Kit', t.net * t.cpt, t.window, { sku: t.kit, ordered: t.kitUnits, built: t.kitBuilt, net: t.kitNet, id: t.lineId });
    }
    const flavors = [...fl.values()].map(r => {
      const inv = invC.get(r.flavor_code), onHand = inv ? inv.n : null;
      const lines = [...r.lines.values()].map(({ seen, ...x }) => x).sort((a, b) => b.cubes - a.cubes);
      const batches = Math.ceil(r.total / size);                            // whole batches needed, rounded up
      const lb = allocate(lines.map(l => l.cubes), batches);
      lines.forEach((l, i) => { l.b = lb[i]; });
      return { ...r, covers: [...r.codes].filter(c => c !== r.flavor_code).sort(), codes: undefined, lines,
               batches, win_b: allocate(r.win, batches), on_hand: onHand, on_hand_b: onHand === null ? null : Math.floor(onHand / size), counted: onHand !== null,
               to_make: Math.max(0, r.total - (onHand ?? 0)) };
    }).sort((a, b) => b.to_make - a.to_make || b.total - a.total || a.flavor_code.localeCompare(b.flavor_code));

    /* Kit rows with the Mini SKUs they hold */
    const kitRows = [...kits.values()].map(k => ({
      ...k, built_on_hand: (invB.get(k.sku) || {}).n ?? null,
      minis: k.comps.map(c => ({ sku: c.mini_sku, label: c.label_code, flavor_code: c.flavor_code, name: flavorName(ref, ref.recipeOf(c.flavor_code)) || flavorName(ref, c.flavor_code),
                                 variant: c.variant, rimmer: c.rimmer, per_kit: c.qty, built: (invB.get(c.mini_sku) || {}).n ?? null, legacy: (invB.get(c.mini_sku) || {}).legacy || 0, known: !!ref.prod.get(c.mini_sku) }))
    })).sort((a, b) => b.to_build - a.to_build || a.sku.localeCompare(b.sku));

    /* Tubes kits need, by Mini SKU, grouped by recipe so batches count every cube of a flavor together */
    const kv = new Map();
    for (const t of tubesIn) if (t.source === 'kit' && t.flavor_code) {
      if (!kv.has(t.sku)) kv.set(t.sku, { sku: t.sku, label: t.label, flavor_code: t.flavor_code, variant: t.variant, rimmer: t.rimmer, tubes: 0, cubes: 0 });
      const r = kv.get(t.sku); r.tubes += t.net; r.cubes += t.net * t.cpt;
    }
    const kf = new Map();
    for (const r of kv.values()) {
      if (r.tubes <= 0) continue;
      const key = ref.recipeOf(r.flavor_code);
      if (!kf.has(key)) kf.set(key, { flavor_code: key, name: flavorName(ref, key), tubes: 0, cubes: 0, skus: [] });
      const f = kf.get(key); f.tubes += r.tubes; f.cubes += r.cubes; f.skus.push(r);
    }
    const kitFlavors = [...kf.values()].map(f => ({ ...f, batches: Math.ceil(f.cubes / size), skus: f.skus.sort((a, b) => b.tubes - a.tubes || a.sku.localeCompare(b.sku)) }))
      .sort((a, b) => b.tubes - a.tubes || a.flavor_code.localeCompare(b.flavor_code));

    const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
    const approx = noContents.cubes ? (() => {
      const a = { cubes: noContents.cubes, units: noContents.units, win: noContents.win, lines: [...noContents.skus.values()].sort((x, y) => y.cubes - x.cubes) };
      a.batches = Math.ceil(a.cubes / size); a.win_b = allocate(a.win, a.batches);
      const lb = allocate(a.lines.map(l => l.cubes), a.batches); a.lines.forEach((l, i) => { l.b = lb[i]; });
      return a;
    })() : null;
    const cubesNeeded = sum(flavors, r => r.total) + (approx ? approx.cubes : 0);
    const toMake = sum(flavors, r => r.to_make) + (approx ? approx.cubes : 0);
    const prepRows = [...prep.values()].sort((a, b) => b.net - a.net || a.sku.localeCompare(b.sku));
    return {
      flavors, approx, kits: kitRows, kitFlavors, prep: prepRows, batch: size,
      legacy: (() => { const rowsL = [...legacyRows.values()].sort((a, b) => b.short - a.short || b.ordered - a.ordered || a.sku.localeCompare(b.sku));
                       return { rows: rowsL, ordered: rowsL.reduce((x, r) => x + r.ordered, 0), short: rowsL.reduce((x, r) => x + r.short, 0) }; })(),
      attention: [...attention.values()].sort((a, b) => b.units - a.units),
      windows: Math.min(LATER, maxWindow) + 1,
      totals: {
        cubesNeeded, toMake, builtCubes, onHand: sum(flavors, r => Math.min(r.on_hand ?? 0, r.total)),
        batchesToMake: sum(flavors, r => Math.ceil(r.to_make / size)) + (approx ? Math.ceil(approx.cubes / size) : 0),
        kitsOrdered: sum(kitRows, k => k.ordered), kitsToBuild: sum(kitRows, k => k.to_build), kitsBuilt: sum(kitRows, k => k.built_used),
        kitsBlocked: kitRows.filter(k => k.status === 'No contents on file').length,
        tubes: sum(prepRows.filter(r => !r.rimmer), r => r.net), rimmers: sum(prepRows.filter(r => r.rimmer), r => r.net),
        orders: orderSet.size, lines: entries.length, poUnits: poU.po, ssUnits: poU.ss,
        flavorsNotCounted: flavors.filter(r => !r.counted).length
      }
    };
  }

  /* What the cubes on hand could make, per product type, for one recipe (ignores tubes, labels and packaging) */
  function canMake(ref, key, cubes) {
    const out = [];
    for (const t of ['Mini', 'Stick', 'Tallboy', 'Bulk Bag']) {
      const p = [...ref.prod.values()].find(x => x.type === t && x.recipe === key && x.cubes_per_unit);
      if (p) out.push({ type: t, sku: p.sku, units: Math.floor((cubes || 0) / p.cubes_per_unit) });
    }
    return out;
  }
  /* Every flavor code the project knows about (including ones merged into another recipe), with its name */
  function flavorCodes(ref) {
    const s = new Set(ref.names.keys());
    for (const p of ref.prod.values()) { if (p.flavor_code) s.add(p.flavor_code); if (p.recipe_code) s.add(p.recipe_code); }
    for (const l of ref.comps.values()) for (const c of l) if (c.flavor_code) s.add(c.flavor_code);
    for (const [k, v] of ref.same) { s.add(k); s.add(v); }
    return [...s].sort().map(code => ({ flavor_code: code, name: flavorName(ref, code), same_as: ref.same.get(code) || '' }));
  }
  /* One entry per recipe: the code batches are counted under, plus any codes that share it */
  function recipeKeys(ref) {
    const m = new Map();
    for (const f of flavorCodes(ref)) {
      const k = ref.recipeOf(f.flavor_code);
      if (!m.has(k)) m.set(k, { flavor_code: k, name: flavorName(ref, k), covers: [] });
      if (f.flavor_code !== k) m.get(k).covers.push(f.flavor_code);
    }
    return [...m.values()].sort((a, b) => a.flavor_code.localeCompare(b.flavor_code));
  }
  /* Loose cube counts are kept per recipe, so a count entered under 033 lands on 034 */
  function mapCubes(ref, rows) {
    const out = new Map();
    for (const r of rows || []) {
      if (r.cubes_on_hand === '' || r.cubes_on_hand == null) continue;
      const k = ref.recipeOf(r.flavor_code), e = out.get(k) || { flavor_code: k, cubes_on_hand: 0, counted_at: r.counted_at || '', notes: r.notes || '' };
      e.cubes_on_hand += +r.cubes_on_hand; out.set(k, e);
    }
    return [...out.values()];
  }

  const api = { TYPES, LATER, DEFAULT_RULES, LABEL_TYPES, labelType, withDefaults, FILES, parseCSV, toCSV, normDate, weekStart, windowFor, windowLabel, allocate, labelParts, miniSkuFor,
                readOrders, readPO, readList, readCounts, mapBuilt, withLegacy, mapCubes, inventoryNow, build, flavorName, resolveSku, demand, plan, canMake, flavorCodes, recipeKeys };
  if (typeof module !== 'undefined') module.exports = api; else root.Core = api;
})(this);
