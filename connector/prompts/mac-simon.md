# Prompt für Claude Code auf Simons Mac — Verbindung abschließen

Stand: Hub läuft, `hetzner` und `mac-simon` sind online. Was fehlt, steht unten.
Alles ab der Trennlinie in Claude Code auf dem eigenen Mac einfügen.

---

Wir schließen die Einrichtung des SK-Connectors ab. Ich sitze am Mac und kann
Dialoge wegklicken — frag mich, wenn du etwas brauchst, statt zu raten.

## Stand

- Hub-URL: `https://hub.138.199.230.178.sslip.io` — läuft, HTTPS antwortet
- Hetzner: `root@138.199.230.178` (`hermes-1`), Repo unter `/opt/src/sk-f`
- Control-Token: auf dem Server in `/etc/skconnector/hub.env`. Von dort lesen,
  nie in eine Datei schreiben, die im Repo landet.
- `hetzner` und `mac-simon` sind bereits enrolled und online
- Repo auf diesem Mac: `~/src/sk-f`, Branch
  `claude/hetzner-multi-device-connector-ply62n`

Auf dem Hetzner setzt du für alle `skconnect.py`-Aufrufe:

```bash
cd /opt/src/sk-f/connector
export CONNECTOR_HUB_URL=https://hub.138.199.230.178.sslip.io
export CONNECTOR_CONTROL_TOKEN="$(grep -oP '(?<=CONNECTOR_CONTROL_TOKEN=).*' /etc/skconnector/hub.env)"
```

## Aufgaben, in dieser Reihenfolge

### 1. Netzteil

Frag mich, ob das MacBook am Strom hängt. `disablesleep=1` ist gesetzt und gilt
systemweit — der Mac schläft also nie, auch nicht im Akkubetrieb. Ohne Netzteil
läuft er leer und ist dann offline. Wenn ich das nicht dauerhaft will, sag mir:
`sudo pmset -a disablesleep 0` nimmt es zurück, dann ist er zugeklappt aber
nicht mehr erreichbar.

### 2. Agent aktualisieren

Die Sperrerkennung war kaputt (`screen_locked: null`) und ist gefixt:

```bash
cd ~/src/sk-f && git pull
sudo install -m 0755 connector/agent/agent.py /usr/local/libexec/skconnector/agent.py
sudo launchctl kickstart -k system/de.skfinanzberatung.connector
```

`kickstart` genügt hier, weil sich nur `agent.py` ändert. Sobald du die **plist**
anfasst (z. B. für `CONNECTOR_ALLOW_MAIL_SEND`), reicht es nicht — dann
`bootout` und `bootstrap`, sonst läuft der Dienst mit der alten Konfiguration
weiter.

Gegenprobe vom Hetzner: `python3 tools/skconnect.py probe mac-simon` —
`screen_locked` muss jetzt `true` oder `false` sein, nicht `null`.

### 3. Freigaben prüfen und schließen

```bash
python3 tools/skconnect.py permissions mac-simon
```

Für alles, was `FEHLT` zeigt, führ mich durch:

- **Automation** für ein Programm fehlt → am Mac, **ohne sudo**:
  `bash ~/src/sk-f/connector/agent/macos/grant-permissions.sh --apps "Name"`
- **JavaScript aus Apple Events**: Safari → Einstellungen → Erweitert →
  „Funktionen für Webentwickler anzeigen", dann Menü *Entwickler* →
  „JavaScript aus Apple Events erlauben". Chrome: *Darstellung* → *Entwickler*
  → „JavaScript über Apple Events zulassen".
- **Festplattenvollzugriff**: Systemeinstellungen → Datenschutz & Sicherheit →
  Festplattenvollzugriff → „+" → Cmd+Shift+G → `/bin/bash` und
  `/usr/bin/python3` eintragen.

Wiederhol `permissions`, bis nichts mehr auf `FEHLT` steht.

### 4. Funktionstest über alle vier Bereiche

Vom Hetzner aus, und sag mir bei jedem, was rauskam:

```bash
python3 tools/skconnect.py run mac-simon 'whoami && ls ~/Documents | head -5'
python3 tools/skconnect.py run mac-simon 'echo test > ~/Documents/ct.txt && cat ~/Documents/ct.txt && rm ~/Documents/ct.txt'
```

Und über die MCP-Werkzeuge (nach Schritt 5) bzw. per API: `app.list`,
`browser.tabs`, `mail.accounts`.

**Wenn `ls ~/Documents` leer bleibt, obwohl da etwas liegt:** Nicht sofort auf
den Festplattenvollzugriff schließen — das ist die naheliegende und meist
falsche Diagnose. Der Daemon lief bis Version 1.2 als root ohne `HOME`, `~`
zeigte auf `/var/root`. Gegenprobe mit absolutem Pfad:
`ls /Users/skuper/Documents`. Kommt der durch, war es das `HOME`-Problem und
Schritt 2 behebt es. Bleibt auch der leer, fehlt tatsächlich die Freigabe.

### 5. MCP-Server lokal einrichten

`python3 --version` prüfen: Der MCP-Server braucht **3.10+**. Oft ist im PATH
schon eine neuere Version als das `/usr/bin/python3` (3.9), mit dem der
Agent-Daemon läuft — dann reicht sie. Nur wenn keine da ist:
`brew install python@3.12` und ein venv anlegen.

Eintragen **nicht** von Hand in `~/.claude/mcp.json` — Claude Code liest die
Datei nicht, der Benutzer-Scope liegt in `~/.claude.json`. Nimm den CLI-Befehl:

```bash
claude mcp add skconnector --scope user \
  --env CONNECTOR_HUB_URL=https://hub.138.199.230.178.sslip.io \
  --env CONNECTOR_CONTROL_TOKEN=skc_ctl_… \
  -- python3 /Users/skuper/src/sk-f/connector/mcp-server/server.py

claude mcp list
```

Liegt im Projekt zusätzlich die Repo-`.mcp.json`, meldet Claude Code den Server
doppelt. Dann den Projekt-Eintrag lokal deaktivieren, die Repo-Datei aber
unangetastet lassen.

### 6. Enrollment-Code für Katyas Mac

```bash
python3 tools/skconnect.py add mac-katya "Katyas Mac" macos \
        --owner katya --mode full \
        --caps shell,fs,notify,probe,app,browser,mail
```

Gib mir den Code aus — den brauche ich für den Prompt auf Katyas Mac. Er gilt
30 Minuten und nur einmal.

### 7. Zugriff für die Web-Session

Damit Claude im Browser dieselben Werkzeuge bekommt: Im Repo liegt eine
`.mcp.json`, die `CONNECTOR_HUB_URL` und `CONNECTOR_CONTROL_TOKEN` aus
Umgebungsvariablen liest. Sag mir, wo ich die beiden in der Konfiguration
meiner Claude-Code-Umgebung hinterlegen muss. Trag sie **nicht** in eine Datei
im Repo ein.

### 8. Abnahme im zugeklappten Zustand

Ich schließe den Deckel (Netzteil dran). Warte 60 Sekunden, dann:

```bash
python3 tools/skconnect.py devices
python3 tools/skconnect.py probe mac-simon
python3 tools/skconnect.py run mac-simon 'uptime'
```

In der `probe`-Ausgabe muss `bleibt_wach_zugeklappt: true` stehen und
`battery.ac: true`. Sag mir deutlich, wenn eines von beiden nicht stimmt.

### 9. Control-Token tauschen

Es steht mehrfach in einem Chatverlauf. Zum Schluss:

```bash
ssh root@138.199.230.178
sudo sed -i "s|^CONNECTOR_CONTROL_TOKEN=.*|CONNECTOR_CONTROL_TOKEN=skc_ctl_$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')|" /etc/skconnector/hub.env
sudo systemctl restart skconnector-hub
```

Danach das neue Token im MCP-Eintrag (`claude mcp remove skconnector`,
dann neu hinzufügen) und in den Umgebungsvariablen
nachziehen und mit `devices` gegenprüfen. Die Geräte-Token der Agenten sind
davon nicht betroffen — die Macs bleiben verbunden.

## Grundsätzlich

- Schritte der Reihe nach, nach jedem zeigen, was herauskam.
- Wenn etwas fehlschlägt: nicht drumherum bauen, sondern mir sagen, was klemmt.
- Erfinde keinen Pfad und kein Token. Frag lieber.
