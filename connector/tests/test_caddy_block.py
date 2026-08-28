"""Tests fuer das Einfuegen von Site-Bloecken in einen fremden Caddyfile.

Der Caddyfile gehoert einem anderen Stack. Wenn hier etwas danebengeht,
faellt nicht der Connector aus, sondern die Mail-Zustellung des Nachbarn.
"""

from __future__ import annotations

import importlib.util
import pathlib

MODUL = pathlib.Path(__file__).resolve().parent.parent / "hub" / "deploy" / "caddy_block.py"
spec = importlib.util.spec_from_file_location("caddy_block", MODUL)
cb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cb)  # type: ignore[union-attr]


BESTAND = """\
{
    email admin@example.de
}

cockpit.example.de {
    reverse_proxy 172.18.0.5:3000
    header {
        Strict-Transport-Security "max-age=31536000"
    }
}

mcp.1.2.3.4.sslip.io {
    handle_path /alt/* {
        reverse_proxy 172.18.0.1:8788
    }
    handle {
        respond "Not found" 404
    }
}
"""

NEUER_BLOCK = """\
mcp.1.2.3.4.sslip.io {
    handle_path /neu/* {
        reverse_proxy 172.18.0.1:8791
    }
}
"""


def test_hostname_wird_aus_der_ersten_zeile_gelesen():
    assert cb.block_hostname(NEUER_BLOCK) == "mcp.1.2.3.4.sslip.io"


def test_vorhandener_block_wird_ersetzt_nicht_verdoppelt():
    out = cb.einfuegen(BESTAND, NEUER_BLOCK)
    assert out.count("mcp.1.2.3.4.sslip.io {") == 1
    assert "/neu/*" in out and "/alt/*" not in out


def test_fremde_bloecke_bleiben_unangetastet():
    out = cb.einfuegen(BESTAND, NEUER_BLOCK)
    assert "cockpit.example.de {" in out
    assert "email admin@example.de" in out
    assert "Strict-Transport-Security" in out


def test_neuer_hostname_wird_angehaengt():
    block = NEUER_BLOCK.replace("mcp.1.2.3.4", "zwei.1.2.3.4")
    out = cb.einfuegen(BESTAND, block)
    assert "mcp.1.2.3.4.sslip.io {" in out
    assert "zwei.1.2.3.4.sslip.io {" in out


def test_verschachtelte_klammern_beenden_den_block_nicht_zu_frueh():
    """'handle_path' und 'header' oeffnen eigene Bloecke."""
    grenzen = cb.block_grenzen(BESTAND, "mcp.1.2.3.4.sslip.io")
    ausschnitt = BESTAND[grenzen[0]:grenzen[1]]
    assert ausschnitt.count("{") == ausschnitt.count("}") == 3
    assert ausschnitt.rstrip().endswith("}")


def test_klammern_in_zeichenketten_zaehlen_nicht():
    text = 'a.example.de {\n    respond "ein { in Anfuehrungszeichen"\n}\n'
    grenzen = cb.block_grenzen(text, "a.example.de")
    assert text[grenzen[0]:grenzen[1]] == text


def test_klammern_hinter_einem_kommentar_zaehlen_nicht():
    text = "a.example.de {\n    # hier ein { Kommentar\n    respond 404\n}\n"
    grenzen = cb.block_grenzen(text, "a.example.de")
    assert text[grenzen[0]:grenzen[1]] == text


def test_mehrere_hostnamen_in_einer_zeile_werden_erkannt():
    text = "eins.example.de, zwei.example.de {\n    respond 404\n}\n"
    assert cb.block_grenzen(text, "zwei.example.de") is not None


def test_teiltreffer_im_hostnamen_zaehlt_nicht():
    """'mcp.example.de' darf nicht 'nicht-mcp.example.de' treffen."""
    text = "nicht-mcp.example.de {\n    respond 404\n}\n"
    assert cb.block_grenzen(text, "mcp.example.de") is None


def test_unbekannter_hostname_liefert_none():
    assert cb.block_grenzen(BESTAND, "gibtsnicht.example.de") is None


def test_entfernen_nimmt_nur_den_einen_block():
    out = cb.entfernen(BESTAND, "mcp.1.2.3.4.sslip.io")
    assert "mcp.1.2.3.4.sslip.io" not in out
    assert "cockpit.example.de {" in out


def test_datei_ohne_abschliessenden_zeilenumbruch():
    out = cb.einfuegen("a.example.de {\n    respond 404\n}", NEUER_BLOCK)
    assert "}\nmcp.1.2.3.4.sslip.io {" in out


def test_nicht_geschlossener_block_wird_gemeldet():
    import pytest
    with pytest.raises(ValueError, match="nicht geschlossen"):
        cb.block_grenzen("a.example.de {\n    respond 404\n", "a.example.de")
