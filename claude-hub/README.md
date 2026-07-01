# Claude Hub

Ein sicheres Dashboard, um mehrere **Claude-Code-Instanzen** (z.B. auf deinem
Mac und auf einem Hetzner-Server) von deinem **iPhone oder Browser** aus zu
sehen und zu steuern. Die einzelnen Claude-Agenten können sich außerdem
**untereinander abstimmen** und über **Coworker/MCP-Dienste** (Gmail, Kalender,
Drive, GitHub …) Aufgaben orchestrieren.

Das System besteht aus:

- einem **Cloudflare Worker mit Durable Object** (der "Hub" – Dashboard + API),
- einem **Brücken-Agenten** (`claude-bridge.mjs`), der auf jedem Rechner läuft
  und die lokale Claude-Code-Session mit dem Hub verbindet.

---

## 1. Was ist das (kurz)

- Du öffnest im Browser (auch am iPhone) ein passwort- und 2FA-geschütztes
  Dashboard.
- Dort siehst du alle deine Claude-Agenten: ob sie **arbeiten**, **auf Input
  warten** oder **offline** sind, und woran sie gerade arbeiten.
- Du kannst einem Agenten **antworten** (Input geben), **Befehle** schicken,
  Aufgaben an einen **günstigeren Agenten** delegieren (Tokens sparen) und
  zusehen, wie Agenten sich gegenseitig **Coworker-Aktionen** (z.B. "durchsuche
  Gmail") auftragen.
- Der Brücken-Agent tippt eingehende Nachrichten automatisch in die laufende
  Claude-Code-Session (per `tmux`), und meldet über **Hooks** zurück, wenn
  Claude auf eine Eingabe wartet oder fertig ist.

---

## 2. Architektur (in Textform)

```
   iPhone / Browser
        │  (HTTPS, Passwort + 2FA)
        ▼
 ┌──────────────────────────────┐
 │  Cloudflare Worker (Hub)      │
 │  + Durable Object (Zustand)   │   ← Dashboard-UI + /api/agent/* Endpunkte
 │  Agenten-Registry, Inbox,     │
 │  Aufgaben, Coworker-Routing   │
 └──────────────────────────────┘
        ▲                    ▲
        │ x-agent-token      │ x-agent-token
        │ (HTTPS)            │ (HTTPS)
        │                    │
 ┌──────────────┐     ┌──────────────┐
 │ Bridge (Mac) │     │Bridge(Hetzner)│   ← claude-bridge.mjs
 │ Kontroll-Port│     │ Kontroll-Port │      (nur 127.0.0.1:4599)
 │  127.0.0.1   │     │  127.0.0.1    │
 └──────────────┘     └──────────────┘
        │  tmux send-keys      │  tmux send-keys
        ▼                      ▼
 ┌──────────────┐     ┌──────────────┐
 │ tmux: claude │     │ tmux: claude │   ← laufende Claude-Code-Session
 │ (Opus)       │     │ (Opus 4.6)   │
 └──────────────┘     └──────────────┘
        │  Hooks (notify.sh / stop.sh)  → melden Status an Kontroll-Port
        ▼
   Coworker / MCP-Dienste (Gmail, Kalender, Drive, GitHub …)
   Ein Agent kann per Hub eine Coworker-Aktion bei einem fähigen
   Agenten anfordern; das Ergebnis läuft über den Hub zurück.
```

---

## 3. Voraussetzungen

- **Node.js 18 oder neuer** (die Bridge nutzt das eingebaute `fetch`, keine
  npm-Pakete).
  - Prüfen: `node --version`
- **Wrangler** (Cloudflare-CLI): `npm i -g wrangler`
- Ein **Cloudflare-Konto** (der kostenlose Plan reicht).
- Einmalig anmelden: `wrangler login`

---

## 4. Schritt für Schritt: Hub deployen

Alles im Ordner `claude-hub`:

```bash
cd claude-hub

# 1) Secrets erzeugen (Passwort wählen, wenn gefragt)
node scripts/setup-secrets.mjs
```

Das Skript zeigt dir vier Werte (HUB_SECRET, AGENT_TOKEN, TOTP_SECRET,
DASHBOARD_PASSWORD) und die passenden Befehle. Führe die **vier
`wrangler secret put`-Befehle** aus und füge jeweils den angezeigten Wert ein:

```bash
wrangler secret put HUB_SECRET
wrangler secret put AGENT_TOKEN
wrangler secret put TOTP_SECRET
wrangler secret put DASHBOARD_PASSWORD
```

Dann den Worker veröffentlichen:

```bash
wrangler deploy
```

Am Ende zeigt wrangler die **URL** an, z.B.
`https://claude-hub.DEINSUB.workers.dev`. **Notiere sie** – das ist deine
`HUB_URL`.

> **Wichtig:** Bewahre den **AGENT_TOKEN** auf. Ihn brauchst du gleich für jede
> Bridge.

> **Optional (Telegram):** Wenn du später Telegram als Hauptkanal nutzen willst
> (Abschnitt 11), setzt du zusätzlich drei Secrets: `TELEGRAM_BOT_TOKEN`,
> `TELEGRAM_WEBHOOK_SECRET` und `TELEGRAM_ALLOWED_CHAT`. Details in Abschnitt 11.

### Optional: eigene Subdomain

Wenn deine Domain (z.B. `sk-finanzberatung.de`) bei Cloudflare liegt, kannst du
im Cloudflare-Dashboard unter **Workers & Pages → dein Worker → Settings →
Domains & Routes** eine eigene Adresse wie `hub.sk-finanzberatung.de`
hinzufügen. Diese URL nutzt du dann als `HUB_URL`.

---

## 5. 2FA einrichten

Das Setup-Skript hat eine **otpauth-URL** und ein **Base32-Secret** ausgegeben.

- Öffne **Google Authenticator**, **1Password** oder **Authy**.
- Entweder die otpauth-URL als QR-Code importieren, **oder** das Base32-Secret
  manuell als "zeitbasiertes/TOTP"-Konto eintippen (Konto: `Claude Hub:admin`,
  30 Sekunden, 6 Stellen).

Beim Login ins Dashboard gibst du dann **Passwort + den aktuellen 6-stelligen
Code** ein.

---

## 6. Bridge auf dem Mac installieren

```bash
cd claude-hub
bash bridge/install.sh
```

Das Skript fragt nach:

- `HUB_URL` (die Worker-URL von oben)
- `AGENT_TOKEN` (aus dem Setup)
- `AGENT_NAME` (z.B. `Mac-Claude`)
- `AGENT_HOST` (z.B. `mac`)
- `AGENT_MODEL` (z.B. `Opus 4.8`)
- `CAPABILITIES` (Kommaliste, z.B. `gmail,calendar,drive,github`)
- `TMUX_TARGET` (z.B. `claude:0.0` – siehe unten)

Es schreibt `~/.claude-hub/config.json` (nur für dich lesbar, `chmod 600`).

**Claude in tmux starten** (damit die Bridge Eingaben hineintippen kann):

```bash
tmux new -s claude     # neue tmux-Sitzung namens "claude"
# darin dann Claude Code starten:
claude
```

Das tmux-Ziel `claude:0.0` bedeutet: Sitzung `claude`, Fenster `0`, Pane `0`.
Trage es in `~/.claude-hub/config.json` bei `TMUX_TARGET` ein (macht das
install.sh bereits, wenn du es angibst).

**Bridge starten** (zum Testen im Vordergrund):

```bash
node bridge/claude-bridge.mjs
```

Du solltest sehen: `Registriert als Mac-Claude@mac ...` und
`Kontroll-Endpunkt: http://127.0.0.1:4599`.

**Als Dienst einrichten (dauerhaft):** `install.sh` druckt ein fertiges
**launchd-plist**-Beispiel für macOS. Datei anlegen und laden:

```bash
launchctl load -w ~/Library/LaunchAgents/de.claude-hub.bridge.plist
launchctl start de.claude-hub.bridge
```

---

## 7. Bridge auf Hetzner (per SSH)

Per SSH auf den Server verbinden und genauso vorgehen:

```bash
ssh dein-user@dein-hetzner-server
# Node 18+ sicherstellen (node --version)
cd /pfad/zu/claude-hub
AGENT_NAME=Hetzner-Claude AGENT_HOST=hetzner AGENT_MODEL="Opus 4.6" \
  CAPABILITIES="gmail,calendar,drive,github" TMUX_TARGET="claude:0.0" \
  HUB_URL="https://claude-hub.DEINSUB.workers.dev" AGENT_TOKEN="<DEIN_TOKEN>" \
  bash bridge/install.sh
```

Claude wieder in tmux starten:

```bash
tmux new -s claude
claude
```

**Als Dienst (Linux):** `install.sh` druckt ein **systemd-user-Service**-Beispiel.
Datei anlegen, dann:

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-bridge.service
loginctl enable-linger $USER   # Bridge läuft auch ohne aktive SSH-Sitzung weiter
```

> Tipp: Für den Hetzner-Agenten das günstigere Modell **Opus 4.6** eintragen,
> um bei delegierten Aufgaben Tokens zu sparen.

---

## 8. Claude-Code-Hooks aktivieren

Damit im Dashboard automatisch "**braucht Input**" bzw. "**fertig**" erscheint,
verbinde die Hooks. `install.sh` druckt dir den passenden Schnipsel mit
**absoluten Pfaden**. Füge ihn in deine `.claude/settings.json` ein (im
Projektordner `.claude/settings.json` oder global `~/.claude/settings.json`):

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [ { "type": "command", "command": "/ABSOLUTER/PFAD/claude-hub/bridge/hooks/notify.sh" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "/ABSOLUTER/PFAD/claude-hub/bridge/hooks/stop.sh" } ] }
    ]
  }
}
```

- **notify.sh** meldet `needs_input`, wenn Claude eine Rückfrage stellt.
- **stop.sh** meldet `done`, wenn Claude die Antwort abgeschlossen hat.

Beide Hooks sind fehlertolerant und blockieren Claude nie.

---

## 9. Nutzung

**Was sehe ich im Dashboard?**
Alle Agenten mit Status (idle / working / needs_input / offline), Modell,
aktueller Aufgabe und offenen Fragen.

**Wie gebe ich Input?**
Bei einem Agenten, der auf Input wartet, ins Textfeld schreiben und senden. Der
Hub legt die Antwort in die Inbox des Agenten; die Bridge holt sie beim
nächsten Poll (alle ~1,5 s) ab und **tippt sie per tmux** in die
Claude-Session.

**Wie delegiere ich an einen günstigeren Agenten (Tokens sparen)?**
Schicke eine Aufgabe/Nachricht gezielt an `Hetzner-Claude` (Opus 4.6). Große,
tokenintensive Recherchen kannst du dort erledigen lassen und nur das Ergebnis
zurückspielen – das schont das Budget des teureren Agenten.

**Wie orchestrieren Agenten Coworker?**
Ein Agent fordert über den Hub eine Coworker-Aktion an (z.B.
`gmail.search`). Der Hub routet das an einen Agenten, der diese Fähigkeit
registriert hat. Dessen Bridge formt daraus einen klaren Arbeitsauftrag
("Bitte führe Coworker-Aktion gmail.search mit Parametern {…} aus …"), Claude
erledigt ihn und die Bridge meldet das Ergebnis über den Kontroll-Endpunkt
(`/coworker-result`) zurück an den anfragenden Agenten.

**Der Haupt-Agent ("main"):** Registriere den Mac-Claude (Opus 4.8, dein
Haupt-Ansprechpartner) mit der Fähigkeit `main` in den `CAPABILITIES`
(z.B. `main,gmail,calendar`). Der Hub routet Telegram-Nachrichten an den
Agenten mit der Fähigkeit `main` (siehe Abschnitt 11).

---

## 10. Gemeinsames Gedächtnis

Alle Agenten teilen sich ein **gemeinsames Gedächtnis** – einen Textblock mit
wichtigen Fakten/Absprachen, den alle lesen und aktualisieren können.

**Wie es funktioniert**

- Beim Start holt jede Bridge das aktuelle Gedächtnis vom Hub
  (`getMemory`) und schreibt es nach `~/.claude-hub/shared-memory.md`.
- Aktualisiert ein Agent das Gedächtnis, verteilt der Hub ein `memory`-Signal
  an **alle** Agenten. Jede Bridge holt daraufhin die neue Version und
  schreibt sie neu. Wenn `TMUX_TARGET` gesetzt ist, wird zusätzlich eine kurze
  Notiz in die Session eingespeist:
  `🧠 Gemeinsames Gedächtnis aktualisiert (vN) – bitte ~/.claude-hub/shared-memory.md beachten.`

**MEMORY_TARGET (optional)**

Setzt du die Umgebungsvariable/Config `MEMORY_TARGET` auf einen Dateipfad
(z.B. das `CLAUDE.md` eines Projekts), schreibt die Bridge den Gedächtnistext
zusätzlich in einen klar abgegrenzten Block dieser Datei – **der Rest der Datei
bleibt unangetastet**:

```
<!-- CLAUDE-HUB-MEMORY:START -->
… der gemeinsame Gedächtnistext …
<!-- CLAUDE-HUB-MEMORY:END -->
```

Die Marker werden automatisch angelegt, falls sie noch nicht existieren. So
sieht der lokale Claude das gemeinsame Wissen direkt in seiner `CLAUDE.md`.

**Selbst aktualisieren (der lokale Claude)**

Der lokale Claude kann das gemeinsame Gedächtnis selbst fortschreiben, indem er
den lokalen Kontroll-Endpunkt aufruft:

```bash
curl -s -X POST http://127.0.0.1:4599/memory \
  -H 'content-type: application/json' \
  -d '{"text":"Neuer Gedächtnisstand …"}'
```

Die Bridge ruft dann `setMemory` am Hub auf; der Hub verteilt das Update an
alle anderen Agenten.

---

## 11. Telegram als Hauptkanal

Du kannst über **Telegram** direkt mit deinem Haupt-Claude (dem `main`-Agenten
auf dem Mac) schreiben. Der Hub nimmt deine Telegram-Nachricht entgegen,
schickt sie an den `main`-Agenten, dieser erzeugt die Antwort **headless**
(Claude-CLI im Print-Modus) und schickt sie zurück nach Telegram.

> Wichtig: Die Antworten erzeugt der `main`-Agent (Mac) **headless über deinen
> lokalen Claude-Account** – die Tokens laufen also über diesen Account, nicht
> über die interaktive tmux-Session.

**1) Bot bei BotFather anlegen**

- In Telegram **@BotFather** öffnen, `/newbot`, Namen + Benutzernamen vergeben.
- Du erhältst ein **Bot-Token** (Form `123456:ABC-DEF…`).

**2) Deine Chat-ID herausfinden**

- Schreibe deinem Bot eine Nachricht, dann:
  `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` – die Zahl unter
  `message.chat.id` ist deine Chat-ID.
- Alternativ **@userinfobot** anschreiben; er zeigt deine ID an.

**3) Drei (optionale) Telegram-Secrets im Worker setzen**

```bash
wrangler secret put TELEGRAM_BOT_TOKEN       # das Bot-Token von BotFather
wrangler secret put TELEGRAM_WEBHOOK_SECRET  # ein selbst gewähltes Geheimwort
wrangler secret put TELEGRAM_ALLOWED_CHAT    # deine Chat-ID (nur du darfst schreiben)
```

**4) Webhook setzen** (damit Telegram Nachrichten an deinen Hub schickt):

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<deine-hub-url>/telegram/<WEBHOOK_SECRET>&secret_token=<WEBHOOK_SECRET>"
```

`<WEBHOOK_SECRET>` ist dasselbe Geheimwort wie oben. Der Hub prüft es, damit
niemand Fremdes deinen Endpunkt aufrufen kann.

**5) Auf dem main-Agenten (Mac) aktivieren**

- `CAPABILITIES` muss `main` enthalten (z.B. `main,gmail,calendar`).
- `TELEGRAM_HANDLER=1` (Default). Auf **allen anderen** Agenten (z.B. Hetzner)
  `TELEGRAM_HANDLER=0` setzen, damit nur der Mac antwortet.
- Optional: `CLAUDE_CMD` (Default `claude`), `CLAUDE_CWD` (Arbeitsverzeichnis
  für die headless Antworten), `CLAUDE_SYSTEM_FLAG` (Default
  `--append-system-prompt` – wird nur genutzt, wenn `shared-memory.md`
  existiert; sonst weglassen).

Schreibst du deinem Bot jetzt eine Nachricht, antwortet dein Mac-Claude direkt
in Telegram.

---

## 12. Sicherheit

- **Login:** Passwort **und** 2FA (TOTP) – beides nötig.
- **Agent-Token:** Jeder Bridge-Request trägt `x-agent-token`. Ohne gültiges
  Token akzeptiert der Hub keine Agenten-Requests.
- **HTTPS überall:** Der Verkehr läuft über Cloudflare (TLS).
- **Secrets nie im Repo:** Alle Geheimnisse liegen als `wrangler secret` im
  Worker bzw. in `~/.claude-hub/config.json` (chmod 600) – **nicht** in Git.
- **tmux nur lokal:** Eingaben werden nur in die lokale tmux-Session getippt.
- **Kontroll-Port nur localhost:** Der Kontroll-Endpunkt (Port 4599) bindet
  ausschließlich auf `127.0.0.1` und weist Nicht-localhost-Requests ab.
- **Rate-Limiting beim Login:** Der Hub sollte fehlgeschlagene Logins begrenzen
  (Brute-Force-Schutz).
- **Empfehlung:** Zusätzlich **Cloudflare Access** vor das Dashboard schalten
  (z.B. E-Mail-Einmalcode oder SSO), dann ist das Dashboard doppelt geschützt.

---

## 13. Troubleshooting

**Agent erscheint als offline**
- Läuft die Bridge? (`node bridge/claude-bridge.mjs` bzw.
  `systemctl --user status claude-bridge` / `launchctl list | grep claude-hub`)
- Stimmen `HUB_URL` und `AGENT_TOKEN` in `~/.claude-hub/config.json`?
- Erreicht der Rechner den Hub? `curl -I https://claude-hub.DEINSUB.workers.dev`
- Logs prüfen: `~/.claude-hub/bridge.out.log` und `~/.claude-hub/bridge.err.log`.

**Eingaben kommen nicht in Claude an / tmux-Target falsch**
- Existiert die tmux-Sitzung? `tmux ls`
- Stimmt `TMUX_TARGET` (Format `sitzung:fenster.pane`, z.B. `claude:0.0`)?
- Manuell testen:
  `tmux send-keys -t claude:0.0 -l -- "hallo" && tmux send-keys -t claude:0.0 Enter`
- Ist in dem Pane wirklich Claude Code aktiv (und nicht die Shell)?
- Ohne tmux: Die Bridge schreibt eingehende Texte nach
  `~/.claude-hub/inbox.log` und `~/.claude-hub/next-input.txt`
  (Abruf: `curl http://127.0.0.1:4599/pending`).

**2FA-Code wird abgelehnt**
- Fast immer ein **Uhrzeit-/Zeitzonen-Problem**: TOTP ist zeitbasiert.
- Stelle sicher, dass die Uhr auf **automatisch** steht (Handy und Server).
- Auf dem Server ggf. NTP prüfen: `timedatectl` (Zeit sollte synchron sein).
- Warte, bis ein **neuer** Code erscheint, und gib ihn zügig ein.
- Prüfe, dass du das **richtige** Base32-Secret eingetragen hast.

**Hooks lösen nichts aus**
- Sind `notify.sh` / `stop.sh` ausführbar (`chmod +x`) und mit **absolutem
  Pfad** in `.claude/settings.json` eingetragen?
- Läuft die Bridge (Kontroll-Port 4599)?
- Test:
  `curl -s -X POST http://127.0.0.1:4599/status -H 'content-type: application/json' -d '{"status":"done","title":"Test"}'`

**Telegram antwortet nicht**
- Ist der Webhook korrekt gesetzt? Prüfen:
  `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`
- Läuft auf dem **main**-Agenten (Mac) `TELEGRAM_HANDLER=1` und ist `main` in
  den `CAPABILITIES`? Antwortet nur EIN Agent (andere auf `TELEGRAM_HANDLER=0`)?
- Funktioniert das Claude-CLI headless? Test:
  `claude -p "Sag hallo" --output-format text`
- Stimmt `CLAUDE_CMD`/`CLAUDE_CWD`? Bei Zeitüberschreitung kommt eine
  `⚠️`-Fehlermeldung in Telegram – dann `CLAUDE_TIMEOUT_MS` prüfen/erhöhen.
- Ist deine Chat-ID als `TELEGRAM_ALLOWED_CHAT` hinterlegt?

**Gemeinsames Gedächtnis aktualisiert sich nicht**
- Existiert `~/.claude-hub/shared-memory.md` nach dem Start? (Wenn nicht:
  erreicht die Bridge den Hub? Siehe "Agent offline".)
- `MEMORY_TARGET` gesetzt, aber Block fehlt? Die Marker
  `<!-- CLAUDE-HUB-MEMORY:START -->` / `:END` werden beim ersten Update
  automatisch angelegt – prüfe Schreibrechte auf die Zieldatei.
- Manuell setzen/testen:
  `curl -s -X POST http://127.0.0.1:4599/memory -H 'content-type: application/json' -d '{"text":"Test"}'`
