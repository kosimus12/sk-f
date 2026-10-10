import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVertragscheck, mailHtml, MAX_FILES } from '../src/worker/vertragscheck.js';
import { buildMime, b64bytes, wrap76 } from '../src/worker/mime.js';

function fd(fields, files = []) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const file of files) f.append('dateien', file);
  return f;
}
const base = { token: 'x', thema: 'Berufsunfähigkeitsversicherung', website: '', vorname: 'Max', nachname: 'Muster',
  email: 'max@example.com', telefon: '0176 1', vorerkrankungen: 'Rücken 2023', einwilligung: 'ja' };

test('gültige Einsendung: Antworten geordnet, Token/Honeypot entfernt', () => {
  const p = parseVertragscheck(fd(base, [new File(['%PDF'], 'police.pdf', { type: 'application/pdf' })]));
  assert.equal(p.spam, false);
  assert.deepEqual(p.errors, []);
  assert.equal(p.answers[0].questionId, 'thema');
  assert.ok(!p.answers.some((a) => a.questionId === 'token' || a.questionId === 'website'));
  assert.equal(p.files.length, 1);
});

test('Honeypot gefüllt -> spam', () => {
  assert.equal(parseVertragscheck(fd({ ...base, website: 'http://spam' })).spam, true);
});

test('Pflichtfelder + Einwilligung werden geprüft', () => {
  const p = parseVertragscheck(fd({ ...base, email: 'kaputt', einwilligung: '' }));
  assert.ok(p.errors.includes('email ungültig'));
  assert.ok(p.errors.includes('einwilligung fehlt'));
});

test('Dateien: falscher Typ und zu viele werden verworfen', () => {
  const files = [new File(['x'], 'virus.exe')];
  for (let i = 0; i < MAX_FILES + 2; i++) files.push(new File(['x'], `f${i}.jpg`, { type: 'image/jpeg' }));
  const p = parseVertragscheck(fd(base, files));
  assert.equal(p.files.length, MAX_FILES);
  assert.equal(p.skipped.length, 3);
});

test('Mehrfachwerte werden zusammengeführt, unbekannte Felder bleiben erhalten', () => {
  const f = fd(base);
  f.append('leistungen', 'Einbettzimmer');
  f.append('leistungen', 'Chefarzt');
  f.append('neues_feld', 'abc');
  const p = parseVertragscheck(f);
  assert.equal(p.fields.leistungen, 'Einbettzimmer, Chefarzt');
  assert.equal(p.answers.at(-1).questionId, 'neues_feld');
});

test('Mail-HTML escaped Eingaben', () => {
  const html = mailHtml({ leadId: 'L', datum: 'd', themaFull: 't', answers: [{ label: 'x', value: '<script>' }],
    folder: null, sheet: null, driveError: new Error('kaputt'), attachments: [], skipped: [] });
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Drive-Ablage fehlgeschlagen'));
});

test('MIME mit Anhang: multipart/mixed, Base64 korrekt', () => {
  const data = new Uint8Array(100000).map((_, i) => i % 251);
  const raw = buildMime({ from: 'a@b.de', to: ['c@d.de'], subject: 'Prüfung', html: '<p>Hi</p>',
    attachments: [{ filename: 'Police ä.pdf', mime: 'application/pdf', data: data.buffer }] });
  assert.match(raw, /Content-Type: multipart\/mixed/);
  assert.match(raw, /Content-Disposition: attachment/);
  assert.equal(Buffer.from(b64bytes(data), 'base64').equals(Buffer.from(data)), true);
  assert.ok(wrap76(b64bytes(data)).split('\r\n').every((l) => l.length <= 76));
});

test('MIME ohne Anhang bleibt kompatibel', () => {
  const raw = buildMime({ from: 'a@b.de', to: 'c@d.de', subject: 's', html: '<p>x</p>' });
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.doesNotMatch(raw, /multipart\/mixed/);
});
