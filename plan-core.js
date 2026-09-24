/* Planning calculation: open orders -> Mini tubes, labels and cubes per LM code.
   No DOM access, so it can be tested outside the browser. */
(function (root) {
  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
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
    const h = out.shift().map(s => s.trim());
    return out.map(r => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? '').trim()])));
  }

  function weekStart(iso) {                       // Monday of the order's week
    const d = new Date(iso + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10);
  }

  function build({ products, components, minis }) {
    const prod = new Map(products.map(p => [p.sku, p]));
    const cases = new Map();
    products.forEach(p => { if (p.case_sku) cases.set(p.case_sku, { kit: p.sku, qty: +p.case_qty || 6 }); });
    const comps = new Map();
    components.forEach(c => { if (!comps.has(c.parent_sku)) comps.set(c.parent_sku, []); comps.get(c.parent_sku).push(c); });
    const mini = new Map(minis.map(m => [m.lm_code, m]));
    return { prod, cases, comps, mini };
  }

  /* opts: { statuses:Set, maxAgeDays:number|null, today:'YYYY-MM-DD', group:'total'|'week'|'day' } */
  function plan(ref, lines, opts) {
    const { prod, cases, comps, mini } = ref;
    const today = new Date((opts.today) + 'T00:00:00Z');
    const periods = new Map();        // key -> Map(lm -> {tubes, fromKits, fromSingles})
    const kitUse = new Map();         // kit sku -> {kits, status}
    const unmapped = new Map();       // sku -> {lines, units, reason}
    const orders = new Set();
    let linesUsed = 0;

    const add = (key, lm, n, via) => {
      if (!periods.has(key)) periods.set(key, new Map());
      const m = periods.get(key);
      if (!m.has(lm)) m.set(lm, { tubes: 0, fromKits: 0, fromSingles: 0 });
      const e = m.get(lm); e.tubes += n; e[via] += n;
    };
    const miss = (sku, units, reason) => {
      const k = sku || '(no SKU)';
      if (!unmapped.has(k)) unmapped.set(k, { lines: 0, units: 0, reason });
      const u = unmapped.get(k); u.lines++; u.units += units;
    };

    for (const l of lines) {
      if (!opts.statuses.has(l.status)) continue;
      if (opts.maxAgeDays != null) {
        const age = (today - new Date(l.order_date + 'T00:00:00Z')) / 864e5;
        if (age > opts.maxAgeDays) continue;
      }
      if (!(l.qty > 0)) continue;
      linesUsed++; orders.add(l.order_number);
      const key = opts.group === 'day' ? l.order_date : opts.group === 'week' ? weekStart(l.order_date) : 'total';
      let sku = l.sku, units = l.qty;
      if (!sku) { miss('', units, 'Order line has no SKU in ShipStation'); continue; }
      if (cases.has(sku)) { const c = cases.get(sku); units = l.qty * c.qty; sku = c.kit; }
      const p = prod.get(sku);
      if (!p) { miss(l.sku, l.qty, 'Not in products.csv'); continue; }
      if (p.product_type === 'Kit') {
        const list = comps.get(sku) || [];
        const status = list.length === 0 ? 'No contents on file' : list.length < 3 ? 'Missing a tube' : 'Counted';
        if (!kitUse.has(sku)) kitUse.set(sku, { name: p.product_name, kits: 0, status, tubes: list.length });
        kitUse.get(sku).kits += units;
        list.forEach(c => add(key, c.label_code, units * (+c.qty || 1), 'fromKits'));
      } else if (p.label_code) {
        add(key, p.label_code, units, 'fromSingles');
      } else {
        miss(l.sku, l.qty, 'Product has no label code');
      }
    }

    const rowsFor = m => [...m].map(([lm, e]) => {
      const info = mini.get(lm) || {};
      const cpt = info.cubes_per_tube != null && info.cubes_per_tube !== '' ? +info.cubes_per_tube : (lm.endsWith('-GR') ? 0 : 6);
      return {
        lm_code: lm, name: info.name || '(not in minis.csv)', category: info.category || lm.split('-')[1] || '',
        category_name: info.category_name || '', cap_color: info.cap_color || '',
        rimmer: lm.endsWith('-GR'), tubes: e.tubes, labels: e.tubes, cubes: e.tubes * cpt,
        from_kits: e.fromKits, from_singles: e.fromSingles
      };
    }).sort((a, b) => b.tubes - a.tubes || a.lm_code.localeCompare(b.lm_code));

    const groups = [...periods].sort((a, b) => a[0].localeCompare(b[0])).map(([key, m]) => ({ key, rows: rowsFor(m) }));
    const all = new Map();
    periods.forEach(m => m.forEach((e, lm) => {
      if (!all.has(lm)) all.set(lm, { tubes: 0, fromKits: 0, fromSingles: 0 });
      const a = all.get(lm); a.tubes += e.tubes; a.fromKits += e.fromKits; a.fromSingles += e.fromSingles;
    }));
    const totalRows = rowsFor(all);
    const sum = f => totalRows.reduce((s, r) => s + f(r), 0);
    const kits = [...kitUse].map(([sku, k]) => ({ sku, ...k })).sort((a, b) => b.kits - a.kits);
    return {
      groups, totalRows, kits,
      unmapped: [...unmapped].map(([sku, u]) => ({ sku, ...u })).sort((a, b) => b.units - a.units),
      totals: {
        miniTubes: sum(r => r.rimmer ? 0 : r.tubes), rimmerTubes: sum(r => r.rimmer ? r.tubes : 0),
        labels: sum(r => r.labels), cubes: sum(r => r.cubes),
        kitsOrdered: kits.reduce((s, k) => s + k.kits, 0),
        kitsCounted: kits.filter(k => k.status === 'Counted').reduce((s, k) => s + k.kits, 0),
        orders: orders.size, lines: linesUsed,
        unmappedUnits: [...unmapped.values()].reduce((s, u) => s + u.units, 0)
      }
    };
  }

  const api = { parseCSV, build, plan, weekStart };
  if (typeof module !== 'undefined') module.exports = api; else root.PlanCore = api;
})(this);
