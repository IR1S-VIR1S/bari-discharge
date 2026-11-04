/**
 * ============================================================================
 *  BARI HOSPITAL: OBSTETRIC DISCHARGE SUMMARY SYSTEM v1.8
 *  4 November 2026. One file: paste into the spreadsheet's Apps Script editor.
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
 *    FOLLOW_UPS   every follow-up not yet attended or closed, soonest first (a live view: do not type in it)
 *    CERTIFICATES medical certificates (sick leave, maternity leave, fitness, attendant) issued from final summaries
 *    DELETED      summaries deleted from the phone, kept here with who deleted them, when and why (only the PI can see the sheet)
 *    LOG          a short list of who did what and when (field names only, not the text)
 *    AUDIT        the full audit trail: every change field by field with the old and new value, who, role, when and why,
 *                 written only by the script, each row chained to the one before by a hash so any later edit shows (menu: PI: check the audit trail)
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
  VERSION: '1.8',
  SCHEMA_VER: 4,                      // 2: obstetric layout (G/P, weeks, co-morbid, operation date, Hb/TLC/PLT); 3: follow-up calendar and patient phone; 4: verification code
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
// Follow-up (recall) tracking. A blank status means the patient is expected on fu_date.
const FU_STATUS = [['A', 'Attended'], ['M', 'Missed'], ['X', 'Closed']];
const FU_REASONS = ['Wound check', 'Stitch removal', 'Postnatal check (6 weeks)', 'BP check', 'Sugar check', 'Review with reports'];
const FU_KEYS = ['phone', 'fu_date', 'fu_for', 'fu_status', 'fu_note', 'fu_reminded'];   // may be changed on a final summary by any writer
const FU_SOON_DAYS = 7;                                         // "this week" on the calendar

function col(key, label, type, o) { const c = { key: key, label: label, type: type }; if (o) Object.keys(o).forEach(function (k) { c[k] = o[k]; }); return c; }

// Front of the pad, then the back. "sec" columns are the long sections with quick buttons.
const SCHEMA = [{ tab: 'DISCHARGES', title: 'Obstetric discharge summaries', cols: [
  col('ds_no', 'Discharge number', 'sys'),
  col('uid', 'Record id (made by the phone)', 'sys'),
  col('status', 'Status', 'code', { codes: STATUS }),
  col('date', 'Date', 'date'),
  col('name', 'Name', 'text'),
  col('father_husband', 'Husband\u2019s / Father\u2019s name', 'text'),
  col('phone', 'Patient\u2019s mobile', 'phone'),
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
  col('fu_date', 'Next follow-up date', 'date'),
  col('fu_for', 'Follow-up for', 'text'),
  col('fu_status', 'Follow-up status', 'code', { codes: FU_STATUS }),
  col('fu_note', 'Follow-up note', 'text'),
  col('fu_reminded', 'Reminder sent on', 'date'),
  col('mo_name', 'Medical officer', 'text'),
  col('created_by', 'Created by', 'sys'),
  col('created_at', 'Created at', 'sys'),
  col('updated_by', 'Last changed by', 'sys'),
  col('updated_at', 'Last changed at', 'sys'),
  col('finalised_by', 'Finalised by', 'sys'),
  col('finalised_at', 'Finalised at', 'sys'),
  col('vcode', 'Verification code', 'vcode'),
  col('fu_log', 'Follow-up history', 'sys')
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
// Medical certificates. Each is issued from a final summary by a consultant, once, and never edited: a mistake is withdrawn and a new one issued.
// The patient's details are copied in at issue, so the certificate reads the same even if the summary is amended later.
const CERT_COLS = ['cert_no', 'cuid', 'ds_uid', 'ds_no', 'ctype', 'purpose', 'addressed_to', 'patient', 'title', 'guardian', 'age', 'admit_date', 'discharge_date', 'birth_date',
  'attendant', 'relation', 'from_date', 'to_date', 'exam_date', 'issued_on', 'show_dx', 'dx', 'advice', 'doctor', 'status', 'vcode', 'issued_by', 'issued_at', 'withdrawn_by', 'withdrawn_at', 'withdraw_reason'];
const CTYPES = [['R', 'Sick leave'], ['M', 'Maternity leave'], ['F', 'Fitness to resume'], ['A', 'Attendant']];
const CTITLE = { R: 'MEDICAL CERTIFICATE', M: 'MATERNITY LEAVE CERTIFICATE', F: 'CERTIFICATE OF FITNESS', A: 'ATTENDANT CERTIFICATE' };
const PURPOSES = [['W', 'Work'], ['S', 'School, college or university']];
const RELATIONS = ['Husband', 'Mother', 'Father', 'Sister', 'Brother', 'Mother-in-law', 'Son', 'Daughter'];
const CERT_ADVICE = ['Avoid lifting heavy weight for 6 weeks', 'Light duties for 2 weeks', 'Shorter working hours for 2 weeks', 'Avoid prolonged standing for 2 weeks', 'Breastfeeding breaks during working hours'];
const CERT_MAX = { R: 90, M: 180, F: 0, A: 30 };
// Printed on every certificate and shown on the verification page. Worded as a limit of purpose, not as "invalid in law": a medical
// certificate remains a document the doctor answers for, and injury or assault cases need a medico-legal certificate (MLC) from an authorised
// Medico-Legal Officer at a designated hospital.
const CERT_LEGAL = 'NOT FOR MEDICO-LEGAL PURPOSES. This certificate is issued only to support leave from work or studies, or return to them. It is not a medico-legal certificate (MLC) and must not be produced as evidence in any court, police inquiry or other legal proceedings. Matters requiring medico-legal examination must be referred to an authorised Medico-Legal Officer.';

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
      const f = dayNo_(row.fu_date);
      if (c.key === 'fu_date' && f !== null && b !== null && f < b) return 'Next follow-up date is before the date of discharge';
    }
    return '';
  }
  if (c.type === 'vcode') return /^[0-9a-f]{16}$/.test(s) ? '' : 'Verification code: made by the app';
  if (c.type === 'phone') return /^\+?[0-9][0-9 -]{8,16}[0-9]$/.test(s) && s.replace(/\D/g, '').length >= 10 && s.replace(/\D/g, '').length <= 13 ? '' : c.label + ': 10 to 13 digits, e.g. 0300 1234567';
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
// Urdu instructions for each medicine line, built from the English wording (printed next to the line on the PDF).
// A line can carry its own wording after " | ", for example: Tab. X 10 mg once daily | صبح خالی پیٹ
const URDU_FORM = [[/^tab\.?\s/i, 'ایک گولی'], [/^cap\.?\s/i, 'ایک کیپسول'], [/^inj\.?\s/i, 'انجکشن'], [/^supp\.?\s/i, 'ایک بتی'], [/^syp\.?\s/i, 'شربت']];
const URDU_TERMS = [
  [/\b2 tablets\b/i, 'دو گولیاں', 'dose'], [/\b1 tablet\b/i, 'ایک گولی', 'dose'],
  [/\bIV\b/, 'رگ میں', 'route'], [/\bIM\b/, 'پٹھے میں', 'route'], [/\bin the rectum\b/i, 'پاخانے کے راستے', 'route'],
  [/\bthree times daily\b/i, 'دن میں تین بار', 'freq'], [/\btwice daily\b/i, 'دن میں دو بار', 'freq'], [/\bonce daily\b/i, 'دن میں ایک بار', 'freq'],
  [/\bat night\b/i, 'رات کو', 'when'], [/\bbefore breakfast\b/i, 'ناشتے سے پہلے', 'when'], [/\bwith meals\b/i, 'کھانے کے ساتھ', 'when'], [/\bwhen needed\b/i, 'ضرورت پڑنے پر', 'when'],
  [/\bto continue\b/i, 'جاری رکھیں', 'dur']
];
function urduFor_(line) {
  const s = str_(line);
  if (!s || s.indexOf('___') >= 0) return '';
  const bar = s.indexOf(' | ');
  if (bar >= 0) return str_(s.slice(bar + 3));
  const got = {};
  URDU_TERMS.forEach(function (t) { if (!got[t[2]] && t[0].test(s)) got[t[2]] = t[1]; });
  const d = /\bfor (\d+) (day|days|week|weeks|month|months)\b/i.exec(s);
  if (d) got.dur = d[1] + ' ' + (/^day/i.test(d[2]) ? 'دن' : /^week/i.test(d[2]) ? 'ہفتے' : 'مہینے') + ' تک';
  if (!got.freq && !got.when && !got.dur) return '';
  const form = URDU_FORM.filter(function (f) { return f[0].test(s); })[0];
  const head = got.dose || (form ? form[1] : '');
  return [head, got.route, got.freq, got.when, got.dur].filter(function (x) { return x; }).join('، ');
}
function medEnglish_(line) { const s = str_(line), bar = s.indexOf(' | '); return bar >= 0 ? str_(s.slice(0, bar)) : s; }
function finalGaps_(row) { return FINAL_NEEDS.filter(function (k) { return str_(row[k]) === ''; }).map(function (k) { return colOf_(k).label; }); }
function rowProblems_(row) {
  const out = [];
  DCOLS.forEach(function (c) { if (c.type === 'sys') return; const e = validateValue_(c, row[c.key], row); if (e && out.indexOf(e) < 0) out.push(e); });
  return out;
}

// ---------------------------------------------------------------- follow-ups (shared with the phone)
// Where a follow-up stands on a given day, as recall worklists group them:
// missed (needs a call), overdue, today, soon (within FU_SOON_DAYS), later; done = attended or closed; none = no date.
function fuState_(row, today) {
  const d = dayNo_(row.fu_date), st = code_(row.fu_status);
  if (d === null) return 'none';
  if (st === 'A' || st === 'X') return 'done';
  if (st === 'M') return 'missed';
  if (d < today) return 'overdue';
  if (d === today) return 'today';
  return d - today <= FU_SOON_DAYS ? 'soon' : 'later';
}
function isoFromDay_(n) { const t = new Date(n * 864e5); return t.getUTCFullYear() + '-' + pad2_(t.getUTCMonth() + 1) + '-' + pad2_(t.getUTCDate()); }
function addDays_(iso, n) { const d = dayNo_(iso); return d === null ? '' : isoFromDay_(d + n); }
// "Stitch removal after 7 days" -> 7. The first "after N days/weeks" in the instructions suggests the follow-up date.
function fuAfterDays_(text) { const m = /\bafter (\d{1,2}) (day|days|week|weeks)\b/i.exec(str_(text)); return m ? +m[1] * (/^week/i.test(m[2]) ? 7 : 1) : 0; }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fuLine_(row) {                       // printed on the summary
  const d = dayNo_(row.fu_date);
  if (d === null) return '';
  return 'Next visit: ' + WEEKDAYS[(d + 4) % 7] + ' ' + isoFromDay_(d).split('-').reverse().join('-') + (str_(row.fu_for) ? ' (' + str_(row.fu_for) + ')' : '');
}
// A Pakistani mobile as WhatsApp wants it: 0300 1234567 -> 923001234567
function waNumber_(phone) { const d = str_(phone).replace(/\D/g, ''); return /^03\d{9}$/.test(d) ? '92' + d.slice(1) : /^923\d{9}$/.test(d) ? d : /^3\d{9}$/.test(d) ? '92' + d : ''; }
function fuReminder_(row) {
  const d = dayNo_(row.fu_date);
  if (d === null) return '';
  const when = WEEKDAYS[(d + 4) % 7] + ' ' + isoFromDay_(d).split('-').reverse().join('-');
  return 'Bari Hospital: ' + (str_(row.name) || 'Dear patient') + ', your follow-up' + (str_(row.fu_for) ? ' (' + str_(row.fu_for) + ')' : '') + ' is on ' + when + ' in the OPD, 73-G Gulberg III, Lahore.' +
    ' To change the day, call ' + CFG.HOSPITAL.phone.replace(/^Ph: /, '') + '.' +
    '\n\u0628\u0627\u0631\u06cc \u06c1\u0633\u067e\u062a\u0627\u0644: \u0622\u067e \u06a9\u0627 \u0686\u06cc\u06a9 \u0627\u067e ' + isoFromDay_(d).split('-').reverse().join('-') + ' \u06a9\u0648 \u06c1\u06d2\u06d4 \u062f\u0646 \u0628\u062f\u0644\u0646\u06d2 \u06a9\u06d2 \u0644\u06cc\u06d2 \u0641\u0648\u0646 \u06a9\u0631\u06cc\u06ba: ' + CFG.HOSPITAL.phone.replace(/^Ph: /, '');
}

// ---------------------------------------------------------------- verification (shared with the phone)
// Every final summary carries a QR code. Scanning it opens the hospital's verification page, which asks the workbook whether the summary
// is real and still current. The QR holds no patient data: only a random code (finding the summary) and a fingerprint of what was printed.
// The fingerprint covers every printed clinical field (not the follow-up, which changes as visits happen), so a copy printed before an
// amendment shows as out of date. The page shows only the details needed to compare with the paper (VERIFY_SHOW).
const VERIFY_PAGE = 'https://ir1s-vir1s.github.io/bari-discharge/v.html';
const VERIFY_SHOW = ['name', 'father_husband', 'age', 'admit_date', 'op_date', 'discharge_date', 'consultant', 'final_diagnoses'];
const FP_KEYS = DCOLS.filter(function (c) { return c.type !== 'sys' && c.type !== 'vcode' && FU_KEYS.indexOf(c.key) < 0 && c.key !== 'mo_name'; }).map(function (c) { return c.key; });
function printedText_(row) { return FP_KEYS.map(function (k) { return k + '=' + str_(row[k]).replace(/\r\n?/g, '\n').toUpperCase().replace(/\s+/g, ' '); }).join('\u001f'); }
function vcodeShow_(c) { return str_(c).toUpperCase().replace(/(.{4})(?=.)/g, '$1-'); }       // 3F9A-01C2-77DE-B410
function verifyUrl_(api, row, fp) { const m = /\/macros\/s\/([\w-]+)\/exec/.exec(str_(api)); return m && str_(row.vcode) ? VERIFY_PAGE + '#' + m[1] + '.' + row.vcode + '.' + fp : ''; }

// ---------------------------------------------------------------- certificate wording (shared with the phone)
// Who may delete a summary: the PI any; a consultant any draft; a medical officer only a draft they wrote.
function canDelete_(role, row, me) { return role === 'pi' || (str_(row.status) !== 'F' && (role === 'consultant' || !str_(row.ds_no) || str_(row.created_by) === str_(me))); }
function codeLabel2_(list, v) { const p = list.filter(function (x) { return x[0] === code_(v); })[0]; return p ? p[1] : str_(v); }
function dmy_(iso) { return str_(iso).split('-').reverse().join('-'); }
function certDays_(c) { const a = dayNo_(c.from_date), b = dayNo_(c.to_date); return a !== null && b !== null ? b - a + 1 : 0; }
// The certificate's body as paragraphs. Diagnosis appears only when the patient agreed (show_dx Y).
const TITLES = ['Mrs', 'Ms', 'Mr', 'Miss', 'Master'];
const WALKIN_BEFORE = 3;                                   // a walk-in certificate may cover at most 3 days before the examination
function certIsWalkin_(c) { return !str_(c.ds_uid); }
function certPron_(c) { const m = /^(Mr|Master)$/.test(str_(c.title)); return { she: m ? 'he' : 'she', She: m ? 'He' : 'She', her: m ? 'his' : 'her', him: m ? 'him' : 'her' }; }
// The certificate's body as paragraphs. Diagnosis appears only when the patient agreed (show_dx Y).
function certText_(c) {
  const t = code_(c.ctype), P = certPron_(c), tl = str_(c.title) || 'Mrs', who = tl + ' ' + str_(c.patient);
  const rel = str_(c.guardian) ? (/^(Mr|Master)$/.test(tl) ? ', son of ' : /^(Ms|Miss)$/.test(tl) ? ', daughter of ' : ', wife of ') + str_(c.guardian) : '';
  const age = str_(c.age) ? ', aged ' + str_(c.age) + (/\d$/.test(str_(c.age)) ? ' years' : '') : '';
  const walk = certIsWalkin_(c);
  const stay = walk ? 'was examined by me at Bari Hospital on ' + dmy_(c.exam_date) : 'was admitted to Bari Hospital on ' + dmy_(c.admit_date) + ' and discharged on ' + dmy_(c.discharge_date);
  const birth = str_(c.birth_date) ? ' She gave birth on ' + dmy_(c.birth_date) + '.' : '';
  const dx = code_(c.show_dx) === 'Y' && str_(c.dx) ? str_(c.dx) : 'a medical condition';
  const doing = code_(c.purpose) === 'S' ? 'attend ' + P.her + ' studies' : 'attend ' + P.her + ' duties';
  const n = certDays_(c), per = 'from ' + dmy_(c.from_date) + ' to ' + dmy_(c.to_date) + ' (' + n + ' day' + (n === 1 ? '' : 's') + ')';
  const resume = dayNo_(c.to_date) !== null ? isoFromDay_(dayNo_(c.to_date) + 1) : '';
  const since = walk ? dayNo_(c.exam_date) : dayNo_(c.issued_on);
  const out = [];
  if (t === 'A') {
    out.push('This is to certify that ' + str_(c.attendant) + (str_(c.relation) ? ' (' + str_(c.relation).toLowerCase() + ' of the patient)' : '') + ' stayed with ' + who + rel + age + ' as ' + P.her + ' attendant while ' + P.she + ' was in Bari Hospital, ' + per + '.' + (str_(c.birth_date) && /husband/i.test(c.relation) ? ' His wife gave birth on ' + dmy_(c.birth_date) + '.' : ''));
    out.push((/husband|father|brother|son/i.test(c.relation) ? 'His' : 'Her') + ' presence was needed to look after the patient during this period.');
  } else {
    out.push('This is to certify that ' + who + rel + age + (rel || age ? ', ' : ' ') + stay + '.' + birth + (!walk && str_(c.exam_date) ? ' I examined ' + P.him + ' on ' + dmy_(c.exam_date) + '.' : ''));
    if (t === 'R') out.push('In my opinion ' + P.she + ' ' + (dayNo_(c.from_date) < since ? 'was, and is,' : 'is') + ' unfit to ' + doing + ' owing to ' + dx + ', ' + per + '. ' + P.She + ' may resume on ' + dmy_(resume) + '.');
    if (t === 'M') out.push('Maternity leave is recommended ' + per + '. She may resume on ' + dmy_(resume) + '.');
    if (t === 'F') out.push(P.She + ' has recovered' + (code_(c.show_dx) === 'Y' && str_(c.dx) ? ' from ' + str_(c.dx) : '') + ' and is fit to ' + doing.replace('attend', 'resume') + ' from ' + dmy_(c.from_date) + '.');
  }
  if (str_(c.advice)) out.push('Advice: ' + str_(c.advice).split('\n').map(function (x) { return str_(x).replace(/\.$/, ''); }).filter(function (x) { return x; }).join('; ') + '.');
  if (t !== 'F' && dayNo_(c.from_date) !== null && since !== null && dayNo_(c.from_date) < since) out.push(walk ? 'The days before ' + dmy_(c.exam_date) + ' are certified from the history ' + P.she + ' gave and my examination.' : 'The days before the date of this certificate are certified from the hospital record of ' + P.her + ' admission.');
  return out;
}
function certProblems_(c) {
  const t = code_(c.ctype), a = dayNo_(c.from_date), b = dayNo_(c.to_date), ad = dayNo_(c.admit_date), dc = dayNo_(c.discharge_date), is = dayNo_(c.issued_on), ex = dayNo_(c.exam_date), walk = certIsWalkin_(c);
  if (!CTYPES.some(function (x) { return x[0] === t; })) return 'choose the kind of certificate';
  if (walk) {
    if (str_(c.patient).length < 3) return 'enter the patient’s name';
    if (TITLES.indexOf(str_(c.title)) < 0) return 'choose Mrs, Ms, Mr, Miss or Master';
    if (str_(c.age) && validateValue_(colOf_('age'), c.age)) return 'age: a number, optionally followed by years or months';
    if (t === 'A') return 'an attendant certificate needs a hospital stay: issue it from the discharge summary';
    if (t === 'M' && /^(Mr|Master)$/.test(str_(c.title))) return 'maternity leave is for a mother';
    if (ex === null) return 'choose the date of examination';
    if (ex > is || ex < is - 30) return 'the examination must be within the last 30 days';
    if (str_(c.doctor).length < 3) return 'choose the consultant';
  }
  if (a === null) return t === 'F' ? 'choose the date of return' : 'choose the first day';
  if (t !== 'F' && (b === null || b < a)) return 'the last day must be on or after the first day';
  if (!walk && ad !== null && a < ad) return 'the certificate cannot start before the date of admission (' + dmy_(c.admit_date) + ')';
  if (walk && t !== 'F' && a < ex - WALKIN_BEFORE) return 'at most ' + WALKIN_BEFORE + ' days before the examination';
  if (walk && t === 'F' && a < ex) return 'fitness starts on or after the examination';
  if (t !== 'F' && certDays_(c) > CERT_MAX[t]) return 'at most ' + CERT_MAX[t] + ' days for this certificate';
  if (t === 'A' && dc !== null && b > dc) return 'an attendant certificate covers the stay in hospital only (to ' + dmy_(c.discharge_date) + ')';
  if (t === 'A' && str_(c.attendant).length < 3) return 'enter the attendant’s name';
  if (!walk && t === 'F' && dc !== null && a < dc) return 'fitness starts on or after the date of discharge';
  if (str_(c.exam_date) && (ex === null || ex > is)) return 'the date of examination cannot be after today';
  if (code_(c.show_dx) === 'Y' && !str_(c.dx)) return 'type the diagnosis to show, or leave it hidden';
  if (str_(c.advice).length > 400 || str_(c.addressed_to).length > 120 || str_(c.dx).length > 200 || str_(c.patient).length > 60 || str_(c.guardian).length > 60) return 'too long';
  return '';
}
function certPrinted_(c) { return [c.cert_no, c.ctype, c.patient, c.guardian, c.from_date, c.to_date, c.issued_on, c.doctor].concat(certText_(c)).map(str_).join('\u001f').toUpperCase(); }

// ---------------------------------------------------------------- roles (shared with the phone)
const ROLE_NAMES = { pi: 'PI', consultant: 'Consultant', mo: 'Medical officer' };
function roleCan_(role, what) {
  if (role === 'pi') return true;
  if (what === 'edit' || what === 'quickAdd') return role === 'consultant' || role === 'mo';
  if (what === 'finalise' || what === 'template' || what === 'certify') return role === 'consultant';
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
const MENU_ITEMS = [['PI: set up or repair', 'setup'], ['PI: check the audit trail', 'menuAuditCheck'], ['PI: manage users', 'menuUsers'], ['PI: invite a phone', 'menuInvite'], ['PI: revoke a phone', 'menuRevoke'],
  ['PI: approve all draft quick buttons', 'menuApproveQuick'], ['PI: clear all records and start over', 'menuReset']];
function onOpen() {                      // used only when this file is pasted on its own instead of the loader
  const m = SpreadsheetApp.getUi().createMenu(CFG.MENU);
  MENU_ITEMS.forEach(function (it) { m.addItem(it[0], it[1]); });
  m.addToUi();
}
// What the loader calls. Every entry point must be listed here.
const RELEASE_NOTE = 'audit trail (old and new values, hash-chained); delete a summary from the phone (kept in DELETED); menu item to clear test records and start over; medical certificates (sick, maternity, fitness, attendant), also for walk-in patients; QR verification of final summaries; follow-up calendar (next visit, patient mobile, missed and rebook, WhatsApp reminder)';   // shown by "PI: install update"
function exports_() {
  return { VERSION: CFG.VERSION, RELEASE_NOTE: RELEASE_NOTE, SCHEMA_VER: CFG.SCHEMA_VER, MENU: CFG.MENU, MENU_ITEMS: MENU_ITEMS,
    setup: setup, menuUsers: menuUsers, menuInvite: menuInvite, menuRevoke: menuRevoke, menuApproveQuick: menuApproveQuick, menuReset: menuReset, menuAuditCheck: menuAuditCheck, doGet: doGet, doPost: doPost };
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
  ['QUICK', 'TEMPLATES', 'STAFF', 'CERTIFICATES'].forEach(function (n) { const sh = ss.getSheetByName(n), c = { QUICK: QUICK_COLS, TEMPLATES: TEMPLATE_COLS, STAFF: STAFF_COLS, CERTIFICATES: CERT_COLS }[n]; if (sh && !headerOk_(sh, c)) rewriteTab_(sh, c); });
  const d = sheet_(ss, 'DISCHARGES', dk, { wide: SECTIONS });
  d.getRange(1, 1, 1, DCOLS.length).setNotes([DCOLS.map(function (c) { return c.label + (c.codes ? '\n' + c.codes.map(function (p) { return p[0] + ' = ' + p[1]; }).join('\n') : ''); })]);
  const q = sheet_(ss, 'QUICK', QUICK_COLS, { wide: ['phrase'] });
  seedQuick_(q);
  q.getRange(1, 1, 1, QUICK_COLS.length).setNotes([['Made by the system', 'Which section the button belongs to: ' + SECTIONS.join(', '), 'A heading that groups buttons inside a section',
    'N = new line, S = same line, C = same line after a comma', 'The text the button inserts. ___ marks a blank the doctor fills in', 'draft = PI phone only until approved; live = everyone', '', '', 'D or H: shown only when the Diabetes or Hypertension box is ticked']]);
  sheet_(ss, 'CERTIFICATES', CERT_COLS, { wide: ['advice'] });
  const tp = sheet_(ss, 'TEMPLATES', TEMPLATE_COLS, { wide: SECTIONS });
  seedDefault_(tp); seedTemplates_(tp);
  const st = sheet_(ss, 'STAFF', STAFF_COLS);
  if (st.getLastRow() < 2) st.getRange(2, 1, SEED_STAFF.length, STAFF_COLS.length).setValues(SEED_STAFF);
  st.getRange(1, 1, 1, STAFF_COLS.length).setNotes([['Name as printed', 'consultant or mo', 'Printed under the name, e.g. Gynaecologist & Obstetrician', 'Degrees, e.g. MBBS, FCPS', 'Personal number printed on that consultant\u2019s summaries']]);
  followTab_(ss);
  backfillVcodes_(ss);
  verifyTab_(ss);
  const lg = sheet_(ss, 'LOG', ['at', 'user', 'action', 'ds_no', 'detail']);
  const au = sheet_(ss, 'AUDIT', AUDIT_COLS, { wide: ['old_value', 'new_value'] });
  try {                                                  // only the PI may edit the system tabs by hand
    [lg, au].forEach(function (sh) { const p = sh.protect().setDescription('system'); p.getEditors().forEach(function (u) { if ((u.getEmail() || '').toLowerCase() !== piEmail_()) p.removeEditor(u); }); });
  } catch (e) { /* protection is a convenience; the phones never depend on it */ }
  const s1 = ss.getSheetByName('Sheet1'); if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);
}
// The VERIFY tab records which web app answers the QR codes. The verification page trusts only that one, so a forger cannot point a
// copied QR at a look-alike web app of their own. Changing the deployment means adding the new one to the page (v.js, TRUSTED).
function verifyTab_(ss) {
  let sh = ss.getSheetByName('VERIFY');
  if (!sh) sh = ss.insertSheet('VERIFY');
  const m = /\/macros\/s\/([\w-]+)\/exec/.exec(props_().getProperty('API_URL') || '');
  sh.getRange(1, 1, 4, 2).setValues([['Verification page', VERIFY_PAGE], ['Web app deployment', m ? m[1] : '(made with the first invitation)'],
    ['What the page shows', VERIFY_SHOW.map(function (k) { return colOf_(k).label; }).join(', ')], ['Every scan', 'is written to LOG as "verify: valid / amended / withdrawn / not found"']]);
}
// Final summaries written before verification existed get a code, so their next printed copy carries a QR.
function backfillVcodes_(ss) {
  const sh = ss.getSheetByName('DISCHARGES'), keys = DCOLS.map(function (c) { return c.key; }), col = keys.indexOf('vcode') + 1;
  let n = 0;
  dRows_(ss).forEach(function (r) { if (r.status === 'F' && !str_(r.vcode)) { sh.getRange(r._row, col).setValue(randomHex_(16)); n++; } });
  return n;
}
// A live view of every open follow-up, soonest first. It reads DISCHARGES, so it never needs saving.
function colLetter_(i) { let s = '', n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function followTab_(ss) {
  let sh = ss.getSheetByName('FOLLOW_UPS');
  if (!sh) sh = ss.insertSheet('FOLLOW_UPS');
  const keys = DCOLS.map(function (c) { return c.key; }), L = function (k) { return colLetter_(keys.indexOf(k)); };
  const pick = ['fu_date', 'fu_for', 'fu_status', 'name', 'phone', 'ds_no', 'discharge_date', 'consultant', 'fu_note', 'fu_reminded'].map(L).join(', ');
  const last = colLetter_(keys.length - 1);
  sh.getRange(1, 1).setFormula('=QUERY(DISCHARGES!A:' + last + ', "select ' + pick + ' where ' + L('fu_date') + " <> '' and " + L('fu_status') + " <> 'A' and " + L('fu_status') + " <> 'X' order by " + L('fu_date') + '", 1)');
  sh.getRange(1, 12).setValue('Open follow-ups, soonest first (blank status = expected, M = missed). Change them on the phone.');
  sh.setFrozenRows(1);
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
  audit_([{ user: user, action: action, record: ds, detail: detail }]);
}
// ---------------------------------------------------------------- audit trail
// Who, role, what, which record, which field, old and new value, when (the workbook's clock, not the phone's) and why.
// Each row carries a hash of its own content and the previous row's hash, so editing, inserting or deleting a row by hand breaks the
// chain from that point; "PI: check the audit trail" finds it. Rows are only ever added.
const AUDIT_COLS = ['seq', 'at', 'user', 'name', 'role', 'action', 'record', 'field', 'old_value', 'new_value', 'detail', 'hash'];
const AUDIT_MAX = 45000;                                              // a cell holds 50 000 characters
function auditHash_(prev, o) { return sha256_(prev + '\u001f' + AUDIT_COLS.slice(0, -1).map(function (k) { return String(o[k] === undefined ? '' : o[k]); }).join('\u001f')).slice(0, 24); }
function audit_(items) {
  try {
    const sh = ss_().getSheetByName('AUDIT');
    if (!sh || !items.length) return;
    let last = sh.getLastRow(), prev = 'START', seq = 0;
    if (last > 1) { const v = sh.getRange(last, 1, 1, AUDIT_COLS.length).getValues()[0]; seq = Number(v[0]) || 0; prev = String(v[AUDIT_COLS.length - 1]); }
    const at = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    const rows = items.map(function (it) {
      const o = { seq: ++seq, at: at, user: str_(it.user).toLowerCase(), name: str_(it.name).slice(0, 60), role: it.role || (it.user ? ROLE_NAMES[roleOf_(it.user)] || '' : ''), action: str_(it.action), record: str_(it.record),
        field: str_(it.field), old_value: String(it.old === undefined ? '' : it.old).slice(0, AUDIT_MAX), new_value: String(it.new === undefined ? '' : it.new).slice(0, AUDIT_MAX), detail: String(it.detail === undefined ? '' : it.detail).slice(0, 2000) };
      o.hash = auditHash_(prev, o); prev = o.hash;
      return AUDIT_COLS.map(function (k) { return o[k]; });
    });
    sh.getRange(last + 1, 1, rows.length, AUDIT_COLS.length).setValues(rows);
  } catch (e) { console.error('audit: ' + e); }
}
function auditCheck_() {
  const sh = ss_().getSheetByName('AUDIT');
  if (!sh || sh.getLastRow() < 2) return { ok: true, n: 0 };
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, AUDIT_COLS.length).getValues();
  let prev = 'START';
  for (let i = 0; i < v.length; i++) {
    const o = {}; AUDIT_COLS.forEach(function (k, j) { o[k] = cellTxt_(v[i][j]); });
    if (Number(o.seq) !== i + 1 || auditHash_(prev, o) !== o.hash) return { ok: false, n: v.length, row: i + 2, seq: o.seq };
    prev = o.hash;
  }
  return { ok: true, n: v.length };
}
function menuAuditCheck() {
  requirePI_();
  const r = auditCheck_(), ui = SpreadsheetApp.getUi();
  if (r.ok) ui.alert('Audit trail intact', r.n + ' entr' + (r.n === 1 ? 'y' : 'ies') + ' checked. None has been edited, inserted or removed by hand.', ui.ButtonSet.OK);
  else ui.alert('Audit trail altered', 'Row ' + r.row + ' of the AUDIT tab (entry ' + r.seq + ') does not match the chain: it, or a row before it, was edited, inserted or removed by hand. Entries before row ' + r.row + ' are intact.', ui.ButtonSet.OK);
  logIt_(me_(), 'audit trail checked', '', r.ok ? 'intact, ' + r.n + ' entries' : 'altered at row ' + r.row);
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
// Clears every summary, certificate and log line after a test run, so numbering starts again at BH-0001 and MC-0001.
// A full copy of the whole spreadsheet is saved in Drive first. Users, invited phones, STAFF and (unless the PI asks) buttons and templates stay.
// Phones learn of the reset at their next sync and drop anything not yet sent, so test entries cannot come back.
function menuReset() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), ss = SpreadsheetApp.getActive();
  const n = Math.max(0, ss.getSheetByName('DISCHARGES').getLastRow() - 1), c = ss.getSheetByName('CERTIFICATES') ? Math.max(0, ss.getSheetByName('CERTIFICATES').getLastRow() - 1) : 0;
  const a = ui.prompt('Clear all records and start over?', 'This deletes ' + n + ' discharge summar' + (n === 1 ? 'y' : 'ies') + ', ' + c + ' certificate' + (c === 1 ? '' : 's') + ', the LOG and old backup tabs. Numbering starts again at ' + CFG.DS_PREFIX + '0001 and MC-0001.\n\n' +
    'A full copy of this spreadsheet is saved in your Google Drive first. Users, invited phones and STAFF are kept. Phones drop anything they have not sent.\n\nType START OVER to continue:', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK || a.getResponseText().trim().toUpperCase() !== 'START OVER') { ui.alert('Nothing was changed', 'The records are as they were.', ui.ButtonSet.OK); return; }
  const fresh = ui.alert('Buttons and templates', 'Also put the quick buttons and templates back to the starter set?\n\nOK: yes, starter set (buttons people added and templates saved during the test go).\nCancel: keep them as they are.', ui.ButtonSet.OK_CANCEL) === ui.Button.OK;
  const stamp = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HHmm');
  let copy;
  try { copy = ss.copy(ss.getName() + ' (backup before reset ' + stamp + ')'); } catch (e) { ui.alert('Nothing was changed', 'The backup copy could not be made (' + e.message + '), so nothing was deleted.', ui.ButtonSet.OK); return; }
  const r = withLock_(function () { return resetAll_(ss, fresh); });
  props_().setProperty('RESET_AT', stamp + ' ' + randomHex_(6));
  logIt_(me_(), 'records cleared', '', r + '; backup copy: ' + copy.getName());
  ui.alert('Started over', r + '.\n\nThe backup copy is in your Google Drive as "' + copy.getName() + '". Phones clear their test entries at their next sync.', ui.ButtonSet.OK);
}
function resetAll_(ss, fresh) {
  const clear = function (name) { const sh = ss.getSheetByName(name), n = sh ? sh.getLastRow() - 1 : 0; if (n > 0) sh.deleteRows(2, n); return Math.max(0, n); };
  const n = clear('DISCHARGES'), c = clear('CERTIFICATES'); clear('LOG'); clear('DELETED'); clear('AUDIT');
  let b = 0;
  ss.getSheets().slice().forEach(function (sh) { if (/^DISCHARGES_backup /.test(sh.getName())) { ss.deleteSheet(sh); b++; } });
  if (fresh) {
    clear('QUICK'); clear('TEMPLATES');
    props_().deleteProperty('SEED_VER'); props_().deleteProperty('TPL_SEED_VER');
    buildAll_(ss);
  }
  return n + ' summar' + (n === 1 ? 'y' : 'ies') + ' and ' + c + ' certificate' + (c === 1 ? '' : 's') + ' deleted' + (b ? ', ' + b + ' old backup tab' + (b === 1 ? '' : 's') + ' removed' : '') + (fresh ? ', buttons and templates back to the starter set' : '');
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
    if (req.op === 'verify') return appJson_(appVerify_(req));
    const u = appUser_(req.token);
    if (!u) return appJson_({ ok: false, error: 'not authorised', code: 401 });
    if (req.op === 'hello') return appJson_({ ok: true, schema: wbSchema_(), version: CFG.VERSION, reset: props_().getProperty('RESET_AT') || '' });
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
    if (req.op === 'cert_issue') return appJson_(certIssue_(u, req));
    if (req.op === 'cert_withdraw') return appJson_(certWithdraw_(u, req));
    if (req.op === 'record_delete') return appJson_(recordDelete_(u, req));
    if (req.op === 'invite') return appJson_(appInvite_(u, req));
    return appJson_({ ok: false, error: 'unknown operation' });
  } catch (err) {
    console.error('doPost: ' + (err && err.stack ? err.stack : err));
    return appJson_({ ok: false, error: 'server error: ' + (err && err.message ? err.message : err) });
  }
}
function withLock_(fn) { const l = LockService.getScriptLock(); l.waitLock(20000); try { return fn(); } finally { l.releaseLock(); } }

// Anyone holding the paper can ask; no account. Only what is needed to compare with the paper comes back, and only for a code that exists.
function appVerify_(req) {
  const code = str_(req.code).toLowerCase(), fp = str_(req.fp).toUpperCase();
  if (!/^[0-9a-f]{16}$/.test(code)) return { ok: true, state: 'unknown' };
  const H = CFG.HOSPITAL, base = { ok: true, hospital: H.name, address: H.address, phone: H.phone, code: vcodeShow_(code) };
  const c = certRows_().filter(function (x) { return str_(x.vcode) === code; })[0];
  if (c) {
    const now = sha256_(certPrinted_(c)).slice(0, 8).toUpperCase(), cs = c.status === 'W' ? 'withdrawn' : fp && fp !== now ? 'amended' : 'valid';
    logIt_('', 'verify certificate: ' + cs, c.cert_no, '');
    const o = Object.assign(base, { state: cs, kind: 'certificate', what: codeLabel2_(CTYPES, c.ctype).toLowerCase() + ' certificate', ds_no: c.cert_no, finalised_on: c.issued_on, fp: now });
    if (cs !== 'withdrawn') o.details = [['Certificate', CTITLE[c.ctype] ? CTITLE[c.ctype].charAt(0) + CTITLE[c.ctype].slice(1).toLowerCase() : ''], ['Patient', (c.title ? c.title + ' ' : '') + c.patient + (c.age ? ', ' + c.age : '')], [/^(Mr|Master|Ms|Miss)$/.test(c.title) ? 'Father’s name' : 'Husband’s / Father’s name', c.guardian], c.ds_uid ? null : ['Seen as', 'Outpatient (walk-in) on ' + dmy_(c.exam_date)],
      c.ctype === 'A' ? ['Attendant', c.attendant + (c.relation ? ' (' + c.relation + ')' : '')] : null, c.ctype === 'F' ? ['Fit to resume from', dmy_(c.from_date)] : ['Period', dmy_(c.from_date) + ' to ' + dmy_(c.to_date) + ' (' + certDays_(c) + ' days)'],
      c.ctype === 'R' || c.ctype === 'M' ? ['May resume on', dmy_(isoFromDay_(dayNo_(c.to_date) + 1))] : null, ['For', codeLabel2_(PURPOSES, c.purpose)], c.addressed_to ? ['Addressed to', c.addressed_to] : null,
      ['Issued on', dmy_(c.issued_on)], ['Doctor', c.doctor], c.show_dx === 'Y' ? ['Diagnosis', c.dx] : null].filter(function (p) { return p && p[1]; });
    else o.reason = c.withdraw_reason;
    return o;
  }
  const r = dRows_(ss_()).filter(function (x) { return str_(x.vcode) === code; })[0];
  if (!r) { logIt_('', 'verify: not found', '', code.slice(0, 4)); return Object.assign(base, { state: 'unknown' }); }
  const now = sha256_(printedText_(r)).slice(0, 8).toUpperCase();
  const state = r.status !== 'F' ? 'withdrawn' : fp && fp !== now ? 'amended' : 'valid';
  logIt_('', 'verify: ' + state, r.ds_no, '');
  const out = Object.assign(base, { state: state, kind: 'summary', what: 'discharge summary', ds_no: r.ds_no, finalised_on: str_(r.finalised_at).slice(0, 10), fp: now });
  if (state !== 'withdrawn') { out.details = VERIFY_SHOW.map(function (k) { const c = colOf_(k); return [c.label, c.type === 'date' ? str_(r[k]).split('-').reverse().join('-') : str_(r[k])]; }).filter(function (p) { return p[1]; }); out.gp = gpLine_(r); }
  return out;
}

function certRows_() { const sh = ss_().getSheetByName('CERTIFICATES'); return sh ? readRows_(sh, CERT_COLS).filter(function (c) { return c.cert_no; }).map(function (c) { delete c._row; return c; }) : []; }
// Issued online, once. The patient's details come from the final summary in the workbook, never from the phone.
function certIssue_(u, req) {
  if (!roleCan_(u.role, 'certify')) return { ok: false, error: 'only a consultant can issue certificates' };
  const v = req.values || {}, cuid = str_(req.cuid);
  if (!/^[0-9a-f]{24}$/.test(cuid)) return { ok: false, error: 'bad request' };
  return withLock_(function () {
    const ss = ss_(), sh = ss.getSheetByName('CERTIFICATES'), all = readRows_(sh, CERT_COLS);
    const again = all.filter(function (c) { return c.cuid === cuid; })[0];
    if (again) { delete again._row; return { ok: true, cert: again, already: true }; }                   // a retry after a lost answer
    const walk = !str_(v.ds_uid), t = code_(v.ctype);
    let c;
    if (walk) {                                          // a walk-in (outpatient) certificate: details typed on the phone, checked here
      const cons = readRows_(ss.getSheetByName('STAFF'), STAFF_COLS).filter(function (x) { return x.role.toLowerCase() !== 'mo' && x.name; }), key = function (n) { return str_(n).toLowerCase().replace(/^dr\.?\s*/, '').replace(/[^a-z]/g, ''); };
      const doc = cons.filter(function (x) { return key(x.name) === key(v.doctor); })[0];
      if (!doc) return { ok: false, error: 'choose a consultant from the STAFF list' };
      c = { cuid: cuid, ds_uid: '', ds_no: '', ctype: t, purpose: code_(v.purpose) === 'S' ? 'S' : 'W', addressed_to: str_(v.addressed_to), patient: str_(v.patient).replace(/\s+/g, ' '), title: str_(v.title), guardian: str_(v.guardian).replace(/\s+/g, ' '), age: str_(v.age),
        admit_date: '', discharge_date: '', birth_date: t === 'M' && dayNo_(v.birth_date) !== null ? str_(v.birth_date) : '', attendant: '', relation: '', from_date: str_(v.from_date), to_date: t === 'F' ? str_(v.from_date) : str_(v.to_date), exam_date: str_(v.exam_date),
        issued_on: todayIso_(), show_dx: code_(v.show_dx) === 'Y' ? 'Y' : 'N', dx: code_(v.show_dx) === 'Y' ? str_(v.dx) : '', advice: str_(v.advice), doctor: doc.name, status: 'I' };
    } else {
    const r = dRows_(ss).filter(function (x) { return x.uid === str_(v.ds_uid); })[0];
    if (!r) return { ok: false, error: 'that summary is not in the workbook yet; sync first' };
    if (r.status !== 'F') return { ok: false, error: 'certificates are issued from final summaries only' };
    const doc = str_(r.consultant) || str_(req.by);
    c = { cuid: cuid, ds_uid: r.uid, ds_no: r.ds_no, ctype: t, purpose: code_(v.purpose) === 'S' ? 'S' : 'W', addressed_to: str_(v.addressed_to), patient: r.name, title: code_(r.marital) === 'S' ? 'Ms' : 'Mrs', guardian: r.father_husband, age: r.age,
      admit_date: r.admit_date, discharge_date: r.discharge_date, birth_date: /deliver|caesarean|birth/i.test(r.final_diagnoses + ' ' + r.course) ? r.op_date : '',
      attendant: t === 'A' ? str_(v.attendant) : '', relation: t === 'A' ? str_(v.relation) : '', from_date: str_(v.from_date), to_date: t === 'F' ? str_(v.from_date) : str_(v.to_date), exam_date: str_(v.exam_date),
      issued_on: todayIso_(), show_dx: code_(v.show_dx) === 'Y' && t !== 'A' ? 'Y' : 'N', dx: code_(v.show_dx) === 'Y' && t !== 'A' ? str_(v.dx) : '', advice: t === 'A' ? '' : str_(v.advice), doctor: doc, status: 'I' };
    }
    const bad = certProblems_(c);
    if (bad) return { ok: false, error: bad };
    const top = all.reduce(function (m, x) { const k = /^MC-(\d+)$/.exec(x.cert_no); return k ? Math.max(m, +k[1]) : m; }, 0);
    c.cert_no = 'MC-' + ('000' + (top + 1)).slice(-Math.max(4, String(top + 1).length));
    c.vcode = randomHex_(16); c.issued_by = str_(req.by).slice(0, 60) || u.email; c.issued_at = nowTxt_();
    writeRow_(sh, CERT_COLS, sh.getLastRow() + 1, c);
    logIt_(u.email, 'certificate issued', c.ds_no || 'walk-in', c.cert_no + ' ' + codeLabel2_(CTYPES, t));
    return { ok: true, cert: c };
  });
}
function certWithdraw_(u, req) {
  if (!roleCan_(u.role, 'certify')) return { ok: false, error: 'only a consultant can withdraw certificates' };
  const why = str_(req.reason).slice(0, 120);
  if (why.length < 3) return { ok: false, error: 'give the reason' };
  return withLock_(function () {
    const sh = ss_().getSheetByName('CERTIFICATES'), c = readRows_(sh, CERT_COLS).filter(function (x) { return x.cert_no === str_(req.cert_no); })[0];
    if (!c) return { ok: false, error: 'no such certificate' };
    if (c.status === 'W') return { ok: true, already: true };
    c.status = 'W'; c.withdrawn_by = str_(req.by).slice(0, 60) || u.email; c.withdrawn_at = nowTxt_(); c.withdraw_reason = why;
    writeRow_(sh, CERT_COLS, c._row, c);
    logIt_(u.email, 'certificate withdrawn', c.ds_no, c.cert_no + ': ' + why);
    delete c._row;
    return { ok: true, cert: c };
  });
}

// Deleting moves the row to the DELETED tab (with who, when and why), so nothing is lost by a wrong tap; the PI can copy it back by hand.
// A summary with certificates still in force is not deleted: withdraw them first.
function recordDelete_(u, req) {
  const uid = str_(req.uid), why = str_(req.reason).slice(0, 120);
  if (!/^[0-9a-f]{24}$/.test(uid)) return { ok: false, error: 'bad request' };
  if (why.length < 3) return { ok: false, error: 'give the reason' };
  return withLock_(function () {
    const ss = ss_(), sh = ss.getSheetByName('DISCHARGES'), r = dRows_(ss).filter(function (x) { return x.uid === uid; })[0];
    if (!r) return { ok: true, gone: true };                                              // already gone: the phone just forgets it
    const by = str_(req.by).slice(0, 60) || u.email;
    if (u.role !== 'pi' && (r.status === 'F' || (u.role !== 'consultant' && r.created_by !== by && r.created_by !== u.email))) return { ok: false, error: r.status === 'F' ? 'only the PI can delete a final summary' : 'only its author, a consultant or the PI can delete this draft' };
    if (certRows_().some(function (c) { return c.ds_uid === uid && c.status !== 'W'; })) return { ok: false, error: 'this summary has certificates in force; withdraw them first' };
    const cols = DCOLS.map(function (c) { return c.key; }).concat(['deleted_by', 'deleted_at', 'deleted_why']);
    const del = sheet_(ss, 'DELETED', cols);
    r.deleted_by = by; r.deleted_at = nowTxt_(); r.deleted_why = why;
    writeRow_(del, cols, del.getLastRow() + 1, r);
    sh.deleteRow(r._row);
    try { ss.getSheetByName('LOG').appendRow([nowTxt_(), u.email, 'deleted', r.ds_no, why]); } catch (e) { console.error('log: ' + e); }
    audit_([{ user: u.email, name: by, role: ROLE_NAMES[u.role], action: 'deleted', record: r.ds_no, field: '(whole summary)', old: JSON.stringify(Object.keys(r).filter(function (k) { return k[0] !== '_' && str_(r[k]); }).reduce(function (o, k) { o[k] = r[k]; return o; }, {})), new: '', detail: why }]);
    return { ok: true, ds_no: r.ds_no };
  });
}

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
  return { ok: true, token: token, email: inv.email, role: role, reset: P.getProperty('RESET_AT') || '' };
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
    if (['missed', 'overdue', 'today', 'soon', 'later'].indexOf(fuState_(r, today)) >= 0) return true;   // and every open follow-up, however old
    const d = dayNo_(r.discharge_date) || dayNo_(String(r.updated_at).slice(0, 10));
    return d === null || today - d <= CFG.PULL_DAYS;
  }).map(function (r) { delete r._row; return r; });
  const quick = quickRows_().filter(function (q) { return q.phrase && SECTIONS.indexOf(q.section) >= 0 && (u.role === 'pi' || q.status.toLowerCase() === 'live'); })
    .map(function (q) { return { qid: q.qid, section: q.section, group: q.group, join: code_(q.join) || 'N', phrase: q.phrase, draft: q.status.toLowerCase() !== 'live', needs: code_(q.needs) }; });
  const templates = readRows_(ss.getSheetByName('TEMPLATES'), TEMPLATE_COLS).filter(function (t) { return t.name; }).map(function (t) { delete t._row; return t; });
  const staff = readRows_(ss.getSheetByName('STAFF'), STAFF_COLS).filter(function (s) { return s.name; }).map(function (s) { return { name: s.name, role: s.role.toLowerCase() === 'mo' ? 'mo' : 'consultant', specialty: s.specialty, qualifications: s.qualifications, phone: s.phone }; });
  const have = {}; rows.forEach(function (r) { have[r.uid] = true; });
  const certs = certRows_().filter(function (c) { return c.ds_uid ? have[c.ds_uid] : today - (dayNo_(c.issued_on) || 0) <= CFG.PULL_DAYS; });
  return { ok: true, email: u.email, role: u.role, roleName: ROLE_NAMES[u.role], version: CFG.VERSION, schema: CFG.SCHEMA_VER, today: todayIso_(), rows: rows, quick: quick, templates: templates, staff: staff, certs: certs };
}
function appSearch_(u, req) {
  const q = str_(req.q).toLowerCase();
  if (q.length < 2) return { ok: false, error: 'type at least 2 letters' };
  const vq = /^[0-9a-f]{4}(-?[0-9a-f]{4}){1,3}$/.test(q) ? q.replace(/-/g, '') : '';      // a verification code read out over the phone
  const rows = dRows_(ss_()).filter(function (r) { return (r.name + ' ' + r.father_husband + ' ' + r.ds_no).toLowerCase().indexOf(q) >= 0 || (vq.length >= 8 && str_(r.vcode).indexOf(vq) === 0); })
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
        if (str_(next.vcode) && rows.some(function (x) { return x.uid !== uid && str_(x.vcode) === str_(next.vcode); })) throw new Error('verification code already in use; finalise again');
        const fuOnly = before && keys.every(function (k) { return FU_KEYS.indexOf(k) >= 0 || k === 'fu_log' || str_(before[k]) === str_(next[k]); });
        if (before && before.status === 'F' && !fuOnly && !roleCan_(u.role, 'finalise')) throw new Error('this summary is final; only a consultant can change it (follow-up details can still be changed)');
        if (next.status === 'F' && (!before || before.status !== 'F') && !roleCan_(u.role, 'finalise')) throw new Error('only a consultant can finalise');
        if (before && str_(before.vcode) && str_(next.vcode) !== str_(before.vcode)) throw new Error('the verification code of a summary cannot change');
        if (next.status === 'F' && !str_(next.vcode)) next.vcode = randomHex_(16);
        const probs = rowProblems_(next);
        if (probs.length) throw new Error(probs.join('; '));
        if (next.status === 'F') { const g = finalGaps_(next); if (g.length) throw new Error('to finalise, fill in: ' + g.join(', ')); }
        if (!str_(next.name)) throw new Error('the patient’s name is needed');
        const changed = keys.filter(function (k) { return !before || str_(before[k]) !== str_(next[k]); });
        if (!isNew && changed.length === 0) { res.status = 'ok'; res.ds_no = row.ds_no; results.push(res); return; }   // a retry of a change already saved
        const at = nowTxt_(), by = str_(ch.by).slice(0, 60) || u.email;
        next.updated_by = by; next.updated_at = at;
        const fuMsg = fuChange_(before || {}, next);
        if (fuMsg) next.fu_log = (str_(next.fu_log) ? str_(next.fu_log) + '\n' : '') + at.slice(0, 10) + ' ' + by + ': ' + fuMsg;
        if (str_(next.fu_log).length > 2000) next.fu_log = str_(next.fu_log).slice(-2000).replace(/^[^\n]*\n/, '');
        if (isNew) { next.ds_no = nextDs_(rows); next.created_by = by; next.created_at = at; }
        if (next.status === 'F' && (!before || before.status !== 'F')) { next.finalised_by = by; next.finalised_at = at; }
        if (next.status === 'D') { next.finalised_by = ''; next.finalised_at = ''; }
        if (isNew) { const r = sh.getLastRow() + 1; writeRow_(sh, keys, r, next); next._row = r; rows.push(next); }
        else { writeRow_(sh, keys, row._row, next); next._row = row._row; rows[rows.indexOf(row)] = next; }
        const act = isNew ? 'created' : next.status === 'F' && before.status !== 'F' ? 'finalised' : before && before.status === 'F' && next.status === 'D' ? 'reopened' : 'changed';
        try { ss.getSheetByName('LOG').appendRow([nowTxt_(), u.email, act, next.ds_no, changed.join(', ').slice(0, 500)]); } catch (e) { console.error('log: ' + e); }
        audit_(changed.filter(function (k) { return ['updated_by', 'updated_at', 'created_by', 'created_at', 'finalised_by', 'finalised_at'].indexOf(k) < 0; })
          .map(function (k) { return { user: u.email, name: by, role: ROLE_NAMES[u.role], action: act, record: next.ds_no, field: k, old: before ? str_(before[k]) : '', new: str_(next[k]), detail: str_(ch.reason) }; }));
        res.status = 'ok'; res.ds_no = next.ds_no;
      } catch (err) { res.status = 'refused'; res.errors = [String(err.message || err)]; }
      results.push(res);
    });
    return { ok: true, results: results };
  });
}

// One line for the follow-up history, written by the workbook (never by a phone) so it can be trusted.
function fuChange_(a, b) {
  const out = [], lab = function (k, v) { return codeLabel_(k, v).toLowerCase(); };
  if (str_(a.fu_date) !== str_(b.fu_date)) out.push(str_(b.fu_date) ? (str_(a.fu_date) ? 'moved to ' : 'booked for ') + str_(b.fu_date) + (str_(b.fu_for) ? ' (' + str_(b.fu_for) + ')' : '') : 'follow-up removed');
  else if (str_(a.fu_for) !== str_(b.fu_for) && str_(b.fu_date)) out.push('reason now ' + str_(b.fu_for));
  if (code_(a.fu_status) !== code_(b.fu_status)) out.push(code_(b.fu_status) ? lab('fu_status', b.fu_status) + (str_(a.fu_date) && str_(a.fu_date) === str_(b.fu_date) ? ' on ' + str_(b.fu_date) : '') : 'expected again');
  if (str_(a.fu_reminded) !== str_(b.fu_reminded) && str_(b.fu_reminded)) out.push('reminder sent');
  if (str_(a.fu_note) !== str_(b.fu_note) && str_(b.fu_note)) out.push('note: ' + str_(b.fu_note));
  return out.join('; ');
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
