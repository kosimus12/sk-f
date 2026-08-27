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
sudo apt install -y caddy
sudo cp hub/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile          # hub.example.de -> deine Subdomain
sudo systemctl reload caddy

curl -s https://hub.DEINE-DOMAIN.de/healthz     # {"ok":true,...}
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
sudo launchctl kickstart -k system/de.skfinanzberatung.connector

# auf dem Hetzner, Fähigkeit ergänzen:
python3 tools/skconnect.py add mac-simon "Simons Mac" macos \
        --owner simon --mode full \
        --caps shell,fs,notify,probe,browser,mail,mail.send
```

Rücknahme: dasselbe mit `0`, Dienst neu starten.

---

## Teil 5 — Claude anschließen

In `~/.claude/mcp.json` auf dem Rechner, an dem du mit Claude Code arbeitest:

```json
{
  "mcpServers": {
    "skconnector": {
      "command": "python3",
      "args": ["/pfad/zu/sk-f/connector/mcp-server/server.py"],
      "env": {
        "CONNECTOR_HUB_URL": "https://hub.DEINE-DOMAIN.de",
        "CONNECTOR_CONTROL_TOKEN": "skc_ctl_..."
      }
    }
  }
}
```

Vorher `pip install -r mcp-server/requirements.txt`.

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
