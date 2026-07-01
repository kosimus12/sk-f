#!/usr/bin/env node
// setup-secrets.mjs — generiert Secrets für das "Claude Hub" und druckt die
// wrangler-Befehle. Node, ZERO dependencies (nur node:crypto / node:readline).
//
// Erzeugt:
//   HUB_SECRET   – 32 zufällige Bytes als Hex (Signaturen/Sessions im Worker)
//   AGENT_TOKEN  – 32 zufällige Bytes als Hex (Auth der Brücken-Agenten)
//   TOTP_SECRET  – 20 zufällige Bytes als Base32 (A-Z2-7) für 2FA
//   DASHBOARD_PASSWORD – vom Nutzer (Argument oder Abfrage)
//
// Nutzung:
//   node scripts/setup-secrets.mjs [DASHBOARD_PASSWORD]

import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

// --- Base32 (RFC 4648, Alphabet A-Z2-7) selbst implementieren ---------------
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function toBase32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  // Kein Padding – für TOTP-Secrets üblich und von Authenticator-Apps akzeptiert.
  return out;
}

// --- Farbige Ausgabe ---------------------------------------------------------
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', gray: '\x1b[90m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// --- Passwort abfragen (falls nicht als Argument übergeben) ------------------
function askPassword() {
  return new Promise((resolve) => {
    const argPw = process.argv[2];
    if (argPw && argPw.trim()) {
      resolve(argPw.trim());
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Dashboard-Passwort wählen: ', (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

async function main() {
  // --- Secrets generieren ----------------------------------------------------
  const HUB_SECRET = randomBytes(32).toString('hex');   // 64 Hex-Zeichen
  const AGENT_TOKEN = randomBytes(32).toString('hex');  // 64 Hex-Zeichen
  const TOTP_SECRET = toBase32(randomBytes(20));        // 20 Bytes -> 32 Base32-Zeichen

  const DASHBOARD_PASSWORD = await askPassword();
  if (!DASHBOARD_PASSWORD) {
    console.error(`${C.red}Kein Passwort angegeben. Abbruch.${C.reset}`);
    process.exit(1);
  }

  // --- otpauth-URL bauen -----------------------------------------------------
  const otpauth =
    `otpauth://totp/Claude%20Hub:admin?secret=${TOTP_SECRET}` +
    `&issuer=Claude%20Hub&period=30&digits=6`;

  // --- Ausgabe ---------------------------------------------------------------
  const line = '='.repeat(66);
  console.log('');
  console.log(`${C.bold}${C.cyan}${line}${C.reset}`);
  console.log(`${C.bold}  Claude Hub – Secrets erzeugt${C.reset}`);
  console.log(`${C.bold}${C.cyan}${line}${C.reset}`);
  console.log('');

  console.log(`${C.bold}Erzeugte Werte:${C.reset}`);
  console.log(`  ${C.green}HUB_SECRET${C.reset}          = ${HUB_SECRET}`);
  console.log(`  ${C.green}AGENT_TOKEN${C.reset}         = ${AGENT_TOKEN}`);
  console.log(`  ${C.green}TOTP_SECRET${C.reset} (Base32) = ${TOTP_SECRET}`);
  console.log(`  ${C.green}DASHBOARD_PASSWORD${C.reset}  = ${DASHBOARD_PASSWORD}`);
  console.log('');

  console.log(`${C.bold}${C.cyan}${line}${C.reset}`);
  console.log(`${C.bold}  1) Diese 4 Befehle nacheinander ausführen (im Ordner claude-hub):${C.reset}`);
  console.log(`${C.gray}     wrangler fragt jeweils nach dem Wert – füge den Wert von oben ein.${C.reset}`);
  console.log(`${C.bold}${C.cyan}${line}${C.reset}`);
  console.log('');
  console.log(`  wrangler secret put HUB_SECRET`);
  console.log(`     ${C.gray}# Wert eingeben:${C.reset} ${C.yellow}${HUB_SECRET}${C.reset}`);
  console.log('');
  console.log(`  wrangler secret put AGENT_TOKEN`);
  console.log(`     ${C.gray}# Wert eingeben:${C.reset} ${C.yellow}${AGENT_TOKEN}${C.reset}`);
  console.log('');
  console.log(`  wrangler secret put TOTP_SECRET`);
  console.log(`     ${C.gray}# Wert eingeben:${C.reset} ${C.yellow}${TOTP_SECRET}${C.reset}`);
  console.log('');
  console.log(`  wrangler secret put DASHBOARD_PASSWORD`);
  console.log(`     ${C.gray}# Wert eingeben:${C.reset} ${C.yellow}${DASHBOARD_PASSWORD}${C.reset}`);
  console.log('');

  console.log(`${C.bold}${C.cyan}${line}${C.reset}`);
  console.log(`${C.bold}  2) 2FA einrichten (Google Authenticator / 1Password / Authy):${C.reset}`);
  console.log(`${C.bold}${C.cyan}${line}${C.reset}`);
  console.log('');
  console.log(`  Entweder diese otpauth-URL als QR-Code scannen/importieren:`);
  console.log(`    ${C.yellow}${otpauth}${C.reset}`);
  console.log('');
  console.log(`  Oder das Base32-Secret manuell eintippen (Typ: zeitbasiert / TOTP):`);
  console.log(`    ${C.yellow}${TOTP_SECRET}${C.reset}`);
  console.log(`    ${C.gray}(Konto: "Claude Hub:admin", Periode 30s, 6 Stellen)${C.reset}`);
  console.log('');

  console.log(`${C.bold}${C.red}${line}${C.reset}`);
  console.log(`${C.bold}${C.red}  SICHERHEITSHINWEIS${C.reset}`);
  console.log(`${C.bold}${C.red}${line}${C.reset}`);
  console.log(`  - Diese Secrets NICHT ins Git-Repo committen.`);
  console.log(`  - Sie liegen nur im Cloudflare-Worker (als 'wrangler secret').`);
  console.log(`  - AGENT_TOKEN kommt zusätzlich in die config.json jeder Bridge`);
  console.log(`    (~/.claude-hub/config.json, chmod 600) – nur auf deinen Rechnern.`);
  console.log(`  - Diese Terminal-Ausgabe danach schließen/löschen.`);
  console.log('');
}

main().catch((e) => {
  console.error(`Fehler: ${e.stack || e.message}`);
  process.exit(1);
});
