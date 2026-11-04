/* Bari Hospital discharge summary verification. The QR on a final summary opens this page with
 * #<web app deployment>.<code>.<fingerprint>. The page asks only the hospital's own web app (v-trust.js),
 * which answers valid, amended (the paper is an older version), withdrawn (reopened) or unknown. */
'use strict';
(function () {
  const out = document.getElementById('out');
  const el = (tag, cls, ...kids) => { const e = document.createElement(tag); if (cls) e.className = cls; kids.forEach((k) => { if (k !== null && k !== undefined) e.append(k instanceof Node ? k : document.createTextNode(String(k))); }); return e; };
  const PHONE = '042 3583 4233';
  const show = (...nodes) => out.replaceChildren(...nodes);
  const call = el('p', 'small', 'To confirm by phone, call Bari Hospital on ', el('a', null, PHONE), ' and quote the verification code.');
  call.querySelector('a').href = 'tel:04235834233';
  const result = (cls, title, ...lines) => el('section', 'res ' + cls, el('h1', null, title), ...lines.map((l) => el('p', null, l)));
  const m = /^#([\w-]{3,120})\.([0-9a-f]{16})\.([0-9A-F]{8})$/.exec(location.hash);
  if (!m) {
    show(result('unknown', 'Scan the QR code on the summary', 'This page checks Bari Hospital discharge summaries. Open it by scanning the QR code printed at the bottom of a final summary.'), call);
    return;
  }
  const dep = m[1], code = m[2], fp = m[3];
  if (!(window.BARI_TRUSTED || []).length) { show(result('fail', 'Verification is being switched on', 'Online checking of Bari Hospital summaries starts shortly. Until then, confirm by phone.'), call); return; }
  if ((window.BARI_TRUSTED || []).indexOf(dep) < 0) {
    show(result('fail', 'Not issued by Bari Hospital', 'This QR code points to a system that Bari Hospital does not use. Treat the document as unverified.'), call);
    return;
  }
  const ctl = new AbortController(); setTimeout(() => ctl.abort(), 30000);
  fetch('https://script.google.com/macros/s/' + dep + '/exec', { method: 'POST', body: JSON.stringify({ op: 'verify', code, fp }), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: ctl.signal })
    .then((r) => r.json())
    .then((d) => {
      if (!d || !d.ok) throw new Error('no answer');
      const codeLine = el('p', 'small', 'Verification code ', el('b', null, d.code || code.toUpperCase()));
      if (d.state === 'unknown') { show(result('unknown', 'Not found', 'Bari Hospital has no discharge summary or certificate with this code. The document may be forged or the QR code copied from another paper.'), codeLine, call); return; }
      const What = d.what ? d.what.charAt(0).toUpperCase() + d.what.slice(1) : 'Discharge summary';
      if (d.state === 'withdrawn' && d.kind === 'certificate') { show(result('withdrawn', 'Withdrawn', What + ' ' + d.ds_no + ' was withdrawn by the hospital' + (d.reason ? ' (' + d.reason.toLowerCase() + ')' : '') + '. It is not valid.'), codeLine, call); return; }
      if (d.state === 'withdrawn') { show(result('withdrawn', 'Withdrawn', 'Discharge summary ' + d.ds_no + ' was reopened for correction. This printed copy is not valid; ask the hospital for the corrected summary.'), codeLine, call); return; }
      const head = d.state === 'valid'
        ? result('valid', '✓ Genuine and current', What + ' ' + d.ds_no + ' was issued by Bari Hospital' + (d.finalised_on ? ' on ' + d.finalised_on.split('-').reverse().join('-') : '') + '. The paper matches the hospital’s record.')
        : d.kind === 'certificate' ? result('amended', 'Does not match the record', 'Bari Hospital issued ' + d.what + ' ' + d.ds_no + ', but this paper does not match it and may have been altered. Ask the hospital.')
        : result('amended', 'Genuine, but this copy is out of date', 'Discharge summary ' + d.ds_no + ' was issued by Bari Hospital, but it has been amended since this copy was printed. Ask the hospital for the current copy before relying on it.');
      const rows = (d.details || []).slice();
      if (d.gp) rows.splice(Math.min(3, rows.length), 0, ['Obstetric', d.gp]);
      const card = el('section', 'card', el('h2', null, 'Compare with the paper'), ...rows.map((p) => el('div', 'kv', el('span', 'k', p[0]), el('span', 'v', p[1]))));
      const tips = el('section', 'card', el('h2', null, 'Before you accept it'), el('ul', 'tips',
        el('li', null, 'Every detail above must match the paper exactly. A different name or date means the paper was altered.'),
        el('li', null, 'This page must open at ir1s-vir1s.github.io. The hospital never asks for a password, card or payment here.'),
        el('li', null, d.kind === 'certificate' ? 'The diagnosis appears only if the patient agreed to have it on the certificate.' : 'Medicines, history and results are not shown here, to protect the patient’s privacy.')));
      show(head, card, codeLine, tips, call);
    })
    .catch(() => show(result('fail', 'Could not check right now', 'The hospital’s record did not answer. Check the internet connection and scan again.'), call));
}());
