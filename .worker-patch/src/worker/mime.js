/**
 * MIME-Aufbau & SMTP-Helfer (ohne Runtime-Abhängigkeiten, daher in Node testbar).
 */
const enc = new TextEncoder();

export function buildMime(msg) {
  const headers = [];
  headers.push(`From: ${formatAddr(msg.fromName, msg.from)}`);
  headers.push(`To: ${toList(msg.to).join(', ')}`);
  if (msg.replyTo) headers.push(`Reply-To: ${msg.replyTo}`);
  headers.push(`Subject: ${encodeHeader(msg.subject)}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push(`Message-ID: <${cryptoRandom()}@sk-finanzberatung.de>`);
  headers.push('MIME-Version: 1.0');

  const text = msg.text || htmlToText(msg.html || '');
  let partHeader;
  let partBody;
  if (msg.html) {
    const boundary = 'b_' + cryptoRandom();
    partHeader = `Content-Type: multipart/alternative; boundary="${boundary}"`;
    partBody =
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset="UTF-8"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n${wrap76(b64utf8(text))}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset="UTF-8"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n${wrap76(b64utf8(msg.html))}\r\n` +
      `--${boundary}--`;
  } else {
    partHeader = 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64';
    partBody = wrap76(b64utf8(text));
  }

  const attachments = msg.attachments || [];
  if (!attachments.length) {
    return headers.join('\r\n') + '\r\n' + partHeader + '\r\n\r\n' + partBody;
  }

  const mixed = 'm_' + cryptoRandom();
  headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
  let body = `--${mixed}\r\n${partHeader}\r\n\r\n${partBody}\r\n`;
  for (const a of attachments) {
    const name = encodeHeader(sanitizeFilename(a.filename));
    body +=
      `--${mixed}\r\n` +
      `Content-Type: ${a.mime || 'application/octet-stream'}; name="${name}"\r\n` +
      `Content-Disposition: attachment; filename="${name}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n${wrap76(b64bytes(a.data))}\r\n`;
  }
  body += `--${mixed}--`;
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

/** Punkt am Zeilenanfang verdoppeln (SMTP transparency, RFC 5321 §4.5.2). */
export function dotStuff(s) {
  return s.replace(/\r\n/g, '\n').split('\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
}

export function toList(to) {
  return (Array.isArray(to) ? to : [to]).filter(Boolean);
}
export function b64(str) {
  let bin = '';
  for (const byte of enc.encode(str)) bin += String.fromCharCode(byte);
  return btoa(bin);
}
export const b64utf8 = b64;

/** Base64 für Binärdaten (ArrayBuffer/Uint8Array), blockweise für große Dateien. */
export function b64bytes(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let out = '';
  const CHUNK = 0x8000 - (0x8000 % 3); // Vielfaches von 3 -> kein Padding zwischen Blöcken
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return out;
}

/** Base64 in Zeilen zu 76 Zeichen (RFC 2045). */
export function wrap76(s) {
  return s.replace(/.{76}(?=.)/g, '$&\r\n');
}

function sanitizeFilename(name) {
  return String(name || 'datei').replace(/[\r\n"\\]/g, '_').slice(0, 120);
}
function formatAddr(name, addr) {
  return name ? `${encodeHeader(name)} <${addr}>` : addr;
}
function encodeHeader(s) {
  return /[^\x00-\x7F]/.test(String(s)) ? `=?UTF-8?B?${b64utf8(String(s))}?=` : String(s);
}
function cryptoRandom() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
