# IMMO-Pipeline – Playbook (Scraper → Analyse → Freigabe → Anschreiben)

Dieses Playbook verbindet deinen **Immobilien-Scraper** mit **Alex** über den
Claude Hub. Es setzt auf deinem bestehenden Setup auf (Drive-Ordner
„Alex-Gedächtnis": *Alex-Stammdaten*, *Alex-Assistenzregeln*,
*gym_property_validation_schema.json*) und verfeinert den IMMO-Workflow um deine
neuen Vorgaben (unterschiedliche Absender/Personas + Telegram-Freigabe).

> **Grundregel (aus deinen Sicherheitsstufen):** Nichts geht ohne deine Freigabe
> raus. Mailversand IMMER über `propose_send` → Telegram **OK/Nein**. Kein
> `send_message confirm=true` ohne ausdrückliche Einzelfreigabe.

## Der automatische Ablauf

```
[Hetzner-Claude / Opus 4.6]                [Mac-Claude "Alex" / Opus 4.8]        [Du]
  1 Scraper läuft (Cron)                                                          
  2 Rohtreffer + Enrichment  ──Hub──▶  3 Kategorisieren & Bewerten               
    (Places/OSM: Wettbewerb,             4 Interessante Treffer je Kategorie      
     Einzugsgebiet, Unterversorgung)        → Entwurf Anschreiben (richtiger      
                                              Absender/Persona)                    
                                          5 Telegram: Angebot + Kennzahlen  ──▶  6 "ja"/"nein"
                                          7 bei "ja": Mail raus (propose_send)     
```

**Delegation (Tokens sparen):** Die schwere Arbeit (Scrapen, Enrichment,
Scoring über viele Objekte) läuft auf dem **Hetzner-Opus-4.6**. Nur die finale
Bewertung, das Anschreiben und die Freigabe-Kommunikation macht **Alex auf dem
Mac (Opus 4.8)**. Übergabe der Ergebnisse läuft über den Hub-Nachrichten-Bus.

## Die 4 Kategorien – Absender & Persona

| # | Kategorie | Zweck | Persona | Absender-Konto |
|---|---|---|---|---|
| **a** | Privat **Miete** | Wohnung, in der du selbst wohnen willst | **Du als Simon** (Ich-Form, privat) | `simon.kuper97@gmail.com` (k97) |
| **b** | Privat **Kauf zum Selbstbewohnen** | Immobilie zum Selbstnutzen kaufen | **Du als Simon** (Ich-Form, privat) | `simon.kuper97@gmail.com` (k97) |
| **c** | Kauf **zum Vermieten** | Kapitalanlage/Vermietung | **Alex, Assistent von Simon** | `alex@sk-finanzberatung.de` |
| **d** | Gewerbe-**Miete Smart Gym** | Fläche fürs 24/7-Smart-Gym | **Alex, Assistent von Simon** | `alex@sk-finanzberatung.de` |

> Wichtigste Änderung ggü. den alten Assistenzregeln: Bei **a/b** meldet sich
> Alex **nicht** als Assistent, sondern schreibt **als du** von deiner privaten
> Adresse. Bei **c/d** bleibt es bei „Alex, Assistent von Simon" über die
> SK-Finanzberatung-Adresse.

## Analyse-Regeln je Kategorie

**a/b – Privat (Miete/Kauf zum Wohnen):** Filter nach deinen privaten Wohn-
Kriterien (Region, Budget, Zimmer, Lage). *(Diese Kriterien sind noch nicht
hinterlegt – siehe „Offene Punkte".)*

**c – Kauf zum Vermieten:** Standard-Kapitalanlage-Kennzahlen: Kaufpreis,
Kaltmiete, **Brutto-Mietrendite**, Preis/m², Lage/Mikrolage, Zustand,
Nebenkostenrisiko. Nur Objekte mit plausibler Rendite vorschlagen.

**d – Smart Gym:** Strikt nach `gym_property_validation_schema.json`:
- **Knockout** (ein Verstoß → verwerfen): Fläche 200–750 m², Deckenhöhe ≥ 2,8 m,
  Bodenlast ≥ 500 kg/m², Etage EG/Hochparterre (OG nur mit Lastenaufzug),
  Miete ≤ 12 €/m² kalt und ≤ 4.500 € gesamt, Gebietstyp GE/GI/MI/MK/SO
  (kein reines Wohngebiet wegen TA-Lärm 24/7), Nutzung zulässig, bezugsfertig.
- **Wirtschaft-Gate:** je Objekt max. tragbare Kaltmiete rechnen (EK 40.000 €,
  Beitrag 34,90/39,90 €, Auslastung 0,70, 1,1–1,3 Mitglieder/m²).
- **Scoring 0–100** + **Unterversorgung** (Einwohner je Studio > 9.160 = HOT).
- Zielregionen: **Kiel + Umland**, **Dortmund + Umland**.
- Fehlende Werte (Deckenhöhe/Bodenlast/Gebietstyp fehlen auf Immoscout oft!)
  → Status **„prüfen"** → an dich/Alex, **nicht** verwerfen.

## Telegram-Freigabe (das „einmal kurz validieren")

Pro interessantem Treffer schickt Alex dir **eine kompakte Telegram-Nachricht**:

```
🏠 [Kategorie c – Vermieten] Musterstr. 1, 24103 Kiel
Kaufpreis 245.000 € · 68 m² · Kaltmiete 720 € · Rendite ~3,5 %
Zustand: gepflegt · Baujahr 1998 · Etage 2/4
Score: 74/100 · Quelle: ImmoScout <Link>
Anschreiben bereit (Absender: alex@sk-finanzberatung.de).
Antworte: JA = senden · NEIN = verwerfen · DETAILS = mehr
```

Du antwortest **JA/NEIN** direkt im Telegram-Chat (läuft über den Hub → Mac-Alex
→ `propose_send`). Erst nach „JA" geht die Mail über das richtige Konto raus.

## So wird es „scharf geschaltet"

1. **Hub deployen + Brücken starten** (siehe `README.md`) – Voraussetzung für
   Telegram-Freigabe und Agenten-Kommunikation.
2. **Hetzner-Scraper** so einstellen, dass er sein Ergebnis (JSON/Liste) nach
   jedem Lauf an den Hub meldet: `POST /message {toCapability:"main",
   body:"IMMO-Ergebnisse: <json/link>"}` (oder Datei im geteilten Ordner + kurze
   Meldung). Danach triggert Alex automatisch die Analyse.
3. **Alex-Memory ergänzen:** Dieses Playbook als Regel in „Alex-Gedächtnis"
   aufnehmen (oder ins gemeinsame Hub-Gedächtnis), damit alle Agenten es kennen.

## Offene Punkte (brauche ich von dir)

- **Privat-Kriterien (a/b):** Region(en), Budget Miete/Kauf, Zimmer/Größe, Muss/
  Kann. Für Smart Gym (d) und Vermieten (c) ist alles hinterlegt, für deine
  privaten Wohn-Wünsche noch nicht.
- **Rhythmus:** Wie oft soll der Scraper laufen und Alex dir Treffer schicken
  (z. B. 1×/Tag Sammel-Digest oder sofort je Treffer)?
- **„Ralf/OpenClaude" & „Hermes":** Hermes ist aktuell dein Telegram-/Freigabe-
  Bot (Hetzner-Cron). Die neue Hub-Telegram-Anbindung **ersetzt** Hermes –
  deshalb Hermes erst abschalten, **wenn** der neue Telegram-Kanal läuft, sonst
  fehlt kurzzeitig der Freigabe-Weg.
