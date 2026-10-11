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

import { parseVertragscheck, mailHtml, EXT_ALLOWED, esc } from './vertragscheck-parse.js';

const SITE = 'https://www.sk-finanzberatung.de';
const WHATSAPP = 'https://wa.me/4917655506385';

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

