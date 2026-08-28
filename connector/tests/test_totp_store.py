"""Tests fuer die Freischaltung: wer wie lange darf, und was Fehlversuche kosten."""

from __future__ import annotations

import base64

import pytest

from hub import totp
from hub.store import Store

GEHEIM = base64.b32encode(b"12345678901234567890").decode().rstrip("=")


@pytest.fixture
def store(tmp_path):
    return Store(str(tmp_path / "hub.sqlite3"))


def code(jetzt=None):
    import time
    return totp.code_fuer(GEHEIM, totp.zaehler_fuer(jetzt or time.time()))


def test_ohne_einrichtung_ist_die_schranke_aus(store):
    assert store.totp_aktiv() is False


def test_einrichten_und_freischalten(store):
    store.totp_einrichten(GEHEIM, [])
    assert store.totp_aktiv() is True
    assert store.entsperrt_bis("control:codeweb") == 0.0
    ok, meldung = store.entsperren("control:codeweb", code(), 900)
    assert ok and meldung == "ok"
    assert store.entsperrt_bis("control:codeweb") > 0


def test_freischaltung_gilt_nur_fuer_das_eine_token(store):
    """Wer Claude Code freischaltet, schaltet nicht den Browser-Connector frei."""
    store.totp_einrichten(GEHEIM, [])
    store.entsperren("control:codeweb", code(), 900)
    assert store.entsperrt_bis("control:conn-mac-simon") == 0.0


def test_freischaltung_laeuft_ab(store):
    store.totp_einrichten(GEHEIM, [])
    store.entsperren("control:codeweb", code(), -1)
    assert store.entsperrt_bis("control:codeweb") == 0.0


def test_derselbe_code_schaltet_kein_zweites_mal_frei(store):
    """Ein mitgelesener Code darf nicht nochmal gelten - auch nicht fuer ein anderes Token."""
    store.totp_einrichten(GEHEIM, [])
    c = code()
    assert store.entsperren("control:a", c, 900)[0] is True
    ok, meldung = store.entsperren("control:b", c, 900)
    assert ok is False and "stimmt nicht" in meldung


def test_falscher_code_schaltet_nicht_frei(store):
    store.totp_einrichten(GEHEIM, [])
    ok, meldung = store.entsperren("control:codeweb", "000000", 900)
    assert ok is False
    assert "Versuche uebrig" in meldung
    assert store.entsperrt_bis("control:codeweb") == 0.0


def test_zu_viele_fehlversuche_sperren_das_token(store):
    store.totp_einrichten(GEHEIM, [])
    for _ in range(Store.MAX_FEHLVERSUCHE - 1):
        store.entsperren("control:codeweb", "000000", 900)
    ok, meldung = store.entsperren("control:codeweb", "000000", 900)
    assert ok is False and "gesperrt" in meldung
    assert store.sperre_bis("control:codeweb") > 0
    # Auch der richtige Code hilft jetzt nicht mehr.
    ok, meldung = store.entsperren("control:codeweb", code(), 900)
    assert ok is False and "zu viele Fehlversuche" in meldung


def test_die_sperre_trifft_nur_das_betroffene_token(store):
    store.totp_einrichten(GEHEIM, [])
    for _ in range(Store.MAX_FEHLVERSUCHE):
        store.entsperren("control:chat", "000000", 900)
    assert store.sperre_bis("control:chat") > 0
    assert store.entsperren("control:codeweb", code(), 900)[0] is True


def test_ein_richtiger_code_setzt_die_fehlversuche_zurueck(store):
    store.totp_einrichten(GEHEIM, [])
    store.entsperren("control:codeweb", "000000", 900)
    store.entsperren("control:codeweb", code(), 900)
    store.sperren("control:codeweb")
    for _ in range(Store.MAX_FEHLVERSUCHE - 1):
        ok, meldung = store.entsperren("control:codeweb", "000000", 900)
    assert "gesperrt" not in meldung


def test_notfallcode_gilt_genau_einmal(store):
    codes = totp.neue_notfallcodes(2)
    store.totp_einrichten(GEHEIM, codes)
    assert store.notfallcodes_uebrig() == 2
    ok, meldung = store.entsperren("control:codeweb", codes[0], 900)
    assert ok and "Notfallcode" in meldung
    assert store.notfallcodes_uebrig() == 1
    store.sperren("control:codeweb")
    assert store.entsperren("control:codeweb", codes[0], 900)[0] is False


def test_neu_einrichten_entwertet_alte_notfallcodes_und_freischaltungen(store):
    codes = totp.neue_notfallcodes(2)
    store.totp_einrichten(GEHEIM, codes)
    store.entsperren("control:codeweb", code(), 900)
    store.totp_einrichten(totp.neues_geheimnis(), totp.neue_notfallcodes(2))
    assert store.entsperrt_bis("control:codeweb") == 0.0
    assert store.entsperren("control:codeweb", codes[0], 900)[0] is False


def test_abschalten_raeumt_auf(store):
    store.totp_einrichten(GEHEIM, totp.neue_notfallcodes(2))
    store.entsperren("control:codeweb", code(), 900)
    store.totp_abschalten()
    assert store.totp_aktiv() is False
    assert store.entsperrt_bis("control:codeweb") == 0.0
    assert store.notfallcodes_uebrig() == 0


def test_ohne_einrichtung_schaltet_kein_code_frei(store):
    ok, meldung = store.entsperren("control:codeweb", code(), 900)
    assert ok is False and "nicht eingerichtet" in meldung


def test_alles_sperren_beendet_jede_sitzung(store):
    store.totp_einrichten(GEHEIM, [])
    store.entsperren("control:a", code(), 900)
    import time
    store.entsperren("control:b", totp.code_fuer(GEHEIM, totp.zaehler_fuer(time.time()) + 1), 900)
    assert len(store.offene_freischaltungen()) == 2
    store.alles_sperren()
    assert store.offene_freischaltungen() == []
