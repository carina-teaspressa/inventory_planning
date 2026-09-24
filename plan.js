const $ = id => document.getElementById(id);
const FALLBACK = 'https://raw.githubusercontent.com/carina-teaspressa/inventory_planning/Test_expansion/';
const FILES = ['data/products.csv', 'data/product_components.csv', 'data/minis.csv', 'data/open_orders.json'];
const S = { ref: null, orders: null, result: null, src: '' };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = v => Number(v).toLocaleString();

async function fetchAll(base) {
  return Promise.all(FILES.map(async f => {
    const r = await fetch(base + f, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${f} returned ${r.status}`);
    return f.endsWith('.json') ? r.json() : r.text();
  }));
}

async function load() {
  let data;
  try { data = await fetchAll(''); S.src = 'this site'; }
  catch (e) {
    try { data = await fetchAll(FALLBACK); S.src = 'the Test_expansion branch on GitHub'; }
    catch (e2) {
      $('source').textContent = '';
      $('err').textContent = `Couldn't load the data files (${e2.message}). Check that the data folder has products.csv, product_components.csv, minis.csv and open_orders.json.`;
      return;
    }
  }
  const [p, c, m, o] = data;
  S.ref = PlanCore.build({ products: PlanCore.parseCSV(p), components: PlanCore.parseCSV(c), minis: PlanCore.parseCSV(m) });
  S.orders = o;
  const when = new Date(o.pulled_at).toLocaleString('en-US', { timeZone: 'America/Phoenix', dateStyle: 'medium', timeStyle: 'short' });
  $('source').textContent = `Open orders pulled ${when} Arizona time, read from ${S.src}.`;
  $('app').hidden = false; $('csvBtn').disabled = false;
  render();
}

function opts() {
  const statuses = new Set([...document.querySelectorAll('.st:checked')].map(x => x.value));
  const age = $('age').value;
  return { statuses, maxAgeDays: age ? +age : null, group: $('group').value,
           today: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' }) };
}

function capClass(c) { c = (c || '').toLowerCase(); return ['rust', 'green', 'cream'].includes(c) ? c : 'none'; }

function planTable(rows, q) {
  const f = q ? rows.filter(r => (r.name + ' ' + r.lm_code).toLowerCase().includes(q)) : rows;
  if (!f.length) return `<p class="empty">${q ? 'No flavors match that search.' : 'Nothing to make for these filters.'}</p>`;
  return `<div class="tablewrap"><table><thead><tr>
      <th>Flavor</th><th>Category</th><th class="num">Tubes</th><th class="num">Labels</th><th class="num">Cubes</th>
      <th class="num">In kits</th><th class="num">Sold alone</th></tr></thead><tbody>` +
    f.map(r => `<tr class="planrow">
      <td><div class="flavor"><span class="cap ${capClass(r.cap_color)}" title="${esc(r.cap_color || 'No cap color')} cap"></span>
        <div>${esc(r.name)}${r.rimmer ? '<span class="tag">Rimmer</span>' : ''}<div class="code">${esc(r.lm_code)}</div></div></div></td>
      <td>${esc(r.category_name || r.category)}</td>
      <td class="num big">${n(r.tubes)}</td><td class="num">${n(r.labels)}</td><td class="num">${n(r.cubes)}</td>
      <td class="num">${n(r.from_kits)}</td><td class="num">${n(r.from_singles)}</td></tr>`).join('') +
    '</tbody></table></div>';
}

function periodLabel(key, group) {
  const d = new Date(key + 'T00:00:00Z');
  const fmt = o => d.toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
  return group === 'week' ? `Week of ${fmt({ month: 'short', day: 'numeric', year: 'numeric' })}` : fmt({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function render() {
  const o = opts();
  const R = S.result = PlanCore.plan(S.ref, S.orders.lines, o);
  const t = R.totals, q = $('q').value.trim().toLowerCase();

  $('tally').innerHTML = [
    ['lead', t.miniTubes, 'Mini tubes to make'],
    ['', t.rimmerTubes, 'Rimmer tubes'],
    ['', t.labels, 'Labels'],
    ['', t.cubes, 'Cubes'],
    ['', t.orders, `Orders (${n(t.lines)} lines)`]
  ].map(([c, v, l]) => `<div class="${c}"><b>${n(v)}</b><span>${l}</span></div>`).join('');

  const shortKits = t.kitsOrdered - t.kitsCounted;
  const w = [];
  if (shortKits) w.push(`<b>${n(shortKits)} of ${n(t.kitsOrdered)} kits</b> are missing some or all of their contents, so their tubes aren't fully counted. See the kits table.`);
  if (t.unmappedUnits) w.push(`<b>${n(t.unmappedUnits)} units</b> on order use SKUs the plan doesn't recognize yet.`);
  $('warn').innerHTML = w.join('<br>'); $('warn').hidden = !w.length;

  $('plan').innerHTML = o.group === 'total' ? planTable(R.totalRows, q) :
    (R.groups.length ? R.groups.slice().reverse().map((g, i) => {
      const tubes = g.rows.reduce((s, r) => s + r.tubes, 0);
      return `<details class="period"${i === 0 ? ' open' : ''}><summary><span class="lbl">${periodLabel(g.key, o.group)}</span>
        <span class="cnt">${n(tubes)} tubes</span></summary>${planTable(g.rows, q)}</details>`;
    }).join('') : '<p class="empty">Nothing to make for these filters.</p>');

  $('kits').innerHTML = R.kits.length ? '<thead><tr><th>Kit</th><th class="num">Kits ordered</th><th>Status</th></tr></thead><tbody>' +
    R.kits.map(k => `<tr><td>${esc(k.sku)}<div class="code">${esc(k.name)}</div></td><td class="num">${n(k.kits)}</td>
      <td><span class="status ${k.status === 'Counted' ? 'ok' : 'bad'}">${esc(k.status)}</span></td></tr>`).join('') + '</tbody>'
    : '<tbody><tr><td class="empty">No kits on these orders.</td></tr></tbody>';

  $('unmapped').innerHTML = R.unmapped.length ? '<thead><tr><th>SKU</th><th class="num">Lines</th><th class="num">Units</th><th>Why</th></tr></thead><tbody>' +
    R.unmapped.map(u => `<tr><td>${esc(u.sku)}</td><td class="num">${n(u.lines)}</td><td class="num">${n(u.units)}</td><td class="code">${esc(u.reason)}</td></tr>`).join('') + '</tbody>'
    : '<tbody><tr><td class="empty">Every SKU on these orders is counted.</td></tr></tbody>';
}

function downloadCSV() {
  const R = S.result, g = $('group').value;
  const head = ['period', 'lm_code', 'flavor', 'category', 'cap_color', 'tubes', 'labels', 'cubes', 'in_kits', 'sold_alone'];
  const rows = (g === 'total' ? [{ key: 'all open orders', rows: R.totalRows }] : R.groups)
    .flatMap(p => p.rows.map(r => [p.key, r.lm_code, r.name, r.category, r.cap_color, r.tubes, r.labels, r.cubes, r.from_kits, r.from_singles]));
  const csv = [head, ...rows].map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: `mini-plan-${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' })}.csv`
  });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

['group', 'age'].forEach(id => $(id).addEventListener('change', render));
document.querySelectorAll('.st').forEach(x => x.addEventListener('change', render));
$('q').addEventListener('input', render);
$('csvBtn').addEventListener('click', downloadCSV);
load();
