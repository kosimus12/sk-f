# Prompt für Claude Code auf Simons Mac

Alles ab der Trennlinie in Claude Code auf dem eigenen Mac einfügen.

---

Du richtest den SK-Connector fertig ein. Ich sitze am Mac und kann Dialoge
wegklicken und Passwörter eingeben — frag mich, wenn du etwas brauchst, statt zu
raten.

## Ausgangslage

- Repo: `https://github.com/kosimus12/sk-f`, Branch
  `claude/hetzner-multi-device-connector-ply62n`
- Hetzner: `root@138.199.230.178`, Hostname `hermes-1`, Ubuntu 24.04.
  Ich habe von diesem Mac aus SSH-Zugang als root.
- Der Hub ist dort **bereits installiert und läuft**: systemd-Unit
  `skconnector-hub`, lauscht auf `127.0.0.1:8787`, Quellcode in
  `/opt/src/sk-f`. Was noch fehlt: TLS davor, Geräte anlegen, dieser Mac.
- Der Server meldet „System restart required" — das ist Teil deiner Aufgabe.

Das Control-Token steht auf dem Server in `/etc/skconnector/hub.env`. Lies es
dort aus, statt mich danach zu fragen. Schreib es **nirgends** in eine Datei, die
im Repo landet.

## Aufgaben, in dieser Reihenfolge

### 1. Hetzner neu starten

Der Server hat ausstehende Kernel-Updates. Jetzt ist der richtige Zeitpunkt,
weil noch nichts davon abhängt.

```bash
ssh root@138.199.230.178 'apt list --upgradable 2>/dev/null | head -20'
ssh root@138.199.230.178 'apt-get update -qq && apt-get -y upgrade && systemctl reboot' || true
```

Dann warten, bis er wieder da ist, und prüfen, dass der Hub von selbst
hochgekommen ist:

```bash
until ssh -o ConnectTimeout=5 root@138.199.230.178 'systemctl is-active skconnector-hub' 2>/dev/null; do sleep 10; done
ssh root@138.199.230.178 'systemctl status skconnector-hub --no-pager -l | head -15; curl -s localhost:8787/healthz'
```

Kommt der Hub nach dem Neustart **nicht** von selbst hoch, ist das ein Fehler —
melde ihn mir, bevor du weitermachst.

### 2. TLS einrichten

Erst prüfen, was die Ports belegt — auf dem Server laufen vermutlich schon
Websites:

```bash
ssh root@138.199.230.178 'ss -lntp | grep -E ":80 |:443 "'
```

- **Nichts belegt** → Caddy aus dem offiziellen Cloudsmith-Repo installieren
  (Caddy ist *nicht* in Ubuntus Standardquellen), dann
  `/opt/src/sk-f/connector/hub/deploy/Caddyfile` nach `/etc/caddy/Caddyfile`
  kopieren und den Hostnamen eintragen.
- **nginx läuft schon** → kein Caddy. Stattdessen
  `/opt/src/sk-f/connector/hub/deploy/nginx-hub.conf` als vhost anlegen und
  `certbot --nginx` laufen lassen. Die Proxy-Timeouts in der Vorlage sind
  wichtig: ohne sie bricht nginx den Long-Poll nach 60 s mit 504 ab.

Den Hostnamen brauchst du von mir. Frag mich, welche Subdomain ich nehmen will,
und prüfe vorher, ob der A-Record schon auf `138.199.230.178` zeigt:

```bash
dig +short GEWÄHLTE-SUBDOMAIN
```

Zeigt er noch nicht dorthin: sag mir Bescheid, ich lege ihn an — Zertifikate
gibt es sonst keine. Danach:

```bash
curl -s https://GEWÄHLTE-SUBDOMAIN/healthz     # erwartet {"ok":true,...}
```

### 3. Den Hetzner selbst als Gerät anbinden

Damit ich ihn wie jeden anderen Rechner ansprechen kann:

```bash
ssh root@138.199.230.178
cd /opt/src/sk-f && git pull && cd connector
export CONNECTOR_HUB_URL=https://GEWÄHLTE-SUBDOMAIN
export CONNECTOR_CONTROL_TOKEN="$(grep -oP '(?<=CONNECTOR_CONTROL_TOKEN=).*' /etc/skconnector/hub.env)"

python3 tools/skconnect.py add hetzner "Hetzner hermes-1" linux \
        --owner simon --mode full --caps shell,fs,notify,probe
sudo bash agent/linux/install.sh --hub "$CONNECTOR_HUB_URL" --code skc_enr_...
```

### 4. Diesen Mac anbinden

Auf dem Hetzner das Gerät anlegen:

```bash
python3 tools/skconnect.py add mac-simon "Simons Mac" macos \
        --owner simon --mode full \
        --caps shell,fs,notify,probe,app,browser,mail
```

Dann hier lokal, mit dem Enrollment-Code von oben:

```bash
git clone https://github.com/kosimus12/sk-f ~/src/sk-f 2>/dev/null || (cd ~/src/sk-f && git pull)
cd ~/src/sk-f && git checkout claude/hetzner-multi-device-connector-ply62n && git pull
cd connector

bash agent/macos/setup-mac.sh --hub https://GEWÄHLTE-SUBDOMAIN --code skc_enr_...
```

**Wichtig:** `setup-mac.sh` NICHT mit `sudo` starten — es ruft sudo selbst auf,
wo es das braucht. Mit `sudo` davor laufen die Freigabe-Dialoge im falschen
Benutzerkontext und erscheinen gar nicht.

Das Skript hält an, wenn Zustimmungsdialoge kommen. Sag mir jedes Mal, was ich
klicken soll, und warte auf meine Bestätigung.

### 5. Die zwei Dinge, für die es keinen Dialog gibt

Du kannst sie nicht selbst setzen. Führ mich durch, prüf danach nach:

**a) JavaScript aus Apple Events**
- Safari: Einstellungen → Erweitert → „Funktionen für Webentwickler anzeigen",
  dann Menü *Entwickler* → „JavaScript aus Apple Events erlauben"
- Chrome: *Darstellung* → *Entwickler* → „JavaScript über Apple Events zulassen"

**b) Festplattenvollzugriff** für `/bin/bash` und `/usr/bin/python3`
- Systemeinstellungen → Datenschutz & Sicherheit → Festplattenvollzugriff
- „+", dann Cmd+Shift+G und die beiden Pfade eintragen

Gegenprobe vom Hetzner aus, so lange wiederholen, bis nichts mehr `FEHLT` zeigt:

```bash
python3 tools/skconnect.py permissions mac-simon
```

### 6. Zugriff für mich (skuper) in Claude Code auf diesem Mac

Trag den MCP-Server in `~/.claude/mcp.json` ein (vorhandene Einträge behalten):

```json
{
  "mcpServers": {
    "skconnector": {
      "command": "python3",
      "args": ["/Users/skuper/src/sk-f/connector/mcp-server/server.py"],
      "env": {
        "CONNECTOR_HUB_URL": "https://GEWÄHLTE-SUBDOMAIN",
        "CONNECTOR_CONTROL_TOKEN": "skc_ctl_..."
      }
    }
  }
}
```

Vorher `python3 -m pip install --user -r connector/mcp-server/requirements.txt`.
Danach Claude Code neu starten und mit `/mcp` prüfen, ob `skconnector`
verbunden ist.

### 7. Zugriff für die Web-Session (sk-f)

Damit Claude im Browser dieselben Werkzeuge bekommt, ohne dass ein Token in Git
liegt: Im Repo gibt es eine `.mcp.json`, die zwei Umgebungsvariablen liest.
Sag mir, dass ich sie in meiner Claude-Code-Umgebung hinterlegen muss —
`CONNECTOR_HUB_URL` und `CONNECTOR_CONTROL_TOKEN` — und wo das geht.
Trag sie **nicht** in eine Datei im Repo ein.

### 8. Abnahme

Ich klappe den Deckel zu und sperre. Dann prüf der Reihe nach und berichte mir
das Ergebnis:

```bash
python3 tools/skconnect.py devices
python3 tools/skconnect.py probe mac-simon        # zeigt die Schlaf-Werte
python3 tools/skconnect.py run mac-simon 'whoami && ls ~/Documents | head -5'
python3 tools/skconnect.py run mac-simon 'echo test > ~/Documents/ct.txt && cat ~/Documents/ct.txt && rm ~/Documents/ct.txt'
python3 tools/skconnect.py permissions mac-simon
```

In der `probe`-Ausgabe muss `bleibt_wach_zugeklappt: true` stehen. Steht dort
`false`, hat `disablesleep` nicht gegriffen — sag mir das deutlich, statt es zu
übergehen.

### 9. Token tauschen

Das aktuelle Control-Token stand in einem Chatverlauf. Zum Schluss austauschen:

```bash
ssh root@138.199.230.178
sudo sed -i "s|^CONNECTOR_CONTROL_TOKEN=.*|CONNECTOR_CONTROL_TOKEN=skc_ctl_$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')|" /etc/skconnector/hub.env
sudo systemctl restart skconnector-hub
```

Danach das neue Token überall nachziehen, wo du es in Schritt 6 und 7 eingetragen
hast, und noch einmal `devices` aufrufen, damit klar ist, dass es funktioniert.
Die Geräte-Token der Agenten sind davon nicht betroffen — die bleiben gültig.

## Grundsätzlich

- Arbeite die Schritte der Reihe nach ab und zeig mir nach jedem, was
  herausgekommen ist.
- Wenn etwas fehlschlägt: nicht drumherum bauen, sondern mir sagen, was klemmt.
- Erfinde keine Domain, keinen Pfad und kein Token. Frag lieber.
