# Due Diligence und Sicherheitsprüfung

Stand: 27. August 2026, nach Abschluss der Einrichtung beider Macs.
Geprüft am Code, nicht am Konzept.

**Was im Betrieb ist:** Hub auf `hermes-1` (Hetzner), drei Geräte — `hetzner`
(Linux, full), `mac-simon` (macOS, full), `mac-katya` (macOS, full).

---

## Zusammenfassung

Fünf Befunde, alle behoben. Vier davon hätten in der Praxis kaum jemand
ausgenutzt, weil sie hinter dem Control-Token liegen — das ändert aber nichts
daran, dass sie Fehler waren. Der fünfte (Push-URL im Audit-Log) hätte ein
Geheimnis in ein Protokoll geschrieben, das man gerade deshalb liest, weil man
ihm vertraut.

Was **nicht** behoben ist und sich auch nicht beheben lässt, steht unter
„Verbleibende Risiken". Der wichtigste Punkt dort ist Prompt Injection, und er
ist kein Randfall.

| # | Befund | Schwere | Status |
|---|---|---|---|
| 1 | Push-URL landete im Klartext im Audit-Log | **hoch** | behoben |
| 2 | Keine Prüfung der Push-URL → SSRF vom Hub aus | mittel | behoben |
| 3 | `fs.write` ohne Größenbegrenzung | mittel | behoben |
| 4 | CRLF im Mitteilungstitel → Header-Injection-Versuch | niedrig | behoben |
| 5 | `notify` benutzte JSON- statt AppleScript-Escaping | niedrig | behoben |

108 Tests, davon 7 neu als Regression zu genau diesen Befunden.

---

## Die Befunde im Einzelnen

### 1. Push-URL im Audit-Log — hoch

`PATCH /v1/devices/{id}` schrieb alle geänderten Felder ins Audit-Log, auch
`push_url`. Eine Pushcut-URL hat die Form
`https://api.pushcut.io/<API-KEY>/notifications/<name>` — der Schlüssel steckt
im Pfad. Wer das Audit-Log lesen darf, hätte damit Mitteilungen im Namen des
Kontos verschicken können.

Besonders unangenehm, weil das Audit-Log die Stelle ist, an der man nach einem
Vorfall nachsieht — dort erwartet man keine Geheimnisse.

**Behoben:** Das Log vermerkt nur noch `push_url: <gesetzt>`. Ein Test prüft,
dass die echte URL nirgends in der Audit-Ausgabe auftaucht.

### 2. SSRF über die Push-URL — mittel

Der Hub POSTet serverseitig an die hinterlegte Push-URL. Ohne Prüfung war jede
Adresse erlaubt — auch `http://169.254.169.254/latest/meta-data/`, der
Metadatendienst der meisten Cloud-Anbieter, oder interne Dienste auf dem
Hetzner, die nur von localhost erreichbar sind.

Voraussetzung war das Control-Token. Wer das hat, hat ohnehin Shell auf allen
Geräten — der Befund ist also keine Rechteausweitung, sondern ein zusätzlicher
Weg, der nicht hätte offenstehen sollen.

**Behoben:** `check_push_url` verlangt `http://` oder `https://`, verbietet
Zugangsdaten in der URL, Steuerzeichen und den Metadaten-Bereich `169.254.*`.
Private Netze bleiben erlaubt — ein selbst gehostetes ntfy liegt typischerweise
dort.

### 3. `fs.write` ohne Grenze — mittel

Der Hub prüfte bei `fs.write` nur, ob ein Pfad da war. Ein einzelnes Kommando
mit einem sehr großen `content` hätte die Platte des Zielgeräts füllen können —
auf einem MacBook mit knappem Speicher reicht dafür wenig.

**Behoben:** 1 MiB pro Kommando. Größere Dateien gehören über die Shell und
einen Download, nicht in einen JSON-Payload.

### 4. CRLF im Mitteilungstitel — niedrig

`_header_safe` schrieb Umlaute um und warf Nicht-ASCII weg, ließ aber `\r` und
`\n` durch. Beide sind ASCII. Bei ntfy geht der Titel als HTTP-Header raus.

Praktisch wäre daraus keine Injection geworden: Pythons `http.client` prüft
Header-Werte und wirft einen `ValueError`. Das Ergebnis wäre also eine still
fehlschlagende Zustellung statt eines eingeschleusten Headers — trotzdem falsch.

**Behoben:** Alle Steuerzeichen werden durch Leerzeichen ersetzt, Titel auf 200
Zeichen begrenzt.

### 5. Uneinheitliches Escaping in `notify` — niedrig

`run_notify` baute sein AppleScript mit `json.dumps`, alle anderen Stellen mit
`as_literal`. Die beiden sehen ähnlich aus und sind es nicht ganz. Kein
bekannter Ausbruch, aber zwei Escaping-Funktionen für dieselbe Sprache sind ein
Fehler, der irgendwann einen findet.

**Behoben:** Überall `as_literal`.

---

## Was geprüft wurde und in Ordnung ist

**Authentifizierung.** Control-Token wird mit `hmac.compare_digest` verglichen,
also ohne Timing-Leck. Geräte-Token liegen nur als SHA-256-Hash in der
Datenbank; ein Test liest die DB-Datei binär und prüft, dass weder Token noch
Enrollment-Code im Klartext darin vorkommen. Beide Tokens haben 256 Bit
Entropie — Raten scheidet aus, deshalb ist die fehlende Rate-Begrenzung hier
kein Befund.

**SQL.** Alle Abfragen sind parametrisiert. Die einzige dynamisch gebaute
Abfrage (`claim_next` mit Kind-Filter) erzeugt nur Platzhalter, die Werte gehen
als Parameter — und die Kind-Liste wird vorher gegen `ALL_KINDS` geprüft.

**Geräte-IDs** sind auf `^[a-z0-9][a-z0-9._-]*$` beschränkt und landen nie in
einem Pfad.

**AppleScript-Escaping.** Betreffs, Empfängeradressen, URLs und Programmnamen
gehen durch `as_literal`; zusätzlich weist der Hub Anführungszeichen und
Zeilenumbrüche in Adressen und URLs ab. Tests versuchen den Ausbruch mit
`"} tell application "Finder" to delete every item of desktop` — er landet als
escapeter String im Skript, nicht als Code.

**Widerruf** wirkt sofort: Das Token wird gelöscht, offene Kommandos werden
abgebrochen, und der laufende Long-Poll des Agenten bekommt beim nächsten
Durchlauf 403 und beendet sich selbst.

**Trennung der Prozesse.** System-Daemon und optionaler Sitzungs-Agent teilen
sich ein Token, aber nicht die Aufträge — der Kind-Filter verhindert, dass der
eine Kommandos annimmt, die er nicht ausführen kann.

**Netzwerk.** Der Hub ist nicht direkt erreichbar; davor steht Caddy im
Container mit Let's-Encrypt-Zertifikat. Port 8787 ist per iptables von außen
geDROPt, von dir extern gegengeprüft. systemd-Härtung ist aktiv
(`ProtectSystem=strict`, `NoNewPrivileges`, `MemoryDenyWriteExecute`,
eingeschränkte Adressfamilien).

**Dateirechte.** `/etc/skconnector/hub.env` ist `0640 root:skconnector`,
`agent.json` auf den Macs `0600`. Keine Tokens in Logs — der Agent protokolliert
Kommando-ID und -Art, nicht den Inhalt.

---

## Verbleibende Risiken

Diese sind nicht behebbar, sondern zu entscheiden.

### Prompt Injection — das mit Abstand größte

Wenn ich eine Webseite lese, eine Mail öffne oder ein Dokument verarbeite, das
versteckte Anweisungen enthält, kann daraus ein echtes Kommando auf euren Macs
werden. Deny-Liste und Audit-Log begrenzen den Schaden, verhindern ihn nicht.

Das Risiko ist durch den Ausbau **gewachsen**: `browser_read` und `mail_read`
holen aktiv fremden Text in meinen Kontext, und `app.applescript` sowie
`browser.js` sind mächtige Werkzeuge direkt daneben.

Was hilft: Geräte so niedrig einstufen, wie es der Zweck erlaubt. Das Audit-Log
gelegentlich lesen. Und bei Aufgaben, die fremde Inhalte verarbeiten, im Kopf
behalten, dass diese Inhalte mitreden können.

### Die Deny-Liste ist ein Stolperdraht, keine Sandbox

`rm -rf /` wird abgewiesen. `echo cm0gLXJmIC8K | base64 -d | sh` nicht. Das ist
Absicht und dokumentiert: Die Liste fängt Tippfehler und halluzinierte Pfade,
nicht jemanden, der sie umgehen will. Wer das Control-Token hat, hat root.

Dasselbe gilt für den `do shell script`-Scan in `app.applescript`: Er erkennt
Literale, nicht `set c to "..."` mit anschließendem `do shell script c`. Ein
Test hält diese Lücke ausdrücklich fest, statt sie zu verschweigen.

### Der Hub sieht alles im Klartext

Jedes Kommando und jedes Ergebnis läuft unverschlüsselt durch den Hub —
Dateiinhalte, Mailtexte, Seiteninhalte. Wer `hermes-1` übernimmt, übernimmt
beide Macs. Der Server trägt damit dasselbe Gewicht wie die Geräte selbst.

Auf demselben Server laufen zwölf weitere Container. Jeder davon ist ein
möglicher Weg zum Hub — sie hängen im selben Docker-Netz, und der Hub lauscht
auf `0.0.0.0`. Die iptables-Regeln schützen nach außen, nicht zwischen den
Containern.

### Katyas Mac steht auf `full`

Das war eure Entscheidung und sie ist protokolliert. Konkret heißt es: Shell als
root, Dateien schreiben, Programme steuern, Mails lesen — auch bei gesperrtem
Bildschirm. Dieselben Rechte wie auf deinem eigenen Mac.

Was das praktisch bedeutet, ist wichtiger als die Einstellung selbst: Der
Zugriff ist nicht auf „gemeinsame" Daten begrenzt. Er umfasst ihre Mails, ihre
Dokumente, ihre Browsersitzungen. Wenn das nicht dem entspricht, was ihr
besprochen habt, ist `skconnect.py mode mac-katya readonly` ein Befehl und
sofort wirksam.

### Kein Vier-Augen-Prinzip

Kein Kommando wartet auf Bestätigung. Was abgesetzt wird, läuft. Der einzige
Notausgang ist `killswitch on`, und der wirkt erst nach dem laufenden Kommando.

### Der Akku

Kein Sicherheitsthema, aber der wahrscheinlichste Ausfallgrund: `disablesleep=1`
gilt systemweit. Ein MacBook ohne Netzteil läuft leer und ist dann offline —
mitten in einer Aufgabe.

---

## Empfehlungen, nach Nutzen sortiert

1. **Audit-Log wöchentlich anschauen.** `skconnect.py audit --limit 200`. Fünf
   Minuten. Es ist die einzige Kontrolle, die Prompt Injection tatsächlich
   sichtbar macht.
2. **`mail.send` aus lassen.** Entwürfe reichen für fast alles, und ein
   verschickter Mail lässt sich nicht zurückholen.
3. **Beide Macs am Netzteil**, sonst ist der ganze Aufwand für den
   zugeklappten Betrieb umsonst.
4. **Backup der Hub-Datenbank** (`/var/lib/skconnector/hub.db`). Geht sie
   verloren, müssen alle Geräte neu enrollen — kein Drama, aber ein Abend.
5. **Den Hub auf das Docker-Gateway binden** statt auf `0.0.0.0`
   (`CONNECTOR_BIND=172.18.0.1`), sobald du ohnehin am Server bist. Dann hängt
   der Schutz nicht allein an iptables-Regeln, die jemand versehentlich flushen
   kann.
6. **Vor Reisen** `pmset -a disablesleep 0` und nach der Rückkehr wieder an —
   oder den Mac bewusst offline lassen.

---

## Wenn etwas passiert

```bash
python3 tools/skconnect.py killswitch on          # zuerst, Fragen danach
python3 tools/skconnect.py audit --limit 500      # was ist gelaufen?
python3 tools/skconnect.py revoke mac-simon
python3 tools/skconnect.py revoke mac-katya
python3 tools/skconnect.py revoke hetzner
```

Danach Control-Token tauschen, Geräte neu enrollen. Die Agenten auf den Macs
beenden sich beim nächsten Poll von selbst, sobald ihr Token widerrufen ist.
