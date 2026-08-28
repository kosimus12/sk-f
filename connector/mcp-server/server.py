#!/usr/bin/env python3
"""MCP-Server 'skconnector' - das ist die Seite, die Claude sieht.

Der Server spricht ausschliesslich mit dem Hub (HTTPS + Control-Token). Er hat
selbst keinen direkten Zugriff auf ein Geraet; jede Aktion laeuft ueber die
Policy des Hubs und landet in dessen Audit-Log.

Konfiguration ueber Umgebungsvariablen:
    CONNECTOR_HUB_URL        z.B. https://hub.sk-finanzberatung.de
    CONNECTOR_CONTROL_TOKEN  Control-Token des Hubs
    CONNECTOR_DEVICE         optional: bindet diesen Server an EIN Geraet
    CONNECTOR_MCP_NAME       optional: Name, den Claude anzeigt
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

# Ein Server pro Geraet: Dann laesst sich in Claude einzeln an- und abschalten,
# wer gerade erreichbar ist. Das Token dahinter ist zusaetzlich auf dasselbe
# Geraet beschraenkt - hier wird nur frueher und mit klarerer Meldung geblockt.
GERAET = os.environ.get("CONNECTOR_DEVICE", "").strip()

server = MCPServer(os.environ.get("CONNECTOR_MCP_NAME", "skconnector"))


class HubError(RuntimeError):
    pass


def _ziel(device: str) -> str:
    """Loest die Geraete-ID auf - und haelt einen festgelegten Server bei seinem."""
    if not GERAET:
        if not device:
            raise HubError("Kein Geraet angegeben. 'devices' zeigt die gueltigen IDs.")
        return device
    if device and device != GERAET:
        raise HubError(
            f"Dieser Connector ist fest auf '{GERAET}' eingestellt. "
            f"Fuer '{device}' gibt es einen eigenen Connector."
        )
    return GERAET


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
    device = _ziel(device)
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
        if GERAET and d["id"] != GERAET:
            continue
        age = f"{int(time.time() - d['last_seen'])}s" if d.get("last_seen") else "nie"
        state = "online" if d["online"] else "offline"
        if not d["enrolled"]:
            state = "nicht enrolled"
        lines.append(
            f"{d['id']:<18} {state:<14} {d['platform']:<8} Modus={d['mode']:<8} "
            f"Besitzer={d['owner']:<8} zuletzt={age:<8} Faehigkeiten={','.join(d['capabilities']) or '-'}"
        )
    if not lines:
        return (f"Geraet '{GERAET}' ist beim Hub nicht registriert." if GERAET
                else "Keine Geraete registriert.")
    return "\n".join(lines)


@server.tool()
def device_info(device: str) -> str:
    """Details zu einem Geraet, inklusive der zuletzt gemeldeten Systemfakten."""
    return json.dumps(_call("GET", f"/v1/devices/{_ziel(device)}"), indent=2, ensure_ascii=False)


@server.tool()
def probe(device: str) -> str:
    """Fragt ein Geraet live nach Systemfakten (Hostname, OS, Akku, Sperrstatus).

    Gut geeignet, um zu pruefen, ob ein Geraet wirklich antwortet.
    """
    return json.dumps(_dispatch(device, "probe", {}, 30), indent=2, ensure_ascii=False)


@server.tool()
def permissions(device: str) -> str:
    """Prueft auf einem Mac, welche macOS-Freigaben tatsaechlich funktionieren.

    Zeigt fuer Mail.app, Safari, Chrome und Festplattenvollzugriff, ob der
    Zugriff klappt - und welche Freigabe sonst fehlt. Bei der Einrichtung als
    Erstes aufrufen, das erspart kryptische AppleScript-Fehlernummern.
    """
    out = _dispatch(device, "permissions", {}, 90)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    lines = []
    for name, info in out["result"].items():
        mark = {True: "OK  ", False: "FEHLT", None: "--  "}[info.get("ok")]
        detail = info.get("hinweis") or info.get("wert")
        lines.append(f"{mark} {name:<28} {detail if detail is not None else ''}")
    return "\n".join(lines)


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
# Programme (macOS, ueber AppleScript)
# ---------------------------------------------------------------------------

@server.tool()
def app_list(device: str) -> str:
    """Listet die laufenden Programme mit sichtbarem Fenster."""
    out = _dispatch(device, "app.list", {}, 60)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    return "\n".join(
        f"{'*' if a['frontmost'] == 'true' else ' '} {a['name']:<30} PID {a['pid']}"
        for a in out["result"]["apps"]
    ) or "Keine Programme im Vordergrund."


@server.tool()
def app_launch(device: str, name: str, file: str = "") -> str:
    """Startet ein Programm, optional mit einer Datei.

    Braucht keine vorherige Automation-Freigabe - laeuft ueber 'open -a'.
    """
    payload: dict[str, Any] = {"name": name}
    if file:
        payload["file"] = file
    out = _dispatch(device, "app.launch", payload, 60)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    return f"{name} gestartet."


@server.tool()
def app_quit(device: str, name: str) -> str:
    """Beendet ein Programm."""
    out = _dispatch(device, "app.quit", {"name": name}, 60)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    return f"{name} beendet."


@server.tool()
def applescript(device: str, script: str, timeout_s: int = 120) -> str:
    """Fuehrt beliebiges AppleScript auf einem Mac aus - der Generalschluessel.

    Damit laesst sich alles steuern, was auf dem Mac skriptfaehig ist:
    Notizen, Kalender, Kontakte, Musik, Finder, Office, Fremdprogramme.

    Zwei Dinge beachten:
      * macOS fragt beim ERSTEN Zugriff auf ein Programm nach Zustimmung.
        Sitzt niemand am Mac, schlaegt das Kommando fehl - die betroffenen
        Programme vorher mit grant-permissions.sh freigeben.
      * 'do shell script' im Skript laeuft durch dieselbe Deny-Liste wie
        normale Shell-Kommandos.

    Beispiel:
        tell application "Notes" to return name of every note
    """
    out = _dispatch(device, "app.applescript", {"script": script}, timeout_s)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    res = out["result"]
    return (res["result"] or "(keine Ausgabe)") + ("\n[gekuerzt]" if res.get("truncated") else "")


# ---------------------------------------------------------------------------
# Browser (macOS, ueber AppleScript)
# ---------------------------------------------------------------------------

@server.tool()
def browser_tabs(device: str, app: str = "Safari") -> str:
    """Listet alle offenen Tabs eines Browsers mit Fenster- und Tab-Nummer.

    Die Nummern brauchst du fuer browser_read und browser_js.
    app: Safari, Google Chrome, Brave Browser, Microsoft Edge oder Arc.
    """
    out = _dispatch(device, "browser.tabs", {"app": app}, 60)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    rows = [f"Fenster {t['window']}, Tab {t['tab']}: {t['title']}\n    {t['url']}"
            for t in out["result"]["tabs"]]
    return "\n".join(rows) or f"{app}: keine offenen Tabs."


@server.tool()
def browser_read(device: str, app: str = "Safari", window: int = 1, tab: int = 0) -> str:
    """Liest den sichtbaren Text einer Browserseite.

    tab=0 nimmt den gerade aktiven Tab. Setzt voraus, dass im Browser
    'JavaScript aus Apple Events erlauben' aktiviert ist.
    """
    out = _dispatch(device, "browser.read",
                    {"app": app, "window": window, "tab": tab}, 90)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    res = out["result"]
    return res["result"] + ("\n[gekuerzt]" if res.get("truncated") else "")


@server.tool()
def browser_open(device: str, url: str, app: str = "Safari") -> str:
    """Oeffnet eine URL in einem neuen Tab (nur Modus 'full')."""
    out = _dispatch(device, "browser.open", {"app": app, "url": url}, 60)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    return f"{url} in {app} geoeffnet."


@server.tool()
def browser_js(device: str, script: str, app: str = "Safari",
               window: int = 1, tab: int = 0) -> str:
    """Fuehrt JavaScript in einem Tab aus und gibt das Ergebnis zurueck.

    Damit lassen sich Formulare fuellen, Elemente anklicken oder gezielt
    Daten aus einer Seite holen. Nur Modus 'full'.
    """
    out = _dispatch(device, "browser.js",
                    {"app": app, "script": script, "window": window, "tab": tab}, 90)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    res = out["result"]
    return res["result"] + ("\n[gekuerzt]" if res.get("truncated") else "")


# ---------------------------------------------------------------------------
# Mail.app (macOS, ueber AppleScript)
# ---------------------------------------------------------------------------

@server.tool()
def mail_accounts(device: str) -> str:
    """Listet die in Mail.app eingerichteten Konten."""
    out = _dispatch(device, "mail.accounts", {}, 60)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    return "\n".join(
        f"{a['name']:<25} {a['user']:<35} aktiv={a['enabled']}"
        for a in out["result"]["accounts"]
    ) or "Keine Konten gefunden."


@server.tool()
def mail_list(device: str, mailbox: str = "inbox", account: str = "",
              limit: int = 25, unread_only: bool = False) -> str:
    """Listet die neuesten Mails eines Postfachs (Betreff, Absender, Datum, ID).

    Die ID brauchst du fuer mail_read.
    """
    out = _dispatch(device, "mail.list", {
        "mailbox": mailbox, "account": account,
        "limit": limit, "unread_only": unread_only}, 180)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    return _format_messages(out["result"]["messages"])


@server.tool()
def mail_search(device: str, query: str, mailbox: str = "inbox", account: str = "",
                limit: int = 25, scan: int = 150) -> str:
    """Sucht in Betreff und Absender der letzten Mails eines Postfachs.

    Durchsucht die letzten `scan` Nachrichten - kein Volltextindex, sondern
    ein Durchlauf. Fuer aeltere Treffer scan erhoehen.
    """
    out = _dispatch(device, "mail.search", {
        "query": query, "mailbox": mailbox, "account": account,
        "limit": limit, "scan": scan}, 240)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    res = out["result"]
    header = f"{len(res['messages'])} Treffer unter den letzten {res['scanned']} Mails:\n"
    return header + _format_messages(res["messages"])


@server.tool()
def mail_read(device: str, id: str, mailbox: str = "inbox", account: str = "") -> str:
    """Liest eine einzelne Mail im Volltext. id stammt aus mail_list."""
    out = _dispatch(device, "mail.read",
                    {"id": id, "mailbox": mailbox, "account": account}, 120)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    r = out["result"]
    body = r["body"] + ("\n[gekuerzt]" if r.get("truncated") else "")
    return f"Von:     {r['sender']}\nBetreff: {r['subject']}\nDatum:   {r['received']}\n\n{body}"


@server.tool()
def mail_draft(device: str, to: list[str], subject: str, body: str,
               cc: list[str] | None = None, from_address: str = "") -> str:
    """Legt einen Mailentwurf an, ohne ihn zu verschicken.

    Der Entwurf oeffnet sich sichtbar in Mail.app und liegt in den Entwuerfen.
    Der sichere Weg: erst Entwurf, dann selbst pruefen und senden.
    """
    payload: dict[str, Any] = {"to": to, "subject": subject, "body": body}
    if cc:
        payload["cc"] = cc
    if from_address:
        payload["from"] = from_address
    out = _dispatch(device, "mail.draft", payload, 90)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    return f"Entwurf an {', '.join(to)} angelegt: {subject}"


@server.tool()
def mail_send(device: str, to: list[str], subject: str, body: str,
              cc: list[str] | None = None, from_address: str = "") -> str:
    """Verschickt eine Mail sofort ueber Mail.app.

    Braucht Modus 'full' UND die eigene Freigabe 'mail.send' auf dem Geraet -
    Mails lesen und Mails verschicken sind bewusst getrennt. Wenn Unsicherheit
    besteht, ob die Mail so rausgehen soll: mail_draft nehmen.
    """
    payload: dict[str, Any] = {"to": to, "subject": subject, "body": body}
    if cc:
        payload["cc"] = cc
    if from_address:
        payload["from"] = from_address
    out = _dispatch(device, "mail.send", payload, 120)
    if out["status"] != "done":
        return f"[{out['status']}] {out.get('error')}"
    return f"Mail an {', '.join(to)} verschickt: {subject}"


def _format_messages(messages: list[dict]) -> str:
    rows = []
    for m in messages:
        flag = " " if str(m.get("read", "")).lower() == "true" else "•"
        rows.append(f"{flag} [{m['id']:>8}] {m['received'][:22]:<22} {m['sender'][:38]:<38} "
                    f"{m['subject']}")
    return "\n".join(rows) or "Keine Mails gefunden."


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
    # Ein festgelegter Server zeigt auch im Log nur sein eigenes Geraet.
    ziel = _ziel(device) if (device or GERAET) else ""
    if ziel:
        path += f"&device_id={ziel}"
    entries = _call("GET", path)["entries"]
    return "\n".join(
        f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(e['ts']))}  "
        f"{e['actor']:<22} {e['action']:<20} {e.get('device_id') or '-':<16} "
        f"{json.dumps(e['detail'], ensure_ascii=False)}"
        for e in entries
    ) or "Audit-Log ist leer."


@server.tool()
def unlock(code: str) -> str:
    """Schaltet diesen Zugang mit dem Code aus der Authenticator-App frei.

    Wenn ein Aufruf mit 'Zweite Schranke' abgelehnt wird: den Menschen nach
    dem aktuellen sechsstelligen Code fragen und ihn hier eingeben. Den Code
    NIE raten, nie aus dem Verlauf wiederverwenden - er gilt nur einmal.
    """
    out = _call("POST", "/v1/unlock", {"code": code})
    minuten = int(out.get("seconds", 0) / 60)
    zusatz = f" ({out['note']})" if out.get("note") not in (None, "ok") else ""
    return f"Freigeschaltet fuer {minuten} Minuten{zusatz}."


@server.tool()
def lock() -> str:
    """Beendet die Freischaltung sofort - fuer diesen Zugang."""
    _call("POST", "/v1/lock")
    return "Gesperrt. Der naechste Zugriff braucht wieder einen Code."


@server.tool()
def lock_status() -> str:
    """Zeigt, ob dieser Zugang gerade freigeschaltet ist und wie lange noch."""
    out = _call("GET", "/v1/unlock")
    if not out.get("totp_aktiv"):
        return "Zweite Schranke ist nicht eingerichtet."
    if out.get("unlocked"):
        return f"Freigeschaltet, noch {out['seconds_left']}s."
    return "Gesperrt - 'unlock' mit dem Code aus der Authenticator-App."


@server.tool()
def killswitch(state: str) -> str:
    """Schaltet den Not-Aus des Hubs ('on' = keine Kommandos mehr, 'off' = normal)."""
    if state not in ("on", "off"):
        return "state muss 'on' oder 'off' sein."
    return json.dumps(_call("POST", f"/v1/killswitch/{state}"), ensure_ascii=False)


def main() -> None:
    """Startet den Server - lokal ueber stdio, fern ueber HTTP.

    stdio ist der Normalfall: Claude Code startet den Prozess selbst.
    'streamable-http' brauchen Claude im Browser und Cowork, die einen
    erreichbaren Endpunkt verlangen statt eines lokalen Prozesses.

        CONNECTOR_MCP_TRANSPORT=streamable-http
        CONNECTOR_MCP_BIND=172.18.0.1        # Docker-Gateway, nicht 0.0.0.0
        CONNECTOR_MCP_PORT=8788
        CONNECTOR_MCP_PATH=/mcp

    Der Endpunkt hat KEINE eigene Authentifizierung - der Schutz liegt im
    geheimen Pfad im Reverse-Proxy davor. Deshalb gehoert dort ein Token mit
    Obergrenze hinein, nie das Master-Token.
    """
    transport = os.environ.get("CONNECTOR_MCP_TRANSPORT", "stdio")
    if transport != "streamable-http":
        server.run()
        return
    server.run(
        transport="streamable-http",
        host=os.environ.get("CONNECTOR_MCP_BIND", "127.0.0.1"),
        port=int(os.environ.get("CONNECTOR_MCP_PORT", "8788")),
        streamable_http_path=os.environ.get("CONNECTOR_MCP_PATH", "/mcp"),
        stateless_http=True,
    )


if __name__ == "__main__":
    main()
