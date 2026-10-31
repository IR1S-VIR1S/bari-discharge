/**
 * BARI DISCHARGE LOADER. Paste once into the sheet's Apps Script project (Code.gs); never needs changing.
 *
 * It runs the version of BariDischarge.gs that the PI approved, taken from GitHub at an exact commit and
 * checked against its SHA-256, so the running code can change only when the PI clicks
 *   Bari Discharge > PI: install update     (shows what changed; OK installs it and runs setup)
 *   Bari Discharge > PI: undo last update   (goes back to the version before)
 * Phones and the web app address are untouched by updates: the web app runs this loader, and the loader
 * reads which version to run from the project's settings at every request.
 */
const LOADER_VERSION = '1';
const REPO = 'IR1S-VIR1S/bari-discharge', CODE_PATH = 'script/BariDischarge.gs', BRANCH = 'main';
const MENU_NAME_DEFAULT = 'Bari Discharge';
const SLOTS = 12;                                       // menu items the loaded version may use (m1 to m12)

let IMPL_ = null;
function lp_() { return PropertiesService.getScriptProperties(); }
function lhex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }
function lsha_(text) { return lhex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)); }
function rawUrl_(commit) { return 'https://raw.githubusercontent.com/' + REPO + '/' + commit + '/' + CODE_PATH; }
function compile_(code) { return new Function(code + '\n;return exports_();'); }

// The approved code: from the cache (6 hours) or from GitHub at the approved commit, and only if its hash matches.
function loadCode_(commit, sha) {
  const C = CacheService.getScriptCache(), key = 'code_' + sha.slice(0, 16);
  let code = null;
  try { code = C.get(key); } catch (e) { code = null; }
  if (code && lsha_(code) === sha) return code;
  const r = UrlFetchApp.fetch(rawUrl_(commit), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Could not read the approved version from GitHub (' + r.getResponseCode() + ').');
  code = r.getContentText();
  if (lsha_(code) !== sha) throw new Error('The file on GitHub does not match the approved version. Nothing was run.');
  try { C.put(key, code, 21600); } catch (e) { /* too large to cache: read from GitHub each time */ }
  return code;
}
function impl_() {
  if (IMPL_) return IMPL_;
  const P = lp_(), commit = P.getProperty('CODE_COMMIT'), sha = P.getProperty('CODE_SHA256');
  if (!commit || !sha) throw new Error('No version installed yet. Use the menu: PI: install update.');
  IMPL_ = compile_(loadCode_(commit, sha))();
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
  if (P.getProperty('PREV_COMMIT')) m.addItem('PI: undo last update', 'menuUndoUpdate');
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
function latest_() {
  const r = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/commits/' + BRANCH, { muteHttpExceptions: true, headers: { Accept: 'application/vnd.github+json' } });
  if (r.getResponseCode() !== 200) throw new Error('GitHub answered ' + r.getResponseCode() + '.');
  const j = JSON.parse(r.getContentText());
  return { commit: j.sha, message: String((j.commit && j.commit.message) || '').split('\n')[0].slice(0, 200), date: String((j.commit && j.commit.committer && j.commit.committer.date) || '').slice(0, 10) };
}
// Installs a commit: reads and checks the file, records it, refreshes the menu, then runs setup (safe to repeat; adds new columns and buttons).
function install_(ui, commit, label) {
  const r = UrlFetchApp.fetch(rawUrl_(commit), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Could not read that version from GitHub (' + r.getResponseCode() + ').');
  const code = r.getContentText(), sha = lsha_(code);
  let ex;
  try { ex = compile_(code)(); } catch (e) { throw new Error('That version does not start: ' + (e.message || e)); }
  ['setup', 'doPost', 'doGet'].forEach(function (k) { if (typeof ex[k] !== 'function') throw new Error('That version lacks ' + k + '.'); });
  const P = lp_(), old = P.getProperty('CODE_COMMIT');
  if (old && old !== commit) { P.setProperty('PREV_COMMIT', old); P.setProperty('PREV_SHA256', P.getProperty('CODE_SHA256') || ''); }
  P.setProperty('CODE_COMMIT', commit); P.setProperty('CODE_SHA256', sha);
  P.setProperty('MENU_ITEMS', JSON.stringify((ex.MENU_ITEMS || []).slice(0, SLOTS)));
  P.setProperty('MENU_NAME', ex.MENU || MENU_NAME_DEFAULT);
  P.setProperty('INSTALLED_AT', Utilities.formatDate(new Date(), 'Asia/Karachi', 'yyyy-MM-dd HH:mm') + ' ' + label);
  IMPL_ = ex;
  onOpen();
  ex.setup();                                           // shows "Set up complete", or says why it stopped
  return ex;
}
function menuInstallUpdate() {
  const ui = SpreadsheetApp.getUi();
  if (!lpi_(ui)) return;
  const P = lp_();
  let L;
  try { L = latest_(); } catch (e) { ui.alert('Could not check for updates', String(e.message || e) + '\n\nNothing was changed.', ui.ButtonSet.OK); return; }
  if (L.commit === P.getProperty('CODE_COMMIT')) { ui.alert('Already up to date', 'The newest version is installed (' + L.date + ': ' + L.message + ').', ui.ButtonSet.OK); return; }
  const now = P.getProperty('INSTALLED_AT') || 'nothing yet';
  const ok = ui.alert('Install update?', 'New version ' + L.commit.slice(0, 7) + ' (' + L.date + '):\n' + L.message + '\n\nInstalled now: ' + now +
    '\n\nPhones keep working and need no new invitation. You can undo this from the same menu.', ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;
  try { install_(ui, L.commit, L.commit.slice(0, 7) + ' ' + L.message.slice(0, 60)); }
  catch (e) { ui.alert('Update not installed', String(e.message || e) + '\n\nThe version that was running is still running.', ui.ButtonSet.OK); }
}
function menuUndoUpdate() {
  const ui = SpreadsheetApp.getUi();
  if (!lpi_(ui)) return;
  const P = lp_(), prev = P.getProperty('PREV_COMMIT');
  if (!prev) { ui.alert('Nothing to undo', 'There is no earlier version recorded.', ui.ButtonSet.OK); return; }
  if (ui.alert('Undo the last update?', 'Go back to version ' + prev.slice(0, 7) + '?', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  const cur = P.getProperty('CODE_COMMIT');
  try { install_(ui, prev, prev.slice(0, 7) + ' (undo)'); P.setProperty('PREV_COMMIT', cur); }
  catch (e) { ui.alert('Undo failed', String(e.message || e), ui.ButtonSet.OK); }
}
