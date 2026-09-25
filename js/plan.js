const $ = id => document.getElementById(id);
const FALLBACK = 'https://raw.githubusercontent.com/carina-teaspressa/inventory_planning/main/';
const REF_FILES = ['data/csv/products.csv', 'data/csv/product_components.csv', 'data/csv/minis.csv', 'data/json/open_orders.json'];
const OPTIONAL = ['data/csv/po_lines.csv', 'data/csv/inventory.csv', 'data/csv/sku_aliases.csv'];   // a missing file just means "none yet"
const KEY = { orders: 'ip.orders', po: 'ip.po', inv: 'ip.inventory', log: 'ip.inventoryLog' };
const S = { ref: null, minis: [], repo: {}, local: {}, log: [], inv: new Map(), result: null, src: '', pick: null };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = v => Number(v).toLocaleString();
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
const stamp = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/* ---------- Browser storage (may be blocked or full) ---------- */
const store = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { } }
};
function save(k, v) {
  if (!store.set(k, v)) { $('err').textContent = "This browser didn't save the change (storage is full or blocked). It will work until you reload."; return false; }
  return true;
}

/* ---------- Loading ---------- */
async function fetchFrom(base, files, optional) {
  return Promise.all(files.map(async f => {
    const r = await fetch(base + f, { cache: 'no-store' });
    if (!r.ok) { if (optional) return null; throw new Error(`${f} returned ${r.status}`); }
    return f.endsWith('.json') ? r.json() : r.text();
  }));
}

async function load() {
  let base = '', data;
  try { data = await fetchFrom('', REF_FILES); S.src = 'this site'; }
  catch (e) {
    try { base = FALLBACK; data = await fetchFrom(base, REF_FILES); S.src = 'the main branch on GitHub'; }
    catch (e2) {
      $('source').textContent = '';
      $('err').textContent = `Couldn't load the data files (${e2.message}). Check that data/csv has products.csv, product_components.csv and minis.csv, and data/json has open_orders.json.`;
      return;
    }
  }
  const [p, c, m, o] = data;
  const [poText, invText, aliasText] = await fetchFrom(base, OPTIONAL, true);
  S.minis = PlanCore.parseCSV(m);
  S.ref = PlanCore.build({ products: PlanCore.parseCSV(p), components: PlanCore.parseCSV(c), minis: S.minis,
                          aliases: aliasText ? PlanCore.parseCSV(aliasText) : [] });
  const po = poText ? PlanCore.readPO(poText) : { rows: [] };
  const inv = invText ? PlanCore.readInventory(invText) : { rows: [] };
  S.repo = {
    orders: { rows: o.lines, at: o.pulled_at },
    po: { rows: po.rows || [], missing: !poText, error: po.error },
    inv: { rows: inv.rows || [], missing: !invText, error: inv.error }
  };
  S.local = { orders: store.get(KEY.orders), po: store.get(KEY.po), inv: store.get(KEY.inv) };
  S.log = store.get(KEY.log) || [];
  $('source').textContent = `Reference data read from ${S.src}.`;
  $('app').hidden = false; $('csvBtn').disabled = false;
  renderSources(); render();
}

const active = kind => S.local[kind] ? S.local[kind].rows : S.repo[kind].rows;

/* ---------- Data sources panel ---------- */
const SOURCES = {
  orders: { title: 'Open orders', file: 'open_orders', blurb: 'ShipStation lines. The repo file refreshes every morning. Only order number, date, status, SKU and qty are kept from an upload.' },
  po: { title: 'PO lines', file: 'po_lines', blurb: 'Retailer POs and allocations, in finished units. A line with replaces_shipstation removes matching ShipStation lines for that SKU.' },
  inv: { title: 'On-hand inventory', file: 'inventory', blurb: 'Mini tube counts by LM code. Blank means not counted yet.' }
};

function sourceState(kind) {
  const L = S.local[kind], R = S.repo[kind], count = active(kind).length;
  const noun = kind === 'inv' ? (count === 1 ? 'flavor' : 'flavors') : (count === 1 ? 'line' : 'lines');
  if (L) return `Using ${esc(L.name)}, uploaded ${stamp(L.at)} in this browser. ${n(count)} ${noun}.`;
  if (R.error) return `<span class="bad">The repo file has a problem: ${esc(R.error)}</span>`;
  if (R.missing) return `No repo file yet. Upload one to start.`;
  return kind === 'orders' ? `Repo file, pulled ${stamp(R.at)} Arizona time. ${n(count)} ${noun}.` : `Repo file. ${n(count)} ${noun}.`;
}

function renderSources() {
  $('sources').innerHTML = Object.entries(SOURCES).map(([kind, s]) => {
    const edits = kind === 'inv' && S.log.length ? `<p class="state">${n(S.log.length)} edit${S.log.length > 1 ? 's' : ''} made in this browser.</p>` : '';
    return `<div class="source" data-kind="${kind}">
      <h3>${s.title}</h3>
      <p class="note">${s.blurb}</p>
      <p class="state">${sourceState(kind)}</p>${edits}
      <div class="btns">
        <button class="btn" data-act="upload">Upload CSV</button>
        ${kind === 'inv' ? '<button class="btn ghost" data-act="edit">Edit counts</button>' : ''}
        <button class="btn ghost" data-act="download">Download current</button>
        <button class="linkbtn" data-act="template">Blank template</button>
        ${S.local[kind] || (kind === 'inv' && S.log.length) ? '<button class="linkbtn" data-act="reset">Go back to repo file</button>' : ''}
      </div>
      <div class="err small" data-err></div>
    </div>`;
  }).join('');
}

$('sources').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const kind = b.closest('.source').dataset.kind, act = b.dataset.act;
  if (act === 'upload') { S.pick = kind; $('fileIn').value = ''; $('fileIn').click(); }
  if (act === 'edit') openEditor();
  if (act === 'download') downloadData(kind);
  if (act === 'template') download(`${SOURCES[kind].file}_template.csv`, PlanCore.toCSV(fileHeaders(kind), []));
  if (act === 'reset') resetSource(kind);
});

const fileHeaders = kind => PlanCore.FILES[kind === 'inv' ? 'inventory' : kind].headers;

$('fileIn').addEventListener('change', async () => {
  const f = $('fileIn').files[0], kind = S.pick; if (!f || !kind) return;
  const box = document.querySelector(`.source[data-kind="${kind}"] [data-err]`);
  const text = await f.text();
  const res = kind === 'orders' ? PlanCore.readOrders(text) : kind === 'po' ? PlanCore.readPO(text) : PlanCore.readInventory(text);
  if (res.error) { box.textContent = `${f.name}: ${res.error}`; return; }
  if (kind === 'inv' && S.log.length && !confirm(`Replace inventory with ${f.name}? This also clears the ${S.log.length} edit(s) made in this browser.`)) return;
  const entry = { name: f.name, at: new Date().toISOString(), rows: res.rows };
  if (!save(KEY[kind], entry)) return;
  S.local[kind] = entry;
  if (kind === 'inv') { S.log = []; store.del(KEY.log); }
  $('err').textContent = '';
  renderSources(); render(); if (!$('invEditor').hidden) renderEditor();
});

function resetSource(kind) {
  const what = kind === 'inv' ? 'the uploaded inventory file and every inventory edit made in this browser' : `the uploaded ${SOURCES[kind].title.toLowerCase()} file`;
  if (!confirm(`Remove ${what} and go back to the repo file?`)) return;
  store.del(KEY[kind]); S.local[kind] = null;
  if (kind === 'inv') { store.del(KEY.log); S.log = []; }
  renderSources(); render(); if (!$('invEditor').hidden) renderEditor();
}

function downloadData(kind) {
  const d = today();
  if (kind === 'orders') return download(`open_orders_${d}.csv`, PlanCore.toCSV(fileHeaders(kind), active('orders')));
  if (kind === 'po') return download(`po_lines_${d}.csv`, PlanCore.toCSV(fileHeaders(kind), active('po')));
  const rows = [...currentInventory()].map(([lm_code, x]) => ({ lm_code, on_hand: x.on_hand ?? '', counted_at: x.counted_at, notes: x.notes }))
    .sort((a, b) => a.lm_code.localeCompare(b.lm_code));
  download(`inventory_${d}.csv`, PlanCore.toCSV(fileHeaders(kind), rows));
}

function download(name, text) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: name });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- Inventory editor ---------- */
const currentInventory = () => PlanCore.inventoryNow(active('inv'), S.log);

function openEditor() { $('invEditor').hidden = false; renderEditor(); $('invEditor').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('invQ').focus(); }
$('invClose').addEventListener('click', () => { $('invEditor').hidden = true; });

function renderEditor() {
  const inv = currentInventory(), q = $('invQ').value.trim().toLowerCase();
  const need = new Map((S.result?.totalRows || []).map(r => [r.lm_code, r.tubes]));
  const codes = new Map(S.minis.map(m => [m.lm_code, m.name]));
  const cat = lm => (S.ref.mini.get(lm) || {}).category_name || '';
  inv.forEach((_, lm) => { if (!codes.has(lm)) codes.set(lm, '(not in minis.csv)'); });
  let list = [...codes].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  if ($('invNeeded').checked) list = list.filter(([lm]) => need.has(lm));
  if (q) list = list.filter(([lm, name]) => (lm + ' ' + name).toLowerCase().includes(q));
  $('invTable').innerHTML = list.length ? `<thead><tr><th>Flavor</th><th class="num">On order</th><th class="num">On hand</th><th>Change by</th><th>Note</th><th></th></tr></thead><tbody>` +
    list.map(([lm, name]) => {
      const x = inv.get(lm), oh = x ? x.on_hand : null;
      return `<tr data-lm="${esc(lm)}">
        <td>${esc(name)}<div class="code">${esc(lm)}${cat(lm) ? ` ${esc(cat(lm))}` : ''}${x?.edits ? ' <span class="tag">edited</span>' : ''}</div></td>
        <td class="num">${need.has(lm) ? n(need.get(lm)) : ''}</td>
        <td class="num"><input class="qty" type="number" min="0" step="1" inputmode="numeric" value="${oh ?? ''}" placeholder="Blank" aria-label="On hand for ${esc(name)}"></td>
        <td><input class="delta" type="number" step="1" inputmode="numeric" placeholder="+/−" aria-label="Change on hand for ${esc(name)}"></td>
        <td><input class="memo" type="text" placeholder="Reason (optional)" aria-label="Note for ${esc(name)}"></td>
        <td><button class="btn ghost sm" data-act="adjust">Add change</button></td></tr>`;
    }).join('') + '</tbody>' : '<tbody><tr><td class="empty">No flavors match.</td></tr></tbody>';
  renderLog();
}

function addLog(entry) {
  const next = [...S.log, { ...entry, at: new Date().toISOString() }];
  if (!save(KEY.log, next)) return;
  S.log = next; renderSources(); render(); renderLog();
  const row = document.querySelector(`#invTable tr[data-lm="${CSS.escape(entry.lm_code)}"]`);
  if (row) {
    const x = currentInventory().get(entry.lm_code);
    row.querySelector('.qty').value = x.on_hand ?? '';
    row.querySelector('.delta').value = ''; row.querySelector('.memo').value = '';
    const code = row.querySelector('.code'); if (!code.querySelector('.tag')) code.insertAdjacentHTML('beforeend', ' <span class="tag">edited</span>');
  }
}

$('invTable').addEventListener('change', e => {
  if (!e.target.classList.contains('qty')) return;
  const row = e.target.closest('tr'), lm = row.dataset.lm, v = e.target.value.trim();
  const now = currentInventory().get(lm)?.on_hand ?? null;
  const qty = v === '' ? null : Math.round(Number(v));
  if (qty !== null && (!Number.isFinite(qty) || qty < 0)) { e.target.value = now ?? ''; return; }
  if (qty === now) return;
  addLog({ type: 'set', lm_code: lm, qty, note: row.querySelector('.memo').value.trim() });
});
$('invTable').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('delta')) e.target.closest('tr').querySelector('[data-act="adjust"]').click();
});
$('invTable').addEventListener('click', e => {
  const b = e.target.closest('[data-act="adjust"]'); if (!b) return;
  const row = b.closest('tr'), d = Math.round(Number(row.querySelector('.delta').value));
  if (!d) { row.querySelector('.delta').focus(); return; }
  addLog({ type: 'adjust', lm_code: row.dataset.lm, qty: d, note: row.querySelector('.memo').value.trim() });
});

function renderLog() {
  if (!S.log.length) { $('invLog').innerHTML = '<p class="empty">No edits yet.</p>'; return; }
  const name = lm => (S.ref.mini.get(lm) || {}).name || lm;
  $('invLog').innerHTML = '<ul class="log">' + S.log.map((e, i) => [e, i]).reverse().map(([e, i]) => `<li>
      <span class="when">${stamp(e.at)}</span>
      <span class="what"><b>${esc(name(e.lm_code))}</b> ${e.type === 'set' ? (e.qty === null ? 'marked not counted' : `count set to ${n(e.qty)}`) : `${e.qty > 0 ? '+' : ''}${n(e.qty)}`}${e.note ? ` <span class="code">${esc(e.note)}</span>` : ''}</span>
      <button class="linkbtn" data-undo="${i}">Undo</button></li>`).join('') + '</ul>';
}
$('invLog').addEventListener('click', e => {
  const b = e.target.closest('[data-undo]'); if (!b) return;
  const next = S.log.filter((_, i) => i !== +b.dataset.undo);
  if (!save(KEY.log, next)) return;
  S.log = next; renderSources(); render(); renderEditor();
});
['invQ', 'invNeeded'].forEach(id => $(id).addEventListener('input', renderEditor));

/* ---------- Plan ---------- */
function opts() {
  return {
    statuses: new Set([...document.querySelectorAll('.st:checked')].map(x => x.value)),
    maxAgeDays: $('age').value ? +$('age').value : null, includePO: $('incPO').checked,
    group: $('group').value, today: today()
  };
}

function capClass(c) { c = (c || '').toLowerCase(); return ['rust', 'green', 'cream'].includes(c) ? c : 'none'; }

const flavorCell = r => `<td><div class="flavor"><span class="cap ${capClass(r.cap_color)}" title="${esc(r.cap_color || 'No cap color')} cap"></span>
  <div>${esc(r.name)}${r.rimmer ? '<span class="tag">Rimmer</span>' : ''}<div class="code">${esc(r.lm_code)}</div></div></div></td>`;

function coverCell(r, windows, t) {
  if (!r.counted) return '<td><span class="status bad">Not counted</span></td>';
  if (r.short === 0) return '<td><span class="status ok">Covered</span></td>';
  if (r.covered_through < 0) return '<td><span class="status bad">Short now</span></td>';
  return `<td><span class="status mid">Through ${esc(PlanCore.windowLabel(r.covered_through, t).replace('Now: ', ''))}</span></td>`;
}

function filterRows(rows, q) { return q ? rows.filter(r => (r.name + ' ' + r.lm_code).toLowerCase().includes(q)) : rows; }
const emptyMsg = q => `<p class="empty">${q ? 'No flavors match that search.' : 'Nothing to make for these filters.'}</p>`;

function windowTable(rows, windows, q, t) {
  const f = filterRows(rows, q); if (!f.length) return emptyMsg(q);
  return `<div class="tablewrap"><table class="wtable"><thead><tr><th>Flavor</th>
      ${windows.map(w => `<th class="num${w === 0 ? ' now' : ''}">${esc(PlanCore.windowLabel(w, t))}</th>`).join('')}
      <th class="num">Total</th><th class="num">On hand</th><th class="num">Short</th><th>Covered</th></tr></thead><tbody>` +
    f.map(r => `<tr class="planrow">${flavorCell(r)}
      ${r.need.map((v, i) => `<td class="num${i === 0 ? ' now big' : ''}">${v ? n(v) : ''}</td>`).join('')}
      <td class="num">${n(r.tubes)}</td><td class="num">${r.counted ? n(r.on_hand) : '—'}</td>
      <td class="num${r.short ? ' shortv' : ''}">${r.short ? n(r.short) : ''}</td>${coverCell(r, windows, t)}</tr>`).join('') +
    '</tbody></table></div>';
}

function planTable(rows, q) {
  const f = filterRows(rows, q); if (!f.length) return emptyMsg(q);
  return `<div class="tablewrap"><table><thead><tr>
      <th>Flavor</th><th>Category</th><th class="num">Tubes</th><th class="num">Labels</th><th class="num">Cubes</th>
      <th class="num">In kits</th><th class="num">Sold alone</th><th class="num">On hand</th><th class="num">Short</th></tr></thead><tbody>` +
    f.map(r => `<tr class="planrow">${flavorCell(r)}
      <td>${esc(r.category_name || r.category)}</td>
      <td class="num big">${n(r.tubes)}</td><td class="num">${n(r.labels)}</td><td class="num">${n(r.cubes)}</td>
      <td class="num">${n(r.from_kits)}</td><td class="num">${n(r.from_singles)}</td>
      <td class="num">${r.counted ? n(r.on_hand) : '—'}</td><td class="num${r.short ? ' shortv' : ''}">${r.short ? n(r.short) : ''}</td></tr>`).join('') +
    '</tbody></table></div>';
}

function periodLabel(key, group) {
  const d = new Date(key + 'T00:00:00Z');
  const fmt = o => d.toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
  return group === 'week' ? `Week of ${fmt({ month: 'short', day: 'numeric', year: 'numeric' })}` : fmt({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function render() {
  const o = opts();
  S.inv = currentInventory();
  const D = PlanCore.demand(S.ref, active('orders'), active('po'), o);
  const R = S.result = PlanCore.plan(S.ref, D.lines, { group: o.group, today: o.today, inventory: S.inv });
  const t = R.totals, q = $('q').value.trim().toLowerCase();

  $('tally').innerHTML = [
    ['lead', t.miniTubes, 'Mini tubes on order'],
    ['', t.rimmerTubes, 'Rimmer tubes'],
    ['flag', t.shortNow, 'Short this week'],
    ['', t.short, 'Short in total'],
    ['', t.cubes, 'Cubes'],
    ['', t.orders, `Orders and POs (${n(t.lines)} lines)`]
  ].map(([c, v, l]) => `<div class="${c}"><b>${n(v)}</b><span>${l}</span></div>`).join('');

  const shortKits = t.kitsOrdered - t.kitsCounted, w = [];
  if (shortKits) w.push(`<b>${n(shortKits)} of ${n(t.kitsOrdered)} kits</b> are missing some or all of their contents, so their tubes aren't fully counted. See the kits table.`);
  if (t.unmappedUnits) w.push(`<b>${n(t.unmappedUnits)} units</b> on order use SKUs the plan doesn't recognize yet.`);
  if (t.notCounted) w.push(`<b>${n(t.notCounted)} flavors</b> on order have no inventory count, so their full need shows as short.`);
  if (D.renamed.lines) w.push(`${n(D.renamed.lines)} order lines (${n(D.renamed.units)} units) use an old SKU or a sample SKU and are counted as the current product.`);
  if (D.replaced.lines) w.push(`${n(D.replaced.lines)} ShipStation lines (${n(D.replaced.units)} units) are replaced by PO lines and not counted twice.`);
  $('warn').innerHTML = w.join('<br>'); $('warn').hidden = !w.length;

  $('planNote').textContent = o.group === 'window'
    ? 'Each week is when to make the tubes. ShipStation orders are placed by age: 60+ days old this week, 30–59 next week, 14–29 in two weeks, newer in three. PO lines land the week before their commit date (or earlier, by their lead weeks). Rimmers hold 0 cubes.'
    : 'One tube and one label per Mini. Minis hold 6 cubes; Rimmers hold 0.';

  if (o.group === 'window') $('plan').innerHTML = windowTable(R.totalRows, R.windows, q, o.today);
  else if (o.group === 'total') $('plan').innerHTML = planTable(R.totalRows, q);
  else $('plan').innerHTML = R.groups.length ? R.groups.slice().reverse().map((g, i) => {
    const tubes = g.rows.reduce((s, r) => s + r.tubes, 0);
    return `<details class="period"${i === 0 ? ' open' : ''}><summary><span class="lbl">${periodLabel(g.key, o.group)}</span>
      <span class="cnt">${n(tubes)} tubes</span></summary>${planTable(g.rows, q)}</details>`;
  }).join('') : emptyMsg('');

  $('kits').innerHTML = R.kits.length ? '<thead><tr><th>Kit</th><th class="num">Kits</th><th class="num">From POs</th><th>Status</th></tr></thead><tbody>' +
    R.kits.map(k => `<tr><td>${esc(k.sku)}<div class="code">${esc(k.name)}</div></td><td class="num">${n(k.kits)}</td><td class="num">${k.po ? n(k.po) : ''}</td>
      <td><span class="status ${k.status === 'Counted' ? 'ok' : 'bad'}">${esc(k.status)}</span></td></tr>`).join('') + '</tbody>'
    : '<tbody><tr><td class="empty">No kits on these orders.</td></tr></tbody>';

  $('unmapped').innerHTML = R.unmapped.length ? '<thead><tr><th>SKU</th><th class="num">Lines</th><th class="num">Units</th><th>Why</th></tr></thead><tbody>' +
    R.unmapped.map(u => `<tr><td>${esc(u.sku)}</td><td class="num">${n(u.lines)}</td><td class="num">${n(u.units)}</td><td class="code">${esc(u.reason)}</td></tr>`).join('') + '</tbody>'
    : '<tbody><tr><td class="empty">Every SKU on these orders is counted.</td></tr></tbody>';
}

function downloadCSV() {
  const R = S.result, g = $('group').value, t = today();
  if (g === 'window') {
    const labels = R.windows.map(w => PlanCore.windowLabel(w, t));
    const head = ['lm_code', 'flavor', 'category', ...labels, 'total', 'on_hand', 'short'];
    const rows = R.totalRows.map(r => Object.fromEntries([['lm_code', r.lm_code], ['flavor', r.name], ['category', r.category],
      ...labels.map((l, i) => [l, r.need[i] || 0]), ['total', r.tubes], ['on_hand', r.on_hand ?? ''], ['short', r.short]]));
    return download(`mini-plan-${t}.csv`, PlanCore.toCSV(head, rows));
  }
  const head = ['period', 'lm_code', 'flavor', 'category', 'cap_color', 'tubes', 'labels', 'cubes', 'in_kits', 'sold_alone', 'on_hand', 'short'];
  const rows = (g === 'total' ? [{ key: 'all demand', rows: R.totalRows }] : R.groups).flatMap(p => p.rows.map(r => ({
    period: p.key, lm_code: r.lm_code, flavor: r.name, category: r.category, cap_color: r.cap_color, tubes: r.tubes, labels: r.labels,
    cubes: r.cubes, in_kits: r.from_kits, sold_alone: r.from_singles, on_hand: r.on_hand ?? '', short: r.short })));
  download(`mini-plan-${t}.csv`, PlanCore.toCSV(head, rows));
}

['group', 'age', 'incPO'].forEach(id => $(id).addEventListener('change', render));
document.querySelectorAll('.st').forEach(x => x.addEventListener('change', render));
$('q').addEventListener('input', render);
$('csvBtn').addEventListener('click', downloadCSV);
load();
