/**
 * Prüf-Formulare der Website (BU, PKV, Altersvorsorge, Vertragscheck der Sub-Brands).
 *
 * Die Formulare auf sk-finanzberatung.de posten klassisch (ohne JavaScript-Fetch)
 * multipart/form-data an POST /api/vertragscheck. Der Worker antwortet mit einem
 * 303-Redirect auf die Danke-Seite.
 *
 * Ablage:
 *   1. Drive-Kundenordner + Antwort-Sheet + Uploads + Zeile im zentralen Sheet
 *      (best effort – fällt z. B. bei abgelaufenem Google-Token aus)
 *   2. Mail an VC_NOTIFY_TO mit allen Antworten. Sind die Dateien NICHT in Drive
 *      gelandet, hängen sie als Anhang an der Mail – so geht keine Anfrage verloren.
 *   3. Telegram-Ping (ohne Gesundheitsdaten).
 * Scheitern Drive UND Mail, bekommt der Besucher eine Fehlerseite mit WhatsApp-Link.
 */
import { makeLeadId, berlinParts, folderName } from './leadid.js';
import { createCustomerFolder, uploadFile } from './drive.js';
import { createAnswerSheet, appendCentralLead, appendUploadMeta } from './sheets.js';
import { sendTelegram, errorMessage } from './telegram.js';
import { sendMail } from './smtp.js';

export const EXT_ALLOWED = /\.(pdf|png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB je Datei
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MB gesamt (Mail-Anhang-tauglich)

const SITE = 'https://www.sk-finanzberatung.de';
const WHATSAPP = 'https://wa.me/4917655506385';

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

export async function handleVertragscheck(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return errorPage(400, 'Die Anfrage konnte nicht gelesen werden.');
  }
  const p = parseVertragscheck(form);
  if (p.spam) return redirect(`${SITE}/danke/`); // Bot: still „erfolgreich“, nichts speichern
  if (p.errors.length) {
    return errorPage(400, 'Bitte fülle Name, E-Mail, Telefon und die Einwilligung aus und sende das Formular erneut.');
  }

  const now = new Date();
  const parts = berlinParts(now);
  const leadId = makeLeadId(now);
  const { vorname, nachname, email } = p.fields;
  const thema = p.fields.thema || 'Vertragscheck';
  const themaFull = p.fields.brand ? `${thema} (${p.fields.brand})` : thema;

  /* ---- 1. Drive / Sheets (best effort) ---- */
  let folder = null;
  let sheet = null;
  let driveError = null;
  const uploaded = new Set();
  try {
    folder = await createCustomerFolder(env, folderName({ vorname, nachname, leadId, date: now }));
    sheet = await createAnswerSheet(env, {
      title: `Antworten_${nachname}_${vorname}_${leadId}`,
      folderId: folder.id,
      meta: { 'Lead-ID': leadId, 'Datum': parts.human, 'Formular': `Website-Prüfformular: ${themaFull}` },
      answers: p.answers,
    });
    await appendCentralLead(env, { vorname, nachname, thema: themaFull, datum: parts.isoDate, status: 'Neu (Website-Prüfung)' })
      .catch(() => {});
    let n = 0;
    for (const f of p.files) {
      n += 1;
      const ext = (f.name.match(EXT_ALLOWED) || [''])[0].toLowerCase();
      const driveName = `Datei_${n}${ext}`;
      try {
        const data = await f.arrayBuffer();
        const up = await uploadFile(env, { folderId: folder.id, name: driveName, mime: f.type, data });
        uploaded.add(f);
        await appendUploadMeta(env, {
          leadId, datum: parts.human, kunde: `${nachname}, ${vorname}`, dateiname: driveName,
          original: f.name, mime: f.type || '', size: data.byteLength, link: up.webViewLink, folderId: folder.id,
        }).catch(() => {});
      } catch (err) {
        driveError = driveError || err;
      }
    }
  } catch (err) {
    driveError = err;
  }

  /* ---- 2. Mail (Pflicht, wenn Drive fehlt) ---- */
  const missing = p.files.filter((f) => !uploaded.has(f));
  const attachments = [];
  for (const f of missing) {
    attachments.push({ filename: f.name, mime: f.type || 'application/octet-stream', data: await f.arrayBuffer() });
  }
  let mailError = null;
  try {
    await sendMail(env, {
      from: env.MAIL_NOTIFY_FROM || env.SMTP_USER,
      fromName: 'SK Finanzberatung Website',
      to: splitList(env.VC_NOTIFY_TO || env.MAIL_NOTIFY_TO || 'kontakt@sk-finanzberatung.de'),
      replyTo: email,
      subject: `Neue Prüf-Anfrage: ${nachname}, ${vorname} – ${themaFull}`,
      html: mailHtml({ leadId, datum: parts.human, themaFull, answers: p.answers, folder, sheet, driveError, attachments, skipped: p.skipped }),
      attachments,
    });
  } catch (err) {
    mailError = err;
  }

  /* ---- 3. Telegram (ohne Namen/Gesundheitsdaten – Telegram sitzt außerhalb der EU) ---- */
  const status = folder ? '📁 Drive ok' : '⚠️ Drive fehlgeschlagen';
  const mailStatus = mailError ? '⚠️ Mail fehlgeschlagen' : '✉️ Mail ok';
  await sendTelegram(env,
    `🟢 <b>Neue Prüf-Anfrage (Website)</b>\nThema: ${esc(themaFull)}\n` +
    `Dateien: ${p.files.length}${p.skipped.length ? ` (+${p.skipped.length} verworfen)` : ''}\n${status} · ${mailStatus}\nLead-ID: <code>${leadId}</code>`);
  if (driveError) await sendTelegram(env, errorMessage('Vertragscheck Drive/Sheets', driveError, leadId));
  if (mailError) await sendTelegram(env, errorMessage('Vertragscheck Mail', mailError, leadId));

  if (!folder && mailError) {
    // Nichts gespeichert – Besucher muss es wissen.
    await sendTelegram(env, `🔴 Anfrage <code>${leadId}</code> NICHT gespeichert – Besucher wurde auf WhatsApp verwiesen.`);
    return errorPage(502, 'Deine Anfrage konnte gerade nicht gespeichert werden. Bitte schreib mir kurz per WhatsApp – ich melde mich sofort.');
  }
  return redirect(`${SITE}/danke/`);
}

/* ------------------------------- Helfer ---------------------------------- */
function splitList(s) {
  return String(s).split(',').map((x) => x.trim()).filter(Boolean);
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { location } });
}

function errorPage(status, text) {
  return new Response(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anfrage nicht gesendet – SK-Finanzberatung</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#333;line-height:1.5}
a.btn{display:inline-block;background:#C8A24B;color:#0A1A5C;font-weight:600;text-decoration:none;border-radius:10px;padding:12px 20px;margin:6px 8px 0 0}</style>
</head><body><h1 style="color:#0A1A5C">Das hat leider nicht geklappt</h1><p>${esc(text)}</p>
<p><a class="btn" href="${WHATSAPP}">Per WhatsApp schreiben</a><a class="btn" href="javascript:history.back()">Zurück zum Formular</a></p>
<p><small>Telefon: <a href="tel:+4917655506385">0176 55506385</a> · <a href="mailto:info@sk-finanzberatung.de">info@sk-finanzberatung.de</a></small></p>
</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
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

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
