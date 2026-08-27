# Wenn Port 80/443 von einem Docker-Reverse-Proxy belegt sind

Zeigt `ss -lntp | grep -E ':80 |:443 '` den Prozess `docker-proxy`, läuft der
Reverse-Proxy in einem Container. Dann **weder Caddy noch nginx auf dem Host
installieren** — beide würden an den belegten Ports scheitern. Stattdessen den
Hub in den vorhandenen Proxy einhängen.

## Schritt 1 — Herausfinden, welcher Proxy es ist

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

Am Image erkennst du den Typ:

| Image enthält | Proxy | Weiter bei |
|---|---|---|
| `traefik` | Traefik | Abschnitt A |
| `nginx-proxy-manager`, `jc21/nginx-proxy-manager` | Nginx Proxy Manager | Abschnitt B |
| `caddy` | Caddy im Container | Abschnitt C |
| `nginxproxy/nginx-proxy` | nginx-proxy (jwilder) | Abschnitt D |
| `nginx`, `swag`, `zoraxy` … | siehe Abschnitt E | |

## Schritt 2 — Den Hub für Container erreichbar machen

Der Hub lauscht standardmäßig auf `127.0.0.1:8787`. Aus einem Container ist das
**nicht** erreichbar: dessen `localhost` ist der Container selbst. Er muss
zusätzlich auf dem Docker-Bridge-Gateway lauschen — auf dem Host meist
`172.17.0.1`.

Gateway ermitteln:

```bash
ip -4 addr show docker0 | awk '/inet /{print $2}' | cut -d/ -f1     # meist 172.17.0.1
```

Dann eintragen und neu starten:

```bash
echo 'CONNECTOR_BIND=172.17.0.1' | sudo tee -a /etc/skconnector/hub.env
sudo systemctl daemon-reload
sudo systemctl restart skconnector-hub
sudo ss -lntp | grep 8787          # muss jetzt 172.17.0.1:8787 zeigen
```

Gegenprobe aus einem Container heraus:

```bash
docker run --rm curlimages/curl -s http://172.17.0.1:8787/healthz
```

> **Was das bedeutet:** Der Hub ist damit für jeden Container auf dem
> Standard-Bridge-Netz erreichbar, nicht mehr nur für Prozesse auf dem Host.
> Aus dem Internet bleibt er unerreichbar, und ohne Control- bzw. Geräte-Token
> nimmt er weiterhin nichts an. Wer das enger haben will, hängt den Hub
> stattdessen in ein eigenes Docker-Netz zusammen mit dem Proxy-Container.

Läuft der Proxy-Container in einem **eigenen** Netz (nicht `bridge`), ist das
Gateway ein anderes:

```bash
docker inspect PROXY-CONTAINER -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.Gateway}}{{"\n"}}{{end}}'
```

Dann diese Gateway-Adresse als `CONNECTOR_BIND` nehmen. Hängt der Container in
mehreren Netzen, `CONNECTOR_BIND=0.0.0.0` setzen und Port 8787 per Firewall
von außen sperren:

```bash
sudo ufw deny 8787/tcp        # falls ufw aktiv
```

## A — Traefik

Traefik braucht eine Route auf einen Host-Dienst. Am einfachsten über den
File-Provider. Prüfe zuerst, ob einer konfiguriert ist:

```bash
docker inspect TRAEFIK-CONTAINER -f '{{json .Mounts}}' | python3 -m json.tool
docker exec TRAEFIK-CONTAINER cat /etc/traefik/traefik.yml 2>/dev/null
```

Ist ein Verzeichnis wie `/etc/traefik/dynamic` gemountet, dort ablegen:

```yaml
# dynamic/skconnector.yml
http:
  routers:
    skconnector:
      rule: "Host(`hub.DEINE-DOMAIN.de`)"
      entryPoints: [websecure]
      service: skconnector
      tls:
        certResolver: letsencrypt     # Namen aus deiner Traefik-Config uebernehmen
  services:
    skconnector:
      loadBalancer:
        servers:
          - url: "http://172.17.0.1:8787"
        # Long-Poll: Antworten nicht puffern
        passHostHeader: true
```

Traefik liest die Datei automatisch neu. Fehlt ein File-Provider, in
`traefik.yml` ergänzen:

```yaml
providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true
```

Traefik hat standardmäßig kein Antwort-Timeout auf Backend-Seite — der
25-Sekunden-Long-Poll läuft ohne Zusatzconfig durch.

## B — Nginx Proxy Manager

Über die Weboberfläche (meist Port 81):

1. **Hosts → Proxy Hosts → Add Proxy Host**
2. *Domain Names*: `hub.DEINE-DOMAIN.de`
3. *Scheme*: `http`, *Forward Hostname / IP*: `172.17.0.1`, *Forward Port*: `8787`
4. *Websockets Support*: **an** (schadet nicht, hilft beim Long-Poll)
5. Reiter **SSL**: *Request a new SSL Certificate*, *Force SSL* an
6. Reiter **Advanced**, damit der Long-Poll nicht nach 60 s abbricht:

```
proxy_read_timeout 120s;
proxy_send_timeout 120s;
proxy_buffering off;
```

## C — Caddy im Container

Caddyfile finden und ergänzen:

```bash
docker inspect CADDY-CONTAINER -f '{{json .Mounts}}' | python3 -m json.tool
```

Im Caddyfile anhängen:

```
hub.DEINE-DOMAIN.de {
    reverse_proxy 172.17.0.1:8787 {
        transport http {
            read_timeout 120s
            write_timeout 120s
        }
    }
}
```

Dann neu laden:

```bash
docker exec CADDY-CONTAINER caddy reload --config /etc/caddy/Caddyfile
```

## D — nginx-proxy (jwilder / nginxproxy)

Dieser Proxy konfiguriert sich über Container-Umgebungsvariablen und kennt
Host-Dienste nicht von selbst. Zwei Wege:

1. **Sauber:** den Hub selbst als Container betreiben, mit
   `VIRTUAL_HOST=hub.DEINE-DOMAIN.de` und `VIRTUAL_PORT=8787`.
2. **Schnell:** eine eigene vhost-Datei in das gemountete
   `/etc/nginx/vhost.d`-Verzeichnis legen und auf `172.17.0.1:8787`
   weiterleiten — Vorlage ist `nginx-hub.conf` in diesem Verzeichnis, nur der
   `server`-Block wird zu einer `location`.

## E — Etwas anderes

Dann gilt allgemein: eine Route für `hub.DEINE-DOMAIN.de` auf
`http://172.17.0.1:8787` anlegen, mit **Read-Timeout ≥ 120 s** und **ohne
Response-Buffering**. Beides ist nicht optional — der Agent hält jede
Verbindung bis zu 25 Sekunden offen, und ein 60-Sekunden-Timeout im Proxy
führt zu Dauer-Reconnects und 504ern im Log.

## Abschluss — immer gleich

```bash
curl -s https://hub.DEINE-DOMAIN.de/healthz          # {"ok":true,...}

# Long-Poll wirklich testen: muss ~25 s offen bleiben und dann leer antworten
time curl -s -H "Authorization: Bearer FALSCHES-TOKEN" \
     https://hub.DEINE-DOMAIN.de/v1/agent/poll
```

Der zweite Test gibt `403` zurück — das ist richtig so. Entscheidend ist, dass
`/healthz` über HTTPS antwortet und der Proxy nicht vorher abbricht.
