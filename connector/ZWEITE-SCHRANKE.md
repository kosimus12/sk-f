# Zweite Schranke: ein Code aus der Authenticator-App

## Wogegen das hilft — und wogegen nicht

Der Fall, um den es geht: Jemand übernimmt den Claude-Account. Damit hat er
auch die Control-Tokens, denn die liegen in der Connector-Konfiguration und in
den Umgebungsvariablen der Cloud-Umgebung. Bis hierher hätte er damit vollen
Zugriff auf beide Macs und den Server.

Mit der zweiten Schranke reicht das Token nicht mehr. Jeder Zugriff auf ein
Gerät verlangt zusätzlich einen sechsstelligen Code, der alle 30 Sekunden
wechselt und auf dem Telefon erzeugt wird. Das Telefon hat der Angreifer nicht.

Was es **nicht** löst, ehrlich gesagt:

- Wer den Account hat, kann warten, bis du selbst freischaltest, und in diesem
  Fenster mitfahren. Deshalb ist das Fenster kurz (15 Minuten) und gilt nur für
  das eine Token, das den Code vorgelegt hat.
- Wer den Account hat, kann dich um den Code *bitten* — in einer Sitzung, die
  aussieht wie deine eigene. Ein Code ist nur so gut wie die Frage, warum er
  gerade verlangt wird. Wenn du keinen Zugriff angestoßen hast und trotzdem
  nach einem Code gefragt wirst: nicht geben, sondern nachsehen, wer da klopft
  (`skconnect.py audit`).
- Wer **root auf dem Hetzner** hat, umgeht alles. Das Master-Token in
  `hub.env` ist von der Schranke ausgenommen — anders gäbe es keinen Weg
  zurück, wenn das Telefon verloren geht. Der Server ist damit weiterhin die
  Stelle, an der die Sicherheit hängt.

## Einrichten

Auf dem Hetzner, einmalig:

```bash
cd /opt/src/sk-f && git pull && cd connector
sudo bash hub/deploy/update.sh    # der laufende Hub muss den Endpunkt kennen
sudo apt install -y qrencode      # optional, für den QR-Code im Terminal
sudo python3 tools/skconnect.py totp-enroll
```

Ohne `update.sh` antwortet `totp-enroll` mit `404`: Der Hub läuft aus
`/opt/skconnector/hub`, nicht aus dem Git-Verzeichnis, und ein `git pull`
allein erreicht ihn nicht.

Der QR-Code wird direkt im Terminal gezeichnet — mit Google Authenticator,
1Password, Aegis oder der iOS-Passwörter-App scannen. Ohne `qrencode` wird
stattdessen das Geheimnis ausgegeben, das man von Hand einträgt.

Darunter stehen **acht Notfallcodes**. Jeder gilt genau einmal. Die gehören in
einen Passwortmanager oder auf Papier, nicht in eine Notiz-App auf demselben
Telefon wie die Authenticator-App.

Diese Ausgabe erscheint genau einmal. In der Datenbank liegt danach nur noch
das Geheimnis für die Prüfung und die Hashes der Notfallcodes.

## Benutzung

Ein Zugriff ohne Freischaltung wird abgelehnt:

> Zweite Schranke: dieses Token ist nicht freigeschaltet. Bitte den
> sechsstelligen Code aus der Authenticator-App erfragen und über 'unlock'
> eingeben.

Claude fragt dann nach dem Code. Du gibst ihn im Chat ein, Claude ruft
`unlock` auf, und danach läuft alles 15 Minuten lang normal. Nach Ablauf
kommt dieselbe Frage wieder.

Vorzeitig beenden geht mit `lock` — sinnvoll, wenn du eine Sitzung
weggibst oder den Rechner verlässt.

Auf dem Hetzner:

```bash
sudo python3 tools/skconnect.py lock-status     # wer ist gerade offen
sudo python3 tools/skconnect.py lock --alle     # alle Sitzungen beenden
```

## Was wo gilt

| | Braucht einen Code |
|---|---|
| Claude Chat, Cowork (die drei Connectors) | ja |
| Claude Code im Browser (`codeweb`) | ja |
| Claude Code im Terminal mit dem Master-Token | nein |
| `skconnect.py` auf dem Hetzner mit `sudo` | nein |

Die Freischaltung gilt **je Token**. Wer den Connector „Mac Simon"
freischaltet, hat damit nicht „Mac Katya" freigeschaltet.

## Schutz gegen Ausprobieren

Ein Code gilt genau einmal — auch für ein anderes Token. Mitlesen und
nachspielen funktioniert also nicht, obwohl ein Code 90 Sekunden lang
rechnerisch gültig wäre.

Nach fünf Fehlversuchen ist das betroffene Token 15 Minuten gesperrt, auch für
den richtigen Code. Die Sperre trifft nur dieses eine Token. Jeder Versuch,
erfolgreich oder nicht, steht im Audit-Log:

```bash
sudo python3 tools/skconnect.py audit --limit 30
```

Interessant sind dort `unlock.failed` und `unlock.required` — Letzteres heißt,
dass jemand mit einem gültigen Token ohne Freischaltung angeklopft hat. Wenn
das auftaucht, ohne dass du gerade gearbeitet hast, ist das das Signal.

## Wenn das Telefon weg ist

1. Einen der acht Notfallcodes verwenden — wie einen normalen Code.
2. Oder per SSH auf den Hetzner und neu einrichten:

```bash
sudo python3 tools/skconnect.py totp-enroll
```

Das ersetzt Geheimnis und Notfallcodes und beendet alle Freischaltungen.

## Abschalten

```bash
sudo python3 tools/skconnect.py totp-disable
```

Danach reicht das Token wieder allein. Alle Notfallcodes verfallen.
