// auth.js — Sicherheit: Login-Token (HMAC), 2FA (TOTP), konstante Vergleiche.
// Nur Web-Crypto (laeuft nativ im Cloudflare Worker), keine Abhaengigkeiten.

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Zeit-/laengensicherer Vergleich gegen Timing-Angriffe.
export function safeEqual(a, b) {
  const ab = enc.encode(String(a));
  const bb = enc.encode(String(b));
  // Immer beide durchlaufen; Laengenunterschied -> ungleich.
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

async function hmac(keyStr, dataBytes, hash = "SHA-256") {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(keyStr), { name: "HMAC", hash }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

// ---- Login-Session-Token: payload.signature (HMAC-SHA256, self-contained) ----
export async function issueToken(secret, ttlSeconds = 12 * 3600) {
  const payload = { exp: Math.floor(Date.now() / 1000) + ttlSeconds, v: 1 };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = b64urlEncode(await hmac(secret, enc.encode(body)));
  return `${body}.${sig}`;
}

export async function verifyToken(secret, token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = b64urlEncode(await hmac(secret, enc.encode(body)));
  if (!safeEqual(sig, expected)) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(body))); }
  catch { return null; }
  if (!payload || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ---- TOTP (RFC 6238), kompatibel mit Google Authenticator / 1Password / etc. ----
function base32Decode(s) {
  const alph = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const out = [];
  for (const c of s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "")) {
    const idx = alph.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function totpAt(secretB32, counter) {
  const key = await crypto.subtle.importKey(
    "raw", base32Decode(secretB32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(4, counter >>> 0, false);
  view.setUint32(0, Math.floor(counter / 2 ** 32) >>> 0, false);
  const hmacBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const offset = hmacBytes[hmacBytes.length - 1] & 0x0f;
  const bin =
    ((hmacBytes[offset] & 0x7f) << 24) |
    ((hmacBytes[offset + 1] & 0xff) << 16) |
    ((hmacBytes[offset + 2] & 0xff) << 8) |
    (hmacBytes[offset + 3] & 0xff);
  return (bin % 1_000_000).toString().padStart(6, "0");
}

// Prueft den 6-stelligen Code mit +/- 1 Zeitfenster (Uhr-Drift-Toleranz).
export async function verifyTotp(secretB32, code) {
  if (!secretB32 || !/^\d{6}$/.test(String(code || "").trim())) return false;
  const step = 30;
  const counter = Math.floor(Date.now() / 1000 / step);
  for (let w = -1; w <= 1; w++) {
    if (safeEqual(await totpAt(secretB32, counter + w), String(code).trim())) return true;
  }
  return false;
}
