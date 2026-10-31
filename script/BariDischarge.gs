/**
 * ============================================================================
 *  BARI HOSPITAL: OBSTETRIC DISCHARGE SUMMARY SYSTEM v1.1
 *  31 October 2026. One file: paste into the spreadsheet's Apps Script editor.
 * ============================================================================
 *  Keeps one row per discharge in the tab DISCHARGES, with the same headings as the
 *  printed Discharge Summary pad (front and back). Consultants and medical officers
 *  fill it in on the Bari Discharge phone app, using quick buttons, and the phone
 *  makes the A4 summary as a PDF to print or send on WhatsApp.
 *
 *  Tabs it builds in this workbook:
 *    DISCHARGES   the records (one row per discharge)
 *    QUICK        the quick buttons: edit, add or delete rows here. status "draft" rows are
 *                 seen only on the PI phone until approved (menu: approve all draft buttons)
 *    TEMPLATES    whole-summary templates saved from the phone (clinical sections only)
 *    STAFF        consultant and medical officer names offered as buttons
 *    LOG          who changed what and when (field names only, not the text)
 *
 *  Install:
 *    1. Create a blank Google Sheet and name it Bari_Discharge.
 *    2. Extensions > Apps Script. Replace the sample code with this file. Save.
 *    3. Reload the spreadsheet. Menu: Bari Discharge > PI: set up or repair.
 *    4. Approve the permissions, then choose the same menu item again.
 *    5. Deploy > New deployment > Web app; Execute as: Me; Who has access: Anyone.
 *    6. Bari Discharge > PI: manage users, then PI: invite a phone.
 *  Running setup again is safe: it repairs missing parts and never deletes data.
 *  Normally this file is not pasted at all: the sheet holds Loader.gs, which runs the version of this
 *  file the PI approved with Bari Discharge > PI: install update (one click, no code to type).
 * ============================================================================
 */

const CFG = {
  VERSION: '1.1',
  SCHEMA_VER: 2,                      // 2: obstetric layout (G/P, weeks, co-morbid, operation date, Hb/TLC/PLT)
  TZ: 'Asia/Karachi',
  MENU: 'Bari Discharge',
  DS_PREFIX: 'BH-',
  PULL_DAYS: 120,                     // phones keep discharges from the last 120 days, and every draft
  TEXT_MAX: 6000,
  HOSPITAL: { name: 'BARI HOSPITAL', address: '73-G, Gulberg III, Near Firdous Market, Lahore', phone: 'Ph: 042 3583 4233', qr: 'https://goo.gl/maps/VroaxLdTjCajWF3f8' }
};

const SEX = [['M', 'Male'], ['F', 'Female']];
const MARITAL = [['S', 'Single'], ['M', 'Married'], ['W', 'Widowed'], ['D', 'Divorced']];
const RELIGION = [['I', 'Islam'], ['C', 'Christianity']];
const STATUS = [['D', 'Draft'], ['F', 'Final']];
function nums_(a, b, pre) { const o = []; for (let i = a; i <= b; i++) o.push([String(i), (pre || '') + i]); return o; }
const GRAVIDA = nums_(1, 10, 'G');
const PARA = nums_(0, 9, 'P');
const WEEKS = nums_(24, 42, '');
const COMORBID = [['D', 'Diabetes'], ['H', 'Hypertension']];   // ticking one shows its quick buttons

function col(key, label, type, o) { const c = { key: key, label: label, type: type }; if (o) Object.keys(o).forEach(function (k) { c[k] = o[k]; }); return c; }

// Front of the pad, then the back. "sec" columns are the long sections with quick buttons.
const SCHEMA = [{ tab: 'DISCHARGES', title: 'Obstetric discharge summaries', cols: [
  col('ds_no', 'Discharge number', 'sys'),
  col('uid', 'Record id (made by the phone)', 'sys'),
  col('status', 'Status', 'code', { codes: STATUS }),
  col('date', 'Date', 'date'),
  col('name', 'Name', 'text'),
  col('father_husband', 'Husband\u2019s / Father\u2019s name', 'text'),
  col('age', 'Age', 'age'),
  col('sex', 'Sex', 'code', { codes: SEX }),
  col('marital', 'Marital status', 'code', { codes: MARITAL }),
  col('religion', 'Religion', 'code', { codes: RELIGION }),
  col('gravida', 'Gravida', 'code', { codes: GRAVIDA }),
  col('para', 'Para', 'code', { codes: PARA }),
  col('gest_weeks', 'Weeks of gestation', 'code', { codes: WEEKS }),
  col('comorbid', 'Co-morbid', 'multi', { codes: COMORBID }),
  col('admit_date', 'Date of admission', 'date'),
  col('op_date', 'Date of operation', 'date'),
  col('discharge_date', 'Date of discharge', 'date'),
  col('consultant', 'Consultant', 'text'),
  col('final_diagnoses', 'Final diagnoses', 'sec'),
  col('history', 'History', 'sec'),
  col('physical_findings', 'Physical findings', 'sec'),
  col('hb', 'Hb', 'num', { min: 3, max: 20, unit: 'g/dL' }),
  col('tlc', 'TLC', 'num', { min: 1, max: 50, unit: 'x10^9/L' }),
  col('plt', 'Platelets', 'num', { min: 10, max: 1000, unit: 'x10^9/L' }),
  col('course', 'Course & treatment in the hospital', 'sec'),
  col('discharge_meds', 'Discharge medications', 'sec'),
  col('follow_up', 'Follow up instructions', 'sec'),
  col('mo_name', 'Medical officer', 'text'),
  col('created_by', 'Created by', 'sys'),
  col('created_at', 'Created at', 'sys'),
  col('updated_by', 'Last changed by', 'sys'),
  col('updated_at', 'Last changed at', 'sys'),
  col('finalised_by', 'Finalised by', 'sys'),
  col('finalised_at', 'Finalised at', 'sys')
] }];
const DCOLS = SCHEMA[0].cols;
const SECTIONS = DCOLS.filter(function (c) { return c.type === 'sec'; }).map(function (c) { return c.key; });
const EDITABLE = DCOLS.filter(function (c) { return c.type !== 'sys'; }).map(function (c) { return c.key; });
const FINAL_NEEDS = ['date', 'name', 'age', 'gravida', 'para', 'gest_weeks', 'admit_date', 'op_date', 'discharge_date', 'consultant', 'final_diagnoses', 'course', 'discharge_meds'];

const QUICK_COLS = ['qid', 'section', 'group', 'join', 'phrase', 'status', 'added_by', 'added_on', 'needs'];
const SEED_VER = '2';                // bump when the starter buttons change: setup swaps the old starter rows for the new ones
const JOINS = [['N', 'new line'], ['S', 'same line'], ['C', 'same line, after a comma']];
const TEMPLATE_COLS = ['tid', 'name'].concat(SECTIONS).concat(['saved_by', 'saved_on']);
const STAFF_COLS = ['name', 'role', 'specialty', 'qualifications', 'phone'];

// ---------------------------------------------------------------- helpers (shared with the phone)
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function code_(v) { return str_(v).toUpperCase(); }
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function dayNo_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str_(iso));
  if (!m) return null;
  const d = Date.UTC(+m[1], +m[2] - 1, +m[3]), t = new Date(d);
  if (t.getUTCFullYear() !== +m[1] || t.getUTCMonth() !== +m[2] - 1 || t.getUTCDate() !== +m[3]) return null;
  return Math.round(d / 864e5);
}
function colOf_(key) { return DCOLS.filter(function (c) { return c.key === key; })[0]; }
function codeLabel_(key, v) { const c = colOf_(key); const p = c && c.codes ? c.codes.filter(function (x) { return x[0] === code_(v); })[0] : null; return p ? p[1] : str_(v); }

// '' when acceptable; a blank is always acceptable here (completeness is checked by finalGaps_)
function validateValue_(c, v, row) {
  const s = str_(v);
  if (s === '') return '';
  if (s.length > (c.type === 'sec' ? CFG.TEXT_MAX : 200)) return c.label + ' is too long';
  if (c.type === 'code') {
    if (!c.codes.some(function (p) { return p[0] === code_(s); })) return c.label + ': choose one of the buttons';
    if (row && (c.key === 'gravida' || c.key === 'para') && str_(row.gravida) !== '' && str_(row.para) !== '' && +row.para > +row.gravida) return 'Para cannot be more than gravida';
    return '';
  }
  if (c.type === 'multi') return s.split(',').every(function (x) { return c.codes.some(function (p) { return p[0] === code_(x); }); }) ? '' : c.label + ': choose from the boxes';
  if (c.type === 'num') {
    const x = Number(s);
    if (!/^\d+(\.\d+)?$/.test(s) || !isFinite(x)) return c.label + ': a number';
    return x < c.min || x > c.max ? c.label + ': between ' + c.min + ' and ' + c.max + ' ' + c.unit : '';
  }
  if (c.type === 'date') {
    const d = dayNo_(s);
    if (d === null) return c.label + ': not a valid date';
    if (d < dayNo_('2000-01-01') || d > dayNo_('2100-12-31')) return c.label + ': year out of range';
    if (row) {
      const a = dayNo_(row.admit_date), b = dayNo_(row.discharge_date);
      const o = dayNo_(row.op_date);
      if ((c.key === 'admit_date' || c.key === 'discharge_date') && a !== null && b !== null && b < a) return 'Date of discharge is before the date of admission';
      if ((c.key === 'op_date' || c.key === 'admit_date') && o !== null && a !== null && o < a) return 'Date of operation is before the date of admission';
      if ((c.key === 'op_date' || c.key === 'discharge_date') && o !== null && b !== null && o > b) return 'Date of operation is after the date of discharge';
    }
    return '';
  }
  if (c.type === 'age') return /^\d{1,3}(\.\d)?( ?(y|yr|yrs|years?|m|mo|months?|d|days?|w|wk|weeks?))?$/i.test(s) && parseFloat(s) <= 120 ? '' : 'Age: a number, optionally followed by years, months, weeks or days';
  return '';
}
// what is still missing before a summary can be finalised, as labels
function comorbidOf_(row) { return str_(row.comorbid) ? code_(row.comorbid).split(',') : []; }
function quickShown_(q, row) { return !q.needs || comorbidOf_(row).indexOf(code_(q.needs)) >= 0; }
function gpLine_(row) {
  const g = str_(row.gravida), p = str_(row.para), w = str_(row.gest_weeks);
  return (g || p ? 'G' + (g || '?') + ' P' + (p || '?') : '') + (w ? (g || p ? ' at ' : '') + w + ' weeks of gestation' : '');
}
function labsLine_(row) {
  return ['hb', 'tlc', 'plt'].filter(function (k) { return str_(row[k]) !== ''; }).map(function (k) { const c = colOf_(k); return c.label + ' ' + str_(row[k]) + ' ' + c.unit; }).join('   |   ');
}
function finalGaps_(row) { return FINAL_NEEDS.filter(function (k) { return str_(row[k]) === ''; }).map(function (k) { return colOf_(k).label; }); }
function rowProblems_(row) {
  const out = [];
  DCOLS.forEach(function (c) { if (c.type === 'sys') return; const e = validateValue_(c, row[c.key], row); if (e && out.indexOf(e) < 0) out.push(e); });
  return out;
}

// ---------------------------------------------------------------- roles (shared with the phone)
const ROLE_NAMES = { pi: 'PI', consultant: 'Consultant', mo: 'Medical officer' };
function roleCan_(role, what) {
  if (role === 'pi') return true;
  if (what === 'edit' || what === 'quickAdd') return role === 'consultant' || role === 'mo';
  if (what === 'finalise' || what === 'template') return role === 'consultant';
  return false;                        // quickLive, quickApprove, invite: PI only
}
const APP_JOIN_DAYS = 7;

// ============================================================================
//  GOOGLE SERVICES
// ============================================================================
function props_() { return PropertiesService.getScriptProperties(); }
function ss_() { const id = props_().getProperty('DATA_ID'); return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive(); }
function nowTxt_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm'); }
function todayIso_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'); }
function emails_(key) { return (props_().getProperty(key) || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s !== ''; }); }
function piEmail_() { return (props_().getProperty('PI_EMAIL') || '').toLowerCase(); }
function me_() { return (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').toLowerCase(); }
function requirePI_() { const pi = piEmail_(); if (!pi || me_() !== pi) throw new Error('Only the PI (' + (pi || 'not yet set up') + ') can do this.'); }
function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function randomHex_(n) { let s = ''; while (s.length < n) s += Utilities.getUuid().replace(/-/g, ''); return s.slice(0, n); }
function cellTxt_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}

// The sheet menu. The loader (Loader.gs) builds the same menu from this list, so a new item needs no change to the loader.
const MENU_ITEMS = [['PI: set up or repair', 'setup'], ['PI: manage users', 'menuUsers'], ['PI: invite a phone', 'menuInvite'], ['PI: revoke a phone', 'menuRevoke'],
  ['PI: approve all draft quick buttons', 'menuApproveQuick']];
function onOpen() {                      // used only when this file is pasted on its own instead of the loader
  const m = SpreadsheetApp.getUi().createMenu(CFG.MENU);
  MENU_ITEMS.forEach(function (it) { m.addItem(it[0], it[1]); });
  m.addToUi();
}
// What the loader calls. Every entry point must be listed here.
function exports_() {
  return { VERSION: CFG.VERSION, SCHEMA_VER: CFG.SCHEMA_VER, MENU: CFG.MENU, MENU_ITEMS: MENU_ITEMS,
    setup: setup, menuUsers: menuUsers, menuInvite: menuInvite, menuRevoke: menuRevoke, menuApproveQuick: menuApproveQuick, doGet: doGet, doPost: doPost };
}

// ---------------------------------------------------------------- setup
function setup() {
  const ui = SpreadsheetApp.getUi(), P = props_(), ss = SpreadsheetApp.getActive();
  const pi = piEmail_(), me = me_();
  if (pi && me && pi !== me) { ui.alert('Not allowed', 'This system was set up by ' + pi + '. Only that account can repair it.', ui.ButtonSet.OK); return; }
  if (!pi) P.setProperty('PI_EMAIL', me);
  P.setProperty('DATA_ID', ss.getId());
  const up = upgradeRecords_(ss, ui);
  if (up === false) { ui.alert('Stopped', 'The summaries were not upgraded.\n\nNothing was changed.', ui.ButtonSet.OK); return; }
  buildAll_(ss);
  P.setProperty('SCHEMA_VER', String(CFG.SCHEMA_VER));
  P.setProperty('VERSION', CFG.VERSION);
  ui.alert('Set up complete', (up ? up + '\n\n' : '') + 'Tabs are ready. ' + seedNote_(ss) + '\n\nNext: Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone), then ' + CFG.MENU + ' > PI: manage users, then PI: invite a phone (invite yourself first).', ui.ButtonSet.OK);
}
// Summaries saved in an older column layout are moved into the current one by column name, after the PI agrees.
// A full copy of the old tab is kept first, so values in columns that no longer exist are never lost.
// Returns '' when nothing was needed, a report when it upgraded, or false when the PI cancelled.
function upgradeRecords_(ss, ui) {
  const sh = ss.getSheetByName('DISCHARGES'), cols = DCOLS.map(function (c) { return c.key; });
  if (!sh || headerOk_(sh, cols) || sh.getLastRow() <= 1) return '';
  const width = sh.getMaxColumns(), n = sh.getLastRow() - 1;
  const head = sh.getRange(1, 1, 1, width).getValues()[0].map(cellTxt_);
  const vals = sh.getRange(2, 1, n, width).getValues();
  const removed = head.filter(function (h) { return h && cols.indexOf(h) < 0; }).map(function (h) {
    const i = head.indexOf(h), filled = vals.filter(function (v) { return cellTxt_(v[i]).trim() !== ''; }).length;
    return h + ' (' + filled + ' filled)';
  });
  const added = cols.filter(function (k) { return head.indexOf(k) < 0; });
  const ok = ui.alert('Upgrade ' + n + ' summar' + (n === 1 ? 'y' : 'ies') + '?', 'The DISCHARGES tab has ' + n + ' summar' + (n === 1 ? 'y' : 'ies') + ' in the older layout. Each one is moved into the new layout by column name.\n\n' +
    'New columns: ' + (added.join(', ') || 'none') + '\nColumns no longer used: ' + (removed.join(', ') || 'none') +
    '\n\nA full copy of the tab is kept first as DISCHARGES_backup, so nothing is lost.', ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return false;
  const stamp = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HHmm');
  sh.copyTo(ss).setName('DISCHARGES_backup ' + stamp);
  rewriteTab_(sh, cols);
  logIt_(me_(), 'summaries upgraded', '', n + ' rows; removed ' + (removed.join(', ') || 'none'));
  return n + ' summar' + (n === 1 ? 'y' : 'ies') + ' moved to the new layout. The old tab is kept as "DISCHARGES_backup ' + stamp + '".' + (removed.length ? ' Columns no longer used: ' + removed.join(', ') + ' (still in the backup).' : '');
}
function sheet_(ss, name, cols, opts) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() < 1) sh.getRange(1, 1, 1, cols.length).setValues([cols]);
  if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, cols.length).setFontWeight('bold').setBackground('#0e5e5a').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');     // text everywhere: dates stay yyyy-mm-dd, leading zeros stay
  if (opts && opts.wide) opts.wide.forEach(function (k) { const i = cols.indexOf(k); if (i >= 0) sh.setColumnWidth(i + 1, 320); });
  return sh;
}
function buildAll_(ss) {
  const dk = DCOLS.map(function (c) { return c.key; }), d0 = ss.getSheetByName('DISCHARGES');
  if (d0 && !headerOk_(d0, dk) && d0.getLastRow() <= 1) rewriteTab_(d0, dk);           // empty records tab: take the new layout
  ['QUICK', 'TEMPLATES', 'STAFF'].forEach(function (n) { const sh = ss.getSheetByName(n), c = { QUICK: QUICK_COLS, TEMPLATES: TEMPLATE_COLS, STAFF: STAFF_COLS }[n]; if (sh && !headerOk_(sh, c)) rewriteTab_(sh, c); });
  const d = sheet_(ss, 'DISCHARGES', dk, { wide: SECTIONS });
  d.getRange(1, 1, 1, DCOLS.length).setNotes([DCOLS.map(function (c) { return c.label + (c.codes ? '\n' + c.codes.map(function (p) { return p[0] + ' = ' + p[1]; }).join('\n') : ''); })]);
  const q = sheet_(ss, 'QUICK', QUICK_COLS, { wide: ['phrase'] });
  seedQuick_(q);
  q.getRange(1, 1, 1, QUICK_COLS.length).setNotes([['Made by the system', 'Which section the button belongs to: ' + SECTIONS.join(', '), 'A heading that groups buttons inside a section',
    'N = new line, S = same line, C = same line after a comma', 'The text the button inserts. ___ marks a blank the doctor fills in', 'draft = PI phone only until approved; live = everyone', '', '', 'D or H: shown only when the Diabetes or Hypertension box is ticked']]);
  const tp = sheet_(ss, 'TEMPLATES', TEMPLATE_COLS, { wide: SECTIONS });
  seedDefault_(tp); seedTemplates_(tp);
  const st = sheet_(ss, 'STAFF', STAFF_COLS);
  if (st.getLastRow() < 2) st.getRange(2, 1, SEED_STAFF.length, STAFF_COLS.length).setValues(SEED_STAFF);
  st.getRange(1, 1, 1, STAFF_COLS.length).setNotes([['Name as printed', 'consultant or mo', 'Printed under the name, e.g. Gynaecologist & Obstetrician', 'Degrees, e.g. MBBS, FCPS', 'Personal number printed on that consultant\u2019s summaries']]);
  const lg = sheet_(ss, 'LOG', ['at', 'user', 'action', 'ds_no', 'detail']);
  try {                                                  // only the PI may edit the system tabs by hand
    [lg].forEach(function (sh) { const p = sh.protect().setDescription('system'); p.getEditors().forEach(function (u) { if ((u.getEmail() || '').toLowerCase() !== piEmail_()) p.removeEditor(u); }); });
  } catch (e) { /* protection is a convenience; the phones never depend on it */ }
  const s1 = ss.getSheetByName('Sheet1'); if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);
}
function seedNote_(ss) {
  const n = ss.getSheetByName('QUICK').getLastRow() - 1;
  return n + ' quick buttons are in the QUICK tab (new ones as DRAFTS: only your phone shows them until you approve them: menu PI: approve all draft quick buttons). The Default row in TEMPLATES fills every new summary.';
}

// Starter quick buttons for obstetric (mostly caesarean) discharges, written as drafts for the PI to review.
// [section, group, join, phrase, needs]; needs D or H: shown only when that co-morbid box is ticked.
const SEED_QUICK = [
  ['final_diagnoses', 'Delivery', 'N', 'Delivered by elective lower segment caesarean section', ''],
  ['final_diagnoses', 'Delivery', 'N', 'Delivered by emergency lower segment caesarean section', ''],
  ['final_diagnoses', 'Delivery', 'N', 'Delivered by spontaneous vaginal delivery', ''],
  ['final_diagnoses', 'Indication', 'N', 'Previous caesarean section', ''],
  ['final_diagnoses', 'Indication', 'N', 'Previous 2 caesarean sections', ''],
  ['final_diagnoses', 'Indication', 'N', 'Breech presentation', ''],
  ['final_diagnoses', 'Indication', 'N', 'Transverse lie', ''],
  ['final_diagnoses', 'Indication', 'N', 'Failure to progress', ''],
  ['final_diagnoses', 'Indication', 'N', 'Fetal distress', ''],
  ['final_diagnoses', 'Indication', 'N', 'Cephalopelvic disproportion', ''],
  ['final_diagnoses', 'Indication', 'N', 'Failed induction of labour', ''],
  ['final_diagnoses', 'Indication', 'N', 'Placenta praevia', ''],
  ['final_diagnoses', 'Indication', 'N', 'Abruptio placentae', ''],
  ['final_diagnoses', 'Indication', 'N', 'Oligohydramnios', ''],
  ['final_diagnoses', 'Indication', 'N', 'Post-dates pregnancy', ''],
  ['final_diagnoses', 'Indication', 'N', 'Twin pregnancy', ''],
  ['final_diagnoses', 'Indication', 'N', 'Maternal request', ''],
  ['final_diagnoses', 'Other', 'N', 'Anaemia in pregnancy', ''],
  ['final_diagnoses', 'Other', 'N', 'Hypothyroidism', ''],
  ['final_diagnoses', 'Diabetes', 'N', 'Gestational diabetes mellitus', 'D'],
  ['final_diagnoses', 'Diabetes', 'N', 'Pre-existing diabetes in pregnancy', 'D'],
  ['final_diagnoses', 'Hypertension', 'N', 'Pregnancy-induced hypertension', 'H'],
  ['final_diagnoses', 'Hypertension', 'N', 'Pre-eclampsia', 'H'],
  ['final_diagnoses', 'Hypertension', 'N', 'Chronic hypertension', 'H'],
  ['history', 'Booking', 'N', 'Booked patient', ''],
  ['history', 'Booking', 'N', 'Unbooked patient', ''],
  ['history', 'Booking', 'N', 'Admitted for elective caesarean section', ''],
  ['history', 'Presented with', 'N', 'Presented with labour pains', ''],
  ['history', 'Presented with', 'N', 'Presented with leaking per vaginum', ''],
  ['history', 'Presented with', 'N', 'Presented with bleeding per vaginum', ''],
  ['history', 'Presented with', 'N', 'Presented with decreased fetal movements', ''],
  ['history', 'Presented with', 'N', 'Presented with labour pains and leaking per vaginum', ''],
  ['history', 'Other', 'N', 'No known drug allergies', ''],
  ['history', 'Diabetes', 'N', 'Known gestational diabetic on insulin', 'D'],
  ['history', 'Diabetes', 'N', 'Known gestational diabetic on metformin', 'D'],
  ['history', 'Diabetes', 'N', 'Known gestational diabetic on diet control', 'D'],
  ['history', 'Hypertension', 'N', 'Known hypertensive on methyldopa', 'H'],
  ['history', 'Hypertension', 'N', 'Known hypertensive on labetalol', 'H'],
  ['physical_findings', 'Change from normal', 'N', 'Pallor present', ''],
  ['physical_findings', 'Change from normal', 'N', 'Pedal oedema present', ''],
  ['physical_findings', 'Change from normal', 'N', 'Wound soakage present', ''],
  ['physical_findings', 'Change from normal', 'N', 'Tenderness around the wound', ''],
  ['physical_findings', 'Change from normal', 'N', 'BP ___/___ mmHg', ''],
  ['physical_findings', 'Change from normal', 'N', 'Pulse ___/min', ''],
  ['physical_findings', 'Change from normal', 'N', 'Temperature ___ \u00b0F', ''],
  ['course', 'Operation', 'N', 'Elective lower segment caesarean section performed', ''],
  ['course', 'Operation', 'N', 'Emergency lower segment caesarean section performed', ''],
  ['course', 'Operation', 'N', 'Spontaneous vaginal delivery conducted', ''],
  ['course', 'Baby', 'N', 'Alive baby boy, weight ___ kg', ''],
  ['course', 'Baby', 'N', 'Alive baby girl, weight ___ kg', ''],
  ['course', 'Baby', 'N', 'Alive twins', ''],
  ['course', 'Baby', 'N', 'Baby shifted to nursery', ''],
  ['course', 'Treatment', 'N', 'Inj. Metronidazole 500 mg IV three times daily given', ''],
  ['course', 'Treatment', 'N', 'Blood transfusion: ___ unit(s) given', ''],
  ['course', 'Treatment', 'N', 'Inj. Iron sucrose ___ mg given', ''],
  ['course', 'Treatment', 'N', 'Catheter removed after 24 hours', ''],
  ['course', 'Treatment', 'N', 'Mobilised and tolerating orally', ''],
  ['course', 'Outcome', 'N', 'Patient improved and discharged in stable condition', ''],
  ['course', 'Outcome', 'N', 'Discharged on request', ''],
  ['course', 'Outcome', 'N', 'Left against medical advice', ''],
  ['course', 'Diabetes', 'N', 'Blood sugar monitored and insulin adjusted', 'D'],
  ['course', 'Diabetes', 'N', 'Insulin stopped after delivery', 'D'],
  ['course', 'Hypertension', 'N', 'BP monitored; antihypertensives given', 'H'],
  ['course', 'Hypertension', 'N', 'Inj. Magnesium sulphate given as per protocol', 'H'],
  ['discharge_meds', 'Antibiotics', 'N', 'Cap. Cefixime 400 mg once daily', ''],
  ['discharge_meds', 'Antibiotics', 'N', 'Tab. Co-amoxiclav 625 mg three times daily', ''],
  ['discharge_meds', 'Antibiotics', 'N', 'Tab. Metronidazole 400 mg three times daily', ''],
  ['discharge_meds', 'Antibiotics', 'N', 'Inj. Ceftriaxone 1 g IV twice daily', ''],
  ['discharge_meds', 'Pain', 'N', 'Tab. Paracetamol 500 mg, 2 tablets three times daily', ''],
  ['discharge_meds', 'Pain', 'N', 'Tab. Mefenamic acid 500 mg three times daily', ''],
  ['discharge_meds', 'Pain', 'N', 'Tab. Ibuprofen 400 mg three times daily', ''],
  ['discharge_meds', 'Pain', 'N', 'Tab. Diclofenac 50 mg twice daily', ''],
  ['discharge_meds', 'Pain', 'N', 'Supp. Diclofenac 100 mg at night', ''],
  ['discharge_meds', 'Pain', 'N', 'Tab. Tramadol 50 mg twice daily when needed', ''],
  ['discharge_meds', 'Iron and vitamins', 'N', 'Tab. Ferrous sulphate with folic acid once daily', ''],
  ['discharge_meds', 'Iron and vitamins', 'N', 'Tab. Iron polymaltose 100 mg once daily', ''],
  ['discharge_meds', 'Iron and vitamins', 'N', 'Tab. Folic acid 5 mg once daily', ''],
  ['discharge_meds', 'Iron and vitamins', 'N', 'Tab. Calcium with vitamin D once daily', ''],
  ['discharge_meds', 'Stomach', 'N', 'Cap. Omeprazole 20 mg once daily before breakfast', ''],
  ['discharge_meds', 'Stomach', 'N', 'Tab. Domperidone 10 mg three times daily', ''],
  ['discharge_meds', 'Diabetes', 'N', 'Tab. Metformin 500 mg twice daily', 'D'],
  ['discharge_meds', 'Diabetes', 'N', 'Inj. Insulin ___ units ___', 'D'],
  ['discharge_meds', 'Hypertension', 'N', 'Tab. Methyldopa 250 mg three times daily', 'H'],
  ['discharge_meds', 'Hypertension', 'N', 'Tab. Labetalol 100 mg twice daily', 'H'],
  ['discharge_meds', 'Hypertension', 'N', 'Tab. Nifedipine 20 mg twice daily', 'H'],
  ['discharge_meds', 'How long', 'S', 'for 3 days', ''],
  ['discharge_meds', 'How long', 'S', 'for 5 days', ''],
  ['discharge_meds', 'How long', 'S', 'for 7 days', ''],
  ['discharge_meds', 'How long', 'S', 'for 2 weeks', ''],
  ['discharge_meds', 'How long', 'S', 'for 6 weeks', ''],
  ['discharge_meds', 'How long', 'S', 'to continue', ''],
  ['follow_up', 'Visit', 'N', 'Follow up in OPD after 1 week', ''],
  ['follow_up', 'Visit', 'N', 'Follow up in OPD after 2 weeks', ''],
  ['follow_up', 'Visit', 'N', 'Postnatal follow up after 6 weeks', ''],
  ['follow_up', 'Visit', 'N', 'Stitch removal after 7 days', ''],
  ['follow_up', 'Visit', 'N', 'Stitch removal after 10 days', ''],
  ['follow_up', 'Visit', 'N', 'Follow up with reports', ''],
  ['follow_up', 'Advice', 'N', 'Keep the wound clean and dry', ''],
  ['follow_up', 'Advice', 'N', 'Breastfeeding encouraged', ''],
  ['follow_up', 'Advice', 'N', 'Avoid lifting heavy weight for 6 weeks', ''],
  ['follow_up', 'Advice', 'N', 'Plenty of oral fluids', ''],
  ['follow_up', 'Advice', 'N', 'Come back at once in case of fever, bleeding, wound discharge or severe pain', ''],
  ['follow_up', 'Diabetes', 'N', 'Check blood sugar fasting and 2 hours after meals; bring the record', 'D'],
  ['follow_up', 'Hypertension', 'N', 'Check BP daily and bring the record', 'H']
];
// The Default template fills every new summary; the doctor changes only what differs. Edit it in the TEMPLATES tab.
const SEED_DEFAULT = { name: 'Default',
  physical_findings: 'BP 120/80 mmHg\nPulse 80/min\nTemperature 98.6 \u00b0F\nRespiratory rate 18/min\nChest clear\nAbdomen soft, wound healthy\nUterus well contracted\nLochia normal',
  course: 'Lower segment caesarean section performed\nInj. Ceftriaxone 1 g IV twice daily given\nPatient improved and discharged in stable condition' };
const SEED_STAFF = [['Dr. Sehrish Irfan', 'consultant', 'Gynaecologist & Obstetrician', 'MBBS, FCPS, MRCOG(UK), MHPE(s)', '0334-3337002'],
  ['Dr. Shahina', 'consultant', '', '', '0300 4235009'],
  ['Dr. Muhammad Irfan Alam', 'consultant', 'Diabetologist & Consultant Physician', 'MBBS, FCPS (Medicine), MHPE(s)', '']];
// Rewrites a support tab in the current column layout, moving every kept row by column name.
function rewriteTab_(sh, cols, keep) {
  const width = Math.max(cols.length, sh.getMaxColumns()), n = sh.getLastRow();
  const head = n ? sh.getRange(1, 1, 1, width).getValues()[0].map(cellTxt_) : [];
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, width).getValues().map(function (v) { const o = {}; head.forEach(function (h, i) { if (h) o[h] = cellTxt_(v[i]); }); return o; }) : [];
  const kept = rows.filter(function (o) { return Object.keys(o).some(function (k) { return o[k] !== ''; }) && (!keep || keep(o)); });
  if (n) sh.getRange(1, 1, n, width).setValues(Array.apply(null, Array(n)).map(function () { return Array.apply(null, Array(width)).map(function () { return ''; }); }));
  sh.getRange(1, 1, 1, cols.length).setValues([cols]);
  if (kept.length) sh.getRange(2, 1, kept.length, cols.length).setValues(kept.map(function (o) { return cols.map(function (k) { return o[k] === undefined ? '' : o[k]; }); }));
  return rows.length - kept.length;
}
function headerOk_(sh, cols) { return sh.getLastRow() < 1 || sh.getRange(1, 1, 1, cols.length).getValues()[0].map(cellTxt_).join('|') === cols.join('|'); }
function seedQuick_(sh) {
  const P = props_();
  if (P.getProperty('SEED_VER') === SEED_VER && sh.getLastRow() > 1) return 0;
  rewriteTab_(sh, QUICK_COLS, function (o) { return o.added_by !== 'starter list'; });       // old starter rows go; buttons people added stay
  const rows = readRows_(sh, QUICK_COLS), top = rows.reduce(function (m, r) { const x = /^q(\d+)$/.exec(r.qid); return x ? Math.max(m, +x[1]) : m; }, 0);
  const on = todayIso_(), add = SEED_QUICK.map(function (r, i) { return ['q' + (top + i + 1), r[0], r[1], r[2], r[3], 'draft', 'starter list', on, r[4] || '']; });
  sh.getRange(sh.getLastRow() + 1, 1, add.length, QUICK_COLS.length).setValues(add);
  P.setProperty('SEED_VER', SEED_VER);
  return add.length;
}
// Starter whole-summary templates (drafts for the PI to review; edit or delete them in the TEMPLATES tab). Consultants add more from any summary.
const TPL_SEED_VER = '1';
const MEDS_LSCS = 'Cap. Cefixime 400 mg once daily for 5 days\nTab. Paracetamol 500 mg, 2 tablets three times daily for 5 days\nTab. Ferrous sulphate with folic acid once daily for 6 weeks\nTab. Calcium with vitamin D once daily for 6 weeks';
const FU_LSCS = 'Stitch removal after 7 days\nKeep the wound clean and dry\nBreastfeeding encouraged\nAvoid lifting heavy weight for 6 weeks\nPostnatal follow up after 6 weeks\nCome back at once in case of fever, bleeding, wound discharge or severe pain';
const SEED_TEMPLATES = [
  { name: 'Elective LSCS', final_diagnoses: 'Delivered by elective lower segment caesarean section', history: 'Booked patient\nAdmitted for elective caesarean section',
    course: 'Elective lower segment caesarean section performed\nInj. Ceftriaxone 1 g IV twice daily given\nPatient improved and discharged in stable condition', discharge_meds: MEDS_LSCS, follow_up: FU_LSCS },
  { name: 'Emergency LSCS', final_diagnoses: 'Delivered by emergency lower segment caesarean section', history: 'Presented with labour pains',
    course: 'Emergency lower segment caesarean section performed\nInj. Ceftriaxone 1 g IV twice daily given\nPatient improved and discharged in stable condition', discharge_meds: MEDS_LSCS, follow_up: FU_LSCS },
  { name: 'Normal delivery', final_diagnoses: 'Delivered by spontaneous vaginal delivery', history: 'Presented with labour pains',
    course: 'Spontaneous vaginal delivery conducted\nPatient improved and discharged in stable condition',
    discharge_meds: 'Tab. Paracetamol 500 mg, 2 tablets three times daily for 3 days\nTab. Ferrous sulphate with folic acid once daily for 6 weeks\nTab. Calcium with vitamin D once daily for 6 weeks',
    follow_up: 'Breastfeeding encouraged\nPostnatal follow up after 6 weeks\nCome back at once in case of fever, heavy bleeding or severe pain' }
];
function seedTemplates_(sh) {
  const P = props_();
  if (P.getProperty('TPL_SEED_VER') === TPL_SEED_VER) return;
  const have = readRows_(sh, TEMPLATE_COLS), names = have.map(function (t) { return t.name.toLowerCase(); });
  let top = have.reduce(function (m, r) { const x = /^t(\d+)$/.exec(r.tid); return x ? Math.max(m, +x[1]) : m; }, 0);
  SEED_TEMPLATES.forEach(function (st) {
    if (names.indexOf(st.name.toLowerCase()) >= 0) return;                 // never overwrite a template of the same name
    const t = { tid: 't' + (++top), saved_by: 'starter (please review)', saved_on: todayIso_() };
    TEMPLATE_COLS.forEach(function (k) { if (st[k] !== undefined) t[k] = st[k]; });
    writeRow_(sh, TEMPLATE_COLS, sh.getLastRow() + 1, t);
  });
  P.setProperty('TPL_SEED_VER', TPL_SEED_VER);
}
function seedDefault_(sh) {
  if (readRows_(sh, TEMPLATE_COLS).some(function (t) { return t.name.toLowerCase() === 'default'; })) return;
  const t = { tid: 't0', saved_by: 'starter', saved_on: todayIso_() };
  TEMPLATE_COLS.forEach(function (k) { if (SEED_DEFAULT[k] !== undefined) t[k] = SEED_DEFAULT[k]; });
  writeRow_(sh, TEMPLATE_COLS, sh.getLastRow() + 1, t);
}

// ---------------------------------------------------------------- reading and writing tabs
function readRows_(sh, cols) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, cols.length).getValues().map(function (v, i) {
    const o = { _row: i + 2 }; cols.forEach(function (k, j) { o[k] = cellTxt_(v[j]).trim(); }); return o;
  });
}
function dRows_(ss) { return readRows_(ss.getSheetByName('DISCHARGES'), DCOLS.map(function (c) { return c.key; })); }
function writeRow_(sh, cols, row, o) { sh.getRange(row, 1, 1, cols.length).setValues([cols.map(function (k) { return o[k] === undefined ? '' : o[k]; })]); }
function logIt_(user, action, ds, detail) {
  try { ss_().getSheetByName('LOG').appendRow([nowTxt_(), user || '', action, ds || '', String(detail || '').slice(0, 500)]); } catch (e) { console.error('log: ' + e); }
}
function wbSchema_() { const v = Number(props_().getProperty('SCHEMA_VER')); return v > 0 ? v : 1; }
function nextDs_(rows) {
  const top = rows.reduce(function (m, r) { const x = new RegExp('^' + CFG.DS_PREFIX + '(\\d+)$').exec(r.ds_no); return x ? Math.max(m, +x[1]) : m; }, 0);
  return CFG.DS_PREFIX + ('000' + (top + 1)).slice(-Math.max(4, String(top + 1).length));
}

// ---------------------------------------------------------------- users and invitations
const ROLE_LISTS = { consultant: 'CONSULTANT_EMAILS', mo: 'MO_EMAILS' };
function roleOf_(email) {
  const e = (email || '').toLowerCase();
  if (!e) return '';
  if (e === piEmail_()) return 'pi';
  if (emails_('CONSULTANT_EMAILS').indexOf(e) >= 0) return 'consultant';
  if (emails_('MO_EMAILS').indexOf(e) >= 0) return 'mo';
  return '';
}
function menuUsers() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), P = props_();
  const lists = [['CONSULTANT_EMAILS', 'Consultants (can finalise summaries)'], ['MO_EMAILS', 'Medical officers (can write drafts)']];
  for (let i = 0; i < lists.length; i++) {
    const r = ui.prompt('Manage users', lists[i][1] + ': Google e-mails separated by commas. You (' + piEmail_() + ') are the PI and need no entry.\n\nNow: ' + (P.getProperty(lists[i][0]) || 'nobody'), ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    const t = r.getResponseText().trim();
    if (t === '') continue;                                   // blank keeps the list as it is
    const list = t === '-' ? [] : t.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); });
    P.setProperty(lists[i][0], list.join(','));
  }
  logIt_(me_(), 'users', '', 'consultants ' + emails_('CONSULTANT_EMAILS').length + ', medical officers ' + emails_('MO_EMAILS').length);
  ui.alert('Saved', 'Consultants: ' + (emails_('CONSULTANT_EMAILS').join(', ') || 'none') + '\nMedical officers: ' + (emails_('MO_EMAILS').join(', ') || 'none') + '\n\nType a single - to empty a list. Leave a box blank to keep it.', ui.ButtonSet.OK);
}
function inviteLink_(email) {
  const P = props_(), code = randomHex_(32);
  P.setProperty('APPJOIN_' + sha256_(code), JSON.stringify({ email: email, expires: Date.now() + APP_JOIN_DAYS * 864e5 }));
  return P.getProperty('APP_URL').replace(/#.*$/, '') + '#join=' + encodeURIComponent(P.getProperty('API_URL')) + '~' + code;
}
function menuInvite() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), P = props_();
  if (!P.getProperty('API_URL')) {
    let live = ''; try { const svc = ScriptApp.getService(); live = svc && svc.getUrl ? svc.getUrl() : ''; } catch (e) { /* not needed: the address is pasted */ }
    const q = ui.prompt('Web app address', 'Paste the web app URL from Deploy > Manage deployments (it ends with /exec). Asked only once.' + (live ? '\n\nThe project reports: ' + live : ''), ui.ButtonSet.OK_CANCEL);
    if (q.getSelectedButton() !== ui.Button.OK) return;
    const api = q.getResponseText().trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(api)) { ui.alert('Not saved', 'That is not a web app address ending in /exec.', ui.ButtonSet.OK); return; }
    P.setProperty('API_URL', api);
  }
  if (!P.getProperty('APP_URL')) {
    const a = ui.prompt('Phone app address', 'Address where the Bari Discharge app is published (https://...):', ui.ButtonSet.OK_CANCEL);
    if (a.getSelectedButton() !== ui.Button.OK) return;
    const url = a.getResponseText().trim();
    if (!/^(https:\/\/\S+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/\S*)$/.test(url)) { ui.alert('Not saved', 'The address must start with https://', ui.ButtonSet.OK); return; }
    P.setProperty('APP_URL', url);
  }
  const b = ui.prompt('Invite a phone', 'Google e-mail of the person (you, a consultant or a medical officer from "manage users"):', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  const email = b.getResponseText().trim().toLowerCase(), role = roleOf_(email);
  if (!role) { ui.alert('Not invited', email + ' is not in a user list. Add them with "PI: manage users" first.', ui.ButtonSet.OK); return; }
  const link = inviteLink_(email);
  logIt_(me_(), 'invite', '', email + ' (' + ROLE_NAMES[role] + ')');
  ui.alert('Invitation for ' + email + ' (' + ROLE_NAMES[role] + ')', 'Send this link to ' + email + ' privately. It works once, on one phone, and expires in ' + APP_JOIN_DAYS + ' days:\n\n' + link, ui.ButtonSet.OK);
}
function menuRevoke() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), P = props_();
  const b = ui.prompt('Revoke a phone', 'Google e-mail whose phones should lose access:', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  const n = revoke_(b.getResponseText());
  logIt_(me_(), 'revoke', '', b.getResponseText().trim().toLowerCase() + ' (' + n + ')');
  ui.alert('Revoked', n + ' phone(s) or unused invitation(s) can no longer reach the records.', ui.ButtonSet.OK);
}
function revoke_(email) {
  const P = props_(), all = P.getProperties(), e = String(email || '').trim().toLowerCase();
  let n = 0;
  Object.keys(all).forEach(function (k) {
    if (!/^APP(JOIN)?_/.test(k)) return;
    try { if (JSON.parse(all[k]).email === e) { P.deleteProperty(k); n++; } } catch (x) { /* not an app entry */ }
  });
  return n;
}
function menuApproveQuick() {
  requirePI_();
  const n = approveQuick_();
  logIt_(me_(), 'quick buttons approved', '', String(n));
  SpreadsheetApp.getUi().alert('Approved', n + ' draft quick button(s) are now live on every phone (after their next sync).', SpreadsheetApp.getUi().ButtonSet.OK);
}
function approveQuick_() {
  const sh = ss_().getSheetByName('QUICK'), rows = readRows_(sh, QUICK_COLS);
  let n = 0;
  rows.forEach(function (r) { if (r.status.toLowerCase() !== 'live') { sh.getRange(r._row, QUICK_COLS.indexOf('status') + 1).setValue('live'); n++; } });
  return n;
}

// ---------------------------------------------------------------- web app (phone) API
function appJson_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function appUser_(token) {
  if (!/^[0-9a-f]{64}$/.test(str_(token))) return null;
  const raw = props_().getProperty('APP_' + sha256_(token));
  if (!raw) return null;
  const u = JSON.parse(raw), role = roleOf_(u.email);
  if (!role) return null;
  u.role = role;
  return u;
}
function doGet() { return appJson_({ ok: true, system: 'BARI-DS', version: CFG.VERSION }); }
function doPost(e) {
  let req;
  try { req = JSON.parse(e && e.postData ? e.postData.contents : '{}'); } catch (err) { return appJson_({ ok: false, error: 'bad request' }); }
  try {
    if (req.op === 'join') return appJson_(appJoin_(req));
    const u = appUser_(req.token);
    if (!u) return appJson_({ ok: false, error: 'not authorised', code: 401 });
    if (req.op === 'hello') return appJson_({ ok: true, schema: wbSchema_(), version: CFG.VERSION });
    if (wbSchema_() !== CFG.SCHEMA_VER) return appJson_({ ok: false, error: 'The workbook is being upgraded. Your entries stay on this phone.', code: 409 });
    if (req.op === 'pull') return appJson_(appPull_(u));
    if (req.op === 'push') {
      if (Number(req.schema) !== CFG.SCHEMA_VER) return appJson_({ ok: false, error: 'This app and the workbook are different versions. Close the app and open it again while online.', code: 409 });
      return appJson_(appPush_(u, req.changes || []));
    }
    if (req.op === 'search') return appJson_(appSearch_(u, req));
    if (req.op === 'quick_add') return appJson_(quickAdd_(u, req));
    if (req.op === 'quick_approve') return appJson_(quickApprove_(u));
    if (req.op === 'quick_delete') return appJson_(quickDelete_(u, req));
    if (req.op === 'template_save') return appJson_(templateSave_(u, req));
    if (req.op === 'template_delete') return appJson_(templateDelete_(u, req));
    if (req.op === 'invite') return appJson_(appInvite_(u, req));
    return appJson_({ ok: false, error: 'unknown operation' });
  } catch (err) {
    console.error('doPost: ' + (err && err.stack ? err.stack : err));
    return appJson_({ ok: false, error: 'server error: ' + (err && err.message ? err.message : err) });
  }
}
function withLock_(fn) { const l = LockService.getScriptLock(); l.waitLock(20000); try { return fn(); } finally { l.releaseLock(); } }

function appJoin_(req) {
  const P = props_(), code = str_(req.code);
  if (!/^[0-9a-f]{32}$/.test(code)) return { ok: false, error: 'invalid invitation' };
  const k = 'APPJOIN_' + sha256_(code), raw = P.getProperty(k);
  if (!raw) return { ok: false, error: 'this invitation has already been used or was withdrawn' };
  const inv = JSON.parse(raw);
  P.deleteProperty(k);
  if (Date.now() > inv.expires) return { ok: false, error: 'this invitation has expired; ask the PI for a new one' };
  const role = roleOf_(inv.email);
  if (!role) return { ok: false, error: 'this account no longer has a role' };
  const token = randomHex_(64);
  P.setProperty('APP_' + sha256_(token), JSON.stringify({ email: inv.email, issued: Date.now(), device: str_(req.device).slice(0, 60) }));
  logIt_(inv.email, 'phone joined', '', str_(req.device).slice(0, 60));
  return { ok: true, token: token, email: inv.email, role: role };
}
function appInvite_(u, req) {
  if (u.role !== 'pi') return { ok: false, error: 'only the PI can invite' };
  const P = props_(), email = str_(req.email).toLowerCase(), role = str_(req.role);
  if (!/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(email)) return { ok: false, error: 'that is not an e-mail address' };
  if (email === piEmail_()) return { ok: false, error: 'that is the PI account' };
  if (!ROLE_LISTS[role]) return { ok: false, error: 'choose a role' };
  if (!P.getProperty('API_URL') || !P.getProperty('APP_URL')) return { ok: false, error: 'make the first invitation from the workbook menu' };
  withLock_(function () {
    Object.keys(ROLE_LISTS).forEach(function (r) {
      const list = emails_(ROLE_LISTS[r]).filter(function (x) { return x !== email; });
      if (r === role) list.push(email);
      P.setProperty(ROLE_LISTS[r], list.join(','));
    });
  });
  logIt_(u.email, 'invite', '', email + ' (' + ROLE_NAMES[role] + ')');
  return { ok: true, email: email, roleName: ROLE_NAMES[role], link: inviteLink_(email), days: APP_JOIN_DAYS };
}

function quickRows_() { return readRows_(ss_().getSheetByName('QUICK'), QUICK_COLS); }
function appPull_(u) {
  const ss = ss_(), today = dayNo_(todayIso_());
  const rows = dRows_(ss).filter(function (r) {
    if (r.status !== 'F') return true;                                  // every draft
    const d = dayNo_(r.discharge_date) || dayNo_(String(r.updated_at).slice(0, 10));
    return d === null || today - d <= CFG.PULL_DAYS;
  }).map(function (r) { delete r._row; return r; });
  const quick = quickRows_().filter(function (q) { return q.phrase && SECTIONS.indexOf(q.section) >= 0 && (u.role === 'pi' || q.status.toLowerCase() === 'live'); })
    .map(function (q) { return { qid: q.qid, section: q.section, group: q.group, join: code_(q.join) || 'N', phrase: q.phrase, draft: q.status.toLowerCase() !== 'live', needs: code_(q.needs) }; });
  const templates = readRows_(ss.getSheetByName('TEMPLATES'), TEMPLATE_COLS).filter(function (t) { return t.name; }).map(function (t) { delete t._row; return t; });
  const staff = readRows_(ss.getSheetByName('STAFF'), STAFF_COLS).filter(function (s) { return s.name; }).map(function (s) { return { name: s.name, role: s.role.toLowerCase() === 'mo' ? 'mo' : 'consultant', specialty: s.specialty, qualifications: s.qualifications, phone: s.phone }; });
  return { ok: true, email: u.email, role: u.role, roleName: ROLE_NAMES[u.role], version: CFG.VERSION, schema: CFG.SCHEMA_VER, today: todayIso_(), rows: rows, quick: quick, templates: templates, staff: staff };
}
function appSearch_(u, req) {
  const q = str_(req.q).toLowerCase();
  if (q.length < 2) return { ok: false, error: 'type at least 2 letters' };
  const rows = dRows_(ss_()).filter(function (r) { return (r.name + ' ' + r.father_husband + ' ' + r.ds_no).toLowerCase().indexOf(q) >= 0; })
    .slice(-50).map(function (r) { delete r._row; return r; });
  return { ok: true, rows: rows };
}

// Each change: { cid, uid, create, values, base }. base holds the values the phone last saw, so a field someone else changed meanwhile is not overwritten.
function appPush_(u, changes) {
  if (!roleCan_(u.role, 'edit')) return { ok: false, error: 'this role cannot write' };
  if (!Array.isArray(changes) || changes.length > 20) return { ok: false, error: 'bad batch' };
  return withLock_(function () {
    const ss = ss_(), sh = ss.getSheetByName('DISCHARGES'), keys = DCOLS.map(function (c) { return c.key; });
    const rows = dRows_(ss), results = [];
    changes.forEach(function (ch) {
      const res = { cid: str_(ch.cid) };
      try {
        const uid = str_(ch.uid);
        if (!/^[0-9a-f]{24}$/.test(uid)) throw new Error('bad record id');
        const vals = ch.values || {}, base = ch.base || {};
        const bad = Object.keys(vals).filter(function (k) { return EDITABLE.indexOf(k) < 0 || typeof vals[k] !== 'string'; });
        if (bad.length) throw new Error('not allowed: ' + bad.join(', '));
        let row = rows.filter(function (r) { return r.uid === uid; })[0];
        if (!row && !ch.create) throw new Error('this record is no longer in the workbook');
        const before = row ? JSON.parse(JSON.stringify(row)) : null;
        const isNew = !row;
        if (isNew) { row = { uid: uid, status: 'D' }; }
        // someone else changed a field since this phone last saw it: keep theirs and say so
        const conflicts = isNew ? [] : Object.keys(vals).filter(function (k) {
          return base[k] !== undefined && str_(row[k]) !== str_(base[k]) && str_(row[k]) !== str_(vals[k]);
        });
        if (conflicts.length) { res.status = 'conflict'; res.errors = conflicts.map(function (k) { return colOf_(k).label + ' was changed by ' + (row.updated_by || 'someone else'); }); res.current = row; delete res.current._row; results.push(res); return; }
        const next = JSON.parse(JSON.stringify(row));
        Object.keys(vals).forEach(function (k) { next[k] = k === 'status' || colOf_(k).type === 'code' || colOf_(k).type === 'multi' ? code_(vals[k]) : String(vals[k]).replace(/\r\n?/g, '\n').trim(); });
        if (before && before.status === 'F' && !roleCan_(u.role, 'finalise')) throw new Error('this summary is final; only a consultant can change it');
        if (next.status === 'F' && (!before || before.status !== 'F') && !roleCan_(u.role, 'finalise')) throw new Error('only a consultant can finalise');
        const probs = rowProblems_(next);
        if (probs.length) throw new Error(probs.join('; '));
        if (next.status === 'F') { const g = finalGaps_(next); if (g.length) throw new Error('to finalise, fill in: ' + g.join(', ')); }
        if (!str_(next.name)) throw new Error('the patient’s name is needed');
        const changed = keys.filter(function (k) { return !before || str_(before[k]) !== str_(next[k]); });
        if (!isNew && changed.length === 0) { res.status = 'ok'; res.ds_no = row.ds_no; results.push(res); return; }   // a retry of a change already saved
        const at = nowTxt_(), by = str_(ch.by).slice(0, 60) || u.email;
        next.updated_by = by; next.updated_at = at;
        if (isNew) { next.ds_no = nextDs_(rows); next.created_by = by; next.created_at = at; }
        if (next.status === 'F' && (!before || before.status !== 'F')) { next.finalised_by = by; next.finalised_at = at; }
        if (next.status === 'D') { next.finalised_by = ''; next.finalised_at = ''; }
        if (isNew) { const r = sh.getLastRow() + 1; writeRow_(sh, keys, r, next); next._row = r; rows.push(next); }
        else { writeRow_(sh, keys, row._row, next); next._row = row._row; rows[rows.indexOf(row)] = next; }
        logIt_(u.email, isNew ? 'created' : next.status === 'F' && before.status !== 'F' ? 'finalised' : before && before.status === 'F' && next.status === 'D' ? 'reopened' : 'changed', next.ds_no, changed.join(', '));
        res.status = 'ok'; res.ds_no = next.ds_no;
      } catch (err) { res.status = 'refused'; res.errors = [String(err.message || err)]; }
      results.push(res);
    });
    return { ok: true, results: results };
  });
}

function quickAdd_(u, req) {
  if (!roleCan_(u.role, 'quickAdd')) return { ok: false, error: 'this role cannot add buttons' };
  const sec = str_(req.section), phrase = str_(req.phrase).replace(/\s+/g, ' '), group = str_(req.group).slice(0, 40) || 'Added', join = code_(req.join) || 'N';
  if (SECTIONS.indexOf(sec) < 0) return { ok: false, error: 'unknown section' };
  if (phrase.length < 2 || phrase.length > 200) return { ok: false, error: 'a button holds 2 to 200 characters' };
  if (!JOINS.some(function (j) { return j[0] === join; })) return { ok: false, error: 'bad join' };
  return withLock_(function () {
    const sh = ss_().getSheetByName('QUICK'), rows = readRows_(sh, QUICK_COLS);
    const dup = rows.filter(function (r) { return r.section === sec && r.phrase.toLowerCase() === phrase.toLowerCase(); })[0];
    if (dup) return { ok: true, qid: dup.qid, already: true };
    const top = rows.reduce(function (m, r) { const x = /^q(\d+)$/.exec(r.qid); return x ? Math.max(m, +x[1]) : m; }, 0);
    const q = { qid: 'q' + (top + 1), section: sec, group: group, join: join, phrase: phrase, status: roleCan_(u.role, 'quickLive') ? 'live' : 'draft', added_by: str_(req.by).slice(0, 60) || u.email, added_on: todayIso_(), needs: /^[DH]$/.test(code_(req.needs)) ? code_(req.needs) : '' };
    writeRow_(sh, QUICK_COLS, sh.getLastRow() + 1, q);
    logIt_(u.email, 'quick button added', '', sec + ': ' + phrase);
    return { ok: true, qid: q.qid, status: q.status };
  });
}
function quickApprove_(u) {
  if (!roleCan_(u.role, 'quickApprove')) return { ok: false, error: 'only the PI can approve' };
  const n = withLock_(approveQuick_);
  logIt_(u.email, 'quick buttons approved', '', n + ' from the phone');
  return { ok: true, n: n };
}
function quickDelete_(u, req) {
  if (u.role !== 'pi') return { ok: false, error: 'only the PI can delete buttons' };
  return withLock_(function () {
    const sh = ss_().getSheetByName('QUICK'), r = readRows_(sh, QUICK_COLS).filter(function (x) { return x.qid === str_(req.qid); })[0];
    if (!r) return { ok: true, gone: true };
    sh.deleteRow(r._row);
    logIt_(u.email, 'quick button deleted', '', r.section + ': ' + r.phrase);
    return { ok: true };
  });
}
function templateSave_(u, req) {
  if (!roleCan_(u.role, 'template')) return { ok: false, error: 'only a consultant can save templates' };
  const name = str_(req.name).slice(0, 60), v = req.values || {};
  if (name.length < 2) return { ok: false, error: 'give the template a name' };
  return withLock_(function () {
    const sh = ss_().getSheetByName('TEMPLATES'), rows = readRows_(sh, TEMPLATE_COLS);
    const old = rows.filter(function (t) { return t.name.toLowerCase() === name.toLowerCase(); })[0];
    const top = rows.reduce(function (m, r) { const x = /^t(\d+)$/.exec(r.tid); return x ? Math.max(m, +x[1]) : m; }, 0);
    const t = { tid: old ? old.tid : 't' + (top + 1), name: name, saved_by: str_(req.by).slice(0, 60) || u.email, saved_on: todayIso_() };
    SECTIONS.forEach(function (k) { t[k] = str_(v[k]).slice(0, CFG.TEXT_MAX); });
    writeRow_(sh, TEMPLATE_COLS, old ? old._row : sh.getLastRow() + 1, t);
    logIt_(u.email, 'template saved', '', name);
    return { ok: true, tid: t.tid, replaced: !!old };
  });
}
function templateDelete_(u, req) {
  if (!roleCan_(u.role, 'template')) return { ok: false, error: 'only a consultant can delete templates' };
  return withLock_(function () {
    const sh = ss_().getSheetByName('TEMPLATES'), r = readRows_(sh, TEMPLATE_COLS).filter(function (x) { return x.tid === str_(req.tid); })[0];
    if (r) { sh.deleteRow(r._row); logIt_(u.email, 'template deleted', '', r.name); }
    return { ok: true };
  });
}
