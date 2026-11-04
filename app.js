/* Bari Discharge v1.0. Discharge summaries for Bari Clinic & Hospital.
 * Entries are kept on the phone, encrypted with a key made from the user's PIN, and sent to the
 * workbook (BariDischarge.gs web app) whenever the phone is online. Fields, codes and checks come from
 * logic.js, which build.js copies from the workbook script itself, so phone and sheet always agree. */
'use strict';
const APP_VERSION = '1.7';
const BUILD_ID = 'ca76e0fb2ba6';
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
const kvDel = (k) => kv('readwrite', (s) => s.delete(k));
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

// ------------------------------------------------------------------ Face ID / fingerprint (from TBDM Field)
// The PIN stays the master key. At set-up the unlocked vault key is encrypted under a key that the phone's own authenticator releases only after
// a Face ID or fingerprint check (the WebAuthn PRF extension). Nothing the phone stores can open the vault without that check, and where the phone
// cannot do this the option is not offered: a button that merely hides the PIN would be weaker than the PIN itself.
function bioIcon() {
  const b = el('span', { class: 'bioico', 'aria-hidden': 'true' });
  b.innerHTML = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 17V12a6 6 0 0 1 6-6h5M31 6h5a6 6 0 0 1 6 6v5M42 31v5a6 6 0 0 1-6 6h-5M17 42h-5a6 6 0 0 1-6-6v-5"/><path d="M17.5 19v3M30.5 19v3M24 19.5v6.5h-2.2M17.5 31.5c3.8 3.6 9.2 3.6 13 0"/></svg>';
  return b;
}
const ANDROID = /Android/i.test(navigator.userAgent);
async function bioAvailable() {
  T.bioWhy = '';
  if (!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create)) { T.bioWhy = 'WebAuthn: not in this browser'; return false; }
  try {
    let caps = null;
    if (PublicKeyCredential.getClientCapabilities) { try { caps = await PublicKeyCredential.getClientCapabilities(); } catch (e) { caps = null; } }
    const v = caps && caps.userVerifyingPlatformAuthenticator !== undefined ? !!caps.userVerifyingPlatformAuthenticator : await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    const prf = caps ? caps['extension:prf'] : undefined;
    T.bioWhy = 'built-in biometric: ' + (v ? 'yes' : 'no') + '; key release (PRF): ' + (prf === true ? 'yes' : prf === false ? 'no' : 'not reported');
    if (!v && ANDROID) T.bioWhy += '. Set a screen lock with a fingerprint and sign in to a Google account on the phone';
    if (prf === false) { T.bioWhy += '. This browser cannot release the key after a fingerprint check' + (ANDROID ? '; update Chrome and Google Play services' : ''); return false; }
    return !!v;
  } catch (e) { T.bioWhy = 'check failed (' + (e && e.name) + ')'; return false; }
}
async function bioWrapKey(prf) {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('bari pin wrap v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function prfOut(cred) { const x = cred && cred.getClientExtensionResults && cred.getClientExtensionResults(); return x && x.prf && x.prf.results && x.prf.results.first ? new Uint8Array(x.prf.results.first) : null; }
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
async function bioAsk(id, prfSalt) {
  const a = await navigator.credentials.get({ publicKey: { challenge: rnd(32), allowCredentials: [Object.assign({ type: 'public-key', id }, ANDROID ? {} : { transports: ['internal'] })], userVerification: 'required', hints: ['client-device'], timeout: 60000, extensions: { prf: { eval: { first: prfSalt } } } } });
  return prfOut(a);
}
async function bioEnrol() {                               // called straight from a tap: phones allow Face ID only in answer to one
  let step = 'start';
  try {
    if (!KEY) throw new Error('The app is locked.');
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', KEY)), prfSalt = rnd(32);
    step = 'passkey';
    const cred = await navigator.credentials.create({ publicKey: { rp: { name: 'Bari Discharge' }, user: { id: rnd(16), name: S.cfg.email || 'user', displayName: S.cfg.name || 'user' }, challenge: rnd(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: ANDROID ? 'required' : 'discouraged', requireResidentKey: ANDROID },
      hints: ['client-device'], timeout: 60000, extensions: { prf: { eval: { first: prfSalt } } } } });
    const id = new Uint8Array(cred.rawId);
    step = 'secret';
    const out = prfOut(cred) || await bioAsk(id, prfSalt);               // some phones give the secret only on the next check
    if (!out) throw new Error('This phone or browser cannot lock the app to Face ID or fingerprint. Keep using the PIN.');
    step = 'save';
    const iv = rnd(12), ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await bioWrapKey(out), raw);
    await kvSet('bio', { v: 2, id, prfSalt, iv, ct, salt: T.salt });
    T.hasBio = true;
  } catch (e) { if (e && !e.step) e.step = step; throw e; }
}
async function bioOpen() {
  const b = await kvGet('bio');
  if (!b || b.v !== 2) throw Object.assign(new Error('not set up'), { name: 'OperationError' });
  const out = await bioAsk(b.id, b.prfSalt);
  if (!out) throw new Error('The check did not release the key.');
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.iv }, await bioWrapKey(out), b.ct);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
  const vault = await kvGet('vault');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vault.iv }, key, vault.ct);
  T.salt = vault.salt; KEY = key; S = JSON.parse(new TextDecoder().decode(pt));
  if (!S.usage) S.usage = {};
  sessSave();
}
async function bioTurnOn() {
  try { await bioEnrol(); toast('Face ID or fingerprint is on'); }
  catch (e) { toast(e && e.name === 'NotAllowedError' ? 'Cancelled, or the phone refused the check. Nothing was changed.' : 'Could not turn it on (' + (e && e.step ? e.step + ': ' : '') + (e && e.name) + ': ' + ((e && e.message) || '') + ')'); }
  render();
}
const BIOASK = 'bari-bioask';
function offerBio() {                                     // after a correct PIN, once: "Not now" is remembered
  let declined = false; try { declined = localStorage.getItem(BIOASK) === 'no'; } catch (e) { /* ignore */ }
  const wanted = T.bioWant; T.bioWant = false;
  if (!KEY || T.hasBio || !T.bioOk || (declined && !wanted)) return;
  modal('Open the app with Face ID or fingerprint?', el('p', null, 'Next time you can unlock without typing the PIN. The PIN keeps working as a back-up.'),
    [['Not now', () => { try { localStorage.setItem(BIOASK, 'no'); } catch (e) { /* ignore */ } }], ['Set up', bioTurnOn, 'primary']]);
}
async function bioOff() { try { await kvDel('bio'); } catch (e) { /* ignore */ } T.hasBio = false; }

// ------------------------------------------------------------------ records: the workbook's copy with this phone's unsent changes on top
function serverRows() { return (S.server && S.server.rows) || []; }
function serverRow(uid) { return serverRows().filter((r) => r.uid === uid)[0] || null; }
function pendingOf(uid) { return S.outbox.filter((c) => c.uid === uid)[0] || null; }
function records() {
  const m = {};
  serverRows().forEach((r) => { m[r.uid] = Object.assign({}, r); });
  S.outbox.forEach((c) => { m[c.uid] = Object.assign(m[c.uid] || Object.assign({}, c.lastKnown || { uid: c.uid, ds_no: '', status: 'D' }), c.values, { _pending: c.status }); });
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
    if (hi.ok && (hi.reset || '') !== (S.resetSeen || '')) {          // the PI cleared the records (a test run): drop this phone's copy and anything unsent
      const lost = S.outbox.length;
      S.outbox = []; if (S.server) { S.server.rows = []; S.server.certs = []; } S.resetSeen = hi.reset || ''; T.form = null;
      await saveState(); still();
      if (lost) toast('The PI cleared the test records: ' + lost + ' unsent change(s) on this phone were dropped.');
    }
    if (hi.ok && Number(hi.schema) !== CFG.SCHEMA_VER) throw new Error('The app and the workbook are different versions. Close the app and open it again while online. Your entries are kept.');
    const pending = S.outbox.filter((c) => c.status === 'pending');
    for (let i = 0; i < pending.length; i += PUSH_BATCH) {
      const part = pending.slice(i, i + PUSH_BATCH), revs = {};
      part.forEach((c) => { revs[c.cid] = c.rev; });
      const res = await api({ op: 'push', token: S.cfg.token, schema: CFG.SCHEMA_VER, changes: part.map((c) => ({ cid: c.cid, uid: c.uid, create: c.create, values: c.values, base: c.base, by: c.by, reason: c.reason || '' })) }); still();
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
    const now = {}; pull.rows.forEach((x) => { now[x.uid] = true; });       // an edit whose summary vanished keeps the last copy seen, so it can be saved again
    S.outbox.forEach((c) => { const o = serverRow(c.uid); if (!now[c.uid] && o) c.lastKnown = o; });
    S.server = { rows: pull.rows, quick: pull.quick, templates: pull.templates, staff: pull.staff, certs: pull.certs || [], roleName: pull.roleName, today: pull.today, at: Date.now() };
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
function lock() { T.bioTried = false; sessClear(); KEY = null; S = null; T.form = null; T.nav = []; T.pin = ''; T.q = ''; clearTimeout(T.idle); render(); applyUpdateIfSafe(); }
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
      : c.name === 'buttons' ? buttonsScreen() : c.name === 'fu' ? fuScreen() : c.name === 'cert' ? certScreen(c.p) : c.name === 'certs' ? certsScreen() : homeScreen();
  }
  const f = KEY && S ? fabFor() : null;
  if (f) { page.classList.add('has-fab'); page.append(f); }
  app.replaceChildren(page);
}
// The main action of a screen sits at the bottom, in the thumb's reach, as an extended floating button (icon and label).
// It shrinks to its icon while the page scrolls down and grows again at the top. Left-handed users can put it on the left (Settings).
function fabFor() {
  const c = cur();
  if (c.name === 'home') return fab('new-summary', 'newdoc', 'New summary', () => newSummary());
  if (c.name === 'certs' && can('certify')) return fab('cert-walkin', 'certplus', 'Walk-in certificate', () => go('cert', { walk: true }));
  if (c.name === 'view' && can('certify')) { const r = record(c.p.uid); if (r && r.status === 'F') return fab('cert-new', 'certplus', 'Certificate', () => go('cert', { uid: r.uid })); }
  return null;
}
function fab(id, ic, label, fn) {
  const b = el('button', { class: 'fab' + (S.cfg.fabLeft ? ' left' : '') + (window.scrollY > 40 ? ' mini' : ''), type: 'button', id, 'aria-label': label, onclick: fn }, icon(ic), el('span', { class: 'fl' }, label));
  if (!cur().name || cur().name === 'home' || cur().name === 'certs') b.classList.add('above-bar');
  return b;
}
window.addEventListener('scroll', () => { const f = document.querySelector('.fab'); if (f) f.classList.toggle('mini', window.scrollY > 40); }, { passive: true });
function topBar(title, opts) {
  opts = opts || {};
  if (!opts.back && T.nav.length && navNested().indexOf(cur().name) >= 0) opts.back = true;     // a tab moved under Settings opens with a way back
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
const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  records: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>',
  buttons: '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="2"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="2"/><path d="M16.75 13.5v6.5M13.5 16.75H20"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  face: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.2 15.6a4 4 0 0 0 5.6 0"/>',
  invite: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-6 6.5-6s5.9 2.4 6.5 6"/><path d="M18.5 8v6M15.5 11h6"/>',
  update: '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>',
  name: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h2M14 14h2M8 17.5h2"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>',
  chat: '<path d="M4 19.5 5.3 16A8 8 0 1 1 8 18.7z"/><path d="M9 10.5h6M9 13.5h4"/>',
  newdoc: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M12 11v6M9 14h6"/>',
  certplus: '<path d="M5 3.5h10l4 4v13H5z"/><path d="M8 9h5M8 12h4"/><circle cx="14.5" cy="15.5" r="2.3"/><path d="m13.3 17.5-.8 3.2 2-1 2 1-.8-3.2"/>',
  cert: '<path d="M5 3.5h10l4 4v13H5z"/><path d="M8 9h6M8 12h8"/><circle cx="14.5" cy="16" r="2.3"/><path d="m13.3 18-.8 3.2 2-1 2 1-.8-3.2"/>'
};
const ICON_DETAIL = { records: [1], buttons: [3], calendar: [1], cert: [1, 2] };      // inner strokes that stay visible when the selected icon is filled
function icon(k) {
  const s = el('span', { class: 'ico', 'aria-hidden': 'true' });
  s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[k] + '</svg>';
  (ICON_DETAIL[k] || []).forEach((i) => { const c = s.querySelector('svg').children[i]; if (c) c.setAttribute('class', 'd'); });
  return s;
}
// The bar: Home and Settings stay; any other tab can be moved under Settings (press and hold it, drag it onto Settings) and put back from Settings.
// Buttons lives under Settings unless moved back. The choice is kept on this phone.
const NAV_FIXED = ['home', 'settings'];
function navAll() { return [['home', 'Home', 'home'], ['list', 'Summaries', 'records'], ['fu', 'Follow-ups', 'calendar'], ['certs', 'Certificates', 'cert']].concat(role() === 'pi' ? [['buttons', 'Buttons', 'buttons']] : []).concat([['settings', 'Settings', 'settings']]); }
function navNested() { const n = S && S.cfg && Array.isArray(S.cfg.nested) ? S.cfg.nested : ['buttons']; return n.filter((id) => NAV_FIXED.indexOf(id) < 0 && navAll().some((t) => t[0] === id)); }
function setNested(list, msg) { S.cfg.nested = list; saveState(); render(); if (msg) toast(msg); }
function navBadge(id) {
  const all = records();
  if (id === 'home') { const n = attention().length; return n ? [n, '', n + ' need attention'] : null; }
  if (id === 'fu') { const n = fuOpen().filter((x) => x.st === 'missed' || x.st === 'overdue' || x.st === 'today').length; return n ? [n, '', n + ' follow-ups due'] : null; }
  if (id === 'list') { const n = all.filter((r) => r.status !== 'F').length; return n ? [n, 'blue', n + ' drafts'] : null; }
  if (id === 'buttons') { const n = ((S.server && S.server.quick) || []).filter((q) => q.draft).length; return n ? [n, 'amber', n + ' draft buttons'] : null; }
  if (id === 'settings') { const b = navNested().map(navBadge).filter(Boolean); return b.length ? [b.reduce((t, x) => t + x[0], 0), b[0][1], 'inside Settings: ' + b.map((x) => x[2]).join(', ')] : null; }
  return null;
}
function bottomNav(active) {
  const nested = navNested(), shown = navAll().filter((t) => nested.indexOf(t[0]) < 0);
  if (nested.indexOf(active) >= 0) active = 'settings';
  const badge = (id) => { const b = navBadge(id); return b ? el('i', { class: 'badge' + (b[1] ? ' ' + b[1] : ''), 'aria-label': b[2] }, String(b[0])) : null; };
  const nav = el('nav', { class: 'bnav', 'aria-label': 'Main' }, shown.map((t) => {
    const b = el('button', { class: 'bn' + (t[0] === active ? ' on' : ''), type: 'button', id: 'nav-' + t[0], 'data-tab': t[0], 'aria-current': t[0] === active ? 'page' : null,
      onclick: () => { if (T.noClick) { T.noClick = false; return; } tabTo(t[0]); } }, icon(t[2]), badge(t[0]), el('span', { class: 'lbl' }, t[1]));
    if (NAV_FIXED.indexOf(t[0]) < 0) dragToSettings(b, t[0], t[1]);
    return b;
  }));
  // the top indicator slides from the tab that was selected to the new one (the bar is rebuilt on every screen, so its last place is remembered)
  const slide = el('i', { class: 'slide', 'aria-hidden': 'true' }); nav.append(slide);
  const place = (b) => { const w = b.offsetWidth; return { x: Math.round(b.offsetLeft + w * 0.22), w: Math.round(w * 0.56) }; };
  queueMicrotask(() => {
    const on = nav.querySelector('.bn.on'); if (!on) { slide.style.display = 'none'; return; }
    const to = place(on), prev = T.navPos && T.navPos.id !== active ? T.navPos : null, from = prev && nav.querySelector('[data-tab="' + prev.id + '"]');
    const set = (q) => { slide.style.width = q.w + 'px'; slide.style.transform = 'translateX(' + q.x + 'px)'; };
    const calm = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (from && calm) { set(place(from)); void slide.offsetWidth; slide.classList.add('go'); }
    set(to); T.navPos = { id: active };
  });
  return nav;
}

// ------------------------------------------------------------------ setup and lock
// Press and hold a tab (0.45 s), then drag it onto Settings. A tap still opens the tab; a small slip before the hold cancels the drag.
function dragToSettings(btn, id, label) {
  let timer = null, ghost = null, sx = 0, sy = 0, pid = null;
  const target = () => $('#nav-settings');
  const over = (x, y) => { const t = target(); if (!t) return false; const r = t.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top - 30 && y <= r.bottom; };
  const end = () => { clearTimeout(timer); timer = null; if (ghost) ghost.remove(); ghost = null; btn.classList.remove('lifting'); document.body.classList.remove('dragging'); const t = target(); if (t) t.classList.remove('over'); };
  btn.addEventListener('pointerdown', (e) => {
    sx = e.clientX; sy = e.clientY; pid = e.pointerId;
    timer = setTimeout(() => {
      timer = null;
      ghost = el('div', { class: 'navghost', 'aria-hidden': 'true' }, icon(btn.querySelector('.ico') ? navAll().filter((t) => t[0] === id)[0][2] : 'home'), el('span', null, label));
      document.body.append(ghost); ghost.style.left = sx + 'px'; ghost.style.top = sy + 'px';
      btn.classList.add('lifting'); document.body.classList.add('dragging');
      try { btn.setPointerCapture(pid); } catch (x) { /* not all browsers */ }
      if (navigator.vibrate) navigator.vibrate(15);
    }, 450);
  });
  btn.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { clearTimeout(timer); timer = null; }
    if (!ghost) return;
    ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
    const t = target(); if (t) t.classList.toggle('over', over(e.clientX, e.clientY));
  });
  btn.addEventListener('pointerup', (e) => {
    const dragging = !!ghost, hit = dragging && over(e.clientX, e.clientY);
    end();
    if (!dragging) return;
    T.noClick = true; setTimeout(() => { T.noClick = false; }, 400);
    if (hit) setNested(navNested().concat([id]), label + ' moved to Settings. Put it back from Settings.');
    else toast('Drop it on Settings to move it there.');
  });
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
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
      S = { cfg: { api: T.join.api, token: res.token, email: res.email, role: res.role, name: n, joined: Date.now() }, server: null, outbox: [], lastSync: 0, usage: {}, resetSeen: res.reset || '' };
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
    try { await openVault(pin); localStorage.setItem('bari-fails', '0'); T.lockMsg = ''; T.nav = []; bumpIdle(); render(); sync(); offerBio(); }
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
  const tryBio = async (auto) => {
    if (T.bioBusy === 'asking') return;                     // one check at a time: a second request would make the phone ask twice
    T.bioBusy = 'asking'; T.lockMsg = ''; if (!auto) render();
    try { await bioOpen(); localStorage.setItem('bari-fails', '0'); T.lockMsg = ''; T.nav = []; bumpIdle(); render(); sync(); }
    catch (e) {
      if (e && e.name === 'OperationError') { await bioOff(); T.lockMsg = 'Face ID or fingerprint no longer matches. Use the PIN, then set it up again in Settings.'; }
      else T.lockMsg = auto ? '' : e && e.name === 'NotAllowedError' ? 'Cancelled. Use the PIN, or try again.' : 'Face ID or fingerprint did not open the app. Use the PIN.';
      render();
    } finally { T.bioBusy = false; }
  };
  if (T.hasBio && !T.join && !T.bioTried && !(Date.now() < until)) { T.bioTried = true; T.bioBusy = 'waiting'; setTimeout(() => { if (!KEY && T.hasBio) tryBio(true); else T.bioBusy = false; }, 350); }
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
  return el('div', { class: 'lock' }, el('img', { class: 'logo', src: 'logo.jpg', alt: 'Bari Hospital' }),
    el('p', null, T.join ? 'An invitation was opened, but this phone is already set up. Unlock, then reset the phone in Settings to use it.' : 'Enter your PIN'),
    dots, el('div', { class: 'pad' }, keys.map((k) => el('button', { class: k.length > 1 ? 'txt' : '', type: 'button', 'aria-label': k === 'del' ? 'Delete' : k === 'ok' ? 'Unlock' : k, onclick: () => press(k) },
      k === 'del' ? 'Delete' : k === 'ok' ? 'Unlock' : k))), el('div', { class: 'err', role: 'alert' }, T.lockMsg || ''),
    el('button', { class: 'linkbtn', type: 'button', onclick: () => modal('Forgot your PIN?', el('p', null, 'The PIN cannot be recovered. Ask the PI for a new invitation, then reset this phone: summaries not yet sent from this phone are lost.'),
      [['Cancel', null], ['Reset this phone', resetPhone, 'danger']]) }, 'Forgot PIN?'),
    (T.hasBio || T.bioOk) && !T.join ? el('button', { class: 'bio', id: 'bio-unlock', type: 'button', 'aria-label': 'Unlock with Face ID or fingerprint', title: 'Face ID or fingerprint',
      onclick: () => { if (T.hasBio) tryBio(false); else { T.bioWant = true; T.lockMsg = 'Type your PIN once. You will then be asked to set up Face ID or fingerprint.'; render(); } } }, bioIcon()) : null);
}
async function resetPhone() { await kvClear(); sessClear(); KEY = null; S = null; T.hasVault = false; T.hasBio = false; T.nav = []; render(); }

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
      fuHomeCard(),
      searchBox(),
      el('div', { id: 'results' }),
      bad.length ? el('section', { class: 'feed alert' }, el('h2', null, 'Needs attention (' + bad.length + ')'), bad.map(card)) : null,
      el('section', { class: 'feed' }, el('h2', null, 'Drafts (' + drafts.length + ')'), drafts.length ? drafts.map(card) : el('p', { class: 'muted small' }, 'No drafts. Tap New summary at the bottom to start one.')),
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
        phoneField(set),
        codeField('marital', set), codeField('religion', set)),
      el('section', { class: 'card' }, el('h2', null, 'Obstetric'),
        codeField('gravida', set), codeField('para', set), codeField('gest_weeks', set), comorbidField(set)),
      el('section', { class: 'card' }, el('h2', null, 'Dates and doctors'),
        dateField('date', set, [['Today', 0]]),
        dateField('admit_date', set, [['Today', 0], ['Yesterday', 1], ['2 days ago', 2], ['3 days ago', 3]]),
        dateField('op_date', set, [['Today', 0], ['Yesterday', 1], ['2 days ago', 2], ['3 days ago', 3]]),
        dateField('discharge_date', set, [['Today', 0], ['Yesterday', 1]]),
        staffField('consultant', set, 'consultant'), staffField('mo_name', set, 'mo')),
      SECTIONS.map((k) => [sectionField(k, set), k === 'physical_findings' ? labsCard(set) : null, k === 'follow_up' ? fuFormCard(set) : null])),
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
  const chip = (q) => el('button', { class: 'chip q' + (q.draft ? ' draft' : ''), type: 'button', title: q.draft ? 'Draft: only the PI sees it until approved' : '', onclick: () => { insertPhrase(ta, q); set(k, ta.value); grow(); ta.dispatchEvent(new Event('input')); S.usage[q.qid] = (S.usage[q.qid] || 0) + 1; } }, q.phrase);
  const blocks = (top.length ? [['Most used', top]] : []).concat(groups.map((g) => [g, qs.filter((q) => q.group === g)]));
  const preview = k === 'discharge_meds' ? el('div', { class: 'urdu-prev', id: 'urdu-prev', lang: 'ur', dir: 'rtl' }) : null;
  const paintUrdu = () => { if (!preview) return; preview.replaceChildren(...ta.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => el('div', { class: urduFor_(l) ? '' : 'none' }, urduFor_(l) || 'No Urdu wording for this line. Add it after " | ".'))); };
  if (preview) { ta.addEventListener('input', paintUrdu); setTimeout(paintUrdu, 0); }
  if (k === 'follow_up') ta.addEventListener('input', () => paintFuHint(ta.value));
  return el('section', { class: 'card sec', id: 'w-' + k }, el('h2', null, el('label', { for: 'f-' + k }, colDef(k).label)), ta, preview,
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
  SECTIONS.forEach((k) => { if (s_(t[k])) v[k] = t[k]; });                 // the template's text replaces what is there (usually the Default)
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
  const sr = serverRow(F.uid), cur0 = record(F.uid) || {};
  const amending = sr && sr.status === 'F' && EDITABLE.some((k) => FU_KEYS.indexOf(k) < 0 && v[k] !== undefined && s_(v[k]) !== s_(cur0[k]));
  if (amending && !F.reason && stay) {                   // a final summary is being amended: the audit trail records why
    const why = el('input', { type: 'text', id: 'amend-reason', maxlength: '120' });
    modal('Why is this final summary being changed?', el('div', null, el('p', { class: 'small muted' }, 'The reason is kept in the audit trail with the old and new text.'), why,
      el('div', { class: 'chips' }, ['Correcting a mistake', 'Adding information', 'Result received later'].map((x) => el('button', { class: 'chip', type: 'button', onclick: () => { why.value = x; } }, x)))),
    [['Cancel', null], ['Save', () => { if (s_(why.value).length < 3) { toast('Give the reason'); return false; } F.reason = s_(why.value); saveForm(true); }, 'primary']]);
    return false;
  }
  queueSave(F.uid, v);
  if (F.reason) { const c = pendingOf(F.uid); if (c) c.reason = F.reason; F.reason = ''; }
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
  let asTpl = false;
  const tplName = el('input', { type: 'text', id: 'fin-tpl-name', maxlength: '60', value: s_(v.final_diagnoses).split('\n')[0].slice(0, 60), hidden: true });
  const tplBox = el('button', { class: 'chip box', type: 'button', id: 'fin-tpl', role: 'checkbox', 'aria-checked': 'false', onclick: (e) => {
    asTpl = !asTpl; e.currentTarget.classList.toggle('on', asTpl); e.currentTarget.setAttribute('aria-checked', asTpl ? 'true' : 'false');
    e.currentTarget.textContent = (asTpl ? '\u2611 ' : '\u2610 ') + 'Also save as a template'; tplName.hidden = !asTpl; if (asTpl) tplName.focus();
  } }, '\u2610 Also save as a template');
  modal('Finalise this summary?', el('div', null, el('p', null, 'It is marked final with your name. Only a consultant can change it afterwards.'),
    !s_(v.fu_date) ? el('p', { class: 'banner warn', id: 'fin-nofu' }, 'No follow-up date: she will not appear on the follow-up calendar. Cancel and set one under Next follow-up, or finalise without.') : null,
    can('template') ? el('div', null, tplBox, tplName, el('p', { class: 'small muted' }, 'A template keeps the clinical sections only, never the patient\u2019s details. The same name replaces an older template.')) : null),
  [['Cancel', null], ['Finalise', () => {
    v.status = 'F'; if (!s_(v.vcode)) v.vcode = rid().slice(0, 16); T.form.dirty = true;     // the verification code is made here, so the PDF carries its QR even offline
    const sections = {}; SECTIONS.forEach((k) => { sections[k] = s_(v[k]); });
    if (saveForm(false)) {
      const uid = T.form.uid; T.form = null; T.nav.pop(); T.nav.push({ name: 'view', p: { uid } }); render(); toast('Finalised');
      if (asTpl) sendTemplate(s_(tplName.value), sections);
    } else v.status = 'D';
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
      c && c.status === 'refused' ? (/no longer in the workbook/.test((c.errors || []).join(' '))
        ? el('div', { class: 'banner bad', id: 'gone-banner' }, el('b', null, 'This summary is no longer in the workbook'), ' (it was deleted, or the records were cleared after a test run). ',
          el('div', { class: 'chips' },
            el('button', { class: 'chip', type: 'button', id: 'gone-drop', onclick: () => dropLocal(r.uid, 'Removed from this phone') }, 'Remove from this phone'),
            el('button', { class: 'chip', type: 'button', id: 'gone-new', onclick: () => saveAsNew(r) }, 'Save it again as a new summary')))
        : el('div', { class: 'banner bad' }, 'Not accepted by the workbook: ' + (c.errors || []).join('. ') + '. Open Edit to fix it.')) : null,
      el('div', { class: 'card' }, el('div', { class: 'vhead' }, el('b', null, r.name), el('span', { class: 'chip-st ' + (final ? 'fin' : 'draft') }, final ? 'final' : 'draft')),
        ['father_husband', 'age', 'phone', 'marital', 'religion'].map(line),
        gpLine_(r) ? el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Obstetric'), el('span', { class: 'v' }, gpLine_(r))) : null,
        comorbidOf_(r).length ? el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Co-morbid'), el('span', { class: 'v' }, comorbidOf_(r).map((c) => (COMORBID.filter((x) => x[0] === c)[0] || [c, c])[1]).join(', '))) : null,
        ['date', 'admit_date', 'op_date', 'discharge_date', 'consultant', 'mo_name'].map(line),
        labsLine_(r) ? el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Investigations'), el('span', { class: 'v' }, labsLine_(r))) : null,
        final ? el('div', { class: 'small muted' }, 'Finalised by ' + r.finalised_by + ' on ' + s_(r.finalised_at)) : null,
        final && s_(r.vcode) ? el('div', { class: 'small muted', id: 'v-code' }, 'Verification code ' + vcodeShow_(r.vcode) + ': printed with a QR that anyone can scan to check this summary') : null),
      SECTIONS.map((k) => (s_(r[k]) ? el('div', { class: 'card' }, el('h2', null, colDef(k).label), el('div', { class: 'pre' }, r[k])) : null)),
      fuViewCard(r),
      final ? certCard(r) : null,
      el('div', { class: 'stack' },
        el('button', { class: 'btn accent block', type: 'button', id: 'v-pdf', onclick: () => sharePdf(r) }, 'PDF: print or send on WhatsApp'),
        editable ? el('button', { class: 'btn block', type: 'button', id: 'v-edit', onclick: () => go('form', { uid: r.uid }) }, final ? 'Edit (final)' : 'Edit') : null,
        final && can('finalise') ? el('button', { class: 'btn block', type: 'button', id: 'v-reopen', onclick: () => {
          const why = el('input', { type: 'text', id: 'reopen-reason', maxlength: '120' });
          modal('Reopen ' + (r.ds_no || '') + ' as a draft?', el('div', null, el('p', { class: 'small muted' }, 'Its QR will show "withdrawn" until it is finalised again. The reason goes in the audit trail.'), why,
            el('div', { class: 'chips' }, ['Correcting a mistake', 'Adding information'].map((x) => el('button', { class: 'chip', type: 'button', onclick: () => { why.value = x; } }, x)))),
          [['Cancel', null], ['Reopen', () => { if (s_(why.value).length < 3) { toast('Give the reason'); return false; } queueSave(r.uid, { status: 'D' }); const c = pendingOf(r.uid); if (c) c.reason = s_(why.value); saveState().then(() => sync()); render(); }, 'primary']]);
        } }, 'Reopen as draft') : null,
        el('button', { class: 'btn block', type: 'button', id: 'v-again', onclick: () => newSummary(r) }, 'New admission, same patient'),
        can('template') ? el('button', { class: 'btn block', type: 'button', id: 'v-tpl', onclick: () => saveTemplate(r) }, 'Save as a template') : null,
        canDelete_(role(), r, S.cfg.name) || !serverRow(r.uid) ? el('button', { class: 'btn danger block', type: 'button', id: 'v-delete', onclick: () => deleteRecord(r) }, 'Delete this summary') : null)));
}
// Delete: a summary never sent is just removed from this phone; one in the workbook is moved to its DELETED tab (online), with a reason.
function dropLocal(uid, msg) {
  S.outbox = S.outbox.filter((c) => c.uid !== uid);
  if (S.server) S.server.rows = (S.server.rows || []).filter((x) => x.uid !== uid);
  saveState().then(() => { T.form = null; tabTo('home'); toast(msg); });
}
function saveAsNew(r) {                                   // the edit outlived its record: keep the content as a fresh draft
  const c = pendingOf(r.uid), vals = {};
  EDITABLE.forEach((k) => { if (s_(r[k])) vals[k] = s_(r[k]); });
  vals.status = 'D'; delete vals.vcode;
  if (c) S.outbox.splice(S.outbox.indexOf(c), 1);
  if (S.server) S.server.rows = (S.server.rows || []).filter((x) => x.uid !== r.uid);
  const uid = rid();
  S.outbox.push({ cid: rid(), uid, create: true, values: vals, base: {}, status: 'pending', rev: 1, by: S.cfg.name });
  saveState().then(() => { sync(); T.nav = [{ name: 'view', p: { uid } }]; render(); toast('Saved again as a new draft'); });
}
function deleteRecord(r) {
  const onServer = !!serverRow(r.uid), certs = certsOf(r.uid).filter((c) => c.status !== 'W');
  if (onServer && certs.length) { modal('Withdraw its certificates first', el('p', null, certs.map((c) => c.cert_no).join(', ') + ' ' + (certs.length > 1 ? 'are' : 'is') + ' still in force. Withdraw ' + (certs.length > 1 ? 'them' : 'it') + ' below, then delete the summary.'), [['OK', null, 'primary']]); return; }
  if (!onServer) {
    modal('Remove ' + (r.name || 'this summary') + '?', el('p', null, 'It has not reached the workbook, so it is only on this phone. It will be gone for good.'), [['Cancel', null], ['Remove', () => dropLocal(r.uid, 'Removed'), 'danger']]);
    return;
  }
  const why = el('input', { type: 'text', id: 'del-reason', maxlength: '120', placeholder: 'e.g. test entry' });
  modal('Delete ' + (r.ds_no || 'this summary') + ' (' + (r.name || '') + ')?', el('div', null,
    el('p', null, 'It disappears from every phone. The workbook keeps a copy in its DELETED tab, with your name and the reason, which only the PI can see.'),
    el('label', { class: 'lab', for: 'del-reason' }, 'Reason'), why,
    el('div', { class: 'chips' }, ['Test entry', 'Duplicate', 'Wrong patient'].map((x) => el('button', { class: 'chip', type: 'button', onclick: () => { why.value = x; } }, x)))),
  [['Cancel', null], ['Delete', () => {
    if (s_(why.value).length < 3) { toast('Give the reason'); return false; }
    if (!navigator.onLine) { toast('Deleting needs a signal.'); return false; }
    api({ op: 'record_delete', token: S.cfg.token, uid: r.uid, reason: s_(why.value), by: S.cfg.name }).then((x) => {
      if (!x.ok) { toast(x.error); return; }
      dropLocal(r.uid, (r.ds_no || 'Summary') + ' deleted');
    }).catch((e) => toast('Not deleted: ' + e.message));
  }, 'danger']]);
}
function conflictCard(c) {
  const cur0 = c.current || {};
  return el('div', { class: 'banner bad' }, el('b', null, 'Changed on another phone. '), (c.errors || []).join('. '), '. ',
    el('div', { class: 'chips' },
      el('button', { class: 'chip', type: 'button', id: 'keep-mine', onclick: async () => { Object.keys(c.values).forEach((k) => { c.base[k] = s_(cur0[k]); }); c.status = 'pending'; c.errors = null; c.rev++; await saveState(); sync(); render(); } }, 'Keep mine'),
      el('button', { class: 'chip', type: 'button', id: 'use-theirs', onclick: async () => { S.outbox.splice(S.outbox.indexOf(c), 1); await saveState(); sync(); render(); } }, 'Use theirs')));
}
function sendTemplate(name, values) {
  if (name.length < 2) { toast('Template not saved: give it a name'); return; }
  if (!navigator.onLine) { toast('Template not saved: no signal. Save it later from the summary page.'); return; }
  api({ op: 'template_save', token: S.cfg.token, name, values, by: S.cfg.name }).then(async (x) => {
    toast(x.ok ? (x.replaced ? 'Template "' + name + '" replaced' : 'Template "' + name + '" saved') : 'Template not saved: ' + x.error);
    if (!x.ok) return;
    const list = (S.server.templates || []).filter((t) => s_(t.name).toLowerCase() !== name.toLowerCase());   // shown at once, even if a sync is already running
    S.server.templates = list.concat([Object.assign({ tid: x.tid, name }, values)]);
    await saveState(); if (cur().name === 'form' || cur().name === 'buttons') render();
  })
    .catch((e) => toast('Template not saved: ' + e.message));
}
function saveTemplate(r) {
  const nm = el('input', { type: 'text', id: 'tpl-name', maxlength: '60', value: s_(r.final_diagnoses).split('\n')[0].slice(0, 60) });
  modal('Save as a template', el('div', null, el('p', { class: 'small muted' }, 'Keeps the clinical sections only, never the patient\u2019s details. A template with the same name is replaced.'), el('label', { class: 'lab', for: 'tpl-name' }, 'Template name'), nm),
    [['Cancel', null], ['Save', () => {
      if (!navigator.onLine) { toast('Saving a template needs a signal.'); return false; }
      const values = {}; SECTIONS.forEach((k) => { values[k] = s_(r[k]); });
      sendTemplate(s_(nm.value), values);
    }, 'primary']]);
}

// ------------------------------------------------------------------ follow-ups: a recall list and calendar, as clinic systems keep them
// Each summary carries one next-visit date. Open visits are grouped by urgency (missed, overdue, today, this week, later), the way recall
// worklists in clinic software are; a missed visit stays at the top until someone rebooks or closes it, so nobody slips through.
const todayNo = () => dayNo_(dayIso(0));
function fuOpen() {
  const t = todayNo();
  return records().map((r) => ({ r, st: fuState_(r, t), d: dayNo_(r.fu_date) })).filter((x) => ['missed', 'overdue', 'today', 'soon', 'later'].indexOf(x.st) >= 0).sort((a, b) => a.d - b.d);
}
const FU_CLS = { missed: 'bad', overdue: 'bad', today: 'wait', soon: 'fin', later: 'draft', done: 'draft', none: 'draft' };
function fuWhen(r) {
  const d = dayNo_(r.fu_date), t = todayNo(); if (d === null) return '';
  const n = d - t;
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? '1 day overdue' : n < 0 ? -n + ' days overdue' : 'in ' + n + ' days';
}
function fuLabel(r, st) { return st === 'done' ? codeLabel_('fu_status', r.fu_status).toLowerCase() : st === 'missed' ? 'did not come' : fuWhen(r); }
function fuDayTxt(iso) { const d = dayNo_(iso); return d === null ? '' : WEEKDAYS[(d + 4) % 7] + ' ' + dmy(iso); }
function fuCard(x) {
  const r = x.r;
  return el('button', { class: 'rec fu', type: 'button', 'data-uid': r.uid, onclick: () => fuSheet(r.uid) },
    el('div', { class: 'main' }, el('div', { class: 'nm' }, r.name || '(no name)', s_(r.fu_reminded) ? el('span', { class: 'muted small' }, '  ✓ reminded') : null),
      el('div', { class: 'sub' }, [fuDayTxt(r.fu_date), r.fu_for, r.ds_no].filter(Boolean).join(' | '))),
    el('span', { class: 'chip-st ' + FU_CLS[x.st] }, fuLabel(r, x.st)));
}
function fuHomeCard() {
  const open = fuOpen(), late = open.filter((x) => x.st === 'missed' || x.st === 'overdue'), now = open.filter((x) => x.st === 'today'), soon = open.filter((x) => x.st === 'soon');
  const stat = (id, n, t, cls) => el('button', { class: 'fstat ' + (n ? cls : 'zero'), type: 'button', id, onclick: () => tabTo('fu') }, el('b', null, String(n)), el('span', null, t));
  const due = late.concat(now);
  return el('section', { class: 'card fuhome', id: 'fu-home' }, el('h2', null, 'Follow-ups'),
    el('div', { class: 'fstats' }, stat('fs-late', late.length, 'overdue or missed', 'bad'), stat('fs-today', now.length, 'due today', 'wait'), stat('fs-soon', soon.length, 'next 7 days', 'fin')),
    due.length ? due.slice(0, 6).map(fuCard) : el('p', { class: 'muted small' }, open.length ? 'Nobody is due today.' : 'No follow-ups booked. Set a next-visit date on a summary and she appears here when she is due.'),
    due.length > 6 ? el('p', { class: 'muted small' }, '+ ' + (due.length - 6) + ' more on the calendar') : null,
    el('button', { class: 'linkbtn', type: 'button', id: 'fu-open-cal', onclick: () => tabTo('fu') }, 'Open the follow-up calendar'));
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fuScreen() {
  const t = todayNo(), all = records();
  if (!T.fuMonth) T.fuMonth = dayIso(0).slice(0, 7);
  if (!T.fuDay) T.fuDay = dayIso(0);
  const ym = T.fuMonth.split('-').map(Number), yy = ym[0], mm = ym[1], first = dayNo_(T.fuMonth + '-01'), days = new Date(yy, mm, 0).getDate();
  const byDay = {};
  all.forEach((r) => { const d = dayNo_(r.fu_date); if (d === null) return; (byDay[d] = byDay[d] || []).push({ r, st: fuState_(r, t), d }); });
  const lead = (first + 3) % 7;                                    // Monday first: 1970-01-01 (day 0) was a Thursday
  const worst = (xs) => ['missed', 'overdue', 'today', 'soon', 'later', 'done'].filter((s) => xs.some((x) => x.st === s))[0];
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(el('span', { class: 'cd blank' }));
  for (let i = 0; i < days; i++) {
    const d = first + i, xs = byDay[d] || [], iso = isoFromDay_(d), w = xs.length ? worst(xs) : '';
    cells.push(el('button', { class: 'cd' + (d === t ? ' now' : '') + (iso === T.fuDay ? ' sel' : '') + (w ? ' has ' + w : ''), type: 'button', 'data-day': iso,
      'aria-label': fuDayTxt(iso) + (xs.length ? ', ' + xs.length + ' follow-up' + (xs.length > 1 ? 's' : '') : ''),
      onclick: () => { T.fuDay = iso; render(); } }, el('span', { class: 'dn' }, String(i + 1)), xs.length ? el('i', { class: 'cnt' }, String(xs.length)) : null));
  }
  const month = (n) => { const d = new Date(yy, mm - 1 + n, 1); T.fuMonth = d.getFullYear() + '-' + pad2(d.getMonth() + 1); render(); };
  const open = fuOpen(), late = open.filter((x) => x.st === 'missed' || x.st === 'overdue');
  const sel = (byDay[dayNo_(T.fuDay)] || []).sort((a, b) => (a.r.name || '').localeCompare(b.r.name || ''));
  const week = open.filter((x) => x.st === 'today' || x.st === 'soon');
  const away = T.fuMonth !== dayIso(0).slice(0, 7) || T.fuDay !== dayIso(0);
  return el('div', { class: 'page' }, topBar('Follow-ups'), el('main', null,
    late.length ? el('section', { class: 'feed alert', id: 'fu-late' }, el('h2', null, 'Overdue or missed (' + late.length + ')'),
      el('p', { class: 'small muted' }, 'Call her or send a reminder, then rebook or close. She stays here until you do.'), late.map(fuCard)) : null,
    el('section', { class: 'card cal', id: 'fu-cal' },
      el('div', { class: 'calhead' }, el('button', { class: 'calnav', type: 'button', id: 'cal-prev', 'aria-label': 'Previous month', onclick: () => month(-1) }, '‹'),
        el('b', { id: 'cal-month' }, MONTHS[mm - 1] + ' ' + yy), el('button', { class: 'calnav', type: 'button', id: 'cal-next', 'aria-label': 'Next month', onclick: () => month(1) }, '›')),
      el('div', { class: 'calgrid' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => el('span', { class: 'wd' }, d)), cells),
      el('div', { class: 'calkey small muted' }, el('i', { class: 'k bad' }), 'overdue or missed', el('i', { class: 'k wait' }), 'today', el('i', { class: 'k fin' }), 'booked', el('i', { class: 'k done' }), 'attended or closed'),
      away ? el('button', { class: 'linkbtn', type: 'button', id: 'cal-today', onclick: () => { T.fuMonth = dayIso(0).slice(0, 7); T.fuDay = dayIso(0); render(); } }, 'Back to today') : null),
    el('section', { class: 'feed', id: 'fu-day' }, el('h2', null, fuDayTxt(T.fuDay) + ' (' + sel.length + ')'), sel.length ? sel.map(fuCard) : el('p', { class: 'muted small' }, 'Nobody booked on this day.')),
    el('section', { class: 'feed', id: 'fu-week' }, el('h2', null, 'Due in the next 7 days (' + week.length + ')'), week.length ? week.map(fuCard) : el('p', { class: 'muted small' }, 'None.'))), bottomNav('fu'));
}
// The next-visit date on the form: buttons count from the date of discharge, and the instructions suggest one ("Stitch removal after 7 days").
const FU_STEPS = [['1 week', 7], ['10 days', 10], ['2 weeks', 14], ['4 weeks', 28], ['6 weeks', 42]];
function fuReasonOf(text) {
  const t = s_(text);
  return /stitch|suture|clip/i.test(t) ? 'Stitch removal' : /postnatal|6 weeks/i.test(t) ? 'Postnatal check (6 weeks)' : /\bBP\b/.test(t) ? 'BP check' : /sugar/i.test(t) ? 'Sugar check' : /report/i.test(t) ? 'Review with reports' : 'Wound check';
}
function paintFuHint(text) {
  const box = $('#fu-hint'); if (!box || !T.form) return;
  const hits = s_(text).split('\n').filter((l) => fuAfterDays_(l)).sort((x, y) => fuAfterDays_(x) - fuAfterDays_(y));     // the soonest visit named
  const n = hits.length ? fuAfterDays_(hits[0]) : 0, base = s_(T.form.vals.discharge_date) || dayIso(0), iso = n ? addDays_(base, n) : '';
  box.replaceChildren();
  if (!iso || iso === s_(T.form.vals.fu_date)) return;
  const reason = fuReasonOf(hits[0]);
  box.append(el('button', { class: 'chip tpl', type: 'button', id: 'fu-suggest', onclick: () => {
    T.form.vals.fu_date = iso; T.form.vals.fu_for = reason; T.form.dirty = true; const y = window.scrollY; render(); window.scrollTo(0, y);
  } }, 'From the instructions: ' + fuDayTxt(iso) + ' (' + reason + ')'));
}
function fuFormCard(set) {
  const v = T.form.vals, base = s_(v.discharge_date) || dayIso(0);
  const di = el('input', { type: 'date', id: 'f-fu_date', value: s_(v.fu_date), min: s_(v.discharge_date) || null });
  const when = el('div', { class: 'hint', id: 'fu-when' }, s_(v.fu_date) ? fuDayTxt(v.fu_date) + ', ' + fuWhen(v) : 'Not booked');
  const setDate = (iso) => {
    di.value = iso; set('fu_date', iso);
    if (s_(v.fu_status)) set('fu_status', '');                    // a new date means she is expected again
    when.textContent = iso ? fuDayTxt(iso) + ', ' + fuWhen(v) : 'Not booked'; paintFuHint(s_(v.follow_up));
  };
  di.addEventListener('input', () => setDate(di.value));
  const ri = el('input', { type: 'text', id: 'f-fu_for', value: s_(v.fu_for), maxlength: '200', autocomplete: 'off', placeholder: 'e.g. Wound check' });
  ri.addEventListener('input', () => set('fu_for', ri.value));
  setTimeout(() => paintFuHint(s_(v.follow_up)), 0);
  return el('section', { class: 'card', id: 'w-fu' }, el('h2', null, el('label', { for: 'f-fu_date' }, 'Next follow-up')),
    el('div', { class: 'hint' }, 'She appears on Home and the follow-up calendar when she is due. The buttons count from the date of discharge.'),
    el('div', { id: 'fu-hint', class: 'chips' }), di, when,
    el('div', { class: 'chips', id: 'c-fu_date' }, FU_STEPS.map((q) => el('button', { class: 'chip', type: 'button', onclick: () => setDate(addDays_(base, q[1])) }, q[0])),
      el('button', { class: 'chip', type: 'button', onclick: () => setDate('') }, 'None')),
    el('label', { class: 'lab', for: 'f-fu_for' }, colDef('fu_for').label), ri,
    el('div', { class: 'chips', id: 'c-fu_for' }, FU_REASONS.map((x) => el('button', { class: 'chip', type: 'button', onclick: () => { ri.value = x; set('fu_for', x); } }, x))));
}
function phoneField(set) {
  const i = el('input', { type: 'tel', id: 'f-phone', value: s_(T.form.vals.phone), inputmode: 'tel', autocomplete: 'off', maxlength: '20', placeholder: '0300 1234567' });
  i.addEventListener('input', () => set('phone', i.value.trim()));
  return fieldWrap('phone', i, el('div', { class: 'hint' }, 'For follow-up calls and WhatsApp reminders. Read it back to her before discharge.'));
}
function fuViewCard(r) {
  const st = fuState_(r, todayNo());
  return el('section', { class: 'card', id: 'fu-view' }, el('h2', null, 'Next follow-up'),
    st === 'none' ? el('p', { class: 'muted small' }, 'Not booked.')
      : el('div', { class: 'vhead fuv' }, el('span', null, fuDayTxt(r.fu_date) + (s_(r.fu_for) ? ', ' + r.fu_for : '')), el('span', { class: 'chip-st ' + FU_CLS[st] }, fuLabel(r, st))),
    s_(r.fu_note) ? el('div', { class: 'small muted' }, r.fu_note) : null,
    can('edit') ? el('button', { class: 'btn block', type: 'button', id: 'fu-manage', onclick: () => fuSheet(r.uid) }, st === 'none' ? 'Book a follow-up' : 'Manage this follow-up') : null);
}
function closeModal() { const m = $('#modal'); m.hidden = true; m.replaceChildren(); }
function fuSave(uid, vals, msg) {
  closeModal();
  if (!queueSave(uid, vals)) return;
  saveState().then(() => sync()); render(); if (msg) toast(msg);
}
function datePicker(id, onPick) {
  const t = dayIso(0), i = el('input', { type: 'date', id, min: t });
  return el('div', null, el('div', { class: 'chips' }, [['Tomorrow', 1], ['In 3 days', 3], ['In 1 week', 7], ['In 2 weeks', 14], ['In 4 weeks', 28], ['In 6 weeks', 42]].map((q) => el('button', { class: 'chip', type: 'button', onclick: () => onPick(addDays_(t, q[1])) }, q[0]))),
    el('div', { class: 'row2 pick' }, i, el('button', { class: 'btn', type: 'button', id: id + '-use', onclick: () => { if (dayNo_(i.value) !== null) onPick(i.value); else toast('Choose a date'); } }, 'Use this date')));
}
// One sheet for everything done with a follow-up: call, WhatsApp reminder, came, did not come, rebook, close. Each step is one tap.
function fuSheet(uid) {
  const r = record(uid); if (!r) return;
  if (!can('edit')) { go('view', { uid }); return; }
  const st = fuState_(r, todayNo()), today = dayIso(0), wa = waNumber_(r.phone), stamp = dmy(today), open = st !== 'none' && st !== 'done';
  const body = el('div', { id: 'fu-sheet' });
  const show = (...kids) => body.replaceChildren(...kids);
  const back = () => el('button', { class: 'linkbtn', type: 'button', onclick: main }, 'Back');
  const reasons = (pick, curv) => el('div', { class: 'chips', id: 'fu-reasons' }, FU_REASONS.map((x) => el('button', { class: 'chip' + (x === curv ? ' on' : ''), type: 'button', onclick: (e) => {
    body.querySelectorAll('#fu-reasons .chip').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); pick(x);
  } }, x)));
  function main() {
    show(el('div', { class: 'small muted' }, [r.ds_no, r.discharge_date ? 'discharged ' + dmy(r.discharge_date) : '', r.consultant].filter(Boolean).join(' | ')),
      st !== 'none' ? el('p', null, el('b', null, fuDayTxt(r.fu_date)), s_(r.fu_for) ? ', ' + r.fu_for + ' ' : ' ', el('span', { class: 'chip-st ' + FU_CLS[st] }, fuLabel(r, st))) : el('p', null, 'No follow-up booked.'),
      s_(r.phone) ? el('div', { class: 'chips' },
        el('a', { class: 'chip ic', href: 'tel:' + s_(r.phone).replace(/[^\d+]/g, ''), id: 'fu-call' }, icon('phone'), 'Call ' + r.phone),
        wa && open ? el('a', { class: 'chip ic', id: 'fu-wa', href: 'https://wa.me/' + wa + '?text=' + encodeURIComponent(fuReminder_(r)), target: '_blank', rel: 'noopener',
          onclick: () => setTimeout(() => fuSave(uid, { fu_reminded: today }, 'Reminder recorded'), 300) }, icon('chat'), s_(r.fu_reminded) ? 'Remind again (last ' + dmy(r.fu_reminded) + ')' : 'WhatsApp reminder') : null)
        : el('p', { class: 'small muted' }, 'No mobile number on this summary. Add it with Edit to call her or send a reminder.'),
      open ? el('div', { class: 'stack' },
        el('button', { class: 'btn primary block', type: 'button', id: 'fu-came', onclick: came }, 'She came'),
        st !== 'missed' ? el('button', { class: 'btn block', type: 'button', id: 'fu-missed', onclick: () => fuSave(uid, { fu_status: 'M', fu_note: 'Did not come on ' + dmy(r.fu_date) }, 'Marked missed: she stays on the list until rebooked or closed') }, 'She did not come') : null,
        el('button', { class: 'btn block', type: 'button', id: 'fu-move', onclick: move }, st === 'missed' || st === 'overdue' ? 'Rebook' : 'Change the date'),
        el('button', { class: 'btn danger block', type: 'button', id: 'fu-close', onclick: closeIt }, 'Close: no more follow-up'))
        : el('div', { class: 'stack' }, el('button', { class: 'btn primary block', type: 'button', id: 'fu-book', onclick: move }, st === 'done' ? 'Book another visit' : 'Book a follow-up')),
      s_(r.fu_log) ? el('details', { class: 'fulog' }, el('summary', null, 'History'), el('div', { class: 'pre small', id: 'fu-log' }, r.fu_log)) : null,
      el('div', { class: 'acts' }, el('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); if (cur().name !== 'view') go('view', { uid }); } }, 'Open summary'), el('button', { class: 'btn', type: 'button', id: 'fu-x', onclick: closeModal }, 'Close')));
  }
  function came() {
    let reason = 'Postnatal check (6 weeks)';
    show(el('p', null, 'Book her next visit, or finish the follow-up.'),
      el('div', { class: 'stack' }, el('button', { class: 'btn primary block', type: 'button', id: 'fu-done', onclick: () => fuSave(uid, { fu_status: 'A', fu_note: 'Came on ' + stamp }, 'Follow-up complete') }, 'No more visits: mark attended')),
      el('div', { class: 'lab' }, 'Or book the next visit for'), reasons((x) => { reason = x; }, reason),
      datePicker('fu-next', (iso) => fuSave(uid, { fu_date: iso, fu_for: reason, fu_status: '', fu_reminded: '', fu_note: 'Came on ' + stamp + (s_(r.fu_for) ? ' (' + r.fu_for + ')' : '') }, 'Next visit booked: ' + fuDayTxt(iso))), back());
  }
  function move() {
    let reason = s_(r.fu_for) || 'Wound check';
    show(el('div', { class: 'lab' }, 'Visit for'), reasons((x) => { reason = x; }, reason), el('div', { class: 'lab' }, 'New date'),
      datePicker('fu-new', (iso) => fuSave(uid, { fu_date: iso, fu_for: reason, fu_status: '', fu_reminded: '', fu_note: st === 'missed' || st === 'overdue' ? 'Rebooked on ' + stamp + ' after a missed visit' : s_(r.fu_note) }, 'Booked: ' + fuDayTxt(iso))), back());
  }
  function closeIt() {
    show(el('p', null, 'Why is the follow-up closed? She leaves the list; the summary itself is not changed.'),
      el('div', { class: 'stack' }, ['Seen elsewhere', 'Could not be reached', 'Declined further visits', 'Not needed'].map((x) => el('button', { class: 'btn block', type: 'button', onclick: () => fuSave(uid, { fu_status: 'X', fu_note: x + ' (' + stamp + ')' }, 'Follow-up closed') }, x))), back());
  }
  const m = $('#modal');
  m.replaceChildren(el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Follow-up' }, el('h3', null, r.name || 'Follow-up'), body));
  m.hidden = false; main();
}

// ------------------------------------------------------------------ medical certificates (sick leave, maternity leave, fitness, attendant)
// Issued by a consultant from a final summary, online, once. The workbook copies the patient's details from the summary, numbers the
// certificate and gives it a verification code; a wrong certificate is withdrawn (with a reason) and a new one issued, never edited.
function certsOf(uid) { return ((S.server && S.server.certs) || []).filter((c) => c.ds_uid === uid).sort((a, b) => (b.cert_no || '').localeCompare(a.cert_no || '')); }
function certLine(c, who) {
  const t = codeLabel2_(CTYPES, c.ctype), per = c.ctype === 'F' ? 'from ' + dmy(c.from_date) : dmy(c.from_date) + ' to ' + dmy(c.to_date) + ' (' + certDays_(c) + ' days)';
  return el('div', { class: 'certrow' + (c.status === 'W' ? ' gone' : ''), 'data-cert': c.cert_no },
    el('div', { class: 'main' }, el('b', null, c.cert_no + '  ' + t), who ? el('div', null, (c.title ? c.title + ' ' : '') + c.patient + (c.ds_no ? ' (' + c.ds_no + ')' : ' (walk-in)')) : null, el('div', { class: 'small muted' }, 'Issued ' + dmy(c.issued_on) + ' | ' + per + (c.ctype === 'A' ? ' | ' + c.attendant : '') + (c.status === 'W' ? ' | withdrawn: ' + c.withdraw_reason : ''))),
    el('button', { class: 'chip', type: 'button', onclick: () => shareCert(c) }, 'PDF'),
    c.status !== 'W' && can('certify') ? el('button', { class: 'chip', type: 'button', onclick: () => withdrawCert(c) }, 'Withdraw') : null);
}
function certCard(r) {
  const list = certsOf(r.uid);
  return el('section', { class: 'card', id: 'cert-card' }, el('h2', null, 'Medical certificates (' + list.length + ')'),
    list.length ? list.map(certLine) : el('p', { class: 'muted small' }, 'None issued. Sick leave, maternity leave, fitness to resume and attendant certificates are issued with the Certificate button at the bottom.'),);
}
const certDoc = (c) => ({ _cert: c, status: c.status === 'W' ? 'W' : 'F', ds_no: c.cert_no, name: c.patient, consultant: c.doctor, vcode: c.vcode });
async function shareCert(c) {
  try {
    const r = certDoc(c), bytes = buildPdf(r, await pdfImages(r));
    const name = (c.cert_no + ' ' + c.patient + ' ' + codeLabel2_(CTYPES, c.ctype)).replace(/[^\w .-]+/g, '').trim() + '.pdf';
    const file = new File([bytes], name, { type: 'application/pdf' });
    T.lastPdf = bytes;
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    const url = URL.createObjectURL(file), a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { if (e && e.name !== 'AbortError') toast('Could not make the PDF: ' + e.message); }
}
function withdrawCert(c) {
  const why = el('input', { type: 'text', id: 'cw-reason', maxlength: '120', placeholder: 'e.g. wrong dates' });
  modal('Withdraw ' + c.cert_no + '?', el('div', null, el('p', null, 'Anyone who scans its QR will see it is withdrawn. This cannot be undone; issue a new certificate if needed.'), el('label', { class: 'lab', for: 'cw-reason' }, 'Reason'), why,
    el('div', { class: 'chips' }, ['Wrong dates', 'Wrong kind of certificate', 'Issued in error'].map((x) => el('button', { class: 'chip', type: 'button', onclick: () => { why.value = x; } }, x)))),
  [['Cancel', null], ['Withdraw', () => {
    if (s_(why.value).length < 3) { toast('Give the reason'); return false; }
    if (!navigator.onLine) { toast('Withdrawing needs a signal.'); return false; }
    api({ op: 'cert_withdraw', token: S.cfg.token, cert_no: c.cert_no, reason: s_(why.value), by: S.cfg.name }).then(async (x) => {
      if (!x.ok) { toast(x.error); return; }
      if (x.cert) S.server.certs = S.server.certs.map((y) => (y.cert_no === c.cert_no ? x.cert : y));
      await saveState(); render(); toast(c.cert_no + ' withdrawn');
    }).catch((e) => toast('Not withdrawn: ' + e.message));
  }, 'danger']]);
}
// One form for both: from a final summary (p.uid: the patient's details come from the summary) or for a walk-in patient (p.walk: typed here).
function certScreen(p) {
  const walk = !!p.walk, r = walk ? null : record(p.uid);
  if (!walk && (!r || r.status !== 'F')) return el('div', { class: 'page' }, topBar('Certificate', { back: true }), el('main', null, el('p', null, 'Certificates are issued from final summaries.')));
  if (!can('certify')) return el('div', { class: 'page' }, topBar('Certificate', { back: true }), el('main', null, el('p', null, 'Only a consultant can issue certificates.')));
  const key = walk ? 'walk-in' : p.uid, today = dayIso(0);
  if (!T.cert || T.cert.key !== key) {
    const mine = ((S.server && S.server.staff) || []).filter((x) => x.role === 'consultant' && normName(x.name) === normName(S.cfg.name))[0];
    T.cert = { key, cuid: rid(), v: walk
      ? { ctype: 'R', purpose: 'W', title: 'Mrs', patient: '', guardian: '', age: '', exam_date: today, from_date: today, to_date: '', show_dx: 'N', dx: '', advice: '', addressed_to: '', birth_date: '', doctor: mine ? mine.name : '' }
      : { ctype: 'R', purpose: 'W', from_date: s_(r.admit_date), to_date: '', exam_date: s_(r.discharge_date), show_dx: 'N', dx: s_(r.final_diagnoses).split('\n')[0], advice: '', attendant: s_(r.father_husband), relation: 'Husband', addressed_to: '' } };
  }
  const v = T.cert.v, adm = walk ? '' : s_(r.admit_date), dis = walk ? '' : s_(r.discharge_date);
  const birth = walk ? s_(v.birth_date) : /deliver|caesarean|birth/i.test(s_(r.final_diagnoses) + ' ' + s_(r.course)) ? s_(r.op_date) : '';
  const again = () => { const yy = window.scrollY; render(); window.scrollTo(0, yy); };
  const preview = el('div', { class: 'certprev', id: 'cert-prev' }), msg = el('div', { class: 'msg', id: 'cert-msg' });
  const draft = () => Object.assign(walk ? { cert_no: 'MC-new', ds_uid: '', issued_on: today } : { cert_no: 'MC-new', ds_uid: r.uid, patient: r.name, title: code_(r.marital) === 'S' ? 'Ms' : 'Mrs', guardian: r.father_husband, age: r.age, admit_date: adm, discharge_date: dis, birth_date: birth, issued_on: today, doctor: r.consultant }, v,
    v.ctype === 'F' ? { to_date: v.from_date } : {}, v.ctype === 'A' ? { show_dx: 'N', advice: '' } : {}, walk && v.ctype !== 'M' ? { birth_date: '' } : {});
  function paintCert() { const c = draft(), bad = certProblems_(c); preview.replaceChildren(...certText_(c).map((t) => el('p', null, t))); msg.textContent = bad ? 'To issue: ' + bad : ''; }
  const set = (k, x, redraw) => { v[k] = x; if (redraw) again(); else paintCert(); };
  paintCert();
  const date = (k, label, chips) => {
    const i = el('input', { type: 'date', id: 'c-' + k, value: v[k] || '' });
    i.addEventListener('input', () => set(k, i.value));
    return el('div', { class: 'field' }, el('label', { class: 'lab', for: 'c-' + k }, label), i, el('div', { class: 'chips' }, chips.filter((c) => c[1]).map((c) => el('button', { class: 'chip', type: 'button', onclick: () => { i.value = c[1]; set(k, c[1]); } }, c[0]))));
  };
  const span = (days) => el('div', { class: 'chips', id: 'c-span' }, days.map((n) => el('button', { class: 'chip', type: 'button', onclick: () => { if (dayNo_(v.from_date) === null) { toast('Choose the first day'); return; } set('to_date', addDays_(v.from_date, n - 1), true); } }, n + (n === 1 ? ' day' : ' days'))));
  const input = (k, id, o) => { const i = el(o.area ? 'textarea' : 'input', Object.assign({ id, value: v[k] || '' }, o.area ? { rows: '2' } : { type: 'text', maxlength: o.max || '120' }, o.ph ? { placeholder: o.ph } : {}, o.cap ? { autocapitalize: o.cap } : {}, o.mode ? { inputmode: o.mode } : {})); i.addEventListener('input', () => set(k, i.value)); return i; };
  const t = v.ctype, male = /^(Mr|Master)$/.test(v.title || ''), she = male ? 'he' : 'she';
  const kinds = walk ? CTYPES.filter((x) => x[0] !== 'A' && !(male && x[0] === 'M')) : CTYPES;
  const exam = s_(v.exam_date) || today;
  const starts = walk ? [['Day of examination', exam], ['Day before', addDays_(exam, -1)], ['2 days before', addDays_(exam, -2)]] : [['Date of admission', adm], ['Date of operation', s_(r.op_date)], ['Date of discharge', dis], ['Today', today]];
  const para = walk ? 0 : +s_(r.para) || 0;
  const consultants = ((S.server && S.server.staff) || []).filter((x) => x.role === 'consultant');
  return el('div', { class: 'page form' }, topBar(walk ? 'Walk-in certificate' : 'Issue a certificate', { back: true }), el('main', null,
    walk ? el('div', { class: 'card', id: 'c-patient' }, el('h2', null, 'Patient'),
      el('div', { class: 'lab' }, 'Title'), chipRow('title', TITLES.map((x) => [x, x]), v.title, (x) => { v.title = x || 'Mrs'; if (/^(Mr|Master)$/.test(v.title) && v.ctype === 'M') v.ctype = 'R'; again(); }),
      el('label', { class: 'lab', for: 'c-name' }, 'Name'), input('patient', 'c-name', { max: '60', cap: 'words', ph: 'as on her or his ID card or school record' }),
      el('label', { class: 'lab', for: 'c-guard' }, male || /^(Ms|Miss)$/.test(v.title) ? 'Father’s name' : 'Husband’s name'), input('guardian', 'c-guard', { max: '60', cap: 'words' }),
      el('label', { class: 'lab', for: 'c-age' }, 'Age'), input('age', 'c-age', { max: '12', mode: 'numeric', ph: 'years' }),
      el('div', { class: 'lab' }, 'Consultant'), chipRow('doctor', consultants.map((x) => [x.name, x.name]), v.doctor, (x) => set('doctor', x || v.doctor, true)),
      date('exam_date', 'Date of examination', [['Today', today], ['Yesterday', addDays_(today, -1)]]))
      : null,
    el('div', { class: 'card' }, walk ? null : el('div', { class: 'small muted' }, r.ds_no + ' | ' + r.name + ' | admitted ' + dmy(adm) + ', discharged ' + dmy(dis)),
      el('div', { class: 'lab' }, 'Kind of certificate'), chipRow('ctype', kinds, t, (x) => set('ctype', x || 'R', true)),
      el('div', { class: 'lab' }, 'For'), chipRow('purpose', PURPOSES, v.purpose, (x) => set('purpose', x || 'W')),
      el('label', { class: 'lab', for: 'c-to' }, 'Addressed to (optional)'), input('addressed_to', 'c-to', { ph: 'e.g. The Principal, ABC School. Blank: To whom it may concern' })),
    t === 'A' ? el('div', { class: 'card' }, el('label', { class: 'lab', for: 'c-att' }, 'Attendant’s name'), input('attendant', 'c-att', { max: '60', cap: 'words' }),
      el('div', { class: 'lab' }, 'Relation to the patient'), chipRow('rel', RELATIONS.map((x) => [x, x]), v.relation, (x) => set('relation', x))) : null,
    el('div', { class: 'card' },
      t === 'F' ? date('from_date', 'Fit to resume from', walk ? [['Today', today], ['Tomorrow', addDays_(today, 1)], ['In 1 week', addDays_(today, 7)]] : [['Day after discharge', addDays_(dis, 1)], ['Today', today], ['In 2 weeks', addDays_(today, 14)], ['6 weeks after the birth', birth ? addDays_(birth, 42) : '']])
        : [date('from_date', 'First day', t === 'A' ? starts.slice(0, 1) : starts), date('to_date', 'Last day', t === 'A' ? [['Date of discharge', dis]] : []),
          t === 'R' ? span([1, 2, 3, 5, 7, 10, 14, 21]) : t === 'M' ? el('div', null, span([84, 90, 120, 180]), el('div', { class: 'hint' }, 'The federal Maternity and Paternity Leave Act 2023 gives 180, 120 or 90 days for a first, second or third birth' + (para ? ' (here Para ' + para + ')' : '') + '; most provincial employers give 12 weeks (84 days). Check what her employer follows.')) : null,
          walk ? el('div', { class: 'hint' }, 'A walk-in certificate may start at most ' + WALKIN_BEFORE + ' days before the examination, from the history ' + she + ' gives.') : null],
      walk && t === 'M' ? date('birth_date', 'Date she gave birth (blank if not yet)', [['Today', today], ['Yesterday', addDays_(today, -1)]]) : null,
      t !== 'A' && !walk ? date('exam_date', 'Date she was examined', [['Date of discharge', dis], ['Today', today]]) : null),
    t !== 'A' ? el('div', { class: 'card' }, el('div', { class: 'lab' }, 'Diagnosis'),
      el('button', { class: 'chip box' + (v.show_dx === 'Y' ? ' on' : ''), type: 'button', id: 'c-dx-ok', role: 'checkbox', 'aria-checked': v.show_dx === 'Y' ? 'true' : 'false', onclick: () => set('show_dx', v.show_dx === 'Y' ? 'N' : 'Y', true) }, (v.show_dx === 'Y' ? '☑' : '☐') + ' The patient agrees to show the diagnosis'),
      el('div', { class: 'hint' }, 'Without agreement the certificate says "a medical condition". Employers and schools do not need the diagnosis.'),
      v.show_dx === 'Y' ? input('dx', 'c-dx', { max: '200' }) : null) : null,
    t !== 'A' ? el('div', { class: 'card' }, el('label', { class: 'lab', for: 'c-adv' }, 'Advice for the employer or school (optional)'), input('advice', 'c-adv', { area: true }),
      el('div', { class: 'chips' }, CERT_ADVICE.filter((x) => !(male && /Breastfeeding/.test(x))).map((x) => el('button', { class: 'chip q', type: 'button', onclick: () => set('advice', (s_(v.advice) ? s_(v.advice) + '\n' : '') + x, true) }, x)))) : null,
    el('section', { class: 'card' }, el('h2', null, 'It will read'), preview, msg)),
    el('div', { class: 'actbar' }, el('button', { class: 'btn primary', type: 'button', id: 'cert-issue', onclick: () => {
      const c = draft(), bad = certProblems_(c);
      if (bad) { toast(bad); return; }
      if (!navigator.onLine) { toast('Issuing a certificate needs a signal: the workbook numbers it.'); return; }
      modal('Issue this certificate?', el('p', null, 'It is numbered and signed in the consultant’s name, and cannot be edited afterwards. A mistake is withdrawn and a new certificate issued.'), [['Cancel', null], ['Issue', () => {
        const btn = $('#cert-issue'); if (btn) { btn.disabled = true; btn.textContent = 'Issuing…'; }
        const vals = Object.assign({ ds_uid: walk ? '' : r.uid }, v, walk && t !== 'M' ? { birth_date: '' } : {});
        api({ op: 'cert_issue', token: S.cfg.token, cuid: T.cert.cuid, values: vals, by: S.cfg.name }).then(async (x) => {
          if (!x.ok) { toast(x.error); render(); return; }
          S.server.certs = (S.server.certs || []).filter((y) => y.cert_no !== x.cert.cert_no).concat([x.cert]);
          await saveState(); T.cert = null; T.nav.pop(); render(); toast(x.cert.cert_no + ' issued');
          shareCert(x.cert);
        }).catch((e) => { toast('Not issued: ' + e.message); render(); });
      }, 'primary']]);
    } }, icon('certplus'), ' Issue certificate')));
}
// The Certificates tab: every certificate on this phone, newest first, and the walk-in button.
function certsScreen() {
  const all = ((S.server && S.server.certs) || []).slice().sort((a, b) => (b.cert_no || '').localeCompare(a.cert_no || ''));
  const box = el('input', { type: 'search', id: 'cert-search', placeholder: 'Search name, MC number or code', value: T.cq || '', autocomplete: 'off' });
  box.addEventListener('input', () => { T.cq = box.value; const list = $('#cert-list'); if (list) list.replaceWith(certList()); });
  function certList() {
    const qq = s_(T.cq).toLowerCase(), code = qq.length >= 9 && /^[0-9a-f-]+$/.test(qq) ? qq.replace(/-/g, '') : '';
    const h = qq.length < 2 ? all : all.filter((c) => (c.patient + ' ' + c.guardian + ' ' + c.cert_no + ' ' + c.ds_no).toLowerCase().indexOf(qq) >= 0 || (code && s_(c.vcode).indexOf(code) === 0));
    return el('section', { class: 'card', id: 'cert-list' }, el('h2', null, (qq.length < 2 ? 'Issued (' : 'Found (') + h.length + ')'),
      h.length ? h.map((c) => certLine(c, true)) : el('p', { class: 'muted small' }, all.length ? 'None match.' : 'No certificates yet.'));
  }
  return el('div', { class: 'page' }, topBar('Certificates'), el('main', null,
    el('p', { class: 'small muted' }, can('certify') ? 'Walk-in, at the bottom, is for a patient seen in the OPD. For an admitted patient, open her final summary and use its Certificate button: the dates come from her admission.' : 'Only a consultant can issue certificates. You can print and send any of these.'),
    box, certList()), bottomNav('certs'));
}

// ------------------------------------------------------------------ settings and the PI's buttons screen
function settingsScreen() {
  const tile = (id, t, sub, fn, ic) => el('button', { class: 'tile', type: 'button', id, onclick: fn }, el('b', { class: 'tt' }, ic ? icon(ic) : null, t), el('span', null, sub));
  const bioTile = () => {
    if (T.hasBio) return tile('bio-off', 'Biometric', 'On: tap to turn off', () => modal('Turn off Face ID and fingerprint?', el('p', null, 'The app will open with the PIN only.'), [['Cancel', null], ['Turn off', async () => { await bioOff(); toast('Face ID and fingerprint unlock is off'); render(); }, 'primary']]), 'face');
    if (T.bioOk === null) return tile('bio-wait', 'Biometric', 'Checking\u2026', null, 'face');
    if (!T.bioOk) return tile('bio-na', 'Biometric', 'Not available', () => modal('Face ID / fingerprint', el('p', { id: 'bio-none' }, 'This phone does not report a built-in biometric for this app (' + (T.bioWhy || '') + '). The PIN works as normal.'),
      window.PublicKeyCredential ? [['Close', null], ['Try to set it up anyway', () => { T.bioOk = true; bioTurnOn(); }, 'primary']] : [['Close', null]]), 'face');
    return tile('bio-on', 'Biometric', 'Off: tap to turn on', bioTurnOn, 'face');
  };
  return el('div', { class: 'page' }, topBar('Settings'), el('main', null,
    el('div', { class: 'card' }, el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Name'), el('span', { class: 'v' }, S.cfg.name)),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Role'), el('span', { class: 'v' }, ROLE_NAMES[role()] || role())),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Account'), el('span', { class: 'v' }, S.cfg.email)),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Last sync'), el('span', { class: 'v' }, S.lastSync ? ago(S.lastSync) : 'never')),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'App build'), el('span', { class: 'v' }, BUILD_ID))),
    (() => {
      const nested = navNested(), all = navAll().filter((t) => NAV_FIXED.indexOf(t[0]) < 0);
      return el('section', { class: 'card', id: 'set-bar' }, el('h2', null, 'Bottom bar'),
        nested.length ? el('div', { class: 'tiles nested' }, nested.map((id) => { const t = navAll().filter((x) => x[0] === id)[0], b = navBadge(id);
          return el('button', { class: 'tile', type: 'button', id: 'set-' + id, onclick: () => go(id) }, el('b', { class: 'tt' }, icon(t[2]), t[1], b ? el('i', { class: 'badge inline' + (b[1] ? ' ' + b[1] : '') }, String(b[0])) : null), el('span', null, 'moved here from the bar')); })) : null,
        el('div', { class: 'kv barrow' }, el('span', { class: 'k' }, 'Main button'), el('span', { class: 'v' }, chipRow('fab-side', [['R', 'Right hand'], ['L', 'Left hand']], S.cfg.fabLeft ? 'L' : 'R', (x) => { if (!x) { render(); return; } S.cfg.fabLeft = x === 'L'; saveState(); render(); }))),
        el('p', { class: 'small muted' }, 'Press and hold a button in the bar, then drag it onto Settings to keep it here instead. Home and Settings always stay in the bar.'),
        all.map((t) => el('div', { class: 'kv barrow' }, el('span', { class: 'k' }, t[1]), el('span', { class: 'v' }, chipRow('bar-' + t[0], [['bar', 'In the bar'], ['set', 'In Settings']], nested.indexOf(t[0]) >= 0 ? 'set' : 'bar',
          (x) => { if (!x) { render(); return; } const now = navNested().filter((y) => y !== t[0]); if (x === 'set') now.push(t[0]); setNested(now, x === 'set' ? t[1] + ' moved to Settings' : t[1] + ' is back in the bar'); })))));
    })(),
    el('div', { class: 'tiles' },
      role() === 'pi' ? tile('t-invite', 'Invite', 'a consultant or medical officer', inviteDialog, 'invite') : null,
      bioTile(),
      tile('t-update', 'Update app', 'check for a newer version', updateApp, 'update'),
      tile('t-name', 'My name', 'as printed on summaries', () => {
        const i = el('input', { type: 'text', id: 'my-name', value: S.cfg.name, maxlength: '60' });
        modal('Your name', i, [['Cancel', null], ['Save', () => { if (s_(i.value).length < 3) return false; S.cfg.name = s_(i.value); saveState(); render(); }, 'primary']]);
      }, 'name')),
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
  return el('div', { class: 'page' }, topBar('Buttons and templates'), el('main', null,
    el('div', { class: 'card' }, el('p', null, qs.length + ' buttons, ' + drafts.length + ' draft. Drafts show with a dashed border, and only on your phone, until approved. Edit their wording in the QUICK tab of the workbook.'),
      drafts.length ? el('button', { class: 'btn primary block', type: 'button', id: 'approve-all', onclick: () => modal('Approve ' + drafts.length + ' draft buttons?', el('p', null, 'They appear on every phone after the next sync.'), [['Cancel', null], ['Approve all', async () => {
        const r = await api({ op: 'quick_approve', token: S.cfg.token }).catch((e) => ({ ok: false, error: e.message }));
        toast(r.ok ? r.n + ' approved' : r.error); if (r.ok) sync();
      }, 'primary']]) }, 'Approve all ' + drafts.length + ' drafts') : null),
    el('section', { class: 'card', id: 'tpl-list' }, el('h2', null, 'Templates (' + ((S.server && S.server.templates) || []).length + ')'),
      el('p', { class: 'small muted' }, 'Default fills every new summary. Tap another to delete it. Edit wording in the TEMPLATES tab; consultants add new ones from any summary or when finalising.'),
      el('div', { class: 'chips' }, ((S.server && S.server.templates) || []).map((t) => el('button', { class: 'chip tpl', type: 'button', onclick: () => {
        if (s_(t.name).toLowerCase() === 'default') { toast('Edit the Default in the TEMPLATES tab of the workbook'); return; }
        modal('Delete the template "' + t.name + '"?', el('p', null, 'Summaries already written are not changed.'), [['Cancel', null], ['Delete', async () => {
          const r = await api({ op: 'template_delete', token: S.cfg.token, tid: t.tid }).catch((e) => ({ ok: false, error: e.message }));
          if (r.ok) { S.server.templates = S.server.templates.filter((x) => x.tid !== t.tid); await saveState(); render(); } else toast(r.error);
        }, 'danger']]);
      } }, t.name)))),
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
async function pdfImages(r) { return { logo: await asset('logo.jpg'), qr: await asset('qr.jpg'), urdu: r ? await urduImages(r) : [], fp: r ? await fingerprint(r) : '' }; }
// The fingerprint of what is printed, the same one the workbook works out when the QR is scanned
async function fingerprint(r) { const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(r._cert ? certPrinted_(r._cert) : printedText_(r)))); return Array.from(h.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(); }
// QR as vector squares (crisp at any print size). Runs of dark modules on a row are drawn as one rectangle.
function qrOps(text, x, yTop, size) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), c = size / n, out = ['0 0 0 rg'];
  for (let r0 = 0; r0 < n; r0++) {
    for (let c0 = 0; c0 < n; c0++) {
      if (!q.isDark(r0, c0)) continue;
      let e = c0; while (e + 1 < n && q.isDark(r0, e + 1)) e++;
      out.push((x + c0 * c).toFixed(3) + ' ' + (yTop - (r0 + 1) * c).toFixed(3) + ' ' + ((e - c0 + 1) * c).toFixed(3) + ' ' + c.toFixed(3) + ' re');
      c0 = e;
    }
  }
  out.push('f'); return { ops: out.join('\n'), n };
}
// Each medicine's Urdu wording is drawn by the phone with the bundled Noto Nastaliq Urdu font and placed in the PDF as a small picture
// (the PDF's own fonts have no Urdu letters, and the phone shapes Nastaliq correctly).
async function urduImages(r) {
  const lines = s_(r.discharge_meds).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.some((l) => urduFor_(l))) return [];
  try { await document.fonts.load('48px BariUrdu', '\u0627\u0628'); } catch (e) { /* the fallback font still draws Urdu */ }
  return lines.map((l) => {
    const t = urduFor_(l);
    if (!t) return null;
    const px = 52, font = px + 'px BariUrdu, "Noto Nastaliq Urdu", serif', pad = 6;
    const big = document.createElement('canvas'), bx = big.getContext('2d');
    bx.font = font; bx.direction = 'rtl';
    const W = Math.ceil(bx.measureText(t).width) + px, H = px * 4, B = Math.round(px * 2.2);       // roomy: Nastaliq reaches far above and below the line
    big.width = W; big.height = H;
    const q = big.getContext('2d', { willReadFrequently: true });
    q.fillStyle = '#fff'; q.fillRect(0, 0, W, H); q.fillStyle = '#000';
    q.font = font; q.direction = 'rtl'; q.textAlign = 'right'; q.textBaseline = 'alphabetic';
    q.fillText(t, W - px / 2, B);
    const d = q.getImageData(0, 0, W, H).data;                                          // crop to the ink, measured from the pixels
    let top = H, bot = 0, left = W, right = 0;
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) { if (d[(yy * W + xx) * 4] < 200) { if (yy < top) top = yy; if (yy > bot) bot = yy; if (xx < left) left = xx; if (xx > right) right = xx; } }
    if (bot < top) return null;
    const cw = right - left + 1 + 2 * pad, ch = bot - top + 1 + 2 * pad, c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
    g.drawImage(big, left - pad, top - pad, cw, ch, 0, 0, cw, ch);
    const b64 = c.toDataURL('image/jpeg', 0.92).split(',')[1], bytes = Uint8Array.from(atob(b64), (ch2) => ch2.charCodeAt(0));
    return { bytes, g: jpegSize(bytes), text: t, px, base: ch - (B - top + pad) };     // base: distance from the image bottom up to the baseline
  });
}
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
  // Design: one identity band (logo, name, contact, QR), a single brand-green rule with a short yellow accent from the logo, then the title band.
  // Colour is used sparingly: green for the name, title and headings; grey for labels; black for the clinical text.
  const GREEN = '0.184 0.435 0.282', YELLOW = '0.984 0.914 0.349', GREY = '0.38 0.4 0.39', TINT = '0.925 0.953 0.937';
  const Tk = (x, yy, s, size, bold, rgb) => { ops.push(rgb + ' rg'); T_(x, yy, s, size, bold); ops.push('0 0 0 rg'); };
  const fill = (x, yy, w, h, rgb) => ops.push(rgb + ' rg ' + x.toFixed(2) + ' ' + yy.toFixed(2) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re f 0 0 0 rg');
  const bar = (x1, x2, yy, wd, rgb) => ops.push('q ' + rgb + ' RG ' + wd + ' w ' + x1.toFixed(2) + ' ' + yy.toFixed(2) + ' m ' + x2.toFixed(2) + ' ' + yy.toFixed(2) + ' l S Q');
  const newPage = (first) => {
    ops = ['0.6 w 0 0 0 RG 0 0 0 rg']; pages.push(ops);
    if (!final) ops.push('q 0.88 g BT /F2 64 Tf 0.819 0.574 -0.574 0.819 ' + (r.status === 'W' ? 110 : 150) + ' 300 Tm (' + (r.status === 'W' ? 'WITHDRAWN' : 'DRAFT') + ') Tj ET Q');
    if (first) {
      const top = PH - 34;
      let tx = M;
      if (lg) { const h = 64, w = h * lg.w / lg.h; ops.push('q ' + w.toFixed(2) + ' 0 0 ' + h + ' ' + M + ' ' + (top - h).toFixed(2) + ' cm /Im1 Do Q'); tx = M + w + 14; }
      Tk(tx, top - 22, H.name, 22, true, GREEN);
      Tk(tx, top - 39, H.address, 9.5, false, GREY);
      T_(tx, top - 53, H.phone, 9.5, true);
      if (qg) { const q = 66; ops.push('q ' + q + ' 0 0 ' + q + ' ' + (PW - M - q).toFixed(2) + ' ' + (top - q).toFixed(2) + ' cm /Im2 Do Q'); Tk(PW - M - q / 2 - tw('Scan for directions', 6.5, false) / 2, top - q - 7, 'Scan for directions', 6.5, false, GREY); }
      const ry = top - 80;
      bar(M, PW - M, ry, 1.4, GREEN); bar(M, M + 64, ry, 3.2, YELLOW);
      fill(M, ry - 30, CW, 24, TINT);
      Tk(M + 10, ry - 22.5, r._cert ? CTITLE[r._cert.ctype] : 'DISCHARGE SUMMARY', 13, true, GREEN);
      if (r.ds_no) T_(PW - M - 10 - tw('No. ' + r.ds_no, 10.5, true), ry - 22, 'No. ' + r.ds_no, 10.5, true);
      y = ry - 40;
    } else {
      Tk(M, PH - M - 4, H.name + '  |  Discharge summary: ' + (r.name || '') + (r.ds_no ? ' (' + r.ds_no + ')' : ''), 9, true, GREEN);
      bar(M, PW - M, PH - M - 10, 1, GREEN);
      y = PH - M - 28;
    }
  };
  const need = (h) => { if (y - h < M) newPage(false); };
  newPage(true);
  const urNames = [];
  const SIG = 78;
  if (r._cert) {                                         // a medical certificate: the patient line, the certificate's paragraphs, then the signature
    const c = r._cert, n = certDays_(c);
    const cell = (x, yy, w, label, val) => { ops.push('q 0.72 G 0.7 w'); rect(x, yy - 32, w, 32); ops.push('Q'); Tk(x + 6, yy - 11, label, 7, true, GREY); T_(x + 6, yy - 24.5, wrap(val, 10.5, w - 12)[0] || '', 10.5, false); };
    const boxes = c.ctype === 'A' ? [[0.4, 'ATTENDANT', c.attendant + (c.relation ? ' (' + c.relation + ')' : '')], [0.38, 'PATIENT', (c.title ? c.title + ' ' : '') + c.patient], [0.22, 'DATE OF ISSUE', dmy_(c.issued_on)]]
      : [[0.4, 'PATIENT', (c.title ? c.title + ' ' : '') + c.patient + (c.age ? ', ' + c.age + (/\d$/.test(c.age) ? ' y' : '') : '')], [0.38, /^(Mr|Master|Ms|Miss)$/.test(c.title) ? 'FATHER’S NAME' : 'HUSBAND’S / FATHER’S NAME', c.guardian], [0.22, 'DATE OF ISSUE', dmy_(c.issued_on)]];
    let x = M; boxes.forEach((b) => { cell(x, y, b[0] * CW, b[1], b[2] || ''); x += b[0] * CW; }); y -= 32;
    const per = c.ctype === 'F' ? [[0.4, 'FIT TO RESUME FROM', dmy_(c.from_date)], [0.38, 'FOR', codeLabel2_(PURPOSES, c.purpose)], [0.22, c.ds_no ? 'SUMMARY NO.' : 'SEEN IN OPD ON', c.ds_no || dmy_(c.exam_date)]]
      : [[0.2, 'FROM', dmy_(c.from_date)], [0.2, 'TO', dmy_(c.to_date)], [0.18, 'DAYS', String(n)], [0.2, c.ctype === 'A' ? 'FOR' : 'MAY RESUME ON', c.ctype === 'A' ? codeLabel2_(PURPOSES, c.purpose) : dmy_(isoFromDay_(dayNo_(c.to_date) + 1))], [0.22, c.ds_no ? 'SUMMARY NO.' : 'SEEN IN OPD ON', c.ds_no || dmy_(c.exam_date)]];
    x = M; per.forEach((b) => { cell(x, y, b[0] * CW, b[1], b[2] || ''); x += b[0] * CW; }); y -= 32;
    y -= 30;
    if (s_(c.addressed_to)) { T_(M, y, 'To: ' + c.addressed_to, 11, true); y -= 24; }
    else { T_(M, y, 'To whom it may concern', 11, true); y -= 24; }
    certText_(c).forEach((para) => { wrap(para, 11.5, CW).forEach((l) => { T_(M, y, l, 11.5, false); y -= 17; }); y -= 9; });
    y -= 6;                                              // the purpose limit, boxed, so it cannot be missed or cut off a photocopy
    const cut = CERT_LEGAL.indexOf('. ') + 1, lw = wrap(CERT_LEGAL.slice(cut).trim(), 8.5, CW - 20), lh = (lw.length + 1) * 11 + 14;
    ops.push('q 0.99 0.96 0.86 rg ' + M + ' ' + (y - lh).toFixed(2) + ' ' + CW + ' ' + lh + ' re f 0.6 0.45 0 RG 0.8 w ' + M + ' ' + (y - lh).toFixed(2) + ' ' + CW + ' ' + lh + ' re S Q');
    T_(M + 10, y - 13, CERT_LEGAL.slice(0, cut), 8.5, true);
    lw.forEach((l, k) => T_(M + 10, y - 24 - k * 11, l, 8.5, false));
    y -= lh;
    y = Math.min(y - 30, M + SIG + 140);
  } else {
    // the patient box, as on the pad
    const cell = (x, yy, w, h, label, val) => { ops.push('q 0.72 G 0.7 w'); rect(x, yy - h, w, h); ops.push('Q'); Tk(x + 6, yy - 11, label, 7, true, GREY); wrap(val, 10.5, w - 12).slice(0, 2).forEach((l, i) => T_(x + 6, yy - 24.5 - i * 12, l, 10.5, false)); };
    const code = (k) => (s_(r[k]) ? codeLabel_(k, r[k]) : '');
    const gp = (s_(r.gravida) || s_(r.para)) ? 'G' + (s_(r.gravida) || '?') + ' P' + (s_(r.para) || '?') : '';
    const rows = [
      [[0.58, 'NAME', r.name], [0.42, 'HUSBAND\u2019S / FATHER\u2019S NAME', r.father_husband]],
      [[0.12, 'AGE', r.age], [0.14, 'GRAVIDA / PARA', gp], [0.16, 'GESTATION', s_(r.gest_weeks) ? r.gest_weeks + ' weeks' : ''], [0.18, 'MARITAL STATUS', code('marital')], [0.18, 'RELIGION', code('religion')], [0.22, 'DATE', dmy(r.date)]],
      [[0.2, 'DATE OF ADMISSION', dmy(r.admit_date)], [0.2, 'DATE OF OPERATION', dmy(r.op_date)], [0.2, 'DATE OF DISCHARGE', dmy(r.discharge_date)], [0.4, 'CONSULTANT', r.consultant]]
    ];
    rows.forEach((row) => { let x = M; const h = row.some((c) => wrap(c[2] || '', 10.5, c[0] * CW - 12).length > 1) ? 42 : 32; row.forEach((c) => { cell(x, y, c[0] * CW, h, c[1], c[2] || ''); x += c[0] * CW; }); y -= h; });
    y -= 14;
    // The details: two columns, medicines (with their Urdu wording) across the page, then the signature.
    // The text size steps down from 10 to 8 pt only as far as needed to keep the summary on one page; longer ones flow onto more pages.
    const text = (k) => (k === 'final_diagnoses' ? [gpLine_(r), s_(r[k])].filter(Boolean).join('\n')
      : k === 'physical_findings' ? s_(r[k]).split('\n').map((x) => x.trim().replace(/[.,;]+$/, '')).filter(Boolean).join(', ')
      : s_(r[k]));
    const LEFT = [[colDef('final_diagnoses').label, text('final_diagnoses')], [colDef('history').label, text('history')], [colDef('physical_findings').label, text('physical_findings')], ['Investigations', labsLine_(r)]];
    const RIGHT = [[colDef('course').label, text('course')], [colDef('follow_up').label, [fuLine_(r), text('follow_up')].filter(Boolean).join('\n')]];
    const urdu = (imgs && imgs.urdu) || [];
    const meds = s_(r.discharge_meds).split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => ({ en: medEnglish_(l), ur: urdu[i] && urdu[i].bytes && urdu[i].bytes.length ? urdu[i] : null }));
    const GAP = 18, C2 = (CW - GAP) / 2, ENW = CW * 0.56, URX = M + ENW + 10, URW = PW - M - URX, FOOT = M;                     // no footer: the page ends with the signature
    const lhOf = (fs) => fs * 1.32;
    const blockH = (bk, w, fs) => 15 + Math.max(1, wrap(bk[1] || '-', fs, w - 4).length) * lhOf(fs) + 8;
    const urSize = (u, fs) => { const k = fs * 0.95 / (u.px || 52), k2 = u.g.w * k > URW ? URW / u.g.w : k; return { w: u.g.w * k2, h: u.g.h * k2, base: (u.base === undefined ? u.g.h * 0.4 : u.base) * k2 }; };   // base: image bottom to baseline
    const medRowH = (m, fs) => { const z = m.ur ? urSize(m.ur, fs) : null; return Math.max(wrap(m.en, fs, ENW).length * lhOf(fs), z ? z.h + 2 : 0) + 3; };
    const medsH = (fs) => 15 + (meds.length ? meds.reduce((t, m) => t + medRowH(m, fs), 0) : lhOf(fs)) + 8;
    const fit = [10, 9.5, 9, 8.5, 8].filter((fs) => Math.max(LEFT.reduce((t, b) => t + blockH(b, C2, fs), 0), RIGHT.reduce((t, b) => t + blockH(b, C2, fs), 0)) + medsH(fs) + SIG <= y - FOOT)[0];
    let headW = C2;
    const head = (x, yy, t, fs) => { Tk(x, yy, t.toUpperCase(), fs + 0.3, true, GREEN); ops.push('q 0.78 0.86 0.81 RG 0.6 w ' + x.toFixed(2) + ' ' + (yy - 3.5).toFixed(2) + ' m ' + (x + headW).toFixed(2) + ' ' + (yy - 3.5).toFixed(2) + ' l S Q'); };
    const drawBlock = (x, w, bk, fs, flow) => {
      if (flow) need(34);
      headW = w;
      head(x, y, bk[0], fs); y -= 15;
      wrap(bk[1] || '-', fs, w - 4).forEach((l) => { if (flow) need(lhOf(fs) + 2); T_(x + 3, y, l, fs, /^Next visit:/.test(l)); y -= lhOf(fs); });
      y -= 8;
    };
    const drawMeds = (fs, flow) => {
      if (flow) need(40);
      headW = CW;
      head(M, y, colDef('discharge_meds').label, fs); y -= 15;
      if (!meds.length) { T_(M + 3, y, '-', fs, false); y -= lhOf(fs); }
      meds.forEach((m) => {
        const rh = medRowH(m, fs);
        if (flow) need(rh + 2);
        wrap(m.en, fs, ENW).forEach((l, i) => T_(M + 3, y - i * lhOf(fs), l, fs, false));
        if (m.ur) {
          const z = urSize(m.ur, fs), nm = 'U' + urNames.length; urNames.push({ nm, u: m.ur });
          ops.push('q ' + z.w.toFixed(2) + ' 0 0 ' + z.h.toFixed(2) + ' ' + (PW - M - z.w).toFixed(2) + ' ' + (y - z.base).toFixed(2) + ' cm /' + nm + ' Do Q');   // Urdu baseline on the English baseline
        }
        y -= rh;
      });
      y -= 8;
    };
    if (fit) {
      const top = y;
      LEFT.forEach((bk) => drawBlock(M, C2, bk, fit, false));
      const yl = y; y = top;
      ops.push('0.8 G ' + (M + C2 + GAP / 2).toFixed(2) + ' ' + (top + 6).toFixed(2) + ' m ' + (M + C2 + GAP / 2).toFixed(2) + ' ' + (Math.min(yl, top) + 4).toFixed(2) + ' l S 0 G');                                  // a faint rule between the columns
      RIGHT.forEach((bk) => drawBlock(M + C2 + GAP, C2, bk, fit, false));
      y = Math.min(yl, y);
      drawMeds(fit, false);
    } else {
      LEFT.concat(RIGHT.slice(0, 1)).forEach((bk) => drawBlock(M, CW, bk, 9.5, true));
      drawMeds(9.5, true);
      drawBlock(M, CW, RIGHT[1], 9.5, true);
    }
  }
  need(SIG); y -= 18;
  const sx = PW - M - 200, sig = [];                    // the consultant's details, printed once, under the signature line
  if (r.consultant) {
    const lines = [[doc ? doc.name : r.consultant, true]];
    if (doc && doc.specialty) lines.push([doc.specialty, false]);
    if (doc && doc.qualifications) lines.push([doc.qualifications, false]);
    if (doc && doc.phone) lines.push(['Ph: ' + doc.phone, false]);
    lines.forEach((l) => wrap(l[0], 9.5, 200, l[1]).forEach((t) => sig.push([t, l[1]])));
  }
  const lastBase = y - 24 - Math.max(0, sig.length - 1) * 12;      // baseline of the consultant's last line
  const vurl = final && imgs && imgs.fp ? verifyUrl_(S && S.cfg && S.cfg.api, r, imgs.fp) : '';
  if (vurl) {                                            // verification QR, bottom left: from the signature line down to the consultant's last line
    const qb = lastBase - 1.5, qs = Math.max(58, y - qb), qx = M, tx = M + qs + 10;
    ops.push(qrOps(vurl, qx, qb + qs, qs).ops);
    Tk(tx, qb + 47, 'SCAN TO VERIFY THIS ' + (r._cert ? 'CERTIFICATE' : 'SUMMARY'), 8, true, GREEN);
    Tk(tx, qb + 35, 'Verification code', 7, false, GREY);
    T_(tx, qb + 23, vcodeShow_(r.vcode), 10, true);
    Tk(tx, qb + 10.5, 'Check the page opens at ' + VERIFY_PAGE.replace(/^https:\/\//, '').replace(/\/v\.html$/, ''), 6.5, false, GREY);
    Tk(tx, qb + 1.5, 'or quote the code on ' + CFG.HOSPITAL.phone.replace(/^Ph: /, ''), 6.5, false, GREY);
  }
  lineH(sx, y, PW - M);
  Tk(sx, y - 12, 'Signature of Consultant', 8.5, true, GREY);
  sig.forEach((l, i) => T_(sx, y - 24 - i * 12, l[0], 9.5, l[1]));
  // assemble the file
  const enc = new TextEncoder(), parts = [], offs = [];
  let len = 0;
  const put = (x) => { const b = typeof x === 'string' ? Uint8Array.from(x, (c) => c.charCodeAt(0) & 255) : x; parts.push(b); len += b.length; };
  const objs = [];                                      // [body parts]
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null), pagesObj = add(null), f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'), f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const jpg = (g, b) => add(['<< /Type /XObject /Subtype /Image /Width ' + g.w + ' /Height ' + g.h + ' /ColorSpace /' + (g.n === 1 ? 'DeviceGray' : 'DeviceRGB') + ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + b.length + ' >>\nstream\n', b, '\nendstream']);
  const img = lg ? jpg(lg, logo) : 0, img2 = qg ? jpg(qg, qr) : 0;
  const urObjs = urNames.map((x) => ' /' + x.nm + ' ' + jpg(x.u.g, x.u.bytes) + ' 0 R').join('');
  const kids = pages.map((p) => {
    const s = p.join('\n');
    const c = add('<< /Length ' + s.length + ' >>\nstream\n' + s + '\nendstream');
    return add('<< /Type /Page /Parent ' + pagesObj + ' 0 R /MediaBox [0 0 ' + PW + ' ' + PH + '] /Resources << /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R >>' + (img || img2 || urObjs ? ' /XObject <<' + (img ? ' /Im1 ' + img + ' 0 R' : '') + (img2 ? ' /Im2 ' + img2 + ' 0 R' : '') + urObjs + ' >>' : '') + ' >> /Contents ' + c + ' 0 R >>');
  });
  objs[catalog - 1] = '<< /Type /Catalog /Pages ' + pagesObj + ' 0 R >>';
  objs[pagesObj - 1] = '<< /Type /Pages /Kids [' + kids.map((k) => k + ' 0 R').join(' ') + '] /Count ' + kids.length + ' >>';
  put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  objs.forEach((b, i) => { offs.push(len); put((i + 1) + ' 0 obj\n'); (Array.isArray(b) ? b : [b]).forEach(put); put('\nendobj\n'); });
  const xref = len;
  put('xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  put('trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R /Info << /Title (' + esc(pdfText((r._cert ? 'Medical certificate ' : 'Discharge summary ') + (r.ds_no || '') + ' ' + (r.name || ''))) + ') /Producer (Bari Discharge) >> >>\nstartxref\n' + xref + '\n%%EOF\n');
  void enc;
  const out = new Uint8Array(len); let p0 = 0; parts.forEach((b) => { out.set(b, p0); p0 += b.length; });
  return out;
}
async function sharePdf(r) {
  try {
    const bytes = buildPdf(r, await pdfImages(r));
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
function applyUpdateIfSafe() { if (!updateReady || KEY || T.pin || T.join || T.bioBusy) return; location.reload(); }   // never while Face ID is asking: a reload would make it ask twice
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
  try { T.hasVault = !!(await kvGet('vault')); T.hasBio = T.hasVault && !!(await kvGet('bio')); } catch (e) { T.hasVault = false; T.hasBio = false; }
  T.bioOk = null; bioAvailable().then((v) => { T.bioOk = v; if (!KEY && T.hasVault || cur().name === 'settings') render(); });
  if (T.hasVault) await sessRestore();
  if (S && !S.usage) S.usage = {};
  if ('serviceWorker' in navigator && location.protocol === 'https:') setupAutoUpdate();
  render();
})();
