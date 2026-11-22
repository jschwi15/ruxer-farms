/* Ruxer Farms — equipment maintenance app.
   Data lives in Supabase (tables equipment, logs, contacts, history, push_subs).
   Access: the link's ?k= code is sent as x-farm-key on every request; the
   database's row-level security refuses requests without it. */
(() => {
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const CFG = window.RUXER_CONFIG || {};
  const KEY = new URLSearchParams(location.search).get('k') || '';
  const S = {
    sb: null, myName: '', equipment: [], logs: [], contacts: [],
    loaded: false, offline: false, outbox: [], view: { name: 'list' }, tab: 'status',
    meterOpen: false, quickMeter: null, confirmIv: null, formShown: false, pendingRender: false, search: ''
  };

  // ---------- helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    if (value !== undefined) el.value = value;
    return el;
  }
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { } },
    del(k) { try { localStorage.removeItem(k); } catch { } }
  };
  const clone = (o) => o == null ? o : JSON.parse(JSON.stringify(o));
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const numOrNull = (v) => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
  const fmtN = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const money = (n) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function todayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function parseD(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); }
  function addMonths(s, n) { const d = parseD(s); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + Math.round(n)); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return d; }
  function daysUntil(date) { return Math.round((date - parseD(todayStr())) / 86400000); }
  function fmtDate(d) { if (typeof d === 'string') d = parseD(d); return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  const unitLabel = (u) => ({ hrs: 'hrs', mi: 'mi', km: 'km' }[u] || 'hrs');
  const meterName = (u) => (u === 'mi' || u === 'km') ? 'Odometer' : 'Hour meter';
  const appUrl = () => location.origin + location.pathname + '?k=' + encodeURIComponent(KEY);
  let toastTimer;
  function toast(msg, action) {
    clearTimeout(toastTimer);
    $toast.replaceChildren(...[h('span', { text: msg }), action ? h('button', { type: 'button', class: 'toastbtn', text: action.label, onclick: () => { $toast.hidden = true; action.run(); } }) : null].filter(Boolean));
    $toast.hidden = false;
    toastTimer = setTimeout(() => { $toast.hidden = true; }, action ? 7000 : 2800);
  }
  function go(hash) { if (location.hash === hash || (hash === '' && !location.hash)) route(); else location.hash = hash; }
  function showErr(e) {
    console.error(e);
    toast('Could not save: ' + ((e && e.message) || 'unknown problem') + '. Try again.');
  }
  function everyText(iv, u) {
    const parts = [numOrNull(iv.everyMeter) ? `${fmtN(iv.everyMeter)} ${u}` : null, numOrNull(iv.everyMonths) ? `${fmtN(iv.everyMonths)} mo` : null].filter(Boolean);
    return parts.length ? 'Every ' + parts.join(' / ') : 'No interval set';
  }
  const field = (label, input, cls) => h('label', { class: 'f' + (cls ? ' ' + cls : '') }, h('span', { text: label }), input);

  // ---------- machines, implements, status ----------
  const findEq = (id) => S.equipment.find(e => e.id === id);
  const findDealer = (id) => S.contacts.find(c => c.id === id);
  const parentOf = (e) => e && e.parentId ? findEq(e.parentId) : null;
  const childrenOf = (id) => S.equipment.filter(e => e.parentId === id);
  const topLevel = () => S.equipment.filter(e => !parentOf(e));
  // An implement that runs on its tractor's hours borrows the tractor's meter.
  function effEq(e) {
    const p = parentOf(e);
    if (e.meterUnit === 'parent') return p ? { ...e, meter: p.meter, meterUnit: p.meterUnit, meterDate: p.meterDate } : { ...e, meter: null, meterUnit: 'hrs' };
    return e;
  }
  const RANK = { unknown: -1, ok: 0, soon: 1, due: 2 };
  const LABEL = { ok: 'Good', soon: 'Due soon', due: 'Overdue', unknown: 'No record' };
  function intervalStatus(eq, iv) {
    const cur = numOrNull(eq.meter), u = unitLabel(eq.meterUnit);
    let level = null, texts = [], pct = null;
    const every = numOrNull(iv.everyMeter), last = numOrNull(iv.lastMeter);
    if (every > 0 && last != null && cur != null) {
      const dueAt = last + every, rem = dueAt - cur;
      level = rem <= 0 ? 'due' : rem <= Math.max(every * 0.1, alertHours()) ? 'soon' : 'ok';
      pct = Math.max(0, Math.min(1, (cur - last) / every));
      texts.push(rem <= 0 ? `${fmtN(-rem)} ${u} overdue` : `${fmtN(rem)} ${u} left · due at ${fmtN(dueAt)}`);
    }
    const months = numOrNull(iv.everyMonths);
    if (months > 0 && iv.lastDate) {
      const due = addMonths(iv.lastDate, months), days = daysUntil(due);
      const l = days < 0 ? 'due' : days <= Math.max(14, months * 3) ? 'soon' : 'ok';
      if (level == null || RANK[l] > RANK[level]) level = l;
      const total = Math.max(1, daysUntil(due) - daysUntil(parseD(iv.lastDate)));
      const p = Math.max(0, Math.min(1, 1 - days / total));
      pct = pct == null ? p : Math.max(pct, p);
      texts.push(days < 0 ? `${-days} days overdue` : `by ${fmtDate(due)}`);
    }
    if (level == null) {
      const why = (every > 0 && last != null && cur == null) ? 'Set the hour meter to see what is due' : '';
      return { level: 'unknown', text: why, pct: null };
    }
    return { level, text: texts.join(' or '), pct };
  }
  function eqStatus(e) {
    const eq = effEq(e);
    let worst = 'unknown', next = null, nextRank = -2;
    const counts = { ok: 0, soon: 0, due: 0, unknown: 0 };
    for (const iv of eq.intervals || []) {
      const s = intervalStatus(eq, iv);
      counts[s.level]++;
      if (RANK[s.level] > RANK[worst]) worst = s.level;
      const r = RANK[s.level] + (s.pct || 0) * 0.5;
      if (r > nextRank) { nextRank = r; next = { iv, s }; }
    }
    return { level: worst, next, counts };
  }
  const chip = (level) => h('span', { class: 'chipst s-' + level, text: LABEL[level] });
  const alertHours = () => numOrNull(ls.get('ruxer-alert-hours')) ?? 30;

  // ---------- data: Supabase + offline outbox + undo ----------
  const TABLES = ['equipment', 'logs', 'contacts'];
  const listOf = (t) => t === 'equipment' ? S.equipment : t === 'logs' ? S.logs : S.contacts;
  function setList(t, arr) { if (t === 'equipment') S.equipment = arr; else if (t === 'logs') S.logs = arr; else S.contacts = arr; }
  function toRow(t, obj) {
    const data = clone(obj); delete data.id;
    return t === 'logs' ? { id: obj.id, equipment_id: obj.equipmentId || '', data } : { id: obj.id, data };
  }
  function fromRow(t, r) { const o = { ...(r.data || {}), id: r.id }; if (t === 'logs' && r.equipment_id) o.equipmentId = r.equipment_id; return o; }
  function applyLocal(op) {
    const arr = listOf(op.table).filter(x => x.id !== (op.op === 'put' ? op.row.id : op.id));
    if (op.op === 'put') arr.push(fromRow(op.table, op.row));
    setList(op.table, arr);
  }
  function saveCache() { ls.set('ruxer-cache', JSON.stringify({ equipment: S.equipment, logs: S.logs, contacts: S.contacts, at: Date.now() })); }
  function loadCache() {
    try { const c = JSON.parse(ls.get('ruxer-cache') || 'null'); if (c) { S.equipment = c.equipment || []; S.logs = c.logs || []; S.contacts = c.contacts || []; S.cacheAt = c.at; return true; } } catch { }
    return false;
  }
  const saveOutbox = () => ls.set('ruxer-outbox', JSON.stringify(S.outbox));
  const isNetErr = (err) => !!err && (err instanceof TypeError || /fetch|network|load failed|offline|timed? ?out/i.test(String(err.message || err)));
  async function exec(op) {
    const q = op.op === 'put' ? S.sb.from(op.table).upsert(op.row) : S.sb.from(op.table).delete().eq('id', op.id);
    const { error } = await q;
    if (error) throw error;
  }
  let offlineToastShown = false;
  async function send(op) {
    applyLocal(op);
    if (!S.outbox.length && navigator.onLine !== false) {
      try { await exec(op); saveCache(); announce(op.table); return; }
      catch (err) { if (!isNetErr(err)) { await loadTable(op.table).catch(() => {}); render(); throw err; } }
    }
    S.outbox.push(op); saveOutbox(); saveCache(); S.offline = true;
    if (!offlineToastShown) { offlineToastShown = true; toast('No signal. Saved on this phone; it will sync when you are back online.'); }
  }
  let flushing = false;
  async function flush() {
    if (flushing || !S.outbox.length || !S.sb) return;
    flushing = true;
    let sent = 0;
    try {
      while (S.outbox.length) {
        try { await exec(S.outbox[0]); S.outbox.shift(); saveOutbox(); sent++; }
        catch (err) { if (isNetErr(err)) break; console.error('Dropped change that the server refused', err, S.outbox[0]); S.outbox.shift(); saveOutbox(); }
      }
    } finally { flushing = false; }
    if (sent) { toast(`Synced ${sent} change${sent === 1 ? '' : 's'} made offline`); TABLES.forEach(announce); await loadAll(); }
  }
  // Undo: actions record what each touched row looked like before.
  let tx = null;
  async function put(t, obj, rec = true) { const before = clone(listOf(t).find(x => x.id === obj.id) || null); if (rec && tx) tx.push({ t, id: obj.id, before }); await send({ op: 'put', table: t, row: toRow(t, obj) }); }
  async function del(t, id, rec = true) { const before = clone(listOf(t).find(x => x.id === id) || null); if (rec && tx) tx.push({ t, id, before }); await send({ op: 'del', table: t, id }); }
  async function action(label, fn) {
    tx = [];
    let ops;
    try { await fn(); } finally { ops = tx; tx = null; }
    render();
    if (ops.length) toast(label, { label: 'Undo', run: () => undoOps(ops) });
  }
  async function undoOps(ops) {
    try {
      for (const o of [...ops].reverse()) { if (o.before) await put(o.t, o.before, false); else await del(o.t, o.id, false); }
      toast('Undone'); render();
    } catch (e) { showErr(e); }
  }
  async function loadTable(t) {
    const { data, error } = await S.sb.from(t).select('*');
    if (error) throw error;
    setList(t, data.map(r => fromRow(t, r)));
  }
  async function loadAll() {
    try {
      await Promise.all(TABLES.map(loadTable));
      for (const op of S.outbox) applyLocal(op); // keep unsynced changes visible
      S.loaded = true; S.offline = S.outbox.length > 0; saveCache();
    } catch (err) {
      console.error(err);
      if (!S.loaded && loadCache()) { for (const op of S.outbox) applyLocal(op); }
      S.loaded = true; S.offline = true;
    }
    render(); updateBadge();
  }
  let channel;
  function announce(t) { if (channel) channel.send({ type: 'broadcast', event: 'changed', payload: { table: t } }).catch(() => {}); }

  // ---------- routing / render ----------
  function parseHash() {
    const s = location.hash.slice(1); let m;
    if (s === 'new') return { name: 'edit', id: null };
    if ((m = s.match(/^new-([A-Za-z0-9]+)$/))) return { name: 'edit', id: null, parentId: m[1] };
    if ((m = s.match(/^edit-([A-Za-z0-9]+)$/))) return { name: 'edit', id: m[1] };
    if ((m = s.match(/^log-([A-Za-z0-9]+)$/))) return { name: 'log', id: m[1] };
    if ((m = s.match(/^eq-([A-Za-z0-9]+)$/))) return { name: 'detail', id: m[1] };
    if ((m = s.match(/^hist-([A-Za-z0-9]+)$/))) return { name: 'history', id: m[1] };
    if (s === 'history') return { name: 'history', id: null };
    if (s === 'settings') return { name: 'settings' };
    if (s === 'dealers') return { name: 'dealers' };
    if (s === 'dealer-new') return { name: 'dealer', id: null };
    if ((m = s.match(/^dealer-([A-Za-z0-9]+)$/))) return { name: 'dealer', id: m[1] };
    return { name: 'list' };
  }
  function route() {
    const prev = S.view; S.view = parseHash();
    if (S.view.name === 'detail' && prev.id !== S.view.id) S.tab = 'status';
    S.meterOpen = false; S.quickMeter = null; S.confirmIv = null; S.formShown = false;
    render(true); window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  const FORM_VIEWS = ['edit', 'log', 'dealer', 'settings'];
  function render(force) {
    const v = S.view;
    if (!force) {
      if (FORM_VIEWS.includes(v.name) && S.formShown) return;
      const a = document.activeElement;
      if (a && $app.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { S.pendingRender = true; return; }
    }
    S.pendingRender = false;
    let node;
    if (S.setupMissing) node = msg('Setup needed', 'Add the Supabase project URL and key to config.js.');
    else if (S.badLink) node = msg('This link is incomplete', 'Open the app with the full link the farm owner sent you. It ends with ?k= and a long code.');
    else if (S.needName) node = nameView();
    else if (!S.loaded) node = msg('Loading equipment…', 'Connecting to the shared log.');
    else if (v.name === 'detail') node = detail(v.id);
    else if (v.name === 'edit') { node = editor(v.id, v.parentId); S.formShown = true; }
    else if (v.name === 'log') { node = logForm(v.id); S.formShown = true; }
    else if (v.name === 'history') node = historyView(v.id);
    else if (v.name === 'settings') { node = settingsView(); S.formShown = true; }
    else if (v.name === 'dealers') node = dealersView();
    else if (v.name === 'dealer') { node = dealerForm(v.id); S.formShown = true; }
    else node = list();
    const banner = S.offline ? h('div', { class: 'banner' },
      'No connection. Showing what is saved on this phone.',
      S.outbox.length ? ` ${S.outbox.length} change${S.outbox.length === 1 ? '' : 's'} will sync when you are back online.` : '') : null;
    $app.replaceChildren(...[banner, node].filter(Boolean));
  }
  $app.addEventListener('focusout', () => setTimeout(() => { if (S.pendingRender) render(); }, 0));
  const msg = (t, p) => h('div', { class: 'empty' }, h('h2', { text: t }), h('p', { text: p }));
  const backLink = (href, text) => h('a', { class: 'back', href, text: '← ' + text });

  function updateBadge() {
    try {
      if (!('setAppBadge' in navigator) || !('Notification' in window) || Notification.permission !== 'granted') return;
      let n = 0;
      for (const e of S.equipment) { const c = eqStatus(e).counts; n += c.due + c.soon; }
      if (n) navigator.setAppBadge(n).catch(() => {}); else navigator.clearAppBadge().catch(() => {});
    } catch { }
  }

  // ---------- first-run name ----------
  function nameView() {
    const form = h('form', { class: 'login', onsubmit: (ev) => {
      ev.preventDefault();
      const n = form.elements.name.value.trim();
      if (!n) return;
      ls.set('ruxer-name', n); S.myName = n; S.needName = false; render(true);
    } },
      h('div', { class: 'eyebrow', text: 'Equipment maintenance' }),
      h('h1', { text: 'Ruxer Farms' }),
      h('p', { class: 'muted', style: 'margin:0', text: 'Your name goes on the services and changes you make from this phone.' }),
      field('Your name', h('input', { id: 'name', name: 'name', autocomplete: 'name', required: true, value: S.myName || '' })),
      h('button', { class: 'primary big', type: 'submit', text: 'Continue' }));
    return form;
  }

  // ---------- list ----------
  function list() {
    const tops = topLevel();
    const frag = h('div', null, h('div', { class: 'top' },
      h('a', { class: 'brand', href: '#', text: 'Ruxer Farms' }), h('span', { class: 'spacer' }),
      tops.length ? h('a', { class: 'btn primary small', href: '#new', text: '+ Add' }) : null,
      h('a', { class: 'btn small', href: '#settings', text: 'Settings' })));
    if (!tops.length) {
      frag.append(h('div', { class: 'empty' },
        h('div', { class: 'eyebrow', text: 'Nothing on the log yet' }),
        h('h2', { text: 'Add your first machine' }),
        h('p', { text: 'Each machine holds its VIN or serial, filter part numbers, and service intervals by hours, miles or months.' }),
        h('a', { class: 'btn primary', href: '#new', text: '+ Add equipment' })));
      return frag;
    }
    const all = S.equipment.map(e => ({ e, s: eqStatus(e) }));
    const count = (l) => all.filter(x => x.s.level === l).length;
    frag.append(h('div', { class: 'ltally' },
      h('div', null, h('b', { class: 'num', text: tops.length }), h('span', { text: tops.length === 1 ? 'Machine' : 'Machines' })),
      h('div', null, h('b', { class: 'num', style: 'color:var(--bad)', text: count('due') }), h('span', { text: 'Overdue' })),
      h('div', null, h('b', { class: 'num', style: 'color:var(--warn)', text: count('soon') }), h('span', { text: 'Due soon' })),
      h('div', null, h('b', { class: 'num', style: 'color:var(--good)', text: count('ok') }), h('span', { text: 'Good' }))));
    const cards = h('div', { class: 'cards' });
    const draw = () => {
      const q = S.search.trim().toLowerCase();
      const match = (e) => [e.name, e.make, e.model, e.year, e.vin, e.category, ...(e.filters || []).map(f => `${f.name} ${f.number} ${f.alt}`)].join(' ').toLowerCase().includes(q);
      const rows = tops.map(e => ({ e, s: eqStatus(e), kids: childrenOf(e.id) }))
        .filter(({ e, kids }) => !q || match(e) || kids.some(match))
        .sort((a, b) => RANK[b.s.level] - RANK[a.s.level] || String(a.e.name).localeCompare(String(b.e.name)));
      cards.replaceChildren(...rows.map(r => card(r.e, r.s, r.kids)));
      if (!rows.length) cards.append(h('p', { class: 'muted', text: 'No machines match that search.' }));
    };
    if (S.equipment.length > 3) frag.append(h('div', { class: 'toolbar' }, h('input', { id: 'search', type: 'search', placeholder: 'Search name, VIN or part number', value: S.search, 'aria-label': 'Search equipment', oninput: (ev) => { S.search = ev.target.value; draw(); } })));
    draw();
    frag.append(cards);
    return frag;
  }
  function card(e, s, kids) {
    const u = unitLabel(e.meterUnit);
    const hasMeter = e.meter != null && e.meter !== '';
    const open = () => go('#eq-' + e.id);
    const stop = (ev) => ev.stopPropagation();
    let meterUi;
    if (S.quickMeter === e.id) {
      meterUi = h('form', { class: 'quickmeter', onclick: stop, onsubmit: async (ev) => {
        ev.preventDefault(); stop(ev);
        const v = numOrNull(ev.target.elements.qm.value);
        if (v == null) { toast('Enter a number for the reading.'); return; }
        S.quickMeter = null; document.activeElement && document.activeElement.blur();
        try { await action(`${e.name || 'Machine'}: ${fmtN(v)} ${u}`, () => put('equipment', { ...findEq(e.id), meter: v, meterDate: todayStr() })); } catch (err) { showErr(err); }
        render(true);
      } },
        h('input', { id: 'qm-' + e.id, name: 'qm', type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: hasMeter ? e.meter : '', 'aria-label': `${meterName(e.meterUnit)} reading` }),
        h('button', { class: 'primary small', type: 'submit', text: 'Save' }),
        h('button', { class: 'small', type: 'button', text: 'Cancel', onclick: (ev) => { stop(ev); S.quickMeter = null; render(true); } }));
    } else {
      meterUi = h('button', { class: 'meterchip num', type: 'button', 'aria-label': `Update ${meterName(e.meterUnit).toLowerCase()}`, onclick: (ev) => {
        stop(ev); S.quickMeter = e.id; render(true); const i = document.getElementById('qm-' + e.id); if (i) { i.focus(); i.select && i.select(); }
      } }, hasMeter ? `${fmtN(e.meter)} ${u}` : `Set ${u === 'hrs' ? 'hours' : 'miles'}`, h('span', { class: 'pen', 'aria-hidden': 'true', text: '✎' }));
    }
    return h('div', { class: 'card', role: 'link', tabindex: '0', onclick: open, onkeydown: (ev) => { if (ev.key === 'Enter' && ev.target === ev.currentTarget) open(); } },
      h('div', { style: 'display:grid;gap:2px;min-width:0' }, h('div', { class: 'eyebrow', text: e.category || 'Machine' }), h('h3', { text: e.name || 'Unnamed machine' })),
      chip(s.level),
      h('div', { class: 'meta' }, e.vin ? h('span', { class: 'mono', text: 'VIN ' + e.vin }) : null),
      h('div', { class: 'meterrow' }, meterUi),
      s.next ? h('div', { class: 'next' }, h('b', { text: s.next.iv.task || 'Service' }), ' · ', h('span', { class: 'muted', text: s.next.s.text || everyText(s.next.iv, u) })) : h('div', { class: 'next muted', text: 'No service intervals set' }),
      kids.length ? h('div', { class: 'kids' }, kids.map(k => {
        const ks = eqStatus(k);
        return h('a', { class: 'kid', href: '#eq-' + k.id, onclick: stop }, h('span', { text: '↳ ' + (k.name || 'Implement') }), chip(ks.level));
      })) : null);
  }

  // ---------- detail ----------
  function detail(id) {
    const e = findEq(id);
    if (!e) return h('div', null, h('div', { class: 'top' }, backLink('#', 'All equipment')), msg('Machine not found', 'It may have been deleted.'));
    const eq = effEq(e), u = unitLabel(eq.meterUnit), parent = parentOf(e);
    const wrap = h('div');
    wrap.append(h('div', { class: 'top' }, parent ? backLink('#eq-' + parent.id, parent.name || 'Machine') : backLink('#', 'All equipment'), h('span', { class: 'spacer' }),
      h('a', { class: 'btn small', href: '#edit-' + e.id, text: 'Edit' })));
    const hasMeter = eq.meter != null && eq.meter !== '';
    const borrowed = e.meterUnit === 'parent';
    wrap.append(h('div', { class: 'mhead' },
      h('div', { class: 'mcard' },
        h('div', { class: 'eyebrow' }, parent ? ['Attached to ', h('a', { href: '#eq-' + parent.id, class: 'inl', text: parent.name || 'machine' })] : (e.category || 'Machine')),
        h('h1', { text: e.name || 'Unnamed machine' })),
      h('button', { class: 'meter', type: 'button', 'aria-expanded': String(S.meterOpen), onclick: () => {
        if (borrowed) { if (parent) go('#eq-' + parent.id); return; }
        S.meterOpen = !S.meterOpen; render(true); if (S.meterOpen) { const i = document.getElementById('meter-input'); i && i.focus(); }
      } },
        h('span', { class: 'eyebrow', text: borrowed ? 'Tractor hours' : meterName(e.meterUnit) }),
        h('b', { class: 'num', text: hasMeter ? fmtN(eq.meter) : 'Set' }))));
    if (S.meterOpen && !borrowed) {
      wrap.append(h('form', { class: 'meterform', onsubmit: async (ev) => {
        ev.preventDefault();
        const v = numOrNull(ev.target.elements.meter.value);
        if (v == null) { toast('Enter a number for the reading.'); return; }
        S.meterOpen = false; document.activeElement && document.activeElement.blur();
        try { await action(`${meterName(e.meterUnit)} set to ${fmtN(v)}`, () => put('equipment', { ...findEq(e.id), meter: v, meterDate: todayStr() })); } catch (err) { showErr(err); }
        render(true);
      } },
        field(`Current reading (${u})`, h('input', { id: 'meter-input', name: 'meter', type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: hasMeter ? e.meter : '' })),
        h('button', { class: 'primary', type: 'submit', text: 'Save' }),
        h('button', { type: 'button', text: 'Cancel', onclick: () => { S.meterOpen = false; render(true); } }),
        e.meterDate ? h('div', { class: 'muted', style: 'flex-basis:100%;font-size:.85rem', text: 'Last read ' + fmtDate(e.meterDate) }) : null));
    }
    const TABS = [['status', 'Status'], ['log', 'Log'], ['fuel', 'Fuel'], ['intervals', 'Intervals'], ['specs', 'Specs']];
    wrap.append(h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(S.tab === k), text: l, onclick: () => { S.tab = k; S.confirmIv = null; render(true); } }))));
    wrap.append(({ status: tabStatus, specs: tabSpecs, log: tabLog, fuel: tabFuel, intervals: tabIntervals })[S.tab](e, eq, u));
    return wrap;
  }

  function tabStatus(e, eq, u) {
    const st = eqStatus(e);
    const frag = h('div', { class: 'stack' });
    frag.append(h('div', { class: 'tally', style: 'margin:0' },
      h('div', null, h('b', { class: 'num', style: 'color:var(--bad)', text: st.counts.due }), h('span', { text: 'Overdue' })),
      h('div', null, h('b', { class: 'num', style: 'color:var(--warn)', text: st.counts.soon }), h('span', { text: 'Due soon' })),
      h('div', null, h('b', { class: 'num', style: 'color:var(--good)', text: st.counts.ok }), h('span', { text: 'Good' }))));
    frag.append(h('a', { class: 'btn primary big', href: '#log-' + e.id, text: '+ Log service' }));
    const ivs = (eq.intervals || []).map((iv, i) => ({ iv, i, s: intervalStatus(eq, iv) }))
      .sort((a, b) => (RANK[b.s.level] - RANK[a.s.level]) || ((b.s.pct || 0) - (a.s.pct || 0)) || (a.i - b.i));
    const panel = h('div', { class: 'panel svc' }, h('h2', { text: 'Service due' }));
    if (!ivs.length) panel.append(h('p', { class: 'muted' }, 'No service intervals yet. ', h('a', { href: '#edit-' + e.id, class: 'inl', text: 'Add them' })));
    const hasMeter = eq.meter != null && eq.meter !== '';
    for (const { iv, s } of ivs) {
      const row = h('div', { class: 'row' },
        h('div', { style: 'min-width:0' },
          h('div', { class: 't', text: iv.task || 'Service' }),
          h('div', { class: 'sub num', text: everyText(iv, u) }),
          s.text ? h('div', { class: 'sub2 num', style: `color:var(--${s.level === 'due' ? 'bad' : s.level === 'soon' ? 'warn' : 'muted'})`, text: s.text }) : null,
          s.pct != null ? h('div', { class: 'bar s-' + s.level }, h('i', { style: `width:${Math.round(s.pct * 100)}%` })) : null),
        h('div', { class: 'side' }, chip(s.level),
          h('button', { type: 'button', text: 'Done', 'aria-label': 'Mark ' + (iv.task || 'service') + ' done', onclick: () => { S.confirmIv = S.confirmIv === iv.id ? null : iv.id; render(true); } })));
      if (S.confirmIv === iv.id) {
        row.append(h('div', { class: 'confirm' },
          h('span', { text: `Record ${iv.task || 'this service'} as done today${hasMeter ? ` at ${fmtN(eq.meter)} ${u}` : ''}?` + (hasMeter ? '' : ' Set the hour meter first to track by hours.') }),
          h('button', { class: 'primary small', type: 'button', text: 'Record it', onclick: async (ev) => {
            ev.target.disabled = true;
            try { await action((iv.task || 'Service') + ' recorded', () => recordService(e.id, { date: todayStr(), meter: hasMeter ? Number(eq.meter) : null, done: [iv.id] })); S.confirmIv = null; }
            catch (err) { showErr(err); }
            render(true);
          } }),
          h('a', { class: 'btn small', href: '#log-' + e.id, text: 'Add details' }),
          h('button', { class: 'small', type: 'button', text: 'Cancel', onclick: () => { S.confirmIv = null; render(true); } })));
      }
      panel.append(row);
    }
    frag.append(panel);
    if (!parentOf(e)) {
      const kids = childrenOf(e.id);
      const kp = h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Implements' }), h('a', { class: 'btn small', href: '#new-' + e.id, text: '+ Add' })));
      if (!kids.length) kp.append(h('p', { class: 'muted', style: 'margin:14px 0 0', text: 'Loaders, mowers, buckets and other attachments used with this machine. Each one can have its own parts and service intervals.' }));
      for (const k of kids) {
        const ks = eqStatus(k);
        kp.append(h('a', { class: 'kidrow', href: '#eq-' + k.id },
          h('span', { style: 'min-width:0' }, h('b', { text: k.name || 'Implement' }), h('span', { class: 'muted', text: ks.next ? ` · ${ks.next.iv.task}` : '' })), chip(ks.level)));
      }
      frag.append(kp);
    }
    return frag;
  }

  function tabSpecs(e) {
    const frag = h('div', { class: 'stack' });
    const facts = [['Make', e.make], ['Model', e.model], ['Year', e.year], ['Category', e.category], ['Location', e.location]].filter(([, v]) => v);
    const copyBtn = h('button', { class: 'small', type: 'button', text: 'Copy', onclick: async (ev) => {
      try { await navigator.clipboard.writeText(e.vin); toast('VIN copied'); }
      catch { const r = document.createRange(); r.selectNodeContents(ev.target.previousSibling); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('VIN selected. Use your copy shortcut.'); }
    } });
    frag.append(h('div', { class: 'panel' }, h('h2', { text: 'Machine' }),
      h('div', { class: 'facts' },
        h('div', { style: 'grid-column:1/-1' }, h('div', { class: 'eyebrow', text: 'VIN / Serial number' }),
          e.vin ? h('div', { class: 'vin' }, h('span', { class: 'mono', text: e.vin }), copyBtn) : h('div', { class: 'muted', text: 'Not entered yet' })),
        facts.map(([k, v]) => h('div', null, h('div', { class: 'eyebrow', text: k }), h('div', { class: 'v', text: v }))))));
    const dealer = findDealer(e.dealerId);
    frag.append(h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Dealer' }), h('a', { class: 'btn small', href: '#edit-' + e.id, text: dealer ? 'Change' : '+ Set' })),
      dealer ? dealerCard(dealer) : h('p', { class: 'muted', style: 'margin:14px 0 0', text: 'No dealer set for this machine.' })));
    const fs = e.filters || [];
    const fp = h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Filters & parts' }), h('a', { class: 'btn small', href: '#edit-' + e.id, text: fs.length ? 'Edit' : '+ Add' })));
    if (!fs.length) fp.append(h('p', { class: 'muted', style: 'margin:14px 0 0', text: 'No part numbers yet.' }));
    for (const f of fs) fp.append(h('div', { class: 'part' },
      h('div', { style: 'font-weight:500;min-width:0;overflow-wrap:anywhere', text: (f.qty && f.qty !== '1' ? f.qty + '× ' : '') + (f.name || 'Part') }),
      h('div', { class: 'pn', text: f.number || '—' }),
      (f.alt || f.notes) ? h('div', { class: 'x' }, f.alt ? h('span', null, 'Cross-ref ', h('span', { class: 'mono', text: f.alt })) : null, f.alt && f.notes ? ' · ' : '', f.notes || '') : null));
    frag.append(fp);
    if (e.notes) frag.append(h('div', { class: 'panel' }, h('h2', { text: 'Notes' }), h('div', { class: 'note', text: e.notes })));
    frag.append(h('a', { class: 'btn', href: '#hist-' + e.id, text: 'Edit history and undo' }));
    const logs = S.logs.filter(l => l.equipmentId === e.id);
    const kids = childrenOf(e.id);
    const zone = h('div', { class: 'dangerzone' });
    const idle = () => zone.replaceChildren(h('button', { class: 'danger small', type: 'button', text: 'Delete machine', onclick: ask }));
    const ask = () => zone.replaceChildren(
      h('span', { style: 'flex:1 1 220px', text: `Delete ${e.name || 'this machine'} and its ${logs.length} log entries?` + (kids.length ? ` Its ${kids.length} implement(s) will be kept as separate machines.` : '') + ' You can undo right after.' }),
      h('button', { class: 'danger solid small', type: 'button', text: 'Delete', onclick: async () => {
        try {
          await action('Machine deleted', async () => {
            for (const k of kids) await put('equipment', { ...k, parentId: null, meterUnit: k.meterUnit === 'parent' ? 'hrs' : k.meterUnit });
            for (const l of logs) await del('logs', l.id);
            await del('equipment', e.id);
          });
          go('');
        } catch (err) { showErr(err); }
      } }),
      h('button', { class: 'small', type: 'button', text: 'Keep it', onclick: idle }));
    idle();
    frag.append(zone);
    return frag;
  }

  function dealerCard(d) {
    const tel = (n) => n ? h('a', { class: 'btn small', href: 'tel:' + n.replace(/[^\d+]/g, '') , text: '☎ ' + n }) : null;
    return h('div', { class: 'stack', style: 'padding-top:14px;gap:10px' },
      h('div', null, h('b', { style: 'font-size:1.1rem', text: d.name || 'Dealer' }), d.contact ? h('div', { class: 'muted', text: 'Contact: ' + d.contact }) : null),
      h('div', { class: 'chips' }, tel(d.phone), d.partsPhone ? h('a', { class: 'btn small', href: 'tel:' + d.partsPhone.replace(/[^\d+]/g, ''), text: '☎ Parts ' + d.partsPhone }) : null,
        d.email ? h('a', { class: 'btn small', href: 'mailto:' + d.email, text: '✉ ' + d.email }) : null),
      d.address ? h('a', { class: 'inl', href: 'https://maps.apple.com/?q=' + encodeURIComponent(d.address), target: '_blank', rel: 'noopener', text: d.address }) : null,
      d.website ? h('a', { class: 'inl', href: /^https?:/.test(d.website) ? d.website : 'https://' + d.website, target: '_blank', rel: 'noopener', text: d.website }) : null,
      d.notes ? h('div', { class: 'muted', style: 'white-space:pre-wrap', text: d.notes }) : null);
  }

  function tabLog(e, eq, u) {
    const logs = S.logs.filter(l => l.equipmentId === e.id && l.kind !== 'fuel').sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0));
    const p = h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Service log' }), h('a', { class: 'btn small', href: '#log-' + e.id, text: '+ Log' })));
    if (!logs.length) p.append(h('p', { class: 'muted', style: 'margin:14px 0 0', text: 'Nothing logged yet. Tap Done on a service, or use Log service.' }));
    for (const l of logs) p.append(h('div', { class: 'entry' },
      h('div', { class: 'eh' },
        h('span', { class: 'date', text: l.date ? fmtDate(l.date) : 'No date' }),
        numOrNull(l.meter) != null ? h('span', { class: 'num muted', text: `${fmtN(l.meter)} ${u}` }) : null,
        l.by ? h('span', { class: 'muted', style: 'font-size:.85rem', text: 'by ' + l.by }) : null,
        numOrNull(l.cost) != null ? h('span', { class: 'num muted', text: money(l.cost) }) : null,
        h('span', { style: 'flex:1' }), removeBtn(l, 'Service entry removed')),
      (l.taskNames || []).length ? h('div', { class: 'chips' }, l.taskNames.map(t => h('span', { class: 'chip', text: t }))) : null,
      l.work ? h('p', { text: l.work }) : null,
      l.parts ? h('p', { class: 'muted' }, 'Parts: ', l.parts) : null));
    return p;
  }
  function removeBtn(l, label) {
    const box = h('span');
    const idle = () => box.replaceChildren(h('button', { class: 'small danger', type: 'button', text: 'Remove', onclick: () => box.replaceChildren(
      h('button', { class: 'small danger solid', type: 'button', text: 'Remove', onclick: async () => { try { await action(label, () => del('logs', l.id)); } catch (err) { showErr(err); } } }),
      h('button', { class: 'small', type: 'button', text: 'Cancel', onclick: idle })) }));
    idle();
    return box;
  }

  function tabFuel(e, eq, u) {
    const fills = S.logs.filter(l => l.equipmentId === e.id && l.kind === 'fuel').sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0));
    const year = String(new Date().getFullYear());
    const yr = fills.filter(f => String(f.date || '').startsWith(year));
    const gal = yr.reduce((s, f) => s + (numOrNull(f.gallons) || 0), 0);
    const cost = yr.reduce((s, f) => s + (numOrNull(f.cost) || 0), 0);
    const withMeter = fills.filter(f => numOrNull(f.meter) != null && numOrNull(f.gallons) != null).sort((a, b) => a.meter - b.meter);
    let rate = null;
    if (withMeter.length >= 2) {
      const span = withMeter[withMeter.length - 1].meter - withMeter[0].meter;
      const used = withMeter.slice(1).reduce((s, f) => s + Number(f.gallons), 0);
      if (span > 0) rate = used / span;
    }
    const frag = h('div', { class: 'stack' });
    frag.append(h('div', { class: 'tally', style: 'margin:0' },
      h('div', null, h('b', { class: 'num', text: fmtN(gal) }), h('span', { text: `Gallons in ${year}` })),
      h('div', null, h('b', { class: 'num', text: rate != null ? rate.toFixed(2) : '—' }), h('span', { text: `Gal per ${u === 'hrs' ? 'hour' : u}` })),
      h('div', null, h('b', { class: 'num', text: cost ? '$' + Math.round(cost).toLocaleString() : '—' }), h('span', { text: `Fuel cost ${year}` }))));
    const form = h('form', { class: 'panel', onsubmit: async (ev) => {
      ev.preventDefault();
      const el = form.elements;
      const gallons = numOrNull(el.gallons.value);
      if (gallons == null || gallons <= 0) { toast('Enter how many gallons went in.'); el.gallons.focus(); return; }
      const meter = numOrNull(el.fmeter.value);
      const entry = { id: uid('f'), kind: 'fuel', equipmentId: e.id, date: el.fdate.value || todayStr(), meter, gallons, cost: numOrNull(el.fcost.value), notes: el.fnotes.value.trim(), by: S.myName, createdAt: Date.now() };
      document.activeElement && document.activeElement.blur();
      try {
        await action(`${fmtN(gallons)} gal logged`, async () => {
          await put('logs', entry);
          const cur = findEq(e.id);
          if (meter != null && e.meterUnit !== 'parent' && (numOrNull(cur.meter) == null || meter >= Number(cur.meter))) await put('equipment', { ...cur, meter, meterDate: entry.date });
        });
        S.formShown = false; render(true);
      } catch (err) { showErr(err); }
    } },
      h('h2', { text: 'Add fill-up' }),
      h('div', { class: 'fgrid' },
        field('Date', h('input', { id: 'fdate', name: 'fdate', type: 'date', value: todayStr() })),
        field('Gallons', h('input', { id: 'gallons', name: 'gallons', type: 'number', inputmode: 'decimal', step: 'any', min: '0', required: true })),
        field(`${meterName(eq.meterUnit)} (${u})`, h('input', { id: 'fmeter', name: 'fmeter', type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: eq.meter ?? '' })),
        field('Total cost ($, optional)', h('input', { id: 'fcost', name: 'fcost', type: 'number', inputmode: 'decimal', step: '0.01', min: '0' })),
        field('Notes', h('input', { id: 'fnotes', name: 'fnotes', placeholder: 'Diesel, DEF, where filled…' }), 'wide')),
      h('div', { class: 'formfoot', style: 'padding-top:14px' }, h('button', { class: 'primary', type: 'submit', text: 'Save fill-up' })));
    frag.append(form);
    const lp = h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Fuel log' }), h('span', { class: 'muted', text: fills.length + (fills.length === 1 ? ' fill-up' : ' fill-ups') })));
    if (!fills.length) lp.append(h('p', { class: 'muted', style: 'margin:14px 0 0', text: 'No fill-ups yet. Enter the hour meter with each fill to see gallons per hour.' }));
    for (const f of fills) lp.append(h('div', { class: 'entry' },
      h('div', { class: 'eh' },
        h('span', { class: 'date', text: f.date ? fmtDate(f.date) : 'No date' }),
        h('b', { class: 'num', text: `${fmtN(f.gallons)} gal` }),
        numOrNull(f.meter) != null ? h('span', { class: 'num muted', text: `${fmtN(f.meter)} ${u}` }) : null,
        numOrNull(f.cost) != null ? h('span', { class: 'num muted', text: money(f.cost) }) : null,
        f.by ? h('span', { class: 'muted', style: 'font-size:.85rem', text: 'by ' + f.by }) : null,
        h('span', { style: 'flex:1' }), removeBtn(f, 'Fill-up removed')),
      f.notes ? h('p', { class: 'muted', text: f.notes }) : null));
    frag.append(lp);
    return frag;
  }

  function tabIntervals(e, eq, u) {
    const ivs = e.intervals || [];
    const p = h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Intervals' }), h('a', { class: 'btn small', href: '#edit-' + e.id, text: 'Edit' })));
    if (!ivs.length) { p.append(h('p', { class: 'muted', style: 'margin:14px 0 0', text: 'No intervals yet.' })); return p; }
    p.append(h('div', { class: 'scroll' }, h('table', null,
      h('thead', null, h('tr', null, ['Service', 'Interval', 'Last done', 'Next due'].map(t => h('th', { text: t })))),
      h('tbody', null, ivs.map(iv => {
        const last = numOrNull(iv.lastMeter), em = numOrNull(iv.everyMeter), mo = numOrNull(iv.everyMonths);
        const next = [em && last != null ? `${fmtN(last + em)} ${u}` : null, mo && iv.lastDate ? fmtDate(addMonths(iv.lastDate, mo)) : null].filter(Boolean).join(' or ');
        return h('tr', null,
          h('td', null, h('div', { style: 'font-weight:500', text: iv.task || 'Service' }), iv.notes ? h('div', { class: 'muted', style: 'font-size:.82rem', text: iv.notes }) : null),
          h('td', { class: 'num', style: 'white-space:nowrap', text: everyText(iv, u).replace(/^Every /, '') }),
          h('td', { class: 'num', text: [last != null ? `${fmtN(last)} ${u}` : null, iv.lastDate ? fmtDate(iv.lastDate) : null].filter(Boolean).join(' · ') || '—' }),
          h('td', { class: 'num', text: next || '—' }));
      })))));
    return p;
  }

  // ---------- service ----------
  async function recordService(eqId, { date, meter, done, work, parts, cost }) {
    const e = findEq(eqId);
    const log = { id: uid('l'), equipmentId: eqId, date, meter, tasks: done,
      taskNames: done.map(d => ((e.intervals || []).find(i => i.id === d) || {}).task || 'Service'),
      work: work || '', parts: parts || '', cost: cost ?? null, by: S.myName, createdAt: Date.now() };
    await put('logs', log);
    const next = clone(findEq(eqId) || e);
    next.intervals = (next.intervals || []).map(iv => {
      if (!done.includes(iv.id)) return iv;
      return (!iv.lastDate || date >= iv.lastDate) ? { ...iv, lastDate: date, lastMeter: meter != null ? meter : iv.lastMeter } : iv;
    });
    if (meter != null && e.meterUnit !== 'parent' && (numOrNull(next.meter) == null || meter >= Number(next.meter))) { next.meter = meter; next.meterDate = date; }
    await put('equipment', next);
  }
  function logForm(id) {
    const e = findEq(id);
    if (!e) return detail(id);
    const eq = effEq(e), u = unitLabel(eq.meterUnit);
    const ivs = (e.intervals || []).map(iv => ({ iv, s: intervalStatus(eq, iv) }));
    const form = h('form', { class: 'stack', onsubmit: async (ev) => {
      ev.preventDefault();
      const el = form.elements;
      const done = [...form.querySelectorAll('input[name=task]:checked')].map(c => c.value);
      const work = el.work.value.trim();
      if (!done.length && !work) { toast('Tick a service or describe the work done.'); return; }
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await action('Service logged', () => recordService(e.id, { date: el.date.value || todayStr(), meter: numOrNull(el.meter.value), done, work, parts: el.parts.value.trim(), cost: numOrNull(el.cost.value) }));
        go('#eq-' + e.id);
      } catch (err) { showErr(err); btn.disabled = false; btn.textContent = 'Save service'; }
    } },
      h('div', { class: 'panel' },
        h('div', { class: 'fgrid', style: 'padding-top:0' },
          field('Date', h('input', { id: 'l-date', name: 'date', type: 'date', value: todayStr(), required: true })),
          field(`${meterName(eq.meterUnit)} (${u})`, h('input', { id: 'l-meter', name: 'meter', type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: eq.meter ?? '' })))),
      ivs.length ? h('div', { class: 'panel' }, h('h2', { text: 'Services done' }),
        h('div', { class: 'checks', style: 'padding-top:14px' }, ivs.map(({ iv, s }) => h('label', null,
          h('input', { type: 'checkbox', name: 'task', value: iv.id, checked: S.confirmIv === iv.id }),
          h('span', { style: 'flex:1;min-width:0' }, iv.task || 'Service'), chip(s.level))))) : null,
      h('div', { class: 'panel stack' },
        field('Work done', h('textarea', { id: 'l-work', name: 'work', placeholder: 'Changed oil and filter, greased loader pins…' })),
        h('div', { class: 'fgrid', style: 'padding-top:0' },
          field('Parts used', h('input', { id: 'l-parts', name: 'parts', placeholder: 'Filter part numbers, oil qty' })),
          field('Cost ($, optional)', h('input', { id: 'l-cost', name: 'cost', type: 'number', inputmode: 'decimal', step: '0.01', min: '0' })))),
      h('div', { class: 'formfoot' }, h('a', { class: 'btn', href: '#eq-' + e.id, text: 'Cancel' }), h('button', { class: 'primary', type: 'submit', text: 'Save service' })));
    return h('div', null,
      h('div', { class: 'top' }, backLink('#eq-' + e.id, e.name || 'Machine')),
      h('div', { class: 'eyebrow', text: 'Log service' }),
      h('h1', { style: 'font-size:2rem;margin-bottom:16px', text: e.name || 'Machine' }),
      form);
  }

  // ---------- add / edit machine ----------
  const COMMON = ['Grease fittings', 'Engine oil & filter', 'Fuel filter', 'Air filter', 'Hydraulic oil & filter', 'Transmission oil', 'Coolant', 'Belts & hoses check'];
  function editor(id, presetParent) {
    const existing = id ? findEq(id) : null;
    if (id && !existing) return detail(id);
    const parentPre = presetParent ? findEq(presetParent) : null;
    const e = existing ? clone(existing) : { id: uid('e'), meterUnit: parentPre ? 'parent' : 'hrs', category: parentPre ? 'Implement' : '', parentId: parentPre ? parentPre.id : null, filters: [], intervals: [] };
    const inp = (key, attrs = {}) => h('input', { id: 'f-' + key, name: key, value: e[key] ?? '', ...attrs });

    const filtersBox = h('div', { class: 'rep' });
    const fRow = (f = {}) => {
      const row = h('div', { class: 'reprow', 'data-kind': 'filter' },
        h('label', { class: 'f w2' }, h('span', { text: 'Item' }), h('input', { 'data-f': 'name', value: f.name || '', placeholder: 'Engine oil filter' })),
        h('label', { class: 'f' }, h('span', { text: 'Part number' }), h('input', { 'data-f': 'number', class: 'mono', value: f.number || '', placeholder: 'OEM number' })),
        h('label', { class: 'f' }, h('span', { text: 'Cross-reference' }), h('input', { 'data-f': 'alt', class: 'mono', value: f.alt || '', placeholder: 'Wix, Baldwin…' })),
        h('label', { class: 'f' }, h('span', { text: 'Qty' }), h('input', { 'data-f': 'qty', value: f.qty || '', placeholder: '1' })),
        h('label', { class: 'f w2' }, h('span', { text: 'Notes' }), h('input', { 'data-f': 'notes', value: f.notes || '', placeholder: 'Capacity, fluid spec…' })),
        h('button', { class: 'small danger rm', type: 'button', text: 'Remove', onclick: () => row.remove() }));
      filtersBox.append(row);
    };
    (e.filters || []).forEach(fRow);
    if (!(e.filters || []).length) fRow();

    const parentSel = h('select', { id: 'f-parentId' }, h('option', { value: '', text: 'Not attached (its own machine)' }),
      S.equipment.filter(x => x.id !== e.id && !x.parentId && !childrenOf(e.id).some(k => k.id === x.id)).map(x => h('option', { value: x.id, text: x.name || 'Machine' })));
    parentSel.value = e.parentId || '';
    const unitSel = h('select', { id: 'f-meterUnit' }, h('option', { value: 'hrs', text: 'Hours' }), h('option', { value: 'mi', text: 'Miles' }), h('option', { value: 'km', text: 'Kilometres' }), h('option', { value: 'parent', text: "Uses the tractor's hours" }));
    unitSel.value = e.meterUnit || 'hrs';
    const meterField = field('Current reading', inp('meter', { type: 'number', inputmode: 'decimal', step: 'any', min: '0' }));
    const syncMeter = () => {
      const opt = unitSel.querySelector('option[value=parent]');
      opt.disabled = !parentSel.value;
      if (!parentSel.value && unitSel.value === 'parent') unitSel.value = 'hrs';
      meterField.hidden = unitSel.value === 'parent';
      ivBox.querySelectorAll('.u-every').forEach(s => s.textContent = `Every (${uTxt()})`);
      ivBox.querySelectorAll('.u-last').forEach(s => s.textContent = `Last done at (${uTxt()})`);
    };
    const uTxt = () => unitSel.value === 'parent' ? 'hrs' : unitLabel(unitSel.value);
    const dealerSel = h('select', { id: 'f-dealerId' }, h('option', { value: '', text: 'None' }), S.contacts.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map(d => h('option', { value: d.id, text: d.name || 'Dealer' })));
    dealerSel.value = e.dealerId || '';

    const ivBox = h('div', { class: 'rep' });
    const ivRow = (iv = {}) => {
      const row = h('div', { class: 'reprow', 'data-kind': 'interval', 'data-id': iv.id || uid('i') },
        h('label', { class: 'f w2' }, h('span', { text: 'Service' }), h('input', { 'data-f': 'task', value: iv.task || '', placeholder: 'Engine oil & filter' })),
        h('label', { class: 'f' }, h('span', { class: 'u-every', text: `Every (${uTxt()})` }), h('input', { 'data-f': 'everyMeter', type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: iv.everyMeter ?? '' })),
        h('label', { class: 'f' }, h('span', { text: 'Or every (months)' }), h('input', { 'data-f': 'everyMonths', type: 'number', inputmode: 'numeric', step: '1', min: '0', value: iv.everyMonths ?? '' })),
        h('label', { class: 'f' }, h('span', { class: 'u-last', text: `Last done at (${uTxt()})` }), h('input', { 'data-f': 'lastMeter', type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: iv.lastMeter ?? '' })),
        h('label', { class: 'f' }, h('span', { text: 'Last done on' }), h('input', { 'data-f': 'lastDate', type: 'date', value: iv.lastDate || '' })),
        h('label', { class: 'f w2' }, h('span', { text: 'Notes' }), h('input', { 'data-f': 'notes', value: iv.notes || '', placeholder: 'Fluid spec, capacity…' })),
        h('button', { class: 'small danger rm', type: 'button', text: 'Remove', onclick: () => row.remove() }));
      ivBox.append(row);
      return row;
    };
    (e.intervals || []).forEach(ivRow);
    parentSel.addEventListener('change', () => { if (parentSel.value && !existing) unitSel.value = 'parent'; syncMeter(); });
    unitSel.addEventListener('change', syncMeter);
    const quick = h('div', { class: 'chips', style: 'padding-top:14px' }, h('span', { class: 'muted', style: 'font-size:.85rem;align-self:center', text: 'Quick add:' }),
      COMMON.map(t => h('button', { type: 'button', class: 'small', text: '+ ' + t, onclick: () => {
        const exists = [...ivBox.querySelectorAll('[data-f=task]')].some(i => i.value.trim().toLowerCase() === t.toLowerCase());
        if (exists) { toast(t + ' is already on the list.'); return; }
        const row = ivRow({ task: t }); row.querySelector('[data-f=everyMeter]').focus();
      } })));

    const form = h('form', { class: 'stack', onsubmit: async (ev) => {
      ev.preventDefault();
      const f = (k) => form.querySelector('#f-' + k);
      const name = f('name').value.trim();
      if (!name) { toast('Give the machine a name.'); f('name').focus(); return; }
      const out = { ...(existing ? clone(findEq(existing.id)) || e : e), name };
      for (const k of ['category', 'make', 'model', 'year', 'vin', 'location']) out[k] = f(k).value.trim();
      out.vin = out.vin.toUpperCase();
      out.notes = f('notes').value.trim();
      out.parentId = parentSel.value || null;
      out.meterUnit = unitSel.value;
      out.dealerId = dealerSel.value || null;
      if (out.meterUnit !== 'parent') {
        const m = numOrNull(f('meter').value);
        if (m !== numOrNull(out.meter)) { out.meter = m; out.meterDate = m == null ? null : todayStr(); }
      }
      const val = (r, k) => r.querySelector(`[data-f=${k}]`).value.trim();
      out.filters = [...filtersBox.querySelectorAll('[data-kind=filter]')].map(r => ({ name: val(r, 'name'), number: val(r, 'number'), alt: val(r, 'alt'), qty: val(r, 'qty'), notes: val(r, 'notes') }))
        .filter(x => x.name || x.number || x.alt);
      out.intervals = [...ivBox.querySelectorAll('[data-kind=interval]')].map(r => ({ id: r.dataset.id, task: val(r, 'task'), everyMeter: numOrNull(val(r, 'everyMeter')), everyMonths: numOrNull(val(r, 'everyMonths')), lastMeter: numOrNull(val(r, 'lastMeter')), lastDate: val(r, 'lastDate') || null, notes: val(r, 'notes') }))
        .filter(iv => iv.task || iv.everyMeter || iv.everyMonths);
      if (!existing) out.createdAt = Date.now();
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Saving…';
      try { await action(existing ? 'Changes saved' : 'Machine added', () => put('equipment', out)); go('#eq-' + e.id); }
      catch (err) { showErr(err); btn.disabled = false; btn.textContent = 'Save'; }
    } },
      h('div', { class: 'panel' }, h('h2', { text: 'Machine' }),
        h('div', { class: 'fgrid' },
          field('Name *', inp('name', { placeholder: 'e.g. 2021 John Deere 4066M', required: true, autocomplete: 'off' }), 'wide'),
          field('Category', inp('category', { placeholder: 'Tractor, loader, mower…', list: 'cats' })),
          field('Make', inp('make', { placeholder: 'John Deere' })),
          field('Model', inp('model', { placeholder: '4066M' })),
          field('Year', inp('year', { inputmode: 'numeric', placeholder: '2021' })),
          field('VIN / Serial number', inp('vin', { class: 'mono', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'VIN or PIN / serial' }), 'wide'),
          field('Attached to', parentSel),
          field('Meter type', unitSel),
          meterField,
          field('Location', inp('location', { placeholder: 'Main shop' })),
          h('label', { class: 'f' }, h('span', null, 'Dealer ', h('a', { href: '#dealer-new', class: 'inl', style: 'text-transform:none;letter-spacing:0', text: '+ new' })), dealerSel),
          field('Notes', h('textarea', { id: 'f-notes', name: 'notes', value: e.notes || '', placeholder: 'Fluid capacities, quirks, grease points…' }), 'wide')),
        h('datalist', { id: 'cats' }, ['Tractor', 'Implement', 'Loader', 'Mower', 'Bucket', 'Baler', 'Tiller', 'Skid steer', 'Truck', 'Trailer', 'UTV', 'Generator'].map(c => h('option', { value: c })))),
      h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Service intervals' }), h('button', { type: 'button', class: 'small', text: '+ Add', onclick: () => ivRow() })),
        h('p', { class: 'muted', style: 'margin:14px 0 0;font-size:.88rem', text: 'Set hours, months, or both; whichever comes first counts. Leave the interval blank until you know it.' }),
        quick, ivBox),
      h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Filters & parts' }), h('button', { type: 'button', class: 'small', text: '+ Add part', onclick: () => fRow() })), filtersBox),
      h('div', { class: 'formfoot' }, h('a', { class: 'btn', href: existing ? '#eq-' + e.id : (parentPre ? '#eq-' + parentPre.id : '#'), text: 'Cancel' }), h('button', { class: 'primary', type: 'submit', text: 'Save' })));
    syncMeter();
    return h('div', null,
      h('div', { class: 'top' }, backLink(existing ? '#eq-' + e.id : (parentPre ? '#eq-' + parentPre.id : '#'), existing ? (existing.name || 'Machine') : (parentPre ? parentPre.name : 'All equipment'))),
      h('h1', { style: 'font-size:2rem;margin-bottom:16px', text: existing ? 'Edit machine' : (parentPre ? 'Add implement' : 'Add equipment') }),
      form);
  }

  // ---------- dealers ----------
  function dealersView() {
    const ds = S.contacts.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const wrap = h('div', null, h('div', { class: 'top' }, backLink('#settings', 'Settings'), h('span', { class: 'spacer' }), h('a', { class: 'btn primary small', href: '#dealer-new', text: '+ Add dealer' })),
      h('h1', { style: 'font-size:2rem;margin-bottom:16px', text: 'Dealers' }));
    if (!ds.length) wrap.append(msg('No dealers yet', 'Add the dealers and parts counters you use, then pick one for each machine.'));
    const st = h('div', { class: 'stack' });
    for (const d of ds) {
      const used = S.equipment.filter(e => e.dealerId === d.id).map(e => e.name).filter(Boolean);
      st.append(h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: d.name || 'Dealer' }), h('a', { class: 'btn small', href: '#dealer-' + d.id, text: 'Edit' })),
        dealerCard({ ...d, name: '' }), used.length ? h('p', { class: 'muted', style: 'margin:10px 0 0;font-size:.85rem', text: 'Used for: ' + used.join(', ') }) : null));
    }
    wrap.append(st);
    return wrap;
  }
  function dealerForm(id) {
    const ex = id ? findDealer(id) : null;
    if (id && !ex) return msg('Dealer not found', 'It may have been deleted.');
    const d = ex ? clone(ex) : { id: uid('d') };
    const inp = (k, attrs = {}) => h('input', { id: 'd-' + k, value: d[k] || '', ...attrs });
    const form = h('form', { class: 'stack', onsubmit: async (ev) => {
      ev.preventDefault();
      const g = (k) => form.querySelector('#d-' + k).value.trim();
      const out = { ...d, name: g('name'), contact: g('contact'), phone: g('phone'), partsPhone: g('partsPhone'), email: g('email'), website: g('website'), address: g('address'), notes: g('notes') };
      if (!out.name) { toast('Give the dealer a name.'); return; }
      try { await action(ex ? 'Dealer saved' : 'Dealer added', () => put('contacts', out)); history.length > 1 && !ex ? history.back() : go('#dealers'); }
      catch (err) { showErr(err); }
    } },
      h('div', { class: 'panel' }, h('div', { class: 'fgrid', style: 'padding-top:0' },
        field('Dealer name *', inp('name', { required: true, placeholder: 'e.g. Green Valley Equipment' }), 'wide'),
        field('Contact person', inp('contact', { placeholder: 'Service writer or parts person' })),
        field('Phone', inp('phone', { type: 'tel', inputmode: 'tel' })),
        field('Parts phone', inp('partsPhone', { type: 'tel', inputmode: 'tel' })),
        field('Email', inp('email', { type: 'email', inputmode: 'email' })),
        field('Website', inp('website', { inputmode: 'url', placeholder: 'dealer.com' })),
        field('Address', inp('address', { placeholder: 'Street, town' }), 'wide'),
        field('Notes', h('textarea', { id: 'd-notes', value: d.notes || '', placeholder: 'Hours, account number, who to ask for…' }), 'wide'))),
      h('div', { class: 'formfoot' }, h('a', { class: 'btn', href: '#dealers', text: 'Cancel' }), h('button', { class: 'primary', type: 'submit', text: 'Save' })));
    const wrap = h('div', null, h('div', { class: 'top' }, backLink('#dealers', 'Dealers')), h('h1', { style: 'font-size:2rem;margin-bottom:16px', text: ex ? 'Edit dealer' : 'Add dealer' }), form);
    if (ex) {
      const zone = h('div', { class: 'dangerzone' });
      const idle = () => zone.replaceChildren(h('button', { class: 'danger small', type: 'button', text: 'Delete dealer', onclick: () => zone.replaceChildren(
        h('span', { style: 'flex:1 1 200px', text: `Delete ${ex.name}? Machines using it will show no dealer.` }),
        h('button', { class: 'danger solid small', type: 'button', text: 'Delete', onclick: async () => { try { await action('Dealer deleted', () => del('contacts', ex.id)); go('#dealers'); } catch (err) { showErr(err); } } }),
        h('button', { class: 'small', type: 'button', text: 'Keep it', onclick: idle })) }));
      idle(); wrap.append(zone);
    }
    return wrap;
  }

  // ---------- edit history ----------
  const FIELD_NAMES = { name: 'name', category: 'category', make: 'make', model: 'model', year: 'year', vin: 'VIN', location: 'location', notes: 'notes', meter: 'hours', meterUnit: 'meter type', intervals: 'service intervals', filters: 'filters & parts', dealerId: 'dealer', parentId: 'attached to', gallons: 'gallons', cost: 'cost', date: 'date', work: 'work done', parts: 'parts', phone: 'phone', partsPhone: 'parts phone', address: 'address', email: 'email', website: 'website', contact: 'contact' };
  function describe(hrow) {
    const b = hrow.before && hrow.before.data, a = hrow.after && hrow.after.data, d = a || b || {};
    if (hrow.table_name === 'equipment') {
      if (hrow.action === 'insert') return `Added ${d.name || 'machine'}`;
      if (hrow.action === 'delete') return `Deleted ${d.name || 'machine'}`;
      const changed = Object.keys({ ...b, ...a }).filter(k => !['updatedAt', 'updatedBy', 'meterDate', 'createdAt'].includes(k) && JSON.stringify(b[k]) !== JSON.stringify(a[k]));
      const parts = changed.map(k => k === 'meter' ? `hours ${b.meter ?? '—'} → ${a.meter ?? '—'}` : (FIELD_NAMES[k] || k));
      return `${d.name || 'Machine'}: changed ${parts.join(', ') || 'details'}`;
    }
    if (hrow.table_name === 'logs') {
      const m = (findEq(d.equipmentId) || {}).name || 'machine';
      if (d.kind === 'fuel') return hrow.action === 'insert' ? `${m}: fuel ${d.gallons} gal` : hrow.action === 'delete' ? `${m}: removed fuel entry (${d.gallons} gal)` : `${m}: edited fuel entry`;
      const t = (d.taskNames || []).join(', ') || 'service';
      return hrow.action === 'insert' ? `${m}: logged ${t}` : hrow.action === 'delete' ? `${m}: removed service entry (${t})` : `${m}: edited service entry`;
    }
    return hrow.action === 'insert' ? `Added dealer ${d.name || ''}` : hrow.action === 'delete' ? `Deleted dealer ${d.name || ''}` : `Edited dealer ${d.name || ''}`;
  }
  function historyView(id) {
    const e = id ? findEq(id) : null;
    const wrap = h('div', null, h('div', { class: 'top' }, id ? backLink('#eq-' + id, (e && e.name) || 'Machine') : backLink('#settings', 'Settings')),
      h('h1', { style: 'font-size:2rem;margin-bottom:4px', text: 'Edit history' }),
      h('p', { class: 'muted', style: 'margin:0 0 16px', text: (id ? (e && e.name) + ': ' : 'All machines: ') + 'every change, newest first. Undo puts a record back the way it was before that change.' }));
    const box = h('div', { class: 'panel' }, h('p', { class: 'muted', style: 'margin:0', text: 'Loading…' }));
    wrap.append(box);
    (async () => {
      try {
        let q = S.sb.from('history').select('*').order('at', { ascending: false }).limit(150);
        if (id) q = q.or(`row_id.eq.${id},after->data->>equipmentId.eq.${id},before->data->>equipmentId.eq.${id}`);
        const { data, error } = await q;
        if (error) throw error;
        box.replaceChildren();
        if (!data.length) box.append(h('p', { class: 'muted', style: 'margin:0', text: 'No changes recorded yet.' }));
        for (const r of data) {
          const who = (() => { try { return decodeURIComponent(r.by || ''); } catch { return r.by; } })() || 'Someone';
          const act = h('span');
          const idle = () => act.replaceChildren(h('button', { class: 'small', type: 'button', text: 'Undo', onclick: () => act.replaceChildren(
            h('button', { class: 'small primary', type: 'button', text: 'Put it back', onclick: async () => {
              try {
                await action('Change undone', async () => {
                  if (r.before) await put(r.table_name, fromRow(r.table_name, r.before)); else await del(r.table_name, r.row_id);
                });
                route();
              } catch (err) { showErr(err); }
            } }),
            h('button', { class: 'small', type: 'button', text: 'Cancel', onclick: idle })) }));
          idle();
          box.append(h('div', { class: 'entry' },
            h('div', { class: 'eh' }, h('span', { class: 'muted num', style: 'font-size:.85rem', text: new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }),
              h('span', { class: 'muted', style: 'font-size:.85rem', text: who }), h('span', { style: 'flex:1' }), act),
            h('p', { text: describe(r) })));
        }
      } catch (err) {
        console.error(err);
        box.replaceChildren(h('p', { class: 'muted', style: 'margin:0', text: 'Edit history needs a connection. Try again when you have signal.' }));
      }
    })();
    return wrap;
  }

  // ---------- settings: name, alerts, dealers, backup ----------
  function b64ToU8(s) { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); }
  async function sha(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].slice(0, 16).map(x => x.toString(16).padStart(2, '0')).join(''); }
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isStandalone = () => navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  async function saveSub(sub, hours) {
    const id = await sha(sub.endpoint);
    const { error } = await S.sb.from('push_subs').upsert({ id, sub: sub.toJSON(), url: appUrl(), name: S.myName, hours_before: hours, days_before: 7, enabled: true });
    if (error) throw error;
    ls.set('ruxer-push-id', id);
    return id;
  }
  function settingsView() {
    const wrap = h('div', null, h('div', { class: 'top' }, backLink('#', 'All equipment')), h('h1', { style: 'font-size:2rem;margin-bottom:16px', text: 'Settings' }));
    const st = h('div', { class: 'stack' });
    wrap.append(st);
    // name
    const nameIn = h('input', { id: 's-name', value: S.myName, autocomplete: 'name' });
    st.append(h('form', { class: 'panel', onsubmit: (ev) => { ev.preventDefault(); const n = nameIn.value.trim(); if (!n) return; S.myName = n; ls.set('ruxer-name', n); toast('Name saved'); nameIn.blur(); } },
      h('h2', { text: 'Your name' }),
      h('div', { class: 'meterform', style: 'margin:14px 0 0' }, field('Shown on what you log from this phone', nameIn), h('button', { class: 'primary', type: 'submit', text: 'Save' }))));
    // alerts
    const alerts = h('div', { class: 'panel' }, h('h2', { text: 'Due-soon alerts' }));
    const body = h('div', { class: 'stack', style: 'padding-top:14px' });
    alerts.append(body);
    st.append(alerts);
    const drawAlerts = async () => {
      body.replaceChildren();
      const hoursIn = h('input', { id: 's-hours', type: 'number', inputmode: 'numeric', min: '1', step: '1', value: alertHours() });
      const hoursForm = h('form', { class: 'meterform', style: 'margin:0', onsubmit: async (ev) => {
        ev.preventDefault();
        const v = numOrNull(hoursIn.value); if (!v || v < 1) { toast('Enter a number of hours.'); return; }
        ls.set('ruxer-alert-hours', String(v)); hoursIn.blur();
        const id = ls.get('ruxer-push-id');
        if (id) { const { error } = await S.sb.from('push_subs').update({ hours_before: v }).eq('id', id); if (error) { showErr(error); return; } }
        toast(`Alerts set to ${v} hours before due`); render(true);
      } }, field('Warn me this many hours before a service is due', hoursIn), h('button', { type: 'submit', text: 'Save' }));
      if (!pushSupported()) {
        body.append(h('p', { style: 'margin:0', text: isIOS() && !isStandalone() ? 'On iPhone, alerts only work from the home-screen app. Open Ruxer Farms from its home-screen icon, then come back to Settings.' : 'This browser cannot show alerts. Use the home-screen app on your phone.' }), hoursForm);
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const on = !!sub && !!ls.get('ruxer-push-id') && Notification.permission === 'granted';
      const toggle = h('button', { class: on ? '' : 'primary', type: 'button', text: on ? 'Turn off alerts' : 'Turn on alerts', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          if (on) {
            const id = ls.get('ruxer-push-id');
            if (id) await S.sb.from('push_subs').delete().eq('id', id);
            if (sub) await sub.unsubscribe();
            ls.del('ruxer-push-id'); toast('Alerts turned off');
          } else {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') { toast(perm === 'denied' ? 'Alerts are blocked. Allow them in iPhone Settings › Notifications › Ruxer Farms.' : 'Alerts were not allowed.'); btn.disabled = false; return; }
            const r = await navigator.serviceWorker.ready;
            const s = (await r.pushManager.getSubscription()) || await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(CFG.vapidPublicKey) });
            await saveSub(s, alertHours());
            toast('Alerts on'); updateBadge();
          }
        } catch (err) { showErr(err); }
        drawAlerts();
      } });
      body.append(
        h('p', { style: 'margin:0' }, on ? ['Alerts are ', h('b', { text: 'on' }), ` for this phone. You get a notification when a service is within ${alertHours()} hours (or 7 days for time-based services), and again if it goes overdue.`]
          : 'Get a notification on this phone when a service is coming due, even when the app is closed.'),
        h('div', { class: 'chips' }, toggle, on ? h('button', { type: 'button', text: 'Send a test alert', onclick: async (ev) => {
          ev.currentTarget.disabled = true;
          try {
            const res = await fetch(CFG.supabaseUrl + '/functions/v1/notify-due', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.supabaseAnonKey, 'x-farm-key': KEY }, body: JSON.stringify({ test: true, id: ls.get('ruxer-push-id') }) });
            toast(res.ok ? 'Test alert sent. It should arrive in a few seconds.' : 'The test alert could not be sent.');
          } catch { toast('The test alert needs a connection.'); }
        } }) : null),
        hoursForm,
        Notification.permission === 'denied' ? h('p', { class: 'muted', style: 'margin:0;font-size:.85rem', text: 'Alerts are blocked for this app. To allow them: iPhone Settings › Notifications › Ruxer Farms › Allow Notifications.' }) : null);
    };
    drawAlerts().catch(err => { console.error(err); body.replaceChildren(h('p', { class: 'muted', style: 'margin:0', text: 'Alerts are not available here.' })); });
    // dealers + history
    st.append(h('div', { class: 'panel' }, h('h2', { text: 'Dealers & history' }),
      h('div', { class: 'chips', style: 'padding-top:14px' }, h('a', { class: 'btn', href: '#dealers', text: `Dealers (${S.contacts.length})` }), h('a', { class: 'btn', href: '#history', text: 'Edit history and undo' }))));
    // backup
    const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: () => restorePick(fileIn, restoreBox) });
    const restoreBox = h('div');
    st.append(h('div', { class: 'panel' }, h('h2', { text: 'Backup & export' }),
      h('p', { class: 'muted', style: 'margin:14px 0 0;font-size:.9rem', text: 'Save a full backup to Files or send it by email. Spreadsheets open in Excel, Numbers or Google Sheets.' }),
      h('div', { class: 'chips', style: 'padding-top:12px' },
        h('button', { class: 'primary', type: 'button', text: 'Full backup', onclick: () => exportBackup() }),
        h('button', { type: 'button', text: 'Service log (spreadsheet)', onclick: () => exportServiceCsv() }),
        h('button', { type: 'button', text: 'Fuel log (spreadsheet)', onclick: () => exportFuelCsv() }),
        h('button', { type: 'button', text: 'Equipment list (spreadsheet)', onclick: () => exportEquipmentCsv() }),
        h('button', { type: 'button', text: 'Restore from backup…', onclick: () => fileIn.click() })),
      fileIn, restoreBox));
    // sync
    st.append(h('div', { class: 'panel' }, h('h2', { text: 'Offline' }),
      h('p', { style: 'margin:14px 0 0' }, S.outbox.length ? `${S.outbox.length} change${S.outbox.length === 1 ? '' : 's'} saved on this phone, waiting for signal.` : 'Everything on this phone is synced.'),
      S.outbox.length ? h('div', { class: 'chips', style: 'padding-top:12px' }, h('button', { type: 'button', text: 'Try to sync now', onclick: async () => { await flush(); render(true); } })) : null));
    return wrap;
  }

  // ---------- export / backup ----------
  async function shareFile(name, text, type) {
    const blob = new Blob([text], { type });
    try {
      const file = new File([blob], name, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (err) { if (err && err.name === 'AbortError') return; }
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  const stamp = () => todayStr();
  const csv = (rows) => '﻿' + rows.map(r => r.map(v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
  const eqName = (id) => (findEq(id) || {}).name || '';
  function exportBackup() {
    const data = { app: 'ruxer-farms', version: 2, exportedAt: new Date().toISOString(),
      equipment: S.equipment.map(o => toRow('equipment', o)), logs: S.logs.map(o => toRow('logs', o)), contacts: S.contacts.map(o => toRow('contacts', o)) };
    shareFile(`ruxer-farms-backup-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
  }
  function exportServiceCsv() {
    const rows = S.logs.filter(l => l.kind !== 'fuel').sort((a, b) => String(a.date).localeCompare(String(b.date)));
    shareFile(`ruxer-service-log-${stamp()}.csv`, csv([['Date', 'Machine', 'Meter', 'Services', 'Work done', 'Parts', 'Cost', 'By'],
      ...rows.map(l => [l.date, eqName(l.equipmentId), l.meter, (l.taskNames || []).join('; '), l.work, l.parts, l.cost, l.by])]), 'text/csv');
  }
  function exportFuelCsv() {
    const rows = S.logs.filter(l => l.kind === 'fuel').sort((a, b) => String(a.date).localeCompare(String(b.date)));
    shareFile(`ruxer-fuel-log-${stamp()}.csv`, csv([['Date', 'Machine', 'Meter', 'Gallons', 'Cost', 'Notes', 'By'],
      ...rows.map(l => [l.date, eqName(l.equipmentId), l.meter, l.gallons, l.cost, l.notes, l.by])]), 'text/csv');
  }
  function exportEquipmentCsv() {
    shareFile(`ruxer-equipment-${stamp()}.csv`, csv([['Name', 'Category', 'Make', 'Model', 'Year', 'VIN / Serial', 'Meter', 'Unit', 'Attached to', 'Dealer', 'Parts', 'Service intervals', 'Notes'],
      ...S.equipment.map(e => { const q = effEq(e); return [e.name, e.category, e.make, e.model, e.year, e.vin, q.meter, unitLabel(q.meterUnit), eqName(e.parentId), (findDealer(e.dealerId) || {}).name,
        (e.filters || []).map(f => `${f.name}: ${f.number}`).join('; '), (e.intervals || []).map(iv => `${iv.task} (${everyText(iv, unitLabel(q.meterUnit)).replace(/^Every /, '')})`).join('; '), e.notes]; })]), 'text/csv');
  }
  function restorePick(fileIn, box) {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      let data;
      try { data = JSON.parse(rd.result); if (data.app !== 'ruxer-farms') throw 0; } catch { box.replaceChildren(h('p', { class: 'muted', text: 'That file is not a Ruxer Farms backup.' })); return; }
      const n = (k) => (data[k] || []).length;
      box.replaceChildren(h('div', { class: 'confirmbox' },
        h('p', { style: 'margin:0', text: `Backup from ${data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'unknown date'}: ${n('equipment')} machines, ${n('logs')} log entries, ${n('contacts')} dealers. Restoring puts back anything missing and replaces records that exist in both. Nothing else is deleted.` }),
        h('div', { class: 'chips' },
          h('button', { class: 'primary', type: 'button', text: 'Restore', onclick: async (ev) => {
            ev.currentTarget.disabled = true;
            try {
              for (const t of TABLES) { const rows = data[t] || []; if (rows.length) { const { error } = await S.sb.from(t).upsert(rows); if (error) throw error; } }
              TABLES.forEach(announce); await loadAll(); box.replaceChildren(); toast('Backup restored');
            } catch (err) { showErr(err); ev.currentTarget.disabled = false; }
          } }),
          h('button', { type: 'button', text: 'Cancel', onclick: () => box.replaceChildren() }))));
    };
    rd.readAsText(f);
  }

  // ---------- boot ----------
  window.addEventListener('online', () => { flush().then(() => loadAll()); });
  window.addEventListener('offline', () => { S.offline = true; render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.sb && !S.needName) flush().then(() => loadAll()); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(err => console.error('Service worker', err));

  (async () => {
    if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) { S.setupMissing = true; render(true); return; }
    if (!KEY) { S.badLink = true; render(true); return; }
    if (KEY) ls.set('ruxer-key-seen', '1');
    try { S.outbox = JSON.parse(ls.get('ruxer-outbox') || '[]'); } catch { S.outbox = []; }
    S.myName = ls.get('ruxer-name') || '';
    S.needName = !S.myName;
    // Show the saved copy right away, then refresh from the server.
    if (loadCache()) { for (const op of S.outbox) applyLocal(op); S.loaded = true; }
    render(true);
    if (!window.supabase) { S.offline = true; S.loaded = true; render(true); return; }
    const baseFetch = window.fetch.bind(window);
    S.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (url, opts = {}) => { const hd = new Headers(opts.headers || {}); hd.set('x-farm-key', KEY); hd.set('x-user-name', encodeURIComponent(S.myName || '')); return baseFetch(url, { ...opts, headers: hd }); } }
    });
    try {
      const { data: ok, error } = await S.sb.rpc('farm_key_ok');
      if (!error && ok !== true) { S.badLink = true; render(true); return; }
    } catch { }
    await flush();
    await loadAll();
    let t;
    channel = S.sb.channel('ruxer-changes', { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'changed' }, ({ payload }) => {
        clearTimeout(t);
        const tb = payload && TABLES.includes(payload.table) ? payload.table : null;
        t = setTimeout(() => (tb ? loadTable(tb) : Promise.all(TABLES.map(loadTable))).then(() => { saveCache(); render(); updateBadge(); }).catch(() => {}), 200);
      })
      .subscribe();
    setInterval(() => { if (document.visibilityState === 'visible') loadAll(); }, 120000);
  })();
})();
