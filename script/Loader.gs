/**
 * BARI DISCHARGE LOADER. Paste once into the sheet's Apps Script project (Code.gs); never needs changing.
 *
 * It runs the copy of BariDischarge.gs that the PI approved. The copy is kept inside this project (in its
 * settings, checked against its SHA-256), so normal use never contacts GitHub. The running code changes only when
 * the PI clicks
 *   Bari Discharge > PI: install update     (shows what is new; OK installs it and runs setup)
 *   Bari Discharge > PI: undo last update   (goes back to the copy before)
 * Phones and the web app address are untouched by updates: the web app runs this loader, and the loader reads
 * the approved copy at every request.
 */
const LOADER_VERSION = '2';
const CODE_URL = 'https://raw.githubusercontent.com/IR1S-VIR1S/bari-discharge/main/script/BariDischarge.gs';
const MENU_NAME_DEFAULT = 'Bari Discharge';
const SLOTS = 12;                                       // menu items the installed version may use (m1 to m12)
const CHUNK = 7000;                                     // characters per saved piece (a setting holds about 9 KB)

let IMPL_ = null;
function lp_() { return PropertiesService.getScriptProperties(); }
function lhex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }
function lsha_(text) { return lhex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)); }
function compile_(code) { return new Function(code + '\n;return exports_();'); }

// The approved copy is saved in pieces: <slot>_N (number of pieces), <slot>_0, <slot>_1 ... ; slot is CODE or PREV.
function saveCopy_(slot, code) {
  const P = lp_(), old = Number(P.getProperty(slot + '_N') || 0), n = Math.ceil(code.length / CHUNK), set = {};
  for (let i = 0; i < n; i++) set[slot + '_' + i] = code.slice(i * CHUNK, (i + 1) * CHUNK);
  set[slot + '_N'] = String(n); set[slot + '_SHA'] = lsha_(code);
  P.setProperties(set);
  for (let i = n; i < old; i++) P.deleteProperty(slot + '_' + i);
}
function readCopy_(slot) {
  const P = lp_(), n = Number(P.getProperty(slot + '_N') || 0);
  if (!n) return null;
  let code = '';
  for (let i = 0; i < n; i++) code += P.getProperty(slot + '_' + i) || '';
  return lsha_(code) === P.getProperty(slot + '_SHA') ? code : null;
}
function impl_() {
  if (IMPL_) return IMPL_;
  const sha = lp_().getProperty('CODE_SHA');
  if (!sha) throw new Error('No version installed yet. Use the menu: PI: install update.');
  const C = CacheService.getScriptCache(), key = 'code_' + sha.slice(0, 16);
  let code = null;
  try { code = C.get(key); } catch (e) { code = null; }
  if (!code || lsha_(code) !== sha) {
    code = readCopy_('CODE');
    if (!code) throw new Error('The installed copy is damaged. Use the menu: PI: install update.');
    try { C.put(key, code, 21600); } catch (e) { /* too large to cache: read from the settings each time */ }
  }
  IMPL_ = compile_(code)();
  return IMPL_;
}

// ---------------------------------------------------------------- entry points
function doGet(e) { return impl_().doGet(e); }
function doPost(e) {
  try { return impl_().doPost(e); }
  catch (err) { return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'server error: ' + (err && err.message ? err.message : err) })).setMimeType(ContentService.MimeType.JSON); }
}
function onOpen() {                                     // a simple trigger: reads only saved settings, never the network
  const P = lp_(), ui = SpreadsheetApp.getUi();
  let items = [];
  try { items = JSON.parse(P.getProperty('MENU_ITEMS') || '[]'); } catch (e) { items = []; }
  const m = ui.createMenu(P.getProperty('MENU_NAME') || MENU_NAME_DEFAULT);
  items.slice(0, SLOTS).forEach(function (it, i) { m.addItem(it[0], 'm' + (i + 1)); });
  if (items.length) m.addSeparator();
  m.addItem('PI: install update', 'menuInstallUpdate');
  if (P.getProperty('PREV_N')) m.addItem('PI: undo last update', 'menuUndoUpdate');
  m.addToUi();
}
function slot_(i) {
  const items = JSON.parse(lp_().getProperty('MENU_ITEMS') || '[]'), it = items[i - 1];
  if (!it) throw new Error('This menu item is no longer used. Reload the sheet.');
  const fn = impl_()[it[1]];
  if (typeof fn !== 'function') throw new Error('This menu item is not in the installed version. Reload the sheet.');
  return fn();
}
function m1() { return slot_(1); } function m2() { return slot_(2); } function m3() { return slot_(3); } function m4() { return slot_(4); }
function m5() { return slot_(5); } function m6() { return slot_(6); } function m7() { return slot_(7); } function m8() { return slot_(8); }
function m9() { return slot_(9); } function m10() { return slot_(10); } function m11() { return slot_(11); } function m12() { return slot_(12); }

// ---------------------------------------------------------------- updates (PI only)
function lme_() { return (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').toLowerCase(); }
function lpi_(ui) {
  const pi = (lp_().getProperty('PI_EMAIL') || '').toLowerCase();
  if (pi && lme_() !== pi) { ui.alert('Not allowed', 'Only the PI (' + pi + ') can install updates.', ui.ButtonSet.OK); return false; }
  return true;
}
function check_(code) {
  let ex;
  try { ex = compile_(code)(); } catch (e) { throw new Error('That version does not start: ' + (e.message || e)); }
  ['setup', 'doPost', 'doGet'].forEach(function (k) { if (typeof ex[k] !== 'function') throw new Error('That version lacks ' + k + '.'); });
  return ex;
}
function label_(ex) { return 'version ' + (ex.VERSION || '?') + (ex.RELEASE_NOTE ? ': ' + ex.RELEASE_NOTE : ''); }
// Makes a checked copy the running one, refreshes the menu, then runs setup (safe to repeat; adds new columns and buttons).
function activate_(code, ex) {
  const P = lp_(), cur = readCopy_('CODE');
  if (cur && lsha_(cur) !== lsha_(code)) saveCopy_('PREV', cur);
  saveCopy_('CODE', code);
  P.setProperties({ CODE_SHA: lsha_(code), MENU_ITEMS: JSON.stringify((ex.MENU_ITEMS || []).slice(0, SLOTS)), MENU_NAME: ex.MENU || MENU_NAME_DEFAULT,
    INSTALLED: label_(ex) + ' (' + Utilities.formatDate(new Date(), 'Asia/Karachi', 'yyyy-MM-dd HH:mm') + ')' });
  IMPL_ = ex;
  onOpen();
  ex.setup();                                           // shows "Set up complete", or says why it stopped
}
function menuInstallUpdate() {
  const ui = SpreadsheetApp.getUi();
  if (!lpi_(ui)) return;
  const P = lp_();
  let code, ex;
  try {
    const r = UrlFetchApp.fetch(CODE_URL + '?t=' + Date.now(), { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('GitHub answered ' + r.getResponseCode() + '.');
    code = r.getContentText();
    ex = check_(code);
  } catch (e) { ui.alert('Update not installed', String(e.message || e) + '\n\nThe version that was running is still running.', ui.ButtonSet.OK); return; }
  if (lsha_(code) === P.getProperty('CODE_SHA')) { ui.alert('Already up to date', 'Installed: ' + (P.getProperty('INSTALLED') || label_(ex)) + '.', ui.ButtonSet.OK); return; }
  const ok = ui.alert('Install update?', 'New: ' + label_(ex) + '\n\nInstalled now: ' + (P.getProperty('INSTALLED') || 'nothing yet') +
    '\n\nPhones keep working and need no new invitation. You can undo this from the same menu.', ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;
  try { activate_(code, ex); }
  catch (e) { ui.alert('Update not installed', String(e.message || e) + '\n\nThe version that was running is still running.', ui.ButtonSet.OK); }
}
function menuUndoUpdate() {
  const ui = SpreadsheetApp.getUi();
  if (!lpi_(ui)) return;
  const prev = readCopy_('PREV');
  if (!prev) { ui.alert('Nothing to undo', 'There is no earlier version kept.', ui.ButtonSet.OK); return; }
  let ex;
  try { ex = check_(prev); } catch (e) { ui.alert('Undo failed', String(e.message || e), ui.ButtonSet.OK); return; }
  if (ui.alert('Undo the last update?', 'Go back to ' + label_(ex) + '?', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  try { activate_(prev, ex); }
  catch (e) { ui.alert('Undo failed', String(e.message || e), ui.ButtonSet.OK); }
}
