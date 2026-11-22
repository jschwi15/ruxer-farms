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
    sb: null, myName: '', equipment: [], logs: [], contacts: [], tanks: [], inventory: [], invSearch: '',
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
  const TABLES = ['equipment', 'logs', 'contacts', 'tanks', 'inventory'];
  const listOf = (t) => t === 'equipment' ? S.equipment : t === 'logs' ? S.logs : t === 'tanks' ? S.tanks : t === 'inventory' ? S.inventory : S.contacts;
  function setList(t, arr) { if (t === 'equipment') S.equipment = arr; else if (t === 'logs') S.logs = arr; else if (t === 'tanks') S.tanks = arr; else if (t === 'inventory') S.inventory = arr; else S.contacts = arr; }
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
  function saveCache() { ls.set('ruxer-cache', JSON.stringify({ equipment: S.equipment, logs: S.logs, contacts: S.contacts, tanks: S.tanks, inventory: S.inventory, at: Date.now() })); }
  function loadCache() {
    try { const c = JSON.parse(ls.get('ruxer-cache') || 'null'); if (c) { S.equipment = c.equipment || []; S.logs = c.logs || []; S.contacts = c.contacts || []; S.tanks = c.tanks || []; S.inventory = c.inventory || []; S.cacheAt = c.at; return true; } } catch { }
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
      await loadPhotos().catch(err => console.error('photos', err));
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
    if (s === 'inventory') return { name: 'inventory' };
    if (s === 'item-new') return { name: 'item', id: null };
    if ((m = s.match(/^item-([A-Za-z0-9]+)$/))) return { name: 'item', id: m[1] };
    if (s === 'tank-new') return { name: 'tankedit', id: null };
    if ((m = s.match(/^tankedit-([A-Za-z0-9]+)$/))) return { name: 'tankedit', id: m[1] };
    if ((m = s.match(/^tank-([A-Za-z0-9]+)$/))) return { name: 'tank', id: m[1] };
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
  const FORM_VIEWS = ['edit', 'log', 'dealer', 'settings', 'tankedit', 'item'];
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
    else if (v.name === 'inventory') node = inventoryView();
    else if (v.name === 'item') { node = itemForm(v.id); S.formShown = true; }
    else if (v.name === 'tank') node = tankView(v.id);
    else if (v.name === 'tankedit') { node = tankForm(v.id); S.formShown = true; }
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
      for (const t of S.tanks) if (tankState(t).low) n++;
      n += S.inventory.filter(itemLow).length;
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
      h('a', { class: 'btn small', href: '#inventory' }, 'Inventory', S.inventory.some(itemLow) ? h('span', { class: 'dot', 'aria-label': 'items low' }) : null),
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
    if (S.tanks.length) frag.append(h('div', { class: 'tanks' }, S.tanks.map(tankCard)));
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
    frag.append(photosPanel(e));
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
    return h('div', { class: 'stack', style: 'padding-top:14px;gap:10px' },
      d.name ? h('b', { style: 'font-size:1.1rem', text: d.name }) : null,
      d.address ? h('a', { class: 'inl', href: 'https://maps.apple.com/?q=' + encodeURIComponent(d.address), target: '_blank', rel: 'noopener', text: d.address }) : null,
      d.account ? h('div', { class: 'acct' }, h('span', { class: 'muted', text: 'Account #' }), h('b', { class: 'mono', text: d.account }),
        h('button', { class: 'small', type: 'button', text: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(d.account); toast('Account number copied'); } catch { toast('Account # ' + d.account); } } })) : null,
      d.phone ? h('a', { class: 'btn primary', style: 'justify-self:start', href: 'tel:' + d.phone.replace(/[^\d+]/g, ''), text: '☎ Call ' + d.phone }) : null);
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
      l.parts ? h('p', { class: 'muted' }, 'Parts: ', l.parts) : null,
      (() => { const rs = S.photos.filter(ph => ph.log_id === l.id); return rs.length ? h('div', { class: 'rthumbs' }, rs.map(ph => h('button', { type: 'button', class: 'thumb', onclick: () => viewPhoto(ph.id), 'aria-label': 'Open receipt' }, h('img', { src: ph.thumb, alt: '' })))) : null; })()));
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
      h('div', null, h('b', { class: 'num', text: yr.length }), h('span', { text: `Fill-ups in ${year}` }))));
    const form = h('form', { class: 'panel', onsubmit: async (ev) => {
      ev.preventDefault();
      const el = form.elements;
      const gallons = numOrNull(el.gallons.value);
      if (gallons == null || gallons <= 0) { toast('Enter how many gallons went in.'); el.gallons.focus(); return; }
      const meter = numOrNull(el.fmeter.value);
      const entry = { id: uid('f'), kind: 'fuel', equipmentId: e.id, tankId: el.fsrc ? (el.fsrc.value || null) : null, date: el.fdate.value || todayStr(), meter, gallons, notes: el.fnotes.value.trim(), by: S.myName, createdAt: Date.now() };
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
        S.tanks.length ? (() => { const sel = h('select', { id: 'fsrc', name: 'fsrc' }, S.tanks.map(t => h('option', { value: t.id, text: t.name || 'Fuel tank' })), h('option', { value: '', text: 'Somewhere else (station, can)' }));
          const last = ls.get('ruxer-fsrc-' + e.id); sel.value = last != null && (last === '' || findTank(last)) ? last : S.tanks[0].id;
          sel.addEventListener('change', () => ls.set('ruxer-fsrc-' + e.id, sel.value));
          return field('Filled from', sel, 'wide'); })() : null,
        field('Date', h('input', { id: 'fdate', name: 'fdate', type: 'date', value: todayStr() })),
        field('Gallons', h('input', { id: 'gallons', name: 'gallons', type: 'number', inputmode: 'decimal', step: 'any', min: '0', required: true })),
        field(`${meterName(eq.meterUnit)} (${u})`, h('input', { id: 'fmeter', name: 'fmeter', type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: eq.meter ?? '' })),
        field('Notes', h('input', { id: 'fnotes', name: 'fnotes', placeholder: 'Diesel, DEF, anything worth noting' }), 'wide')),
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
        f.tankId ? h('span', { class: 'muted', text: 'from ' + ((findTank(f.tankId) || {}).name || 'tank') }) : null,
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

  // ---------- inventory ----------
  const INV_CATS = ['Grease', 'Oil & fluids', 'Filters', 'Parts', 'Belts & hoses', 'Shop supplies', 'Other'];
  const findItem = (id) => S.inventory.find(i => i.id === id);
  const itemLow = (i) => numOrNull(i.minQty) != null && (numOrNull(i.qty) ?? 0) <= numOrNull(i.minQty);
  const invTimers = {};
  function adjustItem(id, delta) {
    const it = findItem(id); if (!it) return;
    const next = Math.max(0, Math.round(((numOrNull(it.qty) ?? 0) + delta) * 100) / 100);
    applyLocal({ op: 'put', table: 'inventory', row: toRow('inventory', { ...it, qty: next }) });
    render(true);
    // Save once the taps stop, so a run of taps is a single change.
    clearTimeout(invTimers[id]);
    invTimers[id] = setTimeout(() => { const cur = findItem(id); if (cur) put('inventory', { ...cur, updatedBy: S.myName }, false).catch(showErr); }, 900);
  }
  function inventoryView() {
    const wrap = h('div', null, h('div', { class: 'top' }, backLink('#', 'All equipment'), h('span', { class: 'spacer' }), h('a', { class: 'btn primary small', href: '#item-new', text: '+ Add item' })),
      h('h1', { style: 'font-size:2rem;margin-bottom:14px', text: 'Inventory' }));
    const items = S.inventory.slice();
    if (!items.length) { wrap.append(msg('Nothing in inventory yet', 'Add grease, oil, filters and other supplies you keep on hand. Set a reorder amount and the item shows Low when you get down to it.')); return wrap; }
    const low = items.filter(itemLow);
    if (low.length) wrap.append(h('div', { class: 'banner', style: 'color:var(--bad)' }, h('b', { text: `${low.length} item${low.length === 1 ? '' : 's'} low: ` }), low.map(i => i.name).join(', ')));
    const listBox = h('div', { class: 'stack' });
    const draw = () => {
      const q = S.invSearch.trim().toLowerCase();
      const shown = items.filter(i => !q || [i.name, i.category, i.partNumber, i.notes].join(' ').toLowerCase().includes(q));
      const groups = {};
      for (const i of shown) (groups[i.category || 'Other'] ||= []).push(i);
      const order = [...INV_CATS, ...Object.keys(groups).filter(c => !INV_CATS.includes(c))];
      listBox.replaceChildren(...order.filter(c => groups[c]).map(c => h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: c }), h('span', { class: 'muted', text: String(groups[c].length) })),
        groups[c].sort((a, b) => Number(itemLow(b)) - Number(itemLow(a)) || String(a.name).localeCompare(String(b.name))).map(invRow))));
      if (!shown.length) listBox.append(h('p', { class: 'muted', text: 'Nothing matches that search.' }));
    };
    if (items.length > 5) wrap.append(h('div', { class: 'toolbar' }, h('input', { id: 'inv-search', type: 'search', placeholder: 'Search name or part number', value: S.invSearch, 'aria-label': 'Search inventory', oninput: (ev) => { S.invSearch = ev.target.value; draw(); } })));
    draw();
    wrap.append(listBox);
    return wrap;
  }
  function invRow(i) {
    const lowNow = itemLow(i);
    return h('div', { class: 'invrow' },
      h('a', { class: 'invname', href: '#item-' + i.id },
        h('b', { text: i.name || 'Item' }),
        h('span', { class: 'muted', text: [i.partNumber, numOrNull(i.minQty) != null ? `reorder at ${fmtN(i.minQty)}` : null].filter(Boolean).join(' · ') })),
      h('div', { class: 'invqty' },
        h('button', { type: 'button', class: 'qbtn', 'aria-label': `Use one ${i.name}`, text: '−', onclick: () => adjustItem(i.id, -1) }),
        h('div', { class: 'qv' }, h('b', { class: 'num', style: lowNow ? 'color:var(--bad)' : '', text: fmtN(numOrNull(i.qty) ?? 0) }), h('span', { class: 'muted', text: i.unit || '' })),
        h('button', { type: 'button', class: 'qbtn', 'aria-label': `Add one ${i.name}`, text: '+', onclick: () => adjustItem(i.id, 1) })),
      lowNow ? h('span', { class: 'chipst s-due invlow', text: 'Low' }) : null);
  }
  function itemForm(id) {
    const ex = id ? findItem(id) : null;
    if (id && !ex) return msg('Item not found', 'It may have been deleted.');
    const it = ex ? clone(ex) : { id: uid('n'), category: 'Grease', qty: 0, unit: '' };
    const inp = (k, attrs = {}) => h('input', { id: 'n-' + k, value: it[k] ?? '', ...attrs });
    const catSel = h('select', { id: 'n-category' }, INV_CATS.map(c => h('option', { value: c, text: c })));
    catSel.value = INV_CATS.includes(it.category) ? it.category : 'Other';
    const dealerSel = h('select', { id: 'n-dealerId' }, h('option', { value: '', text: 'None' }), S.contacts.map(d => h('option', { value: d.id, text: d.name || 'Dealer' })));
    dealerSel.value = it.dealerId || '';
    const pn = inp('partNumber', { class: 'mono', placeholder: 'Optional' });
    const form = h('form', { class: 'stack', onsubmit: async (ev) => {
      ev.preventDefault();
      const g = (k) => form.querySelector('#n-' + k).value.trim();
      const out = { ...it, name: g('name'), category: catSel.value, qty: numOrNull(g('qty')) ?? 0, unit: g('unit'), minQty: numOrNull(g('minQty')), partNumber: g('partNumber'), dealerId: dealerSel.value || null, notes: g('notes') };
      if (!out.name) { toast('Give the item a name.'); return; }
      try { await action(ex ? 'Item saved' : 'Item added', () => put('inventory', out)); go('#inventory'); } catch (err) { showErr(err); }
    } },
      h('div', { class: 'panel' }, h('div', { class: 'fgrid', style: 'padding-top:0' },
        field('Item name *', inp('name', { required: true, placeholder: 'e.g. John Deere Grease-Gard tubes' }), 'wide'),
        field('Category', catSel),
        field('Unit', inp('unit', { list: 'units', placeholder: 'tubes, gal, qt, each' })),
        field('On hand', inp('qty', { type: 'number', inputmode: 'decimal', step: 'any', min: '0' })),
        field('Reorder at (optional)', inp('minQty', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', placeholder: 'e.g. 5' })),
        h('div', { class: 'f' }, h('span', { class: 'flabel', text: 'Part number' }), h('div', { class: 'inrow' }, pn, h('button', { type: 'button', class: 'small scanbtn', text: '📷', 'aria-label': 'Scan part number from a photo', onclick: () => scanInto(pn, 'part', null) }))),
        field('Buy from', dealerSel),
        field('Notes', inp('notes', { placeholder: 'Size, spec, which machines use it' }), 'wide')),
        h('datalist', { id: 'units' }, ['tubes', 'gal', 'qt', 'each', 'cases', 'boxes', 'lb', 'ft'].map(u => h('option', { value: u })))),
      h('div', { class: 'formfoot' }, h('a', { class: 'btn', href: '#inventory', text: 'Cancel' }), h('button', { class: 'primary', type: 'submit', text: 'Save' })));
    const wrap = h('div', null, h('div', { class: 'top' }, backLink('#inventory', 'Inventory')), h('h1', { style: 'font-size:2rem;margin-bottom:16px', text: ex ? 'Edit item' : 'Add item' }), form);
    if (ex) {
      const zone = h('div', { class: 'dangerzone' });
      const idle = () => zone.replaceChildren(h('button', { class: 'danger small', type: 'button', text: 'Delete item', onclick: () => zone.replaceChildren(
        h('span', { style: 'flex:1 1 200px', text: `Delete ${ex.name}? You can undo right after.` }),
        h('button', { class: 'danger solid small', type: 'button', text: 'Delete', onclick: async () => { try { await action('Item deleted', () => del('inventory', ex.id)); go('#inventory'); } catch (err) { showErr(err); } } }),
        h('button', { class: 'small', type: 'button', text: 'Keep it', onclick: idle })) }));
      idle(); wrap.append(zone);
    }
    return wrap;
  }

  // ---------- fuel tanks ----------
  // Level = last gauge reading ('tanklevel'), plus deliveries, minus machine fills drawn from the tank.
  const findTank = (id) => S.tanks.find(t => t.id === id);
  function tankEvents(t) {
    return S.logs.filter(l => (l.equipmentId === t.id && (l.kind === 'delivery' || l.kind === 'tanklevel')) || (l.kind === 'fuel' && l.tankId === t.id))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.createdAt || 0) - (b.createdAt || 0));
  }
  function tankLevel(t) {
    let level = null;
    for (const e of tankEvents(t)) {
      const g = numOrNull(e.kind === 'tanklevel' ? e.level : e.gallons) || 0;
      if (e.kind === 'tanklevel') level = g; else if (e.kind === 'delivery') level = (level ?? 0) + g; else level = (level ?? 0) - g;
    }
    return level;
  }
  function tankState(t) {
    const level = tankLevel(t), cap = numOrNull(t.capacity), alertAt = numOrNull(t.alertAt);
    const pct = level != null && cap ? Math.max(0, Math.min(1, level / cap)) : null;
    const low = level != null && alertAt != null && level <= alertAt;
    const level2 = low ? 'due' : (pct != null && alertAt != null && cap && level <= alertAt + cap * 0.1) ? 'soon' : level == null ? 'unknown' : 'ok';
    return { level, cap, alertAt, pct, low, status: level2 };
  }
  function tankBar(t, st, big) {
    const fill = st.pct != null ? Math.round(st.pct * 100) : 0;
    const mark = st.cap && st.alertAt != null ? Math.max(0, Math.min(100, (st.alertAt / st.cap) * 100)) : null;
    return h('div', { class: 'tankbar' + (big ? ' big' : ''), role: 'img', 'aria-label': st.level == null ? 'Tank level unknown' : `${fmtN(Math.max(0, st.level))} gallons${st.cap ? ' of ' + fmtN(st.cap) : ''}` },
      h('i', { class: 's-' + st.status, style: `width:${fill}%` }),
      mark != null ? h('b', { class: 'mark', style: `left:${mark}%`, title: 'Reorder point' }) : null);
  }
  function tankSummary(st) {
    if (st.level == null) return 'Level not set yet';
    const lv = `${fmtN(Math.max(0, st.level))} gal`;
    return st.cap ? `${lv} of ${fmtN(st.cap)} gal · ${Math.round(st.pct * 100)}%` : `${lv} · set the capacity to see the bar`;
  }
  function tankCard(t) {
    const st = tankState(t);
    return h('a', { class: 'tankcard', href: '#tank-' + t.id },
      h('div', { class: 'tc-top' }, h('div', { style: 'min-width:0' }, h('div', { class: 'eyebrow', text: t.fuelType || 'Fuel' }), h('h3', { text: t.name || 'Fuel tank' })),
        st.low ? h('span', { class: 'chipst s-due', text: 'Reorder' }) : st.status === 'soon' ? h('span', { class: 'chipst s-soon', text: 'Getting low' }) : st.level == null ? h('span', { class: 'chipst', text: 'Set level' }) : h('span', { class: 'chipst s-ok', text: 'OK' })),
      tankBar(t, st),
      h('div', { class: 'muted num', style: 'font-size:.9rem', text: tankSummary(st) }));
  }
  function tankView(id) {
    const t = findTank(id);
    if (!t) return h('div', null, h('div', { class: 'top' }, backLink('#', 'All equipment')), msg('Tank not found', 'It may have been deleted.'));
    const st = tankState(t);
    const wrap = h('div', { class: 'stack' });
    wrap.append(h('div', { class: 'top', style: 'margin-bottom:0' }, backLink('#', 'All equipment'), h('span', { class: 'spacer' }), h('a', { class: 'btn small', href: '#tankedit-' + t.id, text: 'Edit' })));
    wrap.append(h('div', { class: 'panel stack' },
      h('div', null, h('div', { class: 'eyebrow', text: t.fuelType || 'Fuel' }), h('h1', { style: 'font-size:2rem', text: t.name || 'Fuel tank' })),
      h('div', { class: 'tankbig num' }, st.level == null ? '—' : fmtN(Math.max(0, st.level)), h('span', { text: st.level == null ? '' : ' gal' + (st.cap ? ` of ${fmtN(st.cap)}` : '') })),
      tankBar(t, st, true),
      h('div', { class: 'muted', style: 'font-size:.9rem' },
        st.cap ? `${Math.round((st.pct || 0) * 100)}% full` : 'Capacity not set. ', !st.cap ? h('a', { class: 'inl', href: '#tankedit-' + t.id, text: 'Set capacity' }) : null,
        st.alertAt != null ? ` · Reorder at ${fmtN(st.alertAt)} gal` : (st.cap ? ' · ' : ''), st.alertAt == null ? h('a', { class: 'inl', href: '#tankedit-' + t.id, text: 'Set reorder alert' }) : null),
      st.low ? h('div', { class: 'banner', style: 'margin:0;color:var(--bad)', text: `Time to reorder: ${fmtN(Math.max(0, st.level))} gal left, at or below the ${fmtN(st.alertAt)} gal reorder point.` }) : null,
      st.level != null && st.level < 0 ? h('p', { class: 'muted', style: 'margin:0;font-size:.85rem', text: 'More fuel has been drawn than recorded. Use Set level to enter what the gauge reads.' }) : null));

    // delivery + set level forms
    let receipts = [];
    const rNote = h('span', { class: 'muted', style: 'font-size:.85rem' });
    const dForm = h('form', { class: 'panel', onsubmit: async (ev) => {
      ev.preventDefault();
      const g = numOrNull(dForm.querySelector('#dgal').value);
      if (!g || g <= 0) { toast('Enter how many gallons were delivered.'); return; }
      const entry = { id: uid('t'), kind: 'delivery', equipmentId: t.id, date: dForm.querySelector('#ddate').value || todayStr(), gallons: g,
        cost: numOrNull(dForm.querySelector('#dcost').value), supplier: dForm.querySelector('#dsup').value.trim(), by: S.myName, createdAt: Date.now() };
      const btn = dForm.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        await action(`${fmtN(g)} gal delivery added`, () => put('logs', entry));
        if (receipts.length) { btn.textContent = 'Saving receipt…'; try { await savePhotos(t.id, receipts, 'receipt', entry.id); } catch (err) { showErr(err); } }
        S.formShown = false; render(true);
      } catch (err) { showErr(err); btn.disabled = false; }
    } },
      h('h2', { text: 'Add delivery' }),
      h('div', { class: 'fgrid' },
        field('Date', h('input', { id: 'ddate', type: 'date', value: todayStr() })),
        field('Gallons delivered', h('input', { id: 'dgal', type: 'number', inputmode: 'decimal', step: 'any', min: '0', required: true })),
        field('Total cost ($, optional)', h('input', { id: 'dcost', type: 'number', inputmode: 'decimal', step: '0.01', min: '0' })),
        field('Supplier', h('input', { id: 'dsup', placeholder: 'Fuel company' }))),
      h('div', { class: 'chips', style: 'padding-top:12px' },
        h('button', { type: 'button', class: 'small', text: '🧾 Attach receipt', onclick: () => pickPhotos(true, (files) => { receipts = receipts.concat(files); rNote.textContent = `${receipts.length} receipt photo${receipts.length === 1 ? '' : 's'} attached`; }) }), rNote),
      h('div', { class: 'formfoot', style: 'padding-top:12px' }, h('button', { class: 'primary', type: 'submit', text: 'Save delivery' })));
    const lForm = h('form', { class: 'panel', onsubmit: async (ev) => {
      ev.preventDefault();
      const v = numOrNull(lForm.querySelector('#lvl').value);
      if (v == null || v < 0) { toast('Enter the gallons the gauge shows.'); return; }
      const entry = { id: uid('t'), kind: 'tanklevel', equipmentId: t.id, date: todayStr(), level: v, by: S.myName, createdAt: Date.now() };
      try { await action(`Tank set to ${fmtN(v)} gal`, () => put('logs', entry)); S.formShown = false; render(true); } catch (err) { showErr(err); }
    } },
      h('h2', { text: 'Set level' }),
      h('p', { class: 'muted', style: 'margin:12px 0 0;font-size:.88rem', text: 'Enter what the tank gauge or a stick reading shows now. Deliveries and fill-ups after this count up and down from it.' }),
      h('div', { class: 'meterform', style: 'margin:12px 0 0' }, field('Gallons in the tank now', h('input', { id: 'lvl', type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: st.level != null ? Math.max(0, Math.round(st.level)) : '' })),
        h('button', { type: 'submit', text: 'Save level' })));
    wrap.append(dForm, lForm);

    // history
    const evs = tankEvents(t).slice().reverse();
    const hp = h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Tank history' }), h('span', { class: 'muted', text: String(evs.length) })));
    if (!evs.length) hp.append(h('p', { class: 'muted', style: 'margin:14px 0 0', text: 'Nothing yet. Start with Set level, then add deliveries. Machine fill-ups from this tank show here too.' }));
    for (const e of evs) {
      const isDraw = e.kind === 'fuel';
      const label = e.kind === 'delivery' ? `+${fmtN(e.gallons)} gal delivered` : e.kind === 'tanklevel' ? `Level set to ${fmtN(e.level)} gal` : `−${fmtN(e.gallons)} gal to ${(findEq(e.equipmentId) || {}).name || 'machine'}`;
      const rs = S.photos.filter(ph => ph.log_id === e.id);
      hp.append(h('div', { class: 'entry' },
        h('div', { class: 'eh' }, h('span', { class: 'date', text: e.date ? fmtDate(e.date) : '' }),
          h('b', { class: 'num', style: `color:var(--${e.kind === 'delivery' ? 'good' : isDraw ? 'ink' : 'warn'})`, text: label }),
          numOrNull(e.cost) != null ? h('span', { class: 'num muted', text: money(e.cost) }) : null,
          e.supplier ? h('span', { class: 'muted', text: e.supplier }) : null,
          e.by ? h('span', { class: 'muted', style: 'font-size:.85rem', text: 'by ' + e.by }) : null,
          h('span', { style: 'flex:1' }), isDraw ? null : removeBtn(e, 'Entry removed')),
        rs.length ? h('div', { class: 'rthumbs' }, rs.map(ph => h('button', { type: 'button', class: 'thumb', onclick: () => viewPhoto(ph.id), 'aria-label': 'Open receipt' }, h('img', { src: ph.thumb, alt: '' })))) : null));
    }
    wrap.append(hp);
    return wrap;
  }
  function tankForm(id) {
    const ex = id ? findTank(id) : null;
    if (id && !ex) return msg('Tank not found', 'It may have been deleted.');
    const t = ex ? clone(ex) : { id: uid('k'), fuelType: 'Diesel' };
    const inp = (k, attrs = {}) => h('input', { id: 'k-' + k, value: t[k] ?? '', ...attrs });
    const form = h('form', { class: 'stack', onsubmit: async (ev) => {
      ev.preventDefault();
      const g = (k) => form.querySelector('#k-' + k).value.trim();
      const out = { ...t, name: g('name'), fuelType: g('fuelType'), capacity: numOrNull(g('capacity')), alertAt: numOrNull(g('alertAt')) };
      if (!out.name) { toast('Give the tank a name.'); return; }
      if (out.capacity != null && out.alertAt != null && out.alertAt >= out.capacity) { toast('The reorder amount must be less than the capacity.'); return; }
      try { await action(ex ? 'Tank saved' : 'Tank added', () => put('tanks', out)); go('#tank-' + out.id); } catch (err) { showErr(err); }
    } },
      h('div', { class: 'panel' }, h('div', { class: 'fgrid', style: 'padding-top:0' },
        field('Tank name *', inp('name', { required: true, placeholder: 'e.g. Shop diesel tank' }), 'wide'),
        field('Fuel type', inp('fuelType', { list: 'fueltypes', placeholder: 'Diesel' })),
        field('Capacity (gallons)', inp('capacity', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', placeholder: 'e.g. 500' })),
        field('Reorder alert at (gallons)', inp('alertAt', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', placeholder: 'e.g. 100' }), 'wide')),
        h('datalist', { id: 'fueltypes' }, ['Diesel', 'Off-road diesel', 'Gasoline', 'DEF'].map(v => h('option', { value: v }))),
        h('p', { class: 'muted', style: 'margin:12px 0 0;font-size:.85rem', text: 'When the tank drops to the reorder amount, phones with alerts on get a notification and the tank shows Reorder.' })),
      h('div', { class: 'formfoot' }, h('a', { class: 'btn', href: ex ? '#tank-' + t.id : '#', text: 'Cancel' }), h('button', { class: 'primary', type: 'submit', text: 'Save' })));
    const wrap = h('div', null, h('div', { class: 'top' }, backLink(ex ? '#tank-' + t.id : '#', ex ? (ex.name || 'Tank') : 'All equipment')), h('h1', { style: 'font-size:2rem;margin-bottom:16px', text: ex ? 'Edit tank' : 'Add fuel tank' }), form);
    if (ex) {
      const zone = h('div', { class: 'dangerzone' });
      const idle = () => zone.replaceChildren(h('button', { class: 'danger small', type: 'button', text: 'Delete tank', onclick: () => zone.replaceChildren(
        h('span', { style: 'flex:1 1 200px', text: `Delete ${ex.name}? Its deliveries and readings are removed too. Machine fill-ups stay in each machine's fuel log.` }),
        h('button', { class: 'danger solid small', type: 'button', text: 'Delete', onclick: async () => {
          try { await action('Tank deleted', async () => { for (const l of S.logs.filter(l => l.equipmentId === ex.id)) await del('logs', l.id); await del('tanks', ex.id); }); go(''); } catch (err) { showErr(err); }
        } }),
        h('button', { class: 'small', type: 'button', text: 'Keep it', onclick: idle })) }));
      idle(); wrap.append(zone);
    }
    return wrap;
  }

  // ---------- photos & scanning ----------
  const KINDS = { plate: 'VIN / plate', receipt: 'Receipt', machine: 'Machine', other: 'Other' };
  S.photos = [];
  async function loadPhotos() {
    const { data, error } = await S.sb.from('photos').select('id,equipment_id,kind,caption,log_id,taken,by,thumb,created_at').order('created_at', { ascending: false });
    if (error) throw error;
    S.photos = data;
  }
  function shrink(file, max, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * sc)); c.height = Math.max(1, Math.round(img.naturalHeight * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve({ canvas: c, data: c.toDataURL('image/jpeg', quality) });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a photo this phone can read')); };
      img.src = url;
    });
  }
  function pickPhotos(multiple, cb) {
    const inp = h('input', { type: 'file', accept: 'image/*', hidden: true, multiple: multiple || null });
    inp.addEventListener('change', () => { const files = [...(inp.files || [])]; inp.remove(); if (files.length) cb(files); });
    document.body.append(inp);
    inp.click();
  }
  async function savePhotos(eqId, files, kind, logId) {
    if (navigator.onLine === false) { toast('Photos need a connection. Try again when you have signal.'); return 0; }
    let n = 0;
    for (const f of files) {
      const big = await shrink(f, 1600, 0.72), small = await shrink(f, 320, 0.6);
      const row = { id: uid('p'), equipment_id: eqId, kind, caption: '', log_id: logId || null, taken: todayStr(), by: S.myName, thumb: small.data, image: big.data };
      const { error } = await S.sb.from('photos').insert(row);
      if (error) throw error;
      const meta = { ...row }; delete meta.image;
      S.photos.unshift(meta); n++;
    }
    announce('photos');
    return n;
  }
  function addPhotosFlow(eqId, kind, logId) {
    pickPhotos(true, async (files) => {
      toast(`Saving ${files.length} photo${files.length === 1 ? '' : 's'}…`);
      try { const n = await savePhotos(eqId, files, kind, logId); if (n) toast(`${n} photo${n === 1 ? '' : 's'} saved`); render(true); }
      catch (err) { showErr(err); }
    });
  }
  function photosPanel(e) {
    const ps = S.photos.filter(p => p.equipment_id === e.id);
    const btn = (kind, label) => h('button', { class: 'small', type: 'button', text: '📷 ' + label, onclick: () => addPhotosFlow(e.id, kind) });
    const p = h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Photos' }), h('span', { class: 'muted', text: ps.length ? String(ps.length) : '' })),
      h('div', { class: 'chips', style: 'padding-top:14px' }, btn('plate', 'VIN / plate'), btn('receipt', 'Receipt'), btn('machine', 'Machine'), btn('other', 'Other')));
    if (!ps.length) p.append(h('p', { class: 'muted', style: 'margin:12px 0 0', text: 'Take pictures of the serial plate, receipts, filter locations or damage. Everyone with the app sees them.' }));
    else p.append(h('div', { class: 'thumbs' }, ps.map(ph => h('button', { type: 'button', class: 'thumb', onclick: () => viewPhoto(ph.id), 'aria-label': `Open ${KINDS[ph.kind] || 'photo'}` },
      h('img', { src: ph.thumb, alt: '' }), h('span', { text: ph.caption || KINDS[ph.kind] || 'Photo' })))));
    return p;
  }
  async function shareBlob(name, blob) {
    try {
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (err) { if (err && err.name === 'AbortError') return; }
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  async function viewPhoto(id) {
    const meta = S.photos.find(p => p.id === id);
    if (!meta) return;
    let full = null;
    const imgEl = h('img', { src: meta.thumb, alt: meta.caption || KINDS[meta.kind] || 'Photo' });
    const cap = h('input', { id: 'ph-cap', value: meta.caption || '', placeholder: 'Caption, e.g. Hutson invoice 1234' });
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    const del = h('span');
    const delIdle = () => del.replaceChildren(h('button', { class: 'small danger', type: 'button', text: 'Delete', onclick: () => del.replaceChildren(
      h('button', { class: 'small danger solid', type: 'button', text: 'Delete photo', onclick: async () => {
        const { error } = await S.sb.from('photos').delete().eq('id', id);
        if (error) { showErr(error); return; }
        S.photos = S.photos.filter(p => p.id !== id); announce('photos'); close(); toast('Photo deleted'); render(true);
      } }),
      h('button', { class: 'small', type: 'button', text: 'Cancel', onclick: delIdle })) }));
    delIdle();
    const ov = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo' },
      h('div', { class: 'vbar' }, h('span', { class: 'muted', text: [KINDS[meta.kind] || 'Photo', meta.taken ? fmtDate(meta.taken) : '', meta.by].filter(Boolean).join(' · ') }), h('span', { style: 'flex:1' }),
        h('button', { class: 'small', type: 'button', text: 'Close', onclick: close })),
      h('div', { class: 'vimg' }, imgEl),
      h('form', { class: 'vfoot', onsubmit: async (ev) => {
        ev.preventDefault();
        const c = cap.value.trim();
        const { error } = await S.sb.from('photos').update({ caption: c }).eq('id', id);
        if (error) { showErr(error); return; }
        meta.caption = c; announce('photos'); toast('Caption saved'); cap.blur(); render(true);
      } }, cap, h('button', { class: 'small', type: 'submit', text: 'Save' })),
      h('div', { class: 'vfoot' }, h('button', { class: 'small', type: 'button', text: 'Share or save', onclick: async () => {
        if (!full) { toast('The full photo is still loading.'); return; }
        const blob = await (await fetch(full)).blob();
        shareBlob(`ruxer-${meta.kind}-${meta.taken || 'photo'}.jpg`, blob);
      } }), h('span', { style: 'flex:1' }), del));
    document.body.append(ov);
    document.addEventListener('keydown', onKey);
    try {
      const { data, error } = await S.sb.from('photos').select('image').eq('id', id).single();
      if (error) throw error;
      full = data.image; imgEl.src = full;
    } catch (err) { console.error(err); toast('Showing a small copy. The full photo needs a connection.'); }
  }

  const LIB = { tess: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', zx: 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js' };
  const loadedLibs = {};
  function loadScript(src) {
    if (!loadedLibs[src]) loadedLibs[src] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = () => { delete loadedLibs[src]; s.remove(); rej(new Error('Could not load the scanner. Check your connection')); };
      document.head.append(s);
    });
    return loadedLibs[src];
  }
  let ocrWorker = null;
  async function readText(canvas) {
    await loadScript(LIB.tess);
    if (!ocrWorker) ocrWorker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
      corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
      langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int'
    });
    const { data } = await ocrWorker.recognize(canvas);
    return (data && data.text) || '';
  }
  async function readBarcode(canvas) {
    try {
      await loadScript(LIB.zx);
      const hints = new Map(); hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);
      const res = await new window.ZXing.BrowserMultiFormatReader(hints).decodeFromImageUrl(canvas.toDataURL('image/png'));
      return res ? res.getText() : null;
    } catch { return null; }
  }
  function vinCands(text) {
    const out = new Map();
    const add = (s, score) => {
      const v = s.replace(/[OQ]/g, '0').replace(/I/g, '1');
      if (v.length >= 8 && v.length <= 17 && /\d/.test(v) && /[A-Z]/.test(v)) out.set(v, Math.max(out.get(v) || 0, score + (v.length === 17 ? 10 : 0)));
    };
    for (const line of text.toUpperCase().split('\n')) {
      (line.replace(/[^A-Z0-9]/g, '').match(/[A-Z0-9]{17}/g) || []).forEach(m => add(m, 5));
      line.split(/[^A-Z0-9]+/).forEach(t => add(t, 1));
    }
    return [...out.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, 6);
  }
  function partCands(text) {
    const out = new Map();
    for (const tok of text.toUpperCase().split(/[^A-Z0-9-]+/)) {
      const t = tok.replace(/^-+|-+$/g, '');
      const digits = (t.match(/\d/g) || []).length;
      if (t.length < 4 || t.length > 16 || digits < 3) continue;
      out.set(t, Math.max(out.get(t) || 0, (/[A-Z]/.test(t) ? 3 : 1) + (t.length >= 6 && t.length <= 10 ? 1 : 0)));
    }
    return [...out.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, 8);
  }
  function sheet(title, body) {
    let ov;
    const close = () => ov && ov.remove();
    ov = h('div', { class: 'sheetwrap', onclick: (ev) => { if (ev.target === ov) close(); } },
      h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'hd' }, h('h2', { text: title }), h('button', { class: 'small', type: 'button', text: 'Close', onclick: close })), body));
    document.body.append(ov);
    return { close };
  }
  // Read a VIN or part number from a photo and put the chosen one into `target`.
  function scanInto(target, mode, eqId) {
    pickPhotos(false, async ([file]) => {
      const body = h('div', { class: 'stack', style: 'padding-top:14px' },
        h('p', { style: 'margin:0', text: 'Reading the photo…' }),
        h('p', { class: 'muted', style: 'margin:0;font-size:.85rem', text: 'The first scan downloads the reader (about 7 MB) and can take 20–40 seconds. Later scans are faster.' }));
      const sh = sheet(mode === 'vin' ? 'Read VIN from photo' : 'Scan part number', body);
      try {
        const { canvas } = await shrink(file, 1800, 0.9);
        const [code, text] = await Promise.all([mode === 'part' ? readBarcode(canvas) : Promise.resolve(null), readText(canvas)]);
        const cands = mode === 'vin' ? vinCands(text) : partCands(text).filter(c => c !== code);
        const keep = eqId ? h('input', { type: 'checkbox', id: 'scan-keep', checked: true }) : null;
        const pick = async (v) => {
          target.value = v; target.dispatchEvent(new Event('input', { bubbles: true }));
          sh.close(); toast('Filled in. Check it against the ' + (mode === 'vin' ? 'plate.' : 'box.'));
          if (keep && keep.checked) { try { await savePhotos(eqId, [file], mode === 'vin' ? 'plate' : 'other'); } catch (err) { showErr(err); } }
        };
        const cand = (v) => h('button', { class: 'cand', type: 'button', text: v, onclick: () => pick(v) });
        body.replaceChildren();
        if (code) body.append(h('div', { class: 'eyebrow', text: 'Barcode' }), cand(code),
          /^\d{11,14}$/.test(code) ? h('p', { class: 'muted', style: 'margin:0;font-size:.82rem', text: 'This looks like a store UPC code, which is usually not the part number. Use a number below if one matches the box.' }) : null);
        if (cands.length) body.append(h('div', { class: 'eyebrow', text: 'Text found in the photo' }), ...cands.map(cand));
        if (!code && !cands.length) body.append(h('p', { style: 'margin:0', text: `No ${mode === 'vin' ? 'VIN' : 'part number'} could be read. Try again closer, with the ${mode === 'vin' ? 'plate' : 'label'} filling the photo and no glare.` }));
        else body.append(h('p', { class: 'muted', style: 'margin:0;font-size:.82rem', text: 'Tap the one that matches. You can still edit it after.' }));
        if (keep && (code || cands.length)) body.append(h('label', { class: 'keeprow' }, keep, mode === 'vin' ? 'Also save this photo to the machine' : 'Also save this photo to the machine'));
      } catch (err) {
        console.error(err);
        body.replaceChildren(h('p', { style: 'margin:0', text: (err && err.message ? err.message : 'The photo could not be read') + '.' }));
      }
    });
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
    return log.id;
  }
  function logForm(id) {
    const e = findEq(id);
    if (!e) return detail(id);
    const eq = effEq(e), u = unitLabel(eq.meterUnit);
    const ivs = (e.intervals || []).map(iv => ({ iv, s: intervalStatus(eq, iv) }));
    let receipts = [];
    const receiptNote = h('span', { class: 'muted', style: 'font-size:.85rem' });
    const form = h('form', { class: 'stack', onsubmit: async (ev) => {
      ev.preventDefault();
      const el = form.elements;
      const done = [...form.querySelectorAll('input[name=task]:checked')].map(c => c.value);
      const work = el.work.value.trim();
      if (!done.length && !work) { toast('Tick a service or describe the work done.'); return; }
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Saving…';
      try {
        let logId = null;
        await action('Service logged', async () => { logId = await recordService(e.id, { date: el.date.value || todayStr(), meter: numOrNull(el.meter.value), done, work, parts: el.parts.value.trim(), cost: numOrNull(el.cost.value) }); });
        if (receipts.length) { btn.textContent = 'Saving receipt…'; try { await savePhotos(e.id, receipts, 'receipt', logId); } catch (err) { showErr(err); } }
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
          field('Cost ($, optional)', h('input', { id: 'l-cost', name: 'cost', type: 'number', inputmode: 'decimal', step: '0.01', min: '0' }))),
        h('div', { class: 'chips' }, h('button', { type: 'button', class: 'small', text: '🧾 Attach receipt', onclick: () => pickPhotos(true, (files) => { receipts = receipts.concat(files); receiptNote.textContent = `${receipts.length} receipt photo${receipts.length === 1 ? '' : 's'} attached`; }) }), receiptNote)),
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
        (() => { const num = h('input', { 'data-f': 'number', class: 'mono', value: f.number || '', placeholder: 'OEM number' });
          return h('div', { class: 'f' }, h('span', { class: 'flabel', text: 'Part number' }), h('div', { class: 'inrow' }, num, h('button', { type: 'button', class: 'small scanbtn', text: '📷', 'aria-label': 'Scan part number from a photo', onclick: () => scanInto(num, 'part', existing ? e.id : null) }))); })(),
        h('label', { class: 'f' }, h('span', { text: 'Cross-reference' }), h('input', { 'data-f': 'alt', class: 'mono', value: f.alt || '', placeholder: 'Wix, Baldwin…' })),
        h('label', { class: 'f' }, h('span', { text: 'Qty' }), h('input', { 'data-f': 'qty', value: f.qty || '', placeholder: '1' })),
        h('label', { class: 'f w2' }, h('span', { text: 'Notes' }), h('input', { 'data-f': 'notes', value: f.notes || '', placeholder: 'Capacity, fluid spec…' })),
        h('button', { class: 'small danger rm', type: 'button', text: 'Remove', onclick: () => row.remove() }));
      filtersBox.append(row);
      return row;
    };
    (e.filters || []).forEach(fRow);
    if (!(e.filters || []).length) fRow();

    const parentSel = h('select', { id: 'f-parentId' }, h('option', { value: '', text: 'Not attached (its own machine)' }),
      S.equipment.filter(x => x.id !== e.id && !x.parentId && !childrenOf(e.id).some(k => k.id === x.id)).map(x => h('option', { value: x.id, text: x.name || 'Machine' })));
    parentSel.value = e.parentId || '';
    const unitSel = h('select', { id: 'f-meterUnit' }, h('option', { value: 'hrs', text: 'Hours' }), h('option', { value: 'mi', text: 'Miles' }), h('option', { value: 'parent', text: "Uses the tractor's hours" }));
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
          (() => { const vin = inp('vin', { class: 'mono', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'VIN or PIN / serial' });
            return field('VIN / Serial number', h('div', { class: 'inrow' }, vin, h('button', { type: 'button', class: 'small', text: '📷 Scan', onclick: () => scanInto(vin, 'vin', existing ? e.id : null) })), 'wide'); })(),
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
      h('div', { class: 'panel' }, h('div', { class: 'hd' }, h('h2', { text: 'Filters & parts' }), h('div', { class: 'chips' }, h('button', { type: 'button', class: 'small', text: '📷 Scan a part', onclick: () => { const r = fRow(); scanInto(r.querySelector('[data-f=number]'), 'part', existing ? e.id : null); } }), h('button', { type: 'button', class: 'small', text: '+ Add part', onclick: () => fRow() }))), filtersBox),
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
      const out = { id: d.id, name: g('name'), address: g('address'), phone: g('phone'), account: g('account') };
      if (!out.name) { toast('Give the dealer a name.'); return; }
      try { await action(ex ? 'Dealer saved' : 'Dealer added', () => put('contacts', out)); history.length > 1 && !ex ? history.back() : go('#dealers'); }
      catch (err) { showErr(err); }
    } },
      h('div', { class: 'panel' }, h('div', { class: 'fgrid', style: 'padding-top:0' },
        field('Dealer name *', inp('name', { required: true, placeholder: 'e.g. Green Valley Equipment' }), 'wide'),
        field('Address', inp('address', { placeholder: 'Street, town, state' }), 'wide'),
        field('Phone', inp('phone', { type: 'tel', inputmode: 'tel' }), 'wide'),
        field('Account number', inp('account', { class: 'mono', autocomplete: 'off', placeholder: 'Your account # with this dealer' }), 'wide'))),
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
    if (hrow.table_name === 'inventory') return hrow.action === 'insert' ? `Inventory: added ${d.name || 'item'}` : hrow.action === 'delete' ? `Inventory: deleted ${d.name || 'item'}` : (b && a && b.qty !== a.qty ? `Inventory: ${d.name} ${b.qty ?? 0} → ${a.qty ?? 0} ${d.unit || ''}` : `Inventory: edited ${d.name || 'item'}`);
    if (hrow.table_name === 'tanks') return hrow.action === 'insert' ? `Added tank ${d.name || ''}` : hrow.action === 'delete' ? `Deleted tank ${d.name || ''}` : `Edited tank ${d.name || ''} (${d.capacity ?? '—'} gal capacity, reorder at ${d.alertAt ?? '—'})`;
    if (hrow.table_name === 'logs' && (d.kind === 'delivery' || d.kind === 'tanklevel')) {
      const tn = (findTank(d.equipmentId) || {}).name || 'Tank';
      const what = d.kind === 'delivery' ? `delivery of ${d.gallons} gal` : `level reading ${d.level} gal`;
      return hrow.action === 'delete' ? `${tn}: removed ${what}` : `${tn}: ${what}`;
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
      h('div', { class: 'chips', style: 'padding-top:14px' }, h('a', { class: 'btn', href: '#dealers', text: `Dealers (${S.contacts.length})` }), h('a', { class: 'btn', href: '#tank-new', text: '+ Add fuel tank' }), h('a', { class: 'btn', href: '#history', text: 'Edit history and undo' }))));
    // backup
    const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: () => restorePick(fileIn, restoreBox) });
    const restoreBox = h('div');
    st.append(h('div', { class: 'panel' }, h('h2', { text: 'Backup & export' }),
      h('p', { class: 'muted', style: 'margin:14px 0 0;font-size:.9rem', text: 'Save a full backup to Files or send it by email. Photos are not in the backup file; they stay in the app. Spreadsheets open in Excel, Numbers or Google Sheets.' }),
      h('div', { class: 'chips', style: 'padding-top:12px' },
        h('button', { class: 'primary', type: 'button', text: 'Full backup', onclick: () => exportBackup() }),
        h('button', { type: 'button', text: 'Service log (spreadsheet)', onclick: () => exportServiceCsv() }),
        h('button', { type: 'button', text: 'Fuel log (spreadsheet)', onclick: () => exportFuelCsv() }),
        h('button', { type: 'button', text: 'Equipment list (spreadsheet)', onclick: () => exportEquipmentCsv() }),
        h('button', { type: 'button', text: 'Fuel tank log (spreadsheet)', onclick: () => exportTankCsv() }),
        h('button', { type: 'button', text: 'Inventory (spreadsheet)', onclick: () => shareFile(`ruxer-inventory-${stamp()}.csv`, csv([['Item', 'Category', 'On hand', 'Unit', 'Reorder at', 'Part number', 'Buy from', 'Notes'],
          ...S.inventory.map(i => [i.name, i.category, i.qty, i.unit, i.minQty, i.partNumber, (findDealer(i.dealerId) || {}).name, i.notes])]), 'text/csv') }),
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
      equipment: S.equipment.map(o => toRow('equipment', o)), logs: S.logs.map(o => toRow('logs', o)), contacts: S.contacts.map(o => toRow('contacts', o)), tanks: S.tanks.map(o => toRow('tanks', o)), inventory: S.inventory.map(o => toRow('inventory', o)) };
    shareFile(`ruxer-farms-backup-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
  }
  function exportServiceCsv() {
    const rows = S.logs.filter(l => !l.kind).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    shareFile(`ruxer-service-log-${stamp()}.csv`, csv([['Date', 'Machine', 'Meter', 'Services', 'Work done', 'Parts', 'Cost', 'By'],
      ...rows.map(l => [l.date, eqName(l.equipmentId), l.meter, (l.taskNames || []).join('; '), l.work, l.parts, l.cost, l.by])]), 'text/csv');
  }
  function exportFuelCsv() {
    const rows = S.logs.filter(l => l.kind === 'fuel').sort((a, b) => String(a.date).localeCompare(String(b.date)));
    shareFile(`ruxer-fuel-log-${stamp()}.csv`, csv([['Date', 'Machine', 'Meter', 'Gallons', 'From', 'Cost', 'Notes', 'By'],
      ...rows.map(l => [l.date, eqName(l.equipmentId), l.meter, l.gallons, l.tankId ? (findTank(l.tankId) || {}).name : 'Elsewhere', l.cost, l.notes, l.by])]), 'text/csv');
  }
  function exportTankCsv() {
    const rows = S.logs.filter(l => l.kind === 'delivery' || l.kind === 'tanklevel').sort((a, b) => String(a.date).localeCompare(String(b.date)));
    shareFile(`ruxer-tank-log-${stamp()}.csv`, csv([['Date', 'Tank', 'Type', 'Gallons', 'Cost', 'Supplier', 'By'],
      ...rows.map(l => [l.date, (findTank(l.equipmentId) || {}).name, l.kind === 'delivery' ? 'Delivery' : 'Level reading', l.kind === 'delivery' ? l.gallons : l.level, l.cost, l.supplier, l.by])]), 'text/csv');
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
        if (payload && payload.table === 'photos') { loadPhotos().then(() => render()).catch(() => {}); return; }
        const tb = payload && TABLES.includes(payload.table) ? payload.table : null;
        t = setTimeout(() => (tb ? loadTable(tb) : Promise.all(TABLES.map(loadTable))).then(() => { saveCache(); render(); updateBadge(); }).catch(() => {}), 200);
      })
      .subscribe();
    setInterval(() => { if (document.visibilityState === 'visible') loadAll(); }, 120000);
  })();
})();
