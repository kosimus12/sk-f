"""Tests fuer die zweite Schranke am Hub.

Der Bedrohungsfall: Jemand hat den Claude-Account und damit das
Control-Token aus der Connector-Konfiguration. Ohne den Code aus der
Authenticator-App darf er trotzdem nichts auf den Geraeten tun.
"""

from __future__ import annotations

import importlib
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hub import totp  # noqa: E402

CONTROL = "skc_ctl_test-token"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CONNECTOR_DB", str(tmp_path / "hub.db"))
    monkeypatch.setenv("CONNECTOR_CONTROL_TOKEN", CONTROL)
    monkeypatch.setenv("CONNECTOR_POLL_SECONDS", "1")
    import hub.app as app_module
    importlib.reload(app_module)
    with TestClient(app_module.app) as c:
        c.app_module = app_module  # type: ignore[attr-defined]
        yield c


def master(extra: dict | None = None) -> dict:
    return {"Authorization": f"Bearer {CONTROL}", **(extra or {})}


def scoped_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def geraet(client):
    antwort = client.post("/v1/devices", headers=master(), json={
        "device_id": "mac-test", "label": "Test", "platform": "macos",
        "mode": "full", "capabilities": ["shell", "fs", "notify", "probe"],
    })
    assert antwort.status_code == 200, antwort.text
    client.post("/v1/agent/register", json={
        "code": antwort.json()["enrollment_code"],
        "capabilities": ["shell", "fs", "notify", "probe"], "facts": {},
    })
    return "mac-test"


@pytest.fixture()
def chat_token(client):
    return client.post("/v1/control-tokens", headers=master(), json={
        "label": "chat", "ceiling": "full", "devices": [],
    }).json()["token"]


def aktueller_code(client) -> str:
    import time
    with client.app_module.store.conn() as c:
        row = c.execute("SELECT secret FROM totp WHERE id=1").fetchone()
    return totp.code_fuer(row["secret"], totp.zaehler_fuer(time.time()))


def kommando(client, headers, kind="probe"):
    return client.post("/v1/devices/mac-test/commands", headers=headers,
                       json={"kind": kind, "payload": {}})


def test_ohne_einrichtung_aendert_sich_nichts(client, geraet, chat_token):
    """Wer die Schranke nicht einrichtet, merkt nichts davon."""
    assert kommando(client, scoped_headers(chat_token)).status_code == 200


def test_einrichten_liefert_geheimnis_und_notfallcodes(client):
    antwort = client.post("/v1/totp/enroll", headers=master())
    assert antwort.status_code == 200
    daten = antwort.json()
    assert daten["otpauth"].startswith("otpauth://totp/")
    assert daten["secret"] in daten["otpauth"]
    assert len(daten["recovery_codes"]) == 8


def test_einrichten_nur_mit_master_token(client, chat_token):
    assert client.post("/v1/totp/enroll", headers=scoped_headers(chat_token)).status_code == 403


def test_gesperrtes_token_darf_kein_kommando(client, geraet, chat_token):
    """Der Kern: Token allein reicht nicht mehr."""
    client.post("/v1/totp/enroll", headers=master())
    antwort = kommando(client, scoped_headers(chat_token))
    assert antwort.status_code == 401
    assert "Zweite Schranke" in antwort.json()["error"]


def test_nach_freischaltung_geht_es_wieder(client, geraet, chat_token):
    client.post("/v1/totp/enroll", headers=master())
    frei = client.post("/v1/unlock", headers=scoped_headers(chat_token),
                       json={"code": aktueller_code(client)})
    assert frei.status_code == 200 and frei.json()["unlocked"] is True
    assert kommando(client, scoped_headers(chat_token)).status_code == 200


def test_falscher_code_schaltet_nicht_frei(client, geraet, chat_token):
    client.post("/v1/totp/enroll", headers=master())
    antwort = client.post("/v1/unlock", headers=scoped_headers(chat_token),
                          json={"code": "000000"})
    assert antwort.status_code == 403
    assert kommando(client, scoped_headers(chat_token)).status_code == 401


def test_freischaltung_eines_tokens_hilft_dem_anderen_nicht(client, geraet, chat_token):
    """Der Browser-Connector bleibt zu, wenn Claude Code freigeschaltet wird."""
    client.post("/v1/totp/enroll", headers=master())
    zweites = client.post("/v1/control-tokens", headers=master(), json={
        "label": "cowork", "ceiling": "full", "devices": [],
    }).json()["token"]
    client.post("/v1/unlock", headers=scoped_headers(chat_token),
                json={"code": aktueller_code(client)})
    assert kommando(client, scoped_headers(chat_token)).status_code == 200
    assert kommando(client, scoped_headers(zweites)).status_code == 401


def test_master_token_bleibt_ausgenommen(client, geraet):
    """Sonst gibt es keinen Weg zurueck, wenn das Telefon verloren geht."""
    client.post("/v1/totp/enroll", headers=master())
    assert kommando(client, master()).status_code == 200


def test_lock_beendet_die_freischaltung_sofort(client, geraet, chat_token):
    client.post("/v1/totp/enroll", headers=master())
    client.post("/v1/unlock", headers=scoped_headers(chat_token),
                json={"code": aktueller_code(client)})
    assert client.post("/v1/lock", headers=scoped_headers(chat_token)).status_code == 200
    assert kommando(client, scoped_headers(chat_token)).status_code == 401


def test_alle_sitzungen_beenden_nur_mit_master(client, chat_token):
    client.post("/v1/totp/enroll", headers=master())
    client.post("/v1/unlock", headers=scoped_headers(chat_token),
                json={"code": aktueller_code(client)})
    assert client.post("/v1/lock?alle=true",
                       headers=scoped_headers(chat_token)).status_code == 403
    antwort = client.post("/v1/lock?alle=true", headers=master())
    assert antwort.status_code == 200 and antwort.json()["beendet"] == 1


def test_status_zeigt_die_restzeit(client, chat_token):
    client.post("/v1/totp/enroll", headers=master())
    vorher = client.get("/v1/unlock", headers=scoped_headers(chat_token)).json()
    assert vorher["totp_aktiv"] is True and vorher["unlocked"] is False
    client.post("/v1/unlock", headers=scoped_headers(chat_token),
                json={"code": aktueller_code(client)})
    nachher = client.get("/v1/unlock", headers=scoped_headers(chat_token)).json()
    assert nachher["unlocked"] is True and 0 < nachher["seconds_left"] <= 900


def test_notfallcode_funktioniert(client, geraet, chat_token):
    codes = client.post("/v1/totp/enroll", headers=master()).json()["recovery_codes"]
    antwort = client.post("/v1/unlock", headers=scoped_headers(chat_token),
                          json={"code": codes[0]})
    assert antwort.status_code == 200
    assert kommando(client, scoped_headers(chat_token)).status_code == 200


def test_abgelehnte_freischaltung_steht_im_audit_log(client, chat_token):
    client.post("/v1/totp/enroll", headers=master())
    client.post("/v1/unlock", headers=scoped_headers(chat_token), json={"code": "000000"})
    eintraege = client.get("/v1/audit?limit=20", headers=master()).json()["entries"]
    aktionen = [(e["actor"], e["action"]) for e in eintraege]
    assert ("control:chat", "unlock.failed") in aktionen


def test_versuch_ohne_freischaltung_steht_im_audit_log(client, geraet, chat_token):
    """Damit sichtbar wird, wenn jemand mit einem gestohlenen Token klopft."""
    client.post("/v1/totp/enroll", headers=master())
    kommando(client, scoped_headers(chat_token))
    eintraege = client.get("/v1/audit?limit=20", headers=master()).json()["entries"]
    assert ("control:chat", "unlock.required") in [(e["actor"], e["action"]) for e in eintraege]


def test_abschalten_gibt_die_tokens_wieder_frei(client, geraet, chat_token):
    client.post("/v1/totp/enroll", headers=master())
    assert kommando(client, scoped_headers(chat_token)).status_code == 401
    client.post("/v1/totp/disable", headers=master())
    assert kommando(client, scoped_headers(chat_token)).status_code == 200


def test_unlock_ohne_einrichtung_meldet_das(client, chat_token):
    antwort = client.post("/v1/unlock", headers=scoped_headers(chat_token),
                          json={"code": "123456"})
    assert antwort.status_code == 409
