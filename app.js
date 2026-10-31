/* Bari Discharge v1.0. Discharge summaries for Bari Clinic & Hospital.
 * Entries are kept on the phone, encrypted with a key made from the user's PIN, and sent to the
 * workbook (BariDischarge.gs web app) whenever the phone is online. Fields, codes and checks come from
 * logic.js, which build.js copies from the workbook script itself, so phone and sheet always agree. */
'use strict';
const APP_VERSION = '1.0';
const BUILD_ID = '443969021095';
const IDLE_LOCK_MS = 5 * 60 * 1000;
const PBKDF2_ROUNDS = 210000;
let S = null;          // decrypted state: { cfg, server, outbox, lastSync, usage }
let KEY = null;
const T = { nav: [], syncing: false, syncError: '', idle: null, hiddenAt: 0, salt: null, pin: '', join: null, form: null, q: '' };

// ------------------------------------------------------------------ helpers
const $ = (s) => document.querySelector(s);
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) Object.keys(props).forEach((k) => {
    const v = props[k];
    if (k === 'class') e.className = v;
    else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v);
  });
  kids.flat(Infinity).forEach((k) => { if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k))); });
  return e;
}
const s_ = (v) => (v === null || v === undefined ? '' : String(v).trim());
const pad2 = (n) => (n < 10 ? '0' : '') + n;
function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function dayIso(off) { const d = new Date(); d.setDate(d.getDate() - (off || 0)); return isoOf(d); }
function dmy(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s_(iso)); return m ? m[3] + '-' + m[2] + '-' + m[1] : s_(iso); }
function rid() { const a = new Uint8Array(12); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); }
function ago(ms) { const m = Math.round((Date.now() - ms) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago'; }
function toast(msg) { document.querySelectorAll('.toast').forEach((x) => x.remove()); const t = el('div', { class: 'toast', role: 'status' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2800); }
const colDef = (k) => DCOLS.filter((c) => c.key === k)[0];
const role = () => (S && S.cfg.role) || 'mo';
const can = (what) => roleCan_(role(), what);

// ------------------------------------------------------------------ storage and encryption
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('bari-discharge', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kv(mode, fn) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('kv', mode); const q = fn(tx.objectStore('kv')); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); }); }
const kvGet = (k) => kv('readonly', (s) => s.get(k));
const kvSet = (k, v) => kv('readwrite', (s) => s.put(v, k));
const kvClear = () => kv('readwrite', (s) => s.clear());
async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
const SESS = 'bari-sess';
function b64(u8) { let t = ''; u8.forEach((c) => { t += String.fromCharCode(c); }); return btoa(t); }
async function sessSave() { try { const raw = new Uint8Array(await crypto.subtle.exportKey('raw', KEY)); sessionStorage.setItem(SESS, JSON.stringify({ k: b64(raw), t: Date.now() + IDLE_LOCK_MS })); } catch (e) { /* PIN asked again */ } }
function sessTouch() { try { const o = JSON.parse(sessionStorage.getItem(SESS) || 'null'); if (o) { o.t = Date.now() + IDLE_LOCK_MS; sessionStorage.setItem(SESS, JSON.stringify(o)); } } catch (e) { /* ignore */ } }
function sessClear() { try { sessionStorage.removeItem(SESS); } catch (e) { /* ignore */ } }
async function sessRestore() {
  try {
    const o = JSON.parse(sessionStorage.getItem(SESS) || 'null');
    if (!o || !(o.t > Date.now())) { sessClear(); return false; }
    const vault = await kvGet('vault');
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(o.k), (c) => c.charCodeAt(0)), 'AES-GCM', true, ['encrypt', 'decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vault.iv }, key, vault.ct);
    T.salt = vault.salt; KEY = key; S = JSON.parse(new TextDecoder().decode(pt)); bumpIdle();
    return true;
  } catch (e) { sessClear(); return false; }
}
async function saveState() {
  if (!S || !KEY) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, KEY, new TextEncoder().encode(JSON.stringify(S)));
  await kvSet('vault', { v: 1, salt: T.salt, iv, ct });
}
async function openVault(pin) {
  const vault = await kvGet('vault');
  const key = await deriveKey(pin, vault.salt);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vault.iv }, key, vault.ct);
  T.salt = vault.salt; KEY = key; S = JSON.parse(new TextDecoder().decode(pt));
  sessSave();
}

// ------------------------------------------------------------------ records: the workbook's copy with this phone's unsent changes on top
function serverRows() { return (S.server && S.server.rows) || []; }
function serverRow(uid) { return serverRows().filter((r) => r.uid === uid)[0] || null; }
function pendingOf(uid) { return S.outbox.filter((c) => c.uid === uid)[0] || null; }
function records() {
  const m = {};
  serverRows().forEach((r) => { m[r.uid] = Object.assign({}, r); });
  S.outbox.forEach((c) => { m[c.uid] = Object.assign(m[c.uid] || { uid: c.uid, ds_no: '', status: 'D' }, c.values, { _pending: c.status }); });
  return Object.keys(m).map((k) => m[k]);
}
function record(uid) { return records().filter((r) => r.uid === uid)[0] || null; }
function sortKey(r) { return s_(r.updated_at) || s_(r.discharge_date) || '9999'; }
function queueSave(uid, vals) {
  const sr = serverRow(uid), cur = record(uid) || {};
  const changed = {};
  EDITABLE.forEach((k) => { if (vals[k] !== undefined && s_(vals[k]) !== s_(cur[k])) changed[k] = s_(vals[k]); });
  let c = pendingOf(uid);
  if (!Object.keys(changed).length && !(c && c.status !== 'pending')) return false;
  if (!c) { c = { cid: rid(), uid, create: !sr, values: {}, base: {}, status: 'pending', rev: 0, by: S.cfg.name }; S.outbox.push(c); }
  Object.keys(changed).forEach((k) => { if (sr && !(k in c.base)) c.base[k] = s_(sr[k]); c.values[k] = changed[k]; });
  c.status = 'pending'; c.errors = null; c.rev++;
  return true;
}

// ------------------------------------------------------------------ talking to the workbook
async function api(body, ms) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms || 45000);
  try {
    const r = await fetch(S ? S.cfg.api : T.join.api, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      signal: ctl.signal, redirect: 'follow', credentials: 'omit', cache: 'no-store' });
    return await r.json();
  } finally { clearTimeout(timer); }
}
const PUSH_BATCH = 5;
async function sync() {
  if (!S || T.syncing) return;
  if (!navigator.onLine) { T.syncError = 'offline'; paintSync(); return; }
  T.syncing = true; paintSync();
  const mine = S, still = () => { if (S !== mine) throw Object.assign(new Error('stopped'), { quiet: true }); };
  try {
    const hi = await api({ op: 'hello', token: S.cfg.token }); still();
    if (hi.code === 401) throw Object.assign(new Error('This phone no longer has access. Ask the PI for a new invitation.'), { code: 401 });
    if (hi.ok && Number(hi.schema) !== CFG.SCHEMA_VER) throw new Error('The app and the workbook are different versions. Close the app and open it again while online. Your entries are kept.');
    const pending = S.outbox.filter((c) => c.status === 'pending');
    for (let i = 0; i < pending.length; i += PUSH_BATCH) {
      const part = pending.slice(i, i + PUSH_BATCH), revs = {};
      part.forEach((c) => { revs[c.cid] = c.rev; });
      const res = await api({ op: 'push', token: S.cfg.token, schema: CFG.SCHEMA_VER, changes: part.map((c) => ({ cid: c.cid, uid: c.uid, create: c.create, values: c.values, base: c.base, by: c.by })) }); still();
      if (!res.ok) throw Object.assign(new Error(res.error || 'the workbook refused'), { code: res.code });
      res.results.forEach((r) => {
        const c = S.outbox.filter((x) => x.cid === r.cid)[0];
        if (!c || c.rev !== revs[r.cid]) return;                         // changed again while sending: goes next time
        if (r.status === 'ok') S.outbox.splice(S.outbox.indexOf(c), 1);
        else { c.status = r.status; c.errors = r.errors; c.current = r.current || null; }
      });
      await saveState();
    }
    const pull = await api({ op: 'pull', token: S.cfg.token }); still();
    if (!pull.ok) throw Object.assign(new Error(pull.error || 'the workbook refused'), { code: pull.code });
    S.server = { rows: pull.rows, quick: pull.quick, templates: pull.templates, staff: pull.staff, roleName: pull.roleName, today: pull.today, at: Date.now() };
    S.cfg.role = pull.role; S.lastSync = Date.now(); T.syncError = '';
    await saveState();
  } catch (e) {
    if (e.quiet) return;
    T.syncError = e.name === 'AbortError' ? 'timed out' : (e.message || 'failed');
  } finally {
    T.syncing = false;
    if (T.form && T.form.dirty) paintSync(); else render();
  }
}

// ------------------------------------------------------------------ locking and navigation
function bumpIdle() { clearTimeout(T.idle); if (KEY) { T.idle = setTimeout(lock, IDLE_LOCK_MS); sessTouch(); } }
function lock() { sessClear(); KEY = null; S = null; T.form = null; T.nav = []; T.pin = ''; T.q = ''; clearTimeout(T.idle); render(); applyUpdateIfSafe(); }
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true }));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) T.hiddenAt = Date.now();
  else if (KEY && T.hiddenAt && Date.now() - T.hiddenAt > IDLE_LOCK_MS) lock();
});
window.addEventListener('online', () => { paintSync(); sync(); });
window.addEventListener('offline', paintSync);
function go(name, p) { T.nav.push({ name, p: p || {} }); history.pushState({ d: T.nav.length }, ''); T.form = null; render(); window.scrollTo(0, 0); }
function cur() { return T.nav[T.nav.length - 1] || { name: 'home', p: {} }; }
function back() { confirmLeave(() => { T.nav.pop(); T.form = null; render(); window.scrollTo(0, 0); }); }
window.addEventListener('popstate', () => { if (!KEY) return; if (T.form && T.form.dirty) { history.pushState({ d: T.nav.length }, ''); back(); return; } T.nav.pop(); T.form = null; render(); });
function confirmLeave(fn) {
  if (!T.form || !T.form.dirty) { fn(); return; }
  modal('Leave without saving?', el('p', null, 'Your changes on this summary are not saved yet.'), [['Stay', null], ['Save draft and leave', () => { saveForm(false); fn(); }, 'primary'], ['Discard', () => { T.form = null; fn(); }, 'danger']]);
}
function tabTo(name) { confirmLeave(() => { T.nav = name === 'home' ? [] : [{ name, p: {} }]; history.pushState({ d: T.nav.length }, ''); T.form = null; render(); window.scrollTo(0, 0); }); }

function modal(title, body, actions) {
  const m = $('#modal');
  const close = () => { m.hidden = true; m.replaceChildren(); };
  m.replaceChildren(el('div', { class: 'sheet', role: 'alertdialog', 'aria-modal': 'true' }, el('h3', null, title), body,
    el('div', { class: 'acts' }, actions.map((a) => el('button', { class: 'btn ' + (a[2] || ''), type: 'button', onclick: () => {
      const sheet = m.firstChild, r = a[1] ? a[1]() : undefined;
      if (r === false) return;
      if (m.firstChild === sheet) close();
    } }, a[0])))));
  m.hidden = false;
}

// ------------------------------------------------------------------ render
function render() {
  const app = $('#app');
  let page;
  if (!T.hasVault || T.join && !KEY && !T.hasVault) page = setupScreen();
  else if (!KEY) page = lockScreen();
  else {
    const c = cur();
    page = c.name === 'form' ? formScreen(c.p) : c.name === 'view' ? viewScreen(c.p) : c.name === 'list' ? listScreen() : c.name === 'settings' ? settingsScreen()
      : c.name === 'buttons' ? buttonsScreen() : homeScreen();
  }
  app.replaceChildren(page);
}
function topBar(title, opts) {
  opts = opts || {};
  return el('header', { class: 'top' }, opts.back ? el('button', { class: 'back', type: 'button', 'aria-label': 'Back', onclick: back }, '\u2039') : el('img', { class: 'mark', src: 'icon-192.png', alt: '' }),
    el('h1', null, title), el('div', { id: 'syncbar' }, syncBar()));
}
function syncBar() {
  if (!S) return '';
  const n = S.outbox.filter((c) => c.status === 'pending').length, bad = S.outbox.filter((c) => c.status !== 'pending').length;
  const txt = T.syncing ? 'Sending\u2026' : !navigator.onLine ? 'Offline' + (n ? ', ' + n + ' waiting' : '') : T.syncError ? 'Not sent: tap to retry' : n ? n + ' waiting' : bad ? bad + ' need attention' : S.lastSync ? 'Up to date' : 'Tap to sync';
  return el('button', { class: 'sync' + (T.syncError || bad ? ' warn' : ''), type: 'button', id: 'sync-btn', title: T.syncError || '', onclick: () => sync() }, txt);
}
function paintSync() { const b = $('#syncbar'); if (b && S) b.replaceChildren(syncBar()); }
function bottomNav(active) {
  const tabs = [['home', 'Home'], ['list', 'Summaries']].concat(role() === 'pi' ? [['buttons', 'Buttons']] : []).concat([['settings', 'Settings']]);
  return el('nav', { class: 'bar' }, tabs.map((t) => el('button', { class: active === t[0] ? 'on' : '', type: 'button', id: 'nav-' + t[0], onclick: () => tabTo(t[0]) }, t[1])));
}

// ------------------------------------------------------------------ setup and lock
function readJoin(given) {
  const h = given || location.hash;
  if (h.indexOf('#join=') !== 0) return false;
  let ok = false;
  const raw = h.slice(6), i = raw.lastIndexOf('~');
  const apiUrl = decodeURIComponent(raw.slice(0, i)), code = raw.slice(i + 1);
  if (/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(apiUrl) && /^[0-9a-f]{32}$/.test(code)) { T.join = { api: apiUrl, code }; ok = true; }
  if (!given) history.replaceState(null, '', location.pathname + location.search);
  return given ? ok : true;
}
window.addEventListener('hashchange', () => { if (readJoin() && !KEY) render(); });
function setupScreen() {
  if (!T.join) {
    const box = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', placeholder: 'Paste the invitation link here', id: 'join-link' });
    const m0 = el('div', { class: 'msg' });
    return el('div', { class: 'lock' }, el('img', { class: 'logo', src: 'logo.jpg', alt: 'Bari Hospital' }), el('h1', null, 'Bari Discharge'),
      el('p', null, 'Set up this phone with the invitation link the PI sent you. Tap the link on this phone, or paste it below.'), box, m0,
      el('button', { class: 'btn primary block', type: 'button', onclick: () => {
        const v = s_(box.value), k = v.indexOf('#join=');
        if (k < 0 || !readJoin(v.slice(k))) { m0.textContent = 'That is not an invitation link. Copy the whole link and paste it again.'; return; }
        render();
      } }, 'Continue'),
      el('p', { class: 'small' }, 'On iPhone, add the app to the Home Screen first and paste the link there: the Home Screen copy keeps its own storage.'));
  }
  const nm = el('input', { type: 'text', maxlength: '60', autocomplete: 'name', placeholder: 'e.g. Dr Ayesha Khan', id: 'setup-name' });
  const p1 = el('input', { type: 'password', inputmode: 'numeric', maxlength: '12', autocomplete: 'new-password', placeholder: '6 digits or more', id: 'setup-pin1' });
  const p2 = el('input', { type: 'password', inputmode: 'numeric', maxlength: '12', autocomplete: 'new-password', id: 'setup-pin2' });
  const msg = el('div', { class: 'msg' });
  const btn = el('button', { class: 'btn primary block', type: 'button', id: 'setup-join', onclick: async () => {
    msg.textContent = '';
    const n = s_(nm.value), a = p1.value, b = p2.value;
    if (n.length < 3) { msg.textContent = 'Enter your name as it should appear on summaries.'; return; }
    if (!/^\d{6,12}$/.test(a)) { msg.textContent = 'Choose a PIN of 6 to 12 digits.'; return; }
    if (a !== b) { msg.textContent = 'The two PINs do not match.'; return; }
    if (/^(\d)\1+$/.test(a) || '0123456789012'.includes(a) || '9876543210987'.includes(a)) { msg.textContent = 'Choose a PIN that is not a repeated or running sequence.'; return; }
    if (!navigator.onLine) { msg.textContent = 'Joining needs the internet once. Connect and try again.'; return; }
    btn.disabled = true; btn.textContent = 'Joining\u2026';
    try {
      const res = await api({ op: 'join', code: T.join.code, device: navigator.userAgent.slice(0, 60) });
      if (!res.ok) throw new Error(res.error || 'joining failed');
      T.salt = crypto.getRandomValues(new Uint8Array(16)); KEY = await deriveKey(a, T.salt);
      S = { cfg: { api: T.join.api, token: res.token, email: res.email, role: res.role, name: n, joined: Date.now() }, server: null, outbox: [], lastSync: 0, usage: {} };
      await saveState(); sessSave(); T.hasVault = true; T.join = null;
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      bumpIdle(); render(); sync();
    } catch (e) { msg.textContent = e.message; btn.disabled = false; btn.textContent = 'Join'; }
  } }, 'Join');
  return el('div', { class: 'setup' }, el('h2', null, 'Join Bari Discharge'),
    el('div', { class: 'card' }, el('p', { class: 'small muted' }, 'Summaries you write are kept on this phone, encrypted with your PIN, until they reach the hospital workbook.')),
    el('div', { class: 'field' }, el('label', { class: 'lab', for: 'setup-name' }, 'Your name'), el('div', { class: 'hint' }, 'Recorded with every change and offered as the medical officer or consultant name.'), nm),
    el('div', { class: 'field' }, el('label', { class: 'lab', for: 'setup-pin1' }, 'Choose a PIN'), el('div', { class: 'hint' }, 'If you forget it, the phone is reset and anything not yet sent is lost.'), p1),
    el('div', { class: 'field' }, el('label', { class: 'lab', for: 'setup-pin2' }, 'Type the PIN again'), p2, msg), btn);
}
function lockScreen() {
  const fails = +(localStorage.getItem('bari-fails') || 0), until = +(localStorage.getItem('bari-wait') || 0);
  const dots = el('div', { class: 'dots' }, [0, 1, 2, 3, 4, 5].map((i) => el('i', { class: i < T.pin.length ? 'f' : '' })));
  const tryPin = async () => {
    if (T.pin.length < 6) { T.lockMsg = 'At least 6 digits.'; render(); return; }
    const pin = T.pin; T.pin = ''; T.lockMsg = 'Opening\u2026'; render();
    try { await openVault(pin); localStorage.setItem('bari-fails', '0'); T.lockMsg = ''; T.nav = []; bumpIdle(); render(); sync(); }
    catch (e) {
      const f = fails + 1; localStorage.setItem('bari-fails', String(f));
      if (f >= 5) localStorage.setItem('bari-wait', String(Date.now() + Math.min(3600, Math.pow(2, f - 4) * 15) * 1000));
      T.lockMsg = 'Wrong PIN.'; render();
    }
  };
  const press = (d) => {
    if (Date.now() < until) { T.lockMsg = 'Too many wrong PINs. Wait ' + Math.ceil((until - Date.now()) / 1000) + ' s.'; render(); return; }
    if (d === 'del') T.pin = T.pin.slice(0, -1); else if (d === 'ok') { tryPin(); return; } else if (T.pin.length < 12) T.pin += d;
    T.lockMsg = ''; render();
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
  return el('div', { class: 'lock' }, el('img', { class: 'logo', src: 'logo.jpg', alt: 'Bari Hospital' }),
    el('p', null, T.join ? 'An invitation was opened, but this phone is already set up. Unlock, then reset the phone in Settings to use it.' : 'Enter your PIN'),
    dots, el('div', { class: 'pad' }, keys.map((k) => el('button', { class: k.length > 1 ? 'txt' : '', type: 'button', 'aria-label': k === 'del' ? 'Delete' : k === 'ok' ? 'Unlock' : k, onclick: () => press(k) },
      k === 'del' ? 'Delete' : k === 'ok' ? 'Unlock' : k))), el('div', { class: 'err', role: 'alert' }, T.lockMsg || ''),
    el('button', { class: 'linkbtn', type: 'button', onclick: () => modal('Forgot your PIN?', el('p', null, 'The PIN cannot be recovered. Ask the PI for a new invitation, then reset this phone: summaries not yet sent from this phone are lost.'),
      [['Cancel', null], ['Reset this phone', resetPhone, 'danger']]) }, 'Forgot PIN?'));
}
async function resetPhone() { await kvClear(); sessClear(); KEY = null; S = null; T.hasVault = false; T.nav = []; render(); }

// ------------------------------------------------------------------ home and lists
function card(r) {
  const st = r._pending === 'pending' ? 'waiting to send' : r._pending === 'conflict' ? 'changed elsewhere' : r._pending === 'refused' ? 'needs a fix' : r.status === 'F' ? 'final' : 'draft';
  const cls = r._pending === 'conflict' || r._pending === 'refused' ? 'bad' : r.status === 'F' && !r._pending ? 'fin' : r._pending === 'pending' ? 'wait' : 'draft';
  return el('button', { class: 'rec', type: 'button', 'data-uid': r.uid, onclick: () => go('view', { uid: r.uid }) },
    el('div', { class: 'main' }, el('div', { class: 'nm' }, r.name || '(no name)', r.age ? el('span', { class: 'muted' }, '  ' + r.age + (r.sex ? ' ' + r.sex : '')) : null),
      el('div', { class: 'sub' }, [r.ds_no || 'new', r.discharge_date ? 'discharge ' + dmy(r.discharge_date) : '', r.consultant].filter(Boolean).join(' | '))),
    el('span', { class: 'chip-st ' + cls }, st));
}
function attention() { return records().filter((r) => r._pending === 'conflict' || r._pending === 'refused'); }
function homeScreen() {
  const all = records().sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  const drafts = all.filter((r) => r.status !== 'F' && r._pending !== 'conflict' && r._pending !== 'refused');
  const finals = all.filter((r) => r.status === 'F' && !r._pending).slice(0, 8), bad = attention();
  return el('div', { class: 'page' }, topBar('Bari Discharge'),
    el('main', null,
      el('button', { class: 'btn big primary block', type: 'button', id: 'new-summary', onclick: () => newSummary() }, '+ New discharge summary'),
      searchBox(),
      el('div', { id: 'results' }),
      bad.length ? el('section', { class: 'feed alert' }, el('h2', null, 'Needs attention (' + bad.length + ')'), bad.map(card)) : null,
      el('section', { class: 'feed' }, el('h2', null, 'Drafts (' + drafts.length + ')'), drafts.length ? drafts.map(card) : el('p', { class: 'muted small' }, 'No drafts. Tap New discharge summary to start one.')),
      el('section', { class: 'feed' }, el('h2', null, 'Recently finalised'), finals.length ? finals.map(card) : el('p', { class: 'muted small' }, 'None yet.'))),
    bottomNav('home'));
}
function searchBox() {
  const inp = el('input', { type: 'search', id: 'search', placeholder: 'Search name or BH number', value: T.q, autocomplete: 'off' });
  inp.addEventListener('input', () => { T.q = inp.value; paintResults(); });
  setTimeout(paintResults, 0);
  return inp;
}
function paintResults() {
  const box = $('#results'); if (!box) return;
  const q = s_(T.q).toLowerCase();
  if (q.length < 2) { box.replaceChildren(); return; }
  const hits = records().filter((r) => (r.name + ' ' + r.father_husband + ' ' + r.ds_no).toLowerCase().indexOf(q) >= 0).sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  box.replaceChildren(el('section', { class: 'feed' }, el('h2', null, hits.length + ' found on this phone'), hits.slice(0, 30).map(card),
    el('button', { class: 'btn block', type: 'button', id: 'search-online', onclick: () => searchOnline(q) }, 'Search older summaries in the workbook')));
}
async function searchOnline(q) {
  if (!navigator.onLine) { toast('Searching older summaries needs a signal.'); return; }
  const r = await api({ op: 'search', token: S.cfg.token, q }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { toast(r.error || 'Search failed'); return; }
  const known = {}; serverRows().forEach((x) => { known[x.uid] = true; });
  r.rows.forEach((x) => { if (!known[x.uid]) S.server.rows.push(x); });
  await saveState(); paintResults();
  toast(r.rows.length + ' found in the workbook');
}
function listScreen() {
  const all = records().sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  return el('div', { class: 'page' }, topBar('Summaries'), el('main', null, searchBox(), el('div', { id: 'results' }),
    el('section', { class: 'feed' }, el('h2', null, 'On this phone (' + all.length + ')'), all.map(card))), bottomNav('list'));
}

// ------------------------------------------------------------------ the summary form
function newSummary(from) {
  const uid = rid(), v = { status: 'D', date: dayIso(0), discharge_date: dayIso(0), op_date: dayIso(1), sex: 'F', marital: 'M' };
  if (from) ['name', 'father_husband', 'age', 'sex', 'marital', 'religion', 'gravida', 'para', 'comorbid'].forEach((k) => { v[k] = s_(from[k]); });
  const def = defaultTemplate();
  if (def) SECTIONS.forEach((k) => { if (s_(def[k])) v[k] = def[k]; });
  if (role() === 'consultant') v.consultant = S.cfg.name;
  if (role() === 'mo') v.mo_name = S.cfg.name;
  T.newVals = v;
  go('form', { uid, isNew: true });
}
function defaultTemplate() { return ((S.server && S.server.templates) || []).filter((t) => s_(t.name).toLowerCase() === 'default')[0] || null; }
function otherTemplates() { return ((S.server && S.server.templates) || []).filter((t) => s_(t.name).toLowerCase() !== 'default'); }
function formScreen(p) {
  if (!T.form || T.form.uid !== p.uid) {
    const r = record(p.uid);
    T.form = { uid: p.uid, vals: Object.assign({}, r || T.newVals || {}), dirty: false, isNew: !r };
    T.newVals = null;
  }
  const F = T.form, v = F.vals;
  const final = v.status === 'F';
  if (final && !can('finalise')) { setTimeout(() => { T.nav.pop(); T.nav.push({ name: 'view', p: { uid: p.uid } }); T.form = null; render(); }, 0); return el('div'); }
  const set = (k, val) => { v[k] = val; F.dirty = true; };
  const banner = (() => { const c = pendingOf(p.uid); return c && c.errors ? el('div', { class: 'banner bad' }, c.errors.join('. ')) : null; })();
  const tmpl = F.isNew && otherTemplates().length ? el('div', { class: 'card' }, el('div', { class: 'lab' }, 'Start from a template'),
    el('div', { class: 'chips' }, otherTemplates().map((t) => el('button', { class: 'chip tpl', type: 'button', onclick: () => applyTemplate(t) }, t.name)))) : null;
  return el('div', { class: 'page form' }, topBar(F.isNew ? 'New summary' : (v.ds_no || 'Summary'), { back: true }),
    el('main', null, banner, tmpl,
      el('section', { class: 'card' }, el('h2', null, 'Patient'),
        textField('name', set, { cap: 'words' }), textField('father_husband', set, { cap: 'words' }),
        textField('age', set, { mode: 'numeric', ph: 'years' }),
        codeField('marital', set), codeField('religion', set)),
      el('section', { class: 'card' }, el('h2', null, 'Obstetric'),
        codeField('gravida', set), codeField('para', set), codeField('gest_weeks', set), comorbidField(set)),
      el('section', { class: 'card' }, el('h2', null, 'Dates and doctors'),
        dateField('date', set, [['Today', 0]]),
        dateField('admit_date', set, [['Today', 0], ['Yesterday', 1], ['2 days ago', 2], ['3 days ago', 3]]),
        dateField('op_date', set, [['Today', 0], ['Yesterday', 1], ['2 days ago', 2], ['3 days ago', 3]]),
        dateField('discharge_date', set, [['Today', 0], ['Yesterday', 1]]),
        staffField('consultant', set, 'consultant'), staffField('mo_name', set, 'mo')),
      SECTIONS.map((k) => [sectionField(k, set), k === 'physical_findings' ? labsCard(set) : null])),
    el('div', { class: 'actbar' },
      el('button', { class: 'btn', type: 'button', id: 'save-draft', onclick: () => saveForm(true) }, final ? 'Save' : 'Save draft'),
      can('finalise') && !final ? el('button', { class: 'btn primary', type: 'button', id: 'finalise', onclick: finaliseForm }, 'Finalise') : null,
      el('button', { class: 'btn accent', type: 'button', id: 'pdf', onclick: async () => { if (F.dirty) saveForm(false); await sharePdf(record(F.uid) || v); } }, 'PDF')));
}
function fieldWrap(k, input, extra) { return el('div', { class: 'field', id: 'w-' + k }, el('label', { class: 'lab', for: 'f-' + k }, colDef(k).label), input, extra || null); }
function textField(k, set, o) {
  o = o || {};
  const i = el('input', { type: 'text', id: 'f-' + k, value: s_(T.form.vals[k]), autocapitalize: o.cap || 'sentences', placeholder: o.ph || '', maxlength: '200', autocomplete: 'off', inputmode: o.mode || null });
  i.addEventListener('input', () => set(k, i.value));
  return fieldWrap(k, i);
}
function chipRow(k, opts, curVal, onPick) {
  return el('div', { class: 'chips', id: 'c-' + k }, opts.map((o) => el('button', { class: 'chip' + (curVal === o[0] ? ' on' : ''), type: 'button', 'data-v': o[0], onclick: (e) => {
    const on = e.currentTarget.classList.contains('on');
    e.currentTarget.parentNode.querySelectorAll('.chip').forEach((b) => b.classList.remove('on'));
    if (!on) e.currentTarget.classList.add('on');
    onPick(on ? '' : o[0]);
  } }, o[1])));
}
function codeField(k, set) { return el('div', { class: 'field', id: 'w-' + k }, el('div', { class: 'lab' }, colDef(k).label), chipRow(k, colDef(k).codes, s_(T.form.vals[k]), (x) => set(k, x))); }
function dateField(k, set, quick) {
  const i = el('input', { type: 'date', id: 'f-' + k, value: s_(T.form.vals[k]) });
  i.addEventListener('input', () => set(k, i.value));
  const row = el('div', { class: 'chips' }, quick.map((q) => el('button', { class: 'chip', type: 'button', onclick: () => { i.value = dayIso(q[1]); set(k, i.value); } }, q[0])));
  return fieldWrap(k, i, row);
}
function staffField(k, set, kind) {
  const names = ((S.server && S.server.staff) || []).filter((s) => s.role === kind).map((s) => s.name);
  if ((kind === 'mo' ? role() !== 'consultant' : role() !== 'mo') && !names.some((n) => normName(n) === normName(S.cfg.name))) names.push(S.cfg.name);
  const i = el('input', { type: 'text', id: 'f-' + k, value: s_(T.form.vals[k]), autocapitalize: 'words', autocomplete: 'off', maxlength: '200' });
  i.addEventListener('input', () => set(k, i.value));
  return fieldWrap(k, i, el('div', { class: 'chips' }, names.map((n) => el('button', { class: 'chip', type: 'button', onclick: () => { i.value = n; set(k, n); } }, n))));
}
function quickFor(k, row) { return ((S.server && S.server.quick) || []).filter((q) => q.section === k && (!row || quickShown_(q, row))); }
function comorbidField(set) {
  const cur = comorbidOf_(T.form.vals);
  return el('div', { class: 'field', id: 'w-comorbid' }, el('div', { class: 'lab' }, 'Co-morbid'), el('div', { class: 'hint' }, 'Ticking one shows its diagnoses, history, treatment and medicine buttons.'),
    el('div', { class: 'chips', id: 'c-comorbid' }, COMORBID.map((o) => el('button', { class: 'chip box' + (cur.indexOf(o[0]) >= 0 ? ' on' : ''), type: 'button', role: 'checkbox', 'aria-checked': cur.indexOf(o[0]) >= 0 ? 'true' : 'false', 'data-v': o[0], onclick: () => {
      const now = comorbidOf_(T.form.vals), i = now.indexOf(o[0]);
      if (i >= 0) now.splice(i, 1); else now.push(o[0]);
      set('comorbid', COMORBID.map((c) => c[0]).filter((c) => now.indexOf(c) >= 0).join(','));
      const y = window.scrollY; render(); window.scrollTo(0, y);
    } }, (cur.indexOf(o[0]) >= 0 ? '\u2611 ' : '\u2610 ') + o[1]))));
}
function labsCard(set) {
  const f = (k) => {
    const c = colDef(k), i = el('input', { type: 'text', inputmode: 'decimal', id: 'f-' + k, value: s_(T.form.vals[k]), placeholder: c.unit, autocomplete: 'off', maxlength: '6' });
    i.addEventListener('input', () => set(k, i.value.trim()));
    return el('div', { class: 'field', id: 'w-' + k }, el('label', { class: 'lab', for: 'f-' + k }, c.label + ' (' + c.unit + ')'), i);
  };
  return el('section', { class: 'card', id: 'w-labs' }, el('h2', null, 'Investigations'), el('div', { class: 'row3' }, f('hb'), f('tlc'), f('plt')));
}
function sectionField(k, set) {
  const ta = el('textarea', { id: 'f-' + k, rows: '4', value: s_(T.form.vals[k]) });
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.max(96, ta.scrollHeight + 2) + 'px'; };
  ta.addEventListener('input', () => { set(k, ta.value); grow(); });
  setTimeout(grow, 0);
  const qs = quickFor(k, T.form.vals), groups = [];
  qs.forEach((q) => { if (groups.indexOf(q.group) < 0) groups.push(q.group); });
  const use = S.usage || {}, top = qs.filter((q) => use[q.qid]).sort((a, b) => use[b.qid] - use[a.qid]).slice(0, 6);
  const chip = (q) => el('button', { class: 'chip q' + (q.draft ? ' draft' : ''), type: 'button', title: q.draft ? 'Draft: only the PI sees it until approved' : '', onclick: () => { insertPhrase(ta, q); set(k, ta.value); grow(); S.usage[q.qid] = (S.usage[q.qid] || 0) + 1; } }, q.phrase);
  const blocks = (top.length ? [['Most used', top]] : []).concat(groups.map((g) => [g, qs.filter((q) => q.group === g)]));
  return el('section', { class: 'card sec', id: 'w-' + k }, el('h2', null, el('label', { for: 'f-' + k }, colDef(k).label)), ta,
    blocks.map((b) => el('div', { class: 'qgroup' }, el('div', { class: 'qlab' }, b[0]), el('div', { class: 'chips' }, b[1].map(chip)))),
    el('div', { class: 'secacts' },
      el('button', { class: 'linkbtn', type: 'button', onclick: () => { ta.value = ''; set(k, ''); grow(); } }, 'Clear'),
      can('quickAdd') ? el('button', { class: 'linkbtn', type: 'button', id: 'add-' + k, onclick: () => addButton(k, ta, groups) }, '+ Make a quick button') : null));
}
// Insert a quick phrase: N on a new line, S on the same line after a space, C after a comma (or a space after "with", "of").
function insertPhrase(ta, q) {
  let t = ta.value.replace(/[ \t]+$/, '');
  const start = t.length;
  if (t) {
    if (q.join === 'N') t += t.endsWith('\n') ? '' : '\n';
    else if (q.join === 'C') t += /(\bwith|\bof|\band|,|\n)$/i.test(t) ? (/\n$/.test(t) ? '' : ' ') : ', ';
    else t += /\n$/.test(t) ? '' : ' ';
  }
  t += q.phrase;
  ta.value = t;
  const blank = t.indexOf('___', start);
  if (blank >= 0) { ta.focus(); ta.setSelectionRange(blank, blank + 3); }
}
function applyTemplate(t) {
  const v = T.form.vals;
  SECTIONS.forEach((k) => { if (s_(t[k])) v[k] = s_(v[k]) ? s_(v[k]) + '\n' + t[k] : t[k]; });
  T.form.dirty = true; render(); toast('Template "' + t.name + '" added');
}
function addButton(k, ta, groups) {
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
  const lines = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
  const text = el('input', { type: 'text', id: 'qb-text', value: sel || lines[lines.length - 1] || '', maxlength: '200' });
  const grp = el('input', { type: 'text', id: 'qb-group', value: groups[groups.length - 1] || 'Added', maxlength: '40' });
  let join = 'N';
  const msg = el('div', { class: 'msg' });
  const body = el('div', null, el('p', { class: 'small muted' }, 'Use ___ for a blank to fill in each time. ' + (can('quickLive') ? 'It appears on every phone after their next sync.' : 'It stays a draft until the PI approves it.')),
    el('label', { class: 'lab', for: 'qb-text' }, 'Button text'), text,
    el('label', { class: 'lab', for: 'qb-group' }, 'Group'), grp, el('div', { class: 'chips' }, groups.map((g) => el('button', { class: 'chip', type: 'button', onclick: () => { grp.value = g; } }, g))),
    el('div', { class: 'lab' }, 'Where it goes'), chipRow('qb-join', JOINS, 'N', (x) => { join = x || 'N'; }), msg);
  modal('Make a quick button', body, [['Cancel', null], ['Save button', () => {
    const phrase = s_(text.value);
    if (phrase.length < 2) { msg.textContent = 'Type the button text.'; return false; }
    if (!navigator.onLine) { msg.textContent = 'Making a button needs a signal.'; return false; }
    api({ op: 'quick_add', token: S.cfg.token, section: k, group: s_(grp.value), join, phrase, by: S.cfg.name }).then(async (r) => {
      if (!r.ok) { toast(r.error || 'Not saved'); return; }
      if (!r.already) S.server.quick.push({ qid: r.qid, section: k, group: s_(grp.value) || 'Added', join, phrase, draft: r.status !== 'live' });
      await saveState(); toast(r.already ? 'That button already exists' : r.status === 'live' ? 'Button added' : 'Button saved as a draft for the PI');
      if (cur().name === 'form') { const keep = T.form; render(); T.form = keep; }
    }).catch((e) => toast('Not saved: ' + e.message));
  }, 'primary']]);
}
function formProblems(v) { return rowProblems_(v); }
function saveForm(stay) {
  const F = T.form; if (!F) return false;
  const v = F.vals;
  if (!s_(v.name)) { toast('Enter the patient\u2019s name first.'); focusField('name'); return false; }
  const probs = formProblems(v);
  if (probs.length) { toast(probs[0]); return false; }
  queueSave(F.uid, v);
  F.dirty = false; F.isNew = false;
  saveState().then(() => sync());
  if (stay) { toast('Saved on this phone' + (navigator.onLine ? ', sending' : '. It is sent when there is a signal')); render(); }
  return true;
}
function focusField(k) { const w = $('#w-' + k); if (w) { w.scrollIntoView({ block: 'center' }); w.classList.add('flash'); setTimeout(() => w.classList.remove('flash'), 2500); } }
function finaliseForm() {
  const v = T.form.vals, gaps = finalGaps_(v);
  if (gaps.length) {
    modal('Not ready to finalise', el('div', null, el('p', null, 'Fill in:'), el('ul', null, gaps.map((g) => el('li', null, g)))), [['OK', () => { const k = FINAL_NEEDS.filter((x) => !s_(v[x]))[0]; setTimeout(() => focusField(k), 50); }, 'primary']]);
    return;
  }
  modal('Finalise this summary?', el('p', null, 'It is marked final with your name. Only a consultant can change it afterwards.'), [['Cancel', null], ['Finalise', () => {
    v.status = 'F'; T.form.dirty = true;
    if (saveForm(false)) { const uid = T.form.uid; T.form = null; T.nav.pop(); T.nav.push({ name: 'view', p: { uid } }); render(); toast('Finalised'); }
    else v.status = 'D';
  }, 'primary']]);
}

// ------------------------------------------------------------------ view
function viewScreen(p) {
  const r = record(p.uid);
  if (!r) return el('div', { class: 'page' }, topBar('Summary', { back: true }), el('main', null, el('p', null, 'Not on this phone any more.')));
  const c = pendingOf(p.uid), final = r.status === 'F', editable = !final || can('finalise');
  const line = (k) => (s_(r[k]) ? el('div', { class: 'kv' }, el('span', { class: 'k' }, colDef(k).label), el('span', { class: 'v' }, colDef(k).codes ? codeLabel_(k, r[k]) : colDef(k).type === 'date' ? dmy(r[k]) : r[k])) : null);
  return el('div', { class: 'page' }, topBar(r.ds_no || 'New summary', { back: true }),
    el('main', null,
      c && c.status === 'conflict' ? conflictCard(c) : null,
      c && c.status === 'refused' ? el('div', { class: 'banner bad' }, 'Not accepted by the workbook: ' + (c.errors || []).join('. ') + '. Open Edit to fix it.') : null,
      el('div', { class: 'card' }, el('div', { class: 'vhead' }, el('b', null, r.name), el('span', { class: 'chip-st ' + (final ? 'fin' : 'draft') }, final ? 'final' : 'draft')),
        ['father_husband', 'age', 'marital', 'religion'].map(line),
        gpLine_(r) ? el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Obstetric'), el('span', { class: 'v' }, gpLine_(r))) : null,
        comorbidOf_(r).length ? el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Co-morbid'), el('span', { class: 'v' }, comorbidOf_(r).map((c) => (COMORBID.filter((x) => x[0] === c)[0] || [c, c])[1]).join(', '))) : null,
        ['date', 'admit_date', 'op_date', 'discharge_date', 'consultant', 'mo_name'].map(line),
        labsLine_(r) ? el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Investigations'), el('span', { class: 'v' }, labsLine_(r))) : null,
        final ? el('div', { class: 'small muted' }, 'Finalised by ' + r.finalised_by + ' on ' + s_(r.finalised_at)) : null),
      SECTIONS.map((k) => (s_(r[k]) ? el('div', { class: 'card' }, el('h2', null, colDef(k).label), el('div', { class: 'pre' }, r[k])) : null)),
      el('div', { class: 'stack' },
        el('button', { class: 'btn accent block', type: 'button', id: 'v-pdf', onclick: () => sharePdf(r) }, 'PDF: print or send on WhatsApp'),
        editable ? el('button', { class: 'btn block', type: 'button', id: 'v-edit', onclick: () => go('form', { uid: r.uid }) }, final ? 'Edit (final)' : 'Edit') : null,
        final && can('finalise') ? el('button', { class: 'btn block', type: 'button', id: 'v-reopen', onclick: () => { queueSave(r.uid, { status: 'D' }); saveState().then(() => sync()); render(); } }, 'Reopen as draft') : null,
        el('button', { class: 'btn block', type: 'button', id: 'v-again', onclick: () => newSummary(r) }, 'New admission, same patient'),
        can('template') ? el('button', { class: 'btn block', type: 'button', id: 'v-tpl', onclick: () => saveTemplate(r) }, 'Save as a template') : null)));
}
function conflictCard(c) {
  const cur0 = c.current || {};
  return el('div', { class: 'banner bad' }, el('b', null, 'Changed on another phone. '), (c.errors || []).join('. '), '. ',
    el('div', { class: 'chips' },
      el('button', { class: 'chip', type: 'button', id: 'keep-mine', onclick: async () => { Object.keys(c.values).forEach((k) => { c.base[k] = s_(cur0[k]); }); c.status = 'pending'; c.errors = null; c.rev++; await saveState(); sync(); render(); } }, 'Keep mine'),
      el('button', { class: 'chip', type: 'button', id: 'use-theirs', onclick: async () => { S.outbox.splice(S.outbox.indexOf(c), 1); await saveState(); sync(); render(); } }, 'Use theirs')));
}
function saveTemplate(r) {
  const nm = el('input', { type: 'text', id: 'tpl-name', maxlength: '60', value: s_(r.final_diagnoses).split('\n')[0].slice(0, 60) });
  modal('Save as a template', el('div', null, el('p', { class: 'small muted' }, 'Keeps the clinical sections only, never the patient\u2019s details. A template with the same name is replaced.'), el('label', { class: 'lab', for: 'tpl-name' }, 'Template name'), nm),
    [['Cancel', null], ['Save', () => {
      if (!navigator.onLine) { toast('Saving a template needs a signal.'); return false; }
      const values = {}; SECTIONS.forEach((k) => { values[k] = s_(r[k]); });
      api({ op: 'template_save', token: S.cfg.token, name: s_(nm.value), values, by: S.cfg.name }).then((x) => { toast(x.ok ? (x.replaced ? 'Template replaced' : 'Template saved') : x.error); if (x.ok) sync(); });
    }, 'primary']]);
}

// ------------------------------------------------------------------ settings and the PI's buttons screen
function settingsScreen() {
  const tile = (id, t, sub, fn) => el('button', { class: 'tile', type: 'button', id, onclick: fn }, el('b', null, t), el('span', null, sub));
  return el('div', { class: 'page' }, topBar('Settings'), el('main', null,
    el('div', { class: 'card' }, el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Name'), el('span', { class: 'v' }, S.cfg.name)),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Role'), el('span', { class: 'v' }, ROLE_NAMES[role()] || role())),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Account'), el('span', { class: 'v' }, S.cfg.email)),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Last sync'), el('span', { class: 'v' }, S.lastSync ? ago(S.lastSync) : 'never')),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'App build'), el('span', { class: 'v' }, BUILD_ID))),
    el('div', { class: 'tiles' },
      role() === 'pi' ? tile('t-invite', 'Invite', 'a consultant or medical officer', inviteDialog) : null,
      tile('t-update', 'Update app', 'check for a newer version', updateApp),
      tile('t-name', 'My name', 'as printed on summaries', () => {
        const i = el('input', { type: 'text', id: 'my-name', value: S.cfg.name, maxlength: '60' });
        modal('Your name', i, [['Cancel', null], ['Save', () => { if (s_(i.value).length < 3) return false; S.cfg.name = s_(i.value); saveState(); render(); }, 'primary']]);
      })),
    el('button', { class: 'btn danger block', type: 'button', id: 'reset', onclick: () => {
      const n = S.outbox.length;
      modal('Reset this phone?', el('p', null, n ? n + ' change(s) not yet sent will be lost. ' : '', 'You will need a new invitation.'), [['Cancel', null], ['Reset', resetPhone, 'danger']]);
    } }, 'Reset this phone')), bottomNav('settings'));
}
function inviteDialog() {
  const em = el('input', { type: 'email', id: 'inv-email', autocomplete: 'off', placeholder: 'name@gmail.com' });
  let r0 = 'consultant';
  const msg = el('div', { class: 'msg' });
  modal('Invite someone', el('div', null, el('label', { class: 'lab', for: 'inv-email' }, 'Google e-mail'), em, el('div', { class: 'lab' }, 'Role'),
    chipRow('inv-role', [['consultant', 'Consultant'], ['mo', 'Medical officer']], 'consultant', (x) => { r0 = x || 'consultant'; }), msg),
  [['Cancel', null], ['Make invitation', () => {
    if (!navigator.onLine) { msg.textContent = 'Needs a signal.'; return false; }
    api({ op: 'invite', token: S.cfg.token, email: s_(em.value), role: r0 }).then((r) => {
      if (!r.ok) { toast(r.error); return; }
      const box = el('textarea', { rows: '4', readonly: true, id: 'inv-link', value: r.link });
      modal('Invitation for ' + r.email + ' (' + r.roleName + ')', el('div', null, el('p', { class: 'small' }, 'Send it privately. It works once, on one phone, for ' + r.days + ' days.'), box),
        [['Close', null], ['Share', () => { if (navigator.share) navigator.share({ text: r.link }).catch(() => {}); else { box.select(); document.execCommand('copy'); toast('Copied'); } return false; }, 'primary']]);
    });
  }, 'primary']]);
}
function buttonsScreen() {
  const qs = (S.server && S.server.quick) || [], drafts = qs.filter((q) => q.draft);
  return el('div', { class: 'page' }, topBar('Quick buttons'), el('main', null,
    el('div', { class: 'card' }, el('p', null, qs.length + ' buttons, ' + drafts.length + ' draft. Drafts show with a dashed border, and only on your phone, until approved. Edit their wording in the QUICK tab of the workbook.'),
      drafts.length ? el('button', { class: 'btn primary block', type: 'button', id: 'approve-all', onclick: () => modal('Approve ' + drafts.length + ' draft buttons?', el('p', null, 'They appear on every phone after the next sync.'), [['Cancel', null], ['Approve all', async () => {
        const r = await api({ op: 'quick_approve', token: S.cfg.token }).catch((e) => ({ ok: false, error: e.message }));
        toast(r.ok ? r.n + ' approved' : r.error); if (r.ok) sync();
      }, 'primary']]) }, 'Approve all ' + drafts.length + ' drafts') : null),
    SECTIONS.map((k) => el('section', { class: 'card' }, el('h2', null, colDef(k).label + ' (' + quickFor(k).length + ')'),
      el('div', { class: 'chips' }, quickFor(k).map((q) => el('button', { class: 'chip q' + (q.draft ? ' draft' : ''), type: 'button', onclick: () => modal('Delete this button?', el('p', null, q.phrase), [['Cancel', null], ['Delete', async () => {
        const r = await api({ op: 'quick_delete', token: S.cfg.token, qid: q.qid }).catch((e) => ({ ok: false, error: e.message }));
        if (r.ok) { S.server.quick = S.server.quick.filter((x) => x.qid !== q.qid); await saveState(); render(); } else toast(r.error);
      }, 'danger']]) }, q.phrase)))))), bottomNav('buttons'));
}

// ------------------------------------------------------------------ PDF, made on the phone (works offline)
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const WIN = { '\u2018': 0x91, '\u2019': 0x92, '\u201c': 0x93, '\u201d': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x96, '\u00b0': 0xb0, '\u00b5': 0xb5, '\u00d7': 0xd7, '\u00b1': 0xb1, '\u2265': 0x3e, '\u2264': 0x3c };
function pdfText(s) {                                  // to the WinAnsi bytes the standard fonts read; anything else becomes ?
  let o = '';
  for (const ch of String(s)) { const c = ch.charCodeAt(0); if (c >= 32 && c < 127) o += ch; else if (WIN[ch]) o += String.fromCharCode(WIN[ch]); else if (c >= 0xa0 && c <= 0xff) o += ch; else o += '?'; }
  return o;
}
function tw(s, size, bold) { const W = bold ? W_BOLD : W_REG; let w = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); w += c >= 32 && c < 127 ? W[c - 32] : c === 0xb0 ? 400 : 556; } return w * size / 1000; }
function wrap(s, size, width, bold) {
  const out = [];
  String(s).replace(/\r\n?/g, '\n').split('\n').forEach((raw) => {
    const para = pdfText(raw);
    if (!para.trim()) { out.push(''); return; }
    let line = '';
    para.split(/ +/).forEach((w) => {
      const t = line ? line + ' ' + w : w;
      if (tw(t, size, bold) <= width) { line = t; return; }
      if (line) out.push(line);
      while (tw(w, size, bold) > width) { let n = w.length; while (n > 1 && tw(w.slice(0, n), size, bold) > width) n--; out.push(w.slice(0, n)); w = w.slice(n); }
      line = w;
    });
    out.push(line);
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}
function esc(s) { return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
function jpegSize(b) { let i = 2; while (i < b.length) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3]; if (m >= 0xc0 && m <= 0xc3) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], n: b[i + 9] }; i += 2 + len; } return null; }
const ASSETS = {};
async function asset(name) { if (!ASSETS[name]) { try { ASSETS[name] = new Uint8Array(await (await fetch(name)).arrayBuffer()); } catch (e) { ASSETS[name] = new Uint8Array(0); } } return ASSETS[name]; }
async function logoBytes() { return asset('logo.jpg'); }
async function pdfImages() { return { logo: await asset('logo.jpg'), qr: await asset('qr.jpg') }; }
const normName = (n) => s_(n).toLowerCase().replace(/^dr\.?\s*/, '').replace(/[^a-z]/g, '');
function staffOf(name) { const k = normName(name); return k ? ((S && S.server && S.server.staff) || []).filter((x) => normName(x.name) === k)[0] || null : null; }
function buildPdf(r, imgs) {
  if (imgs instanceof Uint8Array) imgs = { logo: imgs };
  const logo = (imgs && imgs.logo) || null, qr = (imgs && imgs.qr) || null, doc = staffOf(r.consultant);
  const PW = 595.28, PH = 841.89, M = 40, CW = PW - 2 * M, pages = [];
  const H = CFG.HOSPITAL, final = r.status === 'F';
  let ops = null, y = 0;
  const lg = logo && logo.length ? jpegSize(logo) : null, qg = qr && qr.length ? jpegSize(qr) : null;
  const T_ = (x, yy, s, size, bold) => ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + x.toFixed(2) + ' ' + yy.toFixed(2) + ' Td (' + esc(pdfText(s)) + ') Tj ET');
  const Tc = (cx, yy, s, size, bold) => T_(cx - tw(pdfText(s), size, bold) / 2, yy, s, size, bold);
  const rect = (x, yy, w, h) => ops.push(x.toFixed(2) + ' ' + yy.toFixed(2) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re S');
  const lineH = (x1, yy, x2) => ops.push(x1.toFixed(2) + ' ' + yy.toFixed(2) + ' m ' + x2.toFixed(2) + ' ' + yy.toFixed(2) + ' l S');
  const newPage = (first) => {
    ops = ['0.6 w 0 0 0 RG 0 0 0 rg']; pages.push(ops);
    if (first) {
      const top = PH - M;
      if (lg) { const h = 92, w = h * lg.w / lg.h; ops.push('q ' + w.toFixed(2) + ' 0 0 ' + h + ' ' + M + ' ' + (top - h).toFixed(2) + ' cm /Im1 Do Q'); }
      if (qg) { const q = 78; ops.push('q ' + q + ' 0 0 ' + q + ' ' + (PW - M - q).toFixed(2) + ' ' + (top - q).toFixed(2) + ' cm /Im2 Do Q'); Tc(PW - M - q / 2, top - q - 8, 'Scan for directions', 7, false); }
      const cx = PW / 2;
      Tc(cx, top - 22, H.name, 20, true);
      Tc(cx, top - 40, H.address, 10.5, false);
      Tc(cx, top - 54, H.phone, 10.5, true);
      Tc(cx, top - 80, 'DISCHARGE SUMMARY', 15, true);
      lineH(cx - 80, top - 84, cx + 80);
      y = top - 104;
      if (r.ds_no) { y -= 2; ops.push('BT /F2 10 Tf ' + (PW - M - tw('No. ' + r.ds_no, 10, true)).toFixed(2) + ' ' + y.toFixed(2) + ' Td (' + esc('No. ' + r.ds_no) + ') Tj ET'); y -= 6; }
      else y -= 4;
    } else {
      T_(M, PH - M - 4, 'Discharge summary: ' + (r.name || '') + (r.ds_no ? ' (' + r.ds_no + ')' : ''), 9, true);
      lineH(M, PH - M - 10, PW - M);
      y = PH - M - 28;
    }
    if (!final) ops.push('q 0.85 g BT /F2 64 Tf 0.819 0.574 -0.574 0.819 150 300 Tm (DRAFT) Tj ET Q');
  };
  const need = (h) => { if (y - h < M + 30) newPage(false); };
  newPage(true);
  // the patient box, as on the pad
  const cell = (x, yy, w, h, label, val) => { rect(x, yy - h, w, h); T_(x + 5, yy - 11, label, 7.5, true); wrap(val, 10.5, w - 10).slice(0, 2).forEach((l, i) => T_(x + 5, yy - 25 - i * 12, l, 10.5, false)); };
  const code = (k) => (s_(r[k]) ? codeLabel_(k, r[k]) : '');
  const gp = (s_(r.gravida) || s_(r.para)) ? 'G' + (s_(r.gravida) || '?') + ' P' + (s_(r.para) || '?') : '';
  const rows = [
    [[0.58, 'NAME', r.name], [0.42, 'HUSBAND\u2019S / FATHER\u2019S NAME', r.father_husband]],
    [[0.12, 'AGE', r.age], [0.14, 'GRAVIDA / PARA', gp], [0.16, 'GESTATION', s_(r.gest_weeks) ? r.gest_weeks + ' weeks' : ''], [0.18, 'MARITAL STATUS', code('marital')], [0.18, 'RELIGION', code('religion')], [0.22, 'DATE', dmy(r.date)]],
    [[0.2, 'DATE OF ADMISSION', dmy(r.admit_date)], [0.2, 'DATE OF OPERATION', dmy(r.op_date)], [0.2, 'DATE OF DISCHARGE', dmy(r.discharge_date)], [0.4, 'CONSULTANT', r.consultant]]
  ];
  rows.forEach((row) => { let x = M; const h = row.some((c) => wrap(c[2] || '', 10.5, c[0] * CW - 10).length > 1) ? 44 : 34; row.forEach((c) => { cell(x, y, c[0] * CW, h, c[1], c[2] || ''); x += c[0] * CW; }); y -= h; });
  y -= 14;
  // the sections, flowing onto more pages when long
  const blocks = [];
  SECTIONS.forEach((k) => {
    const txt = k === 'final_diagnoses' ? [gpLine_(r), s_(r[k])].filter(Boolean).join('\n')
      : k === 'physical_findings' ? s_(r[k]).split('\n').map((x) => x.trim().replace(/[.,;]+$/, '')).filter(Boolean).join(', ')   // short readings read better as one paragraph and keep the page to one sheet
      : s_(r[k]);
    blocks.push([colDef(k).label, txt]);
    if (k === 'physical_findings') blocks.push(['Investigations', labsLine_(r)]);
  });
  blocks.forEach((bk) => {
    const lines = wrap(bk[1] || '-', 10.5, CW - 8);
    need(34);
    const head = bk[0].toUpperCase();
    T_(M, y, head, 11, true); lineH(M, y - 2, M + tw(pdfText(head), 11, true)); y -= 16;
    lines.forEach((l) => { need(14); T_(M + 4, y, l, 10.5, false); y -= 13.5; });
    y -= 10;
  });
  need(86); y -= 26;
  lineH(PW - M - 200, y, PW - M);
  T_(PW - M - 200, y - 12, 'Signature of Consultant', 9, true);
  if (r.consultant) {                                   // the consultant's details, printed once, here
    const sx = PW - M - 200, lines = [[doc ? doc.name : r.consultant, true]];
    if (doc && doc.specialty) lines.push([doc.specialty, false]);
    if (doc && doc.qualifications) lines.push([doc.qualifications, false]);
    if (doc && doc.phone) lines.push(['Ph: ' + doc.phone, false]);
    lines.forEach((l, i) => wrap(l[0], 9.5, 200, l[1]).forEach((t, j) => T_(sx, y - 24 - (i + j) * 12, t, 9.5, l[1])));
  }
  const stamp = (final ? 'Final' : 'DRAFT, not final') + (r.finalised_by ? ' | finalised by ' + r.finalised_by + ' ' + s_(r.finalised_at) : '');
  pages.forEach((p, i) => { const o = ops; ops = p; T_(M, 22, stamp, 7.5, false); T_(PW - M - 60, 22, 'Page ' + (i + 1) + ' of ' + pages.length, 7.5, false); ops = o; });
  // assemble the file
  const enc = new TextEncoder(), parts = [], offs = [];
  let len = 0;
  const put = (x) => { const b = typeof x === 'string' ? Uint8Array.from(x, (c) => c.charCodeAt(0) & 255) : x; parts.push(b); len += b.length; };
  const objs = [];                                      // [body parts]
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null), pagesObj = add(null), f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'), f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const jpg = (g, b) => add(['<< /Type /XObject /Subtype /Image /Width ' + g.w + ' /Height ' + g.h + ' /ColorSpace /' + (g.n === 1 ? 'DeviceGray' : 'DeviceRGB') + ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + b.length + ' >>\nstream\n', b, '\nendstream']);
  const img = lg ? jpg(lg, logo) : 0, img2 = qg ? jpg(qg, qr) : 0;
  const kids = pages.map((p) => {
    const s = p.join('\n');
    const c = add('<< /Length ' + s.length + ' >>\nstream\n' + s + '\nendstream');
    return add('<< /Type /Page /Parent ' + pagesObj + ' 0 R /MediaBox [0 0 ' + PW + ' ' + PH + '] /Resources << /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R >>' + (img || img2 ? ' /XObject <<' + (img ? ' /Im1 ' + img + ' 0 R' : '') + (img2 ? ' /Im2 ' + img2 + ' 0 R' : '') + ' >>' : '') + ' >> /Contents ' + c + ' 0 R >>');
  });
  objs[catalog - 1] = '<< /Type /Catalog /Pages ' + pagesObj + ' 0 R >>';
  objs[pagesObj - 1] = '<< /Type /Pages /Kids [' + kids.map((k) => k + ' 0 R').join(' ') + '] /Count ' + kids.length + ' >>';
  put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  objs.forEach((b, i) => { offs.push(len); put((i + 1) + ' 0 obj\n'); (Array.isArray(b) ? b : [b]).forEach(put); put('\nendobj\n'); });
  const xref = len;
  put('xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  put('trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R /Info << /Title (' + esc(pdfText('Discharge summary ' + (r.ds_no || '') + ' ' + (r.name || ''))) + ') /Producer (Bari Discharge) >> >>\nstartxref\n' + xref + '\n%%EOF\n');
  void enc;
  const out = new Uint8Array(len); let p0 = 0; parts.forEach((b) => { out.set(b, p0); p0 += b.length; });
  return out;
}
async function sharePdf(r) {
  try {
    const bytes = buildPdf(r, await pdfImages());
    const name = ((r.ds_no || 'Draft') + ' ' + (r.name || 'summary')).replace(/[^\w .-]+/g, '').trim() + '.pdf';
    const file = new File([bytes], name, { type: 'application/pdf' });
    T.lastPdf = bytes;
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    const url = URL.createObjectURL(file), a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { if (e && e.name !== 'AbortError') toast('Could not make the PDF: ' + e.message); }
}

// ------------------------------------------------------------------ updates
let updateReady = false;
function applyUpdateIfSafe() { if (!updateReady || KEY || T.pin || T.join) return; location.reload(); }
async function updateApp() {
  if (updateReady) { location.reload(); return; }
  try {
    const t = await (await fetch('sw.js', { cache: 'no-store' })).text();
    const m = /bari-([0-9a-f]+)/.exec(t);
    if (m && m[1] !== BUILD_ID) { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); toast('New version downloading. Close and reopen the app in a minute.'); }
    else toast('Already the newest version (' + BUILD_ID + ')');
  } catch (e) { toast('Checking needs a signal.'); }
}
function setupAutoUpdate() {
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    const check = () => { if (navigator.onLine) reg.update().catch(() => {}); };
    check(); window.addEventListener('online', check);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) { updateReady = true; applyUpdateIfSafe(); } });
  setInterval(applyUpdateIfSafe, 15000);
}

(async function start() {
  readJoin();
  try { T.hasVault = !!(await kvGet('vault')); } catch (e) { T.hasVault = false; }
  if (T.hasVault) await sessRestore();
  if (S && !S.usage) S.usage = {};
  if ('serviceWorker' in navigator && location.protocol === 'https:') setupAutoUpdate();
  render();
})();
