"""Tests fuer die Vergabe von Ports und geheimen Pfaden je Geraet.

Beide Fehler, die hier abgesichert sind, sind im Betrieb aufgetreten:
Ports nach Listenposition statt nach Geraet, und ein Caddy-Block, der nur
die Geraete des jeweiligen Laufs enthielt.
"""

from __future__ import annotations

import importlib.util
import pathlib

MODUL = pathlib.Path(__file__).resolve().parent.parent / "hub" / "deploy" / "instances.py"
spec = importlib.util.spec_from_file_location("instances", MODUL)
inst = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inst)  # type: ignore[union-attr]


def schreibe(ordner: pathlib.Path, geraet: str, port: int, secret: str = "") -> None:
    zeilen = [
        "# Abgestuftes Token",
        "CONNECTOR_CONTROL_TOKEN=skc_ctl_egal",
        f"CONNECTOR_DEVICE={geraet}",
        f"CONNECTOR_MCP_PORT={port}",
    ]
    if secret:
        zeilen.append(f"CONNECTOR_SECRET_PATH={secret}")
    (ordner / f"mcp-{geraet}.env").write_text("\n".join(zeilen) + "\n")


def test_leeres_verzeichnis_hat_keine_instanzen(tmp_path):
    assert inst.instanzen(tmp_path) == {}


def test_fehlendes_verzeichnis_wirft_nicht(tmp_path):
    assert inst.instanzen(tmp_path / "gibtsnicht") == {}


def test_instanzen_werden_gelesen(tmp_path):
    schreibe(tmp_path, "mac-simon", 8791, "aaa")
    schreibe(tmp_path, "hetzner", 8793, "ccc")
    gefunden = inst.instanzen(tmp_path)
    assert gefunden["mac-simon"] == {"port": 8791, "secret": "aaa"}
    assert gefunden["hetzner"] == {"port": 8793, "secret": "ccc"}


def test_hub_env_wird_nicht_als_instanz_gelesen(tmp_path):
    (tmp_path / "hub.env").write_text("CONNECTOR_CONTROL_TOKEN=skc_ctl_master\n")
    (tmp_path / "mcp.env").write_text("CONNECTOR_MCP_PORT=8788\n")
    assert inst.instanzen(tmp_path) == {}


def test_bekanntes_geraet_behaelt_seinen_port(tmp_path):
    """Der Fehler: ein Lauf mit --devices vergab Ports nach Listenposition neu."""
    schreibe(tmp_path, "mac-simon", 8791, "aaa")
    schreibe(tmp_path, "mac-katya", 8792, "bbb")
    schreibe(tmp_path, "hetzner", 8793, "ccc")
    vorhanden = inst.instanzen(tmp_path)
    assert inst.port_fuer(vorhanden, "mac-katya", 8791) == 8792
    assert inst.port_fuer(vorhanden, "hetzner", 8791) == 8793


def test_neues_geraet_bekommt_den_naechsten_freien_port(tmp_path):
    schreibe(tmp_path, "mac-simon", 8791, "aaa")
    schreibe(tmp_path, "hetzner", 8792, "ccc")
    vorhanden = inst.instanzen(tmp_path)
    assert inst.port_fuer(vorhanden, "ipad", 8791) == 8793


def test_luecke_wird_wiederverwendet(tmp_path):
    schreibe(tmp_path, "mac-simon", 8791, "aaa")
    schreibe(tmp_path, "hetzner", 8793, "ccc")
    vorhanden = inst.instanzen(tmp_path)
    assert inst.port_fuer(vorhanden, "ipad", 8791) == 8792


def test_erstes_geraet_bekommt_die_basis(tmp_path):
    assert inst.port_fuer({}, "mac-simon", 8791) == 8791


def test_block_enthaelt_alle_geraete_nicht_nur_die_des_laufs(tmp_path):
    """Der Fehler: ein Lauf mit --devices warf die anderen aus dem Block."""
    schreibe(tmp_path, "mac-simon", 8791, "aaa")
    schreibe(tmp_path, "mac-katya", 8792, "bbb")
    schreibe(tmp_path, "hetzner", 8793, "ccc")
    text = inst.block("mcp.example.de", "172.18.0.1", inst.instanzen(tmp_path))
    for pfad, port in (("aaa", 8791), ("bbb", 8792), ("ccc", 8793)):
        assert f"handle_path /{pfad}/*" in text
        assert f"reverse_proxy 172.18.0.1:{port}" in text


def test_block_ist_klammernbalanciert(tmp_path):
    schreibe(tmp_path, "mac-simon", 8791, "aaa")
    text = inst.block("mcp.example.de", "172.18.0.1", inst.instanzen(tmp_path))
    assert text.count("{") == text.count("}")
    assert text.startswith("mcp.example.de {")
    assert text.rstrip().endswith("}")


def test_block_faellt_auf_404_zurueck(tmp_path):
    text = inst.block("mcp.example.de", "172.18.0.1", {})
    assert 'respond "Not found" 404' in text


def test_instanz_ohne_pfad_kommt_nicht_in_den_block(tmp_path):
    """Ein halb eingerichtetes Geraet darf keinen leeren Pfad oeffnen."""
    schreibe(tmp_path, "mac-simon", 8791, "aaa")
    schreibe(tmp_path, "ipad", 8792)
    text = inst.block("mcp.example.de", "172.18.0.1", inst.instanzen(tmp_path))
    assert "handle_path //*" not in text
    assert "8792" not in text


def test_urls_werden_je_geraet_gebildet(tmp_path):
    schreibe(tmp_path, "mac-simon", 8791, "aaa")
    schreibe(tmp_path, "hetzner", 8793, "ccc")
    assert inst.urls("mcp.example.de", inst.instanzen(tmp_path)) == [
        ("hetzner", "https://mcp.example.de/ccc/mcp"),
        ("mac-simon", "https://mcp.example.de/aaa/mcp"),
    ]


def test_kaputter_port_wird_uebergangen(tmp_path):
    (tmp_path / "mcp-kaputt.env").write_text("CONNECTOR_MCP_PORT=achtzehn\n")
    assert inst.instanzen(tmp_path) == {}


def test_erzeugter_block_passt_zum_einfuegen_in_den_caddyfile(tmp_path):
    """Die beiden Programme muessen zusammenpassen: das eine baut, das andere fuegt ein."""
    cb_spec = importlib.util.spec_from_file_location(
        "caddy_block", MODUL.parent / "caddy_block.py")
    cb = importlib.util.module_from_spec(cb_spec)
    cb_spec.loader.exec_module(cb)

    schreibe(tmp_path, "mac-simon", 8791, "aaa")
    schreibe(tmp_path, "mac-katya", 8792, "bbb")
    text = inst.block("mcp.example.de", "172.18.0.1", inst.instanzen(tmp_path))

    assert cb.block_hostname(text) == "mcp.example.de"

    bestand = "andere.example.de {\n    respond 404\n}\n"
    einmal = cb.einfuegen(bestand, text)
    assert cb.block_grenzen(einmal, "mcp.example.de") is not None
    # Ein zweiter Lauf ersetzt, statt zu verdoppeln.
    zweimal = cb.einfuegen(einmal, text)
    assert zweimal == einmal
    assert zweimal.count("mcp.example.de {") == 1
    assert "andere.example.de {" in zweimal
