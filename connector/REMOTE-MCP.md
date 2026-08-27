# Claude Chat und Cowork anbinden

Claude Code auf dem Mac spricht den MCP-Server über einen lokalen Prozess an
(stdio). **Claude im Browser und Cowork können das nicht** — sie brauchen einen
erreichbaren Endpunkt und werden als *Custom Connector* eingetragen. Custom
Connectors über Remote-MCP gibt es für Claude, Cowork und Claude Desktop auf
allen bezahlten Plänen.

## Bevor du das machst: was sich dadurch ändert

Ein Connector im Browser bedeutet: Jede Chat-Sitzung kann auf beide Macs
zugreifen. Chat-Sitzungen verarbeiten ständig fremde Inhalte — Webseiten,
hochgeladene Dokumente, Suchergebnisse. Genau dort ist Prompt Injection kein
Randfall mehr, sondern der wahrscheinlichste Angriffsweg.

Deshalb **niemals das Master-Control-Token in einen Connector eintragen**. Der
Hub kennt seit Version 1.3 abgestufte Tokens:

```bash
# Auf dem Hetzner, mit dem Master-Token in der Umgebung:
python3 tools/skconnect.py token-issue chat --ceiling readonly
python3 tools/skconnect.py token-issue cowork --ceiling readonly
python3 tools/skconnect.py token-list
```

Ausgegeben wird das Token nicht im Terminal, sondern in eine Datei mit 0600
unter `/etc/skconnector/tokens/`. Terminalausgabe landet zu leicht in einem
Chat oder Screenshot, und dieses Token ist ein Passwort. In die Zwischenablage
kommt es ohne Umweg über den Bildschirm:

```bash
pbcopy < /etc/skconnector/tokens/chat.token          # macOS
xclip -selection clipboard < /etc/skconnector/tokens/chat.token   # Linux
```

`--show` zeigt es doch an, `--out PFAD` wählt eine andere Datei.

Ein Token mit `--ceiling readonly` kann lesen — Dateien, Mails, offene Tabs,
Systemstatus — und sonst nichts. Kein `shell`, kein `fs.write`, kein
`app.applescript`, kein `browser.js`, kein `mail.send`. Auch dann nicht, wenn
das Zielgerät auf `full` steht. Und es kann seine eigene Grenze nicht anheben:
Geräte anlegen, umstufen, widerrufen und Tokens ausstellen bleiben dem
Master-Token vorbehalten.

Weiter einschränken geht auch:

```bash
python3 tools/skconnect.py token-issue chat --ceiling readonly --devices mac-simon
```

Dann kommt diese Sitzung an Katyas Mac gar nicht heran.

Jedes abgestufte Token taucht im Audit-Log unter seinem Namen auf
(`control:chat`), auch bei abgelehnten Kommandos. Widerrufen:

```bash
python3 tools/skconnect.py token-revoke chat
```

## Einrichtung auf dem Hetzner — ein Befehl

```bash
cd /opt/src/sk-f && git pull && cd connector
sudo bash hub/deploy/install-mcp.sh --label chat --ceiling readonly
```

Das Skript erledigt alles, was sich automatisieren lässt:

1. prüft, dass der Hub läuft, und liest **die echte Listen-Adresse aus `ss`**
   statt sie zu raten — je nach Einrichtung ist das `127.0.0.1`, `0.0.0.0`
   oder das Docker-Gateway
2. findet den Caddy-Container und dessen Netz-Gateway
3. stellt das abgestufte Token aus und legt es in `/etc/skconnector/mcp.env`
   (0640 root:skconnector) — **nie** in `hub.env`
4. installiert den Dienst `skconnector-mcp` in ein **eigenes venv** und prüft,
   dass er lauscht — im gemeinsamen venv zieht das MCP-SDK starlette hoch und
   der Hub fällt beim nächsten Neustart aus; ein beschädigtes Hub-venv räumt
   das Skript auf
5. erzeugt einen geheimen Pfad mit `openssl rand -hex 32` und ermittelt die
   öffentliche Adresse über die Standardroute (nicht über `hostname -I`, das
   auch Docker-Brücken auflistet)
6. schreibt den **fertigen** Caddy-Block nach `/etc/skconnector/caddy-mcp.conf`
   — mit echtem Hostnamen, ohne Platzhalter — und druckt die Connector-URL

Enger einstellen geht über die Argumente:

```bash
# nur ein Gerät:
sudo bash hub/deploy/install-mcp.sh --label chat --ceiling readonly --devices mac-simon

# nur Mitteilungen, gar kein Lesen:
sudo bash hub/deploy/install-mcp.sh --label chat --ceiling notify
```

Was **nicht** automatisch geht: das Einfügen in den Caddyfile. Der gehört einem
anderen Stack (`alex-mail-mcp`), und ein Skript, das fremde Konfiguration
umschreibt, ist ein Skript, das irgendwann etwas kaputt macht. Der Block liegt
fertig in `/etc/skconnector/caddy-mcp.conf`, anhängen und neu laden musst du
selbst:

```bash
cat /etc/skconnector/caddy-mcp.conf >> /opt/alex-mail-mcp/Caddyfile
docker exec alex-mail-mcp-caddy-1 caddy reload --config /etc/caddy/Caddyfile
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.138.199.230.178.sslip.io/
```

Die Gegenprobe muss **404** liefern. **000** heißt: Caddy kennt den Namen gar
nicht — der Block fehlt im Caddyfile oder wurde nicht geladen, und deshalb gibt
es auch kein Zertifikat für den Namen. Kein Netzwerkproblem, ein Konfigproblem.

### 4. Als Custom Connector eintragen

In Claude (Browser) unter **Einstellungen → Connectors → Custom Connector
hinzufügen**:

```
Name:  SK Connector
URL:   https://mcp.138.199.230.178.sslip.io/DEIN-GEHEIMER-PFAD/mcp
```

Cowork nutzt dieselbe Connector-Liste — einmal eintragen genügt für beide.

Erster Test: *„Zeig mir die verbundenen Geräte."* → `devices` muss drei Zeilen
liefern. Dann die Gegenprobe, dass die Grenze wirkt: *„Führ `uptime` auf
mac-simon aus."* → muss mit einer Meldung über die Token-Obergrenze scheitern.

## Die drei Oberflächen im Vergleich

| | Transport | Token | Was geht |
|---|---|---|---|
| **Claude Code (Terminal)** | stdio, lokaler Prozess | Master | alles |
| **Claude Chat (Browser)** | Remote-MCP über Caddy | `chat`, readonly | nur lesen |
| **Cowork** | derselbe Endpunkt | `cowork`, readonly | nur lesen |

Dass das Terminal mehr darf, ist Absicht: Dort sitzt ein Mensch, der sieht, was
läuft, und der Kontext kommt aus dem Projekt statt aus einer beliebigen
Webseite.

Wenn du im Chat doch einmal schreibend arbeiten willst, ist der Weg nicht, das
Token hochzustufen — sondern die Aufgabe im Terminal zu machen.

## Wenn du es wieder loswerden willst

```bash
python3 tools/skconnect.py token-revoke chat
sudo systemctl disable --now skconnector-mcp
# Site-Block aus dem Caddyfile entfernen, dann:
docker exec alex-mail-mcp-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

Der Connector in Claude meldet danach einen Verbindungsfehler; entfernen kannst
du ihn in denselben Einstellungen.
