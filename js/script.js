const $ = id => document.getElementById(id);
const S = { headers: [], rows: [], types: {}, sortCol: null, sortDir: 1, page: 0, q: '', chart: null };
const PAGE = 25;
const PALETTE = ['#1f7a5c', '#e0a030', '#3b7dd8', '#c8553d', '#8a5cc2', '#2aa5a0', '#d1648f', '#7d8b3a', '#5b6b78', '#b5793e', '#4c9f70', '#a04a8f'];

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const delims = [',', ';', '\t', '|'];
  const d = delims.map(c => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const out = [];
  let row = [], f = '', q = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { f += '"'; i++; }
        else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.some(x => x !== '')) out.push(row);
      row = [];
    } else f += c;
  }
  row.push(f);
  if (row.some(x => x !== '')) out.push(row);
  return out;
}

const toNum = v => {
  if (v == null || v === '') return NaN;
  const s = String(v).trim().replace(/[$€£,%\s]/g, '');
  return /^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(s) ? parseFloat(s) : NaN;
};

const isDate = v => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(String(v).trim()) && !isNaN(Date.parse(v));

function load(text, name) {
  try {
    const t = parseCSV(text);
    if (t.length < 2) throw new Error('That file needs a header row and at least one data row.');
    let headers = t[0].map((h, i) => (h || '').trim() || ('Column ' + (i + 1)));
    const seen = {};
    headers = headers.map(h => { seen[h] = (seen[h] || 0) + 1; return seen[h] > 1 ? h + ' (' + seen[h] + ')' : h; });
    const rows = t.slice(1).map(r => { const o = {}; headers.forEach((h, i) => o[h] = (r[i] ?? '').trim()); return o; });

    S.headers = headers; S.rows = rows; S.types = {}; S.sortCol = null; S.page = 0; S.q = '';
    headers.forEach(h => {
      const vals = rows.map(r => r[h]).filter(v => v !== '');
      const n = vals.length || 1;
      const nums = vals.filter(v => !isNaN(toNum(v))).length;
      const dates = vals.filter(isDate).length;
      S.types[h] = nums / n >= .8 ? 'number' : dates / n >= .8 ? 'date' : 'text';
    });

    $('fileinfo').textContent = `${name} · ${rows.length.toLocaleString()} rows · ${headers.length} columns`;
    $('dropzone').hidden = true; $('dash').hidden = false; $('topbtns').hidden = false; $('err').textContent = '';
    setup();
  } catch (e) {
    $('err').textContent = e.message || 'Could not read that file.';
  }
}

function setup() {
  const H = S.headers, T = S.types;
  const cats = H.filter(h => T[h] !== 'number'), nums = H.filter(h => T[h] === 'number');
  const xs = cats.length ? cats : H;

  $('xSel').innerHTML = xs.concat(H.filter(h => !xs.includes(h))).map(h => `<option>${esc(h)}</option>`).join('');
  const dateCol = H.find(h => T[h] === 'date');
  const bestX = dateCol || H.find(h => T[h] === 'text' && uniq(h) <= Math.max(30, S.rows.length / 3)) || xs[0];
  $('xSel').value = bestX;
  $('mSel').innerHTML = '<option value="__count">Row count</option>' + nums.map(h => `<option>${esc(h)}</option>`).join('');
  $('mSel').value = nums[0] || '__count';
  $('aSel').value = nums.length ? 'sum' : 'count';

  syncType(true); render(); drawTable(); drawCols();
}

const uniq = h => new Set(S.rows.map(r => r[h])).size;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = v => isFinite(v) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, notation: Math.abs(v) >= 1e6 ? 'compact' : 'standard' }).format(v) : '–';

function syncType(reset) {
  const isD = S.types[$('xSel').value] === 'date';$('dateWrap').hidden = !isD;
  if (reset) $('tSel').value = isD ? 'line' : 'bar';
}

function groupData() {
  const x = $('xSel').value, m =$('mSel').value, agg = $('aSel').value, isD = S.types[x] === 'date', g =$('dateSel').value;
  const map = new Map();

  S.rows.forEach(r => {
    let k = r[x]; if (k === '') k = '(blank)';
    if (isD && k !== '(blank)') {
      const d = new Date(k);
      if (isNaN(d.getTime())) return;
      const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
      k = g === 'year' ? `${y}` : g === 'month' ? `${y}-${mo}` : `${y}-${mo}-${da}`;
    }
    const v = m === '__count' ? 1 : toNum(r[m]);
    if (!map.has(k)) map.set(k, []);
    if (m === '__count' || !isNaN(v)) map.get(k).push(v);
  });

  let arr = [...map].map(([k, vs]) => {
    let val = agg === 'count' ? vs.length : !vs.length ? 0 : agg === 'sum' ? vs.reduce((a, b) => a + b, 0) : agg === 'avg' ? vs.reduce((a, b) => a + b, 0) / vs.length : agg === 'max' ? Math.max(...vs) : Math.min(...vs);
    return { k, val };
  });

  if (isD) arr.sort((a, b) => a.k < b.k ? -1 : 1);
  else arr.sort((a, b) => b.val - a.val);

  return { arr, isD };
}

function render() {
  const { arr, isD } = groupData();
  const n = +$('nSel').value;
  const shown = isD ? arr.slice(-Math.max(n, 60)) : arr.slice(0, n);
  const m = $('mSel').value, agg =$('aSel').value;
  const label = (agg === 'count' || m === '__count') ? 'Rows' : `${agg[0].toUpperCase() + agg.slice(1)} of ${m}`;

  // KPIs
  const total = arr.reduce((a, b) => a + b.val, 0), top = [...arr].sort((a, b) => b.val - a.val)[0];
  const missing = S.rows.reduce((a, r) => a + S.headers.filter(h => r[h] === '').length, 0);
  $('kpis').innerHTML = [
    ['Rows', S.rows.length.toLocaleString()], ['Columns', S.headers.length],
    [agg === 'avg' ? 'Average of groups' : 'Total ' + (agg === 'count' ? 'rows' : label.toLowerCase()), fmt(agg === 'avg' ? total / (arr.length || 1) : total)],
    ['Top group ' + (top ? '· ' + fmt(top.val) : ''), top ? top.k : '–'], ['Groups', arr.length.toLocaleString()], ['Missing cells', missing.toLocaleString()]
  ].map(([l, v]) => `<div class="kpi"><b title="${esc(v)}">${esc(v)}</b><span>${esc(l)}</span></div>`).join('');

  // Chart
  if (S.chart) S.chart.destroy();
  const t = $('tSel').value, cs = getComputedStyle(document.documentElement);
  const ink = cs.getPropertyValue('--mute').trim() || '#666', grid = cs.getPropertyValue('--line').trim() || '#ddd';
  const round = t === 'doughnut';
  const type = t === 'horizontal' ? 'bar' : t;
  const isHoriz = t === 'horizontal';

  S.chart = new Chart($('chart'), {
    type,
    data: {
      labels: shown.map(d => d.k),
      datasets: [{
        label,
        data: shown.map(d => d.val),
        backgroundColor: round ? shown.map((_, i) => PALETTE[i % PALETTE.length]) : (t === 'line' ? PALETTE[0] + '33' : PALETTE[0]),
        borderColor: PALETTE[0],
        borderWidth: t === 'line' ? 2 : 0,
        fill: t === 'line',
        tension: .3,
        pointRadius: t === 'line' && shown.length > 40 ? 0 : 3,
        borderRadius: t === 'bar' || isHoriz ? 4 : 0
      }]
    },
    options: {
      indexAxis: isHoriz ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: round, position: 'right', labels: { color: ink } },
        tooltip: { callbacks: { label: c => ' ' + fmt(c.parsed.y ?? c.parsed.x ?? c.parsed) } }
      },
      scales: round ? {} : {
        x: {
          ticks: { color: ink, maxRotation: 45, autoSkip: true, callback: v => isHoriz && typeof v === 'number' ? fmt(v) : v },
          grid: { color: grid },
          title: { display: isHoriz, text: label, color: ink }
        },
        y: {
          ticks: { color: ink, callback: v => !isHoriz && typeof v === 'number' ? fmt(v) : v },
          grid: { color: grid },
          title: { display: !isHoriz, text: label, color: ink }
        }
      }
    }
  });
}

function drawCols() {
  $('cols').innerHTML = S.headers.map(h => {
    const miss = S.rows.filter(r => r[h] === '').length;
    return `<div class="col"><span>${esc(h)}</span><em>${S.types[h]} · ${uniq(h).toLocaleString()} unique${miss ? ' · ' + miss + ' blank' : ''}</em></div>`;
  }).join('');
}

function drawTable() {
  const q = S.q.toLowerCase();
  let rows = q ? S.rows.filter(r => S.headers.some(h => (r[h] || '').toLowerCase().includes(q))) : S.rows.slice();
  if (S.sortCol) {
    const h = S.sortCol, num = S.types[h] === 'number';
    rows.sort((a, b) => {
      const x = num ? toNum(a[h]) : a[h], y = num ? toNum(b[h]) : b[h];
      return (x > y ? 1 : x < y ? -1 : 0) * S.sortDir;
    });
  }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  S.page = Math.min(S.page, pages - 1);

  $('thead').innerHTML = '<tr>' + S.headers.map(h => `<th data-h="${esc(h)}">${esc(h)}${S.sortCol === h ? (S.sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>';
  $('tbody').innerHTML = rows.slice(S.page * PAGE, (S.page + 1) * PAGE).map(r => '<tr>' + S.headers.map(h => `<td title="${esc(r[h] ?? '')}">${esc(r[h] ?? '')}</td>`).join('') + '</tr>').join('');
  $('count').textContent = `${rows.length.toLocaleString()} rows · page ${S.page + 1} of ${pages}`;
  $('prev').disabled = S.page === 0;
  $('next').disabled = S.page >= pages - 1;
}

// Event Listeners
const fileIn = $('file'), dz =$('dropzone');
const readFile = f => {
  if (!f) return;
  const r = new FileReader();
  r.onload = () => load(r.result, f.name);
  r.onerror = () => $('err').textContent = 'Could not read that file.';
  r.readAsText(f);
};

$('pickBtn').onclick = e => { e.stopPropagation(); fileIn.click(); };
$('newBtn').onclick = () => {$('dash').hidden = true;
  dz.hidden = false;
  $('topbtns').hidden = true;
  $('fileinfo').textContent = 'Load a CSV to build a dashboard. Files stay in your browser.';
  fileIn.value = '';
};
dz.onclick = () => fileIn.click();
dz.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } };
fileIn.onchange = () => readFile(fileIn.files[0]);

['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => readFile(e.dataTransfer.files[0]));

window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  if (!dz.hidden) return;
  readFile(e.dataTransfer.files[0]);
});

$('xSel').onchange = () => { syncType(true); render(); };
['mSel', 'aSel', 'tSel', 'nSel', 'dateSel'].forEach(id => $(id).onchange = render);
$('q').oninput = e => { S.q = e.target.value; S.page = 0; drawTable(); };$('prev').onclick = () => { S.page--; drawTable(); };
$('next').onclick = () => { S.page++; drawTable(); };$('thead').onclick = e => {
  const h = e.target.closest('th')?.dataset.h;
  if (!h) return;
  S.sortDir = S.sortCol === h ? -S.sortDir : 1;
  S.sortCol = h;
  drawTable();
};

$('sampleBtn').onclick = e => {
  e.stopPropagation();
  const prods = ['Jasmine Green', 'Chai Latte Mix', 'Matcha Ceremonial', 'Earl Grey', 'Oat Milk Latte', 'Rooibos Vanilla'], ch = ['Retail', 'Wholesale', 'Online'];
  let s = 'Date,Product,Channel,Units,Revenue\n', seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  for (let i = 0; i < 180; i++) {
    const d = new Date(2026, 0, 1 + Math.floor(i * 1.6));
    const u = Math.floor(5 + rnd() * 60);
    const p = prods[Math.floor(rnd() * prods.length)];
    s += `${d.toISOString().slice(0, 10)},${p},${ch[Math.floor(rnd() * 3)]},${u},"${(u * (8 + rnd() * 10)).toFixed(2)}"\n`;
  }
  load(s, 'sample-sales.csv');
};
