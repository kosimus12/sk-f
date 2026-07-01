// dashboard.js — Frontend fuer das "Claude Hub"-Dashboard der SK Finanzberatung.
// Exportiert drei Strings: HTML (index.html), CSS (style.css), APPJS (app.js).
// Der Worker liefert sie unter /, /style.css und /app.js aus.
//
// WICHTIG — strikte CSP (default-src 'self'; script-src 'self'; style-src 'self'):
//   - Kein Inline-<script>, kein Inline-<style>, keine style="..."/onclick="..."-Attribute.
//   - Alles Styling in CSS-Klassen, alle Events via addEventListener in app.js.
//   - element.style.xyz und classList per JS sind erlaubt.
//   - Keine externen Ressourcen; System-Fonts.
//
// Escaping-Hinweis: Weil diese Datei selbst Template-Literale nutzt, sind in den
// enthaltenen Strings alle Backticks als \` und alle ${ als \${ escaped.
// In app.js wird bewusst mit einfachen Anfuehrungszeichen / Konkatenation gearbeitet,
// um Template-Literal-Escaping zu vermeiden.

// ---------------------------------------------------------------------------
// HTML — index.html (kein Inline-Script/Style, laedt /style.css und /app.js)
// ---------------------------------------------------------------------------
export const HTML = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#0f172a">
  <title>Claude Hub — SK Finanzberatung</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <!-- ==================== LOGIN ==================== -->
  <main id="login-screen" class="login-screen" aria-label="Anmeldung">
    <section class="login-card">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">SK</div>
        <div class="brand-text">
          <div class="brand-title">SK Finanzberatung</div>
          <div class="brand-sub">Claude Hub</div>
        </div>
      </div>
      <form id="login-form" class="login-form" novalidate>
        <label class="field">
          <span class="field-label">Passwort</span>
          <input id="login-password" type="password" autocomplete="current-password"
                 name="password" required>
        </label>
        <label class="field">
          <span class="field-label">2FA-Code</span>
          <input id="login-code" type="text" inputmode="numeric" pattern="[0-9]*"
                 maxlength="6" autocomplete="one-time-code" name="code"
                 placeholder="123456" required>
        </label>
        <button id="login-submit" class="btn btn-primary btn-lg" type="submit">Anmelden</button>
        <p id="login-error" class="login-error" role="alert" hidden></p>
      </form>
    </section>
  </main>

  <!-- ==================== DASHBOARD ==================== -->
  <div id="dashboard" class="dashboard" hidden>
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand brand-compact">
          <div class="brand-mark" aria-hidden="true">SK</div>
          <div class="brand-text">
            <div class="brand-title">Claude Hub</div>
            <div class="brand-sub">SK Finanzberatung</div>
          </div>
        </div>
        <div class="topbar-actions">
          <span id="sync-status" class="sync-status" aria-live="polite">…</span>
          <button id="refresh-btn" class="btn btn-ghost" type="button" title="Jetzt aktualisieren">Aktualisieren</button>
          <button id="logout-btn" class="btn btn-ghost" type="button">Abmelden</button>
        </div>
      </div>
    </header>

    <main class="content">
      <!-- Braucht deinen Input (wichtigster Bereich) -->
      <section id="section-input" class="section section-alert" hidden>
        <h2 class="section-title">⚠️ Braucht deinen Input</h2>
        <div id="input-list" class="card-list"></div>
      </section>

      <!-- Broadcast -->
      <section class="section">
        <h2 class="section-title">📣 Broadcast an alle Agenten</h2>
        <div class="card broadcast-card">
          <textarea id="broadcast-text" class="textarea" rows="2"
                    placeholder="Nachricht an alle Agenten…"></textarea>
          <div class="card-actions">
            <button id="broadcast-send" class="btn btn-primary" type="button">Senden</button>
          </div>
        </div>
      </section>

      <!-- Aktive Aufgaben -->
      <section class="section">
        <h2 class="section-title">🟢 Aktive Aufgaben</h2>
        <div id="active-list" class="card-list"></div>
      </section>

      <!-- Erledigt (einklappbar) -->
      <section class="section">
        <h2 class="section-title section-title-toggle">
          <button id="done-toggle" class="collapse-btn" type="button" aria-expanded="false">
            <span class="chevron" aria-hidden="true">▸</span>
            <span>Erledigt</span>
            <span id="done-count" class="badge badge-muted">0</span>
          </button>
        </h2>
        <div id="done-list" class="card-list" hidden></div>
      </section>

      <!-- Meine Claudes (Agenten) -->
      <section class="section">
        <h2 class="section-title">🤖 Meine Claudes</h2>
        <div id="agents-list" class="card-list"></div>
      </section>

      <!-- Coworker (MCP-Dienste) -->
      <section class="section">
        <h2 class="section-title">🔌 Coworker</h2>
        <p class="section-hint">Delegiere Arbeit an einen günstigeren Agenten (z.&nbsp;B. Opus&nbsp;4.6), um Tokens zu sparen.</p>
        <div class="card">
          <div class="form-grid">
            <label class="field">
              <span class="field-label">Coworker</span>
              <select id="cw-coworker" class="select"></select>
            </label>
            <label class="field">
              <span class="field-label">Aktion</span>
              <select id="cw-action" class="select"></select>
            </label>
            <label class="field">
              <span class="field-label">Ziel-Agent (optional)</span>
              <select id="cw-target" class="select"></select>
            </label>
          </div>
          <label class="field">
            <span class="field-label">Parameter (JSON, optional)</span>
            <textarea id="cw-params" class="textarea mono" rows="3" placeholder="{ }"></textarea>
          </label>
          <p id="cw-error" class="field-error" role="alert" hidden></p>
          <div class="card-actions">
            <button id="cw-send" class="btn btn-primary" type="button">Aktion auslösen</button>
          </div>
          <div id="cw-empty" class="empty-note" hidden>Keine Coworker verfügbar.</div>
        </div>
      </section>

      <!-- Gemeinsames Gedächtnis (shared memory) -->
      <section class="section">
        <h2 class="section-title section-title-toggle">
          <button id="mem-toggle" class="collapse-btn" type="button" aria-expanded="false">
            <span class="chevron" aria-hidden="true">▸</span>
            <span>🧠 Gemeinsames Gedächtnis</span>
            <span id="mem-newer" class="badge badge-needs_input" hidden></span>
          </button>
        </h2>
        <div id="mem-body" class="card" hidden>
          <p class="section-hint">Dieser Text ist für ALLE deine Claudes gleich. Nach dem Speichern synchronisieren sich alle Agenten automatisch.</p>
          <div class="mem-meta-row">
            <span id="mem-meta" class="card-meta">…</span>
            <button id="mem-reload" class="btn btn-ghost btn-sm" type="button">Neu laden</button>
          </div>
          <textarea id="mem-text" class="textarea mono mem-textarea" rows="12"
                    placeholder="Gemeinsamer Kontext für alle Agenten…" spellcheck="false"></textarea>
          <div class="card-actions">
            <button id="mem-save" class="btn btn-primary" type="button">Speichern &amp; an alle verteilen</button>
          </div>
        </div>
      </section>

      <!-- Aktivitaets-Feed -->
      <section class="section">
        <h2 class="section-title">🕘 Aktivität</h2>
        <ul id="feed-list" class="feed"></ul>
      </section>
    </main>

    <footer class="footer">
      <span>SK Finanzberatung · Claude Hub</span>
    </footer>
  </div>

  <!-- kleine Toast-Meldung -->
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>

  <script src="/app.js"></script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// CSS — style.css (mobile-first, Dark-Mode via prefers-color-scheme, Touch >=44px)
// ---------------------------------------------------------------------------
export const CSS = `:root {
  --bg: #f4f5f7;
  --surface: #ffffff;
  --surface-2: #f8fafc;
  --border: #e2e8f0;
  --text: #0f172a;
  --text-muted: #64748b;
  --primary: #1e40af;
  --primary-hover: #1d4ed8;
  --primary-text: #ffffff;
  --alert-bg: #fef3c7;
  --alert-border: #f59e0b;
  --alert-text: #78350f;
  --danger: #b91c1c;
  --ok: #16a34a;
  --gray-dot: #94a3b8;
  --radius: 14px;
  --shadow: 0 1px 3px rgba(15, 23, 42, .08), 0 1px 2px rgba(15, 23, 42, .04);
  --touch: 44px;
  --header-bg: #0f172a;
  --header-text: #e2e8f0;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b1120;
    --surface: #111827;
    --surface-2: #0f1729;
    --border: #1f2937;
    --text: #e5e7eb;
    --text-muted: #94a3b8;
    --primary: #3b82f6;
    --primary-hover: #60a5fa;
    --primary-text: #0b1120;
    --alert-bg: #422006;
    --alert-border: #d97706;
    --alert-text: #fde68a;
    --danger: #f87171;
    --ok: #4ade80;
    --gray-dot: #475569;
    --shadow: 0 1px 3px rgba(0, 0, 0, .4);
    --header-bg: #060a14;
    --header-text: #e5e7eb;
  }
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 16px;
  line-height: 1.45;
  -webkit-text-size-adjust: 100%;
}

button, input, select, textarea { font-family: inherit; font-size: 1rem; color: inherit; }

/* ---------- Buttons ---------- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--touch);
  padding: 10px 16px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text);
  cursor: pointer;
  font-weight: 600;
  text-decoration: none;
  transition: background .12s ease, opacity .12s ease;
}
.btn:active { opacity: .85; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-primary { background: var(--primary); color: var(--primary-text); border-color: var(--primary); }
.btn-primary:hover { background: var(--primary-hover); }
.btn-ghost { background: transparent; border-color: transparent; color: var(--header-text); }
.btn-ghost:hover { background: rgba(255, 255, 255, .08); }
.btn-lg { min-height: 50px; width: 100%; font-size: 1.05rem; }
.btn-danger { background: transparent; color: var(--danger); border-color: var(--border); }

/* ---------- Login ---------- */
.login-screen {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  padding-top: max(24px, env(safe-area-inset-top));
}
.login-card {
  width: 100%;
  max-width: 400px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 28px 24px;
}
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
.brand-compact { margin-bottom: 0; }
.brand-mark {
  width: 44px; height: 44px;
  flex: 0 0 44px;
  display: grid; place-items: center;
  background: var(--primary);
  color: var(--primary-text);
  border-radius: 12px;
  font-weight: 800;
  letter-spacing: .5px;
}
.brand-title { font-weight: 700; font-size: 1.05rem; }
.brand-sub { color: var(--text-muted); font-size: .85rem; }
.login-form { display: flex; flex-direction: column; gap: 16px; }
.login-error {
  margin: 4px 0 0;
  color: var(--danger);
  font-size: .9rem;
  background: var(--alert-bg);
  border: 1px solid var(--alert-border);
  border-radius: 8px;
  padding: 8px 12px;
}

/* ---------- Felder ---------- */
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: .82rem; color: var(--text-muted); font-weight: 600; }
input[type="text"], input[type="password"], .textarea, .select {
  width: 100%;
  min-height: var(--touch);
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text);
}
.textarea { resize: vertical; min-height: 60px; line-height: 1.4; }
.mono { font-family: var(--mono); font-size: .9rem; }
input:focus, .textarea:focus, .select:focus, .btn:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.field-error { color: var(--danger); font-size: .85rem; margin: 4px 0 0; }

/* ---------- Topbar ---------- */
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  background: var(--header-bg);
  color: var(--header-text);
  padding-top: env(safe-area-inset-top);
}
.topbar-inner {
  max-width: 900px;
  margin: 0 auto;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.topbar .brand-title { color: var(--header-text); }
.topbar .brand-sub { color: #94a3b8; }
.topbar-actions { display: flex; align-items: center; gap: 6px; }
.sync-status { font-size: .78rem; color: #94a3b8; white-space: nowrap; }
.sync-status.offline { color: #f87171; }

/* ---------- Content-Layout ---------- */
.content { max-width: 900px; margin: 0 auto; padding: 16px 14px 40px; }
.section { margin-bottom: 26px; }
.section-title { font-size: 1.1rem; margin: 0 0 12px; font-weight: 700; }
.section-hint { color: var(--text-muted); font-size: .88rem; margin: -6px 0 12px; }
.section-alert {
  background: var(--alert-bg);
  border: 1px solid var(--alert-border);
  border-radius: var(--radius);
  padding: 14px;
}
.section-alert .section-title { color: var(--alert-text); }

.section-title-toggle { margin: 0; }
.collapse-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: var(--touch);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 6px 0;
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text);
}
.chevron { display: inline-block; transition: transform .15s ease; color: var(--text-muted); }
.collapse-btn[aria-expanded="true"] .chevron { transform: rotate(90deg); }

/* ---------- Karten ---------- */
.card-list { display: flex; flex-direction: column; gap: 12px; }
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 14px;
}
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.card-title { font-weight: 700; font-size: 1rem; margin: 0; }
.card-meta { color: var(--text-muted); font-size: .82rem; margin-top: 2px; }
.card-body { margin-top: 8px; }
.card-question { margin: 8px 0; }
.card-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; justify-content: flex-end; }
.broadcast-card .card-actions { margin-top: 8px; }

.reply-row { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }

/* ---------- Badges & Status ---------- */
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: .72rem;
  font-weight: 700;
  white-space: nowrap;
}
.badge-muted { background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); }
.badge-open { background: #dbeafe; color: #1e3a8a; }
.badge-working { background: #fef9c3; color: #854d0e; }
.badge-needs_input { background: var(--alert-bg); color: var(--alert-text); }
.badge-done { background: #dcfce7; color: #166534; }
.badge-error { background: #fee2e2; color: #991b1b; }
.badge-idle { background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); }
.badge-offline { background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); }

@media (prefers-color-scheme: dark) {
  .badge-open { background: #1e3a8a; color: #dbeafe; }
  .badge-working { background: #713f12; color: #fef9c3; }
  .badge-done { background: #14532d; color: #dcfce7; }
  .badge-error { background: #7f1d1d; color: #fee2e2; }
}

.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--gray-dot); flex: 0 0 10px; }
.dot-online { background: var(--ok); }
.dot-offline { background: var(--gray-dot); }

/* ---------- Agenten ---------- */
.agent-head { display: flex; align-items: center; gap: 8px; }
.agent-name { font-weight: 700; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip {
  display: inline-block;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: .74rem;
}
.kv { display: flex; gap: 6px; font-size: .85rem; margin-top: 2px; }
.kv .k { color: var(--text-muted); min-width: 62px; }

/* ---------- Log / Detail ---------- */
.detail-toggle {
  background: transparent;
  border: none;
  color: var(--primary);
  cursor: pointer;
  padding: 6px 0;
  font-size: .85rem;
  font-weight: 600;
  min-height: var(--touch);
  text-align: left;
}
.log {
  margin-top: 8px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.log-entry { font-size: .85rem; display: flex; gap: 8px; }
.log-who { color: var(--text-muted); font-weight: 600; min-width: 70px; }
.log-ts { color: var(--text-muted); font-size: .72rem; }
.log-text { white-space: pre-wrap; word-break: break-word; }

/* ---------- Feed ---------- */
.feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.feed-item {
  display: flex;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  align-items: flex-start;
}
.feed-item:nth-child(odd) { background: var(--surface); }
.feed-icon { flex: 0 0 22px; text-align: center; }
.feed-body { flex: 1; min-width: 0; }
.feed-text { font-size: .9rem; word-break: break-word; }
.feed-time { color: var(--text-muted); font-size: .74rem; white-space: nowrap; }

/* ---------- Coworker-Formular ---------- */
.form-grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-bottom: 12px; }
@media (min-width: 620px) { .form-grid { grid-template-columns: 1fr 1fr 1fr; } }

.empty-note, .empty { color: var(--text-muted); font-size: .9rem; padding: 8px 2px; }

/* ---------- Gemeinsames Gedächtnis ---------- */
.btn-sm { min-height: 36px; padding: 6px 12px; font-size: .85rem; }
.mem-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.mem-meta-row .btn-ghost { color: var(--primary); border: 1px solid var(--border); }
.mem-textarea {
  min-height: 280px;
  line-height: 1.5;
  font-size: .9rem;
  -webkit-overflow-scrolling: touch;
}

.footer {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px 14px calc(20px + env(safe-area-inset-bottom));
  color: var(--text-muted);
  font-size: .8rem;
  text-align: center;
}

/* ---------- Toast ---------- */
.toast {
  position: fixed;
  left: 50%;
  bottom: calc(20px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  background: var(--header-bg);
  color: var(--header-text);
  padding: 10px 16px;
  border-radius: 10px;
  box-shadow: var(--shadow);
  z-index: 50;
  font-size: .9rem;
  max-width: 90vw;
}
.toast.error { background: var(--danger); color: #fff; }

[hidden] { display: none !important; }`;

// ---------------------------------------------------------------------------
// APPJS — app.js (Vanilla JS, kein Framework). Bewusst mit einfachen
// Anfuehrungszeichen / String-Konkatenation, um Template-Literal-Escaping zu sparen.
// ---------------------------------------------------------------------------
export const APPJS = `'use strict';
(function () {
  // ===================== Konstanten & Zustand =====================
  var TOKEN_KEY = 'hub_token';
  var POLL_MS = 3000;

  var token = null;
  var pollTimer = null;
  var lastSync = 0;        // Zeitpunkt des letzten erfolgreichen State-Abrufs
  var online = true;
  var serverSkew = 0;      // serverTime - clientTime (fuer relative Zeiten)
  var expandedTasks = {};  // taskId -> true, wenn Detail aufgeklappt
  var doneOpen = false;
  var lastState = { agents: [], tasks: [], messages: [], coworkers: [] };

  // Gemeinsames Gedächtnis: bewusst getrennt vom Auto-Refresh, damit die
  // Tipp-Eingabe des Nutzers nicht ueberschrieben wird.
  var memOpen = false;
  var memLoaded = false;     // wurde der Text schon einmal geladen?
  var memLoadedVersion = null; // Version, die aktuell in der Textarea steht

  // ===================== Kleine DOM-Helfer =====================
  function el(id) { return document.getElementById(id); }

  function make(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // textContent => sicher gegen HTML-Injection
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function showToast(msg, isError) {
    var t = el('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ===================== Zeit-Formatierung =====================
  function serverNow() { return Date.now() + serverSkew; }

  function relTime(ts) {
    if (!ts) return '';
    var diff = Math.round((serverNow() - new Date(ts).getTime()) / 1000);
    if (diff < 0) diff = 0;
    if (diff < 5) return 'gerade eben';
    if (diff < 60) return 'vor ' + diff + ' Sek';
    var m = Math.round(diff / 60);
    if (m < 60) return 'vor ' + m + ' Min';
    var h = Math.round(m / 60);
    if (h < 24) return 'vor ' + h + ' Std';
    var d = Math.round(h / 24);
    return 'vor ' + d + ' T';
  }

  function absTime(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return ''; }
  }

  // ===================== API =====================
  function apiLogin(password, code) {
    return fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password, code: code })
    });
  }

  // Nutzer-Request mit Bearer-Token. Bei 401 -> ausloggen.
  function api(op, body) {
    return fetch('/api/user/' + op, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + token
      },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      if (r.status === 401) { logout(); throw new Error('unauthorized'); }
      return r.json().catch(function () { return {}; });
    });
  }

  // ===================== Login / Logout =====================
  function logout() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    token = null;
    stopPolling();
    el('dashboard').hidden = true;
    el('login-screen').hidden = false;
    var pw = el('login-password'); if (pw) pw.value = '';
    var cd = el('login-code'); if (cd) cd.value = '';
    // Memory-Zustand zuruecksetzen, damit ein erneuter Login frisch laedt.
    memOpen = false; memLoaded = false; memLoadedVersion = null;
    var mt = el('mem-toggle'); if (mt) mt.setAttribute('aria-expanded', 'false');
    var mb = el('mem-body'); if (mb) mb.hidden = true;
    var mn = el('mem-newer'); if (mn) mn.hidden = true;
  }

  function showDashboard() {
    el('login-screen').hidden = true;
    el('dashboard').hidden = false;
    refresh();
    startPolling();
  }

  function handleLogin(ev) {
    ev.preventDefault();
    var pw = el('login-password').value;
    var code = el('login-code').value.trim();
    var errEl = el('login-error');
    var btn = el('login-submit');
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Anmelden…';

    apiLogin(pw, code).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        return { status: r.status, data: data };
      });
    }).then(function (res) {
      if (res.status === 200 && res.data && res.data.token) {
        token = res.data.token;
        try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
        showDashboard();
      } else {
        var msg = (res.data && res.data.error) ? res.data.error :
                  (res.status === 429 ? 'Zu viele Versuche. Bitte kurz warten.' : 'Login fehlgeschlagen');
        errEl.textContent = msg;
        errEl.hidden = false;
      }
    }).catch(function () {
      errEl.textContent = 'Netzwerkfehler. Bitte erneut versuchen.';
      errEl.hidden = false;
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Anmelden';
    });
  }

  // ===================== Polling =====================
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (document.hidden) return; // im Hintergrund pausieren
      refresh();
    }, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function refresh() {
    if (!token) return;
    api('state', {}).then(function (state) {
      if (!state || typeof state !== 'object') return;
      online = true;
      lastSync = Date.now();
      if (state.serverTime) {
        serverSkew = new Date(state.serverTime).getTime() - Date.now();
      }
      lastState = {
        agents: Array.isArray(state.agents) ? state.agents : [],
        tasks: Array.isArray(state.tasks) ? state.tasks : [],
        messages: Array.isArray(state.messages) ? state.messages : [],
        coworkers: Array.isArray(state.coworkers) ? state.coworkers : [],
        // Falls der state eine Memory-Version mitliefert, durchreichen (optional).
        memory: state.memory,
        memoryVersion: state.memoryVersion
      };
      render(lastState);
      updateSyncStatus();
    }).catch(function (e) {
      if (e && e.message === 'unauthorized') return;
      online = false;
      updateSyncStatus();
    });
  }

  function updateSyncStatus() {
    var s = el('sync-status');
    if (!s) return;
    if (!online) {
      s.textContent = 'offline';
      s.classList.add('offline');
      return;
    }
    s.classList.remove('offline');
    var secs = Math.max(0, Math.round((Date.now() - lastSync) / 1000));
    s.textContent = 'aktualisiert vor ' + secs + 's';
  }

  // ===================== Render: Braucht Input =====================
  function renderInput(tasks, agents) {
    var section = el('section-input');
    var list = el('input-list');
    clear(list);

    var items = [];
    // Tasks mit needs_input
    tasks.forEach(function (t) {
      if (t.status === 'needs_input') {
        items.push({ kind: 'task', task: t, agent: findAgent(agents, t.agentId) });
      }
    });
    // Agenten mit needs_input, die nicht schon ueber einen Task abgedeckt sind
    var coveredAgents = {};
    tasks.forEach(function (t) { if (t.status === 'needs_input') coveredAgents[t.agentId] = true; });
    agents.forEach(function (a) {
      if (a.status === 'needs_input' && !coveredAgents[a.id]) {
        items.push({ kind: 'agent', agent: a });
      }
    });

    if (items.length === 0) { section.hidden = true; return; }
    section.hidden = false;

    items.forEach(function (it) {
      if (it.kind === 'task') list.appendChild(inputTaskCard(it.task, it.agent));
      else list.appendChild(inputAgentCard(it.agent));
    });
  }

  function inputTaskCard(task, agent) {
    var card = make('div', 'card');
    var head = make('div', 'card-head');
    var titleWrap = make('div');
    titleWrap.appendChild(make('p', 'card-title', task.title || 'Aufgabe'));
    var meta = make('p', 'card-meta', (agent ? agent.name : 'Agent') + ' · ' + relTime(task.updatedAt || task.createdAt));
    titleWrap.appendChild(meta);
    head.appendChild(titleWrap);
    head.appendChild(statusBadge(task.status));
    card.appendChild(head);

    if (task.question) {
      card.appendChild(make('p', 'card-question', task.question));
    }

    var ta = make('textarea', 'textarea');
    ta.rows = 2;
    ta.placeholder = 'Deine Antwort…';
    var row = make('div', 'reply-row');
    row.appendChild(ta);
    var actions = make('div', 'card-actions');
    var btn = make('button', 'btn btn-primary', 'Senden');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      btn.disabled = true;
      api('taskInput', { taskId: task.id, text: text }).then(function (r) {
        if (r && r.ok) { ta.value = ''; showToast('Antwort gesendet'); refresh(); }
        else { showToast('Konnte nicht senden', true); btn.disabled = false; }
      }).catch(function () { showToast('Netzwerkfehler', true); btn.disabled = false; });
    });
    actions.appendChild(btn);
    row.appendChild(actions);
    card.appendChild(row);
    return card;
  }

  function inputAgentCard(agent) {
    var card = make('div', 'card');
    var head = make('div', 'card-head');
    var titleWrap = make('div');
    titleWrap.appendChild(make('p', 'card-title', agent.name || 'Agent'));
    titleWrap.appendChild(make('p', 'card-meta', 'Wartet auf Eingabe · ' + relTime(agent.lastSeen)));
    head.appendChild(titleWrap);
    head.appendChild(statusBadge(agent.status));
    card.appendChild(head);

    if (agent.currentTask) {
      card.appendChild(make('p', 'card-question', agent.currentTask));
    }

    var ta = make('textarea', 'textarea');
    ta.rows = 2;
    ta.placeholder = 'Nachricht an ' + (agent.name || 'Agent') + '…';
    var row = make('div', 'reply-row');
    row.appendChild(ta);
    var actions = make('div', 'card-actions');
    var btn = make('button', 'btn btn-primary', 'Senden');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      btn.disabled = true;
      api('agentMessage', { agentId: agent.id, text: text }).then(function (r) {
        if (r && r.ok) { ta.value = ''; showToast('Nachricht gesendet'); refresh(); }
        else { showToast('Konnte nicht senden', true); btn.disabled = false; }
      }).catch(function () { showToast('Netzwerkfehler', true); btn.disabled = false; });
    });
    actions.appendChild(btn);
    row.appendChild(actions);
    card.appendChild(row);
    return card;
  }

  // ===================== Render: Aktive Aufgaben =====================
  function renderActive(tasks, agents) {
    var list = el('active-list');
    clear(list);
    var active = tasks.filter(function (t) { return t.status === 'working' || t.status === 'open'; });
    if (active.length === 0) {
      list.appendChild(make('div', 'empty', 'Keine aktiven Aufgaben.'));
      return;
    }
    active.forEach(function (t) {
      list.appendChild(taskCard(t, findAgent(agents, t.agentId), false));
    });
  }

  // ===================== Render: Erledigt =====================
  function renderDone(tasks, agents) {
    var list = el('done-list');
    var done = tasks.filter(function (t) { return t.status === 'done' || t.status === 'error'; });
    el('done-count').textContent = String(done.length);
    clear(list);
    if (done.length === 0) {
      list.appendChild(make('div', 'empty', 'Nichts erledigt.'));
    } else {
      done.forEach(function (t) {
        list.appendChild(taskCard(t, findAgent(agents, t.agentId), true));
      });
    }
    list.hidden = !doneOpen;
  }

  // Gemeinsame Task-Karte. deletable=true => Loeschen-Button (Erledigt).
  function taskCard(task, agent, deletable) {
    var card = make('div', 'card');
    var head = make('div', 'card-head');
    var titleWrap = make('div');
    titleWrap.appendChild(make('p', 'card-title', task.title || 'Aufgabe'));
    var metaText = (agent ? agent.name : 'Agent') + ' · ' + relTime(task.updatedAt || task.createdAt);
    titleWrap.appendChild(make('p', 'card-meta', metaText));
    head.appendChild(titleWrap);
    head.appendChild(statusBadge(task.status));
    card.appendChild(head);

    // Detail (Log) — antippbar
    var log = Array.isArray(task.log) ? task.log : [];
    var toggle = make('button', 'detail-toggle', null);
    toggle.type = 'button';
    var isOpen = !!expandedTasks[task.id];
    toggle.textContent = (isOpen ? '▾ Verlauf ausblenden' : '▸ Verlauf anzeigen') + ' (' + log.length + ')';
    var logBox = make('div', 'log');
    logBox.hidden = !isOpen;
    toggle.addEventListener('click', function () {
      expandedTasks[task.id] = !expandedTasks[task.id];
      var nowOpen = !!expandedTasks[task.id];
      logBox.hidden = !nowOpen;
      toggle.textContent = (nowOpen ? '▾ Verlauf ausblenden' : '▸ Verlauf anzeigen') + ' (' + log.length + ')';
    });
    card.appendChild(toggle);

    log.forEach(function (entry) {
      var e = make('div', 'log-entry');
      e.appendChild(make('span', 'log-who', entry.who || '—'));
      var body = make('div', 'log-body');
      body.appendChild(make('div', 'log-text', entry.text || ''));
      body.appendChild(make('div', 'log-ts', absTime(entry.ts)));
      e.appendChild(body);
      logBox.appendChild(e);
    });
    card.appendChild(logBox);

    if (deletable) {
      var actions = make('div', 'card-actions');
      var del = make('button', 'btn btn-danger', 'Löschen');
      del.type = 'button';
      del.addEventListener('click', function () {
        del.disabled = true;
        api('deleteTask', { taskId: task.id }).then(function (r) {
          if (r && r.ok) { showToast('Gelöscht'); refresh(); }
          else { showToast('Löschen fehlgeschlagen', true); del.disabled = false; }
        }).catch(function () { showToast('Netzwerkfehler', true); del.disabled = false; });
      });
      actions.appendChild(del);
      card.appendChild(actions);
    }
    return card;
  }

  // ===================== Render: Agenten =====================
  function renderAgents(agents) {
    var list = el('agents-list');
    clear(list);
    if (agents.length === 0) {
      list.appendChild(make('div', 'empty', 'Keine Agenten registriert.'));
      return;
    }
    agents.forEach(function (a) { list.appendChild(agentCard(a)); });
  }

  function agentCard(agent) {
    var card = make('div', 'card');
    var head = make('div', 'card-head');

    var left = make('div', 'agent-head');
    var dot = make('span', 'dot ' + (agent.online ? 'dot-online' : 'dot-offline'));
    left.appendChild(dot);
    left.appendChild(make('span', 'agent-name', agent.name || 'Agent'));
    head.appendChild(left);
    head.appendChild(statusBadge(agent.status));
    card.appendChild(head);

    var body = make('div', 'card-body');
    body.appendChild(kv('Host', agent.host || '—'));
    body.appendChild(kv('Modell', agent.model || '—'));
    if (agent.currentTask) body.appendChild(kv('Aufgabe', agent.currentTask));
    body.appendChild(kv('Gesehen', relTime(agent.lastSeen)));
    card.appendChild(body);

    var caps = Array.isArray(agent.capabilities) ? agent.capabilities : [];
    if (caps.length) {
      var chips = make('div', 'chips');
      caps.forEach(function (c) { chips.appendChild(make('span', 'chip', c)); });
      card.appendChild(chips);
    }

    // Befehl senden
    var ta = make('textarea', 'textarea');
    ta.rows = 2;
    ta.placeholder = 'Befehl senden…';
    var row = make('div', 'reply-row');
    row.appendChild(ta);
    var actions = make('div', 'card-actions');
    var btn = make('button', 'btn btn-primary', 'Befehl senden');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      btn.disabled = true;
      api('agentMessage', { agentId: agent.id, text: text }).then(function (r) {
        if (r && r.ok) { ta.value = ''; showToast('Befehl gesendet'); refresh(); }
        else { showToast('Konnte nicht senden', true); btn.disabled = false; }
      }).catch(function () { showToast('Netzwerkfehler', true); btn.disabled = false; });
    });
    actions.appendChild(btn);
    row.appendChild(actions);
    card.appendChild(row);
    return card;
  }

  function kv(k, v) {
    var row = make('div', 'kv');
    row.appendChild(make('span', 'k', k));
    row.appendChild(make('span', 'v', v));
    return row;
  }

  // ===================== Render: Coworker-Formular =====================
  function renderCoworkers(coworkers, agents) {
    var sel = el('cw-coworker');
    var actionSel = el('cw-action');
    var targetSel = el('cw-target');
    var empty = el('cw-empty');

    // Bisherige Auswahl merken, damit Polling die Auswahl nicht staendig zuruecksetzt
    var prevCw = sel.value;
    var prevAction = actionSel.value;
    var prevTarget = targetSel.value;

    clear(sel);
    if (!coworkers.length) {
      empty.hidden = false;
      el('cw-send').disabled = true;
    } else {
      empty.hidden = true;
      el('cw-send').disabled = false;
      coworkers.forEach(function (c) {
        var o = make('option', null, c.name);
        o.value = c.name;
        sel.appendChild(o);
      });
      if (prevCw) sel.value = prevCw;
    }

    // Aktions-Dropdown aus dem gewaehlten Coworker fuellen
    function fillActions() {
      clear(actionSel);
      var chosen = null;
      for (var i = 0; i < coworkers.length; i++) {
        if (coworkers[i].name === sel.value) { chosen = coworkers[i]; break; }
      }
      var acts = (chosen && Array.isArray(chosen.actions)) ? chosen.actions : [];
      if (!acts.length) {
        var o = make('option', null, '(keine Aktionen)');
        o.value = '';
        actionSel.appendChild(o);
      } else {
        acts.forEach(function (a) {
          var o = make('option', null, a);
          o.value = a;
          actionSel.appendChild(o);
        });
        if (prevAction) actionSel.value = prevAction;
      }
    }
    fillActions();
    // Aktionen bei Coworker-Wechsel neu befuellen (Handler einmalig setzen)
    sel.onchange = function () { prevAction = ''; fillActions(); };

    // Ziel-Agent-Dropdown
    clear(targetSel);
    var none = make('option', null, '— kein Ziel —');
    none.value = '';
    targetSel.appendChild(none);
    agents.forEach(function (a) {
      var o = make('option', null, a.name + (a.online ? '' : ' (offline)'));
      o.value = a.id;
      targetSel.appendChild(o);
    });
    if (prevTarget) targetSel.value = prevTarget;
  }

  function sendCoworkerCall() {
    var errEl = el('cw-error');
    errEl.hidden = true;
    var coworker = el('cw-coworker').value;
    var action = el('cw-action').value;
    var target = el('cw-target').value;
    var raw = el('cw-params').value.trim();

    if (!coworker) { errEl.textContent = 'Bitte einen Coworker wählen.'; errEl.hidden = false; return; }
    if (!action) { errEl.textContent = 'Bitte eine Aktion wählen.'; errEl.hidden = false; return; }

    var params = {};
    if (raw) {
      try {
        params = JSON.parse(raw);
        if (typeof params !== 'object' || params === null || Array.isArray(params)) {
          throw new Error('kein Objekt');
        }
      } catch (e) {
        errEl.textContent = 'Ungültiges JSON in den Parametern. Erwartet wird ein Objekt, z. B. { }.';
        errEl.hidden = false;
        return;
      }
    }

    var payload = { coworker: coworker, action: action, params: params };
    if (target) payload.targetAgentId = target;

    var btn = el('cw-send');
    btn.disabled = true;
    api('coworkerCall', payload).then(function (r) {
      if (r && r.ok) {
        showToast('Aktion ausgelöst' + (r.requestId ? ' (' + r.requestId + ')' : ''));
        el('cw-params').value = '';
        refresh();
      } else {
        showToast('Aktion fehlgeschlagen', true);
      }
    }).catch(function () {
      showToast('Netzwerkfehler', true);
    }).then(function () { btn.disabled = false; });
  }

  // ===================== Render: Feed =====================
  function feedIcon(kind) {
    switch (kind) {
      case 'system': return '⚙️';
      case 'task': return '📋';
      case 'input': return '✍️';
      case 'command': return '⌘';
      case 'peer': return '🔁';
      case 'coworker': return '🔌';
      default: return '•';
    }
  }

  function renderFeed(messages) {
    var list = el('feed-list');
    clear(list);
    if (!messages.length) {
      var li = make('li', 'empty', 'Noch keine Aktivität.');
      list.appendChild(li);
      return;
    }
    // Neueste zuerst (bereits so geliefert); auf 60 begrenzen
    messages.slice(0, 60).forEach(function (m) {
      var li = make('li', 'feed-item');
      li.appendChild(make('span', 'feed-icon', feedIcon(m.kind)));
      var body = make('div', 'feed-body');
      body.appendChild(make('div', 'feed-text', m.text || ''));
      body.appendChild(make('div', 'feed-time', relTime(m.ts)));
      li.appendChild(body);
      list.appendChild(li);
    });
  }

  // ===================== gemeinsame Helfer =====================
  function findAgent(agents, id) {
    for (var i = 0; i < agents.length; i++) { if (agents[i].id === id) return agents[i]; }
    return null;
  }

  function statusLabel(status) {
    switch (status) {
      case 'open': return 'offen';
      case 'working': return 'arbeitet';
      case 'needs_input': return 'braucht Input';
      case 'done': return 'erledigt';
      case 'error': return 'Fehler';
      case 'idle': return 'bereit';
      case 'offline': return 'offline';
      default: return status || '—';
    }
  }

  function statusBadge(status) {
    var b = make('span', 'badge badge-' + (status || 'idle'), statusLabel(status));
    return b;
  }

  // ===================== Gemeinsames Gedächtnis =====================
  // Meta-Zeile "Version X · zuletzt geändert von Y · vor Z" aktualisieren.
  function setMemMeta(mem) {
    var meta = el('mem-meta');
    if (!mem) { meta.textContent = 'Noch kein Text gespeichert.'; return; }
    var parts = [];
    if (mem.version != null) parts.push('Version ' + mem.version);
    if (mem.updatedBy) parts.push('zuletzt geändert von ' + mem.updatedBy);
    if (mem.updatedAt) parts.push(relTime(mem.updatedAt));
    meta.textContent = parts.length ? parts.join(' · ') : '—';
  }

  // Text laden — NUR beim ersten Öffnen bzw. per "Neu laden"-Button.
  function loadMemory(force) {
    var meta = el('mem-meta');
    var ta = el('mem-text');
    meta.textContent = 'Lade…';
    api('getMemory', {}).then(function (r) {
      var mem = (r && r.memory) ? r.memory : null;
      ta.value = mem && mem.text != null ? mem.text : '';
      memLoadedVersion = mem ? mem.version : null;
      memLoaded = true;
      setMemMeta(mem);
      el('mem-newer').hidden = true; // gerade frisch geladen => aktuell
      if (force) showToast('Neu geladen');
    }).catch(function (e) {
      if (e && e.message === 'unauthorized') return;
      meta.textContent = 'Konnte Gedächtnis nicht laden.';
      showToast('Laden fehlgeschlagen', true);
    });
  }

  function saveMemory() {
    var ta = el('mem-text');
    var btn = el('mem-save');
    btn.disabled = true;
    api('setMemory', { text: ta.value }).then(function (r) {
      if (r && r.ok) {
        memLoadedVersion = (r.version != null) ? r.version : memLoadedVersion;
        el('mem-newer').hidden = true; // eigene Version ist jetzt die neueste
        setMemMeta({ version: r.version, updatedBy: 'dir', updatedAt: new Date().toISOString() });
        showToast('Gespeichert (v' + (r.version != null ? r.version : '?') + ') – alle Claudes werden synchronisiert');
      } else {
        showToast('Speichern fehlgeschlagen', true);
      }
    }).catch(function (e) {
      if (e && e.message !== 'unauthorized') showToast('Netzwerkfehler', true);
    }).then(function () { btn.disabled = false; });
  }

  // Vom Auto-Refresh aufgerufen: nur dezent auf eine neuere Server-Version
  // hinweisen — die Textarea NICHT anfassen. Erwartet die serverseitige
  // Version aus dem state (falls geliefert).
  function noteMemoryVersion(serverVersion) {
    if (!memLoaded || serverVersion == null || memLoadedVersion == null) return;
    var badge = el('mem-newer');
    if (serverVersion > memLoadedVersion) {
      badge.textContent = 'Neuere Version v' + serverVersion + ' verfügbar – neu laden';
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  // ===================== Haupt-Render =====================
  function render(state) {
    renderInput(state.tasks, state.agents);
    renderActive(state.tasks, state.agents);
    renderDone(state.tasks, state.agents);
    renderAgents(state.agents);
    renderCoworkers(state.coworkers, state.agents);
    renderFeed(state.messages);
    // Textarea in Ruhe lassen — nur den Hinweis auf neuere Version pflegen,
    // falls der state eine Memory-Version mitliefert.
    if (state.memory && typeof state.memory === 'object') {
      noteMemoryVersion(state.memory.version);
    } else if (typeof state.memoryVersion !== 'undefined') {
      noteMemoryVersion(state.memoryVersion);
    }
  }

  // ===================== Event-Verdrahtung =====================
  function wire() {
    el('login-form').addEventListener('submit', handleLogin);
    el('logout-btn').addEventListener('click', logout);
    el('refresh-btn').addEventListener('click', refresh);

    // Erledigt einklappen/ausklappen
    el('done-toggle').addEventListener('click', function () {
      doneOpen = !doneOpen;
      el('done-toggle').setAttribute('aria-expanded', doneOpen ? 'true' : 'false');
      el('done-list').hidden = !doneOpen;
    });

    // Broadcast
    el('broadcast-send').addEventListener('click', function () {
      var ta = el('broadcast-text');
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      var btn = el('broadcast-send');
      btn.disabled = true;
      api('broadcast', { text: text }).then(function (r) {
        if (r && r.ok) { ta.value = ''; showToast('Broadcast gesendet'); refresh(); }
        else { showToast('Broadcast fehlgeschlagen', true); }
      }).catch(function () { showToast('Netzwerkfehler', true); })
        .then(function () { btn.disabled = false; });
    });

    // Coworker
    el('cw-send').addEventListener('click', sendCoworkerCall);

    // Gemeinsames Gedächtnis: ein-/ausklappen. Text NUR beim ersten Öffnen laden.
    el('mem-toggle').addEventListener('click', function () {
      memOpen = !memOpen;
      el('mem-toggle').setAttribute('aria-expanded', memOpen ? 'true' : 'false');
      el('mem-body').hidden = !memOpen;
      if (memOpen && !memLoaded) loadMemory(false);
    });
    el('mem-reload').addEventListener('click', function () { loadMemory(true); });
    el('mem-save').addEventListener('click', saveMemory);

    // Sofort refreshen bei Fenster-Fokus / Sichtbarkeit
    window.addEventListener('focus', function () { if (token) refresh(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && token) refresh();
    });

    // "aktualisiert vor Xs" laufend hochzaehlen
    setInterval(function () { if (token && !el('dashboard').hidden) updateSyncStatus(); }, 1000);
  }

  // ===================== Start =====================
  function init() {
    wire();
    try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { token = null; }
    if (token) showDashboard();
    else { el('login-screen').hidden = false; }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`;
