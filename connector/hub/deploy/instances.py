#!/usr/bin/env python3
"""Verwaltet die Instanzen der Geraete-Connectors: Ports, geheime Pfade, Caddy-Block.

Warum ein eigenes Programm statt ein paar Zeilen Shell: Die Vergabe in der
Shell hat zweimal danebengegriffen.

  1. Ports wurden nach Position in der Liste vergeben. Ein Lauf mit
     '--devices mac-katya' gab dem Geraet Port 8791 - den hielt schon
     mac-simon. 'address already in use'.
  2. Der Caddy-Block wurde nur aus den Geraeten des Laufs gebaut. Wer eines
     nachtraeglich umstellte, warf die anderen aus dem Block und damit aus
     dem Netz.

Beides kommt daher, dass ein Lauf den Bestand kennen muss. Der Bestand steht
in /etc/skconnector/mcp-<geraet>.env - hier wird er gelesen, nicht geraten.

    instances.py port   CONF GERAET BASIS   -> Port (vorhandener oder naechster freier)
    instances.py secret CONF GERAET         -> geheimer Pfad, leer wenn neu
    instances.py block  CONF HOSTNAME GATEWAY -> vollstaendiger Caddy-Block
    instances.py urls   CONF HOSTNAME       -> 'geraet<TAB>url' je Zeile
"""

from __future__ import annotations

import pathlib
import sys

SCHLUESSEL_PORT = "CONNECTOR_MCP_PORT"
SCHLUESSEL_PFAD = "CONNECTOR_SECRET_PATH"


def env_lesen(pfad: pathlib.Path) -> dict[str, str]:
    werte = {}
    for zeile in pfad.read_text(encoding="utf-8").splitlines():
        zeile = zeile.strip()
        if not zeile or zeile.startswith("#") or "=" not in zeile:
            continue
        name, wert = zeile.split("=", 1)
        werte[name.strip()] = wert.strip()
    return werte


def instanzen(conf: str | pathlib.Path) -> dict[str, dict]:
    """Alle eingerichteten Geraete-Connectors, nach Geraet sortiert."""
    ordner = pathlib.Path(conf)
    gefunden = {}
    if not ordner.is_dir():
        return gefunden
    for datei in sorted(ordner.glob("mcp-*.env")):
        geraet = datei.name[len("mcp-"):-len(".env")]
        if not geraet:
            continue
        werte = env_lesen(datei)
        try:
            port = int(werte.get(SCHLUESSEL_PORT, ""))
        except ValueError:
            continue
        gefunden[geraet] = {"port": port, "secret": werte.get(SCHLUESSEL_PFAD, "")}
    return gefunden


def port_fuer(vorhanden: dict[str, dict], geraet: str, basis: int) -> int:
    """Behaelt den Port eines bekannten Geraets, sonst der naechste freie."""
    if geraet in vorhanden:
        return vorhanden[geraet]["port"]
    belegt = {i["port"] for g, i in vorhanden.items() if g != geraet}
    port = basis
    while port in belegt:
        port += 1
    return port


def block(hostname: str, gateway: str, vorhanden: dict[str, dict]) -> str:
    """Der Caddy-Block ueber ALLE eingerichteten Geraete, nicht nur die des Laufs."""
    zeilen = [f"{hostname} {{"]
    for geraet in sorted(vorhanden):
        eintrag = vorhanden[geraet]
        if not eintrag.get("secret"):
            continue
        zeilen += [
            f"    # {geraet}",
            f"    handle_path /{eintrag['secret']}/* {{",
            f"        reverse_proxy {gateway}:{eintrag['port']} {{",
            "            transport http {",
            "                read_timeout 300s",
            "                write_timeout 300s",
            "            }",
            "        }",
            "    }",
        ]
    zeilen += ["    handle {", '        respond "Not found" 404', "    }", "}"]
    return "\n".join(zeilen) + "\n"


def urls(hostname: str, vorhanden: dict[str, dict]) -> list[tuple[str, str]]:
    return [
        (geraet, f"https://{hostname}/{eintrag['secret']}/mcp")
        for geraet, eintrag in sorted(vorhanden.items())
        if eintrag.get("secret")
    ]


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    befehl, conf = argv[1], argv[2]
    vorhanden = instanzen(conf)

    if befehl == "port" and len(argv) == 5:
        print(port_fuer(vorhanden, argv[3], int(argv[4])))
    elif befehl == "secret" and len(argv) == 4:
        print(vorhanden.get(argv[3], {}).get("secret", ""))
    elif befehl == "block" and len(argv) == 5:
        sys.stdout.write(block(argv[3], argv[4], vorhanden))
    elif befehl == "urls" and len(argv) == 4:
        for geraet, url in urls(argv[3], vorhanden):
            print(f"{geraet}\t{url}")
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
