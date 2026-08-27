# Sicherheitsmodell

Dieser Konnektor gibt einem Sprachmodell Shell-Zugriff auf deine Rechner. Das
ist mächtig und entsprechend heikel. Dieses Dokument sagt, was ihn absichert —
und was er ausdrücklich **nicht** leistet.

## Vertrauensgrenzen

```
Claude ──┐
         │ Control-Token (Generalschlüssel)
         ▼
       Hub ── Policy ── Audit-Log ── SQLite
         │ Geräte-Token (eines je Gerät)
         ▼
     Agent ── führt aus, was der Hub durchgelassen hat
```

Der **Hub** ist die einzige Stelle, die Regeln durchsetzt. Der Agent vertraut
dem Hub vollständig: Was dort ankommt, führt er aus. Wer das Control-Token
besitzt, kann alles, was die Geräte-Modi erlauben. Behandle es wie einen
SSH-Schlüssel zu allen deinen Rechnern.

## Was durchgesetzt wird

### Berechtigungsstufen (je Gerät)

| Modus | Erlaubt |
|---|---|
| `notify` | nur Mitteilungen |
| `readonly` | Mitteilungen, Kurzbefehle, `fs.list`, `fs.read`, `probe` |
| `full` | zusätzlich `fs.write` und `shell` |

Ein Gerät kann nur, was **beide** Seiten hergeben: der Modus *und* die
Fähigkeiten, die der Agent beim Enrollment gemeldet hat. Ein iPhone bekommt
`shell` also selbst im Modus `full` nicht, weil es die Fähigkeit nie meldet.

### Deny-Liste

Greift auch im Modus `full`, im Hub, bevor das Kommando ein Gerät erreicht:
rekursives `rm -rf`, `mkfs`, `dd` auf Blockgeräte, Schreiben nach `/dev/disk*`,
`diskutil erase`, `shutdown`/`reboot`/`halt`, `csrutil disable`,
`spctl --master-disable`, Fork-Bombs, `chmod 777 /`, `chown … /`, `history -c`,
`shred`, Schreiben auf `/etc/sudoers|shadow|passwd`, Keychain-Dumps.

Das ist ein **Stolperdraht gegen Unfälle**, keine Sandbox. Wer die Liste
umgehen will, kann das (Base64, Skriptdatei, Umwege). Sie fängt den Tippfehler
und den halluzinierten Pfad — nicht den Angreifer mit Control-Token.

### Allowlist (optional, je Gerät)

`--allowlist git,ls,cat,grep` erlaubt nur diese Programme als erstes Wort eines
Kommandos. Für die Geräte anderer Personen die richtige Voreinstellung, wenn sie
überhaupt Shell-Zugriff geben wollen.

### Tokens

* Control-Token: in `/etc/skconnector/hub.env`, `0640 root:skconnector`.
* Geräte-Token: je Gerät eines, beim Enrollment vergeben, auf dem Gerät in
  `/etc/skconnector/agent.json` mit `0600`.
* In der Hub-Datenbank stehen **nur SHA-256-Hashes**. Ein Test prüft, dass
  weder Token noch Enrollment-Code im Klartext in der Datei landen.
* Enrollment-Codes: einmal verwendbar, Standard-TTL 30 Minuten.
* Push-URLs (Pushcut enthält den API-Key) werden nie in API-Antworten
  ausgeliefert — nur das Flag `push_configured`.

### Widerruf und Not-Aus

```bash
skconnect.py revoke mac-freundin    # ein Gerät: Token weg, offene Kommandos abgebrochen
skconnect.py killswitch on          # alle Geräte: Hub nimmt nichts mehr an
```

Der Agent bemerkt den Widerruf beim nächsten Poll (spätestens nach 25 s) und
beendet sich selbst.

### Audit-Log

Jedes ausgegebene Kommando, jede Ablehnung, jede Übernahme durch ein Gerät,
jeder Abschluss, jeder Widerruf, jede Push-Zustellung. Abrufbar über
`skconnect.py audit` oder das MCP-Werkzeug `audit_log`. Aufbewahrung 30 Tage
(`CONNECTOR_RETENTION_DAYS`).

### Netzwerk

Der Hub lauscht nur auf `127.0.0.1:8787`. Nach außen steht Caddy mit TLS und
HSTS. Es gibt keinen eingehenden Port auf einem Mac oder iPhone — alle
Verbindungen gehen von den Geräten aus.

## Was dieser Konnektor NICHT leistet

* **Keine Sandbox.** Ein Kommando im Modus `full` läuft als `root`. Es gibt kein
  Chroot, kein seccomp, keine Ressourcengrenzen.
* **Kein Schutz vor Prompt Injection.** Liest Claude eine Webseite oder E-Mail
  mit versteckten Anweisungen und hat dieses Werkzeug, kann daraus ein echtes
  Kommando auf deinem Mac werden. Deny-Liste und Audit-Log begrenzen den
  Schaden, sie verhindern ihn nicht. **Das ist das größte reale Risiko dieses
  Aufbaus.** Gegenmittel: Geräte so niedrig wie möglich einstufen, Allowlists
  nutzen, das Audit-Log gelegentlich lesen.
* **Kein Vier-Augen-Prinzip.** Kein Kommando wartet auf eine Bestätigung.
* **Keine Ende-zu-Ende-Verschlüsselung.** Der Hub sieht jedes Kommando und
  jedes Ergebnis im Klartext. Wer den Hetzner-Server übernimmt, übernimmt alles.
* **Kein Schutz vor dir selbst.** Wer das Control-Token hat, ist der Chef.

## Empfehlungen

1. Alles auf der niedrigsten Stufe anlegen, die den Zweck erfüllt. `full` nur
   für Geräte, auf denen Claude wirklich arbeiten soll.
2. Für die Geräte deiner Freundin: `--mode notify`, und Höherstufung nur nach
   ausdrücklicher Zustimmung. Zeig ihr `revoke` und `audit`.
3. Control-Token in den Passwortmanager, nicht in ein Shell-Profil, das in
   einem Repo landet.
4. Auf dem Hetzner: SSH mit Schlüsseln, `fail2ban`, ungenutzte Ports zu.
   Der Hub ist nur so sicher wie der Server, auf dem er läuft.
5. Nach einem Verdacht: `killswitch on`, dann `audit --limit 500` lesen, dann
   alle Geräte widerrufen und neu enrollen.
6. Das Repo enthält keine Tokens. Halte das so — `agent.json` und `hub.env`
   gehören nie in Git.

## Ein Problem melden

Wenn dir etwas auffällt: `killswitch on` zuerst, Fragen danach. Der Not-Aus
kostet nichts außer ein paar Minuten Bequemlichkeit.
