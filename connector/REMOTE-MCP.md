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

## Einrichtung auf dem Hetzner

### 1. Token ausstellen und ablegen

```bash
cd /opt/src/sk-f/connector
export CONNECTOR_HUB_URL=https://hub.138.199.230.178.sslip.io
export CONNECTOR_CONTROL_TOKEN="$(grep -oP '(?<=CONNECTOR_CONTROL_TOKEN=).*' /etc/skconnector/hub.env)"

python3 tools/skconnect.py token-issue chat --ceiling readonly
```

Das ausgegebene Token in eine eigene Datei — **nicht** in `hub.env`:

```bash
sudo install -m 0640 -o root -g skconnector /dev/null /etc/skconnector/mcp.env
echo 'CONNECTOR_CONTROL_TOKEN=skc_ctl_...' | sudo tee /etc/skconnector/mcp.env
```

### 2. MCP-Dienst installieren

```bash
sudo cp -r /opt/src/sk-f/connector/mcp-server /opt/skconnector/
sudo /opt/skconnector/venv/bin/pip install -q -r /opt/skconnector/mcp-server/requirements.txt
sudo chown -R root:skconnector /opt/skconnector/mcp-server

sudo cp /opt/src/sk-f/connector/hub/deploy/skconnector-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now skconnector-mcp
sudo systemctl status skconnector-mcp --no-pager | head -12
sudo ss -lntp | grep 8788        # muss 172.18.0.1:8788 zeigen
```

### 3. Caddy: Endpunkt hinter einem geheimen Pfad

Der MCP-Endpunkt hat **keine eigene Authentifizierung**. Der Schutz liegt im
Pfad — dasselbe Muster, das dein `alex-mail-mcp`-Block schon benutzt. Pfad mit
`openssl rand -hex 32` erzeugen, nicht ausdenken.

In `/opt/alex-mail-mcp/Caddyfile` ergänzen:

```
mcp.138.199.230.178.sslip.io {
    handle_path /DEIN-GEHEIMER-PFAD/* {
        reverse_proxy 172.18.0.1:8788 {
            transport http {
                read_timeout 300s
                write_timeout 300s
            }
        }
    }
    handle {
        respond "Not found" 404
    }
}
```

```bash
docker exec alex-mail-mcp-caddy-1 caddy reload --config /etc/caddy/Caddyfile
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.138.199.230.178.sslip.io/
# 404 erwartet - ohne den geheimen Pfad gibt es nichts zu sehen
```

> **Der geheime Pfad ist ein Passwort.** Wer die vollständige URL kennt, hat
> den Zugriff, den das hinterlegte Token erlaubt. Deshalb steht dort ein
> `readonly`-Token und nicht das Master-Token. Behandle die URL wie ein
> Geheimnis: nicht in Chats, nicht in Screenshots, nicht ins Repo.

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
