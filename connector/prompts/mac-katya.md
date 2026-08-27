# Prompt für Claude Code auf Katyas Mac

Der Enrollment-Code kommt aus Schritt 6 des Prompts auf Simons Mac:

```bash
python3 tools/skconnect.py add mac-katya "Katyas Mac" macos \
        --owner katya --mode full \
        --caps shell,fs,notify,probe,app,browser,mail
```

Den `skc_enr_…`-Code unten einsetzen. 30 Minuten gültig, einmal verwendbar.

> **Das Control-Token gehört hier nicht hin.** Dieser Mac braucht nur seinen
> Enrollment-Code. Wer den hat, kann genau ein Gerät anmelden — mehr nicht.

---

Du richtest auf diesem Mac einen Fernzugriffs-Agenten ein. Ich sitze davor und
kann Dialoge bestätigen — frag mich, wenn du etwas brauchst.

Hub: `https://hub.138.199.230.178.sslip.io`
Enrollment-Code: `skc_enr_HIER_EINSETZEN`

## Zuerst: erklären und Zustimmung einholen

Bevor du irgendetwas installierst, sag mir in eigenen Worten, was hier
eingerichtet wird: Dieser Mac wird an einen Konnektor angebunden, über den Simon
und Claude aus der Ferne darauf zugreifen können — Dateien lesen **und
schreiben**, Shell-Befehle ausführen, Programme steuern, Browser-Tabs lesen,
Mails in Mail.app lesen. Das gilt auch, wenn der Bildschirm gesperrt ist.

**Warte auf mein ausdrückliches Ja.**

Zeig mir dabei diese drei Befehle — sie gehören zur Einrichtung, nicht als
Nachtrag hinterher:

```bash
# Was wurde auf diesem Mac gemacht? Jedes Kommando mit Zeitstempel:
python3 tools/skconnect.py audit --device mac-katya --limit 100

# Sofort abklemmen, von überall, wirkt in Sekunden:
python3 tools/skconnect.py revoke mac-katya

# Endgültig entfernen, direkt hier am Mac:
sudo launchctl bootout system/de.skfinanzberatung.connector
sudo rm -rf /Library/LaunchDaemons/de.skfinanzberatung.connector.plist \
            /usr/local/libexec/skconnector /etc/skconnector
```

Sag mir außerdem: Die Stufe lässt sich jederzeit auf reines Lesen senken —
`skconnect.py mode mac-katya readonly`, dann kein Ausführen und kein Schreiben
mehr. Wenn ich das lieber will, sag es Simon; installier trotzdem, die Stufe
stellt er auf dem Server um.

## Einrichtung

Wenn ich zugestimmt habe:

```bash
git clone https://github.com/kosimus12/sk-f ~/src/sk-f
cd ~/src/sk-f && git checkout claude/hetzner-multi-device-connector-ply62n
cd connector

bash agent/macos/setup-mac.sh \
     --hub https://hub.138.199.230.178.sslip.io \
     --code skc_enr_HIER_EINSETZEN
```

**Ohne `sudo` starten** — das Skript ruft sudo selbst auf, wo nötig. Mit `sudo`
davor erscheinen die Zustimmungsdialoge gar nicht.

Das Skript hält an, wenn Dialoge kommen („Terminal möchte Mail steuern" und
ähnliche). Sag mir jedes Mal, was ich klicken soll, und warte auf meine
Bestätigung. Ich muss jeden einzelnen bewusst erlauben.

## Zwei Dinge, für die es keinen Dialog gibt

Führ mich durch, prüf danach nach:

**a) JavaScript aus Apple Events**
- Safari: Einstellungen → Erweitert → „Funktionen für Webentwickler anzeigen",
  dann Menü *Entwickler* → „JavaScript aus Apple Events erlauben"
- Chrome: *Darstellung* → *Entwickler* → „JavaScript über Apple Events zulassen"

**b) Festplattenvollzugriff** für `/bin/bash` und `/usr/bin/python3`
- Systemeinstellungen → Datenschutz & Sicherheit → Festplattenvollzugriff
- „+", dann Cmd+Shift+G und die beiden Pfade eintragen

## Zum Schluss

Sag mir:

1. ob der Agent läuft:
   `sudo launchctl print system/de.skfinanzberatung.connector | head -20`
2. was `pmset -g live | grep -i disablesleep` zeigt. Steht dort `1`, bleibt
   dieser Mac auch zugeklappt wach — das ist Absicht und **braucht das
   Netzteil**, sonst läuft der Akku leer. Wenn ich das nicht will:
   `sudo pmset -a disablesleep 0`
3. dass Simon vom Server aus prüfen kann, ob noch etwas fehlt:
   `skconnect.py permissions mac-katya` und `skconnect.py probe mac-katya`

Trag auf diesem Mac **keinen** MCP-Server ein und keine Umgebungsvariablen mit
dem Control-Token. Der Zugriff läuft über den Hub; dieser Rechner braucht dafür
nichts weiter.
