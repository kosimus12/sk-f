/**
 * Reine Logik der Prüf-Formulare (ohne Cloudflare-Runtime) – in Node testbar.
 */
export const EXT_ALLOWED = /\.(pdf|png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB je Datei
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MB gesamt (Mail-Anhang-tauglich)


/** Reihenfolge + Beschriftung der bekannten Felder (unbekannte werden hinten angehängt). */
export const FIELD_LABELS = [
  ['thema', 'Thema'],
  ['brand', 'Marke / Seite'],
  ['vorname', 'Vorname'],
  ['nachname', 'Nachname'],
  ['email', 'E-Mail'],
  ['telefon', 'Telefon'],
  ['geburtsdatum', 'Geburtsdatum'],
  ['beruf', 'Beruf / Status'],
  ['familienstand', 'Familienstand'],
  ['nettoeinkommen', 'Nettoeinkommen / Monat (€)'],
  ['bruttoeinkommen', 'Bruttoeinkommen / Jahr (€)'],
  ['kinder', 'Kinder'],
  ['kinder_details', 'Anzahl & Alter der Kinder'],
  ['taetigkeit', 'Ausgeübter Beruf & Tätigkeit'],
  ['beamtenstatus', 'Beamtenstatus'],
  ['kv_status', 'Aktuelle Krankenversicherung'],
  ['beihilfe', 'Beihilfeberechtigt'],
  ['beihilfesatz', 'Beihilfesatz (%)'],
  ['leistungen', 'Wichtige Leistungen'],
  ['selbstbeteiligung', 'Selbstbeteiligung'],
  ['raucher', 'Raucher'],
  ['groesse', 'Größe (cm)'],
  ['gewicht', 'Gewicht (kg)'],
  ['vorerkrankungen', 'Vorerkrankungen / Behandlungen (5 Jahre)'],
  ['beschwerden', 'Aktuelle Beschwerden / Medikamente'],
  ['bu_rente', 'Gewünschte BU-/DU-Rente (€)'],
  ['rentenbeginn_alter', 'Gewünschter Rentenbeginn (Alter)'],
  ['sparrate', 'Sparrate / Monat (€)'],
  ['vermoegen', 'Vorhandenes Vermögen (€)'],
  ['anlageziel', 'Anlageziel'],
  ['zeithorizont', 'Zeithorizont (Jahre)'],
  ['risiko', 'Risikobereitschaft (1–5)'],
  ['depots', 'Bestehende Depots / Sparpläne'],
  ['depots_welche', 'Welche Depots'],
  ['einmalanlage', 'Einmalanlage geplant'],
  ['einmalanlage_betrag', 'Einmalanlage Betrag (€)'],
  ['vertragsart', 'Was soll geprüft werden'],
  ['vertrag_status', 'Bestehender Vertrag / Angebot'],
  ['anmerkungen', 'Anmerkungen'],
  ['einwilligung', 'Einwilligung Datenverarbeitung'],
  ['einwilligung_gesundheit', 'Einwilligung Gesundheitsdaten (Art. 9 DSGVO)'],
];
const SKIP = new Set(['website', '_honey', 'token', 'dateien']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Wandelt FormData in eine geordnete Antwortliste + Dateiliste um und validiert.
 * Rein (ohne Netz) und deshalb in Node testbar.
 * @returns {{spam:boolean, errors:string[], fields:Object, answers:{questionId,label,value}[], files:File[], skipped:string[]}}
 */
export function parseVertragscheck(form) {
  const spam = String(form.get('website') || form.get('_honey') || '').trim() !== '';

  const fields = {};
  const files = [];
  for (const [key, value] of form.entries()) {
    if (typeof value === 'object' && value && typeof value.arrayBuffer === 'function') {
      if (value.size > 0 && value.name) files.push(value);
      continue;
    }
    if (SKIP.has(key)) continue;
    const v = String(value).trim().slice(0, 5000);
    if (!v) continue;
    fields[key] = fields[key] ? `${fields[key]}, ${v}` : v;
  }

  const errors = [];
  for (const k of ['vorname', 'nachname', 'email', 'telefon']) {
    if (!fields[k]) errors.push(`${k} fehlt`);
  }
  if (fields.email && !EMAIL_RE.test(fields.email)) errors.push('email ungültig');
  if (fields.einwilligung !== 'ja') errors.push('einwilligung fehlt');

  const known = new Map(FIELD_LABELS);
  const answers = [];
  for (const [k, label] of FIELD_LABELS) if (fields[k]) answers.push({ questionId: k, label, value: fields[k] });
  for (const [k, v] of Object.entries(fields)) if (!known.has(k)) answers.push({ questionId: k, label: k, value: v });

  // Dateien filtern: Endung, Einzelgröße, Anzahl, Gesamtgröße
  const accepted = [];
  const skipped = [];
  let total = 0;
  for (const f of files) {
    if (!EXT_ALLOWED.test(f.name)) { skipped.push(`${f.name} (Dateityp)`); continue; }
    if (f.size > MAX_FILE_BYTES) { skipped.push(`${f.name} (zu groß)`); continue; }
    if (accepted.length >= MAX_FILES) { skipped.push(`${f.name} (zu viele Dateien)`); continue; }
    if (total + f.size > MAX_TOTAL_BYTES) { skipped.push(`${f.name} (Gesamtgröße)`); continue; }
    total += f.size;
    accepted.push(f);
  }

  return { spam, errors, fields, answers, files: accepted, skipped };
}

export function mailHtml({ leadId, datum, themaFull, answers, folder, sheet, driveError, attachments, skipped }) {
  const rows = answers
    .map((a) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#5b6470;font-size:13px;vertical-align:top;width:40%">${esc(a.label)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:14px;white-space:pre-wrap">${esc(a.value)}</td></tr>`)
    .join('');
  const links = folder
    ? `<p><a href="${esc(folder.webViewLink)}">📁 Drive-Ordner</a>${sheet ? ` · <a href="${esc(sheet.url)}">📊 Antwort-Sheet</a>` : ''}</p>`
    : `<p style="color:#b00020"><b>Drive-Ablage fehlgeschlagen</b> – Dateien hängen an dieser Mail. Bitte manuell ablegen.<br><small>${esc(driveError && driveError.message ? driveError.message : driveError || '').slice(0, 300)}</small></p>`;
  const att = attachments.length ? `<p>Anhänge: ${attachments.map((a) => esc(a.filename)).join(', ')}</p>` : '';
  const skip = skipped.length ? `<p style="color:#b00020">Verworfene Dateien: ${esc(skipped.join(', '))}</p>` : '';
  return `<div style="font-family:Arial,sans-serif;max-width:640px;color:#333">
<h2 style="color:#0A1A5C">Neue Prüf-Anfrage über die Website</h2>
<p>Lead-ID <code>${esc(leadId)}</code> · ${esc(datum)} · ${esc(themaFull)}</p>${links}${att}${skip}
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #e4e7ef;border-collapse:collapse">${rows}</table>
<p style="font-size:12px;color:#888">Enthält ggf. Gesundheitsdaten (Art. 9 DSGVO) – nicht weiterleiten.</p></div>`;
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
