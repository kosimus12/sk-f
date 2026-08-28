"""Tests fuer die Konfiguration der Kommandozeile.

Der Rueckfall auf hub.env existiert, weil eine frische ssh-Sitzung die
Variablen nicht hat - und die Zeile zum Nachtragen zweimal falsch
ausgefuellt wurde, einmal mit dem Token statt mit dem Suchmuster.
"""

from __future__ import annotations

import importlib.util
import pathlib

MODUL = pathlib.Path(__file__).resolve().parent.parent / "tools" / "skconnect.py"


def lade(monkeypatch, hub_env: pathlib.Path | None, **umgebung):
    for name in ("CONNECTOR_HUB_URL", "CONNECTOR_CONTROL_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    for name, wert in umgebung.items():
        monkeypatch.setenv(name, wert)
    spec = importlib.util.spec_from_file_location("skconnect_test", MODUL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    if hub_env is not None:
        mod.HUB_ENV = str(hub_env)
        hub, token = mod.aus_hub_env()
        mod.HUB, mod.TOKEN = hub, token
    return mod


def test_umgebung_hat_vorrang(monkeypatch, tmp_path):
    datei = tmp_path / "hub.env"
    datei.write_text("CONNECTOR_CONTROL_TOKEN=skc_ctl_datei\n")
    mod = lade(monkeypatch, None,
               CONNECTOR_HUB_URL="https://hub.example.de",
               CONNECTOR_CONTROL_TOKEN="skc_ctl_umgebung")
    assert mod.HUB == "https://hub.example.de"
    assert mod.TOKEN == "skc_ctl_umgebung"


def test_rueckfall_auf_hub_env(monkeypatch, tmp_path):
    datei = tmp_path / "hub.env"
    datei.write_text(
        "# Kommentar\nCONNECTOR_CONTROL_TOKEN=skc_ctl_datei\nCONNECTOR_BIND=172.18.0.1\n")
    mod = lade(monkeypatch, datei)
    assert mod.TOKEN == "skc_ctl_datei"
    assert mod.HUB == "http://172.18.0.1:8787"


def test_abweichender_port_wird_uebernommen(monkeypatch, tmp_path):
    datei = tmp_path / "hub.env"
    datei.write_text("CONNECTOR_CONTROL_TOKEN=t\nCONNECTOR_BIND=127.0.0.1\nCONNECTOR_PORT=9999\n")
    mod = lade(monkeypatch, datei)
    assert mod.HUB == "http://127.0.0.1:9999"


def test_bind_auf_alle_adressen_wird_zu_localhost(monkeypatch, tmp_path):
    """0.0.0.0 ist eine Lausch-, keine Zieladresse."""
    datei = tmp_path / "hub.env"
    datei.write_text("CONNECTOR_CONTROL_TOKEN=t\nCONNECTOR_BIND=0.0.0.0\n")
    mod = lade(monkeypatch, datei)
    assert mod.HUB == "http://127.0.0.1:8787"


def test_fehlende_datei_ist_kein_absturz(monkeypatch, tmp_path):
    mod = lade(monkeypatch, tmp_path / "gibtsnicht.env")
    assert (mod.HUB, mod.TOKEN) == ("", "")


def test_datei_ohne_token_liefert_keine_hub_adresse(monkeypatch, tmp_path):
    """Sonst laeuft der Aufruf ohne Token in einen 403 statt in eine klare Meldung."""
    datei = tmp_path / "hub.env"
    datei.write_text("CONNECTOR_BIND=172.18.0.1\n")
    mod = lade(monkeypatch, datei)
    assert (mod.HUB, mod.TOKEN) == ("", "")
