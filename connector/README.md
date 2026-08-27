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
| Systemstatus abfragen | ✅ | ✅ | ✅ (verzögert) |
| Mitteilung zustellen | ✅ | ✅ (wenn angemeldet) | ✅ (sofort) |
| Kurzbefehl starten | — | — | ✅ (verzögert) |
| **Erreichbar bei gesperrtem Bildschirm** | ✅ immer | ✅ **ja** (LaunchDaemon) | teilweise — siehe unten |

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

```bash
sudo apt install -y caddy
sudo cp hub/deploy/Caddyfile /etc/caddy/Caddyfile   # Hostnamen anpassen!
sudo systemctl reload caddy
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
# auf dem Server:
python3 tools/skconnect.py add mac-simon "Simons Mac" macos \
        --mode full --caps shell,fs,notify,probe

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

Einmalig nötig, wenn Claude auf Dokumente/Schreibtisch/Downloads zugreifen soll:
`/bin/bash` unter *Systemeinstellungen → Datenschutz & Sicherheit →
Festplattenvollzugriff* freigeben.

### 5. iPhones und iPad anbinden

Siehe [`ios/README.md`](ios/README.md) — dort steht die vollständige Anleitung
inklusive ntfy-Setup und dem Bauplan für den Kurzbefehl-Agenten.

### 6. Claude den Konnektor geben

In `~/.claude/mcp.json` (oder `.mcp.json` im Projekt):

```json
{
  "mcpServers": {
    "skconnector": {
      "command": "python3",
      "args": ["/pfad/zu/connector/mcp-server/server.py"],
      "env": {
        "CONNECTOR_HUB_URL": "https://hub.DEINE-DOMAIN.de",
        "CONNECTOR_CONTROL_TOKEN": "skc_ctl_..."
      }
    }
  }
}
```

Vorher einmalig `pip install -r mcp-server/requirements.txt`.

Danach hat Claude diese Werkzeuge: `devices`, `device_info`, `probe`, `run`,
`read_file`, `write_file`, `list_dir`, `notify`, `shortcut`, `command_status`,
`audit_log`, `killswitch`.

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
* **Voreinstellung ist die niedrigste Stufe.** Lege ihre Geräte mit
  `--owner freundin --mode notify` an. Dann kann Claude Mitteilungen schicken
  und sonst nichts. Mehr Rechte nur, wenn sie das ausdrücklich will:
  `skconnect.py mode mac-freundin readonly`.
* **Sie kann jederzeit raus.** `skconnect.py revoke <gerät>` klemmt sofort ab;
  auf dem Mac beendet `sudo launchctl bootout system/de.skfinanzberatung.connector`
  den Agenten endgültig. Zeig ihr beide Befehle bei der Einrichtung.
* **Alles ist protokolliert.** `skconnect.py audit --device mac-freundin` zeigt
  jeden Zugriff mit Zeitstempel. Sie sollte wissen, dass es dieses Log gibt und
  wie sie es anschaut.

Ein Fernzugriff auf das Gerät einer anderen Person ohne deren Wissen wäre nicht
nur heikel, sondern nach §202a StGB strafbar. Der Konnektor ist deshalb so
gebaut, dass er ohne ihre aktive Mitwirkung auf ihren Geräten gar nicht erst
anläuft.

```bash
skconnect.py add iphone-freundin "iPhone (Freundin)" ios \
        --owner freundin --mode notify --caps notify \
        --push-url https://ntfy.DEINE-DOMAIN.de/gf-iphone-c3d045

skconnect.py add mac-freundin "Mac (Freundin)" macos \
        --owner freundin --mode notify --caps notify,probe
```

## Sicherheit im Überblick

Ausführlich in [`SECURITY.md`](SECURITY.md). Die Kurzfassung:

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
python3 -m pytest tests -q        # 37 Tests: Policy, Store, API
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
