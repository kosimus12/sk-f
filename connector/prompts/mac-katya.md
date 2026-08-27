# Prompt für Claude Code auf Katyas Mac

Vorher auf dem Hetzner den Enrollment-Code erzeugen:

```bash
python3 tools/skconnect.py add mac-katya "Katyas Mac" macos \
        --owner katya --mode full \
        --caps shell,fs,notify,probe,app,browser,mail
```

Den ausgegebenen `skc_enr_…`-Code unten einsetzen. Er ist 30 Minuten gültig und
nur einmal verwendbar.

> **Das Control-Token gehört hier nicht hin.** Dieser Mac braucht nur seinen
> Enrollment-Code. Wer den hat, kann genau ein Gerät anmelden — mehr nicht.

---

Du richtest auf diesem Mac einen Fernzugriffs-Agenten ein. Ich sitze davor und
kann Dialoge bestätigen — frag mich, wenn du etwas brauchst.

## Was hier passiert, und warum du es mir sagen sollst

Dieser Mac wird an einen Konnektor angebunden, über den Simon und Claude aus der
Ferne darauf zugreifen können: Dateien lesen und schreiben, Programme steuern,
Browser-Tabs lesen, Mails in Mail.app lesen. Bevor du irgendetwas installierst,
sag mir das in eigenen Worten und **warte auf mein ausdrückliches Ja**.

Zeig mir dabei auch diese drei Befehle — die gehören zur Einrichtung, nicht als
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

Sag mir außerdem, dass die Stufe jederzeit heruntergesetzt werden kann:
`skconnect.py mode mac-katya readonly` — dann ist nur noch Lesen möglich, kein
Ausführen und kein Schreiben. Wenn ich das lieber will, sag es Simon und
installier trotzdem; die Stufe stellt er auf dem Server um.

## Einrichtung

Wenn ich zugestimmt habe:

```bash
git clone https://github.com/kosimus12/sk-f ~/src/sk-f
cd ~/src/sk-f && git checkout claude/hetzner-multi-device-connector-ply62n
cd connector

bash agent/macos/setup-mac.sh --hub https://HUB-SUBDOMAIN --code skc_enr_...
```

**Ohne `sudo` starten** — das Skript ruft sudo selbst auf, wo es nötig ist. Mit
`sudo` davor erscheinen die Zustimmungsdialoge gar nicht.

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

1. ob der Agent läuft — `sudo launchctl print system/de.skfinanzberatung.connector | head -20`
2. was `pmset -g live | grep -i disablesleep` zeigt. Steht dort `1`, bleibt
   dieser Mac auch zugeklappt wach — das ist Absicht und braucht das Netzteil.
   Wenn ich das nicht will, sag es mir, dann setzen wir es zurück:
   `sudo pmset -a disablesleep 0`
3. dass Simon vom Server aus mit `skconnect.py permissions mac-katya` prüfen kann,
   ob noch eine Freigabe fehlt

Und trag auf diesem Mac **keinen** MCP-Server ein. Der Zugriff läuft über den
Hub; dieser Rechner braucht dafür nichts weiter.
