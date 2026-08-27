# Anleitung: beide Macs vollständig anbinden

Für die drei Ziele:

1. **Lesen und Schreiben auf beiden Macs, auch wenn der Mac gesperrt ist**
2. **Browser-Steuerung auf beiden**
3. **Zugriff auf alle Programme auf beiden**

Zeitbedarf: ~20 Minuten Hub, dann je ~20 Minuten pro Mac.

---

## Was am Ende wann funktioniert

Das Wichtigste vorweg, damit du weißt, worauf du hinarbeitest:

| | Gesperrt, angemeldet | Abgemeldet / Login-Fenster | Mac schläft |
|---|---|---|---|
| Shell-Befehle | ✅ | ✅ | ❌ |
| Dateien lesen **und schreiben** | ✅ | ✅ | ❌ |
| Programme steuern (Notizen, Kalender, Musik, …) | ✅ | ❌ | ❌ |
| Browser über den Konnektor | ✅ | ❌ | ❌ |
| Mails | ✅ | ❌ | ❌ |
| Claude in Chrome (das Add-on) | ❌ | ❌ | ❌ |

Daraus folgen zwei Regeln für den Alltag:

> **Bildschirm sperren, nicht abmelden.** Sperren ist völlig in Ordnung —
> Abmelden beendet die Benutzersitzung, und damit sind Programme, Browser und
> Mail weg. Shell und Dateien laufen weiter.

> **Der Mac darf nicht schlafen.** Ein schlafender Mac ist offline, egal wie
> gut alles konfiguriert ist. Dafür sorgt `--keep-awake` in Schritt 2.

Das Chrome-Add-on ist bewusst in der letzten Zeile: Es ist kein Fernzugriff,
sondern läuft in einer offenen Claude-Code-Sitzung auf dem jeweiligen Mac.
Mehr dazu in Teil 4.

---

## Teil 0 — Jetzt sofort, bevor du dich hinsetzt

Leg den DNS-Eintrag an: eine Subdomain (z. B. `hub.sk-finanzberatung.de`) mit
**A-Record auf die IP deines Hetzner-Servers**. Die Propagation dauert manchmal
eine halbe Stunde — wenn du das jetzt machst, wartest du später nicht darauf.

Prüfen:

```bash
dig +short hub.DEINE-DOMAIN.de     # muss deine Hetzner-IP zeigen
```

---

## Teil 1 — Hub auf dem Hetzner-Server

```bash
ssh root@dein-hetzner

git clone https://github.com/kosimus12/sk-f /opt/src/sk-f
cd /opt/src/sk-f
git checkout claude/hetzner-multi-device-connector-ply62n
cd connector

sudo bash hub/deploy/install.sh
```

Der Installer zeigt **einmalig das Control-Token** (`skc_ctl_…`).
Sofort in den Passwortmanager — es ist der Generalschlüssel zu beiden Macs und
taucht nie wieder auf.

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

curl -s https://hub.DEINE-DOMAIN.de/healthz
```

Für alle weiteren Befehle auf dem Server:

```bash
export CONNECTOR_HUB_URL=https://hub.DEINE-DOMAIN.de
export CONNECTOR_CONTROL_TOKEN=skc_ctl_...
```

---

## Teil 2 — Dein Mac

### 2.1 Auf dem Hetzner: Gerät anlegen

```bash
python3 tools/skconnect.py add mac-simon "Simons Mac" macos \
        --owner simon --mode full \
        --caps shell,fs,notify,probe,app,browser,mail
```

`--mode full` = lesen und schreiben. `app` ist die Fähigkeit für „alle
Programme". Der Befehl gibt einen Enrollment-Code aus, 30 Minuten gültig.

### 2.2 Auf dem Mac: Agent installieren

```bash
git clone https://github.com/kosimus12/sk-f ~/src/sk-f
cd ~/src/sk-f
git checkout claude/hetzner-multi-device-connector-ply62n
cd connector

bash agent/macos/setup-mac.sh --hub https://hub.DEINE-DOMAIN.de --code skc_enr_...
```

**Ohne `sudo` starten** — das Skript fragt selbst nach, wo es root braucht. Mit
`sudo` davor laufen die Freigabe-Dialoge im falschen Benutzerkontext und
erscheinen nicht.

`setup-mac.sh` erledigt Installation, Energieeinstellungen und Freigaben in
einem Durchgang. Für den **zugeklappten** Betrieb setzt es `disablesleep=1` —
`sleep 0` allein reicht nicht, damit schläft der Mac beim Zuklappen trotzdem
ein — und prüft danach über `pmset -g live` nach, ob der Wert wirklich gegriffen
hat. Voraussetzung bleibt: **Netzteil angeschlossen lassen.**

Die Schritte 2.3 und 2.4 unten laufen dabei automatisch mit; sie stehen hier
noch einmal einzeln, falls du etwas nachziehen musst.

### 2.3 Auf dem Mac: Freigaben erteilen — **ohne sudo, am Mac selbst**

Das ist der Schritt, an dem die meisten Setups scheitern. Er muss in der
grafischen Sitzung laufen, nicht über SSH, und ohne `sudo`:

```bash
bash agent/macos/grant-permissions.sh
```

Das Skript tippt der Reihe nach alle Programme an, damit macOS **jetzt** fragt.
Bestätige jeden Dialog mit **Erlauben**:

> „Terminal" möchte „Mail" steuern. → **Erlauben**
> „Terminal" möchte „Safari" steuern. → **Erlauben**
> … und so weiter für Chrome, Finder, Notizen, Kalender, Kontakte,
> Erinnerungen, Nachrichten, Musik, System Events

**Warum das wichtig ist:** macOS fragt bei jedem Programm genau einmal. Wenn
diese Frage später kommt, während der Mac gesperrt ist und niemand davorsitzt,
kann sie niemand wegklicken — das Kommando scheitert einfach. Deshalb jetzt
alles vorab durchklicken.

Weitere Programme mit aufnehmen:

```bash
bash agent/macos/grant-permissions.sh --apps "Pages,Numbers,Keynote,Notion,Spotify"
```

### 2.4 Zwei Dinge von Hand — dafür gibt es keinen Dialog

**a) JavaScript aus Apple Events** (sonst kommt Seitentext leer zurück)

- Safari: Einstellungen → Erweitert → „Funktionen für Webentwickler anzeigen",
  dann Menü *Entwickler* → **„JavaScript aus Apple Events erlauben"**
- Chrome: Menü *Darstellung* → *Entwickler* → **„JavaScript über Apple Events zulassen"**

**b) Festplattenvollzugriff** (sonst sind Dokumente, Schreibtisch, Downloads und
die Mail-Ablage für den Dienst leer)

- Systemeinstellungen → Datenschutz & Sicherheit → **Festplattenvollzugriff**
- „+" anklicken, dann **Cmd+Shift+G** und diese beiden Pfade eintragen:
  ```
  /bin/bash
  /usr/bin/python3
  ```

### 2.5 Gegenprobe vom Hetzner aus

```bash
python3 tools/skconnect.py devices                  # mac-simon: online
python3 tools/skconnect.py permissions mac-simon    # alles OK?
```

`permissions` listet zeilenweise auf, was funktioniert und was fehlt.
**Erst weitermachen, wenn dort nichts mehr auf `FEHLT` steht.**

---

## Teil 3 — Katyas Mac

Identischer Ablauf. Du hast gesagt, ihr wollt auf beiden Macs Lesen und
Schreiben — also `--mode full` auch hier.

```bash
# auf dem Hetzner:
python3 tools/skconnect.py add mac-katya "Katyas Mac" macos \
        --owner katya --mode full \
        --caps shell,fs,notify,probe,app,browser,mail
```

```bash
# auf Katyas Mac:
git clone https://github.com/kosimus12/sk-f ~/src/sk-f
cd ~/src/sk-f && git checkout claude/hetzner-multi-device-connector-ply62n
cd connector

bash agent/macos/setup-mac.sh --hub https://hub.DEINE-DOMAIN.de --code skc_enr_...
```

Dann Schritt 2.4 (JavaScript + Festplattenvollzugriff) und 2.5 (Gegenprobe)
genauso.

### Drei Befehle, die Katya kennen sollte

Der Modus `full` heißt: Shell-Zugriff, Dateien schreiben, Programme steuern,
Mails lesen. Das ist derselbe Zugriff, den du auf deinem eigenen Mac hast.
Zeig ihr diese drei Befehle bei der Einrichtung, nicht danach:

```bash
# Was wurde auf meinem Mac gemacht? Jedes Kommando mit Zeitstempel:
python3 tools/skconnect.py audit --device mac-katya --limit 100

# Sofort abklemmen — wirkt in Sekunden, von überall:
python3 tools/skconnect.py revoke mac-katya

# Endgültig entfernen, direkt am Mac:
sudo launchctl bootout system/de.skfinanzberatung.connector
sudo rm -rf /Library/LaunchDaemons/de.skfinanzberatung.connector.plist \
            /usr/local/libexec/skconnector /etc/skconnector
```

Falls sie erst mal nur mitlesen lassen will, geht auch das — und lässt sich
jederzeit hochstufen:

```bash
python3 tools/skconnect.py mode mac-katya readonly    # nur lesen
python3 tools/skconnect.py mode mac-katya full        # später wieder voll
```

---

## Teil 4 — Browser: die zwei Wege

Hier lohnt es sich, den Unterschied zu kennen, weil du beide willst.

### Weg A: Claude in Chrome (das Add-on, das du meinst)

Das ist Anthropics eigene Browser-Erweiterung. Seit dem 26. August 2026 auf
**allen bezahlten Plänen** verfügbar (Pro, Max, Team, Enterprise).

**Auf jedem der beiden Macs:**

1. [Claude in Chrome aus dem Chrome Web Store](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn)
   installieren (Version 1.0.36 oder neuer)
2. In der Erweiterung mit dem Claude-Konto anmelden
3. In Claude Code auf diesem Mac:
   ```bash
   claude --chrome
   ```
   oder einmalig `/chrome` → **„Enabled by default"**, dann braucht es das Flag
   nicht mehr.

Damit kann Claude Code in dieser Sitzung Tabs öffnen, klicken, tippen, Konsole
und DOM lesen, Formulare ausfüllen, Dateien hochladen — und zwar **mit deinem
eingeloggten Browserzustand**, also in Gmail, Notion, Google Docs und jedem
Portal, in dem du angemeldet bist.

Zwei Bedingungen: Anmeldung über `/login` (nicht per API-Key — dann bleibt die
Chrome-Anbindung aus), und Chrome, Edge oder ein anderer Chromium-Browser.

**Was das nicht ist:** kein Fernzugriff. Es funktioniert, während auf diesem Mac
eine Claude-Code-Sitzung offen ist. Es hilft dir nicht, wenn der Mac gesperrt
im Nebenzimmer steht.

### Weg B: Browser über den Konnektor

Das ist der Fernzugriff — funktioniert bei gesperrtem Bildschirm, von einer
zentralen Sitzung aus, für beide Macs gleichzeitig. Läuft über AppleScript.

```
browser_tabs   offene Tabs mit Fenster- und Tab-Nummer
browser_read   sichtbarer Seitentext
browser_open   URL in neuem Tab öffnen
browser_js     JavaScript im Tab ausführen
```

Weniger komfortabel als Weg A (kein Klicken per Beschreibung, keine Screenshots),
dafür aus der Ferne und ohne offene Sitzung auf dem Zielrechner.

**Empfehlung: beides einrichten.** Weg A, wenn du selbst am Mac sitzt und
gemeinsam mit mir arbeitest. Weg B, wenn ich unterwegs etwas für dich im Browser
nachsehen oder erledigen soll.

---

## Teil 5 — Claude den Konnektor geben

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

Vorher einmalig:

```bash
pip install -r mcp-server/requirements.txt
```

---

## Teil 6 — Abnahme: prüfen, ob deine drei Ziele erreicht sind

Sperr beide Macs (**Ctrl+Cmd+Q**, nicht abmelden) und lass sie am Strom.
Dann vom Hetzner aus, für `mac-simon` und `mac-katya`:

**Ziel 1 — Lesen und Schreiben bei gesperrtem Mac**

```bash
python3 tools/skconnect.py run mac-simon 'whoami && ls ~/Documents | head -5'
python3 tools/skconnect.py run mac-simon 'echo "Test $(date)" > ~/Documents/connector-test.txt'
python3 tools/skconnect.py run mac-simon 'cat ~/Documents/connector-test.txt'
python3 tools/skconnect.py run mac-simon 'rm ~/Documents/connector-test.txt'
```

Kommt `whoami` durch und lässt sich die Datei schreiben und wieder lesen, steht
Ziel 1. Wenn `ls ~/Documents` leer bleibt, obwohl da etwas liegt: der
Festplattenvollzugriff aus Schritt 2.4b fehlt.

**Ziel 2 — Browser bei gesperrtem Mac**

In Claude Code, mit angeschlossenem Konnektor:

> Zeig mir die offenen Tabs in Safari auf mac-simon.

Dann:

> Lies den Text der aktiven Seite auf mac-simon vor.

Kommt der Text leer zurück: „JavaScript aus Apple Events" aus Schritt 2.4a fehlt.

**Ziel 3 — Alle Programme bei gesperrtem Mac**

> Welche Programme laufen gerade auf mac-simon?

> Lies mir die Titel meiner letzten Notizen von mac-simon vor.

Das zweite geht über AppleScript an die Notizen-App. Fehler `-1743` bedeutet
immer: für dieses Programm fehlt die Automation-Freigabe — `grant-permissions.sh`
mit `--apps "Notes"` nachziehen, am Mac, ohne sudo.

---

## Wenn etwas klemmt

| Symptom | Ursache | Behebung |
|---|---|---|
| Gerät bleibt `offline` | Daemon läuft nicht | `sudo launchctl print system/de.skfinanzberatung.connector`, dann `tail -50 /var/log/skconnector/agent.log` |
| Fehler `-1743`, „Not authorized to send Apple events" | Automation-Freigabe fehlt für dieses Programm | `grant-permissions.sh --apps "Programmname"` am Mac, **ohne sudo** |
| „Niemand ist angemeldet" | Mac ist abgemeldet, nicht nur gesperrt | Anmelden und nur sperren |
| Browser-Text kommt leer | JavaScript aus Apple Events aus | Schritt 2.4a |
| Dokumente/Schreibtisch wirken leer | Festplattenvollzugriff fehlt | Schritt 2.4b |
| Gerät nachts nicht erreichbar | Mac schläft | `pmset -g custom` prüfen, ggf. `--keep-awake-aggressive` |
| Apple Events gehen im Terminal, aber nicht über den Dienst | macOS blockt Apple Events aus root-Daemons | Sitzungs-Agent nachrüsten — Anleitung im Kopf von `agent/macos/de.skfinanzberatung.connector.user.plist` |
| Chrome-Add-on wird nicht erkannt | Native-Messaging-Host fehlt | Chrome und Claude Code neu starten, dann `/chrome` → „Reconnect extension" |
| **Alles sofort anhalten** | — | `python3 tools/skconnect.py killswitch on` |

---

## Danach

Lass es ein paar Tage laufen und schau ins Protokoll:

```bash
python3 tools/skconnect.py audit --limit 100
```

Da steht jedes Kommando mit Zeitstempel, Gerät und Ergebnis — auch jedes
abgelehnte. Wenn dort etwas auftaucht, das du nicht erwartet hast, ist
`killswitch on` der erste Griff, Fragen danach.

Zwei Dinge bleiben bewusst aus, bis du sie ausdrücklich einschaltest:

- **Mailversand.** Ich kann Mails lesen und Entwürfe anlegen (der Entwurf öffnet
  sich sichtbar in Mail.app, du drückst selbst auf Senden). Echter Versand
  braucht `--allow-mail-send` beim Installieren — siehe `RUNBOOK.md`, Teil 4.
- **iPhones und iPad.** Für Dateien reicht der Weg über iCloud und den Mac
  (Tabelle im `README.md`). Direkte Anbindung: `ios/README.md`.
