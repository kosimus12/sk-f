"""Tests fuer die zweite Schranke: zeitbasierte Codes.

Die Vektoren stammen aus RFC 6238, Anhang B (SHA-1, Geheimnis
'12345678901234567890'). Wenn die stimmen, stimmt die Rechnung - und jede
Authenticator-App erzeugt dieselben Ziffern.
"""

from __future__ import annotations

import base64

import pytest

from hub import totp

# RFC 6238: das ASCII-Geheimnis, hier in Base32 wie es die Apps wollen.
RFC_GEHEIM = base64.b32encode(b"12345678901234567890").decode().rstrip("=")

# (Unix-Zeit, achtstelliger Code aus dem RFC). Wir vergleichen die letzten
# sechs Stellen, weil der Hub sechsstellig arbeitet.
RFC_VEKTOREN = [
    (59, "94287082"),
    (1111111109, "07081804"),
    (1111111111, "14050471"),
    (1234567890, "89005924"),
    (2000000000, "69279037"),
    (20000000000, "65353130"),
]


@pytest.mark.parametrize("zeit,erwartet", RFC_VEKTOREN)
def test_rfc6238_vektoren(zeit, erwartet):
    zaehler = totp.zaehler_fuer(zeit)
    assert totp.code_fuer(RFC_GEHEIM, zaehler) == erwartet[-6:]


def test_neues_geheimnis_ist_base32_ohne_fuellzeichen():
    g = totp.neues_geheimnis()
    assert "=" not in g
    assert set(g) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
    assert len(g) == 32


def test_zwei_geheimnisse_sind_verschieden():
    assert totp.neues_geheimnis() != totp.neues_geheimnis()


def test_richtiger_code_wird_angenommen():
    jetzt = 1_700_000_000.0
    code = totp.code_fuer(RFC_GEHEIM, totp.zaehler_fuer(jetzt))
    assert totp.pruefe(RFC_GEHEIM, code, jetzt) == totp.zaehler_fuer(jetzt)


def test_falscher_code_wird_abgelehnt():
    assert totp.pruefe(RFC_GEHEIM, "000000", 1_700_000_000.0) is None


def test_leerzeichen_im_code_stoeren_nicht():
    """Authenticator-Apps zeigen '123 456'."""
    jetzt = 1_700_000_000.0
    code = totp.code_fuer(RFC_GEHEIM, totp.zaehler_fuer(jetzt))
    assert totp.pruefe(RFC_GEHEIM, f"{code[:3]} {code[3:]}", jetzt) is not None


def test_zu_kurzer_code_wird_abgelehnt():
    assert totp.pruefe(RFC_GEHEIM, "12345", 1_700_000_000.0) is None


def test_schiefe_uhr_um_ein_fenster_wird_toleriert():
    jetzt = 1_700_000_000.0
    frueher = totp.code_fuer(RFC_GEHEIM, totp.zaehler_fuer(jetzt) - 1)
    spaeter = totp.code_fuer(RFC_GEHEIM, totp.zaehler_fuer(jetzt) + 1)
    assert totp.pruefe(RFC_GEHEIM, frueher, jetzt) is not None
    assert totp.pruefe(RFC_GEHEIM, spaeter, jetzt) is not None


def test_zwei_fenster_daneben_ist_zu_weit():
    jetzt = 1_700_000_000.0
    alt = totp.code_fuer(RFC_GEHEIM, totp.zaehler_fuer(jetzt) - 2)
    assert totp.pruefe(RFC_GEHEIM, alt, jetzt) is None


def test_ein_code_gilt_nur_einmal():
    """Mitgelesen und nachgespielt darf nicht funktionieren."""
    jetzt = 1_700_000_000.0
    zaehler = totp.zaehler_fuer(jetzt)
    code = totp.code_fuer(RFC_GEHEIM, zaehler)
    assert totp.pruefe(RFC_GEHEIM, code, jetzt, zuletzt_benutzt=None) == zaehler
    assert totp.pruefe(RFC_GEHEIM, code, jetzt, zuletzt_benutzt=zaehler) is None


def test_aeltere_codes_gelten_nach_einer_benutzung_nicht_mehr():
    jetzt = 1_700_000_000.0
    zaehler = totp.zaehler_fuer(jetzt)
    vorher = totp.code_fuer(RFC_GEHEIM, zaehler - 1)
    assert totp.pruefe(RFC_GEHEIM, vorher, jetzt, zuletzt_benutzt=zaehler) is None


def test_kaputtes_geheimnis_wird_gemeldet():
    with pytest.raises(ValueError):
        totp.code_fuer("nicht base32 !!", 1)


def test_otpauth_uri_enthaelt_alles_noetige():
    uri = totp.otpauth_uri("ABCDEFGH", "simon", "SK Connector")
    assert uri.startswith("otpauth://totp/SK%20Connector%3Asimon?")
    assert "secret=ABCDEFGH" in uri
    assert "digits=6" in uri and "period=30" in uri


def test_notfallcodes_sind_verschieden_und_lesbar():
    codes = totp.neue_notfallcodes(8)
    assert len(set(codes)) == 8
    for code in codes:
        assert len(code.split("-")) == 3
