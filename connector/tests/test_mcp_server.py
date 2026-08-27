"""Tests fuer den MCP-Server (die Seite, die Claude sieht).

Der Server wird ueber den Dateipfad geladen, nicht per Import: das Verzeichnis
heisst bewusst 'mcp-server' und nicht 'mcp', damit es das gleichnamige
SDK-Paket nicht verdeckt.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import pathlib

import pytest

mcp_sdk = pytest.importorskip("mcp", reason="MCP-SDK nicht installiert")

SERVER_PY = pathlib.Path(__file__).resolve().parent.parent / "mcp-server" / "server.py"

ERWARTETE_WERKZEUGE = {
    "devices", "device_info", "probe", "run", "read_file", "write_file",
    "list_dir", "notify", "shortcut", "command_status", "audit_log", "killswitch",
}


@pytest.fixture(scope="module")
def module():
    os.environ.setdefault("CONNECTOR_HUB_URL", "https://hub.invalid")
    os.environ.setdefault("CONNECTOR_CONTROL_TOKEN", "skc_ctl_test")
    spec = importlib.util.spec_from_file_location("skconnector_mcp", SERVER_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_all_tools_are_registered(module):
    names = {t.name for t in asyncio.run(module.server.list_tools())}
    assert names == ERWARTETE_WERKZEUGE


def test_every_tool_has_a_description(module):
    """Ohne Beschreibung waehlt ein Modell das falsche Werkzeug."""
    for tool in asyncio.run(module.server.list_tools()):
        assert tool.description and len(tool.description) > 20, tool.name


def test_directory_name_does_not_shadow_the_sdk():
    """'mcp-server' statt 'mcp' - sonst importiert server.py sich selbst."""
    assert SERVER_PY.parent.name == "mcp-server"
    assert not (SERVER_PY.parent / "__init__.py").exists()


def test_hub_error_is_readable(module, monkeypatch):
    monkeypatch.setattr(module, "HUB", "")
    with pytest.raises(module.HubError) as exc:
        module._call("GET", "/v1/devices")
    assert "CONNECTOR_HUB_URL" in str(exc.value)


def test_run_reports_failed_command_instead_of_raising(module, monkeypatch):
    monkeypatch.setattr(module, "_dispatch",
                        lambda *a, **k: {"status": "timeout", "error": "Geraet schlief"})
    out = module.run("mac-simon", "uptime")
    assert "timeout" in out and "Geraet schlief" in out


def test_run_formats_stdout_and_exit_code(module, monkeypatch):
    monkeypatch.setattr(module, "_dispatch", lambda *a, **k: {
        "status": "done",
        "result": {"exit_code": 0, "duration_s": 0.4, "stdout": "up 3 days", "stderr": ""},
    })
    out = module.run("mac-simon", "uptime")
    assert "exit=0" in out and "up 3 days" in out
