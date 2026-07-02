# Personas / Experten

Jede `.md`-Datei hier ist ein wiederverwendbarer Experte, den du übers Dashboard
oder Telegram nutzen kannst. Die Mac-Brücke lädt diese Dateien, listet sie im Hub
und lässt bei „Aufgabe geben" genau diese Persona (headless) antworten.

## Format
```
---
name: Business Development Manager      # Anzeigename
slug: bd-manager                        # eindeutige Kurz-ID (klein, keine Leerzeichen)
role: Kurzbeschreibung der Rolle        # wird im Dashboard angezeigt
model: Opus 4.8                         # optional
---

<Hier der System-Prompt: Wer bist du, Aufgabe, Arbeitsweise, Regeln.>
```

## Neue Persona hinzufügen
Einfach eine neue `.md` mit diesem Format anlegen (auf dem Mac unter
`~/.claude-hub/personas/` — die Brücke kopiert die Vorlagen dorthin oder du legst
sie direkt an). Beim nächsten Scan erscheint sie automatisch im Dashboard.
