#!/usr/bin/env python3
"""MCP-Server 'skconnector' - das ist die Seite, die Claude sieht.

Der Server spricht ausschliesslich mit dem Hub (HTTPS + Control-Token). Er hat
selbst keinen direkten Zugriff auf ein Geraet; jede Aktion laeuft ueber die
Policy des Hubs und landet in dessen Audit-Log.

Konfiguration ueber Umgebungsvariablen:
    CONNECTOR_HUB_URL        z.B. https://hub.sk-finanzberatung.de
    CONNECTOR_CONTROL_TOKEN  Control-Token des Hubs
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

from mcp.server.mcpserver import MCPServer

HUB = os.environ.get("CONNECTOR_HUB_URL", "").rstrip("/")
TOKEN = os.environ.get("CONNECTOR_CONTROL_TOKEN", "")
DEFAULT_WAIT = int(os.environ.get("CONNECTOR_WAIT_SECONDS", "120"))

server = MCPServer("skconnector")


class HubError(RuntimeError):
    pass


def _call(method: str, path: str, body: dict | None = None, timeout: int = 60) -> dict:
    if not HUB or not TOKEN:
        raise HubError("CONNECTOR_HUB_URL oder CONNECTOR_CONTROL_TOKEN ist nicht gesetzt")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(HUB + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except json.JSONDecodeError:
            pass
        raise HubError(f"Hub antwortete {exc.code}: {detail}") from None
    except urllib.error.URLError as exc:
        raise HubError(f"Hub nicht erreichbar: {exc.reason}") from None


def _dispatch(device: str, kind: str, payload: dict, timeout_s: int,
              wait: bool = True) -> dict:
    """Setzt ein Kommando ab und wartet auf das Ergebnis."""
    cmd = _call("POST", f"/v1/devices/{device}/commands",
                {"kind": kind, "payload": payload, "timeout_s": timeout_s})
    if not wait:
        return {"command_id": cmd["id"], "status": cmd["status"]}

    deadline = time.time() + timeout_s + 15
    delay = 0.5
    while time.time() < deadline:
        time.sleep(delay)
        delay = min(delay * 1.5, 5.0)
        current = _call("GET", f"/v1/commands/{cmd['id']}")
        if current["status"] in ("done", "error", "timeout", "cancelled"):
            return {
                "command_id": current["id"],
                "status": current["status"],
                "result": current.get("result"),
                "error": current.get("error"),
            }
    return {"command_id": cmd["id"], "status": "pending",
            "note": "Ergebnis steht noch aus - spaeter mit command_status abrufen"}


# ---------------------------------------------------------------------------
# Geraete
# ---------------------------------------------------------------------------

@server.tool()
def devices() -> str:
    """Listet alle verbundenen Geraete mit Status, Modus und Faehigkeiten.

    Immer zuerst aufrufen, um die gueltigen Geraete-IDs zu erfahren.
    """
    data = _call("GET", "/v1/devices")
    lines = []
    for d in data["devices"]:
        age = f"{int(time.time() - d['last_seen'])}s" if d.get("last_seen") else "nie"
        state = "online" if d["online"] else "offline"
        if not d["enrolled"]:
            state = "nicht enrolled"
        lines.append(
            f"{d['id']:<18} {state:<14} {d['platform']:<8} Modus={d['mode']:<8} "
            f"Besitzer={d['owner']:<8} zuletzt={age:<8} Faehigkeiten={','.join(d['capabilities']) or '-'}"
        )
    return "\n".join(lines) or "Keine Geraete registriert."


@server.tool()
def device_info(device: str) -> str:
    """Details zu einem Geraet, inklusive der zuletzt gemeldeten Systemfakten."""
    return json.dumps(_call("GET", f"/v1/devices/{device}"), indent=2, ensure_ascii=False)


@server.tool()
def probe(device: str) -> str:
    """Fragt ein Geraet live nach Systemfakten (Hostname, OS, Akku, Sperrstatus).

    Gut geeignet, um zu pruefen, ob ein Geraet wirklich antwortet.
    """
    return json.dumps(_dispatch(device, "probe", {}, 30), indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Ausfuehrung
# ---------------------------------------------------------------------------

@server.tool()
def run(device: str, command: str, cwd: str = "", timeout_s: int = 120,
        as_user: str = "") -> str:
    """Fuehrt ein Shell-Kommando auf einem Mac oder Linux-Server aus.

    Nur fuer Geraete im Modus 'full'. Der Hub prueft das Kommando vorher gegen
    eine Deny-Liste (Formatieren, rm -rf, Herunterfahren, SIP aus, ...).

    as_user: optional ein Benutzername - der als root laufende Agent stuft
    das Kommando dann in diesen Benutzerkontext herab.
    """
    payload: dict[str, Any] = {"command": command}
    if cwd:
        payload["cwd"] = cwd
    if as_user:
        payload["as_user"] = as_user
    out = _dispatch(device, "shell", payload, timeout_s)
    result = out.get("result") or {}
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error') or 'kein Ergebnis'}"
    parts = [f"exit={result.get('exit_code')} ({result.get('duration_s')}s)"]
    if result.get("stdout"):
        parts.append("--- stdout ---\n" + result["stdout"])
    if result.get("stderr"):
        parts.append("--- stderr ---\n" + result["stderr"])
    if result.get("truncated"):
        parts.append("[Ausgabe gekuerzt]")
    return "\n".join(parts)


@server.tool()
def read_file(device: str, path: str, max_bytes: int = 65536) -> str:
    """Liest eine Datei von einem Geraet."""
    out = _dispatch(device, "fs.read", {"path": path, "max_bytes": max_bytes}, 60)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    res = out["result"]
    suffix = "\n[gekuerzt]" if res.get("truncated") else ""
    return res["content"] + suffix


@server.tool()
def write_file(device: str, path: str, content: str, append: bool = False) -> str:
    """Schreibt eine Datei auf ein Geraet (nur Modus 'full')."""
    out = _dispatch(device, "fs.write",
                    {"path": path, "content": content, "append": append}, 60)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    return f"{out['result']['bytes']} Bytes nach {out['result']['path']} geschrieben."


@server.tool()
def list_dir(device: str, path: str, limit: int = 200) -> str:
    """Listet ein Verzeichnis auf einem Geraet."""
    out = _dispatch(device, "fs.list", {"path": path, "limit": limit}, 60)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    rows = []
    for e in out["result"]["entries"]:
        if "error" in e:
            rows.append(f"?  {e['name']}  ({e['error']})")
        else:
            rows.append(f"{'d' if e['dir'] else '-'}  {e['size']:>10}  {e['name']}")
    return "\n".join(rows) or "(leer)"


# ---------------------------------------------------------------------------
# Mobilgeraete
# ---------------------------------------------------------------------------

@server.tool()
def notify(device: str, title: str, message: str, url: str = "") -> str:
    """Schickt eine Mitteilung an ein Geraet.

    Auf iPhone/iPad kommt sie als Push an - auch bei gesperrtem Bildschirm.
    Auf dem Mac erscheint sie als Mitteilung, sofern jemand angemeldet ist.
    """
    payload: dict[str, Any] = {"title": title, "message": message}
    if url:
        payload["url"] = url
    out = _dispatch(device, "notify", payload, 45)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    return json.dumps(out["result"], ensure_ascii=False)


@server.tool()
def shortcut(device: str, name: str, input: str = "", timeout_s: int = 900) -> str:
    """Startet einen Kurzbefehl (Shortcut) auf einem iPhone oder iPad.

    Achtung: Das Geraet holt Kommandos nur beim naechsten Poll ab. Bei
    gesperrtem Bildschirm kann das je nach Automation einige Minuten dauern -
    das Ergebnis kommt entsprechend verzoegert.
    """
    out = _dispatch(device, "shortcut", {"name": name, "input": input}, timeout_s)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error') or 'noch kein Ergebnis'}"
    return json.dumps(out["result"], ensure_ascii=False, indent=2)


@server.tool()
def command_status(command_id: str) -> str:
    """Fragt ein frueher abgesetztes Kommando ab (fuer verzoegerte Antworten)."""
    return json.dumps(_call("GET", f"/v1/commands/{command_id}"), indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Verwaltung
# ---------------------------------------------------------------------------

@server.tool()
def audit_log(limit: int = 50, device: str = "") -> str:
    """Zeigt die letzten Eintraege des Audit-Logs (wer hat was wann ausgeloest)."""
    path = f"/v1/audit?limit={limit}"
    if device:
        path += f"&device_id={device}"
    entries = _call("GET", path)["entries"]
    return "\n".join(
        f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(e['ts']))}  "
        f"{e['actor']:<22} {e['action']:<20} {e.get('device_id') or '-':<16} "
        f"{json.dumps(e['detail'], ensure_ascii=False)}"
        for e in entries
    ) or "Audit-Log ist leer."


@server.tool()
def killswitch(state: str) -> str:
    """Schaltet den Not-Aus des Hubs ('on' = keine Kommandos mehr, 'off' = normal)."""
    if state not in ("on", "off"):
        return "state muss 'on' oder 'off' sein."
    return json.dumps(_call("POST", f"/v1/killswitch/{state}"), ensure_ascii=False)


def main() -> None:
    server.run()


if __name__ == "__main__":
    main()
