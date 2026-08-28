#!/usr/bin/env python3
"""Fuegt einen Site-Block in einen fremden Caddyfile ein - ersetzend, mit Backup.

Der Caddyfile gehoert einem anderen Stack. Deshalb: nur der eine Block mit
genau diesem Hostnamen wird angefasst, alles andere bleibt Zeichen fuer
Zeichen stehen, und vorher wird kopiert.

    caddy_block.py einfuegen CADDYFILE BLOCKDATEI
    caddy_block.py entfernen CADDYFILE HOSTNAME
"""

from __future__ import annotations

import shutil
import sys
import time


def block_hostname(block: str) -> str:
    """Der Hostname steht in der ersten Zeile, vor der oeffnenden Klammer."""
    for zeile in block.splitlines():
        zeile = zeile.strip()
        if not zeile or zeile.startswith("#"):
            continue
        if zeile.endswith("{"):
            return zeile[:-1].strip()
        raise ValueError(f"Erste Zeile oeffnet keinen Block: {zeile!r}")
    raise ValueError("Block ist leer")


def block_grenzen(text: str, hostname: str) -> tuple[int, int] | None:
    """Findet Anfang und Ende des Blocks fuer diesen Hostnamen.

    Zaehlt Klammern, statt auf die Einrueckung zu vertrauen - verschachtelte
    Bloecke wie 'handle_path' haben eigene. Klammern in Zeichenketten und
    Kommentaren zaehlen nicht mit.
    """
    zeilen = text.splitlines(keepends=True)
    pos = 0
    tiefe = 0
    for i, zeile in enumerate(zeilen):
        kopf = zeile.strip()
        # Nur Zeilen auf oberster Ebene sind Site-Bloecke. 'handle_path ... {'
        # steht innerhalb eines Blocks und kommt hier nie in Frage.
        if tiefe == 0 and kopf.endswith("{") and not kopf.startswith("#"):
            namen = [n.strip() for n in kopf[:-1].split(",")]
            if hostname in namen:
                innen = 0
                ende = pos
                for j in range(i, len(zeilen)):
                    innen += _klammern(zeilen[j])
                    ende += len(zeilen[j])
                    if innen == 0:
                        return pos, ende
                raise ValueError(f"Block '{hostname}' wird nicht geschlossen")
        tiefe += _klammern(zeile)
        pos += len(zeile)
    return None


def _klammern(zeile: str) -> int:
    """Klammer-Bilanz einer Zeile, ohne Kommentare und Zeichenketten."""
    tiefe = 0
    in_string = False
    i = 0
    while i < len(zeile):
        c = zeile[i]
        if in_string:
            if c == "\\":
                i += 2
                continue
            if c == '"':
                in_string = False
        elif c == '"':
            in_string = True
        elif c == "#":
            break
        elif c == "{":
            tiefe += 1
        elif c == "}":
            tiefe -= 1
        i += 1
    return tiefe


def einfuegen(text: str, block: str) -> str:
    """Ersetzt einen vorhandenen Block gleichen Namens oder haengt an."""
    hostname = block_hostname(block)
    if not block.endswith("\n"):
        block += "\n"
    grenzen = block_grenzen(text, hostname)
    if grenzen:
        anfang, ende = grenzen
        return text[:anfang] + block + text[ende:]
    if text and not text.endswith("\n"):
        text += "\n"
    return text + block


def entfernen(text: str, hostname: str) -> str:
    grenzen = block_grenzen(text, hostname)
    if not grenzen:
        return text
    anfang, ende = grenzen
    return text[:anfang] + text[ende:]


def _sichern(pfad: str) -> str:
    ziel = f"{pfad}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(pfad, ziel)
    return ziel


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    befehl, caddyfile, arg = argv[1], argv[2], argv[3]
    with open(caddyfile, encoding="utf-8") as f:
        alt = f.read()

    if befehl == "einfuegen":
        with open(arg, encoding="utf-8") as f:
            neu = einfuegen(alt, f.read())
    elif befehl == "entfernen":
        neu = entfernen(alt, arg)
    else:
        print(f"Unbekannter Befehl: {befehl}", file=sys.stderr)
        return 2

    if neu == alt:
        print("unveraendert")
        return 0
    kopie = _sichern(caddyfile)
    with open(caddyfile, "w", encoding="utf-8") as f:
        f.write(neu)
    print(kopie)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
