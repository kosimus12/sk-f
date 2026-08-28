# SK Connector

Ein Konnektor, über den Claude deine Geräte erreicht: Hetzner-Server, Macs,
iPhones und iPad. Der Hetzner-Server ist die Zentrale, alle anderen Geräte
verbinden sich **ausgehend** dorthin. Kein offener Port, kein Portforwarding,
funktioniert hinter NAT, CGNAT und im Mobilfunknetz.

```
   Claude ──MCP──▶ Hub (Hetzner, HTTPS) ◀──Long-Poll── Mac / Linux
                            │
                            └──Push (APNs)──────────▶ iPhone / iPad
```

## Was auf welchem Gerät geht

| | Hetzner | Macs | iPhone / iPad |
|---|---|---|---|
| Shell-Befehle | ✅ | ✅ | ❌ (gibt iOS nicht her) |
| Dateien lesen/schreiben | ✅ | ✅ | ❌ |
| **Programme steuern** (beliebiges AppleScript) | — | ✅ | ❌ |
| **Browser steuern** (Tabs, Seitentext, JavaScript) | — | ✅ | ❌ |
| **Mails** (lesen, suchen, Entwurf, senden) | — | ✅ | ❌ |
| Systemstatus abfragen | ✅ | ✅ | ✅ (verzögert) |
| Mitteilung zustellen | ✅ | ✅ (wenn angemeldet) | ✅ (sofort) |
| Kurzbefehl starten | — | — | ✅ (verzögert) |
| **Erreichbar bei gesperrtem Bildschirm** | ✅ immer | ✅ **ja** (LaunchDaemon) | teilweise — siehe unten |

Browser und Mail laufen über AppleScript und brauchen deshalb eine **aktive
Benutzersitzung**. Gesperrter Bildschirm ist in Ordnung, abgemeldet nicht —
dann bleiben Shell und Dateien erreichbar, Browser und Mail nicht.

**Einrichtung Schritt für Schritt: [`ANLEITUNG.md`](ANLEITUNG.md)** — beide Macs,
alle drei Ziele, mit Abnahme-Test am Ende.

### Zum gesperrten Zustand

**Macs:** Ja. Der Agent läuft als *LaunchDaemon*, nicht als LaunchAgent — er
startet beim Booten als Systemdienst und läuft weiter, wenn der Bildschirm
gesperrt ist oder niemand angemeldet ist (Login-Fenster). Die einzige echte
Lücke ist **Ruhezustand**: ein schlafender Mac ist offline. Deshalb setzt
`install.sh --keep-awake` die Energieeinstellungen so, dass der Mac am Netzteil
wach bleibt (Display darf aus). Details unten unter „Mac dauerhaft erreichbar".

**iPhone / iPad:** Erreichen ja, ausführen eingeschränkt. Push-Mitteilungen
kommen auch gesperrt in Sekunden an. Befehle holt das Gerät dagegen nur ab,
wenn eine Kurzbefehl-Automation läuft — das passiert im Hintergrund auch bei
gesperrtem Bildschirm, aber im Minuten- bis Stundentakt, nicht sofort. iOS lässt
keinen dauerhaften Hintergrunddienst zu. Die vollständige Erklärung samt
Bauanleitung steht in [`ios/README.md`](ios/README.md).

## Aufbau

```
connector/
├── hub/          FastAPI-Zentrale auf dem Hetzner-Server (SQLite, Audit-Log)
├── agent/        Agent für macOS (LaunchDaemon) und Linux (systemd)
├── mcp-server/   MCP-Server — die Seite, die Claude sieht
├── ios/          Anleitung für iPhone und iPad (Kurzbefehle + Push)
├── tools/        skconnect.py — Kommandozeile für die Steuerseite
└── tests/        Unit-Tests und ein End-to-End-Rauchtest

ANLEITUNG.md      Einrichtung beider Macs: lesen+schreiben, Browser, Programme
REMOTE-MCP.md     Claude Chat und Cowork anbinden (abgestufte Tokens)
ZWEITE-SCHRANKE.md  TOTP: Zugriff nur mit Code aus der Authenticator-App
SECURITY-REVIEW.md  Due Diligence, Befunde und verbleibende Risiken
RUNBOOK.md        Kurzfassung der Einrichtung
SECURITY.md       Sicherheitsmodell, Grenzen, Empfehlungen
```

## Einrichtung

### 1. Hub auf dem Hetzner-Server

```bash
git clone <dieses-repo> /tmp/skconnector && cd /tmp/skconnector/connector
sudo bash hub/deploy/install.sh
```

Der Installer legt Dienstbenutzer, venv und systemd-Unit an und gibt **einmalig
das Control-Token** aus. Das ist der Generalschlüssel — sicher ablegen
(Passwortmanager), es taucht nie wieder auf.

Danach TLS über Caddy davor:

Zuerst prüfen, ob Port 80/443 schon belegt ist:

```bash
sudo ss -lntp | grep -E ':80 |:443 '
```

**Ist dort nichts** — Caddy aus dem offiziellen Repo installieren (in Ubuntus
Standardquellen ist es nicht enthalten):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo cp hub/deploy/Caddyfile /etc/caddy/Caddyfile   # Hostnamen anpassen!
sudo systemctl reload caddy
```

**Läuft dort schon nginx**, kein Caddy installieren — stattdessen einen
vhost anlegen (`hub/deploy/nginx-hub.conf` als Vorlage) und
`certbot --nginx -d hub.DEINE-DOMAIN.de` laufen lassen.

**Steht dort `docker-proxy`**, laeuft der Reverse-Proxy in einem
Container — dann gilt weder das eine noch das andere. Vorgehen je
nach Proxy-Typ: [`hub/deploy/DOCKER-PROXY.md`](hub/deploy/DOCKER-PROXY.md).

Gegenprobe:

```bash
curl -s https://hub.DEINE-DOMAIN.de/healthz
```

Voraussetzung: ein A-Record auf die Hetzner-IP. Der Hub selbst lauscht nur auf
`127.0.0.1:8787` — er ist nie direkt aus dem Netz erreichbar.

### 2. Steuerseite konfigurieren

Überall dort, wo du `skconnect.py` benutzt:

```bash
export CONNECTOR_HUB_URL=https://hub.DEINE-DOMAIN.de
export CONNECTOR_CONTROL_TOKEN=skc_ctl_...
```

### 3. Den Hetzner-Server selbst anbinden

Damit Claude ihn wie jedes andere Gerät anspricht:

```bash
python3 tools/skconnect.py add hetzner "Hetzner-Server" linux \
        --mode full --caps shell,fs,notify,probe
sudo bash agent/linux/install.sh --hub https://hub.DEINE-DOMAIN.de --code skc_enr_...
```

### 4. Macs anbinden

```bash
# auf dem Server — dein Mac, voller Zugriff:
python3 tools/skconnect.py add mac-simon "Simons Mac" macos \
        --owner simon --mode full \
        --caps shell,fs,notify,probe,app,browser,mail

# auf dem Mac (Repo dorthin kopieren oder klonen):
sudo bash agent/macos/install.sh \
     --hub https://hub.DEINE-DOMAIN.de --code skc_enr_... --keep-awake
```

Der Installer registriert den Mac, legt den LaunchDaemon an und startet ihn.
Prüfen:

```bash
sudo launchctl print system/de.skfinanzberatung.connector | head -20
tail -f /var/log/skconnector/agent.log
```

Danach am Mac einmalig die macOS-Freigaben erteilen — **ohne sudo, in der
grafischen Sitzung**, sonst erscheinen die Dialoge nicht:

```bash
bash agent/macos/grant-permissions.sh
```

Das Skript löst die Zustimmungsdialoge für Mail, Safari und Chrome aus und sagt
am Ende, was noch fehlt. Zwei Dinge musst du zusätzlich von Hand setzen:
*JavaScript aus Apple Events* im Browser und *Festplattenvollzugriff* für
`/bin/bash` und `/usr/bin/python3`. Beides steht im [`RUNBOOK.md`](RUNBOOK.md).

Gegenprobe vom Server aus:

```bash
python3 tools/skconnect.py permissions mac-simon
```

### 5. Über die Macs an iPhone-Daten kommen

Ein eigener iPhone-Agent ist dafür nicht nötig — was in iCloud liegt, liegt auch
auf dem Mac:

| Auf dem iPhone | Auf dem Mac erreichbar? | Pfad |
|---|---|---|
| Dateien-App (iCloud Drive) | ✅ | `~/Library/Mobile Documents/com~apple~CloudDocs` |
| Fotos (iCloud-Mediathek) | ✅ mit „Originale laden" | `~/Bilder/Fotos-Mediathek.photoslibrary` |
| Notizen | ✅ über Notes.app / SQLite | `~/Library/Group Containers/group.com.apple.notes` |
| Nachrichten (iMessage) | ✅ bei aktiviertem Sync | `~/Library/Messages/chat.db` |
| Kontakte, Kalender | ✅ | `~/Library/Application Support/AddressBook`, `~/Library/Calendars` |
| App-Daten außerhalb iCloud Drive | ❌ | bleiben im App-Sandbox auf dem Gerät |
| WhatsApp-Chats | ❌ | eigenes Backup, nicht in iCloud Drive lesbar |

Alle diese Pfade liegen hinter dem **Festplattenvollzugriff** — ohne den
kommen `fs.read` und `shell` dort nicht heran.

### 6. iPhones und iPad direkt anbinden (später)

Siehe [`ios/README.md`](ios/README.md) — dort steht die vollständige Anleitung
inklusive ntfy-Setup und dem Bauplan für den Kurzbefehl-Agenten. Für Push-
Mitteilungen aufs iPhone brauchst du das; für Dateizugriff reicht der Weg über
iCloud und den Mac.

### 7. Claude den Konnektor geben

Claude Code liest `~/.claude/mcp.json` **nicht** — der Benutzer-Scope liegt in
`~/.claude.json`. Nimm den CLI-Befehl, der schreibt an die richtige Stelle:

```bash
claude mcp add skconnector --scope user \
  --env CONNECTOR_HUB_URL=https://hub.DEINE-DOMAIN.de \
  --env CONNECTOR_CONTROL_TOKEN=skc_ctl_... \
  -- python3 /pfad/zu/connector/mcp-server/server.py

claude mcp list        # skconnector muss "Connected" zeigen
```

Der MCP-Server braucht Python **3.10+** (`pip install -r
mcp-server/requirements.txt`). Der Agent-Daemon dagegen läuft auf Apples
`/usr/bin/python3` (3.9) — die beiden sind unabhängig voneinander.

Im Repo liegt zusätzlich eine `.mcp.json`, die Hub-URL und Token aus
Umgebungsvariablen liest — für Claude Code im Browser, damit kein Token in Git
landet. Sind beide aktiv, meldet Claude Code den Server doppelt; dann einen
davon deaktivieren.

Danach hat Claude diese 27 Werkzeuge:

| Bereich | Werkzeuge |
|---|---|
| Geräte | `devices`, `device_info`, `probe`, `permissions` |
| Shell & Dateien | `run`, `read_file`, `write_file`, `list_dir` |
| Programme | `app_list`, `app_launch`, `app_quit`, `applescript` |
| Browser | `browser_tabs`, `browser_read`, `browser_open`, `browser_js` |
| Mail | `mail_accounts`, `mail_list`, `mail_search`, `mail_read`, `mail_draft`, `mail_send` |
| Mobil | `notify`, `shortcut`, `command_status` |
| Verwaltung | `audit_log`, `killswitch` |

## Mac dauerhaft erreichbar halten

Der LaunchDaemon löst „gesperrt", nicht „schlafend". Dafür sorgen die
Energieeinstellungen, die `--keep-awake` setzt:

```bash
sudo pmset -c sleep 0 displaysleep 10 disksleep 0   # am Netzteil nicht schlafen
sudo pmset -a womp 1                                # bei Netzwerkzugriff aufwachen
sudo pmset -a powernap 1                            # Power Nap
```

Für einen MacBook mit **geschlossenem Deckel** zusätzlich
`--keep-awake-aggressive`, das `sudo pmset -a disablesleep 1` setzt. Das wirkt
auch im Akkubetrieb und zieht entsprechend Strom — nur für einen Mac sinnvoll,
der dauerhaft am Netzteil hängt. Rücknahme jederzeit:
`sudo pmset -a disablesleep 0`.

Realistisch bleibt: Ein MacBook im Rucksack ist offline. Für „immer erreichbar"
brauchst du mindestens einen Mac, der dauerhaft am Strom steht — bei dir ist das
der 24/7-Mac, auf dem schon der Mail-Task-Runner läuft.

## Die Geräte deiner Freundin

Zwei Geräte im Plan gehören nicht dir. Das ist im Konnektor bewusst anders
gelöst als bei deinen eigenen:

* **Sie muss selbst zustimmen.** Ein Gerät kommt nur ins System, wenn jemand auf
  *diesem* Gerät einen Enrollment-Code einlöst. Das lässt sich nicht aus der
  Ferne erledigen — und das ist Absicht, nicht Bequemlichkeitsverlust.
* **Die Stufe ist eine bewusste Entscheidung.** `--mode notify` (nur
  Mitteilungen), `readonly` (lesen) oder `full` (Shell, schreiben, Programme).
  Umstellen jederzeit mit `skconnect.py mode mac-katya <stufe>`.
* **Sie kann jederzeit raus.** `skconnect.py revoke <gerät>` klemmt sofort ab;
  auf dem Mac beendet `sudo launchctl bootout system/de.skfinanzberatung.connector`
  den Agenten endgültig. Zeig ihr beide Befehle bei der Einrichtung.
* **Alles ist protokolliert.** `skconnect.py audit --device mac-katya` zeigt
  jeden Zugriff mit Zeitstempel. Sie sollte wissen, dass es dieses Log gibt und
  wie sie es anschaut.

Ein Fernzugriff auf das Gerät einer anderen Person ohne deren Wissen wäre nicht
nur heikel, sondern nach §202a StGB strafbar. Der Konnektor ist deshalb so
gebaut, dass er ohne ihre aktive Mitwirkung auf ihren Geräten gar nicht erst
anläuft.

```bash
# voller Zugriff, wie auf dem eigenen Mac:
skconnect.py add mac-katya "Katyas Mac" macos \
        --owner katya --mode full \
        --caps shell,fs,notify,probe,app,browser,mail

# oder erst mal nur mitlesen:
skconnect.py add mac-katya "Katyas Mac" macos \
        --owner katya --mode readonly \
        --caps fs,notify,probe,app,browser,mail

skconnect.py add iphone-katya "iPhone (Katya)" ios \
        --owner katya --mode notify --caps notify \
        --push-url https://ntfy.DEINE-DOMAIN.de/katya-iphone-c3d045
```

## Sicherheit im Überblick

Ausführlich in [`SECURITY.md`](SECURITY.md). Die Kurzfassung:

* **Zweite Schranke**: ein Code aus der Authenticator-App, alle 30 Sekunden
  neu. Ein gestohlenes Control-Token allein reicht dann nicht mehr — siehe
  [`ZWEITE-SCHRANKE.md`](ZWEITE-SCHRANKE.md).
* **Drei Berechtigungsstufen** je Gerät: `notify` (nur Mitteilungen),
  `readonly` (lesen), `full` (Shell und Schreiben).
* **Deny-Liste** blockt zerstörerische Befehle schon im Hub, bevor sie ein Gerät
  erreichen — `rm -rf`, `mkfs`, `dd` auf Blockgeräte, `shutdown`, `csrutil
  disable`, Keychain-Dumps und andere.
* **Optionale Allowlist** je Gerät: `--allowlist git,ls,cat` erlaubt nur diese
  Programme.
* **Tokens nur als SHA-256-Hash** gespeichert. Wer die Datenbank stiehlt, hat
  keine gültigen Tokens (dafür gibt es einen Test).
* **Enrollment-Codes** sind einmalig verwendbar und laufen nach 30 Minuten ab.
* **Audit-Log** über jedes Kommando, jede Ablehnung, jeden Widerruf.
* **Not-Aus**: `skconnect.py killswitch on` — der Hub nimmt sofort keine
  Kommandos mehr an, auf allen Geräten.

## Tests

```bash
cd connector
python3 -m pytest tests -q        # 115 Tests: Policy, Store, API, AppleScript
bash tests/smoke_e2e.sh           # echter Durchstich: Hub + Agent + CLI
```

Der Rauchtest startet einen echten Hub und einen echten Agenten, schleust
Shell-Kommandos und Dateizugriffe durch, prüft, dass die Deny-Liste greift, und
dass ein Widerruf sofort wirkt.

## Verhältnis zum bestehenden Mac-Task-Runner

Auf deinem 24/7-Mac läuft bereits ein Runner, der über `queue_mac_task` Aufträge
abholt. Der Konnektor ersetzt ihn nicht — er läuft daneben und deckt ab, was der
Runner nicht kann: die anderen fünf Geräte, synchrone Antworten statt
Queue-und-später-nachsehen, Berechtigungsstufen und ein Audit-Log. Wenn sich das
bewährt, lässt sich `queue_mac_task` später als dünner Aufsatz auf `run`
umstellen; nötig ist das nicht.
