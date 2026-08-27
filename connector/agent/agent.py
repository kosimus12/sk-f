#!/usr/bin/env python3
"""Connector-Agent fuer macOS und Linux.

Nur Standardbibliothek - keine Installation von Paketen noetig.

Der Agent haelt eine ausgehende Long-Poll-Verbindung zum Hub. Dadurch ist das
Geraet erreichbar, ohne dass ein Port offen sein muss, und - wenn der Agent als
LaunchDaemon (macOS) bzw. systemd-Dienst (Linux) laeuft - auch dann, wenn der
Bildschirm gesperrt oder niemand angemeldet ist.

Aufruf:
    agent.py register --hub https://hub.example.de --code skc_enr_...
    agent.py run
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import pwd
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_STATE = "/etc/skconnector/agent.json"
USER_AGENT = "sk-connector-agent/1.1"

MAX_OUTPUT_BYTES = 256 * 1024  # 256 KiB pro Kommando, danach wird gekuerzt

# ---------------------------------------------------------------------------
# Rollen
#
# Auf dem Mac koennen zwei Prozesse mit demselben Token laufen:
#   system - LaunchDaemon als root: Shell und Dateien, laeuft auch am
#            Login-Fenster und bei gesperrtem Bildschirm.
#   user   - optionaler LaunchAgent in der Benutzersitzung: Browser und
#            Mail.app. Apple Events an laufende Programme brauchen eine
#            Sitzung; als reiner Daemon scheitern sie je nach TCC-Zustand.
# Standard ist 'all' - ein Prozess macht beides und schickt GUI-Kommandos
# ueber 'launchctl asuser' in die Sitzung des angemeldeten Benutzers.
# ---------------------------------------------------------------------------

SYSTEM_KINDS = ["shell", "fs.list", "fs.read", "fs.write", "probe", "permissions"]
USER_KINDS = [
    "notify",
    "app.list", "app.launch", "app.quit", "app.applescript",
    "browser.tabs", "browser.read", "browser.open", "browser.js", "browser.close",
    "mail.accounts", "mail.mailboxes", "mail.list", "mail.search", "mail.read",
    "mail.draft", "mail.send",
]

SYSTEM_CAPS = ["shell", "fs", "probe"]
USER_CAPS = ["notify", "app", "browser", "mail"]


def role() -> str:
    value = os.environ.get("CONNECTOR_ROLE", "all").lower()
    return value if value in ("system", "user", "all") else "all"


def handled_kinds() -> list[str]:
    current = role()
    kinds = []
    if current in ("system", "all"):
        kinds += SYSTEM_KINDS
    if current in ("user", "all"):
        kinds += USER_KINDS
    if platform.system() != "Darwin":
        # Browser und Mail laufen ueber AppleScript - anderswo gibt es sie nicht.
        kinds = [k for k in kinds if not k.startswith(("app.", "browser.", "mail."))]
    if not mail_send_allowed():
        kinds = [k for k in kinds if k != "mail.send"]
    return kinds


def capabilities() -> list[str]:
    current = role()
    caps = []
    if current in ("system", "all"):
        caps += SYSTEM_CAPS
    if current in ("user", "all"):
        caps += USER_CAPS
    if platform.system() != "Darwin":
        # Browser- und Mail-Steuerung gibt es nur ueber AppleScript.
        caps = [c for c in caps if c not in ("app", "browser", "mail")]
    if mail_send_allowed() and "mail" in caps:
        caps.append("mail.send")
    return caps


def mail_send_allowed() -> bool:
    """Mails verschicken ist eine eigene Freigabe, nicht Teil von 'Mail lesen'."""
    return os.environ.get("CONNECTOR_ALLOW_MAIL_SEND") == "1"


# ---------------------------------------------------------------------------
# Zustand
# ---------------------------------------------------------------------------

def state_path() -> str:
    return os.environ.get("CONNECTOR_STATE", DEFAULT_STATE)


def load_state() -> dict:
    path = state_path()
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_state(state: dict) -> None:
    path = state_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    os.chmod(tmp, 0o600)  # Token nur fuer den Eigentuemer lesbar
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def http(method: str, url: str, token: str | None = None,
         body: dict | None = None, timeout: int = 60) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8") or "{}"
    return json.loads(raw)


# ---------------------------------------------------------------------------
# Systemfakten
# ---------------------------------------------------------------------------

def console_user() -> tuple[str | None, int | None]:
    """Aktuell an der grafischen Konsole angemeldeter Benutzer (macOS)."""
    if platform.system() != "Darwin":
        return None, None
    try:
        out = subprocess.run(["/usr/bin/stat", "-f", "%Su", "/dev/console"],
                             capture_output=True, text=True, timeout=5)
        name = out.stdout.strip()
        if not name or name == "root":
            return None, None
        return name, pwd.getpwnam(name).pw_uid
    except Exception:
        return None, None


def parse_ioreg_lock(text: str) -> bool | None:
    """Liest den Sperrstatus aus der Plist-Ausgabe von 'ioreg -n Root -d1 -a'.

    macOS setzt CGSSessionScreenIsLocked nur, WENN gesperrt ist - fehlt der
    Schluessel, ist der Bildschirm offen.
    """
    idx = text.find("CGSSessionScreenIsLocked")
    if idx == -1:
        return False
    fenster = text[idx:idx + 200]
    if "<true/>" in fenster:
        return True
    if "<false/>" in fenster:
        return False
    return None


def screen_locked() -> bool | None:
    """Ist der Bildschirm gesperrt? None, wenn nicht ermittelbar.

    Ueber ioreg statt ueber Quartz: Apples /usr/bin/python3 bringt kein
    PyObjC mit, der Import scheiterte auf jedem echten Mac still. ioreg
    braucht kein Modul und funktioniert auch im root-Daemon.
    """
    if platform.system() != "Darwin":
        return None
    _user, uid = console_user()
    if uid is None:
        return True  # Login-Fenster == gesperrt
    try:
        out = subprocess.run(["/usr/sbin/ioreg", "-n", "Root", "-d1", "-a"],
                             capture_output=True, text=True, timeout=10)
        return parse_ioreg_lock(out.stdout)
    except Exception:
        return None


def parse_pmset(text: str) -> dict[str, int]:
    """Zieht die Schlaf-Einstellungen aus der Ausgabe von 'pmset -g custom'.

    Nur der Block 'AC Power' zaehlt: der Mac soll am Netzteil wach bleiben,
    im Akkubetrieb ist Schlafen richtig.
    """
    interessant = ("disablesleep", "sleep", "displaysleep", "disksleep",
                   "womp", "powernap", "standby", "lidwake", "ttyskeepawake")
    werte: dict[str, int] = {}
    in_ac = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("AC Power"):
            in_ac = True
            continue
        if stripped.startswith("Battery Power"):
            in_ac = False
            continue
        if not in_ac:
            continue
        parts = stripped.split()
        if len(parts) >= 2 and parts[0] in interessant:
            try:
                werte[parts[0]] = int(parts[1])
            except ValueError:
                pass
    return werte


def sleep_settings() -> dict:
    """Beantwortet: bleibt dieser Mac zugeklappt und gesperrt erreichbar?"""
    raw = _run_ok(["pmset", "-g", "custom"]) or ""
    werte = parse_pmset(raw)
    if not werte:
        return {"lesbar": False}

    # 'disablesleep 1' ist der einzige Schalter, der auch bei geschlossenem
    # Deckel wirkt. 'sleep 0' allein reicht nicht - Zuklappen schlaeft trotzdem.
    zugeklappt_ok = werte.get("disablesleep") == 1
    return {
        "lesbar": True,
        "werte": werte,
        "bleibt_wach_am_netzteil": werte.get("sleep") == 0 or zugeklappt_ok,
        "bleibt_wach_zugeklappt": zugeklappt_ok,
        "hinweis": None if zugeklappt_ok else (
            "Zugeklappt schlaeft dieser Mac ein. Beheben mit: "
            "sudo pmset -a disablesleep 1"
        ),
    }


def battery() -> dict | None:
    if not shutil.which("pmset"):
        return None
    try:
        out = subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True, timeout=5)
        text = out.stdout
        pct = None
        for token in text.replace(";", " ").split():
            if token.endswith("%"):
                pct = int(token.rstrip("%"))
                break
        return {"percent": pct, "ac": "AC Power" in text}
    except Exception:
        return None


def gather_facts() -> dict:
    facts: dict = {
        "hostname": socket.gethostname(),
        "platform": platform.system().lower(),
        "release": platform.release(),
        "python": platform.python_version(),
        "uptime_s": _uptime(),
        "agent_uid": os.getuid(),
        "ts": time.time(),
    }
    if platform.system() == "Darwin":
        facts["macos"] = _run_ok(["sw_vers", "-productVersion"])
        user, _uid = console_user()
        facts["console_user"] = user
        facts["screen_locked"] = screen_locked()
        facts["sleep"] = sleep_settings()
    bat = battery()
    if bat:
        facts["battery"] = bat
    return facts


def _uptime() -> float | None:
    try:
        if os.path.exists("/proc/uptime"):
            with open("/proc/uptime", encoding="utf-8") as fh:
                return float(fh.read().split()[0])
        out = subprocess.run(["sysctl", "-n", "kern.boottime"],
                             capture_output=True, text=True, timeout=5).stdout
        sec = int(out.split("sec = ")[1].split(",")[0])
        return time.time() - sec
    except Exception:
        return None


def _run_ok(cmd: list[str]) -> str | None:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Kommandoausfuehrung
# ---------------------------------------------------------------------------

def _truncate(text: str) -> tuple[str, bool]:
    raw = text.encode("utf-8", "replace")
    if len(raw) <= MAX_OUTPUT_BYTES:
        return text, False
    return raw[:MAX_OUTPUT_BYTES].decode("utf-8", "ignore"), True


def run_shell(payload: dict, timeout: int) -> dict:
    command = payload.get("command", "")
    cwd = payload.get("cwd") or None
    as_user = payload.get("as_user")

    argv = ["/bin/bash", "-lc", command]
    if as_user and os.getuid() == 0:
        # Der Daemon laeuft als root; fuer Nutzerkontext gezielt herabstufen.
        argv = ["/usr/bin/sudo", "-u", str(as_user), "-i", "/bin/bash", "-lc", command]

    started = time.time()
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    stdout, cut_out = _truncate(proc.stdout)
    stderr, cut_err = _truncate(proc.stderr)
    return {
        "exit_code": proc.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "truncated": cut_out or cut_err,
        "duration_s": round(time.time() - started, 3),
    }


def run_fs(kind: str, payload: dict) -> dict:
    path = os.path.expanduser(payload["path"])
    if kind == "fs.list":
        entries = []
        with os.scandir(path) as it:
            for e in sorted(it, key=lambda x: x.name)[: int(payload.get("limit", 500))]:
                try:
                    st = e.stat(follow_symlinks=False)
                    entries.append({
                        "name": e.name, "dir": e.is_dir(),
                        "size": st.st_size, "mtime": st.st_mtime,
                    })
                except OSError:
                    entries.append({"name": e.name, "error": "stat fehlgeschlagen"})
        return {"path": path, "entries": entries}

    if kind == "fs.read":
        max_bytes = min(int(payload.get("max_bytes", MAX_OUTPUT_BYTES)), MAX_OUTPUT_BYTES)
        with open(path, "rb") as fh:
            raw = fh.read(max_bytes + 1)
        truncated = len(raw) > max_bytes
        return {
            "path": path,
            "content": raw[:max_bytes].decode("utf-8", "replace"),
            "truncated": truncated,
        }

    if kind == "fs.write":
        content = payload.get("content", "")
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        mode = "a" if payload.get("append") else "w"
        with open(path, mode, encoding="utf-8") as fh:
            fh.write(content)
        return {"path": path, "bytes": len(content.encode("utf-8")), "append": bool(payload.get("append"))}

    raise ValueError(f"unbekannte fs-Operation: {kind}")


def run_notify(payload: dict) -> dict:
    """Meldung im angemeldeten Benutzerkontext anzeigen (macOS) bzw. loggen."""
    title = payload.get("title", "Claude")
    message = payload.get("message", "")
    if platform.system() != "Darwin":
        if shutil.which("notify-send"):
            subprocess.run(["notify-send", title, message], timeout=10)
            return {"delivered": "notify-send"}
        return {"delivered": "log-only", "note": "keine Desktop-Benachrichtigung verfuegbar"}

    user, uid = console_user()
    if uid is None:
        return {"delivered": False, "note": "niemand angemeldet - Meldung nicht zustellbar"}
    script = (
        f'display notification {json.dumps(message)} with title {json.dumps(title)}'
    )
    argv = ["/usr/bin/osascript", "-e", script]
    if os.getuid() == 0:
        argv = ["/bin/launchctl", "asuser", str(uid)] + argv
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=15)
    return {"delivered": proc.returncode == 0, "user": user, "stderr": proc.stderr.strip()}


# ---------------------------------------------------------------------------
# AppleScript: Browser und Mail.app
# ---------------------------------------------------------------------------

SEP = "|~|"          # Feldtrenner - kommt in Betreffs und URLs praktisch nie vor
REC = "␞"       # Datensatztrenner (Unicode RECORD SEPARATOR SYMBOL)


class AppleScriptError(RuntimeError):
    """AppleScript hat einen Fehler zurueckgegeben."""


def as_literal(value: str) -> str:
    """Wert als AppleScript-Stringliteral - Anfuehrungszeichen entschaerft."""
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
    escaped = escaped.replace("\r", " ").replace("\n", "\\n")
    return f'"{escaped}"'


def run_osascript(script: str, timeout: int = 60) -> str:
    """Fuehrt AppleScript aus - notfalls in der Sitzung des angemeldeten Nutzers.

    Als root laufender Daemon: Apple Events brauchen eine GUI-Sitzung, deshalb
    der Umweg ueber 'launchctl asuser'. Laeuft der Agent bereits als Benutzer
    (Rolle 'user'), wird direkt aufgerufen.
    """
    argv = ["/usr/bin/osascript", "-"]
    if os.getuid() == 0:
        _user, uid = console_user()
        if uid is None:
            raise AppleScriptError(
                "Niemand ist angemeldet - Browser und Mail sind nur in einer "
                "aktiven Benutzersitzung erreichbar (gesperrter Bildschirm ist ok)."
            )
        argv = ["/bin/launchctl", "asuser", str(uid)] + argv

    proc = subprocess.run(argv, input=script, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        message = proc.stderr.strip() or f"osascript endete mit {proc.returncode}"
        if "-1743" in message or "Not authorized to send Apple events" in message:
            raise AppleScriptError(
                f"{message}\n\nMacOS blockiert die Steuerung. Einmalig auf dem Mac "
                "freigeben: Systemeinstellungen > Datenschutz & Sicherheit > "
                "Automation. Falls der Eintrag fehlt, "
                "'bash grant-permissions.sh' in der Benutzersitzung ausfuehren."
            )
        if "-1728" in message:
            raise AppleScriptError(f"{message} (Objekt nicht gefunden - Tab oder Mail weg?)")
        raise AppleScriptError(message)
    return proc.stdout


def parse_records(raw: str, fields: list[str]) -> list[dict]:
    """Zerlegt die Textausgabe eines AppleScripts in Woerterbuecher."""
    records = []
    for line in raw.split(REC):
        line = line.strip("\n")
        if not line.strip():
            continue
        parts = line.split(SEP)
        if len(parts) < len(fields):
            parts += [""] * (len(fields) - len(parts))
        records.append(dict(zip(fields, (p.strip() for p in parts[: len(fields)]))))
    return records


# -- Browser ----------------------------------------------------------------

CHROMIUM = ("Google Chrome", "Brave Browser", "Microsoft Edge", "Arc")


def browser_script_tabs(app: str) -> str:
    title_prop = "title" if app in CHROMIUM else "name"
    return f'''
set out to ""
tell application {as_literal(app)}
    repeat with w from 1 to (count of windows)
        repeat with t from 1 to (count of tabs of window w)
            set theTab to tab t of window w
            set out to out & w & {as_literal(SEP)} & t & {as_literal(SEP)} & ¬
                ({title_prop} of theTab) & {as_literal(SEP)} & (URL of theTab) & {as_literal(REC)}
        end repeat
    end repeat
end tell
return out
'''


def browser_script_js(app: str, script: str, window: int, tab: int) -> str:
    js = as_literal(script)
    if app in CHROMIUM:
        return f'''
tell application {as_literal(app)}
    set r to execute tab {tab} of window {window} javascript {js}
    if r is missing value then return ""
    return r as text
end tell
'''
    return f'''
tell application {as_literal(app)}
    set r to do JavaScript {js} in tab {tab} of window {window}
    if r is missing value then return ""
    return r as text
end tell
'''


def run_browser(kind: str, payload: dict, timeout: int) -> dict:
    app = payload.get("app", "Safari")
    window = int(payload.get("window", 1))
    tab = int(payload.get("tab", 0))

    if kind == "browser.tabs":
        raw = run_osascript(browser_script_tabs(app), timeout)
        tabs = parse_records(raw, ["window", "tab", "title", "url"])
        return {"app": app, "count": len(tabs), "tabs": tabs}

    if kind == "browser.open":
        url = payload["url"]
        script = f'tell application {as_literal(app)}\n activate\n open location {as_literal(url)}\nend tell'
        run_osascript(script, timeout)
        return {"app": app, "opened": url}

    if kind == "browser.close":
        script = f'tell application {as_literal(app)} to close tab {tab or 1} of window {window}'
        run_osascript(script, timeout)
        return {"app": app, "closed": {"window": window, "tab": tab or 1}}

    if kind in ("browser.read", "browser.js"):
        if tab == 0:
            tab = _front_tab_index(app, window, timeout)
        script = (
            payload["script"] if kind == "browser.js"
            else "document.body ? document.body.innerText : document.documentElement.innerText"
        )
        raw = run_osascript(browser_script_js(app, script, window, tab), timeout)
        text, truncated = _truncate(raw)
        return {"app": app, "window": window, "tab": tab,
                "result": text, "truncated": truncated}

    raise ValueError(f"unbekannte Browser-Operation: {kind}")


def _front_tab_index(app: str, window: int, timeout: int) -> int:
    """Index des aktiven Tabs - Safari und Chrome nennen ihn unterschiedlich."""
    if app in CHROMIUM:
        script = f'tell application {as_literal(app)} to return active tab index of window {window}'
    else:
        script = f'''
tell application {as_literal(app)}
    set theTab to current tab of window {window}
    repeat with t from 1 to (count of tabs of window {window})
        if tab t of window {window} is theTab then return t
    end repeat
end tell
return 1
'''
    try:
        return int(run_osascript(script, timeout).strip() or 1)
    except (AppleScriptError, ValueError):
        return 1


# -- Beliebige Programme ----------------------------------------------------

def run_app(kind: str, payload: dict, timeout: int) -> dict:
    """Programme starten, beenden, auflisten - oder beliebiges AppleScript.

    'app.applescript' ist der Generalschluessel fuer alles, was sich auf dem
    Mac skripten laesst: Notizen, Kalender, Musik, Finder, Office, Fremdapps.
    macOS fragt bei jedem Programm einmal nach Zustimmung - siehe
    grant-permissions.sh, das die Abfragen vorab ausloest.
    """
    if kind == "app.list":
        raw = run_osascript(
            f'set out to ""\n'
            f'tell application "System Events"\n'
            f'  repeat with p in (every process whose background only is false)\n'
            f'    set out to out & (name of p) & {as_literal(SEP)} & '
            f'(unix id of p) & {as_literal(SEP)} & (frontmost of p) & {as_literal(REC)}\n'
            f'  end repeat\nend tell\nreturn out', timeout)
        return {"apps": parse_records(raw, ["name", "pid", "frontmost"])}

    if kind == "app.launch":
        name = payload["name"]
        # 'open -a' braucht keine Automation-Freigabe - der bessere Weg zum
        # Starten, weil er auch bei noch nie freigegebenen Programmen geht.
        argv = ["/usr/bin/open", "-a", name]
        if payload.get("file"):
            argv.append(os.path.expanduser(str(payload["file"])))
        user, uid = console_user()
        if os.getuid() == 0:
            if uid is None:
                raise AppleScriptError("Niemand angemeldet - Programm nicht startbar")
            argv = ["/bin/launchctl", "asuser", str(uid)] + argv
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        if proc.returncode != 0:
            raise AppleScriptError(proc.stderr.strip() or f"open endete mit {proc.returncode}")
        return {"launched": name, "user": user}

    if kind == "app.quit":
        run_osascript(f'tell application {as_literal(payload["name"])} to quit', timeout)
        return {"quit": payload["name"]}

    if kind == "app.applescript":
        raw = run_osascript(payload["script"], timeout)
        text, truncated = _truncate(raw.strip())
        return {"result": text, "truncated": truncated}

    raise ValueError(f"unbekannte Programm-Operation: {kind}")


# -- Mail.app ---------------------------------------------------------------

def mail_script_list(mailbox: str, account: str, limit: int, unread_only: bool) -> str:
    if account:
        box = f'mailbox {as_literal(mailbox)} of account {as_literal(account)}'
    else:
        box = as_literal(mailbox) if mailbox.lower() != "inbox" else "inbox"
        if mailbox.lower() != "inbox":
            box = f"mailbox {box}"
    selector = "(messages of theBox whose read status is false)" if unread_only else "(messages of theBox)"
    return f'''
set out to ""
tell application "Mail"
    set theBox to {box}
    set msgs to {selector}
    set n to (count of msgs)
    if n > {int(limit)} then set n to {int(limit)}
    repeat with i from 1 to n
        set m to item i of msgs
        try
            set out to out & (id of m) & {as_literal(SEP)} & (subject of m) & {as_literal(SEP)} & ¬
                (sender of m) & {as_literal(SEP)} & ((date received of m) as string) & {as_literal(SEP)} & ¬
                (read status of m) & {as_literal(SEP)} & (name of mailbox of m) & {as_literal(REC)}
        end try
    end repeat
end tell
return out
'''


def mail_script_read(message_id: str, mailbox: str, account: str) -> str:
    if account:
        box = f'mailbox {as_literal(mailbox)} of account {as_literal(account)}'
    elif mailbox.lower() != "inbox":
        box = f'mailbox {as_literal(mailbox)}'
    else:
        box = "inbox"
    return f'''
tell application "Mail"
    set theBox to {box}
    set m to (first message of theBox whose id is {int(message_id)})
    return (subject of m) & {as_literal(SEP)} & (sender of m) & {as_literal(SEP)} & ¬
        ((date received of m) as string) & {as_literal(SEP)} & (content of m)
end tell
'''


def mail_script_compose(payload: dict, send: bool) -> str:
    recipients = payload.get("to") or []
    if isinstance(recipients, str):
        recipients = [recipients]
    lines = [
        'tell application "Mail"',
        f'    set m to make new outgoing message with properties '
        f'{{subject:{as_literal(payload.get("subject", ""))}, '
        f'content:{as_literal(payload.get("body", ""))}, visible:true}}',
        "    tell m",
    ]
    for address in recipients:
        lines.append(
            f'        make new to recipient at end of to recipients '
            f'with properties {{address:{as_literal(address)}}}'
        )
    for address in (payload.get("cc") or []):
        lines.append(
            f'        make new cc recipient at end of cc recipients '
            f'with properties {{address:{as_literal(address)}}}'
        )
    lines.append("    end tell")
    if payload.get("from"):
        lines.append(f'    set sender of m to {as_literal(payload["from"])}')
    lines.append("    send m" if send else "    save m")
    lines.append('    return "ok"')
    lines.append("end tell")
    return "\n".join(lines)


def run_mail(kind: str, payload: dict, timeout: int) -> dict:
    mailbox = str(payload.get("mailbox", "inbox"))
    account = str(payload.get("account", ""))

    if kind == "mail.accounts":
        raw = run_osascript(
            f'set out to ""\ntell application "Mail"\n'
            f'  repeat with a in accounts\n'
            f'    set out to out & (name of a) & {as_literal(SEP)} & '
            f'(user name of a) & {as_literal(SEP)} & (enabled of a) & {as_literal(REC)}\n'
            f'  end repeat\nend tell\nreturn out', timeout)
        return {"accounts": parse_records(raw, ["name", "user", "enabled"])}

    if kind == "mail.mailboxes":
        scope = f'account {as_literal(account)}' if account else "application \"Mail\""
        raw = run_osascript(
            f'set out to ""\ntell {scope}\n'
            f'  repeat with b in mailboxes\n'
            f'    set out to out & (name of b) & {as_literal(REC)}\n'
            f'  end repeat\nend tell\nreturn out', timeout)
        return {"mailboxes": [r["name"] for r in parse_records(raw, ["name"])]}

    if kind == "mail.list":
        limit = min(int(payload.get("limit", 25)), 200)
        raw = run_osascript(
            mail_script_list(mailbox, account, limit, bool(payload.get("unread_only"))),
            timeout)
        return {"mailbox": mailbox, "messages": parse_records(
            raw, ["id", "subject", "sender", "received", "read", "mailbox"])}

    if kind == "mail.search":
        # Bewusst ein Scan der letzten N Nachrichten statt eines 'whose'-Filters:
        # Mail.app braucht fuer verschachtelte Filter ueber grosse Postfaecher
        # Minuten und laeuft dabei regelmaessig in den Timeout.
        scan = min(int(payload.get("scan", 150)), 500)
        query = str(payload["query"]).lower()
        raw = run_osascript(mail_script_list(mailbox, account, scan, False), timeout)
        found = [
            m for m in parse_records(raw, ["id", "subject", "sender", "received", "read", "mailbox"])
            if query in m["subject"].lower() or query in m["sender"].lower()
        ]
        return {"mailbox": mailbox, "scanned": scan, "query": payload["query"],
                "messages": found[: int(payload.get("limit", 25))]}

    if kind == "mail.read":
        raw = run_osascript(mail_script_read(str(payload["id"]), mailbox, account), timeout)
        parts = raw.split(SEP)
        while len(parts) < 4:
            parts.append("")
        body, truncated = _truncate(parts[3])
        return {"subject": parts[0].strip(), "sender": parts[1].strip(),
                "received": parts[2].strip(), "body": body, "truncated": truncated}

    if kind in ("mail.draft", "mail.send"):
        send = kind == "mail.send"
        run_osascript(mail_script_compose(payload, send), timeout)
        recipients = payload.get("to")
        return {"sent" if send else "drafted": True,
                "to": [recipients] if isinstance(recipients, str) else recipients,
                "subject": payload.get("subject", "")}

    raise ValueError(f"unbekannte Mail-Operation: {kind}")


# -- Berechtigungen ---------------------------------------------------------

def check_permissions() -> dict:
    """Prueft, was macOS diesem Agenten tatsaechlich erlaubt.

    Gedacht fuer die Einrichtung: sagt vor dem ersten echten Kommando, welche
    Freigabe noch fehlt, statt es an einer kryptischen Fehlernummer scheitern
    zu lassen.
    """
    results: dict[str, dict] = {}

    def probe_app(label: str, script: str) -> None:
        try:
            run_osascript(script, timeout=20)
            results[label] = {"ok": True}
        except AppleScriptError as exc:
            results[label] = {"ok": False, "hinweis": str(exc).split("\n")[0]}
        except Exception as exc:
            results[label] = {"ok": False, "hinweis": f"{type(exc).__name__}: {exc}"}

    probe_app("mail", 'tell application "Mail" to return (count of accounts) as text')
    for app in ("Safari", "Google Chrome"):
        probe_app(f"browser:{app}",
                  f'tell application {as_literal(app)} to return (count of windows) as text')

    # Festplattenvollzugriff: ohne ihn bleiben Mail-Ablage und viele
    # Benutzerordner fuer den Daemon unsichtbar.
    user, _uid = console_user()
    mail_dir = f"/Users/{user}/Library/Mail" if user else None
    if mail_dir and os.path.isdir(mail_dir):
        try:
            os.listdir(mail_dir)
            results["festplattenvollzugriff"] = {"ok": True}
        except PermissionError:
            results["festplattenvollzugriff"] = {
                "ok": False,
                "hinweis": "Systemeinstellungen > Datenschutz & Sicherheit > "
                           "Festplattenvollzugriff: /bin/bash und /usr/bin/python3 hinzufuegen",
            }
    else:
        results["festplattenvollzugriff"] = {"ok": None, "hinweis": "nicht pruefbar"}

    results["angemeldeter_benutzer"] = {"ok": user is not None, "wert": user}
    results["bildschirm_gesperrt"] = {"ok": None, "wert": screen_locked()}
    results["rolle"] = {"ok": None, "wert": role()}
    results["mail_senden_freigegeben"] = {"ok": None, "wert": mail_send_allowed()}
    return results


def execute(command: dict) -> tuple[dict | None, str | None]:
    kind = command["kind"]
    payload = command.get("payload", {}) or {}
    timeout = int(command.get("timeout_s", 120))
    try:
        if kind == "shell":
            return run_shell(payload, timeout), None
        if kind.startswith("fs."):
            return run_fs(kind, payload), None
        if kind == "notify":
            return run_notify(payload), None
        if kind == "probe":
            return gather_facts(), None
        if kind == "permissions":
            return check_permissions(), None
        if kind.startswith("app."):
            return run_app(kind, payload, timeout), None
        if kind.startswith("browser."):
            return run_browser(kind, payload, timeout), None
        if kind.startswith("mail."):
            if kind == "mail.send" and not mail_send_allowed():
                return None, ("Mailversand ist auf diesem Geraet nicht freigegeben "
                              "(CONNECTOR_ALLOW_MAIL_SEND=1 im LaunchDaemon setzen)")
            return run_mail(kind, payload, timeout), None
        return None, f"Kommandoart '{kind}' wird von diesem Agenten nicht unterstuetzt"
    except AppleScriptError as exc:
        return None, str(exc)
    except KeyError as exc:
        return None, f"Pflichtfeld fehlt: {exc}"
    except subprocess.TimeoutExpired:
        return None, f"Timeout nach {timeout}s"
    except FileNotFoundError as exc:
        return None, f"Nicht gefunden: {exc}"
    except PermissionError as exc:
        return None, f"Keine Berechtigung: {exc}"
    except Exception as exc:  # pragma: no cover - Agent darf nie sterben
        return None, f"{type(exc).__name__}: {exc}"


# ---------------------------------------------------------------------------
# Kommandos des CLI
# ---------------------------------------------------------------------------

def cmd_register(args: argparse.Namespace) -> int:
    hub = args.hub.rstrip("/")
    resp = http("POST", f"{hub}/v1/agent/register", body={
        "code": args.code, "capabilities": capabilities(), "facts": gather_facts(),
    }, timeout=30)
    save_state({"hub": hub, "token": resp["device_token"], "device_id": resp["device"]["id"]})
    print(f"Registriert als '{resp['device']['id']}' (Modus: {resp['device']['mode']}).")
    print(f"Token liegt in {state_path()} (chmod 600).")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    state = load_state()
    if not state.get("token"):
        print("Nicht registriert - zuerst 'agent.py register' ausfuehren.", file=sys.stderr)
        return 2
    hub, token = state["hub"], state["token"]
    device_id = state.get("device_id", "?")
    keep_awake = os.environ.get("CONNECTOR_KEEP_AWAKE") == "1"
    caff = None
    if keep_awake and shutil.which("caffeinate"):
        # Verhindert, dass der Mac im gesperrten Zustand einschlaeft und
        # damit unerreichbar wird. -s wirkt nur am Netzteil.
        caff = subprocess.Popen(["caffeinate", "-s", "-i"])
        log(f"caffeinate aktiv (PID {caff.pid})")

    kinds_param = ",".join(handled_kinds())
    log(f"Agent laeuft. Geraet={device_id} Rolle={role()} Hub={hub}")
    log(f"Kommandoarten: {kinds_param}")
    backoff = 1.0
    last_heartbeat = 0.0
    while True:
        try:
            if time.time() - last_heartbeat > 300:
                http("POST", f"{hub}/v1/agent/heartbeat", token,
                     {"facts": gather_facts()}, timeout=30)
                last_heartbeat = time.time()

            resp = http("GET", f"{hub}/v1/agent/poll?wait=25&kinds={kinds_param}",
                        token, timeout=45)
            backoff = 1.0
            if resp.get("killswitch"):
                log("Kill-Switch aktiv - warte 30s")
                time.sleep(30)
                continue
            for command in resp.get("commands", []):
                log(f"Kommando {command['id']} ({command['kind']})")
                result, error = execute(command)
                try:
                    http("POST", f"{hub}/v1/agent/result", token, {
                        "command_id": command["id"], "result": result, "error": error,
                    }, timeout=60)
                except Exception as exc:
                    log(f"Ergebnis konnte nicht gesendet werden: {exc}")
        except urllib.error.HTTPError as exc:
            if exc.code == 403:
                log("Token abgelehnt (widerrufen?) - Agent stoppt.")
                if caff:
                    caff.terminate()
                return 3
            log(f"HTTP {exc.code} - neuer Versuch in {backoff:.0f}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)
        except Exception as exc:
            log(f"{type(exc).__name__}: {exc} - neuer Versuch in {backoff:.0f}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)


def log(message: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="SK Connector Agent")
    sub = parser.add_subparsers(dest="cmd", required=True)

    reg = sub.add_parser("register", help="Enrollment-Code gegen ein Geraete-Token einloesen")
    reg.add_argument("--hub", required=True)
    reg.add_argument("--code", required=True)
    reg.set_defaults(func=cmd_register)

    run = sub.add_parser("run", help="Agent-Schleife starten")
    run.set_defaults(func=cmd_run)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
