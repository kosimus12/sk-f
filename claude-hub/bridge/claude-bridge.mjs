#!/usr/bin/env node
// claude-bridge.mjs — Brücken-Agent für das "Claude Hub"-System.
// Node.js >= 18 (globales fetch). ZERO dependencies.
//
// Verbindet eine lokale Claude-Code-Session (optional in tmux) mit dem
// Cloudflare-Worker-Hub: meldet sich an, sendet Heartbeats, pollt die Inbox
// und speist eingehende Inputs/Befehle/Coworker-Aufträge in die Session ein.
// Bietet zusätzlich einen lokalen Kontroll-Endpunkt (nur 127.0.0.1), über den
// Claude-Code-Hooks und der lokale Claude Status melden können.
//
// Start:  node claude-bridge.mjs
// Config: Umgebungsvariablen ODER ~/.claude-hub/config.json (env hat Vorrang).

import { createServer } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Konstanten / Pfade
// ---------------------------------------------------------------------------
const HOME = homedir();
const HUB_DIR = join(HOME, '.claude-hub');
const CONFIG_FILE = join(HUB_DIR, 'config.json');
const STATE_FILE = join(HUB_DIR, 'state.json');
const INBOX_LOG = join(HUB_DIR, 'inbox.log');
const NEXT_INPUT_FILE = join(HUB_DIR, 'next-input.txt');
const SHARED_MEMORY_FILE = join(HUB_DIR, 'shared-memory.md');

// Marker für den Gedächtnis-Block in einer externen Datei (z.B. CLAUDE.md)
const MEM_START = '<!-- CLAUDE-HUB-MEMORY:START -->';
const MEM_END = '<!-- CLAUDE-HUB-MEMORY:END -->';

// ---------------------------------------------------------------------------
// Farbiges, knappes Logging
// ---------------------------------------------------------------------------
const C = {
  reset: '\x1b[0m', gray: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function log(color, tag, ...args) {
  console.log(`${C.gray}${ts()}${C.reset} ${color}${tag}${C.reset}`, ...args);
}
const info = (...a) => log(C.cyan, '[info]', ...a);
const ok = (...a) => log(C.green, '[ok]  ', ...a);
const warn = (...a) => log(C.yellow, '[warn]', ...a);
const err = (...a) => log(C.red, '[err] ', ...a);
const net = (...a) => log(C.magenta, '[net] ', ...a);

// ---------------------------------------------------------------------------
// Config laden (env hat Vorrang vor Datei)
// ---------------------------------------------------------------------------
function loadFileConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    warn(`Konnte ${CONFIG_FILE} nicht lesen: ${e.message}`);
  }
  return {};
}

function pick(envKey, fileCfg, fileKey, dflt) {
  if (process.env[envKey] != null && process.env[envKey] !== '') return process.env[envKey];
  if (fileCfg[fileKey] != null && fileCfg[fileKey] !== '') return fileCfg[fileKey];
  return dflt;
}

const fileCfg = loadFileConfig();
const cfg = {
  HUB_URL: pick('HUB_URL', fileCfg, 'HUB_URL', ''),
  AGENT_TOKEN: pick('AGENT_TOKEN', fileCfg, 'AGENT_TOKEN', ''),
  AGENT_NAME: pick('AGENT_NAME', fileCfg, 'AGENT_NAME', 'Claude'),
  AGENT_HOST: pick('AGENT_HOST', fileCfg, 'AGENT_HOST', 'localhost'),
  AGENT_MODEL: pick('AGENT_MODEL', fileCfg, 'AGENT_MODEL', 'Opus'),
  CAPABILITIES: pick('CAPABILITIES', fileCfg, 'CAPABILITIES', ''),
  TMUX_TARGET: pick('TMUX_TARGET', fileCfg, 'TMUX_TARGET', ''),
  CONTROL_PORT: parseInt(pick('CONTROL_PORT', fileCfg, 'CONTROL_PORT', '4599'), 10),
  POLL_MS: parseInt(pick('POLL_MS', fileCfg, 'POLL_MS', '1500'), 10),
  HEARTBEAT_MS: parseInt(pick('HEARTBEAT_MS', fileCfg, 'HEARTBEAT_MS', '15000'), 10),
  // Gemeinsames Gedächtnis: optionale externe Zieldatei (z.B. ein CLAUDE.md)
  MEMORY_TARGET: pick('MEMORY_TARGET', fileCfg, 'MEMORY_TARGET', ''),
  // Telegram (headless): Claude-CLI-Kommando + optionales Arbeitsverzeichnis
  CLAUDE_CMD: pick('CLAUDE_CMD', fileCfg, 'CLAUDE_CMD', 'claude'),
  CLAUDE_CWD: pick('CLAUDE_CWD', fileCfg, 'CLAUDE_CWD', ''),
  CLAUDE_SYSTEM_FLAG: pick('CLAUDE_SYSTEM_FLAG', fileCfg, 'CLAUDE_SYSTEM_FLAG', '--append-system-prompt'),
  // Telegram-Verarbeitung an (Default) / aus ("0"). Nur der "main"-Agent sollte an sein.
  TELEGRAM_HANDLER: pick('TELEGRAM_HANDLER', fileCfg, 'TELEGRAM_HANDLER', '1'),
  // Timeout für headless Claude-Aufrufe (ms)
  CLAUDE_TIMEOUT_MS: parseInt(pick('CLAUDE_TIMEOUT_MS', fileCfg, 'CLAUDE_TIMEOUT_MS', '180000'), 10),
  // --- Session-/Chat-Scanner ---
  // Anzeigename der Quelle im Dashboard (z.B. „Mac", „Mac (Max)", „Hetzner").
  SOURCE_LABEL: pick('SOURCE_LABEL', fileCfg, 'SOURCE_LABEL', ''),
  // Scan-Intervall (ms)
  SCAN_MS: parseInt(pick('SCAN_MS', fileCfg, 'SCAN_MS', '60000'), 10),
  // Scanner an/aus
  SCAN_CODE: pick('SCAN_CODE', fileCfg, 'SCAN_CODE', '1'),
  SCAN_COWORK: pick('SCAN_COWORK', fileCfg, 'SCAN_COWORK', '1'),
  // Basisverzeichnis von Claude Code (Sessions unter <CLAUDE_HOME>/projects/…)
  CLAUDE_HOME: pick('CLAUDE_HOME', fileCfg, 'CLAUDE_HOME', join(HOME, '.claude')),
};

// SOURCE_LABEL: Default = AGENT_NAME
if (!cfg.SOURCE_LABEL) cfg.SOURCE_LABEL = cfg.AGENT_NAME;

// Normalisiere HUB_URL (kein abschließender Slash)
cfg.HUB_URL = (cfg.HUB_URL || '').replace(/\/+$/, '');

// Fähigkeiten als Liste
const capabilities = (cfg.CAPABILITIES || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Default-Aktionen pro Coworker/Fähigkeit
const DEFAULT_COWORKER_ACTIONS = {
  gmail: ['search', 'send', 'draft'],
  calendar: ['list', 'create'],
  drive: ['search', 'read'],
  github: ['list_prs', 'comment'],
};

function validateConfig() {
  const missing = [];
  if (!cfg.HUB_URL) missing.push('HUB_URL');
  if (!cfg.AGENT_TOKEN) missing.push('AGENT_TOKEN');
  if (missing.length) {
    err(`Fehlende Pflicht-Konfiguration: ${missing.join(', ')}`);
    err(`Setze sie als Umgebungsvariable oder in ${CONFIG_FILE}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// State (agentId persistieren)
// ---------------------------------------------------------------------------
function ensureHubDir() {
  try { mkdirSync(HUB_DIR, { recursive: true }); } catch { /* ignore */ }
}
function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch { /* ignore */ }
  return {};
}
function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { warn(`Konnte state nicht speichern: ${e.message}`); }
}

let state = loadState();
let agentId = state.agentId || null;

// requestId -> replyTo Mapping für Coworker-Aufträge, die wir ausführen sollen
const pendingCoworker = new Map();

// ---------------------------------------------------------------------------
// HTTP-Helfer mit Backoff (nie crashen)
// ---------------------------------------------------------------------------
async function hubPost(path, body) {
  const url = `${cfg.HUB_URL}${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-token': cfg.AGENT_TOKEN,
      },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      net(`${path} -> HTTP ${res.status} ${C.red}${(data && data.error) || text || ''}${C.reset}`);
      return { ok: false, status: res.status, data };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    net(`${path} -> Netzwerkfehler: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Text-Sanitisierung + tmux-Einspeisung
// ---------------------------------------------------------------------------
function sanitize(text) {
  if (text == null) return '';
  return String(text)
    // Zeilenumbrueche/Tabs zuerst zu Leerzeichen
    .replace(/[\r\n\t]+/g, ' ')
    // sonstige Steuerzeichen (ASCII 0x00-0x1F und 0x7F) entfernen
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
}

function tmuxSend(text) {
  const target = cfg.TMUX_TARGET;
  const clean = sanitize(text);
  if (!clean) return false;
  // 1) Text literal einfügen (-l = literal, -- beendet Optionen)
  const r1 = spawnSync('tmux', ['send-keys', '-t', target, '-l', '--', clean], {
    encoding: 'utf8',
  });
  if (r1.error) { err(`tmux send-keys (Text) fehlgeschlagen: ${r1.error.message}`); return false; }
  if (r1.status !== 0) { err(`tmux send-keys (Text) status ${r1.status}: ${(r1.stderr || '').trim()}`); return false; }
  // 2) Enter separat senden
  const r2 = spawnSync('tmux', ['send-keys', '-t', target, 'Enter'], { encoding: 'utf8' });
  if (r2.error) { err(`tmux send-keys (Enter) fehlgeschlagen: ${r2.error.message}`); return false; }
  if (r2.status !== 0) { err(`tmux send-keys (Enter) status ${r2.status}: ${(r2.stderr || '').trim()}`); return false; }
  return true;
}

// Speist einen Text entweder in tmux ein oder legt ihn in Dateien ab.
function feedToSession(text) {
  const clean = sanitize(text);
  if (cfg.TMUX_TARGET) {
    const sent = tmuxSend(clean);
    if (sent) { ok(`-> tmux ${cfg.TMUX_TARGET}: ${clean}`); return; }
    warn('tmux-Einspeisung fehlgeschlagen, falle auf Datei zurück.');
  }
  // Fallback: Datei/stdout
  try { appendFileSync(INBOX_LOG, `${ts()}  ${clean}\n`); } catch { /* ignore */ }
  try { writeFileSync(NEXT_INPUT_FILE, clean + '\n'); } catch { /* ignore */ }
  console.log(`${C.blue}>> ${C.reset}${clean}`);
}

function logToInbox(text) {
  const clean = sanitize(text);
  try { appendFileSync(INBOX_LOG, `${ts()}  ${clean}\n`); } catch { /* ignore */ }
  console.log(`${C.blue}>> ${C.reset}${clean}`);
}

// ---------------------------------------------------------------------------
// Gemeinsames Gedächtnis (shared memory)
// ---------------------------------------------------------------------------
let memoryVersion = 0;

// Schreibt den Gedächtnistext lokal: immer nach shared-memory.md, zusätzlich
// (falls MEMORY_TARGET gesetzt) in einen abgegrenzten Block der Zieldatei.
function writeMemoryLocally(text, version) {
  const body = typeof text === 'string' ? text : '';
  // 1) Immer shared-memory.md schreiben
  try { writeFileSync(SHARED_MEMORY_FILE, body.endsWith('\n') ? body : body + '\n'); }
  catch (e) { warn(`Konnte shared-memory.md nicht schreiben: ${e.message}`); }

  // 2) Optional in externe Zieldatei (Marker-Block ersetzen/anlegen)
  if (cfg.MEMORY_TARGET) {
    const block = `${MEM_START}\n${body}\n${MEM_END}`;
    try {
      let existing = '';
      if (existsSync(cfg.MEMORY_TARGET)) existing = readFileSync(cfg.MEMORY_TARGET, 'utf8');
      const startIdx = existing.indexOf(MEM_START);
      const endIdx = existing.indexOf(MEM_END);
      let next;
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        // Block ersetzen (Rest der Datei unangetastet lassen)
        next = existing.slice(0, startIdx) + block + existing.slice(endIdx + MEM_END.length);
      } else if (existing) {
        // Marker anlegen (am Ende anhängen)
        next = existing.replace(/\s*$/, '') + `\n\n${block}\n`;
      } else {
        next = block + '\n';
      }
      writeFileSync(cfg.MEMORY_TARGET, next);
    } catch (e) {
      warn(`Konnte MEMORY_TARGET (${cfg.MEMORY_TARGET}) nicht schreiben: ${e.message}`);
    }
  }
}

// Holt das Gedächtnis vom Hub, schreibt es lokal und meldet (bei Änderung)
// eine kurze Notiz in die Session bzw. auf stdout.
async function syncMemory({ announce } = { announce: false }) {
  const res = await hubPost('/api/agent/getMemory', {});
  if (!res.ok || !res.data || !res.data.memory) {
    warn('Konnte gemeinsames Gedächtnis nicht laden.');
    return;
  }
  const mem = res.data.memory;
  const version = mem.version || 0;
  writeMemoryLocally(mem.text || '', version);
  memoryVersion = version;
  ok(`Gemeinsames Gedächtnis synchronisiert (v${version}${mem.updatedBy ? ', von ' + mem.updatedBy : ''}).`);
  if (announce) {
    const note = `🧠 Gemeinsames Gedächtnis aktualisiert (v${version}) – bitte ${SHARED_MEMORY_FILE} beachten.`;
    if (cfg.TMUX_TARGET) feedToSession(note);
    else logToInbox(note);
  }
}

// ---------------------------------------------------------------------------
// Registrierung
// ---------------------------------------------------------------------------
async function register() {
  const res = await hubPost('/api/agent/register', {
    name: cfg.AGENT_NAME,
    host: cfg.AGENT_HOST,
    model: cfg.AGENT_MODEL,
    capabilities,
  });
  if (res.ok && res.data && res.data.agentId) {
    agentId = res.data.agentId;
    state = { ...state, agentId, registeredAt: ts() };
    saveState(state);
    ok(`Registriert als ${C.green}${cfg.AGENT_NAME}@${cfg.AGENT_HOST}${C.reset} (agentId=${agentId})`);
    return true;
  }
  warn('Registrierung fehlgeschlagen, versuche es später erneut.');
  return false;
}

async function registerCoworkers() {
  if (!capabilities.length) return;
  for (const cap of capabilities) {
    const actions = DEFAULT_COWORKER_ACTIONS[cap] || ['run'];
    const res = await hubPost('/api/agent/registerCoworker', {
      name: cap,
      actions,
      providedBy: agentId,
    });
    if (res.ok) ok(`Coworker registriert: ${cap} [${actions.join(', ')}]`);
    else warn(`Coworker-Registrierung für ${cap} fehlgeschlagen.`);
  }
}

// ---------------------------------------------------------------------------
// Heartbeat-Schleife
// ---------------------------------------------------------------------------
let currentStatus = 'idle';
let currentTask = '';

async function sendHeartbeat() {
  if (!agentId) return;
  await hubPost('/api/agent/heartbeat', {
    agentId,
    status: currentStatus,
    currentTask,
    capabilities,
  });
}

function startHeartbeatLoop() {
  const tick = async () => {
    try { await sendHeartbeat(); } catch (e) { warn(`Heartbeat-Fehler: ${e.message}`); }
    heartbeatTimer = setTimeout(tick, cfg.HEARTBEAT_MS);
  };
  tick();
}

// ---------------------------------------------------------------------------
// Inbox-Poll-Schleife
// ---------------------------------------------------------------------------
async function processItem(item) {
  if (!item || typeof item !== 'object') return;
  switch (item.type) {
    case 'input': {
      const text = `[Nutzer-Antwort${item.taskId ? ' zu Aufgabe ' + item.taskId : ''}] ${item.text || ''}`;
      feedToSession(text);
      break;
    }
    case 'command': {
      feedToSession(`[Befehl] ${item.text || ''}`);
      break;
    }
    case 'peer': {
      feedToSession(`[Nachricht von ${item.from || 'Agent'}] ${item.text || ''}`);
      break;
    }
    case 'coworker': {
      const paramsJson = (() => { try { return JSON.stringify(item.params || {}); } catch { return '{}'; } })();
      const auftrag = `[Coworker-Auftrag ${item.requestId || ''}] Bitte führe Coworker-Aktion ` +
        `${item.coworker}.${item.action} mit Parametern ${paramsJson} aus und melde das Ergebnis.`;
      // requestId + replyTo merken, damit ein späteres Ergebnis via /coworker-result
      // zugeordnet werden kann.
      if (item.requestId) {
        pendingCoworker.set(item.requestId, {
          replyTo: item.replyTo,
          coworker: item.coworker,
          action: item.action,
          at: Date.now(),
        });
      }
      feedToSession(auftrag);
      break;
    }
    case 'coworker_result': {
      let resultStr = '';
      try { resultStr = typeof item.result === 'string' ? item.result : JSON.stringify(item.result); }
      catch { resultStr = String(item.result); }
      logToInbox(`[Coworker-Ergebnis ${item.requestId || ''}] ${resultStr}`);
      break;
    }
    case 'memory': {
      // Gemeinsames Gedächtnis wurde aktualisiert -> neu holen und lokal schreiben.
      info(`Gedächtnis-Update signalisiert (v${item.version || '?'}), synchronisiere...`);
      await syncMemory({ announce: true });
      break;
    }
    case 'telegram': {
      // Headless beantworten (NICHT in die tmux-Session einspeisen).
      await handleTelegram(item);
      break;
    }
    default:
      logToInbox(`[Unbekanntes Item ${item.type || '?'}] ${JSON.stringify(item)}`);
  }
}

// ---------------------------------------------------------------------------
// Telegram (headless Antwort über das Claude-CLI im Print-Modus)
// ---------------------------------------------------------------------------
// Ruft das Claude-CLI headless auf und liefert stdout (oder wirft bei Fehler).
function runClaudeHeadless(prompt) {
  return new Promise((resolve, reject) => {
    // Argumente als Array – KEINE String-Interpolation (kein Shell-Injection).
    const args = ['-p', prompt, '--output-format', 'text'];
    // Optionaler System-Prompt aus dem gemeinsamen Gedächtnis
    if (cfg.CLAUDE_SYSTEM_FLAG && existsSync(SHARED_MEMORY_FILE)) {
      try {
        const memText = readFileSync(SHARED_MEMORY_FILE, 'utf8').trim();
        if (memText) {
          args.push(cfg.CLAUDE_SYSTEM_FLAG,
            `Gemeinsames Gedächtnis des Claude-Hub-Teams:\n${memText}`);
        }
      } catch { /* ignore */ }
    }

    const opts = { encoding: 'utf8' };
    if (cfg.CLAUDE_CWD) opts.cwd = cfg.CLAUDE_CWD;

    let child;
    try {
      child = spawn(cfg.CLAUDE_CMD, args, opts);
    } catch (e) {
      reject(new Error(`Claude-CLI-Start fehlgeschlagen: ${e.message}`));
      return;
    }

    let out = '';
    let errOut = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`Zeitüberschreitung nach ${Math.round(cfg.CLAUDE_TIMEOUT_MS / 1000)}s`));
    }, cfg.CLAUDE_TIMEOUT_MS);

    child.stdout && child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr && child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`Claude-CLI-Fehler: ${e.message}`));
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`Claude-CLI beendet mit Code ${code}: ${(errOut || '').trim().slice(0, 300)}`));
    });
  });
}

async function handleTelegram(item) {
  const chatId = item.chatId;
  const text = item.text || '';
  // Nur der "main"-Agent soll Telegram beantworten (per env steuerbar).
  if (String(cfg.TELEGRAM_HANDLER) === '0') {
    info('Telegram-Item empfangen, aber TELEGRAM_HANDLER=0 – ignoriere.');
    return;
  }
  info(`Telegram-Anfrage (chat ${chatId}): ${text.slice(0, 80)}`);
  let reply;
  try {
    reply = await runClaudeHeadless(text);
    if (!reply) reply = '(leere Antwort)';
  } catch (e) {
    warn(`Telegram-Verarbeitung fehlgeschlagen: ${e.message}`);
    reply = `⚠️ Konnte die Anfrage nicht bearbeiten: ${e.message}`;
  }
  const r = await hubPost('/api/agent/telegramReply', { chatId, text: reply });
  if (r.ok) ok(`Telegram-Antwort gesendet (chat ${chatId}).`);
  else warn('Telegram-Antwort konnte nicht an den Hub gesendet werden.');
}

async function pollInbox() {
  if (!agentId) return;
  const res = await hubPost('/api/agent/inbox', { agentId });
  if (res.ok && res.data && Array.isArray(res.data.items) && res.data.items.length) {
    info(`${res.data.items.length} Inbox-Item(s) empfangen`);
    for (const item of res.data.items) {
      try { await processItem(item); } catch (e) { err(`Item-Verarbeitung: ${e.message}`); }
    }
  }
}

let pollBackoff = cfg.POLL_MS;
function startPollLoop() {
  const tick = async () => {
    let hadError = false;
    try {
      const before = agentId;
      await pollInbox();
      if (!before) hadError = true;
    } catch (e) {
      hadError = true;
      warn(`Poll-Fehler: ${e.message}`);
    }
    // Backoff bei fehlender agentId / Fehlern, sonst normaler Takt
    if (!agentId) {
      // versuche Re-Register
      try {
        await register();
        if (agentId) { await registerCoworkers(); await syncMemory({ announce: false }); }
      } catch { /* ignore */ }
      pollBackoff = Math.min(pollBackoff * 2, 30000);
    } else if (hadError) {
      pollBackoff = Math.min(pollBackoff * 2, 30000);
    } else {
      pollBackoff = cfg.POLL_MS;
    }
    pollTimer = setTimeout(tick, pollBackoff);
  };
  tick();
}

// ---------------------------------------------------------------------------
// Lokaler Kontroll-Endpunkt (nur 127.0.0.1)
// ---------------------------------------------------------------------------
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function isLocal(req) {
  const ra = req.socket.remoteAddress || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

async function handleControl(req, res) {
  // Nur localhost erlauben
  if (!isLocal(req)) {
    sendJson(res, 403, { ok: false, error: 'Nur localhost erlaubt' });
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  // GET /pending -> Inhalt von next-input.txt
  if (req.method === 'GET' && path === '/pending') {
    let content = '';
    try { if (existsSync(NEXT_INPUT_FILE)) content = readFileSync(NEXT_INPUT_FILE, 'utf8'); } catch { /* ignore */ }
    sendJson(res, 200, { ok: true, pending: content });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 404, { ok: false, error: 'Nicht gefunden' });
    return;
  }

  const body = await readJsonBody(req);

  try {
    switch (path) {
      case '/status': {
        // Ruft Hub task auf.
        const r = await hubPost('/api/agent/task', {
          agentId,
          taskId: body.taskId,
          title: body.title || 'Status',
          status: body.status || 'working',
          question: body.question,
          note: body.note,
        });
        // Lokalen Status spiegeln
        if (body.status === 'needs_input') currentStatus = 'needs_input';
        else if (body.status === 'done') currentStatus = 'idle';
        else if (body.status === 'working' || body.status === 'open') currentStatus = 'working';
        if (body.title) currentTask = body.title;
        sendJson(res, r.ok ? 200 : 502, { ok: r.ok, taskId: r.data && r.data.taskId });
        return;
      }
      case '/heartbeat': {
        if (body.status) currentStatus = body.status;
        if (body.currentTask != null) currentTask = body.currentTask;
        const r = await hubPost('/api/agent/heartbeat', {
          agentId, status: currentStatus, currentTask, capabilities,
        });
        sendJson(res, r.ok ? 200 : 502, { ok: r.ok });
        return;
      }
      case '/message': {
        const r = await hubPost('/api/agent/message', {
          fromAgentId: agentId,
          toAgentId: body.toAgentId,
          toCapability: body.toCapability,
          body: body.body,
        });
        sendJson(res, r.ok ? 200 : 502, { ok: r.ok });
        return;
      }
      case '/coworker': {
        const r = await hubPost('/api/agent/coworkerCall', {
          coworker: body.coworker,
          action: body.action,
          params: body.params || {},
          fromAgentId: agentId,
          targetAgentId: body.targetAgentId,
        });
        sendJson(res, r.ok ? 200 : 502, {
          ok: r.ok,
          requestId: r.data && r.data.requestId,
          agentId: r.data && r.data.agentId,
        });
        return;
      }
      case '/coworker-result': {
        const mapping = body.requestId ? pendingCoworker.get(body.requestId) : null;
        const replyTo = (mapping && mapping.replyTo) || body.replyTo;
        const r = await hubPost('/api/agent/coworkerResult', {
          requestId: body.requestId,
          result: body.result,
          replyTo,
        });
        if (r.ok && body.requestId) pendingCoworker.delete(body.requestId);
        sendJson(res, r.ok ? 200 : 502, { ok: r.ok });
        return;
      }
      case '/memory': {
        // Der lokale Claude aktualisiert das gemeinsame Gedächtnis.
        const r = await hubPost('/api/agent/setMemory', {
          text: body.text || '',
          fromAgentId: agentId,
        });
        // Bei Erfolg lokal direkt spiegeln
        if (r.ok) {
          const version = r.data && r.data.version;
          writeMemoryLocally(body.text || '', version);
          if (version != null) memoryVersion = version;
        }
        sendJson(res, r.ok ? 200 : 502, { ok: r.ok, version: r.data && r.data.version });
        return;
      }
      default:
        sendJson(res, 404, { ok: false, error: 'Route nicht gefunden' });
    }
  } catch (e) {
    err(`Kontroll-Endpunkt-Fehler: ${e.message}`);
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

let controlServer = null;
function startControlServer() {
  controlServer = createServer((req, res) => {
    handleControl(req, res).catch((e) => {
      try { sendJson(res, 500, { ok: false, error: e.message }); } catch { /* ignore */ }
    });
  });
  controlServer.on('error', (e) => {
    err(`Kontroll-Server-Fehler: ${e.message}`);
  });
  // WICHTIG: nur auf 127.0.0.1 binden
  controlServer.listen(cfg.CONTROL_PORT, '127.0.0.1', () => {
    ok(`Kontroll-Endpunkt: http://127.0.0.1:${cfg.CONTROL_PORT}`);
  });
}

// ---------------------------------------------------------------------------
// Session-/Chat-Scanner
// ---------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CODE_SESSIONS = 100; // nur die neuesten N Sessions je Scan melden

// Kürzt einen String auf max. n Zeichen (mit … am Ende).
function truncate(s, n) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trimEnd() + '…';
}

// Dekodiert den von Claude Code kodierten Projektordnernamen.
// Claude Code ersetzt „/" durch „-"; führendes „-" entfernen.
// Rückgabe: { path, short } – short = letzter Pfadbestandteil.
function decodeProjectDir(dirName) {
  let s = String(dirName || '');
  // führende Bindestriche entfernen (kodierter absoluter Pfad)
  const path = s.replace(/^-+/, '').replace(/-/g, '/');
  const parts = path.split('/').filter(Boolean);
  const short = parts.length ? parts[parts.length - 1] : (s || '(unbekannt)');
  return { path: '/' + path, short };
}

// Extrahiert den Text aus einem message.content (String ODER Array von Blöcken).
function extractMessageText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        if (typeof block.text === 'string' && (block.type === 'text' || !block.type)) {
          texts.push(block.text);
        }
      } else if (typeof block === 'string') {
        texts.push(block);
      }
    }
    return texts.join(' ');
  }
  return '';
}

// Liest die ersten ~maxLines Zeilen einer JSONL-Datei und sucht die erste
// sinnvolle Nutzer-Nachricht. Robust gegen kaputte Zeilen.
function firstUserTitle(filePath, maxLines = 20) {
  let raw = '';
  try { raw = readFileSync(filePath, 'utf8'); } catch { return ''; }
  const lines = raw.split('\n', maxLines + 5).slice(0, maxLines);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const isUser = obj.type === 'user' ||
      (obj.message && typeof obj.message === 'object' && obj.message.role === 'user');
    if (!isUser) continue;
    // Text ermitteln
    let content;
    if (obj.message && typeof obj.message === 'object') content = obj.message.content;
    else content = obj.content;
    const text = extractMessageText(content).trim();
    // Slash-/Meta-Kommandos und leere Texte überspringen
    if (!text) continue;
    // Command-Wrapper (z.B. <command-name>…) grob rausfiltern
    if (/^<command-name>/.test(text) || /^<local-command/.test(text)) continue;
    return text;
  }
  return '';
}

// Scannt Claude-Code-Sessions (JSONL unter CLAUDE_HOME/projects/<encoded>/<uuid>.jsonl).
function scanClaudeCode() {
  const items = [];
  const projectsRoot = join(cfg.CLAUDE_HOME, 'projects');
  if (!existsSync(projectsRoot)) return items;

  // Alle .jsonl-Dateien mit mtime einsammeln
  const found = [];
  let projectDirs = [];
  try { projectDirs = readdirSync(projectsRoot); } catch { return items; }
  for (const dirName of projectDirs) {
    const dirPath = join(projectsRoot, dirName);
    let st;
    try { st = statSync(dirPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    const { short } = decodeProjectDir(dirName);
    let files = [];
    try { files = readdirSync(dirPath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = join(dirPath, f);
      let fst;
      try { fst = statSync(fp); } catch { continue; }
      if (!fst.isFile()) continue;
      found.push({
        id: f.slice(0, -'.jsonl'.length),
        filePath: fp,
        mtime: fst.mtimeMs,
        projectShort: short,
      });
    }
  }

  // Nach mtime absteigend sortieren, nur die neuesten N
  found.sort((a, b) => b.mtime - a.mtime);
  const slice = found.slice(0, MAX_CODE_SESSIONS);
  const now = Date.now();

  for (const s of slice) {
    let title = '';
    try { title = firstUserTitle(s.filePath); } catch { title = ''; }
    title = truncate(title || s.projectShort, 80);
    items.push({
      id: s.id,
      kind: 'code',
      title,
      status: (now - s.mtime) < DAY_MS ? 'open' : 'done',
      pinned: false,
      lastActivity: Math.round(s.mtime),
      project: s.projectShort,
    });
  }
  return items;
}

// Best-effort: sucht einen lokalen Claude-Cowork-Chat-Speicher (macOS).
// Gibt { items, checked, storeFound } zurück.
function scanClaudeCowork() {
  const candidates = [
    join(HOME, 'Library', 'Application Support', 'Claude'),
    join(HOME, 'Library', 'Application Support', 'Claude', 'Cowork'),
    join(HOME, 'Library', 'Application Support', 'Claude', 'cowork'),
    join(HOME, 'Library', 'Application Support', 'Claude', 'Local Storage'),
    join(HOME, 'Library', 'Application Support', 'Claude', 'IndexedDB'),
    join(cfg.CLAUDE_HOME, 'cowork'),
  ];
  const items = [];
  const existing = [];
  for (const dir of candidates) {
    if (existsSync(dir)) existing.push(dir);
  }

  // In existierenden Kandidaten nach parsebaren Chat-JSON-Dateien suchen.
  for (const dir of existing) {
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      const fp = join(dir, name);
      let fst;
      try { fst = statSync(fp); } catch { continue; }
      if (!fst.isFile() || fst.size > 5 * 1024 * 1024) continue;
      let data;
      try { data = JSON.parse(readFileSync(fp, 'utf8')); } catch { continue; }
      // Chats können ein einzelnes Objekt oder ein Array/verschachtelt sein.
      const chats = Array.isArray(data) ? data
        : (Array.isArray(data && data.chats) ? data.chats
          : (data && typeof data === 'object' ? [data] : []));
      for (const chat of chats) {
        if (!chat || typeof chat !== 'object') continue;
        // Nur wenn es wie ein Chat aussieht (title/pinned/status/updatedAt).
        const looksLikeChat = ('title' in chat) &&
          (('pinned' in chat) || ('status' in chat) || ('updatedAt' in chat));
        if (!looksLikeChat) continue;
        const updated = chat.updatedAt != null ? Number(new Date(chat.updatedAt).getTime() || chat.updatedAt) : fst.mtimeMs;
        items.push({
          id: String(chat.id || chat.uuid || name),
          kind: 'cowork',
          title: truncate(chat.title || '(Cowork-Chat)', 80),
          status: chat.status === 'done' ? 'done' : 'open',
          pinned: !!chat.pinned,
          lastActivity: Math.round(Number.isFinite(updated) ? updated : fst.mtimeMs),
          project: chat.project ? String(chat.project) : undefined,
        });
      }
    }
  }

  return { items, checked: candidates, storeFound: items.length > 0 };
}

let coworkNoticeLogged = false;

async function runScan() {
  let items = [];
  let codeCount = 0;
  let coworkCount = 0;

  if (String(cfg.SCAN_CODE) !== '0') {
    try {
      const codeItems = scanClaudeCode();
      codeCount = codeItems.length;
      items = items.concat(codeItems);
    } catch (e) { warn(`Code-Scan-Fehler: ${e.message}`); }
  }

  if (String(cfg.SCAN_COWORK) !== '0') {
    try {
      const { items: coworkItems, checked, storeFound } = scanClaudeCowork();
      coworkCount = coworkItems.length;
      items = items.concat(coworkItems);
      if (!storeFound && !coworkNoticeLogged) {
        coworkNoticeLogged = true;
        info('Cowork-Chats evtl. nur im Claude-Konto (Cloud) – lokal nichts gefunden. ' +
          `Geprüft: ${checked.join(', ')}`);
      }
    } catch (e) { warn(`Cowork-Scan-Fehler: ${e.message}`); }
  }

  if (!agentId) return { codeCount, coworkCount };

  try {
    const r = await hubPost('/api/agent/sessions', {
      agentId,
      source: cfg.SOURCE_LABEL,
      items,
    });
    if (r.ok) {
      const cnt = (r.data && r.data.count != null) ? r.data.count : items.length;
      info(`Sessions gemeldet: ${cnt} (code=${codeCount}, cowork=${coworkCount})`);
    } else {
      warn('Sessions konnten nicht an den Hub gemeldet werden.');
    }
  } catch (e) {
    warn(`Sessions-Meldung fehlgeschlagen: ${e.message}`);
  }
  return { codeCount, coworkCount };
}

let scanTimer = null;
function startScanLoop() {
  const tick = async () => {
    try { await runScan(); } catch (e) { warn(`Scan-Fehler: ${e.message}`); }
    scanTimer = setTimeout(tick, cfg.SCAN_MS);
  };
  // Kleiner Anfangsverzug, damit die Registrierung zuerst greift.
  scanTimer = setTimeout(tick, 2000);
}

// ---------------------------------------------------------------------------
// Sauberes Herunterfahren
// ---------------------------------------------------------------------------
let heartbeatTimer = null;
let pollTimer = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  warn(`${signal} empfangen, melde 'offline' und beende...`);
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  if (pollTimer) clearTimeout(pollTimer);
  if (scanTimer) clearTimeout(scanTimer);
  try {
    if (agentId) {
      await hubPost('/api/agent/heartbeat', {
        agentId, status: 'offline', currentTask: '', capabilities,
      });
    }
  } catch { /* ignore */ }
  try { if (controlServer) controlServer.close(); } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { err(`uncaughtException: ${e.stack || e.message}`); });
process.on('unhandledRejection', (e) => { err(`unhandledRejection: ${e && (e.stack || e.message || e)}`); });

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  ensureHubDir();
  validateConfig();

  info(`Brücken-Agent startet: ${C.cyan}${cfg.AGENT_NAME}@${cfg.AGENT_HOST}${C.reset}`);
  info(`Hub: ${cfg.HUB_URL}`);
  info(`Modell: ${cfg.AGENT_MODEL} | Fähigkeiten: ${capabilities.join(', ') || '(keine)'}`);
  info(`tmux-Ziel: ${cfg.TMUX_TARGET || '(keins – Datei-Modus)'} | Poll ${cfg.POLL_MS}ms | Heartbeat ${cfg.HEARTBEAT_MS}ms`);
  info(`Telegram-Handler: ${String(cfg.TELEGRAM_HANDLER) === '0' ? 'aus' : 'an'} | Gedächtnis-Ziel: ${cfg.MEMORY_TARGET || '(nur shared-memory.md)'}`);

  // Registrieren (mit Wiederholung, falls Hub noch nicht erreichbar)
  let registered = await register();
  if (registered) {
    await registerCoworkers();
    // Gemeinsames Gedächtnis einmal beim Start holen
    try { await syncMemory({ announce: false }); } catch (e) { warn(`Gedächtnis-Startsync: ${e.message}`); }
  } else {
    warn('Starte trotzdem – Poll-Schleife versucht Re-Register mit Backoff.');
  }

  // Einmalige Info zum Session-/Chat-Scanner beim Start.
  info(`Session-Scanner: Quelle „${cfg.SOURCE_LABEL}" | Intervall ${cfg.SCAN_MS}ms | ` +
    `Code ${String(cfg.SCAN_CODE) === '0' ? 'aus' : 'an'} | Cowork ${String(cfg.SCAN_COWORK) === '0' ? 'aus' : 'an'}`);
  try {
    let codeInfo = 0;
    let coworkStore = false;
    if (String(cfg.SCAN_CODE) !== '0') {
      codeInfo = scanClaudeCode().length;
    }
    if (String(cfg.SCAN_COWORK) !== '0') {
      const cw = scanClaudeCowork();
      coworkStore = cw.storeFound;
      if (!cw.storeFound) {
        coworkNoticeLogged = true;
        info('Cowork-Chats evtl. nur im Claude-Konto (Cloud) – lokal nichts gefunden. ' +
          `Geprüft: ${cw.checked.join(', ')}`);
      }
    }
    info(`Scanner-Start: ${codeInfo} Claude-Code-Session(s) gefunden; ` +
      `Cowork-Store: ${coworkStore ? 'gefunden' : 'keiner'}.`);
  } catch (e) { warn(`Scanner-Startinfo-Fehler: ${e.message}`); }

  startControlServer();
  startHeartbeatLoop();
  startPollLoop();
  if (String(cfg.SCAN_CODE) !== '0' || String(cfg.SCAN_COWORK) !== '0') startScanLoop();

  ok('Brücken-Agent läuft. Strg+C zum Beenden.');
}

main().catch((e) => {
  err(`Fataler Startfehler: ${e.stack || e.message}`);
  process.exit(1);
});
