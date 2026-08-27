# Runbook: beide Macs einrichten

Reihenfolge für einen Abend. Rechne mit 20 Minuten für den Hub, dann je 15
Minuten pro Mac. Der Hub muss zuerst laufen — ohne ihn geht auf den Macs nichts.

Was du brauchst: eine Subdomain mit A-Record auf den Hetzner (z. B.
`hub.sk-finanzberatung.de`), Root auf dem Hetzner, Admin auf beiden Macs.

---

## Teil 1 — Hub auf dem Hetzner (einmalig, ~20 min)

```bash
ssh root@dein-hetzner
git clone https://github.com/kosimus12/sk-f /opt/src/sk-f
cd /opt/src/sk-f/connector
git checkout claude/hetzner-multi-device-connector-ply62n

sudo bash hub/deploy/install.sh
```

Der Installer zeigt **einmalig das Control-Token** (`skc_ctl_…`). Sofort in den
Passwortmanager. Es ist der Generalschlüssel zu allen Geräten und taucht nie
wieder auf.

TLS davor:

```bash
# 1. Ist Port 80/443 schon belegt?
sudo ss -lntp | grep -E ':80 |:443 '

# 2a. Nichts belegt -> Caddy aus dem offiziellen Repo (nicht in Ubuntu enthalten):
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
sudo cp hub/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile          # hub.example.de -> deine Subdomain
sudo systemctl reload caddy

# 2b. nginx laeuft schon -> kein Caddy, stattdessen vhost:
#   sudo cp hub/deploy/nginx-hub.conf /etc/nginx/sites-available/skconnector-hub
#   sudo ln -s /etc/nginx/sites-available/skconnector-hub /etc/nginx/sites-enabled/
#   sudo nano /etc/nginx/sites-available/skconnector-hub    # Hostnamen eintragen
#   sudo nginx -t && sudo systemctl reload nginx
#   sudo certbot --nginx -d hub.DEINE-DOMAIN.de

# 2c. docker-proxy haelt die Ports -> Reverse-Proxy laeuft im Container.
#     Weder Caddy noch nginx auf dem Host installieren, sondern:
#     siehe hub/deploy/DOCKER-PROXY.md

curl -s https://hub.DEINE-DOMAIN.de/healthz
```

Steuerseite für die weiteren Schritte:

```bash
export CONNECTOR_HUB_URL=https://hub.DEINE-DOMAIN.de
export CONNECTOR_CONTROL_TOKEN=skc_ctl_...
```

---

## Teil 2 — Dein Mac (~15 min)

### 2.1 Auf dem Hetzner: Gerät anlegen

```bash
python3 tools/skconnect.py add mac-simon "Simons Mac" macos \
        --owner simon --mode full \
        --caps shell,fs,notify,probe,browser,mail
```

Der Befehl gibt einen Enrollment-Code aus (30 Minuten gültig, einmal
verwendbar). `mail.send` steht bewusst **nicht** dabei — dazu unten mehr.

### 2.2 Auf dem Mac: Agent installieren

```bash
git clone https://github.com/kosimus12/sk-f ~/src/sk-f
cd ~/src/sk-f/connector
git checkout claude/hetzner-multi-device-connector-ply62n

sudo bash agent/macos/install.sh \
     --hub https://hub.DEINE-DOMAIN.de \
     --code skc_enr_... \
     --keep-awake
```

### 2.3 Auf dem Mac: Freigaben erteilen — **ohne sudo, am Mac selbst**

```bash
bash agent/macos/grant-permissions.sh
```

Jetzt erscheinen die Zustimmungsdialoge. Bei jedem auf **Erlauben**:

- „Terminal" möchte „Mail" steuern
- „Terminal" möchte „Safari" steuern
- „Terminal" möchte „Google Chrome" steuern

Zwei Dinge musst du zusätzlich von Hand klicken, dafür gibt es keinen Dialog:

**JavaScript aus Apple Events** (sonst kann ich keine Seiteninhalte lesen)
- Safari: Einstellungen → Erweitert → „Funktionen für Webentwickler anzeigen",
  dann Menü *Entwickler* → „JavaScript aus Apple Events erlauben"
- Chrome: Menü *Darstellung* → *Entwickler* → „JavaScript über Apple Events zulassen"

**Festplattenvollzugriff** (sonst bleiben Dokumente, Schreibtisch, Downloads und
die Mail-Ablage für den Dienst leer)
- Systemeinstellungen → Datenschutz & Sicherheit → Festplattenvollzugriff
- Über „+" und dann Cmd+Shift+G eintragen: `/bin/bash` und `/usr/bin/python3`

### 2.4 Gegenprobe vom Hetzner aus

```bash
python3 tools/skconnect.py devices                  # mac-simon: online
python3 tools/skconnect.py permissions mac-simon    # alles OK?
python3 tools/skconnect.py run mac-simon 'ls ~/Documents | head'
```

`permissions` sagt dir zeilenweise, was noch fehlt. Erst weitermachen, wenn
dort nichts mehr auf `FEHLT` steht.

---

## Teil 3 — Katyas Mac (~15 min)

Gleicher Ablauf, **eine wichtige Abweichung**: Der Mac startet auf `readonly`.
Ich kann dann lesen (Dateien, Mails, offene Tabs), aber nichts verändern —
keine Shell, kein Schreiben, kein Verschicken.

```bash
# auf dem Hetzner:
python3 tools/skconnect.py add mac-katya "Katyas Mac" macos \
        --owner katya --mode readonly \
        --caps fs,notify,probe,browser,mail
```

```bash
# auf Katyas Mac:
sudo bash agent/macos/install.sh \
     --hub https://hub.DEINE-DOMAIN.de --code skc_enr_... --keep-awake

bash agent/macos/grant-permissions.sh     # ohne sudo, Dialoge bestätigen
```

**Bevor du anfängst, zeig Katya diese drei Befehle** — sie gehören zur
Einrichtung dazu, nicht als Nachtrag:

```bash
# Was wurde auf meinem Mac gemacht?
python3 tools/skconnect.py audit --device mac-katya --limit 100

# Sofort abklemmen, von überall:
python3 tools/skconnect.py revoke mac-katya

# Endgültig entfernen, direkt am Mac:
sudo launchctl bootout system/de.skfinanzberatung.connector
sudo rm -rf /Library/LaunchDaemons/de.skfinanzberatung.connector.plist \
            /usr/local/libexec/skconnector /etc/skconnector
```

Höherstufen auf Shell-Zugriff geht später mit einem Befehl — aber nur, wenn
Katya das ausdrücklich will:

```bash
python3 tools/skconnect.py mode mac-katya full
```

---

## Teil 4 — Mailversand (bewusste Extra-Entscheidung)

Mails **lesen** kann ich nach Teil 2 und 3. Mails **verschicken** ist absichtlich
separat abgesichert, weil es der einzige Schritt ist, der nach außen wirkt und
sich nicht zurücknehmen lässt.

Ohne Freigabe steht dir `mail_draft` zur Verfügung: Ich lege den Entwurf an, er
öffnet sich sichtbar in Mail.app, du liest ihn und drückst selbst auf Senden.
**Für den Anfang würde ich es dabei belassen.**

Wenn du echten Versand willst, auf deinem Mac (nicht auf Katyas):

```bash
# auf dem Mac:
sudo /usr/libexec/PlistBuddy -c \
  "Set :EnvironmentVariables:CONNECTOR_ALLOW_MAIL_SEND 1" \
  /Library/LaunchDaemons/de.skfinanzberatung.connector.plist
sudo launchctl bootout system/de.skfinanzberatung.connector
sudo launchctl bootstrap system /Library/LaunchDaemons/de.skfinanzberatung.connector.plist
# kickstart reicht hier NICHT - es startet den Prozess neu,
# liest die geaenderte plist aber nicht ein.

# auf dem Hetzner, Fähigkeit ergänzen:
python3 tools/skconnect.py add mac-simon "Simons Mac" macos \
        --owner simon --mode full \
        --caps shell,fs,notify,probe,browser,mail,mail.send
```

Rücknahme: dasselbe mit `0`, Dienst neu starten.

---

## Teil 5 — Claude anschließen

Claude Code liest `~/.claude/mcp.json` **nicht** — der Benutzer-Scope liegt in
`~/.claude.json`. Statt die Datei von Hand zu bearbeiten, den CLI-Befehl nehmen,
der schreibt an die richtige Stelle:

```bash
claude mcp add skconnector --scope user \
  --env CONNECTOR_HUB_URL=https://hub.DEINE-DOMAIN.de \
  --env CONNECTOR_CONTROL_TOKEN=skc_ctl_... \
  -- python3 /pfad/zu/sk-f/connector/mcp-server/server.py

claude mcp list        # skconnector muss "Connected" zeigen
```

Der MCP-Server braucht Python **3.10 oder neuer**. `python3 --version` prüfen —
oft ist im PATH schon eine neuere Version als das `/usr/bin/python3` (3.9),
mit dem der Agent-Daemon läuft. Fehlt eine: `brew install python@3.12` und den
Pfad zu dessen Interpreter im Befehl oben verwenden.

Liegt zusätzlich eine `.mcp.json` im Projekt, meldet Claude Code den Server
doppelt (project + user scope). Einen der beiden deaktivieren.

Erster Test in Claude Code: *„Zeig mir die verbundenen Geräte"* → ich rufe
`devices` auf und sehe beide Macs.

---

## Wenn etwas nicht geht

| Symptom | Ursache | Behebung |
|---|---|---|
| Gerät bleibt `offline` | Daemon läuft nicht | `sudo launchctl print system/de.skfinanzberatung.connector`, dann `tail -50 /var/log/skconnector/agent.log` |
| `Not authorized to send Apple events` / Fehler `-1743` | Automation-Freigabe fehlt | `grant-permissions.sh` **ohne sudo** am Mac, sonst Systemeinstellungen → Automation |
| Browser-Text kommt leer zurück | JavaScript aus Apple Events aus | Siehe Schritt 2.3 |
| Mail-Befehle laufen in den Timeout | Riesiges Postfach | `limit` bzw. `scan` senken, oder gezielt `mailbox` angeben |
| Dokumente/Schreibtisch wirken leer | Festplattenvollzugriff fehlt | `/bin/bash` und `/usr/bin/python3` eintragen (Schritt 2.3) |
| Apple Events klappen im Terminal, aber nicht über den Dienst | macOS blockt Apple Events aus root-Daemons | Sitzungs-Agent nachrüsten: Anleitung im Kopf von `agent/macos/de.skfinanzberatung.connector.user.plist` |
| Alles anhalten, sofort | — | `python3 tools/skconnect.py killswitch on` |

## Danach

Lass es ein paar Tage laufen und schau ins Audit-Log:

```bash
python3 tools/skconnect.py audit --limit 100
```

Da steht jedes Kommando mit Zeitstempel, Gerät und Ergebnis. Wenn dort etwas
auftaucht, das du nicht erwartet hast, ist `killswitch on` der erste Griff.
