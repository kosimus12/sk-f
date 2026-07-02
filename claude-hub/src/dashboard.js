// dashboard.js — Frontend fuer das "Claude Hub"-Dashboard der SK Finanzberatung.
// Exportiert drei Strings: HTML (index.html), CSS (style.css), APPJS (app.js).
// Der Worker liefert sie unter /, /style.css und /app.js aus.
//
// Optik: angelehnt an die Design-Vorlage "Projekt-Cockpit" (helle Karten,
// Pills, Header mit Eyebrow/Greeting/Datum + Stat-Karten, Slide-over fuer
// Detail-Ansichten). Kein PIN-/FaceID-Lock — der bestehende Login
// (Passwort + 2FA, Token in localStorage 'hub_token') bleibt unveraendert.
//
// WICHTIG — strikte CSP (default-src 'self'; script-src 'self'; style-src 'self'):
//   - Kein Inline-<script>, kein Inline-<style>, keine style="..."/onclick="..."-Attribute.
//   - Alles Styling in CSS-Klassen, alle Events via addEventListener in app.js.
//   - element.style.xyz und classList per JS sind erlaubt.
//   - Keine externen Ressourcen (KEINE Google Fonts); System-Font-Kette.
//   - DOM nur via createElement/textContent (kein innerHTML mit ungeprueftem Text).
//
// Escaping-Hinweis: Weil diese Datei selbst Template-Literale nutzt, waeren in
// den enthaltenen Strings Backticks als \` und ${ als \${ zu escapen. HTML/CSS
// enthalten keine. In app.js wird bewusst mit einfachen Anfuehrungszeichen /
// Konkatenation gearbeitet, um Template-Literal-Escaping zu vermeiden.

// ---------------------------------------------------------------------------
// HTML — index.html (kein Inline-Script/Style, laedt /style.css und /app.js)
// ---------------------------------------------------------------------------
export const HTML = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#f5f6f8">
  <title>Claude Hub — SK Finanzberatung</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <!-- ==================== LOGIN ==================== -->
  <main id="login-screen" class="login-screen" aria-label="Anmeldung">
    <section class="login-card">
      <div class="login-badge" aria-hidden="true">SK</div>
      <div class="login-eyebrow">CLAUDE HUB</div>
      <h1 class="login-title">SK Finanzberatung</h1>
      <p class="login-sub">Melde dich an, um dein Hub zu steuern.</p>
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
    <div class="page">
      <!-- Header: Eyebrow, Greeting, Datum + 3 Stat-Karten -->
      <header class="hero">
        <div class="hero-head">
          <div class="hero-left">
            <div class="eyebrow">CLAUDE HUB</div>
            <h1 id="greeting" class="greeting">Hallo</h1>
            <div id="date-label" class="date-label"></div>
          </div>
          <div class="hero-stats">
            <div class="stat-card">
              <div id="stat-online" class="stat-value">0</div>
              <div class="stat-label">online</div>
            </div>
            <div class="stat-card">
              <div id="stat-needs" class="stat-value stat-warn">0</div>
              <div class="stat-label">braucht Input</div>
            </div>
            <div class="stat-card">
              <div id="stat-tasks" class="stat-value">0</div>
              <div class="stat-label">offene Aufgaben</div>
            </div>
          </div>
        </div>
        <div class="hero-bar">
          <span id="sync-status" class="sync-status" aria-live="polite">…</span>
          <button id="refresh-btn" class="btn btn-ghost btn-sm" type="button" title="Jetzt aktualisieren">Aktualisieren</button>
          <button id="logout-btn" class="btn btn-ghost btn-sm" type="button">Abmelden</button>
        </div>
      </header>

      <main class="content">
        <!-- Braucht deinen Input (wichtigster Bereich) -->
        <section id="section-input" class="section" hidden>
          <div class="card panel panel-alert">
            <div class="panel-head">
              <h2 class="panel-title">⚠️ Braucht deinen Input</h2>
              <span id="input-count-badge" class="pill pill-warn">0 offen</span>
            </div>
            <p class="section-hint">Diese Eingaben brauchen deine Agenten gerade von dir — direkt beantworten.</p>
            <div id="input-list" class="io-list"></div>
          </div>
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
              <span>✅ Erledigt</span>
              <span id="done-count" class="badge badge-muted">0</span>
            </button>
          </h2>
          <div id="done-list" class="card-list" hidden></div>
        </section>

        <!-- Meine Claudes (Agenten) -->
        <section class="section">
          <h2 class="section-title">🤖 Meine Claudes</h2>
          <div id="agents-list" class="card-grid"></div>
        </section>

        <!-- Meine Experten (Personas) -->
        <section class="section">
          <h2 class="section-title">🧑‍🚀 Meine Experten</h2>
          <p class="section-hint">Gib einer Experten-Persona eine Aufgabe — die Antwort erscheint als erledigte Aufgabe.</p>
          <div id="personas-list" class="card-grid"></div>
        </section>

        <!-- Chats & Sessions je Quelle -->
        <section class="section">
          <h2 class="section-title">💬 Chats &amp; Sessions</h2>
          <p class="section-hint">Chats und Claude-Code-Sessions je Quelle. Nur zur Ansicht.</p>
          <div id="sessions-list" class="sessions-list"></div>
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
  </div>

  <!-- Slide-over (Detail-Ansicht fuer Agenten/Aufgaben) -->
  <div id="slideover" class="slideover" hidden>
    <div id="so-backdrop" class="so-backdrop"></div>
    <aside class="so-panel" role="dialog" aria-modal="true" aria-labelledby="so-title">
      <div class="so-head">
        <div class="so-head-text">
          <div id="so-eyebrow" class="eyebrow"></div>
          <h2 id="so-title" class="so-title"></h2>
        </div>
        <button id="so-close" class="so-close" type="button" aria-label="Schließen">×</button>
      </div>
      <div id="so-pills" class="so-pills"></div>
      <div id="so-body" class="so-body ck-scroll"></div>
    </aside>
  </div>

  <!-- kleine Toast-Meldung -->
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>

  <script src="/app.js"></script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// CSS — style.css (mobile-first, Design-Tokens der Vorlage, Dark-Mode ergaenzt)
// ---------------------------------------------------------------------------
export const CSS = `:root {
  /* Flaechen */
  --bg: #f5f6f8;
  --surface: #ffffff;
  --surface-2: #fafbfc;
  --surface-3: #f7f8fa;
  --border: #e7e9ee;
  --border-2: #e2e5ea;
  --border-soft: #eef0f4;
  /* Text */
  --text: #16181d;
  --text-2: #2a2e38;
  --text-3: #4b5160;
  --muted: #8a90a0;
  --muted-2: #9aa1ad;
  /* Akzente */
  --primary: #4f46e5;
  --primary-hover: #4338ca;
  --primary-soft-bg: #eef0ff;
  --primary-soft-border: #dcdffb;
  --dark: #16181d;
  --ok: #16a34a;
  --ok-bg: #e7f6ee;
  --warn: #d97706;
  --warn-bg: #fdf2e6;
  --err: #dc2626;
  --err-bg: #fde8e8;
  --info: #2563eb;
  --token-green: #22c55e;
  /* Form */
  --radius: 16px;
  --radius-lg: 18px;
  --radius-sm: 11px;
  --radius-pill: 999px;
  --shadow: 0 1px 2px rgba(16, 18, 29, .06), 0 1px 3px rgba(16, 18, 29, .05);
  --shadow-btn: 0 1px 2px rgba(0, 0, 0, .08);
  --touch: 44px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1013;
    --surface: #17191f;
    --surface-2: #1c1f26;
    --surface-3: #1c1f26;
    --border: #2a2d35;
    --border-2: #333741;
    --border-soft: #262a32;
    --text: #e9eaee;
    --text-2: #d5d8de;
    --text-3: #b7bcc6;
    --muted: #8a90a0;
    --muted-2: #7f8695;
    --primary: #6366f1;
    --primary-hover: #7c7ff5;
    --primary-soft-bg: #23233a;
    --primary-soft-border: #33345a;
    --dark: #000000;
    --ok: #4ade80;
    --ok-bg: #12351f;
    --warn: #f59e0b;
    --warn-bg: #3a2a12;
    --err: #f87171;
    --err-bg: #3a1416;
    --info: #60a5fa;
    --shadow: 0 1px 3px rgba(0, 0, 0, .45);
    --shadow-btn: 0 1px 2px rgba(0, 0, 0, .4);
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
  -webkit-font-smoothing: antialiased;
}
body.no-scroll { overflow: hidden; }
::placeholder { color: var(--muted-2); }

button, input, select, textarea { font-family: inherit; font-size: 1rem; color: inherit; }

/* ---------- Buttons ---------- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--touch);
  padding: 11px 18px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: var(--surface-3);
  color: var(--text);
  cursor: pointer;
  font-weight: 600;
  font-size: .95rem;
  text-decoration: none;
  box-shadow: var(--shadow-btn);
  transition: background .12s ease, filter .12s ease, opacity .12s ease;
}
.btn:active { opacity: .88; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
.btn-primary:hover { background: var(--primary-hover); }
.btn-dark { background: var(--dark); color: #fff; border-color: var(--dark); }
.btn-dark:hover { filter: brightness(1.25); }
.btn-ghost {
  background: var(--surface);
  border-color: var(--border-2);
  color: var(--text-3);
  box-shadow: none;
}
.btn-ghost:hover { background: var(--surface-3); }
.btn-lg { min-height: 50px; width: 100%; font-size: 1.02rem; }
.btn-sm { min-height: 38px; padding: 8px 14px; font-size: .85rem; }
.btn-danger { background: var(--surface); color: var(--err); border-color: var(--border-2); box-shadow: none; }
.btn-danger:hover { background: var(--err-bg); }

/* ---------- Login (dunkel, zentriert) ---------- */
.login-screen {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--dark);
  color: #fff;
  padding: 32px 24px;
  padding-top: max(32px, env(safe-area-inset-top));
}
.login-card {
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}
.login-badge {
  width: 54px; height: 54px;
  border-radius: 16px;
  background: var(--primary);
  color: #fff;
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 20px;
  letter-spacing: .5px;
  margin-bottom: 20px;
}
.login-eyebrow {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: #8a90a0;
}
.login-title { margin: 6px 0 0; font-size: 22px; font-weight: 700; color: #fff; }
.login-sub { margin: 8px 0 26px; font-size: 14px; color: #9aa1ad; max-width: 280px; }
.login-form { width: 100%; display: flex; flex-direction: column; gap: 16px; }
.login-screen .field-label { color: #aab0bc; }
.login-screen input[type="text"], .login-screen input[type="password"] {
  background: #23252c;
  border: 1px solid #3a3d46;
  color: #fff;
}
.login-screen input:focus { outline: 2px solid var(--primary); outline-offset: 1px; border-color: var(--primary); }
.login-error {
  margin: 4px 0 0;
  color: #fff;
  font-size: .9rem;
  background: rgba(220, 38, 38, .18);
  border: 1px solid #dc2626;
  border-radius: 10px;
  padding: 9px 12px;
}

/* ---------- Felder ---------- */
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: .82rem; color: var(--muted); font-weight: 600; }
input[type="text"], input[type="password"], .textarea, .select {
  width: 100%;
  min-height: var(--touch);
  padding: 11px 13px;
  border: 1px solid var(--border-2);
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text);
}
.textarea { resize: vertical; min-height: 60px; line-height: 1.4; }
.mono { font-family: var(--mono); font-size: .9rem; }
input:focus, .textarea:focus, .select:focus, .btn:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
  border-color: var(--primary);
}
.field-error { color: var(--err); font-size: .85rem; margin: 4px 0 0; }

/* ---------- Seiten-Layout ---------- */
.page { max-width: 1080px; margin: 0 auto; padding: clamp(16px, 3vw, 32px); }

/* ---------- Header ---------- */
.hero { margin-bottom: 22px; }
.hero-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}
.eyebrow {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--muted);
}
.greeting {
  margin: 6px 0 0;
  font-size: clamp(26px, 3.4vw, 38px);
  font-weight: 700;
  letter-spacing: -.02em;
  line-height: 1.1;
}
.date-label { margin-top: 4px; color: var(--muted); font-size: 15px; }
.hero-stats { display: flex; gap: 10px; flex-wrap: wrap; }
.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 10px 16px;
  min-width: 92px;
  box-shadow: var(--shadow);
}
.stat-value { font-size: 24px; font-weight: 700; line-height: 1; }
.stat-value.stat-warn { color: var(--warn); }
.stat-label { font-size: 12px; color: var(--muted); margin-top: 3px; }
.hero-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}
.sync-status { flex: 1; font-size: .78rem; color: var(--muted); white-space: nowrap; }
.sync-status.offline { color: var(--err); }

/* ---------- Content / Sections ---------- */
.content { }
.section { margin-bottom: 30px; }
.section-title { font-size: 18px; margin: 0 0 14px; font-weight: 600; }
.section-hint { color: var(--muted-2); font-size: .82rem; margin: -8px 0 14px; line-height: 1.45; }

.section-title-toggle { margin: 0 0 14px; }
.collapse-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: var(--touch);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}
.chevron { display: inline-block; transition: transform .15s ease; color: var(--muted); }
.collapse-btn[aria-expanded="true"] .chevron,
.sess-collapse[aria-expanded="true"] .chevron { transform: rotate(90deg); }

/* ---------- Panel (Input-Bereich) ---------- */
.panel { padding: 20px 22px; border-radius: var(--radius-lg); }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
.panel-title { margin: 0; font-size: 18px; font-weight: 600; }

/* ---------- Karten ---------- */
.card-list { display: flex; flex-direction: column; gap: 12px; }
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 18px;
}
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.card-open { cursor: pointer; border-radius: 10px; margin: -4px; padding: 4px; }
.card-open:hover { background: var(--surface-3); }
.card-open:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.card-title-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.card-title { font-weight: 600; font-size: 16px; margin: 0; }
.open-chevron { color: #c2c7d0; font-size: 18px; line-height: 1; }
.card-meta { color: var(--muted); font-size: .8rem; margin-top: 3px; }
.card-body { margin-top: 10px; }
.card-question {
  margin: 10px 0 0;
  font-size: 14.5px;
  line-height: 1.4;
  color: var(--text-2);
}
.card-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; justify-content: flex-end; }
.broadcast-card .card-actions { margin-top: 10px; }
.reply-row { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }

/* ---------- Pills / Status ---------- */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding: 5px 11px;
  border-radius: var(--radius-pill);
  white-space: nowrap;
}
.pill-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: 0 0 7px; }
.pill-ok { background: var(--ok-bg); color: var(--ok); }
.pill-warn { background: var(--warn-bg); color: var(--warn); }
.pill-err { background: var(--err-bg); color: var(--err); }
.pill-info { background: var(--primary-soft-bg); color: var(--primary); }
.pill-muted { background: var(--surface-3); color: var(--text-3); border: 1px solid var(--border-soft); }

/* Zaehler-Badge (Erledigt / neuere Memory-Version) */
.badge {
  display: inline-block;
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  font-size: .72rem;
  font-weight: 700;
  white-space: nowrap;
}
.badge-muted { background: var(--surface-3); color: var(--muted); border: 1px solid var(--border); }
.badge-needs_input { background: var(--warn-bg); color: var(--warn); }

.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: 0 0 9px; }
.dot-online { background: var(--ok); }
.dot-offline { background: var(--muted); }

/* ---------- Input-Kacheln ("Braucht deinen Input") ---------- */
.io-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.io-card {
  border: 1px solid var(--border-soft);
  border-radius: 14px;
  padding: 15px;
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.io-eyebrow {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--warn);
}
.io-title { font-size: 14.5px; font-weight: 600; line-height: 1.3; margin-top: 4px; }
.io-question { font-size: 13px; color: var(--text-3); line-height: 1.45; margin-top: 2px; }
.io-meta { font-size: 12px; color: var(--muted-2); margin-top: 2px; }

/* ---------- Agenten ---------- */
.agent-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.agent-name { font-weight: 600; font-size: 16px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chip {
  display: inline-block;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  background: var(--surface-3);
  border: 1px solid var(--border-soft);
  color: var(--text-3);
  font-size: .74rem;
}
.kv { display: flex; gap: 8px; font-size: .86rem; margin-top: 3px; }
.kv .k { color: var(--muted); min-width: 68px; }
.kv .v { color: var(--text-2); }

/* ---------- Experten (Personas) ---------- */
.persona-role { font-size: 13px; color: var(--muted); margin-top: 3px; }
.persona-meta { display: flex; align-items: center; gap: 8px; margin-top: 10px; }

/* ---------- Chats & Sessions ---------- */
.sessions-list { display: flex; flex-direction: column; gap: 16px; }

/* Cowork-Projekte-Übersicht (ganz oben) */
.cowork-overview {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 16px 18px;
}
.cowork-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.cowork-title { font-size: 14px; font-weight: 600; }
.cowork-list { display: flex; flex-direction: column; gap: 6px; }
.cowork-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 11px;
  border-radius: 10px;
  background: var(--surface-3);
  border: 1px solid var(--border-soft);
}
.cowork-name { font-size: 13.5px; font-weight: 600; color: var(--text-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cowork-meta { display: flex; align-items: baseline; gap: 10px; flex: 0 0 auto; }
.cowork-count { font-size: 11.5px; color: var(--muted); }
.cowork-date { font-size: 12px; font-weight: 600; color: var(--text-3); white-space: nowrap; }

.source-block {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 16px 18px;
}
.source-head { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }
.source-title-wrap { display: flex; flex-direction: column; min-width: 0; }
.source-title { font-size: 15px; font-weight: 600; line-height: 1.2; }
.source-model { font-size: 12px; color: var(--muted); margin-top: 1px; }
.sess-groups { display: flex; flex-direction: column; gap: 14px; }
.sess-group { display: flex; flex-direction: column; }
.sess-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-3);
  background: transparent;
  border: none;
  text-align: left;
}
.sess-collapse { cursor: pointer; min-height: 38px; }
.sess-group-title { flex: 0 0 auto; }
.sess-count {
  font-size: .68rem;
  font-weight: 700;
  color: var(--muted);
  background: var(--surface-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-pill);
  padding: 1px 8px;
}

/* Projekt-Untergruppen (Kategorien) innerhalb einer Quelle */
.sess-proj-groups { display: flex; flex-direction: column; gap: 12px; }
.sess-proj-group { display: flex; flex-direction: column; }
.sess-proj-head { display: flex; align-items: baseline; gap: 8px; padding: 2px 0 7px; }
.sess-proj-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sess-proj-date { margin-left: auto; font-size: 11.5px; color: var(--muted); white-space: nowrap; }

.sess-list { display: flex; flex-direction: column; gap: 6px; }
.sess-row {
  padding: 9px 11px;
  border-radius: 10px;
  background: var(--surface-3);
  border: 1px solid var(--border-soft);
}
.sess-row-main { display: flex; align-items: baseline; gap: 8px; }
.sess-code { flex: 0 0 auto; font-size: 13px; line-height: 1; }
.sess-title {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sess-date { flex: 0 0 auto; font-size: 12px; font-weight: 600; color: var(--text-3); white-space: nowrap; }
.sess-sub { display: flex; align-items: center; gap: 8px; margin-top: 3px; flex-wrap: wrap; }
.sess-rel { font-size: 11px; color: var(--muted-2); white-space: nowrap; }
.sess-proj-badge {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-3);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-pill);
  padding: 1px 8px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- Slide-over ---------- */
.slideover { position: fixed; inset: 0; z-index: 60; }
.so-backdrop { position: absolute; inset: 0; background: rgba(20, 22, 28, .45); }
.so-panel {
  position: absolute;
  top: 0; right: 0; bottom: 0;
  width: min(440px, 100%);
  background: var(--bg);
  box-shadow: -12px 0 40px rgba(0, 0, 0, .2);
  display: flex;
  flex-direction: column;
  animation: soSlide .25s ease;
}
@keyframes soSlide { from { transform: translateX(100%); } to { transform: translateX(0); } }
.so-head {
  padding: 20px 22px;
  padding-top: max(20px, env(safe-area-inset-top));
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.so-head-text { min-width: 0; }
.so-title { margin: 5px 0 0; font-size: 22px; font-weight: 700; letter-spacing: -.01em; word-break: break-word; }
.so-close {
  flex: none;
  appearance: none;
  border: 1px solid var(--border-2);
  cursor: pointer;
  width: 34px; height: 34px;
  border-radius: 10px;
  background: var(--surface);
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
}
.so-close:hover { background: var(--surface-3); }
.so-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 14px 22px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.so-body { flex: 1; overflow-y: auto; padding: 22px; display: flex; flex-direction: column; gap: 22px; }
.so-section { }
.so-section-title { margin-bottom: 10px; font-size: 12px; }
.so-text { margin: 0; font-size: 14.5px; line-height: 1.55; color: var(--text-2); }
.so-empty { color: var(--muted-2); font-size: .9rem; }
.timeline { display: flex; flex-direction: column; gap: 12px; }
.tl-item { display: flex; gap: 11px; align-items: flex-start; }
.tl-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--primary); margin-top: 6px; }
.tl-body { min-width: 0; }
.tl-text { font-size: 14px; color: var(--text-2); line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
.tl-when { font-size: 12px; color: var(--muted-2); margin-top: 1px; }
.ck-scroll::-webkit-scrollbar { width: 8px; }
.ck-scroll::-webkit-scrollbar-thumb { background: var(--border-2); border-radius: 8px; }

/* ---------- Feed ---------- */
.feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.feed-item { display: flex; gap: 10px; padding: 9px 10px; border-radius: 10px; align-items: flex-start; }
.feed-item:nth-child(odd) { background: var(--surface); }
.feed-icon { flex: 0 0 22px; text-align: center; }
.feed-body { flex: 1; min-width: 0; }
.feed-text { font-size: .9rem; word-break: break-word; color: var(--text-2); }
.feed-time { color: var(--muted); font-size: .74rem; white-space: nowrap; }

/* ---------- Coworker-Formular ---------- */
.form-grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-bottom: 12px; }
@media (min-width: 620px) { .form-grid { grid-template-columns: 1fr 1fr 1fr; } }
.empty-note, .empty { color: var(--muted-2); font-size: .9rem; padding: 8px 2px; }

/* ---------- Gemeinsames Gedächtnis ---------- */
.mem-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.mem-meta-row .btn-ghost { color: var(--primary); }
.mem-textarea { min-height: 280px; line-height: 1.5; font-size: .9rem; -webkit-overflow-scrolling: touch; }

/* ---------- Footer / Toast ---------- */
.footer {
  padding: 20px 0 calc(20px + env(safe-area-inset-bottom));
  color: var(--muted);
  font-size: .8rem;
  text-align: center;
}
.toast {
  position: fixed;
  left: 50%;
  bottom: calc(20px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  background: var(--dark);
  color: #fff;
  padding: 11px 18px;
  border-radius: 12px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .25);
  z-index: 90;
  font-size: .9rem;
  max-width: 90vw;
}
.toast.error { background: var(--err); color: #fff; }

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
  var doneOpen = false;    // "Erledigt"-Sektion aufgeklappt?
  var sessOpen = {};       // srcKey -> true, wenn "Erledigt" einer Quelle offen
  var lastState = { agents: [], tasks: [], messages: [], coworkers: [], sessions: [], personas: [] };

  // Gemeinsames Gedächtnis: bewusst getrennt vom Auto-Refresh, damit die
  // Tipp-Eingabe des Nutzers nicht ueberschrieben wird.
  var memOpen = false;
  var memLoaded = false;       // wurde der Text schon einmal geladen?
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

  // Datum des letzten Chats: "Heute HH:MM", "Gestern", sonst "TT.MM.YYYY".
  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var now = new Date(serverNow());
    var sameDay = d.getFullYear() === now.getFullYear() &&
                  d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) {
      var hh = d.getHours(), mm = d.getMinutes();
      return 'Heute ' + (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    }
    var y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() &&
        d.getDate() === y.getDate()) return 'Gestern';
    try {
      return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
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
    closeSlideover();
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
    updateHeaderTime();
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
        sessions: Array.isArray(state.sessions) ? state.sessions : [],
        personas: Array.isArray(state.personas) ? state.personas : [],
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

  // ===================== Header (Greeting/Datum/Stats) =====================
  function updateHeaderTime() {
    var h = new Date().getHours();
    var greeting = h < 11 ? 'Guten Morgen' : (h < 18 ? 'Guten Tag' : 'Guten Abend');
    var g = el('greeting'); if (g) g.textContent = greeting;
    var d = el('date-label');
    if (d) {
      try {
        d.textContent = new Date().toLocaleDateString('de-DE',
          { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      } catch (e) { d.textContent = ''; }
    }
  }

  function updateHeaderStats(state, inputCount) {
    var onlineAgents = state.agents.filter(function (a) { return a.online; }).length;
    var openTasks = state.tasks.filter(function (t) {
      return t.status === 'open' || t.status === 'working';
    }).length;
    el('stat-online').textContent = String(onlineAgents);
    el('stat-needs').textContent = String(inputCount);
    el('stat-tasks').textContent = String(openTasks);
  }

  // ===================== Braucht Input =====================
  // Sammelt alle offenen Eingaben (Tasks + Agenten mit needs_input).
  function collectInputs(tasks, agents) {
    var items = [];
    var coveredAgents = {};
    tasks.forEach(function (t) {
      if (t.status === 'needs_input') {
        coveredAgents[t.agentId] = true;
        items.push({ kind: 'task', task: t, agent: findAgent(agents, t.agentId) });
      }
    });
    agents.forEach(function (a) {
      if (a.status === 'needs_input' && !coveredAgents[a.id]) {
        items.push({ kind: 'agent', agent: a });
      }
    });
    return items;
  }

  function renderInput(items) {
    var section = el('section-input');
    var list = el('input-list');
    clear(list);

    if (items.length === 0) { section.hidden = true; return; }
    section.hidden = false;
    el('input-count-badge').textContent = items.length + ' offen';

    items.forEach(function (it) {
      if (it.kind === 'task') list.appendChild(inputTaskCard(it.task, it.agent));
      else list.appendChild(inputAgentCard(it.agent));
    });
  }

  // Kleiner Helfer: Antwort-Zeile (Textarea + Senden) fuer Input-Kacheln.
  function replyBlock(placeholder, sendFn) {
    var ta = make('textarea', 'textarea');
    ta.rows = 2;
    ta.placeholder = placeholder;
    var row = make('div', 'reply-row');
    row.appendChild(ta);
    var actions = make('div', 'card-actions');
    var btn = make('button', 'btn btn-primary', 'Senden');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      btn.disabled = true;
      sendFn(text, function (ok) {
        if (ok) { ta.value = ''; }
        btn.disabled = false;
      });
    });
    actions.appendChild(btn);
    row.appendChild(actions);
    return row;
  }

  function inputTaskCard(task, agent) {
    var card = make('div', 'io-card');
    card.appendChild(make('div', 'io-eyebrow', 'INPUT NÖTIG · ' + (agent ? agent.name : 'Agent')));
    card.appendChild(make('div', 'io-title', task.title || 'Aufgabe'));
    if (task.question) card.appendChild(make('div', 'io-question', task.question));
    card.appendChild(make('div', 'io-meta', relTime(task.updatedAt || task.createdAt)));
    card.appendChild(replyBlock('Deine Antwort…', function (text, done) {
      api('taskInput', { taskId: task.id, text: text }).then(function (r) {
        if (r && r.ok) { showToast('Antwort gesendet'); done(true); refresh(); }
        else { showToast('Konnte nicht senden', true); done(false); }
      }).catch(function () { showToast('Netzwerkfehler', true); done(false); });
    }));
    return card;
  }

  function inputAgentCard(agent) {
    var card = make('div', 'io-card');
    card.appendChild(make('div', 'io-eyebrow', 'INPUT NÖTIG · ' + (agent.name || 'Agent')));
    card.appendChild(make('div', 'io-title', agent.currentTask || 'Wartet auf Eingabe'));
    card.appendChild(make('div', 'io-meta', relTime(agent.lastSeen)));
    card.appendChild(replyBlock('Nachricht an ' + (agent.name || 'Agent') + '…', function (text, done) {
      api('agentMessage', { agentId: agent.id, text: text }).then(function (r) {
        if (r && r.ok) { showToast('Nachricht gesendet'); done(true); refresh(); }
        else { showToast('Konnte nicht senden', true); done(false); }
      }).catch(function () { showToast('Netzwerkfehler', true); done(false); });
    }));
    return card;
  }

  // ===================== Aktive / Erledigte Aufgaben =====================
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

  // Task-Karte. Kopf ist antippbar und oeffnet den Slide-over (Verlauf/Timeline).
  // deletable=true => Loeschen-Button (Erledigt).
  function taskCard(task, agent, deletable) {
    var card = make('div', 'card');

    var head = make('div', 'card-head card-open');
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    var titleWrap = make('div');
    var titleRow = make('div', 'card-title-row');
    titleRow.appendChild(make('span', 'card-title', task.title || 'Aufgabe'));
    titleRow.appendChild(make('span', 'open-chevron', '›'));
    titleWrap.appendChild(titleRow);
    var log = Array.isArray(task.log) ? task.log : [];
    var metaText = (agent ? agent.name : 'Agent') + ' · ' + relTime(task.updatedAt || task.createdAt) +
                   ' · ' + log.length + ' Einträge';
    titleWrap.appendChild(make('div', 'card-meta', metaText));
    head.appendChild(titleWrap);
    head.appendChild(statusPill(task.status));
    head.addEventListener('click', function () { openTaskDetail(task, agent); });
    head.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openTaskDetail(task, agent); }
    });
    card.appendChild(head);

    if (task.question) card.appendChild(make('div', 'card-question', task.question));

    if (deletable) {
      var actions = make('div', 'card-actions');
      var del = make('button', 'btn btn-danger btn-sm', 'Löschen');
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

  // ===================== Agenten ("Meine Claudes") =====================
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

    var head = make('div', 'card-head card-open');
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    var left = make('div', 'agent-head');
    left.appendChild(make('span', 'dot ' + (agent.online ? 'dot-online' : 'dot-offline')));
    left.appendChild(make('span', 'agent-name', agent.name || 'Agent'));
    left.appendChild(make('span', 'open-chevron', '›'));
    head.appendChild(left);
    head.appendChild(statusPill(agent.status));
    head.addEventListener('click', function () { openAgentDetail(agent); });
    head.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openAgentDetail(agent); }
    });
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

    // Befehl senden (bleibt inline)
    card.appendChild(replyBlock('Befehl senden…', function (text, done) {
      api('agentMessage', { agentId: agent.id, text: text }).then(function (r) {
        if (r && r.ok) { showToast('Befehl gesendet'); done(true); refresh(); }
        else { showToast('Konnte nicht senden', true); done(false); }
      }).catch(function () { showToast('Netzwerkfehler', true); done(false); });
    }));
    return card;
  }

  function kv(k, v) {
    var row = make('div', 'kv');
    row.appendChild(make('span', 'k', k));
    row.appendChild(make('span', 'v', v));
    return row;
  }

  // ===================== Experten (Personas) =====================
  function renderPersonas(personas) {
    var list = el('personas-list');
    clear(list);
    if (!personas || !personas.length) {
      list.appendChild(make('div', 'empty-note',
        'Noch keine Experten gemeldet — die Mac-Brücke lädt sie aus ~/.claude-hub/personas/.'));
      return;
    }
    personas.forEach(function (p) { list.appendChild(personaCard(p)); });
  }

  function personaCard(persona) {
    var name = persona.name || persona.slug || 'Experte';
    var card = make('div', 'card');

    // Kopf: Name (fett), darunter Rolle
    var head = make('div', 'card-head');
    var titleWrap = make('div');
    titleWrap.appendChild(make('span', 'agent-name', name));
    if (persona.role) titleWrap.appendChild(make('div', 'persona-role', persona.role));
    head.appendChild(titleWrap);
    card.appendChild(head);

    // Meta: Online-Punkt + Modell als Chip
    var meta = make('div', 'persona-meta');
    meta.appendChild(make('span', 'dot ' + (persona.online ? 'dot-online' : 'dot-offline')));
    if (persona.model) meta.appendChild(make('span', 'chip', persona.model));
    card.appendChild(meta);

    // Aufgabe an die Persona geben -> runPersona
    var ta = make('textarea', 'textarea');
    ta.rows = 2;
    ta.placeholder = 'Aufgabe an ' + name + '…';
    var hint = make('p', 'field-error');
    hint.hidden = true;
    var row = make('div', 'reply-row');
    row.appendChild(ta);
    row.appendChild(hint);
    var actions = make('div', 'card-actions');
    var btn = make('button', 'btn btn-primary', 'Aufgabe geben');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      var task = ta.value.trim();
      if (!task) {
        hint.textContent = 'Bitte eine Aufgabe eingeben.';
        hint.hidden = false;
        ta.focus();
        return;
      }
      hint.hidden = true;
      btn.disabled = true;
      api('runPersona', { slug: persona.slug, task: task }).then(function (r) {
        if (r && r.ok) {
          ta.value = '';
          showToast('An ' + name + ' übergeben — die Antwort erscheint gleich unter „Aufgaben".');
          refresh();
        } else {
          showToast('Konnte Aufgabe nicht übergeben', true);
        }
      }).catch(function (e) {
        if (!e || e.message !== 'unauthorized') showToast('Netzwerkfehler', true);
      }).then(function () { btn.disabled = false; });
    });
    actions.appendChild(btn);
    row.appendChild(actions);
    card.appendChild(row);
    return card;
  }

  // ===================== Chats & Sessions je Quelle =====================
  function byLastActivityDesc(a, b) {
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  }

  // Distinct-Projekte aus einer Item-Liste: [{project, count, newest}] nach Datum sortiert.
  // fallbackLabel = Bezeichnung fuer Items ohne project (z.B. "Sonstige").
  function projectStats(items, fallbackLabel) {
    var map = {};
    items.forEach(function (it) {
      var key = it.project || '__none__';
      if (!map[key]) map[key] = { project: it.project || fallbackLabel, items: [], newest: 0 };
      map[key].items.push(it);
      if ((it.lastActivity || 0) > map[key].newest) map[key].newest = it.lastActivity || 0;
    });
    var arr = Object.keys(map).map(function (k) { return map[k]; });
    arr.forEach(function (grp) { grp.items.sort(byLastActivityDesc); });
    arr.sort(function (a, b) { return b.newest - a.newest; });
    return arr;
  }

  function renderSessions(sessions) {
    var wrap = el('sessions-list');
    clear(wrap);
    // Cowork-Projekte-Übersicht immer zuerst (zeigt auch den Leer-Hinweis).
    wrap.appendChild(coworkOverview(sessions || []));
    if (!sessions || !sessions.length) {
      wrap.appendChild(make('div', 'empty-note',
        'Noch keine Chats gemeldet — die Brücke sammelt sie beim nächsten Lauf.'));
      return;
    }
    sessions.forEach(function (src) { wrap.appendChild(sourceBlock(src)); });
  }

  // Kompakte Übersicht aller distinct Cowork-Projekte (kind=="cowork") über alle Quellen.
  function coworkOverview(sessions) {
    var coworkItems = [];
    sessions.forEach(function (src) {
      (Array.isArray(src.items) ? src.items : []).forEach(function (it) {
        if (it.kind === 'cowork') coworkItems.push(it);
      });
    });
    var card = make('div', 'cowork-overview');
    var head = make('div', 'cowork-head');
    head.appendChild(make('span', 'cowork-title', '🗂 Cowork-Projekte'));
    card.appendChild(head);

    var stats = projectStats(coworkItems, 'Sonstige');
    if (!stats.length) {
      card.appendChild(make('div', 'empty-note',
        'Cowork-Projekte erscheinen, sobald die Brücke sie lokal findet.'));
      return card;
    }
    var list = make('div', 'cowork-list');
    stats.forEach(function (p) {
      var row = make('div', 'cowork-row');
      row.appendChild(make('span', 'cowork-name', p.project));
      var meta = make('span', 'cowork-meta');
      meta.appendChild(make('span', 'cowork-count', p.items.length + (p.items.length === 1 ? ' Chat' : ' Chats')));
      meta.appendChild(make('span', 'cowork-date', fmtDate(p.newest)));
      row.appendChild(meta);
      list.appendChild(row);
    });
    card.appendChild(list);
    return card;
  }

  function sourceBlock(src) {
    var block = make('div', 'source-block');

    var head = make('div', 'source-head');
    head.appendChild(make('span', 'dot ' + (src.online ? 'dot-online' : 'dot-offline')));
    var titleWrap = make('div', 'source-title-wrap');
    titleWrap.appendChild(make('span', 'source-title', src.name || 'Quelle'));
    var metaBits = [];
    if (src.model) metaBits.push(src.model);
    if (src.updatedAt) metaBits.push(relTime(src.updatedAt));
    if (metaBits.length) titleWrap.appendChild(make('span', 'source-model', metaBits.join(' · ')));
    head.appendChild(titleWrap);
    block.appendChild(head);

    var items = Array.isArray(src.items) ? src.items : [];
    // Aufteilung: Angeheftet (projektübergreifend, oben) > Erledigt (einklappbar) > Offen (nach Projekt).
    var pinned = items.filter(function (it) { return it.pinned; }).sort(byLastActivityDesc);
    var rest = items.filter(function (it) { return !it.pinned; });
    var doneItems = rest.filter(function (it) { return it.status === 'done'; }).sort(byLastActivityDesc);
    var openItems = rest.filter(function (it) { return it.status !== 'done'; });

    var srcKey = (src.agentId || '') + '|' + (src.source || src.name || '');

    var groups = make('div', 'sess-groups');

    // 📌 Angeheftet — projektübergreifend, mit Projekt-Badge je Zeile.
    var g = sessGroup('📌', 'Angeheftet', pinned, { showProject: true });
    if (g) groups.appendChild(g);

    // Offene Chats nach Projekt gruppiert (Projekt = Kategorie), Projekte nach jüngstem Chat.
    var projGroups = projectStats(openItems, 'Sonstige');
    if (projGroups.length) {
      var projWrap = make('div', 'sess-proj-groups');
      projGroups.forEach(function (p) { projWrap.appendChild(projectSubgroup(p)); });
      groups.appendChild(projWrap);
    }

    // ✅ Erledigt — einklappbar, projektübergreifend, mit Projekt-Badge.
    g = sessGroup('✅', 'Erledigt', doneItems, { collapsible: true, stateKey: srcKey, showProject: true });
    if (g) groups.appendChild(g);

    if (!groups.firstChild) groups.appendChild(make('div', 'empty-note', 'Keine Einträge.'));
    block.appendChild(groups);
    return block;
  }

  // Projekt-Untergruppe: Unterüberschrift (Name + Anzahl + jüngstes Datum) + Zeilen.
  function projectSubgroup(p) {
    var wrap = make('div', 'sess-proj-group');
    var head = make('div', 'sess-proj-head');
    head.appendChild(make('span', 'sess-proj-name', p.project));
    head.appendChild(make('span', 'sess-count', String(p.items.length)));
    head.appendChild(make('span', 'sess-proj-date', fmtDate(p.newest)));
    wrap.appendChild(head);
    var list = make('div', 'sess-list');
    // innerhalb des Projekts nach lastActivity absteigend (bereits vorsortiert)
    p.items.forEach(function (it) { list.appendChild(sessRow(it, false)); });
    wrap.appendChild(list);
    return wrap;
  }

  // Gruppe (Angeheftet / Erledigt). opts.collapsible => einklappbar; opts.showProject => Projekt-Badge je Zeile.
  function sessGroup(emoji, label, items, opts) {
    if (!items.length) return null;
    opts = opts || {};
    var g = make('div', 'sess-group');
    var count = make('span', 'sess-count', String(items.length));
    var list = make('div', 'sess-list');
    items.forEach(function (it) { list.appendChild(sessRow(it, !!opts.showProject)); });

    var head;
    if (opts.collapsible) {
      var isOpen = !!sessOpen[opts.stateKey];
      head = make('button', 'sess-group-head sess-collapse');
      head.type = 'button';
      head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      head.appendChild(make('span', 'chevron', '▸'));
      head.appendChild(make('span', 'sess-group-title', emoji + ' ' + label));
      head.appendChild(count);
      list.hidden = !isOpen;
      head.addEventListener('click', function () {
        sessOpen[opts.stateKey] = !sessOpen[opts.stateKey];
        var no = !!sessOpen[opts.stateKey];
        head.setAttribute('aria-expanded', no ? 'true' : 'false');
        list.hidden = !no;
      });
    } else {
      head = make('div', 'sess-group-head');
      head.appendChild(make('span', 'sess-group-title', emoji + ' ' + label));
      head.appendChild(count);
    }
    g.appendChild(head);
    g.appendChild(list);
    return g;
  }

  // Chat-Zeile: [🧑‍💻 bei Claude Code] Titel … Datum(fmtDate); darunter relTime + optional Projekt-Badge.
  function sessRow(it, showProject) {
    var row = make('div', 'sess-row');
    var main = make('div', 'sess-row-main');
    if (it.kind === 'code') {
      var mark = make('span', 'sess-code', '🧑‍💻');
      mark.title = 'Claude Code';
      main.appendChild(mark);
    }
    main.appendChild(make('span', 'sess-title', it.title || '(ohne Titel)'));
    main.appendChild(make('span', 'sess-date', fmtDate(it.lastActivity)));
    row.appendChild(main);

    var sub = make('div', 'sess-sub');
    var rel = relTime(it.lastActivity);
    if (rel) sub.appendChild(make('span', 'sess-rel', rel));
    if (showProject) {
      if (it.project) sub.appendChild(make('span', 'sess-proj-badge', it.project));
      else if (it.kind === 'code') sub.appendChild(make('span', 'sess-proj-badge', 'Claude Code'));
    }
    if (sub.firstChild) row.appendChild(sub);
    return row;
  }

  // ===================== Slide-over (Detail-Ansicht) =====================
  function openSlideover() {
    el('slideover').hidden = false;
    document.body.classList.add('no-scroll');
  }
  function closeSlideover() {
    el('slideover').hidden = true;
    document.body.classList.remove('no-scroll');
  }

  // "Letzte Aktivität"-Timeline aus [{text, who, when}].
  function timelineSection(title, entries) {
    var wrap = make('div', 'so-section');
    wrap.appendChild(make('div', 'so-section-title eyebrow', title));
    if (!entries.length) {
      wrap.appendChild(make('div', 'so-empty', 'Noch keine Aktivität.'));
      return wrap;
    }
    var tl = make('div', 'timeline');
    entries.forEach(function (e) {
      var item = make('div', 'tl-item');
      item.appendChild(make('span', 'tl-dot'));
      var b = make('div', 'tl-body');
      b.appendChild(make('div', 'tl-text', e.text || ''));
      var meta = [];
      if (e.who) meta.push(e.who);
      if (e.when) meta.push(e.when);
      if (meta.length) b.appendChild(make('div', 'tl-when', meta.join(' · ')));
      item.appendChild(b);
      tl.appendChild(item);
    });
    wrap.appendChild(tl);
    return wrap;
  }

  function mutedPill(label) { return make('span', 'pill pill-muted', label); }

  function openTaskDetail(task, agent) {
    el('so-eyebrow').textContent = agent ? (agent.name || 'Agent') : 'Aufgabe';
    el('so-title').textContent = task.title || 'Aufgabe';

    var pills = el('so-pills');
    clear(pills);
    pills.appendChild(statusPill(task.status));
    var rel = relTime(task.updatedAt || task.createdAt);
    if (rel) pills.appendChild(mutedPill('🕘 ' + rel));

    var body = el('so-body');
    clear(body);
    if (task.question) {
      var q = make('div', 'so-section');
      q.appendChild(make('div', 'so-section-title eyebrow', 'Frage'));
      q.appendChild(make('p', 'so-text', task.question));
      body.appendChild(q);
    }
    var log = Array.isArray(task.log) ? task.log.slice() : [];
    log.reverse(); // neueste zuerst
    var entries = log.map(function (e) {
      return { text: e.text || '', who: e.who || '', when: absTime(e.ts) };
    });
    body.appendChild(timelineSection('Letzte Aktivität', entries));
    openSlideover();
  }

  function openAgentDetail(agent) {
    el('so-eyebrow').textContent = agent.host || 'Agent';
    el('so-title').textContent = agent.name || 'Agent';

    var pills = el('so-pills');
    clear(pills);
    var onlinePill = make('span', 'pill ' + (agent.online ? 'pill-ok' : 'pill-muted'));
    onlinePill.appendChild(make('span', 'pill-dot'));
    onlinePill.appendChild(document.createTextNode(agent.online ? 'online' : 'offline'));
    pills.appendChild(onlinePill);
    pills.appendChild(statusPill(agent.status));
    if (agent.model) pills.appendChild(mutedPill(agent.model));

    var body = el('so-body');
    clear(body);

    var info = make('div', 'so-section');
    info.appendChild(make('div', 'so-section-title eyebrow', 'Überblick'));
    info.appendChild(kv('Host', agent.host || '—'));
    info.appendChild(kv('Modell', agent.model || '—'));
    if (agent.currentTask) info.appendChild(kv('Aufgabe', agent.currentTask));
    info.appendChild(kv('Gesehen', relTime(agent.lastSeen) || '—'));
    body.appendChild(info);

    var caps = Array.isArray(agent.capabilities) ? agent.capabilities : [];
    if (caps.length) {
      var capSec = make('div', 'so-section');
      capSec.appendChild(make('div', 'so-section-title eyebrow', 'Fähigkeiten'));
      var chips = make('div', 'chips');
      caps.forEach(function (c) { chips.appendChild(make('span', 'chip', c)); });
      capSec.appendChild(chips);
      body.appendChild(capSec);
    }

    // "Letzte Aktivität" = Logs aller Aufgaben dieses Agenten, neueste zuerst.
    var acts = [];
    lastState.tasks.forEach(function (t) {
      if (t.agentId === agent.id && Array.isArray(t.log)) {
        t.log.forEach(function (e) {
          acts.push({ text: e.text || '', who: e.who || '', ts: e.ts });
        });
      }
    });
    acts.sort(function (a, b) {
      return (new Date(b.ts).getTime() || 0) - (new Date(a.ts).getTime() || 0);
    });
    var entries = acts.slice(0, 25).map(function (e) {
      return { text: e.text, who: e.who, when: absTime(e.ts) };
    });
    body.appendChild(timelineSection('Letzte Aktivität', entries));
    openSlideover();
  }

  // ===================== Coworker-Formular =====================
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
          var oo = make('option', null, a);
          oo.value = a;
          actionSel.appendChild(oo);
        });
        if (prevAction) actionSel.value = prevAction;
      }
    }
    fillActions();
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

  // ===================== Feed =====================
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
      list.appendChild(make('li', 'empty', 'Noch keine Aktivität.'));
      return;
    }
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

  // ===================== Gemeinsame Helfer =====================
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
      case 'active': return 'aktiv';
      default: return status || '—';
    }
  }

  function pillClass(status) {
    switch (status) {
      case 'working':
      case 'active': return 'pill-ok';
      case 'open': return 'pill-info';
      case 'needs_input': return 'pill-warn';
      case 'error': return 'pill-err';
      case 'done':
      case 'idle':
      case 'offline':
      default: return 'pill-muted';
    }
  }

  // Status-Pill mit farbigem Punkt (wie die Projektkarten der Vorlage).
  function statusPill(status) {
    var p = make('span', 'pill ' + pillClass(status));
    p.appendChild(make('span', 'pill-dot'));
    p.appendChild(document.createTextNode(statusLabel(status)));
    return p;
  }

  // ===================== Gemeinsames Gedächtnis =====================
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
        el('mem-newer').hidden = true;
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
  // hinweisen — die Textarea NICHT anfassen.
  function noteMemoryVersion(serverVersion) {
    if (!memLoaded || serverVersion == null || memLoadedVersion == null) return;
    var badge = el('mem-newer');
    if (serverVersion > memLoadedVersion) {
      badge.textContent = 'Neuere Version v' + serverVersion + ' – neu laden';
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  // ===================== Haupt-Render =====================
  function render(state) {
    updateHeaderTime();
    var inputs = collectInputs(state.tasks, state.agents);
    updateHeaderStats(state, inputs.length);
    renderInput(inputs);
    renderActive(state.tasks, state.agents);
    renderDone(state.tasks, state.agents);
    renderAgents(state.agents);
    renderPersonas(state.personas);
    renderSessions(state.sessions);
    renderCoworkers(state.coworkers, state.agents);
    renderFeed(state.messages);
    // Textarea in Ruhe lassen — nur den Hinweis auf neuere Version pflegen.
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

    // Slide-over schliessen (Backdrop, X-Button, Escape)
    el('so-backdrop').addEventListener('click', closeSlideover);
    el('so-close').addEventListener('click', closeSlideover);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !el('slideover').hidden) closeSlideover();
    });

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
