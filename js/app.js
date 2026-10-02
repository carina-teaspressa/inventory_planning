/* Cube planning UI. All calculation lives in core.js; this file loads data, keeps browser-only edits, and draws the four pages. */
// 


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
    cubes:      { title: 'Cube counts', repo: 'data/csv/inventory_cubes.csv', noun: 'recipes', blurb: 'Loose cubes on hand, by flavor code. Codes that share a recipe are added together.' },
    faire:      { title: 'Faire open orders', repo: 'data/csv/faire_open_orders.csv', noun: 'orders', blurb: 'Optional. Faire order numbers that are still open. Used when the Faire rule is "only orders on the list".' }
  };
  const READ = { orders: C.readOrders, po: C.readPO, built: t => C.readCounts('built', t), cubes: t => C.readCounts('cubes', t) };
  ['products', 'components', 'aliases', 'flavors'].forEach(k => { READ[k] = t => C.readList(k, t); });
  READ.faire = t => C.readList('faire', t, { allowEmpty: true });
  const CSVNAME = { orders: 'open_orders.csv', po: 'po_lines.csv', products: 'products.csv', components: 'product_components.csv', aliases: 'sku-aliases.csv',
                    flavors: 'flavors.csv', built: 'inventory_built.csv', cubes: 'inventory_cubes.csv', faire: 'faire_open_orders.csv' };

  const S = {
    repo: {}, local: {}, log: [], rules: C.DEFAULT_RULES, ref: null, inv: null, demand: null, full: null, res: null, view: null, srcErr: {}, flags: { soon: 0, later: 0 }, kitRecipes: new Set(),
    ui: { mode: 'all', types: new Set(TYPES), q: '', open: new Set(), kitFilter: 'all', kitQ: '', prepAll: false, invOnly: true, invQ: '',
          prodQ: '', prodMore: 50, compQ: '', compMore: 100, flavQ: '', flavMissing: true, poSel: '', poStock: false, rv: {} }
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
    S.rules = C.withDefaults(store.get('rules') || S.repo.rules);
    S.ref = C.build({ products: rows('products'), components: rows('components'), aliases: rows('aliases'), flavors: rows('flavors') });
    S.kitRecipes = new Set();   // recipes that appear as a tube inside a kit (rimmers hold no cubes)
    for (const l of S.ref.comps.values()) for (const c of l) if (!c.rimmer && c.flavor_code) S.kitRecipes.add(S.ref.recipeOf(c.flavor_code));
    const mb = C.mapBuilt(S.ref, rows('built'));
    S.builtNotes = mb.notes;
    const log = S.log.map(e => e.kind === 'cubes' ? { ...e, key: S.ref.recipeOf(e.key) } : e);   // cube counts live under the recipe
    S.inv = C.withLegacy(C.inventoryNow(mb.rows, C.mapCubes(S.ref, rows('cubes')), log), mb.legacy);
    const faireOpen = new Set(rows('faire').map(r => String(r.order_number).trim()).filter(Boolean));
    S.demand = C.demand(S.ref, rows('orders'), rows('po'), { statuses: o.statuses, includePO: o.includePO, today: t, rules: S.rules, faireOpen });
    const batch = S.rules.batch_cubes;
    S.full = C.plan(S.ref, S.demand.lines, { today: t, batch, inventory: S.inv });
    S.res = S.ui.types.size === TYPES.length ? S.full : C.plan(S.ref, S.demand.lines, { today: t, batch, inventory: S.inv, types: [...S.ui.types] });
    const m = reviewModel();
    S.flags = { soon: m.filter(x => x.tier === 'soon').reduce((a, x) => a + x.count, 0), later: m.filter(x => x.tier === 'later').reduce((a, x) => a + x.count, 0) };
    chrome();
  }
  function chrome() {
    const b = $('badge'), b2 = $('badge2'), f = S.flags;
    b.hidden = !f.soon; b.textContent = f.soon; b.title = `${f.soon} item${f.soon === 1 ? '' : 's'} that can change the numbers`;
    b2.hidden = !f.later; b2.textContent = f.later; b2.title = `${f.later} item${f.later === 1 ? '' : 's'} to fix over time`;
    const R = S.repo.orders || {}, L = S.local.orders;
    $('fresh').innerHTML = (L ? `Using orders uploaded ${esc(stamp(L.at))} in this browser.` : R.at ? `Orders pulled ${esc(stamp(R.at))} Arizona time.` : 'No order pull yet.') +
      ` <a href="${PULL_URL}" target="_blank" rel="noopener">Run the pull</a>`;
  }

  /* ---------- Small builders ---------- */
  const flavorLabel = (code, name) => `<span class="fcode">${esc(code)}</span> ${name ? esc(name) : '<span class="muted">No name yet</span>'}`;
  const th = (t, num, tip) => `<th${num ? ' class="num"' : ''}${tip ? ` title="${esc(tip)}"` : ''}>${t}</th>`;
  const bc = (cubes, size) => Math.ceil(cubes / size);                                                                      // whole batches, rounded up
  const flavorCell = r => `<span>${flavorLabel(r.flavor_code, r.name)}${r.covers && r.covers.length ? `<span class="sub">Also ${r.covers.map(c => esc(c + ' ' + C.flavorName(S.ref, c))).join(', ')}</span>` : ''}</span>`;
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
    const R = S.res, T = R.totals, size = R.batch;
    document.querySelectorAll('[data-act="mode"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === S.ui.mode)));
    document.querySelectorAll('[data-act="type"]').forEach(b => b.setAttribute('aria-pressed', String(S.ui.types.has(b.dataset.type))));
    const bits = [];
    if (S.flags.soon) bits.push(`<a href="#review">${n(S.flags.soon)} item${S.flags.soon === 1 ? '' : 's'} to review</a> that can change these numbers.`);
    if (S.ui.types.size < TYPES.length) bits.push(`Showing ${[...S.ui.types].map(t => LBL[t].toLowerCase()).join(', ')} only. Batches to make are figured for these alone.`);
    $('notes').innerHTML = bits.length ? `<p class="quiet">${bits.join(' ')}</p>` : '';
    $('tally').innerHTML = [
      [T.batchesToMake ? 'bad' : '', T.batchesToMake, 'Batches to make', `${n(T.toMake)} cubes, rounded up per flavor`],
      ['', Math.round(T.builtCubes / size), 'Batches already built', `${n(T.builtCubes)} cubes covered by built units`],
      ['', Math.round(T.onHand / size), 'Batches of loose cubes', T.flavorsNotCounted === R.flavors.length ? 'No loose cubes counted yet' : 'Counted flavors only'],
      ['', T.kitsToBuild, 'Kits to build', `${n(T.kitsOrdered)} on orders, ${n(T.kitsBuilt)} already built`]
    ].map(([c, v, l, sub]) => `<div class="${c}"><b>${n(v)}</b><span>${l}</span><small>${sub}</small></div>`).join('');
    $('planTitle').textContent = S.ui.mode === 'all' ? 'Flavours needed: FULL DEMAND' : 'Flavours needed: BY WINDOW';
    $('planNote').textContent = S.ui.mode === 'all'
      ? `Whole batches of ${n(size)} cubes, by flavor. Open a row to see the items ordered, in units.`
      : 'ShipStation orders land by age: 60+ days now, 30 to 59 next week, 14 to 29 in two weeks, newer in three (editable). POs land the week before their date, minus lead weeks.';
    renderFlavorTable(); renderPrep();
  }
  const matchFlavor = (r, q) => !q || (r.flavor_code + ' ' + r.name + ' ' + (r.covers || []).join(' ')).toLowerCase().includes(q) || r.lines.some(l => (l.sku + ' ' + (itemName(l.sku) || '')).toLowerCase().includes(q));
  function detailRows(lines, cols, size) {
    const dot = t => `<span class="dot" style="background:var(${TVAR[t] || '--line'})"></span>`;
    return `<tr class="drow"><td colspan="${cols}"><table><thead><tr>${th('Ordered item')}${th('Type')}${th('Ordered', 1, 'Units on order of this item. A kit counts in kits, a Mini in tubes.')}${th('Built', 1, 'Units covered by built stock')}${th('To make', 1, 'Units still to make')}${th('Batches needed', 1, 'Whole batches of this flavor this item needs. They add up to the flavor total above.')}</tr></thead><tbody>` +
      lines.map(l => `<tr><td>${itemCell(l.sku)}</td><td>${dot(l.type)}${esc(l.type === 'Kit' ? 'Kit' : (LBL[l.type] || l.type))}</td><td class="num">${n(l.ordered)}</td><td class="num">${nz(l.built)}</td><td class="num">${n(l.net)}</td><td class="num strong">${l.b ? n(l.b) : (l.cubes ? '&lt;1' : '0')}</td></tr>`).join('') +
      '</tbody></table><p class="dnote">These add up to the flavor\'s batches needed.</p></td></tr>';
  }


  function renderFlavorTable() {
    const R = S.res, size = R.batch, q = S.ui.q.trim().toLowerCase(), list = R.flavors.filter(r => matchFlavor(r, q)), t0 = today();
    if (!list.length && !(R.approx && !q)) { $('flavorTable').innerHTML = empty(q ? 'No flavors match that search.' : 'Nothing to make for these filters.'); return; }
    const byWin = S.ui.mode === 'window', cols = byWin ? R.windows : 0;
    const tNeed = `This flavor's cubes divided by ${size}, rounded up to whole batches`, tHand = 'Loose cubes counted for this flavor, in whole batches (rounded down)', tMake = 'Batches needed minus loose cubes on hand, rounded up';
    const head = byWin
      ? `${th('Flavor')}${Array.from({ length: cols }, (_, i) => th(esc(C.windowLabel(i, t0)), 1, 'Batches needed in this window. They add up to Batches needed.')).join('')}${th('Batches needed', 1, tNeed)}${th('On hand', 1, tHand)}${th('To make', 1, tMake)}`
      : `${th('Flavor')}${th('Mix', 0, 'Share of this flavor by product type. Colors match the filters above.')}${th('Batches needed', 1, tNeed)}${th('On hand', 1, tHand)}${th('To make', 1, tMake)}`;
    const span = byWin ? cols + 4 : 5;
    const tail = r => `<td class="num strong">${n(r.batches)}</td><td class="num ${r.counted ? '' : 'muted'}">${r.counted ? n(r.on_hand_b) : '—'}</td><td class="num"><span class="tomake${r.to_make ? '' : ' zero'}">${r.to_make ? n(bc(r.to_make, size)) : 'Covered'}</span></td>`;
    const open = k => S.ui.open.has(k);
    const twist = k => `<button type="button" class="twist" data-act="twist" data-code="${esc(k)}" aria-expanded="${open(k)}" aria-label="Show SKUs">▶</button>`;
    let h = `<table><thead><tr>${head}</tr></thead><tbody>`;
    for (const r of list) {
      h += `<tr class="frow"><td><div class="fcell">${twist(r.flavor_code)}${flavorCell(r)}</div></td>`;
      h += byWin ? Array.from({ length: cols }, (_, i) => `<td class="num">${nz(r.win_b[i])}</td>`).join('') : `<td>${mix(r.types, r.total)}</td>`;
      h += tail(r) + '</tr>';
      if (open(r.flavor_code)) h += detailRows(r.lines, span, size);
    }
    if (R.approx && !q) {
      const a = R.approx;
      h += `<tr class="frow"><td><div class="fcell">${twist('__approx')}<span>Kits with no contents on file<span class="tag warn">Estimate</span></span></div></td>`;
      h += byWin ? Array.from({ length: cols }, (_, i) => `<td class="num">${nz(a.win_b[i])}</td>`).join('') : '<td></td>';
      h += `<td class="num strong">${n(a.batches)}</td><td class="num muted">—</td><td class="num"><span class="tomake">${n(a.batches)}</span></td></tr>`;
      if (open('__approx')) h += detailRows(a.lines.map(l => ({ sku: l.sku, type: 'Kit', ordered: l.ordered, built: l.built, net: l.net, cubes: l.cubes, b: l.b })), span, size);
    }
    const apx = R.approx && !q ? R.approx : null;
    const sum = f => list.reduce((acc, r) => acc + f(r), 0);
    h += `<tr class="total"><td>${q ? 'Matching flavors' : 'All flavors'}</td>`;
    h += byWin ? Array.from({ length: cols }, (_, i) => `<td class="num">${n(sum(r => r.win_b[i]) + (apx ? apx.win_b[i] : 0))}</td>`).join('') : '<td></td>';
    h += `<td class="num">${n(sum(r => r.batches) + (apx ? apx.batches : 0))}</td><td class="num">${n(sum(r => Math.min(r.on_hand_b ?? 0, r.batches)))}</td><td class="num">${n(sum(r => bc(r.to_make, size)) + (apx ? apx.batches : 0))}</td></tr></tbody></table>`;
    h += `<div class="note-in">A batch is ${n(size)} cubes of one flavor. "Batches needed" is the flavor's cubes divided by ${n(size)}, rounded up. Open a row to see which ordered items make it up. Colors match the product filters above.</div>`;
    $('flavorTable').innerHTML = h;
  }
  function renderPrep() {
    const q = S.ui.q.trim().toLowerCase();
    const list = S.res.prep.filter(r => !q || (r.sku + ' ' + r.label + ' ' + r.name + ' ' + C.flavorName(S.ref, r.flavor_code) + ' ' + r.flavor_code).toLowerCase().includes(q));
    $('prepTable').innerHTML = prepTable(list, { all: S.ui.prepAll || !!q, more: true });
  }
  /* Mini tubes by SKU. Cap color comes from the SKU suffix. */
  function prepTable(list, o) {
    if (!list.length) return empty('No Mini tubes on these orders.');
    const total = list.length, shown = o.all ? list : list.slice(0, 15);
    let h = `<table><thead><tr>${th('Tube')}${th('Cap')}${th('Direct', 1)}${th('In kits', 1)}${th('Needed', 1)}${th('Built used', 1)}${th('To prep', 1)}</tr></thead><tbody>`;
    for (const r of shown) {
      const lt = C.labelType(r.variant), fn = C.flavorName(S.ref, S.ref.recipeOf(r.flavor_code)) || C.flavorName(S.ref, r.flavor_code);
      h += `<tr><td><span class="sku">${esc(r.label)}</span>${r.rimmer ? '<span class="tag">Rimmer, no cubes</span>' : ''}<span class="sub">${esc(r.name || fn || 'Flavor ' + r.flavor_code)} · ${esc(lt.name || r.variant)}</span></td>` +
        `<td>${lt.cap ? `<span class="cap ${capClass(lt.cap)}"></span>${esc(lt.cap)}` : '<span class="muted">—</span>'}</td>` +
        `<td class="num">${nz(r.direct)}</td><td class="num">${nz(r.in_kits)}</td><td class="num">${n(r.gross)}</td><td class="num">${nz(r.built_used)}</td><td class="num strong">${n(r.net)}</td></tr>`;
    }
    h += '</tbody></table>';
    if (o.more && shown.length < total) h += `<div class="more"><button type="button" class="btn sm" data-act="showprep">Show all ${n(total)} tubes</button></div>`;
    return h;
  }

  /* ================= KITS ================= */
  function renderKits() {
    document.querySelectorAll('[data-act="kitfilter"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === S.ui.kitFilter)));
    const R = S.full, T = R.totals, q = S.ui.kitQ.trim().toLowerCase();
    const flagged = R.kits.filter(k => k.status !== 'Counted' || k.dup).length;
    $('kitTally').innerHTML = [
      ['', T.kitsOrdered, 'Kits on orders', `${R.kits.length} different kits`], ['', T.kitsBuilt, 'Already built', 'Built kits used against orders, oldest first'],
      ['', T.kitsToBuild, 'Kits needed', 'On order, after built kits'], ['', flagged, 'Kits flagged', 'Contents to check. See Data review']
    ].map(([c, v, l, sub]) => `<div class="${c}"><b>${n(v)}</b><span>${l}</span><small>${sub}</small></div>`).join('');
    let list = R.kits.filter(k => S.ui.kitFilter === 'build' ? k.to_build > 0 : S.ui.kitFilter === 'blocked' ? (k.status !== 'Counted' || k.dup) : true);
    if (q) list = list.filter(k => (k.sku + ' ' + k.name + ' ' + k.minis.map(m => m.sku + ' ' + m.name + ' ' + m.label).join(' ')).toLowerCase().includes(q));
    $('kitList').innerHTML = list.length ? list.map(kitBlock).join('') : empty(q ? 'No kits match that search.' : 'No kits on these orders.');
    $('kitTubes').innerHTML = tubeTable(R.kitFlavors, R.batch);
  }
  function kitBlock(k) {
    let h = `<article class="kit"><div class="kit-h"><div class="kit-id"><b>${esc(k.sku)}</b><span>${esc(k.name)}</span>` +
      (k.status === 'No contents on file' ? '<span class="tag">No contents on file</span>' : (k.status !== 'Counted' || k.dup) ? '<a class="quiet-link" href="#review">Review flag</a>' : '') + '</div>' +
      `<dl class="kit-n"><div><dt>On order</dt><dd>${n(k.ordered)}</dd></div><div><dt>Built</dt><dd>${n(k.built_used)}</dd></div><div><dt>Kits needed</dt><dd>${n(k.to_build)}</dd></div></dl></div>`;
    if (!k.minis.length) return h + `<div class="nocontent">No Mini SKUs are listed for this kit. Add its tubes under <a href="#data">Data and rules</a>, Kit components.</div></article>`;
    h += `<table><thead><tr>${th('Mini SKU')}${th('Flavor')}${th('Per kit', 1)}${th('Minis built', 1, 'Built, labeled Minis of this SKU on hand, shared with every kit and order. Legacy Minis are a different size and are not used in kits.')}</tr></thead><tbody>`;
    for (const m of k.minis) {
      const lt = C.labelType(m.variant);
      h += `<tr><td><span class="sku">${esc(m.sku)}</span>${m.rimmer ? '<span class="tag">Rimmer, no cubes</span>' : ''}<span class="sub">${esc(lt.name || m.label)}</span></td>` +
        `<td>${flavorLabel(m.flavor_code, m.name)}</td><td class="num">${n(m.per_kit)}</td>` +
        `<td class="num ${m.built == null ? 'muted' : ''}">${m.built == null ? '—' : n(m.built)}${m.legacy ? `<span class="sub">${n(m.legacy)} legacy, not used</span>` : ''}</td></tr>`;
    }
    return h + '</tbody></table></article>';
  }
  /* Tubes by Mini SKU, grouped by recipe. Batches count every cube of the flavor together, across kits and label variants. */
  function tubeTable(list, size) {
    if (!list.length) return empty('No kit tubes to make.');
    let h = `<table><thead><tr>${th('Flavor and Mini SKU')}${th('Tubes', 1)}${th('Batches', 1, 'Batches of ' + size + ' cubes, counting every kit and label variant of the flavor together')}</tr></thead><tbody>`;
    for (const f of list) {
      h += `<tr class="grp"><td>${flavorLabel(f.flavor_code, f.name)}</td><td class="num strong">${n(f.tubes)}</td><td class="num strong">${f.cubes ? n(f.batches) : '<span class="muted">No cubes</span>'}</td></tr>`;
      for (const x of f.skus) h += `<tr class="sk"><td><span class="sku">${esc(x.sku)}</span><span class="sub">${esc(C.labelType(x.variant).name || x.variant)}${x.rimmer ? ', no cubes' : ''}</span></td><td class="num">${n(x.tubes)}</td><td></td></tr>`;
    }
    return h + '</tbody></table>';
  }

  /* ================= POS ================= */
  function poGroups() {
    const m = new Map();
    for (const p of rows('po')) {
      if (String(p.status || 'open').toLowerCase() !== 'open') continue;
      if (!m.has(p.po_number)) m.set(p.po_number, { po: p.po_number, customer: p.customer, source: p.source, commit: p.commit_date, lines: [], units: 0 });
      const g = m.get(p.po_number); g.lines.push(p); g.units += +p.units || 0;
      if (p.commit_date && (!g.commit || p.commit_date < g.commit)) g.commit = p.commit_date;
    }
    return [...m.values()].sort((a, b) => (a.commit || '').localeCompare(b.commit || '') || String(a.po).localeCompare(String(b.po)));
  }
  /* One PO planned on its own. Built stock is only taken off if asked. */
  function poPlan(g, useStock) {
    const t = today(), d = C.demand(S.ref, [], g.lines, { statuses: new Set(), includePO: true, today: t, rules: S.rules });
    return { d, p: C.plan(S.ref, d.lines, { today: t, batch: S.rules.batch_cubes, inventory: useStock ? S.inv : C.inventoryNow([], [], []) }) };
  }
  function renderPOs() {
    const groups = poGroups(), size = S.rules.batch_cubes;
    if (!groups.length) { $('poOverview').innerHTML = empty('No open PO lines. Add them to data/csv/po_lines.csv.'); $('poDetail').innerHTML = ''; $('poNote').innerHTML = ''; return; }
    if (!groups.some(g => g.po === S.ui.poSel)) S.ui.poSel = groups[0].po;
    const st = new Set(['awaiting_shipment', 'on_hold']);
    const all = C.demand(S.ref, rows('orders'), rows('po'), { statuses: st, includePO: true, today: today(), rules: S.rules });
    const ssOrders = rows('orders');
    const ssCell = g => {
      const r = all.replaced.by[g.po];
      if (r) return `<span class="tag ok">Replaces ${n(r.lines)} ShipStation lines</span>`;
      const num = String(g.po).trim(), hit = num.length >= 4 ? new Set(ssOrders.filter(o => String(o.order_number).includes(num)).map(o => o.order_number)) : new Set();
      return hit.size ? `<span class="tag warn">${hit.size} ShipStation order${hit.size === 1 ? '' : 's'} contain this number</span>` : '<span class="muted">No ShipStation overlap set</span>';
    };
    $('poNote').innerHTML = '';
    $('poOverview').innerHTML = `<table><thead><tr>${th('PO')}${th('Customer')}${th('Commit date')}${th('Lines', 1)}${th('Units', 1)}${th('Batches', 1, 'Batches of ' + size + ' cubes this PO needs on its own, rounded up per flavor')}${th('In ShipStation?')}</tr></thead><tbody>` +
      groups.map(g => { const r = poPlan(g, S.ui.poStock).p;
        return `<tr class="frow pick${g.po === S.ui.poSel ? ' on' : ''}" data-act="po-pick" data-po="${esc(g.po)}" tabindex="0" role="button" aria-label="Show PO ${esc(g.po)}"><td><span class="sku">${esc(g.po)}</span>${g.source && g.source !== 'PO' ? `<span class="tag">${esc(g.source)}</span>` : ''}</td><td>${esc(g.customer)}</td><td>${esc(g.commit)}</td><td class="num">${n(g.lines.length)}</td><td class="num">${n(g.units)}</td><td class="num strong">${n(r.totals.batchesToMake)}</td><td>${ssCell(g)}</td></tr>`; }).join('') + '</tbody></table>' +
      `<div class="note-in">Batches here are for each PO on its own. POs are also counted in the Plan, and rounding each PO up separately means they can add up to a little more than the Plan shows. To avoid counting a PO twice when it is also in ShipStation, put its ShipStation order number (or the start of it, like MO-PS) in <code>replaces_shipstation</code> in po_lines.csv. Use ; between several.</div>`;
    const g = groups.find(x => x.po === S.ui.poSel), { d, p } = poPlan(g, S.ui.poStock), T = p.totals;
    const bySku = new Map(); p.flavors.forEach(f => f.lines.forEach(l => { const x = bySku.get(l.sku) || { b: 0, cubes: 0 }; x.b += l.b; x.cubes += l.cubes; bySku.set(l.sku, x); }));
    const status = l => { const pr = S.ref.prod.get(l.sku); return !pr ? '<span class="tag warn">Not in products</span>' : !pr.include ? '<span class="tag">Left out</span>' : '<span class="tag ok">Counted</span>'; };
    $('poDetail').innerHTML =
      `<div class="block-h"><h2>PO ${esc(g.po)}</h2><p>${esc(g.customer)} · commit ${esc(g.commit)} · ${n(g.lines.length)} line${g.lines.length === 1 ? '' : 's'}</p>` +
      `<label class="checks"><input type="checkbox" data-chg="poStock"${S.ui.poStock ? ' checked' : ''}> Take built stock off this PO</label></div>` +
      `<div class="tally">${[['', g.units, 'Units on this PO', 'As written in the PO file'], ['', T.kitsToBuild, 'Kits to build', 'On this PO'], ['', T.tubes, 'Mini tubes to prep', `${n(T.rimmers)} rimmers`], [T.batchesToMake ? 'bad' : '', T.batchesToMake, 'Batches', 'Rounded up per flavor']]
        .map(([c, v, l, sub]) => `<div class="${c}"><b>${n(v)}</b><span>${l}</span><small>${sub}</small></div>`).join('')}</div>` +
      `<section class="block"><div class="block-h"><h2>SKUs on this PO</h2></div><div class="scroll"><table><thead><tr>${th('Item')}${th('Type')}${th('Units', 1)}${th('Batches', 1, 'Batches of cubes this line needs')}${th('')}</tr></thead><tbody>` +
      d.lines.map(l => { const pr = S.ref.prod.get(l.sku); return `<tr><td>${itemCell(l.raw_sku)}</td><td>${esc(pr ? (LBL[pr.type] || pr.type) : '')}</td><td class="num">${n(l.units)}</td><td class="num">${(() => { const x = bySku.get(l.sku); return x ? (x.b ? n(x.b) : (x.cubes ? '&lt;1' : '0')) : ''; })()}</td><td>${status(l)}</td></tr>`; }).join('') + '</tbody></table></div></section>' +
      `<section class="block"><div class="block-h"><h2>Batches by flavor</h2><p>Every cube this PO needs, by recipe.</p></div><div class="scroll">` +
      (p.flavors.some(f => f.total) ? `<table><thead><tr>${th('Flavor')}${th('Mix')}${th('Batches', 1, 'Whole batches of ' + size + ' cubes')}</tr></thead><tbody>` +
        p.flavors.filter(f => f.total).sort((a, b) => b.total - a.total).map(f => `<tr><td>${flavorCell(f)}</td><td>${mix(f.types, f.total)}</td><td class="num strong">${n(bc(f.to_make, size))}</td></tr>`).join('') + '</tbody></table>' : empty('No cubes to make for this PO.')) + '</div></section>' +
      (p.kits.length ? `<section class="block"><div class="block-h"><h2>Kits on this PO</h2></div><div class="scroll"><table><thead><tr>${th('Kit')}${th('On PO', 1)}${th('Kits needed', 1)}${th('Mini SKUs inside')}</tr></thead><tbody>` +
        p.kits.map(k => `<tr><td>${itemCell(k.sku)}</td><td class="num">${n(k.ordered)}</td><td class="num strong">${n(k.to_build)}</td><td>${k.minis.length ? k.minis.map(m => `<span class="sku">${esc(m.sku)}</span>`).join(' ') : '<span class="muted">No contents on file</span>'}</td></tr>`).join('') + '</tbody></table></div></section>' : '') +
      (p.prep.length ? `<section class="block"><div class="block-h"><h2>Mini tubes to prep</h2><p>Tubes by Mini SKU for this PO, direct and inside kits.</p></div><div class="scroll">${prepTable(p.prep, { all: true })}</div></section>` : '');
  }

  /* ================= INVENTORY ================= */
  function orderedMap() {
    const m = new Map();
    for (const l of S.demand.lines) { const p = S.ref.prod.get(l.sku); if (p && p.include && p.type !== 'Mini') m.set(p.sku, (m.get(p.sku) || 0) + l.units); }
    for (const r of S.full.prep) m.set(r.sku, (m.get(r.sku) || 0) + r.gross);
    return m;
  }
  const cnt = (map, key) => { const x = map.get(key); if (!x) return null; const v = x.newN !== undefined ? x.newN : x.n; return v != null ? v : null; };
  function afterCell(built, ordered) {
    if (built == null) return '<span class="muted">—</span>';
    const d = built - ordered;
    return d >= 0 ? `<span class="tag ok">${n(d)} spare</span>` : `<span class="tag bad">${n(-d)} short</span>`;
  }
  function makesCell(code, cubes) {
    if (cubes == null) return '<span class="muted">—</span>';
    const c = C.canMake(S.ref, code, cubes);
    if (c.length) return c.map(x => `${n(x.units)} ${LBL[x.type].toLowerCase()}`).join(' · ');
    if (S.kitRecipes.has(code)) return `Kit tubes only: ${n(Math.floor(cubes / 6))} tubes`;   // no sellable product, but kits use it: 6 cubes a tube
    return '<span class="muted">No product on file</span>';
  }

  function invNotices() {
    const k = reviewModel().filter(x => ['counts', 'merged', 'unknown'].includes(x.id)).reduce((a, x) => a + x.count, 0);
    $('invNotes').innerHTML = k ? `<p class="quiet">${n(k)} inventory count item${k === 1 ? '' : 's'} to review in <a href="#review">Data review</a>.</p>` : '';
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
    $('builtTable').innerHTML = bl.length ? `<table><thead><tr>${th('SKU')}${th('On order', 1)}${th('Built (new)', 1, 'Built units under the current, labeled SKU. Type a count, or +6 and -6 to adjust.')}${th('Legacy', 1, 'Older Minis with no label and a different size, counted under a short SKU like SM001. They are not used for this SKU or for kits. They only fill orders placed under the short SKU.')}${th('After orders', 1, 'New built minus what is on order. Legacy is not included.')}</tr></thead><tbody>` +
      bl.map(r => { const b = cnt(S.inv.built, r.sku), o = ord.get(r.sku) || 0, lg = (S.inv.built.get(r.sku) || {}).legacy || 0;
        return `<tr data-ord="${o}"><td><span class="sku">${esc(r.sku)}</span><span class="tag">${esc(LBL[r.type] || r.type)}</span><span class="sub">${esc(r.name)}</span></td><td class="num">${nz(o)}</td>` +
          `<td class="num"><input class="cnt" type="text" inputmode="text" data-chg="inv" data-kind="built" data-key="${esc(r.sku)}" aria-label="Built count for ${esc(r.sku)}" placeholder="Count" value="${b == null ? '' : b}"></td><td class="num">${lg ? n(lg) : '<span class="muted">—</span>'}</td><td class="num after">${afterCell(b, o)}</td></tr>`; }).join('') + '</tbody></table>'
      : empty(only ? 'Nothing on order matches. Untick "Only what\'s on order" to count any SKU.' : 'No SKUs match that search.');
    /* cubes */
    const need = new Map(S.full.flavors.map(f => [f.flavor_code, f.total]));
    const codes = new Map(C.recipeKeys(ref).map(f => [f.flavor_code, f]));
    let keys = only ? new Set([...need.keys(), ...S.inv.cubes.keys()]) : new Set([...codes.keys(), ...S.inv.cubes.keys()]);
    const cl = [...keys].map(c => ({ code: c, name: (codes.get(c) || {}).name || C.flavorName(ref, c), covers: (codes.get(c) || {}).covers || [] })).filter(r => !q || (r.code + ' ' + r.name).toLowerCase().includes(q)).sort((a, b) => (need.get(b.code) || 0) - (need.get(a.code) || 0) || a.code.localeCompare(b.code));
    $('cubesTable').innerHTML = cl.length ? `<table><thead><tr>${th('Flavor')}${th('Needed (cubes)', 1)}${th('Cubes on hand', 1)}${th('Makes up to')}</tr></thead><tbody>` +
      cl.map(r => { const c = cnt(S.inv.cubes, r.code);
        return `<tr><td>${flavorCell({ flavor_code: r.code, name: r.name, covers: r.covers })}</td><td class="num">${nz(need.get(r.code))}</td><td class="num"><input class="cnt" type="text" data-chg="inv" data-kind="cubes" data-key="${esc(r.code)}" aria-label="Cubes on hand for flavor ${esc(r.code)}" placeholder="Count" value="${c == null ? '' : c}"></td><td class="makes">${makesCell(r.code, c)}</td></tr>`; }).join('') + '</tbody></table>'
      : empty('No flavors match.');
    const lg = S.full.legacy;
    $('legacyBlock').innerHTML = lg.rows.length ? `<section class="block"><div class="block-h"><h2>Legacy Minis on order</h2><p>Orders placed under a short SKU. They are filled from legacy stock only, and add no batches.</p></div><div class="scroll"><table><thead><tr>${th('Ordered as')}${th('On order', 1)}${th('Legacy stock', 1)}${th('Short', 1)}</tr></thead><tbody>` +
      lg.rows.map(r => `<tr><td><span class="sku">${esc(r.raw)}</span><span class="sub">${esc(r.name)} Mini</span></td><td class="num">${n(r.ordered)}</td><td class="num">${n(r.stock)}</td><td class="num">${r.short ? `<span class="tag bad">${n(r.short)}</span>` : '<span class="tag ok">Covered</span>'}</td></tr>`).join('') + '</tbody></table></div></section>' : '';
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
  function renderData() { renderSources(); renderRules(); renderProducts(); renderComponents(); renderFlavors(); renderAliases(); }
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
  
  const tblH = (heads, body) => `<div class="scroll"><table><thead><tr>${heads.map(h => th(h[0], h[1])).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
  const aliasForm = () => `<datalist id="skuList">${[...S.ref.prod.keys()].map(x => `<option value="${esc(x)}">`).join('')}</datalist>` +
    `<div class="formrow"><label>Old or alternate SKU<input type="text" id="alOld" class="w140" placeholder="SM1005"></label><label>Counts as<input type="text" id="alNew" class="w140" list="skuList" placeholder="SM005-BL"></label><button type="button" class="btn" data-act="alias-add">Add alias</button><span class="muted" id="alMsg"></span></div>`;
  /* Everything worth checking, in two tiers. "soon" can change the numbers, "later" is housekeeping. Each html is built only when drawn. */
  function reviewModel() {
    const A = S.full.attention, bn = S.builtNotes || { assumed: [], ambiguous: [], unknown: [], merged: [] }, F = S.demand.faire, size = S.rules.batch_cubes;
    const dupes = ((S.local.built || S.repo.built || {}).dupes || []), secs = [];
    const add = (tier, id, title, hint, count, html) => { if (count > 0) secs.push({ tier, id, title, hint, count, html }); };
    const by = k => A.filter(a => a.kind === k);
    const un = by('unmapped'), ct = by('contents'), as = by('assumed'), ex = by('excluded');
    const btn = (act, label, attrs, quiet) => `<button type="button" class="btn sm${quiet ? ' quiet' : ''}" data-act="${act}" ${attrs}>${label}</button>`;

    /* --- can change the numbers --- */
    add('soon', 'unmapped', "SKUs on orders that aren't in products", "These order lines aren't counted. Add an alias if it's an old name for something you sell, or leave it out if it isn't a cube product (accessories and tea, for example).", un.length,
      () => tblH([['Item'], ['Units', 1], ['Why'], ['']], un.map(a => `<tr><td>${itemCell(a.sku)}</td><td class="num">${n(a.units)}</td><td>${esc(a.reason)}</td><td class="num nowrap">${btn('alias-from', 'Add alias', `data-sku="${esc(a.sku)}"`)} ${btn('exclude', 'Leave out', `data-sku="${esc(a.sku)}"`, 1)}</td></tr>`).join('')) + aliasForm());
    add('soon', 'nocontents', 'Kits with no contents on file', "Their cubes are estimated and not assigned to a flavor, so they can't join a flavor's batches. List each kit's Mini tubes under Data and rules, Kit components.", ct.length,
      () => tblH([['Kit'], ['Units on order', 1]], ct.map(a => `<tr><td>${itemCell(a.sku)}</td><td class="num">${n(a.units)}</td></tr>`).join('')));
    const errs = ['built', 'cubes'].map(k => ({ k, e: S.srcErr[k] || (!S.local[k] && S.repo[k] && S.repo[k].error) })).filter(x => x.e);
    add('soon', 'counts', 'Inventory counts to check', "Counts that can't be used, or were merged because a SKU is listed twice. Fix the counts file, or use the full SKU.", errs.length + dupes.length + bn.ambiguous.length,
      () => tblH([['Item'], ['Counts', 1], ['What happened']],
        errs.map(x => `<tr><td>${esc(SRC[x.k].title)}</td><td class="num"></td><td>${esc(x.e)} These counts aren't being used.</td></tr>`).join('') +
        dupes.map(d => `<tr><td>${itemCell(d.key)}</td><td class="num">${d.values.map(n).join(' and ')}</td><td>Listed more than once. Using ${n(d.used)} (${esc(d.how)}).</td></tr>`).join('') +
        bn.ambiguous.map(a => `<tr><td>${itemCell(a.sku)}</td><td class="num">${n(a.qty)}</td><td>${esc(a.reason)}. Not used.</td></tr>`).join('')));
    add('soon', 'dupcomps', 'Kit contents listed twice', 'The same label appears twice for one kit. It is counted once, because two tubes of a kind belong in one row with qty 2. Remove the repeat from product_components.csv, or set qty to 2 if the kit really holds two.', S.ref.dupComps.length,
      () => tblH([['Kit'], ['Label'], ['Listed', 1], ['Counted', 1]], S.ref.dupComps.map(d => `<tr><td>${itemCell(d.parent)}</td><td class="sku">${esc(d.label_code)}</td><td class="num">${n(d.times)} times</td><td class="num">${n(d.used)}</td></tr>`).join('')));
    const legShort = S.full.legacy.rows.filter(r => r.short > 0);
    add('soon', 'legacyshort', 'Legacy Minis ordered that legacy stock cannot fill', 'These orders use a short SKU, so they need legacy Minis (older, unlabeled, a different size). They add no batches. Count legacy stock on Inventory, or move the orders to the new SKU.', legShort.length,
      () => tblH([['Ordered as'], ['On order', 1], ['Legacy stock', 1], ['Short', 1]], legShort.map(r => `<tr><td>${itemCell(r.raw)}</td><td class="num">${n(r.ordered)}</td><td class="num">${n(r.stock)}</td><td class="num"><span class="tag bad">${n(r.short)}</span></td></tr>`).join('')));
    const faireSoon = F.orders > 0 && ((F.mode === 'all' && F.old_units > 0) || F.listedMissing);
    add('soon', 'faire', 'Faire orders may be counted twice', 'Faire orders sync into ShipStation but are shipped from Faire, so ShipStation never marks them shipped.', faireSoon ? 1 : 0, () =>
      `<div class="rv-body"><p>${n(F.orders)} open ShipStation orders look like Faire orders (${n(F.units)} units). ${n(F.old_orders)} of them (${n(F.old_units)} units) are over ${n(F.max_age_days)} days old and may already be shipped.</p>` +
      `<p>${F.listedMissing ? 'The Faire rule is set to count only orders on the open list, but the list is empty, so every Faire order is counted.' : 'Every Faire order is counted right now, which can push batches up.'} ` +
      `Change this under <a href="#data">Data and rules</a>, Planning rules, Faire orders.</p>` +
      tblH([['Faire units by order age'], ['Under 14 days', 1], ['14 to 29', 1], ['30 to 59', 1], ['60 or more', 1]], `<tr><td>Units</td><td class="num">${n(F.ages.lt14)}</td><td class="num">${n(F.ages.lt30)}</td><td class="num">${n(F.ages.lt60)}</td><td class="num">${n(F.ages.gte60)}</td></tr>`) + '</div>');

    /* --- fix over time --- */
    const shortKits = S.full.kits.filter(k => k.status === 'Contents may be incomplete');
    add('later', 'short', 'Kits whose contents look short', 'The tubes listed hold fewer cubes than cubes per unit in products. A rimmer holds no cubes, so a rimmer and 2 tubes is 12 cubes. Either a tube is missing, or cubes per unit should be 12.', shortKits.length,
      () => tblH([['Kit'], ['On order', 1], ['Contents hold (cubes)', 1], ['Product says (cubes)', 1], ['Contents']], shortKits.map(k => `<tr><td>${itemCell(k.sku)}</td><td class="num">${n(k.ordered)}</td><td class="num">${n(k.cubes_per_kit)}</td><td class="num">${n(k.cpu)}</td><td>${k.comps.map(c => `<span class="sku">${esc(c.label_code)}</span>${c.rimmer ? ' (rimmer)' : ''}`).join(' ')}</td></tr>`).join('')));
    const unnamed = S.full.flavors.filter(f => !f.name);
    add('later', 'names', 'Flavors with no name', 'These show as a number only. Type a name and it saves in this browser. Download flavors.csv from Data and rules to keep it.', unnamed.length,
      () => tblH([['Flavor'], ['Batches', 1], ['Name']], unnamed.map(f => `<tr><td><span class="fcode">${esc(f.flavor_code)}</span></td><td class="num">${n(f.batches)}</td><td><input type="text" class="w140" data-chg="flav" data-code="${esc(f.flavor_code)}" aria-label="Name for flavor ${esc(f.flavor_code)}" placeholder="Name"></td></tr>`).join('')));
    add('later', 'assumed', 'Counted on an assumption', 'An old SKU, sample, or short SKU was matched to one product. Confirm it to save it as an alias.', as.length,
      () => tblH([['Item'], ['Units', 1], ['Counted as'], ['']], as.map(a => `<tr><td>${itemCell(a.sku)}</td><td class="num">${n(a.units)}</td><td>${esc(a.reason)}</td><td class="num">${a.to && a.fix ? btn('alias-do', 'Confirm', `data-old="${esc(a.sku)}" data-new="${esc(a.to)}"`) : ''}</td></tr>`).join('')));
    add('later', 'merged', 'Built counts added together', 'More than one SKU in the counts file matched the same product, so their counts were added.', bn.merged.length,
      () => tblH([['Item'], ['From'], ['Total', 1]], bn.merged.map(m => `<tr><td>${itemCell(m.sku)}</td><td>${m.from.map(x => `<span class="sku">${esc(x)}</span>`).join(' + ')}</td><td class="num">${n(m.total)}</td></tr>`).join('')));
    add('later', 'unknown', "Counted SKUs that aren't in products", "The plan ignores these counts. That's expected for accessories and tea, but look for a cube product that is missing from products.", bn.unknown.length ? 1 : 0,
      () => tblH([['SKU'], ['Count', 1]], bn.unknown.map(u => `<tr><td>${itemCell(u.sku)}</td><td class="num">${n(u.qty)}</td></tr>`).join('')));
    add('later', 'excluded', 'Left out by your settings', 'include_in_plan is N for these, so they are not counted. Nothing to fix unless that changed.', ex.length,
      () => tblH([['Item'], ['Units', 1], ['']], ex.map(a => `<tr><td>${itemCell(a.sku)}</td><td class="num">${n(a.units)}</td><td class="num">${btn('include', 'Count it', `data-sku="${esc(a.sku)}"`, 1)}</td></tr>`).join('')));
    add('later', 'kitwarn', 'Kit data that disagrees', 'A Mini SKU in the components file does not match its label code. The label code is used.', S.ref.warnings.length,
      () => tblH([['Kit'], ['What']], S.ref.warnings.map(w => `<tr><td class="sku">${esc(w.parent)}</td><td>${esc(w.text)}</td></tr>`).join('')));
    const poLike = new Map(), repl = rows('po').flatMap(p => String(p.replaces_shipstation || '').split(/[;|]/).map(x => x.trim()).filter(Boolean));
    for (const o of rows('orders')) {
      const m = /^(PO\d+)/i.exec(String(o.order_number)); if (!m) continue;
      const k = m[1].toUpperCase(); if (repl.some(x => k.startsWith(x.toUpperCase()) || x.toUpperCase().startsWith(k))) continue;
      const e = poLike.get(k) || { orders: new Set(), units: 0 }; e.orders.add(o.order_number); e.units += o.qty; poLike.set(k, e);
    }
    add('later', 'polike', 'ShipStation orders that look like POs', 'If these are retail POs that are also in po_lines.csv, they are counted twice. Put the start of their order number in replaces_shipstation on that PO. If they are not in po_lines.csv, nothing to do.', poLike.size,
      () => tblH([['Order number starts with'], ['Orders', 1], ['Units', 1]], [...poLike].map(([k, e]) => `<tr><td class="sku">${esc(k)}</td><td class="num">${n(e.orders.size)}</td><td class="num">${n(e.units)}</td></tr>`).join('')));
    add('later', 'fairerule', 'The Faire rule is leaving orders out', 'Faire orders are being left out under the current rule. This is here so it is never a surprise.', F.skipped.lines > 0 ? 1 : 0, () =>
      `<div class="rv-body"><p>The Faire rule is leaving out ${n(F.skipped.lines)} order lines (${n(F.skipped.units)} units). Change it under <a href="#data">Data and rules</a>, Planning rules.</p></div>`);
    return secs;
  }
  function renderReview() {
    const m = reviewModel(), soon = m.filter(x => x.tier === 'soon'), later = m.filter(x => x.tier === 'later');
    const sec = x => `<details class="rv" data-rv="${x.id}"${(S.ui.rv[x.id] ?? x.tier === 'soon') ? ' open' : ''}><summary><span class="rv-t">${esc(x.title)}</span><span class="rv-n">${n(x.count)}</span></summary><p class="rv-hint">${esc(x.hint)}</p>${x.html()}</details>`;
    $('reviewBody').innerHTML =
      `<h2 class="rv-h">Can change the numbers</h2>${soon.length ? soon.map(sec).join('') : '<p class="empty">Nothing here changes the numbers right now.</p>'}` +
      `<h2 class="rv-h">Fix over time</h2>${later.length ? later.map(sec).join('') : '<p class="empty">Nothing waiting.</p>'}`;
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
    const r = S.rules, t0 = today(), f = r.faire;
    const opts = sel => Array.from({ length: 5 }, (_, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(C.windowLabel(i, t0))}</option>`).join('');
    const list = r.age_rules.map((x, i) => ({ x, i })).sort((a, b) => b.x.min_age - a.x.min_age);
    const modes = [['all', 'Count every Faire order'], ['max_age', 'Ignore Faire orders older than the limit'], ['listed', 'Count only orders on the Faire open list'], ['none', 'Ignore all Faire orders']];
    $('rules').innerHTML = `<div class="scroll"><table><thead><tr>${th('ShipStation order is at least')}${th('Make it in')}<th></th></tr></thead><tbody>` +
      list.map(({ x, i }) => `<tr><td><input type="number" min="0" class="w60" data-chg="rule" data-i="${i}" data-f="min_age" aria-label="Minimum age in days" value="${x.min_age}"> days old</td>` +
        `<td><select data-chg="rule" data-i="${i}" data-f="window" aria-label="Production window">${opts(x.window)}</select></td><td class="num"><button type="button" class="btn sm quiet" data-act="rule-del" data-i="${i}">Remove</button></td></tr>`).join('') +
      `</tbody></table><div class="formrow"><button type="button" class="btn" data-act="rule-add">Add rule</button><span class="muted">POs land the week before their commit date, minus lead weeks. The oldest rule that fits wins.</span></div>` +
      `<div class="formrow"><label>Batch size (cubes)<input type="number" min="1" class="w90" data-chg="setting" data-key="batch_cubes" value="${r.batch_cubes}"></label><span class="muted">One batch is this many cubes of one flavor. Each flavor rounds up to whole batches.</span></div>` +
      `<div class="formrow"><label>Faire orders<select data-chg="setting" data-key="faire.mode" aria-label="How Faire orders are counted">${modes.map(([v, l]) => `<option value="${v}"${f.mode === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>` +
      `<label>Older than (days)<input type="number" min="0" class="w60" data-chg="setting" data-key="faire.max_age_days" value="${f.max_age_days}"></label>` +
      `<label>Recognised by order number<input type="text" class="w140" data-chg="setting" data-key="faire.pattern" value="${esc(f.pattern)}" aria-label="Faire order number pattern"></label></div>` +
      `<div class="formrow"><span class="muted">Faire orders are recognised by the ShipStation store name when the daily pull includes it, otherwise by an order number matching the pattern (10 capital letters and numbers). Faire orders are shipped from Faire, so ShipStation never closes them. "Only orders on the Faire open list" uses <code>data/csv/faire_open_orders.csv</code>.</span></div>` +
      `<div class="formrow"><button type="button" class="btn quiet" data-act="rules-reset">Back to repo rules</button><button type="button" class="btn quiet" data-act="rules-dl">Download rules.json</button></div></div>`;
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
    let h = `<table><thead><tr>${th('SKU')}${th('Type')}${th('Flavor code')}${th('Cubes per unit')}${th('Label code')}${th('Recipe code')}${th('Counts in plan')}${th('Active')}</tr></thead><tbody>` +
      shown.map(p => `<tr><td><span class="sku">${esc(p.sku)}</span><span class="sub">${esc(p.product_name)}</span></td><td>${esc(p.product_type)}</td>` +
        `<td><input type="text" class="w60" data-chg="prod" data-sku="${esc(p.sku)}" data-f="flavor_code" aria-label="Flavor code for ${esc(p.sku)}" value="${esc(p.flavor_code)}"></td>` +
        `<td><input type="number" min="0" class="w60" data-chg="prod" data-sku="${esc(p.sku)}" data-f="cubes_per_unit" aria-label="Cubes per unit for ${esc(p.sku)}" value="${esc(p.cubes_per_unit)}"></td>` +
        `<td><input type="text" class="w90" data-chg="prod" data-sku="${esc(p.sku)}" data-f="label_code" aria-label="Label code for ${esc(p.sku)}" value="${esc(p.label_code)}"></td>` +
        `<td><input type="text" class="w90" data-chg="prod" data-sku="${esc(p.sku)}" data-f="recipe_code" aria-label="Recipe code for ${esc(p.sku)}" placeholder="same as flavor" value="${esc(p.recipe_code)}"></td>` +
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
    const same = new Map(rows('flavors').map(r => [r.flavor_code, r.same_recipe_as || '']));
    $('flavors').innerHTML = list.length ? `<table><thead><tr>${th('Flavor code')}${th('Name')}${th('Same recipe as', 0, 'Another flavor code that is the same recipe. They share cubes and batches. Leave blank if it is its own recipe, or if it differs by inclusions.')}</tr></thead><tbody>` +
      list.map(f => `<tr><td><span class="fcode">${esc(f.flavor_code)}</span></td><td><input type="text" class="w140" data-chg="flav" data-f="flavor_name" data-code="${esc(f.flavor_code)}" aria-label="Name for flavor ${esc(f.flavor_code)}" value="${esc(f.name)}"></td>` +
        `<td><input type="text" class="w90" data-chg="flav" data-f="same_recipe_as" data-code="${esc(f.flavor_code)}" aria-label="Same recipe as, for flavor ${esc(f.flavor_code)}" value="${esc(same.get(f.flavor_code) || '')}"></td></tr>`).join('') + '</tbody></table>'
      : empty(S.ui.flavMissing ? 'Every flavor has a name.' : 'No flavors match.');
  }
  function renderAliases() {
    const list = rows('aliases');
    $('aliasCount').textContent = `${n(list.length)} mapped in the background`;
    $('aliases').innerHTML = list.length ? `<table><thead><tr>${th('Old SKU')}${th('Counts as')}${th('Notes')}<th></th></tr></thead><tbody>` +
      list.map((a, i) => `<tr><td class="sku">${esc(a.old_sku)}</td><td class="sku">${esc(a.new_sku)}</td><td class="muted">${esc(a.notes)}</td><td class="num"><button type="button" class="btn sm quiet" data-act="alias-del" data-i="${i}">Remove</button></td></tr>`).join('') + '</tbody></table>' : empty('No aliases yet.');
  }

  /* ---------- Actions ---------- */
  function addAlias(old, nw) {
    const msg = $('alMsg'), set = t => { if (msg) msg.textContent = t; };
    old = (old || '').trim(); nw = (nw || '').trim();
    if (!old || !nw) return set('Enter both SKUs.');
    if (!S.ref.prod.has(nw)) return set(`${nw} isn't in products. Pick a current SKU.`);
    editRows('aliases', r => { const i = r.findIndex(a => a.old_sku.toUpperCase() === old.toUpperCase()); const row = { old_sku: old, new_sku: nw, notes: 'Added in the planner' }; if (i >= 0) r[i] = row; else r.push(row); });
    renderCurrent();
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
      const out = [...S.inv[k]].filter(([, x]) => (x.newN !== undefined ? x.newN : x.n) != null).sort((a, b) => a[0].localeCompare(b[0])).map(([id, x]) => ({ [key]: id, [val]: x.newN !== undefined ? x.newN : x.n, counted_at: x.counted_at || t, notes: '' }));
      if (k === 'built') for (const l of (S.builtNotes || {}).legacy || []) out.push({ sku: l.from, on_hand: l.qty, counted_at: t, notes: 'Legacy SKU' });
      download(CSVNAME[k], C.toCSV([key, val, 'counted_at', 'notes'], out));
    },
    'reset-src': b => { const k = b.dataset.kind; store.del('src.' + k); S.local[k] = null; if (k === 'built' || k === 'cubes') { S.log = S.log.filter(e => e.kind !== k); store.set('log', S.log); } delete S.srcErr[k]; recompute(); renderCurrent(); },
    'inv-del': b => { S.log.splice(+b.dataset.i, 1); store.set('log', S.log); recompute(); renderInventory(); },
    jump: b => { const el = $(b.dataset.to); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    'po-pick': b => { S.ui.poSel = b.dataset.po; renderPOs(); },
    'alias-from': b => { $('alOld').value = b.dataset.sku; $('alNew').focus(); },
    'alias-add': () => addAlias($('alOld').value, $('alNew').value),
    'alias-do': b => addAlias(b.dataset.old, b.dataset.new),
    'alias-del': b => { editRows('aliases', r => r.splice(+b.dataset.i, 1)); renderCurrent(); },
    exclude: b => { const sku = b.dataset.sku; editRows('products', r => { if (!r.some(p => p.sku === sku)) r.push({ sku, product_name: '', product_type: 'Other', flavor_code: '', flavor_name: '', flavor_category: '', label_code: '', cap_color: '', cubes_per_unit: '', case_sku: '', case_qty: '', include_in_plan: 'N', active: 'Y', notes: 'Left out of the cube plan' }); }); renderCurrent(); },
    include: b => { const sku = b.dataset.sku; editRows('products', r => r.forEach(p => { if (p.sku === sku) p.include_in_plan = 'Y'; })); renderCurrent(); },
    'prod-more': () => { S.ui.prodMore += 100; renderProducts(); },
    'comp-more': () => { S.ui.compMore += 200; renderComponents(); },
    'prod-add': () => {
      const sku = $('npSku').value.trim(), m = $('npMsg');
      if (!sku) { m.textContent = 'Enter a SKU.'; return; }
      if (S.ref.prod.has(sku)) { m.textContent = `${sku} is already in products.`; return; }
      editRows('products', r => r.unshift({ sku, product_name: $('npName').value.trim(), product_type: $('npType').value, flavor_code: $('npFlav').value.trim(), flavor_name: '', flavor_category: '', label_code: '', cap_color: '', cubes_per_unit: $('npCpu').value, case_sku: '', case_qty: '', include_in_plan: 'Y', active: 'Y', notes: '' }));
      renderCurrent();
    },
    'comp-add': () => {
      const kit = $('ncKit').value.trim(), label = $('ncLabel').value.trim(), m = $('ncMsg');
      if (!kit || !label) { m.textContent = 'Enter a kit and a label code.'; return; }
      if (!C.labelParts(label)) { m.textContent = 'Label codes look like LM001-GC.'; return; }
      editRows('components', r => r.push({ parent_sku: kit, mini_sku: '', label_code: label, qty: $('ncQty').value || '1', notes: '' }));
      renderCurrent();
    },
    'comp-del': b => { editRows('components', r => r.splice(+b.dataset.i, 1)); renderCurrent(); },
    'rule-add': () => { const r = curRules(); r.age_rules.push({ min_age: 7, window: 3 }); saveRules(r); renderRules(); },
    'rule-del': b => { const r = curRules(); r.age_rules.splice(+b.dataset.i, 1); if (!r.age_rules.length) r.age_rules.push({ min_age: 0, window: 3 }); saveRules(r); renderRules(); },
    'rules-reset': () => { store.del('rules'); recompute(); renderRules(); },
    'rules-dl': () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(S.rules, null, 2) + '\n'], { type: 'application/json' })); a.download = 'rules.json'; a.click(); }
  };
  const CHG = {
    inv: inp => applyCount(inp),
    prod: inp => { const f = inp.dataset.f, sku = inp.dataset.sku; editRows('products', r => { const p = r.find(x => x.sku === sku); if (p) p[f] = inp.type === 'checkbox' ? (inp.checked ? 'Y' : 'N') : inp.value.trim(); }); renderSources(); },
    comp: inp => { const f = inp.dataset.f, i = +inp.dataset.i; editRows('components', r => { if (r[i]) { r[i][f] = inp.value.trim(); if (f === 'label_code') r[i].mini_sku = ''; } }); renderSources(); const cell = inp.closest('tr').children[2]; if (cell && f === 'label_code') { const m = C.miniSkuFor(inp.value.trim(), ''); cell.innerHTML = `<span class="sku">${esc(m)}</span>`; } },
    flav: inp => { const code = inp.dataset.code, f = inp.dataset.f || 'flavor_name'; editRows('flavors', r => { let x = r.find(y => y.flavor_code === code); if (!x) { x = { flavor_code: code, flavor_name: '', notes: '', same_recipe_as: '' }; r.push(x); } x[f] = inp.value.trim(); }); renderSources(); if (f === 'same_recipe_as') setTimeout(renderCurrent, 0); },
    poStock: inp => { S.ui.poStock = inp.checked; renderPOs(); },
    setting: inp => {
      const r = curRules(), path = inp.dataset.key.split('.'), last = path.pop(); let o = r; path.forEach(k => { o = o[k]; });
      o[last] = inp.type === 'number' ? Math.max(last === 'batch_cubes' ? 1 : 0, parseInt(inp.value, 10) || (last === 'batch_cubes' ? 200 : 0)) : inp.value.trim();
      saveRules(r); setTimeout(renderRules, 0);   // redraw after the field loses focus, or the browser throws
    },
    rule: inp => { const r = curRules(), i = +inp.dataset.i, f = inp.dataset.f; r.age_rules[i][f] = Math.max(0, parseInt(inp.value, 10) || 0); saveRules(r); setTimeout(renderRules, 0); }
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
  document.addEventListener('toggle', e => { const d = e.target; if (d && d.dataset && d.dataset.rv) S.ui.rv[d.dataset.rv] = d.open; }, true);   // remember which review sections are open
  document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr[data-act="po-pick"]')) { e.preventDefault(); e.target.click(); } });

  const PAGES = ['plan', 'kits', 'pos', 'inventory', 'review', 'data'], DRAW = { plan: renderPlan, kits: renderKits, pos: renderPOs, inventory: renderInventory, review: renderReview, data: renderData };
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
