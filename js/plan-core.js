/* Planning calculation: open orders + PO lines -> Mini tubes per LM code, by production window,
   compared with on-hand inventory. No DOM access, so it can be tested outside the browser. */
(function (root) {
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

  /* ---------- Dates and windows ---------- */
  function normDate(v) {                           // YYYY-MM-DD, M/D/YYYY, M/D/YY, or ISO datetime -> YYYY-MM-DD
    const s = String(v || '').trim(); let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/))) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
    return null;
  }
  function iso(y, mo, d) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  }
  const day = s => new Date(s + 'T00:00:00Z');
  const addDays = (s, n) => { const d = day(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function weekStart(s) { const d = day(s); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); }
  const weeksBetween = (a, b) => Math.round((day(weekStart(b)) - day(weekStart(a))) / (7 * 864e5));

  /* ShipStation orders have no due date, so their order age decides the window
     (the rule from the planning sheets). Window 0 is this week, including anything past due. */
  const AGE_RULES = [{ minAge: 60, window: 0 }, { minAge: 30, window: 1 }, { minAge: 14, window: 2 }, { minAge: 0, window: 3 }];

  function windowFor(line, today) {
    if (line.source === 'ShipStation') {
      const age = (day(today) - day(line.order_date)) / 864e5;
      return (AGE_RULES.find(r => age >= r.minAge) || AGE_RULES[AGE_RULES.length - 1]).window;
    }
    // PO lines: make it the week(s) before the week the commitment date falls in
    return Math.max(0, weeksBetween(today, line.commit_date) - line.lead_weeks);
  }

  function windowLabel(i, today) {
    const start = addDays(weekStart(today), 7 * i), end = addDays(start, 6);
    const f = (s, o) => day(s).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
    const sameMonth = start.slice(5, 7) === end.slice(5, 7);
    const range = `${f(start, { month: 'short', day: 'numeric' })}–${sameMonth ? f(end, { day: 'numeric' }) : f(end, { month: 'short', day: 'numeric' })}`;
    return i === 0 ? `Now: ${range}` : range;
  }

  /* ---------- Uploaded file checks ---------- */
  const ORDER_ALIASES = {
    order_number: ['order_number', 'order number', 'order - number', 'order #', 'ordernumber'],
    order_date: ['order_date', 'order date', 'date - order date', 'orderdate'],
    status: ['status', 'order status', 'order - status', 'orderstatus'],
    sku: ['sku', 'item sku', 'item - sku', 'item_sku'],
    qty: ['qty', 'quantity', 'item - qty', 'item qty', 'item_qty']
  };
  const FILES = {
    orders: { headers: ['order_number', 'order_date', 'status', 'sku', 'qty'], required: ['order_number', 'order_date', 'sku', 'qty'] },
    po: { headers: ['source', 'po_number', 'customer', 'sku', 'units', 'commit_date', 'commit_type', 'lead_weeks', 'status', 'replaces_shipstation', 'notes'],
          required: ['po_number', 'sku', 'units', 'commit_date'] },
    inventory: { headers: ['lm_code', 'on_hand', 'counted_at', 'notes'], required: ['lm_code', 'on_hand'] }
  };

  function headerCheck(kind, rows, text) {
    const first = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    const missing = FILES[kind].required.filter(h => !first.includes(h));
    return missing.length ? `Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. The first row must be: ${FILES[kind].headers.join(',')}` : null;
  }

  function normStatus(s) {
    const k = String(s || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return k === '' ? 'awaiting_shipment' : k;
  }

  /* Orders: keeps only order number, date, status, SKU and qty. Any other column (names, addresses) is dropped. */
  function readOrders(text) {
    const raw = parseCSV(text); if (!raw.length) return { error: 'That file has no data rows.' };
    const keys = Object.keys(raw[0]); const pick = {};
    for (const [field, names] of Object.entries(ORDER_ALIASES)) pick[field] = keys.find(k => names.includes(k.toLowerCase()));
    const missing = FILES.orders.required.filter(f => !pick[f]);
    if (missing.length) return { error: `Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. The first row must be: ${FILES.orders.headers.join(',')}` };
    const lines = [], problems = [];
    raw.forEach((r, i) => {
      const d = normDate(r[pick.order_date]), q = Number(r[pick.qty]);
      if (!d) problems.push(`Row ${i + 2}: order date "${r[pick.order_date]}" isn't a date`);
      else if (!Number.isFinite(q)) problems.push(`Row ${i + 2}: qty "${r[pick.qty]}" isn't a number`);
      else lines.push({ order_number: r[pick.order_number], order_date: d, status: pick.status ? normStatus(r[pick.status]) : 'awaiting_shipment',
                        sku: r[pick.sku], qty: Math.round(q) });
    });
    return finish(lines, problems);
  }

  function readPO(text) {
    const raw = parseCSV(text); if (!raw.length) return { error: 'That file has no data rows.' };
    const h = headerCheck('po', raw, text); if (h) return { error: h };
    const rows = [], problems = [];
    raw.forEach((r, i) => {
      const d = normDate(r.commit_date), u = Number(r.units), lead = r.lead_weeks === '' || r.lead_weeks == null ? 1 : Number(r.lead_weeks);
      if (!r.sku) problems.push(`Row ${i + 2}: no SKU`);
      else if (!d) problems.push(`Row ${i + 2}: commit date "${r.commit_date}" isn't a date`);
      else if (!Number.isFinite(u)) problems.push(`Row ${i + 2}: units "${r.units}" isn't a number`);
      else if (!Number.isFinite(lead) || lead < 0) problems.push(`Row ${i + 2}: lead weeks "${r.lead_weeks}" must be 0 or more`);
      else rows.push({ ...Object.fromEntries(FILES.po.headers.map(k => [k, r[k] ?? ''])), units: Math.round(u), commit_date: d,
                       lead_weeks: lead, status: (r.status || 'open').toLowerCase() });
    });
    return finish(rows, problems);
  }

  function readInventory(text) {
    const raw = parseCSV(text); if (!raw.length) return { error: 'That file has no data rows.' };
    const h = headerCheck('inventory', raw, text); if (h) return { error: h };
    const rows = [], problems = [], seen = new Set();
    raw.forEach((r, i) => {
      const code = r.lm_code.toUpperCase(), oh = r.on_hand === '' ? null : Number(r.on_hand);
      if (!code) problems.push(`Row ${i + 2}: no LM code`);
      else if (seen.has(code)) problems.push(`Row ${i + 2}: ${code} is listed twice`);
      else if (oh !== null && (!Number.isFinite(oh) || oh < 0)) problems.push(`Row ${i + 2}: on hand "${r.on_hand}" must be a number, 0 or more, or blank`);
      else { seen.add(code); rows.push({ lm_code: code, on_hand: oh === null ? null : Math.round(oh), counted_at: normDate(r.counted_at) || '', notes: r.notes || '' }); }
    });
    return finish(rows, problems);
  }

  function finish(rows, problems) {
    if (problems.length) return { error: `${problems.length} row${problems.length > 1 ? 's' : ''} couldn't be read. ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '; …' : ''}` };
    if (!rows.length) return { error: 'That file has no data rows.' };
    return { rows };
  }

  /* ---------- Inventory: base counts plus a log of edits ---------- */
  /* log entries: { type:'set'|'adjust', lm_code, qty, note, at } applied in order */
  function inventoryNow(base, log) {
    const inv = new Map(base.map(r => [r.lm_code, { on_hand: r.on_hand, counted_at: r.counted_at, notes: r.notes, edits: 0 }]));
    for (const e of log || []) {
      if (!inv.has(e.lm_code)) inv.set(e.lm_code, { on_hand: null, counted_at: '', notes: '', edits: 0 });
      const x = inv.get(e.lm_code);
      if (e.type === 'set') { x.on_hand = e.qty; x.counted_at = e.at.slice(0, 10); }
      else x.on_hand = Math.max(0, (x.on_hand ?? 0) + e.qty);
      x.edits++;
    }
    return inv;
  }

  /* ---------- Reference data ---------- */
  function build({ products, components, minis, aliases }) {
    const prod = new Map(products.map(p => [p.sku, p]));
    const cases = new Map();
    products.forEach(p => { if (p.case_sku) cases.set(p.case_sku, { kit: p.sku, qty: +p.case_qty || 6 }); });
    const comps = new Map();
    components.forEach(c => { if (!comps.has(c.parent_sku)) comps.set(c.parent_sku, []); comps.get(c.parent_sku).push(c); });
    const mini = new Map(minis.map(m => [m.lm_code, m]));
    const alias = new Map();                        // old SKU -> current SKU (upper-case keys)
    (aliases || []).forEach(a => { if (a.old_sku && a.new_sku) alias.set(a.old_sku.trim().toUpperCase(), a.new_sku.trim()); });
    return { prod, cases, comps, mini, alias };
  }

  /* Current SKU for an order SKU:
     1. a SKU in products.csv (or a case SKU) is used as is
     2. an old SKU listed in sku_aliases.csv becomes its new SKU
     3. a sample (ends in -S) is the same product as the SKU without -S. If that isn't a SKU itself,
        it matches the one product whose SKU starts with it (SM006-S -> SM006-BL). */
  function resolveSku(ref, sku) {
    const known = s => ref.prod.has(s) || ref.cases.has(s);
    if (!sku || known(sku)) return { sku, via: null };
    const a = ref.alias.get(sku.toUpperCase());
    if (a) return { sku: a, via: 'alias' };
    const m = sku.match(/^(.+)-S$/i);
    if (m) {
      const base = m[1];
      if (known(base)) return { sku: base, via: 'sample' };
      const hits = [...ref.prod.keys()].filter(k => k.toUpperCase().startsWith(base.toUpperCase() + '-') && !/-S$/i.test(k));
      if (hits.length === 1) return { sku: hits[0], via: 'sample' };
      return { sku, via: 'sample', unresolved: hits.length ? `Sample matches ${hits.length} products (${hits.join(', ')})` : `Sample of ${base}, which isn't in products.csv` };
    }
    return { sku, via: null };
  }

  /* ---------- Demand: ShipStation lines + PO lines, one list ---------- */
  /* opts: { statuses:Set, maxAgeDays, includePO:boolean, today } */
  function demand(ref, orders, poLines, opts) {
    const out = [], replaced = { lines: 0, units: 0 }, renamed = { lines: 0, units: 0 };
    const pos = opts.includePO ? poLines.filter(p => p.status === 'open') : [];
    const resolve = (raw, source) => {                  // old/sample SKU -> current SKU, then case SKU -> kit. PO units are already finished units.
      const r = resolveSku(ref, raw);
      const c = ref.cases.get(r.sku);
      const base = { via: r.via, unresolved: r.unresolved };
      if (!c) return { ...base, sku: r.sku, mult: 1 };
      return { ...base, sku: c.kit, mult: source === 'ShipStation' ? c.qty : 1 };
    };
    const note = (d, r) => { d.via = r.via; d.unresolved = r.unresolved; if (r.via && !r.unresolved) { renamed.lines++; renamed.units += d.units; } };
    const rules = pos.filter(p => p.replaces_shipstation).map(p => ({ prefix: p.replaces_shipstation, sku: resolve(p.sku, 'PO').sku }));

    for (const l of orders) {
      if (!opts.statuses.has(l.status) || !(l.qty > 0)) continue;
      const age = (day(opts.today) - day(l.order_date)) / 864e5;
      if (opts.maxAgeDays != null && age > opts.maxAgeDays) continue;
      const r = resolve(l.sku, 'ShipStation');
      if (rules.some(x => l.order_number.startsWith(x.prefix) && x.sku === r.sku)) { replaced.lines++; replaced.units += l.qty * r.mult; continue; }
      const d = { source: 'ShipStation', ref: l.order_number, order_date: l.order_date, raw_sku: l.sku, sku: r.sku, units: l.qty * r.mult };
      note(d, r); d.window = windowFor(d, opts.today); out.push(d);
    }
    for (const p of pos) {
      if (!(p.units > 0)) continue;
      const r = resolve(p.sku, 'PO');
      const d = { source: 'PO', ref: p.po_number, customer: p.customer, order_date: p.commit_date, commit_date: p.commit_date,
                  lead_weeks: p.lead_weeks, raw_sku: p.sku, sku: r.sku, units: p.units };
      note(d, r); d.window = windowFor(d, opts.today); out.push(d);
    }
    return { lines: out, replaced, renamed };
  }

  /* ---------- Plan ---------- */
  /* opts: { group:'window'|'total'|'week'|'day', today, inventory: Map from inventoryNow() } */
  function plan(ref, lines, opts) {
    const { prod, comps, mini } = ref;
    const inv = opts.inventory || new Map();
    const periods = new Map(), byWindow = new Map();
    const kitUse = new Map(), unmapped = new Map(), orders = new Set();
    let poUnits = 0, ssUnits = 0, maxWindow = 0;

    const bump = (map, key, lm, n, via) => {
      if (!map.has(key)) map.set(key, new Map());
      const m = map.get(key);
      if (!m.has(lm)) m.set(lm, { tubes: 0, fromKits: 0, fromSingles: 0 });
      const e = m.get(lm); e.tubes += n; e[via] += n;
    };
    const miss = (sku, units, reason) => {
      const k = sku || '(no SKU)';
      if (!unmapped.has(k)) unmapped.set(k, { lines: 0, units: 0, reason });
      const u = unmapped.get(k); u.lines++; u.units += units;
    };

    for (const l of lines) {
      orders.add(l.source + ':' + l.ref);
      if (l.source === 'PO') poUnits += l.units; else ssUnits += l.units;
      maxWindow = Math.max(maxWindow, l.window);
      const key = opts.group === 'day' ? l.order_date : opts.group === 'week' ? weekStart(l.order_date) : opts.group === 'window' ? l.window : 'total';
      const add = (lm, n, via) => { bump(periods, key, lm, n, via); bump(byWindow, l.window, lm, n, via); };
      if (!l.sku) { miss('', l.units, 'Order line has no SKU in ShipStation'); continue; }
      const p = prod.get(l.sku);
      if (!p) {
        miss(l.raw_sku, l.units, l.unresolved || (l.via === 'alias' ? `Old SKU for ${l.sku}, which isn't in products.csv` : 'Not in products.csv'));
        continue;
      }
      if (p.product_type === 'Kit') {
        const list = comps.get(l.sku) || [];
        const status = list.length === 0 ? 'No contents on file' : list.length < 3 ? 'Missing a tube' : 'Counted';
        if (!kitUse.has(l.sku)) kitUse.set(l.sku, { name: p.product_name, kits: 0, po: 0, status, tubes: list.length });
        const k = kitUse.get(l.sku); k.kits += l.units; if (l.source === 'PO') k.po += l.units;
        list.forEach(c => add(c.label_code, l.units * (+c.qty || 1), 'fromKits'));
      } else if (p.label_code) {
        add(p.label_code, l.units, 'fromSingles');
      } else {
        miss(l.raw_sku, l.units, 'Product has no label code');
      }
    }

    const windows = Array.from({ length: maxWindow + 1 }, (_, i) => i);
    const needByWindow = lm => windows.map(w => byWindow.get(w)?.get(lm)?.tubes || 0);

    const rowsFor = m => [...m].map(([lm, e]) => {
      const info = mini.get(lm) || {};
      const cpt = info.cubes_per_tube != null && info.cubes_per_tube !== '' ? +info.cubes_per_tube : (lm.endsWith('-GR') ? 0 : 6);
      const stock = inv.get(lm), onHand = stock ? stock.on_hand : null;
      const need = needByWindow(lm);
      let cum = 0, coveredThrough = -1;
      for (let i = 0; i < need.length; i++) { cum += need[i]; if (cum <= (onHand ?? 0)) coveredThrough = i; else break; }
      const firstWindow = need.findIndex(v => v > 0);
      return {
        lm_code: lm, name: info.name || '(not in minis.csv)', category: info.category || lm.split('-')[1] || '',
        category_name: info.category_name || '', cap_color: info.cap_color || '',
        rimmer: lm.endsWith('-GR'), tubes: e.tubes, labels: e.tubes, cubes: e.tubes * cpt,
        from_kits: e.fromKits, from_singles: e.fromSingles,
        need, first_window: firstWindow, on_hand: onHand, counted: onHand !== null,
        short: Math.max(0, e.tubes - (onHand ?? 0)),
        covered_through: coveredThrough            // -1 = not even this week, need.length-1 = everything
      };
    });
    const byPriority = (a, b) => a.first_window - b.first_window || (b.need[b.first_window] || 0) - (a.need[a.first_window] || 0) || a.lm_code.localeCompare(b.lm_code);
    const byTubes = (a, b) => b.tubes - a.tubes || a.lm_code.localeCompare(b.lm_code);

    const all = new Map();
    periods.forEach(m => m.forEach((e, lm) => {
      if (!all.has(lm)) all.set(lm, { tubes: 0, fromKits: 0, fromSingles: 0 });
      const a = all.get(lm); a.tubes += e.tubes; a.fromKits += e.fromKits; a.fromSingles += e.fromSingles;
    }));
    const totalRows = rowsFor(all).sort(opts.group === 'window' ? byPriority : byTubes);
    const groups = [...periods].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
      .map(([key, m]) => ({ key, rows: rowsFor(m).sort(byTubes) }));
    const sum = f => totalRows.reduce((s, r) => s + f(r), 0);
    const kits = [...kitUse].map(([sku, k]) => ({ sku, ...k })).sort((a, b) => b.kits - a.kits);
    return {
      groups, totalRows, kits, windows,
      unmapped: [...unmapped].map(([sku, u]) => ({ sku, ...u })).sort((a, b) => b.units - a.units),
      totals: {
        miniTubes: sum(r => r.rimmer ? 0 : r.tubes), rimmerTubes: sum(r => r.rimmer ? r.tubes : 0),
        labels: sum(r => r.labels), cubes: sum(r => r.cubes), short: sum(r => r.short),
        shortNow: sum(r => Math.max(0, (r.need[0] || 0) - (r.on_hand ?? 0))),
        notCounted: totalRows.filter(r => !r.counted).length,
        kitsOrdered: kits.reduce((s, k) => s + k.kits, 0),
        kitsCounted: kits.filter(k => k.status === 'Counted').reduce((s, k) => s + k.kits, 0),
        orders: orders.size, lines: lines.length, poUnits, ssUnits,
        unmappedUnits: [...unmapped.values()].reduce((s, u) => s + u.units, 0)
      }
    };
  }

  const api = { resolveSku, parseCSV, toCSV, normDate, weekStart, windowFor, windowLabel, AGE_RULES, FILES,
                readOrders, readPO, readInventory, inventoryNow, build, demand, plan };
  if (typeof module !== 'undefined') module.exports = api; else root.PlanCore = api;
})(this);
