/* Cube planning UI. All calculation lives in core.js; this file loads data, keeps browser-only edits, and draws the four pages. */
(function () {
  'use strict';
  const C = window.Core;
  const $ = id => document.getElementById(id);
  const REPO = 'carina-teaspressa/inventory_planning';
  const FALLBACK = `https://raw.githubusercontent.com/${REPO}/main/`;
  const PULL_URL = `https://github.com/${REPO}/actions/workflows/pullshipstation.yml`;
  const TYPES = C.TYPES;
  const LBL = { Mini: 'Mini', Stick: 'Stick', Tallboy: 'Tallboy', 'Bulk Bag': 'Bulk bag', Kit: 'Kits' };
  const TVAR = { Mini: '--t-mini', Stick: '--t-stick', Tallboy: '--t-tallboy', 'Bulk Bag': '--t-bulk', Kit: '--t-kit' };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n = v => Number(v || 0).toLocaleString('en-US');
  const nz = v => (v ? n(v) : '');
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
  const stamp = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  /* ---------- Where each file lives ---------- */
  const SRC = {
    orders:     { title: 'Open orders', repo: 'data/json/open_orders.json', required: true, noun: 'lines', blurb: 'ShipStation lines, pulled every morning. An upload keeps only order number, date, status, SKU and qty.' },
    po:         { title: 'PO lines', repo: 'data/csv/po_lines.csv', noun: 'lines', blurb: 'Retail POs in finished units. A replaces_shipstation value removes matching ShipStation lines.' },
    products:   { title: 'Products', repo: 'data/csv/products.csv', required: true, noun: 'products', blurb: 'Every SKU: type, flavor code, cubes per unit, case size, and include_in_plan.' },
    components: { title: 'Kit components', repo: 'data/csv/product_components.csv', required: true, noun: 'rows', blurb: 'The Mini tubes inside each kit, by label code.' },
    aliases:    { title: 'SKU aliases', repo: 'data/csv/sku-aliases.csv', noun: 'aliases', blurb: 'Old SKUs that count as a current product.' },
    flavors:    { title: 'Flavors', repo: 'data/csv/flavors.csv', noun: 'flavors', blurb: 'Flavor code to name. Fills gaps the products file leaves.' },
    built:      { title: 'Built counts', repo: 'data/csv/inventory_built.csv', noun: 'SKUs', blurb: 'Finished units on hand, by SKU.' },
    cubes:      { title: 'Cube counts', repo: 'data/csv/inventory_cubes.csv', noun: 'flavors', blurb: 'Loose cubes on hand, by flavor code.' }
  };
  const READ = { orders: C.readOrders, po: C.readPO, built: t => C.readCounts('built', t), cubes: t => C.readCounts('cubes', t) };
  ['products', 'components', 'aliases', 'flavors'].forEach(k => { READ[k] = t => C.readList(k, t); });
  const CSVNAME = { orders: 'open_orders.csv', po: 'po_lines.csv', products: 'products.csv', components: 'product_components.csv', aliases: 'sku-aliases.csv',
                    flavors: 'flavors.csv', built: 'inventory_built.csv', cubes: 'inventory_cubes.csv' };

  const S = {
    repo: {}, local: {}, log: [], rules: C.DEFAULT_RULES, ref: null, inv: null, demand: null, full: null, res: null, view: null, srcErr: {},
    ui: { mode: 'all', types: new Set(TYPES), q: '', open: new Set(), kitFilter: 'all', kitQ: '', prepAll: false, invOnly: true, invQ: '',
          prodQ: '', prodMore: 50, compQ: '', compMore: 100, flavQ: '', flavMissing: true }
  };

  /* ---------- Browser storage (may be blocked or full) ---------- */
  const store = {
    get(k) { try { const v = localStorage.getItem('cp.' + k); return v ? JSON.parse(v) : null; } catch { return null; } },
    set(k, v) { try { localStorage.setItem('cp.' + k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem('cp.' + k); } catch { } }
  };
  function saved(ok) { if (!ok) showErr("This browser didn't save the change (storage is full or blocked). It will work until you reload."); return ok; }
  function showErr(msg) { const e = $('err'); e.textContent = msg; e.hidden = !msg; }

  /* ---------- Loading ---------- */
  async function fetchText(base, file) {
    const r = await fetch(base + file, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${file} returned ${r.status}`);
    return r.text();
  }
  async function loadAll(base) {
    const keys = Object.keys(SRC);
    const texts = await Promise.all(keys.map(async k => {
      try { return await fetchText(base, SRC[k].repo); } catch (e) { if (SRC[k].required) throw e; return null; }
    }));
    let rules = null; try { rules = JSON.parse(await fetchText(base, 'data/json/rules.json')); } catch { }
    return { keys, texts, rules };
  }
  async function load() {
    let got;
    try { got = await loadAll(''); }
    catch (e) {
      try { got = await loadAll(FALLBACK); }
      catch (e2) {
        showErr(`Couldn't load the data files (${e2.message}). Open this page from GitHub Pages, or run "python3 -m http.server" in the project folder and open localhost.`);
        return false;
      }
    }
    got.keys.forEach((k, i) => {
      const t = got.texts[i];
      if (t == null) { S.repo[k] = { rows: [], missing: true }; return; }
      if (k === 'orders') {
        try { const o = JSON.parse(t); S.repo[k] = { rows: o.lines || [], at: o.pulled_at }; } catch (e) { S.repo[k] = { rows: [], error: 'open_orders.json is not valid JSON' }; }
      } else { const r = READ[k](t); S.repo[k] = { rows: r.rows || [], error: r.error, dupes: r.dupes || [] }; }
    });
    S.repo.rules = got.rules;
    Object.keys(SRC).forEach(k => { S.local[k] = store.get('src.' + k); });
    S.log = store.get('log') || [];
    const st = (store.get('rules') || got.rules || C.DEFAULT_RULES).statuses || C.DEFAULT_RULES.statuses;
    document.querySelectorAll('.st').forEach(x => { x.checked = st.includes(x.value); });
    return true;
  }
  const rows = kind => (S.local[kind] ? S.local[kind].rows : (S.repo[kind] ? S.repo[kind].rows : [])) || [];

  /* ---------- Compute ---------- */
  function planOpts() {
    return { statuses: new Set([...document.querySelectorAll('.st:checked')].map(x => x.value)), includePO: $('incPO').checked };
  }
  function recompute() {
    const t = today(), o = planOpts();
    S.rules = store.get('rules') || S.repo.rules || C.DEFAULT_RULES;
    S.ref = C.build({ products: rows('products'), components: rows('components'), aliases: rows('aliases'), flavors: rows('flavors') });
    const mb = C.mapBuilt(S.ref, rows('built'));
    S.builtNotes = mb.notes;
    S.inv = C.inventoryNow(mb.rows, rows('cubes'), S.log);
    S.demand = C.demand(S.ref, rows('orders'), rows('po'), { statuses: o.statuses, includePO: o.includePO, today: t, rules: S.rules });
    S.full = C.plan(S.ref, S.demand.lines, { today: t, inventory: S.inv });
    S.res = S.ui.types.size === TYPES.length ? S.full : C.plan(S.ref, S.demand.lines, { today: t, inventory: S.inv, types: [...S.ui.types] });
    chrome();
  }
  const problems = () => S.full.attention.filter(a => a.kind === 'unmapped' || a.kind === 'contents');
  function chrome() {
    const b = $('badge'), k = problems().length; b.hidden = !k; b.textContent = k;
    const pr = problems(); b.title = `${pr.filter(a => a.kind === 'unmapped').length} SKUs on orders aren't in products, ${pr.filter(a => a.kind === 'contents').length} kits need contents`;
    const R = S.repo.orders || {}, L = S.local.orders;
    $('fresh').innerHTML = (L ? `Using orders uploaded ${esc(stamp(L.at))} in this browser.` : R.at ? `Orders pulled ${esc(stamp(R.at))} Arizona time.` : 'No order pull yet.') +
      ` <a href="${PULL_URL}" target="_blank" rel="noopener">Run the pull</a>`;
  }

  /* ---------- Small builders ---------- */
  const flavorLabel = (code, name) => `<span class="fcode">${esc(code)}</span> ${name ? esc(name) : '<span class="muted">No name yet</span>'}`;
  const th = (t, num) => `<th${num ? ' class="num"' : ''}>${t}</th>`;
  function mix(types, total) {
    if (!total) return '<span class="mix"></span>';
    const segs = TYPES.filter(t => types[t] > 0).map(t => `<i style="width:${(types[t] / total * 100).toFixed(1)}%;background:var(${TVAR[t]})" title="${LBL[t]} ${n(types[t])}"></i>`).join('');
    const label = TYPES.filter(t => types[t] > 0).map(t => `${LBL[t]} ${Math.round(types[t] / total * 100)}%`).join(', ');
    return `<span class="mix" role="img" aria-label="${esc(label)}">${segs}</span>`;
  }
  const capClass = c => ['rust', 'green', 'cream'].includes((c || '').toLowerCase()) ? c.toLowerCase() : '';
  const empty = msg => `<p class="empty">${msg}</p>`;
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  /* ================= PLAN ================= */
  function buildChips() {
    $('typeChips').innerHTML = TYPES.map(t => `<button type="button" class="chip" data-act="type" data-type="${esc(t)}" aria-pressed="true" style="--c:var(${TVAR[t]})"><i></i>${LBL[t]}</button>`).join('');
  }
  function renderPlan() {
    const R = S.res, T = R.totals, A = S.full.attention;
    document.querySelectorAll('[data-act="mode"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === S.ui.mode)));
    document.querySelectorAll('[data-act="type"]').forEach(b => b.setAttribute('aria-pressed', String(S.ui.types.has(b.dataset.type))));
    const w = [], bad = problems();
    if (bad.length) w.push(`<p><b>${n(bad.length)} SKUs</b> on open orders aren't fully counted (${n(bad.reduce((s, a) => s + a.units, 0))} units). <a href="#data">See what to fix</a>.</p>`);
    if (R.approx) w.push(`<p><b>${n(R.approx.units)} kits</b> on order have no contents on file, so their ${n(R.approx.cubes)} cubes are estimated from cubes per kit and aren't assigned to a flavor.</p>`);
    if (T.flavorsNotCounted && T.flavorsNotCounted === R.flavors.length) w.push(`<p>No loose cube counts are entered yet, so every cube still needed shows as to make. Built units are already taken off the demand. Add cube counts on the <a href="#inventory">Inventory</a> page.</p>`);
    const bn = S.builtNotes, bd = ((S.local.built || S.repo.built || {}).dupes || []);
    if (bn && (bn.ambiguous.length || bd.length)) w.push(`<p>${n(bn.ambiguous.length)} built counts can't be matched to one product${bd.length ? ` and ${n(bd.length)} SKUs are listed twice` : ''}. <a href="#inventory">Check the counts</a>.</p>`);
    if (S.demand.replaced.lines) w.push(`<p>${n(S.demand.replaced.lines)} ShipStation lines (${n(S.demand.replaced.units)} units) are replaced by PO lines and not counted twice.</p>`);
    if (S.ui.types.size < TYPES.length) w.push(`<p>Showing ${[...S.ui.types].map(t => LBL[t].toLowerCase()).join(', ')} only. Cubes to make is figured for these alone.</p>`);
    $('notes').innerHTML = w.length ? `<div class="warn">${w.join('')}</div>` : '';
    $('tally').innerHTML = [
      ['', T.cubesNeeded, 'Cubes needed', T.builtCubes ? `After ${n(T.builtCubes)} cubes covered by built units` : `${n(T.lines)} lines, ${n(T.orders)} orders and POs`],
      ['', T.onHand, 'Cubes on hand', T.flavorsNotCounted === R.flavors.length ? 'No loose cubes counted yet' : 'Counted flavors only'],
      [T.toMake ? 'bad' : '', T.toMake, 'Cubes to make', 'Needed minus on hand'],
      ['', T.kitsToBuild, 'Kits to build', `${n(T.kitsOrdered)} on orders, ${n(T.kitsBuilt)} already built`]
    ].map(([c, v, l, s]) => `<div class="${c}"><b>${n(v)}</b><span>${l}</span><small>${s}</small></div>`).join('');
    $('planTitle').textContent = S.ui.mode === 'all' ? 'What to make: all demand' : 'What to make: by production window';
    $('planNote').textContent = S.ui.mode === 'all'
      ? 'Cubes by flavor and product type. Open a row to see the SKUs behind it.'
      : 'ShipStation orders land by age: 60+ days now, 30 to 59 next week, 14 to 29 in two weeks, newer in three (editable). POs land the week before their date, minus lead weeks.';
    renderFlavorTable(); renderPrep();
  }
  const matchFlavor = (r, q) => !q || (r.flavor_code + ' ' + r.name).toLowerCase().includes(q) || r.lines.some(l => (l.sku + ' ' + l.from).toLowerCase().includes(q));
  function detailRows(lines, cols) {
    return `<tr class="drow"><td colspan="${cols}"><table><thead><tr>${th('SKU')}${th('Type')}${th('From')}${th('Ordered', 1)}${th('Built', 1)}${th('To make', 1)}${th('Cubes', 1)}</tr></thead><tbody>` +
      lines.map(l => `<tr><td class="sku">${esc(l.sku)}</td><td>${esc(LBL[l.type] || l.type)}</td><td class="muted">${l.from ? 'In ' + esc(l.from) : ''}</td><td class="num">${n(l.ordered)}</td><td class="num">${nz(l.built)}</td><td class="num">${n(l.net)}</td><td class="num strong">${n(l.cubes)}</td></tr>`).join('') + '</tbody></table></td></tr>';
  }
  function renderFlavorTable() {
    const R = S.res, q = S.ui.q.trim().toLowerCase(), list = R.flavors.filter(r => matchFlavor(r, q)), t0 = today();
    if (!list.length && !(R.approx && !q)) { $('flavorTable').innerHTML = empty(q ? 'No flavors match that search.' : 'Nothing to make for these filters.'); return; }
    const byWin = S.ui.mode === 'window', cols = byWin ? R.windows : 0;
    const head = byWin
      ? `${th('Flavor')}${Array.from({ length: cols }, (_, i) => th(esc(C.windowLabel(i, t0)), 1)).join('')}${th('Total', 1)}${th('On hand', 1)}${th('To make', 1)}`
      : `${th('Flavor')}${th('Mix')}${TYPES.map(t => th(LBL[t], 1)).join('')}${th('Total', 1)}${th('On hand', 1)}${th('To make', 1)}`;
    const span = byWin ? cols + 4 : TYPES.length + 5;
    const tail = r => `<td class="num strong">${n(r.total)}</td><td class="num ${r.counted ? '' : 'muted'}">${r.counted ? n(r.on_hand) : '—'}</td><td class="num"><span class="tomake${r.to_make ? '' : ' zero'}">${r.to_make ? n(r.to_make) : 'Covered'}</span></td>`;
    const open = k => S.ui.open.has(k);
    const twist = k => `<button type="button" class="twist" data-act="twist" data-code="${esc(k)}" aria-expanded="${open(k)}" aria-label="Show SKUs">▶</button>`;
    let h = `<table><thead><tr>${head}</tr></thead><tbody>`;
    for (const r of list) {
      h += `<tr class="frow"><td><div class="fcell">${twist(r.flavor_code)}<span>${flavorLabel(r.flavor_code, r.name)}</span></div></td>`;
      h += byWin ? Array.from({ length: cols }, (_, i) => `<td class="num">${nz(r.win[i])}</td>`).join('')
                 : `<td>${mix(r.types, r.total)}</td>${TYPES.map(t => `<td class="num">${nz(r.types[t])}</td>`).join('')}`;
      h += tail(r) + '</tr>';
      if (open(r.flavor_code)) h += detailRows(r.lines, span);
    }
    if (R.approx && !q) {
      const a = R.approx;
      h += `<tr class="frow"><td><div class="fcell">${twist('__approx')}<span>Kits with no contents on file<span class="tag warn">Estimate</span></span></div></td>`;
      h += byWin ? Array.from({ length: cols }, (_, i) => `<td class="num">${nz(a.win[i])}</td>`).join('')
                 : `<td></td>${TYPES.map(t => `<td class="num">${t === 'Kit' ? n(a.cubes) : ''}</td>`).join('')}`;
      h += `<td class="num strong">${n(a.cubes)}</td><td class="num muted">—</td><td class="num"><span class="tomake">${n(a.cubes)}</span></td></tr>`;
      if (open('__approx')) h += detailRows(a.lines.map(l => ({ sku: l.sku, type: 'Kit', from: '', ordered: l.ordered, built: l.built, net: l.net, cubes: l.cubes })), span);
    }
    const sum = f => list.reduce((s, r) => s + f(r), 0) + (R.approx && !q ? f({ total: R.approx.cubes, to_make: R.approx.cubes, types: { Kit: R.approx.cubes }, win: R.approx.win, on_hand: 0 }) : 0);
    h += `<tr class="total"><td>${q ? 'Matching flavors' : 'All flavors'}</td>`;
    h += byWin ? Array.from({ length: cols }, (_, i) => `<td class="num">${n(sum(r => r.win[i]))}</td>`).join('')
               : `<td></td>${TYPES.map(t => `<td class="num">${n(sum(r => r.types[t] || 0))}</td>`).join('')}`;
    h += `<td class="num">${n(sum(r => r.total))}</td><td class="num">${n(sum(r => Math.min(r.on_hand ?? 0, r.total)))}</td><td class="num">${n(sum(r => r.to_make))}</td></tr></tbody></table>`;
    $('flavorTable').innerHTML = h;
  }
  function renderPrep() {
    const q = S.ui.q.trim().toLowerCase();
    let list = S.res.prep.filter(r => !q || (r.sku + ' ' + r.label + ' ' + r.name + ' ' + C.flavorName(S.ref, r.flavor_code) + ' ' + r.flavor_code).toLowerCase().includes(q));
    if (!list.length) { $('prepTable').innerHTML = empty('No Mini tubes on these orders.'); return; }
    const total = list.length, shown = S.ui.prepAll || q ? list : list.slice(0, 15);
    let h = `<table><thead><tr>${th('Tube')}${th('Cap')}${th('Direct', 1)}${th('In kits', 1)}${th('Needed', 1)}${th('Built used', 1)}${th('To prep', 1)}</tr></thead><tbody>`;
    for (const r of shown) {
      const fn = C.flavorName(S.ref, r.flavor_code);
      h += `<tr><td><span class="sku">${esc(r.label)}</span>${r.rimmer ? '<span class="tag">Rimmer, no cubes</span>' : ''}<span class="sub">${esc(r.name || fn || 'Flavor ' + r.flavor_code)} · ${esc(r.sku)}</span></td>` +
        `<td>${r.cap_color ? `<span class="cap ${capClass(r.cap_color)}"></span>${esc(r.cap_color)}` : '<span class="muted">—</span>'}</td>` +
        `<td class="num">${nz(r.direct)}</td><td class="num">${nz(r.in_kits)}</td><td class="num">${n(r.gross)}</td><td class="num">${nz(r.built_used)}</td><td class="num strong">${n(r.net)}</td></tr>`;
    }
    h += '</tbody></table>';
    if (shown.length < total) h += `<div class="more"><button type="button" class="btn sm" data-act="showprep">Show all ${n(total)} tubes</button></div>`;
    $('prepTable').innerHTML = h;
  }

  /* ================= KITS ================= */
  function renderKits() {
    document.querySelectorAll('[data-act="kitfilter"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === S.ui.kitFilter)));
    const R = S.full, T = R.totals, q = S.ui.kitQ.trim().toLowerCase();
    const attn = R.kits.filter(k => k.status !== 'Counted').length;
    $('kitTally').innerHTML = [
      ['', T.kitsOrdered, 'Kits on orders', `${R.kits.length} different kits`], ['', T.kitsBuilt, 'Already built', 'Built counts, oldest orders first'],
      ['', T.kitsToBuild, 'Kits to build', 'After built kits'], [attn ? 'bad' : '', attn, 'Need attention', 'No contents, or contents look short']
    ].map(([c, v, l, s]) => `<div class="${c}"><b>${n(v)}</b><span>${l}</span><small>${s}</small></div>`).join('');
    let list = R.kits.filter(k => S.ui.kitFilter === 'build' ? k.to_build > 0 : S.ui.kitFilter === 'blocked' ? k.status !== 'Counted' : true);
    if (q) list = list.filter(k => (k.sku + ' ' + k.name + ' ' + k.minis.map(m => m.sku + ' ' + m.name + ' ' + m.label).join(' ')).toLowerCase().includes(q));
    $('kitList').innerHTML = list.length ? list.map(kitBlock).join('') : empty(q ? 'No kits match that search.' : 'No kits on these orders.');
    const kc = R.kitCubes;
    $('kitCubes').innerHTML = kc.length ? `<table><thead><tr>${th('Flavor')}${th('Label variant')}${th('Tubes', 1)}${th('Cubes', 1)}</tr></thead><tbody>` +
      kc.map(r => `<tr><td>${flavorLabel(r.flavor_code, r.name)}</td><td><span class="sku">${esc(r.variant)}</span>${r.rimmer ? '<span class="tag">Rimmer, no cubes</span>' : ''}</td><td class="num">${n(r.tubes)}</td><td class="num strong">${n(r.cubes)}</td></tr>`).join('') + '</tbody></table>'
      : empty('No kit tubes to make.');
  }
  function kitBlock(k) {
    const cls = k.status === 'Counted' ? 'ok' : k.status === 'No contents on file' ? 'bad' : 'warn';
    let h = `<article class="kit"><div class="kit-h"><div class="kit-id"><b>${esc(k.sku)}</b><span>${esc(k.name)}</span><span class="tag ${cls}">${esc(k.status)}</span></div>` +
      `<dl class="kit-n"><div><dt>Ordered</dt><dd>${n(k.ordered)}</dd></div><div><dt>Built</dt><dd>${n(k.built_used)}</dd></div><div><dt>To build</dt><dd>${n(k.to_build)}</dd></div></dl></div>`;
    if (!k.minis.length) return h + `<div class="nocontent">No Mini SKUs are listed for this kit. Add its tubes under <a href="#data">Data and rules</a>, Kit components.</div></article>`;
    h += `<table><thead><tr>${th('Mini SKU')}${th('Flavor')}${th('Per kit', 1)}${th('Needed', 1)}${th('Built', 1)}${th('Short, all orders', 1)}</tr></thead><tbody>`;
    for (const m of k.minis) {
      h += `<tr><td><span class="sku">${esc(m.sku)}</span>${m.rimmer ? '<span class="tag">Rimmer, no cubes</span>' : ''}<span class="sub">${esc(m.label)}</span></td>` +
        `<td>${flavorLabel(m.flavor_code, m.name)}</td><td class="num">${n(m.per_kit)}</td><td class="num">${n(m.needed)}</td>` +
        `<td class="num ${m.built == null ? 'muted' : ''}">${m.built == null ? '—' : n(m.built)}</td><td class="num">${m.short_all ? `<span class="tag bad">${n(m.short_all)}</span>` : ''}</td></tr>`;
    }
    return h + '</tbody></table></article>';
  }

  /* ================= INVENTORY ================= */
  function orderedMap() {
    const m = new Map();
    for (const l of S.demand.lines) { const p = S.ref.prod.get(l.sku); if (p && p.include && p.type !== 'Mini') m.set(p.sku, (m.get(p.sku) || 0) + l.units); }
    for (const r of S.full.prep) m.set(r.sku, (m.get(r.sku) || 0) + r.gross);
    return m;
  }
  const cnt = (map, key) => { const x = map.get(key); return x && x.n != null ? x.n : null; };
  function afterCell(built, ordered) {
    if (built == null) return '<span class="muted">—</span>';
    const d = built - ordered;
    return d >= 0 ? `<span class="tag ok">${n(d)} spare</span>` : `<span class="tag bad">${n(-d)} short</span>`;
  }
  function makesCell(code, cubes) {
    if (cubes == null) return '<span class="muted">—</span>';
    const c = C.canMake(S.ref, code, cubes);
    return c.length ? c.map(x => `${n(x.units)} ${LBL[x.type].toLowerCase()}`).join(' · ') : '<span class="muted">No product on file</span>';
  }
  function invNotices() {
    const bn = S.builtNotes || { assumed: [], ambiguous: [], unknown: [], merged: [] }, out = [];
    ['built', 'cubes'].forEach(k => {
      const e = (S.srcErr[k]) || (!S.local[k] && S.repo[k] && S.repo[k].error);
      if (e) out.push(`<p><b>${SRC[k].title} aren't being used.</b> ${esc(e)}</p>`);
    });
    const list = (items, f) => `<details><summary>Show the SKUs</summary>${items.slice(0, 40).map(f).join('<br>')}${items.length > 40 ? `<br>and ${items.length - 40} more` : ''}</details>`;
    const dupes = ((S.local.built || S.repo.built || {}).dupes || []);
    if (dupes.length) out.push(`<p><b>${n(dupes.length)} SKUs are listed more than once</b> in the built counts. Identical repeats are counted once and different numbers are added together. Fix the file if that's wrong.</p>` +
      list(dupes, d => `<span class="sku">${esc(d.key)}</span>: ${d.values.map(n).join(' and ')}, using ${n(d.used)} (${esc(d.how)})`));
    if (bn.ambiguous.length) out.push(`<p><b>${n(bn.ambiguous.length)} built counts aren't used</b> because the SKU matches more than one product. Use the full SKU or add an alias.</p>` +
      list(bn.ambiguous, a => `<span class="sku">${esc(a.sku)}</span>: ${n(a.qty)}. ${esc(a.reason)}`));
    const short = bn.assumed.filter(a => a.why === 'short SKU');
    if (short.length) out.push(`<p>${n(short.length)} built counts use a short SKU and are counted against the one product that starts with it.</p>` +
      list(short, a => `<span class="sku">${esc(a.from)}</span> counted as <span class="sku">${esc(a.to)}</span>: ${n(a.qty)}`));
    if (bn.merged.length) out.push(`<p>${n(bn.merged.length)} products have counts from more than one SKU, added together.</p>` +
      list(bn.merged, m => `<span class="sku">${esc(m.sku)}</span> = ${m.from.map(esc).join(' + ')} = ${n(m.total)}`));
    if (bn.unknown.length) out.push(`<p>${n(bn.unknown.length)} counted SKUs aren't in products, so the plan ignores them (accessories and tea, for example).</p>` +
      list(bn.unknown, u => `<span class="sku">${esc(u.sku)}</span>: ${n(u.qty)}`));
    $('invNotes').innerHTML = out.length ? `<div class="warn">${out.join('')}</div>` : '';
  }
  function renderInventory() {
    $('invErr').hidden = true; invNotices();
    const q = S.ui.invQ.trim().toLowerCase(), only = S.ui.invOnly, ord = orderedMap(), ref = S.ref;
    /* built */
    let skus = new Map();
    if (only) { ord.forEach((_, k) => skus.set(k, null)); S.inv.built.forEach((_, k) => skus.set(k, null)); }
    else { ref.prod.forEach(p => { if (p.include && p.active) skus.set(p.sku, null); }); ord.forEach((_, k) => skus.set(k, null)); S.inv.built.forEach((_, k) => skus.set(k, null)); }
    const order = t => { const i = TYPES.indexOf(t); return i < 0 ? 9 : i; };
    const info = sku => { const p = ref.prod.get(sku); if (p) return { name: p.name, type: p.type }; const lp = C.labelParts('LM' + sku.slice(2)); return { name: lp ? `${C.flavorName(ref, lp.num) || 'Flavor ' + lp.num} · ${lp.suf}` : '', type: 'Mini' }; };
    const bl = [...skus.keys()].map(s => ({ sku: s, ...info(s) })).filter(r => !q || (r.sku + ' ' + r.name).toLowerCase().includes(q)).sort((a, b) => order(a.type) - order(b.type) || a.sku.localeCompare(b.sku));
    $('builtTable').innerHTML = bl.length ? `<table><thead><tr>${th('SKU')}${th('On order', 1)}${th('Built', 1)}${th('After orders', 1)}</tr></thead><tbody>` +
      bl.map(r => { const b = cnt(S.inv.built, r.sku), o = ord.get(r.sku) || 0;
        return `<tr data-ord="${o}"><td><span class="sku">${esc(r.sku)}</span><span class="tag">${esc(LBL[r.type] || r.type)}</span><span class="sub">${esc(r.name)}</span></td><td class="num">${nz(o)}</td>` +
          `<td class="num"><input class="cnt" type="text" inputmode="text" data-chg="inv" data-kind="built" data-key="${esc(r.sku)}" aria-label="Built count for ${esc(r.sku)}" placeholder="Count" value="${b == null ? '' : b}"></td><td class="num after">${afterCell(b, o)}</td></tr>`; }).join('') + '</tbody></table>'
      : empty(only ? 'Nothing on order matches. Untick "Only what\'s on order" to count any SKU.' : 'No SKUs match that search.');
    /* cubes */
    const need = new Map(S.full.flavors.map(f => [f.flavor_code, f.total]));
    const codes = new Map(C.flavorCodes(ref).map(f => [f.flavor_code, f.name]));
    let keys = only ? new Set([...need.keys(), ...S.inv.cubes.keys()]) : new Set([...codes.keys(), ...S.inv.cubes.keys()]);
    const cl = [...keys].map(c => ({ code: c, name: codes.get(c) || C.flavorName(ref, c) })).filter(r => !q || (r.code + ' ' + r.name).toLowerCase().includes(q)).sort((a, b) => (need.get(b.code) || 0) - (need.get(a.code) || 0) || a.code.localeCompare(b.code));
    $('cubesTable').innerHTML = cl.length ? `<table><thead><tr>${th('Flavor')}${th('Needed', 1)}${th('Cubes on hand', 1)}${th('Makes up to')}</tr></thead><tbody>` +
      cl.map(r => { const c = cnt(S.inv.cubes, r.code);
        return `<tr><td>${flavorLabel(r.code, r.name)}</td><td class="num">${nz(need.get(r.code))}</td><td class="num"><input class="cnt" type="text" data-chg="inv" data-kind="cubes" data-key="${esc(r.code)}" aria-label="Cubes on hand for flavor ${esc(r.code)}" placeholder="Count" value="${c == null ? '' : c}"></td><td class="makes">${makesCell(r.code, c)}</td></tr>`; }).join('') + '</tbody></table>'
      : empty('No flavors match.');
    renderLog();
  }
  function renderLog() {
    $('invLog').innerHTML = S.log.length ? S.log.map((e, i) => ({ e, i })).reverse().map(({ e, i }) =>
      `<div class="logrow"><span class="muted">${esc(stamp(e.at))}</span><span class="sku">${esc(e.key)}</span><span>${e.kind === 'built' ? 'Built' : 'Cubes'}: ${e.type === 'set' ? 'set to ' + n(e.qty) : (e.qty > 0 ? '+' : '−') + n(Math.abs(e.qty))}</span><button type="button" class="btn sm quiet" data-act="inv-del" data-i="${i}">Undo</button></div>`).join('')
      : '<p class="muted">No edits yet. Counts you type here are kept in this browser. Download them to commit to the repo.</p>';
  }
  function applyCount(inp) {
    const v = inp.value.trim(), kind = inp.dataset.kind, key = inp.dataset.key, cur = cnt(S.inv[kind], key);
    let entry = null;
    if (/^\d+$/.test(v)) entry = { type: 'set', qty: +v }; else if (/^[+-]\d+$/.test(v)) entry = { type: 'adjust', qty: +v };
    if (!entry) { inp.value = cur == null ? '' : cur; if (v !== '') { inp.classList.add('flash'); setTimeout(() => inp.classList.remove('flash'), 900); } return; }
    S.log.push({ kind, key, ...entry, at: new Date().toISOString() });
    saved(store.set('log', S.log)); recompute();
    const now = cnt(S.inv[kind], key); inp.value = now == null ? '' : now;
    const tr = inp.closest('tr');
    if (kind === 'built') tr.querySelector('.after').innerHTML = afterCell(now, +tr.dataset.ord || 0); else tr.querySelector('.makes').innerHTML = makesCell(key, now);
    renderLog();
  }

  /* ================= DATA AND RULES ================= */
  function renderData() { renderAttention(); renderSources(); renderRules(); renderProducts(); renderComponents(); renderFlavors(); renderAliases(); }
  /* A readable name for a SKU. Products use their own name. A Mini SKU that isn't in products (SM005, or the old SM1005)
     gets its flavor name from the number, so "SM005" reads "Strawberry Mini". */
  function itemName(sku) {
    const p = S.ref.prod.get(sku);
    if (p) return p.type === 'Mini' ? `${p.flavor_name || p.name} Mini` : p.name;
    const m = /^SM(\d{3})(?:-[A-Z]+)?(?:-S)?$/i.exec(sku) || /^SM10(\d{2})$/i.exec(sku);
    const code = m ? (m[1].length === 2 ? '0' + m[1] : m[1]) : '';
    const nm = code && C.flavorName(S.ref, code);
    return nm ? `${nm} Mini` : '';
  }
  const itemCell = sku => { const nm = itemName(sku); return nm ? `${esc(nm)}<span class="sub sku">${esc(sku)}</span>` : `<span class="sku">${esc(sku)}</span>`; };
  
  function renderAttention() {
    const A = S.full.attention, prod = [...S.ref.prod.keys()];
    const grp = (title, list, act) => !list.length ? '' : `<div class="group-h">${title}</div><table><thead><tr>${th('Item')}${th('Units', 1)}${th('Why')}${th('What to do')}<th></th></tr></thead><tbody>` +
      list.map(a => `<tr><td>${itemCell(a.sku)}</td><td class="num">${n(a.units)}</td><td>${esc(a.reason)}</td><td class="muted">${esc(a.fix)}</td><td class="num nowrap">${act(a)}</td></tr>`).join('') + '</tbody></table>';
    const un = A.filter(a => a.kind === 'unmapped'), ct = A.filter(a => a.kind === 'contents'), as = A.filter(a => a.kind === 'assumed'), ex = A.filter(a => a.kind === 'excluded');
    const warns = S.ref.warnings;
    let h = grp('Not counted: SKU not found', un, a => a.sku.startsWith('(') ? '' : `<button type="button" class="btn sm" data-act="alias-from" data-sku="${esc(a.sku)}">Add alias</button> <button type="button" class="btn sm quiet" data-act="exclude" data-sku="${esc(a.sku)}">Leave out</button>`) +
      //grp('Kits to check', ct, () => '') + grp('Counted on an assumption', as, a => a.to && a.fix ? `<button type="button" class="btn sm" data-act="alias-do" data-old="${esc(a.sku)}" data-new="${esc(a.to)}">Confirm</button>` : '') +
      grp('Left out by your settings', ex, a => `<button type="button" class="btn sm quiet" data-act="include" data-sku="${esc(a.sku)}">Count it</button>`);
    if (warns.length) h += `<div class="group-h">Kit data to check</div><div style="padding:0 12px 12px">${warns.map(w => `<p>${esc(w.parent)}: ${esc(w.text)}</p>`).join('')}</div>`;
    if (!un.length && !ct.length && !as.length && !ex.length && !warns.length) h = empty('Every SKU on these orders is counted.');
    else h = `<div class="note" style="margin:0;border:0;border-bottom:1px solid var(--line2);border-radius:0"><b>${n(un.length + ct.length)} to fix</b>: ${n(un.length)} SKUs on orders aren't in products, and ${n(ct.length)} kits have no contents or look short. That's the number on the Data and rules tab.${as.length || ex.length ? ` ${n(as.length)} more are counted on an assumption and ${n(ex.length)} are left out on purpose. Those don't need a fix.` : ''}</div>` + h;
    h += `<datalist id="skuList">${prod.map(s => `<option value="${esc(s)}">`).join('')}</datalist>` +
      `<div class="formrow"><label>Old or alternate SKU<input type="text" id="alOld" class="w140" placeholder="SM1005"></label><label>Counts as<input type="text" id="alNew" class="w140" list="skuList" placeholder="SM005-BL"></label><button type="button" class="btn" data-act="alias-add">Add alias</button><span class="muted" id="alMsg"></span></div>`;
    $('attention').innerHTML = `<div class="scroll">${h}</div>`;
  }
  
  function srcState(k) {
    const L = S.local[k], R = S.repo[k] || {}, c = rows(k).length, noun = SRC[k].noun;
    if (L) return `Using <b>${esc(L.name)}</b>, ${esc(stamp(L.at))}, in this browser. ${n(c)} ${noun}.`;
    if (R.error) return `<span style="color:var(--rust)">Problem with the repo file: ${esc(R.error)}</span>`;
    if (R.missing) return 'No repo file yet. Upload one to start.';
    return k === 'orders' ? `Repo file, pulled ${esc(stamp(R.at))}. ${n(c)} ${noun}.` : `Repo file. ${n(c)} ${noun}.`;
  }
  function renderSources() {
    $('sources').innerHTML = Object.keys(SRC).map(k => `<div class="source"><h3>${SRC[k].title}</h3><p>${SRC[k].blurb}</p><p class="stat">${srcState(k)}</p>` +
      (S.srcErr[k] ? `<p class="stat" style="color:var(--rust)">${esc(S.srcErr[k])}</p>` : '') +
      `<div class="btns"><button type="button" class="btn sm" data-act="upload" data-kind="${k}">Upload CSV</button><button type="button" class="btn sm" data-act="dl-src" data-kind="${k}">Download CSV</button>` +
      (S.local[k] || ((k === 'built' || k === 'cubes') && S.log.some(e => e.kind === k)) ? `<button type="button" class="btn sm quiet" data-act="reset-src" data-kind="${k}">Back to repo file</button>` : '') + '</div></div>').join('');
  }
  function renderRules() {
    const r = S.rules, t0 = today();
    const opts = sel => Array.from({ length: 5 }, (_, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(C.windowLabel(i, t0))}</option>`).join('');
    const list = r.age_rules.map((x, i) => ({ x, i })).sort((a, b) => b.x.min_age - a.x.min_age);
    $('rules').innerHTML = `<div class="scroll"><table><thead><tr>${th('ShipStation order is at least')}${th('Make it in')}<th></th></tr></thead><tbody>` +
      list.map(({ x, i }) => `<tr><td><input type="number" min="0" class="w60" data-chg="rule" data-i="${i}" data-f="min_age" aria-label="Minimum age in days" value="${x.min_age}"> days old</td>` +
        `<td><select data-chg="rule" data-i="${i}" data-f="window" aria-label="Production window">${opts(x.window)}</select></td><td class="num"><button type="button" class="btn sm quiet" data-act="rule-del" data-i="${i}">Remove</button></td></tr>`).join('') +
      `</tbody></table><div class="formrow"><button type="button" class="btn" data-act="rule-add">Add rule</button><button type="button" class="btn quiet" data-act="rules-reset">Back to repo rules</button><button type="button" class="btn quiet" data-act="rules-dl">Download rules.json</button>` +
      `<span class="muted">POs land the week before their commit date, minus lead weeks. The oldest rule that fits wins.</span></div></div>`;
  }
  function saveRules(r) { saved(store.set('rules', r)); recompute(); }
  const curRules = () => JSON.parse(JSON.stringify(S.rules));

  function editRows(kind, fn) {
    const base = JSON.parse(JSON.stringify(rows(kind))); fn(base);
    const rec = { name: 'edits', at: new Date().toISOString(), rows: base }; saved(store.set('src.' + kind, rec)); S.local[kind] = rec; recompute();
  }
  function renderProducts() {
    const q = S.ui.prodQ.trim().toLowerCase();
    const all = rows('products').filter(p => !q || (p.sku + ' ' + p.product_name + ' ' + p.product_type + ' ' + p.flavor_code).toLowerCase().includes(q));
    const shown = all.slice(0, S.ui.prodMore);
    const chk = (p, f) => String(p[f] || 'Y').toUpperCase() !== 'N';
    let h = `<table><thead><tr>${th('SKU')}${th('Type')}${th('Flavor code')}${th('Cubes per unit')}${th('Label code')}${th('Counts in plan')}${th('Active')}</tr></thead><tbody>` +
      shown.map(p => `<tr><td><span class="sku">${esc(p.sku)}</span><span class="sub">${esc(p.product_name)}</span></td><td>${esc(p.product_type)}</td>` +
        `<td><input type="text" class="w60" data-chg="prod" data-sku="${esc(p.sku)}" data-f="flavor_code" aria-label="Flavor code for ${esc(p.sku)}" value="${esc(p.flavor_code)}"></td>` +
        `<td><input type="number" min="0" class="w60" data-chg="prod" data-sku="${esc(p.sku)}" data-f="cubes_per_unit" aria-label="Cubes per unit for ${esc(p.sku)}" value="${esc(p.cubes_per_unit)}"></td>` +
        `<td><input type="text" class="w90" data-chg="prod" data-sku="${esc(p.sku)}" data-f="label_code" aria-label="Label code for ${esc(p.sku)}" value="${esc(p.label_code)}"></td>` +
        `<td><input type="checkbox" data-chg="prod" data-sku="${esc(p.sku)}" data-f="include_in_plan" aria-label="Counts in plan: ${esc(p.sku)}"${chk(p, 'include_in_plan') ? ' checked' : ''}></td>` +
        `<td><input type="checkbox" data-chg="prod" data-sku="${esc(p.sku)}" data-f="active" aria-label="Active: ${esc(p.sku)}"${chk(p, 'active') ? ' checked' : ''}></td></tr>`).join('') + '</tbody></table>';
    if (!shown.length) h = empty('No products match that search.');
    if (shown.length < all.length) h += `<div class="more"><button type="button" class="btn sm" data-act="prod-more">Show more (${n(all.length - shown.length)} left)</button></div>`;
    h += `<div class="formrow"><label>New SKU<input type="text" id="npSku" class="w140"></label><label>Name<input type="text" id="npName" class="w140"></label><label>Type<select id="npType"><option>Mini</option><option>Stick</option><option>Tallboy</option><option>Bulk Bag</option><option>Kit</option><option>Other</option></select></label>` +
      `<label>Flavor code<input type="text" id="npFlav" class="w60"></label><label>Cubes per unit<input type="number" id="npCpu" class="w60" min="0"></label><button type="button" class="btn" data-act="prod-add">Add product</button><span class="muted" id="npMsg"></span></div>`;
    $('products').innerHTML = h;
  }
  function renderComponents() {
    const q = S.ui.compQ.trim().toLowerCase(), all = rows('components').map((c, i) => ({ c, i })).filter(({ c }) => !q || (c.parent_sku + ' ' + c.label_code + ' ' + c.mini_sku).toLowerCase().includes(q));
    const shown = all.slice(0, S.ui.compMore);
    const kits = [...S.ref.prod.values()].filter(p => p.type === 'Kit').map(p => p.sku);
    let h = `<datalist id="kitList2">${kits.map(s => `<option value="${esc(s)}">`).join('')}</datalist>` +
      `<table><thead><tr>${th('Kit')}${th('Label code')}${th('Mini SKU')}${th('Qty', 1)}<th></th></tr></thead><tbody>` +
      shown.map(({ c, i }) => { const m = C.miniSkuFor(c.label_code, c.mini_sku);
        return `<tr><td class="sku">${esc(c.parent_sku)}</td><td><input type="text" class="w140" data-chg="comp" data-i="${i}" data-f="label_code" aria-label="Label code" value="${esc(c.label_code)}"></td>` +
          `<td><span class="sku">${esc(m)}</span></td>` +
          `<td class="num"><input type="number" min="1" class="w60" data-chg="comp" data-i="${i}" data-f="qty" aria-label="Quantity" value="${esc(c.qty || 1)}"></td><td class="num"><button type="button" class="btn sm quiet" data-act="comp-del" data-i="${i}">Remove</button></td></tr>`; }).join('') + '</tbody></table>';
    if (!shown.length) h = empty('No components match that search.');
    if (shown.length < all.length) h += `<div class="more"><button type="button" class="btn sm" data-act="comp-more">Show more (${n(all.length - shown.length)} left)</button></div>`;
    h += `<div class="formrow"><label>Kit<input type="text" id="ncKit" class="w140" list="kitList2"></label><label>Label code<input type="text" id="ncLabel" class="w140" placeholder="LM001-GC"></label><label>Qty<input type="number" id="ncQty" class="w60" min="1" value="1"></label><button type="button" class="btn" data-act="comp-add">Add component</button><span class="muted" id="ncMsg"></span></div>`;
    $('components').innerHTML = h;
  }
  function renderFlavors() {
    const q = S.ui.flavQ.trim().toLowerCase();
    const list = C.flavorCodes(S.ref).filter(f => (!S.ui.flavMissing || !f.name) && (!q || (f.flavor_code + ' ' + f.name).toLowerCase().includes(q)));
    $('flavors').innerHTML = list.length ? `<table><thead><tr>${th('Flavor code')}${th('Name')}</tr></thead><tbody>` +
      list.map(f => `<tr><td><span class="fcode">${esc(f.flavor_code)}</span></td><td><input type="text" class="w140" data-chg="flav" data-code="${esc(f.flavor_code)}" aria-label="Name for flavor ${esc(f.flavor_code)}" value="${esc(f.name)}"></td></tr>`).join('') + '</tbody></table>'
      : empty(S.ui.flavMissing ? 'Every flavor has a name.' : 'No flavors match.');
  }
  function renderAliases() {
    const list = rows('aliases');
    $('aliases').innerHTML = (list.length ? `<table><thead><tr>${th('Old SKU')}${th('Counts as')}${th('Notes')}<th></th></tr></thead><tbody>` +
      list.map((a, i) => `<tr><td class="sku">${esc(a.old_sku)}</td><td class="sku">${esc(a.new_sku)}</td><td class="muted">${esc(a.notes)}</td><td class="num"><button type="button" class="btn sm quiet" data-act="alias-del" data-i="${i}">Remove</button></td></tr>`).join('') + '</tbody></table>' : empty('No aliases yet.')) +
      '<div class="more muted">Add one from the Needs attention table above.</div>';
  }

  /* ---------- Actions ---------- */
  function addAlias(old, nw) {
    const msg = $('alMsg'), set = t => { if (msg) msg.textContent = t; };
    old = (old || '').trim(); nw = (nw || '').trim();
    if (!old || !nw) return set('Enter both SKUs.');
    if (!S.ref.prod.has(nw)) return set(`${nw} isn't in products. Pick a current SKU.`);
    editRows('aliases', r => { const i = r.findIndex(a => a.old_sku.toUpperCase() === old.toUpperCase()); const row = { old_sku: old, new_sku: nw, notes: 'Added in the planner' }; if (i >= 0) r[i] = row; else r.push(row); });
    renderData();
  }
  const ACT = {
    mode: b => { S.ui.mode = b.dataset.mode; renderPlan(); },
    type: b => { const t = b.dataset.type, s = S.ui.types; if (s.has(t)) s.delete(t); else s.add(t); if (!s.size) TYPES.forEach(x => s.add(x)); recompute(); renderPlan(); },
    twist: b => { const k = b.dataset.code; S.ui.open.has(k) ? S.ui.open.delete(k) : S.ui.open.add(k); renderFlavorTable(); },
    showprep: () => { S.ui.prepAll = true; renderPrep(); },
    kitfilter: b => { S.ui.kitFilter = b.dataset.f; renderKits(); },
    upload: b => { S.pick = b.dataset.kind; $('fileIn').value = ''; $('fileIn').click(); },
    'dl-src': b => { const k = b.dataset.kind; if (k === 'built' || k === 'cubes') return ACT['dl-inv'](b); download(CSVNAME[k], C.toCSV(C.FILES[k].headers, rows(k))); },
    'dl-inv': b => {
      const k = b.dataset.kind, key = k === 'built' ? 'sku' : 'flavor_code', val = k === 'built' ? 'on_hand' : 'cubes_on_hand', t = today();
      const out = [...S.inv[k]].filter(([, x]) => x.n != null).sort((a, b) => a[0].localeCompare(b[0])).map(([id, x]) => ({ [key]: id, [val]: x.n, counted_at: x.counted_at || t, notes: '' }));
      download(CSVNAME[k], C.toCSV([key, val, 'counted_at', 'notes'], out));
    },
    'reset-src': b => { const k = b.dataset.kind; store.del('src.' + k); S.local[k] = null; if (k === 'built' || k === 'cubes') { S.log = S.log.filter(e => e.kind !== k); store.set('log', S.log); } delete S.srcErr[k]; recompute(); renderCurrent(); },
    'inv-del': b => { S.log.splice(+b.dataset.i, 1); store.set('log', S.log); recompute(); renderInventory(); },
    'alias-from': b => { $('alOld').value = b.dataset.sku; $('alNew').focus(); },
    'alias-add': () => addAlias($('alOld').value, $('alNew').value),
    'alias-do': b => addAlias(b.dataset.old, b.dataset.new),
    'alias-del': b => { editRows('aliases', r => r.splice(+b.dataset.i, 1)); renderData(); },
    exclude: b => { const sku = b.dataset.sku; editRows('products', r => { if (!r.some(p => p.sku === sku)) r.push({ sku, product_name: '', product_type: 'Other', flavor_code: '', flavor_name: '', flavor_category: '', label_code: '', cap_color: '', cubes_per_unit: '', case_sku: '', case_qty: '', include_in_plan: 'N', active: 'Y', notes: 'Left out of the cube plan' }); }); renderData(); },
    include: b => { const sku = b.dataset.sku; editRows('products', r => r.forEach(p => { if (p.sku === sku) p.include_in_plan = 'Y'; })); renderData(); },
    'prod-more': () => { S.ui.prodMore += 100; renderProducts(); },
    'comp-more': () => { S.ui.compMore += 200; renderComponents(); },
    'prod-add': () => {
      const sku = $('npSku').value.trim(), m = $('npMsg');
      if (!sku) { m.textContent = 'Enter a SKU.'; return; }
      if (S.ref.prod.has(sku)) { m.textContent = `${sku} is already in products.`; return; }
      editRows('products', r => r.unshift({ sku, product_name: $('npName').value.trim(), product_type: $('npType').value, flavor_code: $('npFlav').value.trim(), flavor_name: '', flavor_category: '', label_code: '', cap_color: '', cubes_per_unit: $('npCpu').value, case_sku: '', case_qty: '', include_in_plan: 'Y', active: 'Y', notes: '' }));
      renderData();
    },
    'comp-add': () => {
      const kit = $('ncKit').value.trim(), label = $('ncLabel').value.trim(), m = $('ncMsg');
      if (!kit || !label) { m.textContent = 'Enter a kit and a label code.'; return; }
      if (!C.labelParts(label)) { m.textContent = 'Label codes look like LM001-GC.'; return; }
      editRows('components', r => r.push({ parent_sku: kit, mini_sku: '', label_code: label, qty: $('ncQty').value || '1', notes: '' }));
      renderData();
    },
    'comp-del': b => { editRows('components', r => r.splice(+b.dataset.i, 1)); renderData(); },
    'rule-add': () => { const r = curRules(); r.age_rules.push({ min_age: 7, window: 3 }); saveRules(r); renderRules(); },
    'rule-del': b => { const r = curRules(); r.age_rules.splice(+b.dataset.i, 1); if (!r.age_rules.length) r.age_rules.push({ min_age: 0, window: 3 }); saveRules(r); renderRules(); },
    'rules-reset': () => { store.del('rules'); recompute(); renderRules(); },
    'rules-dl': () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(S.rules, null, 2) + '\n'], { type: 'application/json' })); a.download = 'rules.json'; a.click(); }
  };
  const CHG = {
    inv: inp => applyCount(inp),
    prod: inp => { const f = inp.dataset.f, sku = inp.dataset.sku; editRows('products', r => { const p = r.find(x => x.sku === sku); if (p) p[f] = inp.type === 'checkbox' ? (inp.checked ? 'Y' : 'N') : inp.value.trim(); }); renderSources(); renderAttention(); },
    comp: inp => { const f = inp.dataset.f, i = +inp.dataset.i; editRows('components', r => { if (r[i]) { r[i][f] = inp.value.trim(); if (f === 'label_code') r[i].mini_sku = ''; } }); renderSources(); renderAttention(); const cell = inp.closest('tr').children[2]; if (cell && f === 'label_code') { const m = C.miniSkuFor(inp.value.trim(), ''); cell.innerHTML = `<span class="sku">${esc(m)}</span>`; } },
    flav: inp => { const code = inp.dataset.code; editRows('flavors', r => { let x = r.find(f => f.flavor_code === code); if (!x) { x = { flavor_code: code, flavor_name: '', notes: '' }; r.push(x); } x.flavor_name = inp.value.trim(); }); renderSources(); },
    rule: inp => { const r = curRules(), i = +inp.dataset.i, f = inp.dataset.f; r.age_rules[i][f] = Math.max(0, parseInt(inp.value, 10) || 0); saveRules(r); renderRules(); }
  };

  /* ---------- File upload ---------- */
  $('fileIn').addEventListener('change', async e => {
    const f = e.target.files[0], k = S.pick; if (!f || !k) return;
    const res = READ[k](await f.text());
    if (res.error) { S.srcErr[k] = `${f.name}: ${res.error}`; if (S.view === 'inventory') { const el = $('invErr'); el.textContent = S.srcErr[k]; el.hidden = false; } renderCurrent(true); return; }
    delete S.srcErr[k];
    const rec = { name: f.name, at: new Date().toISOString(), rows: res.rows, dupes: res.dupes || [] }; saved(store.set('src.' + k, rec)); S.local[k] = rec;
    if (k === 'built' || k === 'cubes') { S.log = S.log.filter(x => x.kind !== k); store.set('log', S.log); }
    recompute(); renderCurrent();
  });

  /* ---------- Wiring ---------- */
  document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && ACT[b.dataset.act]) ACT[b.dataset.act](b, e); });
  document.addEventListener('change', e => { const t = e.target; if (t.dataset && t.dataset.chg && CHG[t.dataset.chg]) CHG[t.dataset.chg](t); });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('cnt')) { e.preventDefault(); const all = [...document.querySelectorAll('input.cnt')], i = all.indexOf(e.target); e.target.blur(); const nx = all[i + 1]; if (nx) nx.focus(); } });
  const bind = (id, ev, fn) => $(id).addEventListener(ev, fn);
  document.querySelectorAll('.st').forEach(x => x.addEventListener('change', () => { recompute(); renderPlan(); }));
  bind('incPO', 'change', () => { recompute(); renderPlan(); });
  bind('q', 'input', e => { S.ui.q = e.target.value; renderFlavorTable(); renderPrep(); });
  bind('kitQ', 'input', e => { S.ui.kitQ = e.target.value; renderKits(); });
  bind('invQ', 'input', e => { S.ui.invQ = e.target.value; renderInventory(); });
  bind('invOnly', 'change', e => { S.ui.invOnly = e.target.checked; renderInventory(); });
  bind('prodQ', 'input', e => { S.ui.prodQ = e.target.value; S.ui.prodMore = 50; renderProducts(); });
  bind('compQ', 'input', e => { S.ui.compQ = e.target.value; S.ui.compMore = 100; renderComponents(); });
  bind('flavQ', 'input', e => { S.ui.flavQ = e.target.value; renderFlavors(); });
  bind('flavMissing', 'change', e => { S.ui.flavMissing = e.target.checked; renderFlavors(); });

  const PAGES = ['plan', 'kits', 'inventory', 'data'], DRAW = { plan: renderPlan, kits: renderKits, inventory: renderInventory, data: renderData };
  function renderCurrent() { if (S.ref) DRAW[S.view](); }
  function route() {
    const v = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'plan';
    S.view = v;
    PAGES.forEach(p => { $('v-' + p).hidden = p !== v; });
    document.querySelectorAll('#nav a').forEach(a => { if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    renderCurrent();
  }
  window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

  buildChips();
  load().then(ok => { if (!ok) return; recompute(); route(); });
  window.CubePlanner = { S, recompute, route };   // handy in the browser console and in tests
})();
