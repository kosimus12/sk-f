# iPhone und iPad anbinden

Auf iOS gibt es keinen Hintergrunddienst, den man wie auf dem Mac installieren
kann. Apple laesst keinen dauerhaft laufenden Fremdprozess zu. Deshalb sieht die
Anbindung hier anders aus als auf den Macs — und deshalb steht am Anfang eine
ehrliche Bestandsaufnahme, was im **gesperrten** Zustand wirklich geht.

## Was bei gesperrtem Gerät funktioniert

| Funktion | Gesperrt? | Wie |
|---|---|---|
| Mitteilung zustellen (`notify`) | **Ja, zuverlässig, in Sekunden** | Push über APNs — der Hub schickt sie an ntfy/Pushcut, Apple stellt sie zu. Unabhängig davon, ob das Display an ist. |
| Statusabfrage (`probe`: Akku, Ort, Gerätename) | **Ja, aber verzögert** | Zeitgesteuerte Kurzbefehl-Automation. Läuft im Hintergrund auch bei gesperrtem Bildschirm — aber im Takt der Automation (Minuten), nicht sofort. |
| Kurzbefehl ausführen (`shortcut`) | **Teilweise** | Wie oben: der Kurzbefehl-Agent holt den Auftrag beim nächsten Lauf ab. Kurzbefehle, die eine Entsperrung verlangen (Face ID, App-Interaktion), warten bis zum Entsperren. |
| Shell / Dateizugriff | **Nein** | Gibt es auf iOS nicht, in keinem Zustand. Dafür sind die Macs da. |
| Gerät orten, sperren, löschen | Ja | Nicht über diesen Konnektor — dafür „Wo ist?" bzw. MDM (siehe unten). |

Kurz gefasst: **Erreichen** kann der Konnektor dein iPhone jederzeit, auch
gesperrt. **Etwas ausführen lassen** geht gesperrt nur im Automations-Takt.
Wer sekundengenaue Befehlsausführung auf einem gesperrten iPhone braucht,
kommt an MDM nicht vorbei (letzter Abschnitt).

## Schritt 1: Push-Kanal einrichten (Pflicht)

Empfohlen: **ntfy**, selbst gehostet auf demselben Hetzner-Server. Dann verlässt
die Mitteilung deine Infrastruktur nur noch als APNs-Payload.

```bash
# auf dem Hetzner-Server
docker run -d --name ntfy --restart unless-stopped \
  -p 127.0.0.1:8080:80 \
  -v /var/lib/ntfy:/var/cache/ntfy \
  binwiederhier/ntfy serve \
  --base-url https://ntfy.DEINE-DOMAIN.de \
  --cache-file /var/cache/ntfy/cache.db
```

Dazu ein Caddy-Block analog zu `hub/deploy/Caddyfile`, dann in der ntfy-App
(App Store) `https://ntfy.DEINE-DOMAIN.de` als Server eintragen und die
Themen abonnieren — pro Gerät ein eigenes, geratenes Thema:

```
simon-iphone-4f9a2c    ipad-simon-7b1e88    gf-iphone-c3d045
```

> Ein ntfy-Thema ist ein Passwort. Wer es kennt, kann Mitteilungen an das Gerät
> schicken. Nimm zufällige Namen, keine sprechenden. Für echte Zugriffskontrolle
> ntfy mit `auth-file` betreiben.

Alternative ohne eigenen Server: **Pushcut** (App Store). Push-URL ist dann
`https://api.pushcut.io/<dein-secret>/notifications/<name>`. Pushcut kann
zusätzlich Kurzbefehle aus einer Mitteilung heraus starten — allerdings erst
nach einem Tipp auf die Mitteilung.

Gerät im Hub anlegen:

```bash
skconnect.py add iphone-simon "Simons iPhone" ios \
    --mode notify --caps notify \
    --push-url https://ntfy.DEINE-DOMAIN.de/simon-iphone-4f9a2c
```

Ab hier funktioniert `notify` — sofort, auch bei gesperrtem Gerät. Ein Enrollment
ist dafür nicht nötig; reine Push-Ziele brauchen kein Geräte-Token.

## Schritt 2: Kurzbefehl-Agent (optional, für `probe` und `shortcut`)

Nur nötig, wenn Claude vom iPhone auch etwas *zurück* bekommen soll.

Zuerst das Gerät auf `readonly` heben und die Fähigkeiten ergänzen:

```bash
skconnect.py add iphone-simon "Simons iPhone" ios \
    --mode readonly --caps notify,probe,shortcut \
    --push-url https://ntfy.DEINE-DOMAIN.de/simon-iphone-4f9a2c
```

Der Befehl gibt einen Enrollment-Code aus. Den brauchst du gleich.

### 2a) Kurzbefehl „Claude-Agent einrichten" (einmalig)

| # | Aktion | Einstellung |
|---|---|---|
| 1 | Nach Text fragen | „Enrollment-Code?" |
| 2 | Wörterbuch | `code` = Ergebnis aus 1, `capabilities` = Liste `notify`, `probe`, `shortcut` |
| 3 | Inhalte von URL abrufen | URL `https://hub.DEINE-DOMAIN.de/v1/agent/register`, Methode `POST`, Anfragetext `JSON` = Wörterbuch aus 2 |
| 4 | Wörterbuchwert abrufen | Schlüssel `device_token` |
| 5 | Datei speichern | `iCloud Drive/Shortcuts/claude-token.txt`, „Überschreiben" ein |

Einmal ausführen, Code eingeben, fertig. Danach den Kurzbefehl löschen.

### 2b) Kurzbefehl „Claude-Agent" (der eigentliche Agent)

| # | Aktion | Einstellung |
|---|---|---|
| 1 | Datei abrufen | `iCloud Drive/Shortcuts/claude-token.txt` → Variable `Token` |
| 2 | Text | `https://hub.DEINE-DOMAIN.de` → Variable `Hub` |
| 3 | Inhalte von URL abrufen | URL `[Hub]/v1/agent/poll?wait=20`, Methode `GET`, Header `Authorization` = `Bearer [Token]` |
| 4 | Wörterbuchwert abrufen | Schlüssel `commands` |
| 5 | Wiederholen mit jedem Objekt | über das Ergebnis aus 4 |
| 6 | ↳ Wörterbuchwert abrufen | `kind` aus `Wiederholungsobjekt` |
| 7 | ↳ Wenn `kind` = `probe` | → Wörterbuch: `battery` = Batteriestand, `name` = Gerätename, `locked` = `true` |
| 8 | ↳ Sonst wenn `kind` = `notify` | → Mitteilung anzeigen mit `payload.title` / `payload.message` |
| 9 | ↳ Sonst wenn `kind` = `shortcut` | → Kurzbefehl ausführen, Name aus `payload.name` |
| 10 | ↳ Wörterbuch | `command_id` = `id` aus Wiederholungsobjekt, `result` = Ergebnis aus 7–9 |
| 11 | ↳ Inhalte von URL abrufen | URL `[Hub]/v1/agent/result`, `POST`, Header `Authorization` = `Bearer [Token]`, JSON = Wörterbuch aus 10 |

### 2c) Automationen, die auch bei gesperrtem Gerät laufen

Kurzbefehle → Automation → **Persönliche Automation**. Wichtig: bei jeder
Automation **„Sofort ausführen"** wählen und **„Vor dem Ausführen fragen" aus**.
Nur dann läuft sie im Hintergrund ohne Entsperren.

Zuverlässig auch gesperrt:

* **Tageszeit** — der Haupttakt. Für halbstündliches Abholen brauchst du
  mehrere Automationen (iOS kennt kein Intervall, nur feste Zeiten). Praktikabel:
  6–8 Automationen über den Tag verteilt, plus die Ereignis-Trigger unten.
* **Ladegerät verbunden / getrennt** — greift nachts am Nachttisch.
* **WLAN verbunden** — greift beim Nachhausekommen.
* **Fokus ein/aus** — greift beim Schlafen-Fokus.
* **NFC-Tag** — braucht ein Antippen, dafür sofort.

Was Apple **nicht** garantiert: den exakten Zeitpunkt. Im Stromsparmodus oder
bei wenig Akku schiebt iOS Hintergrundautomationen auf oder überspringt sie.
Plane den Agenten deshalb als „meldet sich alle paar Minuten bis Stunden", nicht
als „steht permanent bereit".

## Schritt 3: iPad

Identisch zum iPhone, Plattform `ipados`. Das iPad ist der bessere Agent, wenn es
ohnehin dauerhaft am Strom hängt: Automationen laufen dort verlässlicher, weil
das Gerät seltener in tiefe Stromsparzustände geht.

```bash
skconnect.py add ipad-simon "Simons iPad" ipados \
    --mode readonly --caps notify,probe,shortcut \
    --push-url https://ntfy.DEINE-DOMAIN.de/ipad-simon-7b1e88
```

## Wenn du echte Kontrolle über ein gesperrtes iPhone brauchst

Dann führt der Weg über **MDM** (Mobile Device Management). Ein MDM-Server
schickt Befehle über APNs, und iOS führt sie auch im gesperrten Zustand aus —
das ist genau der Mechanismus, mit dem Firmen Firmen-iPhones verwalten.

* Möglich: Geräteinformationen, Ortung, Sperren, Code zurücksetzen, Apps und
  Profile installieren, Einstellungen erzwingen, Fernlöschung.
* Nicht möglich: beliebige Skripte ausführen oder Dateien lesen. Das gibt iOS
  auch per MDM nicht her.
* Aufwand: ein MDM-Server auf dem Hetzner (z. B. MicroMDM oder NanoMDM), ein
  APNs-Push-Zertifikat über das Apple-Push-Certificates-Portal, und die Geräte
  müssen ein Verwaltungsprofil annehmen (für den vollen Funktionsumfang über
  Apple Configurator „betreut" gesetzt werden — das setzt das Gerät zurück).

Dieser Konnektor bringt kein MDM mit. Wenn du den Weg gehen willst, sag
Bescheid — dann baue ich MicroMDM als zusätzlichen Kanal daneben, sodass Claude
beide über dieselben MCP-Werkzeuge anspricht.
