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
USER_AGENT = "sk-connector-agent/1.0"

# Faehigkeiten, die dieser Agent tatsaechlich implementiert.
CAPABILITIES = ["shell", "fs", "notify", "probe"]

MAX_OUTPUT_BYTES = 256 * 1024  # 256 KiB pro Kommando, danach wird gekuerzt


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


def screen_locked() -> bool | None:
    """Ist der Bildschirm gesperrt? None, wenn nicht ermittelbar."""
    if platform.system() != "Darwin":
        return None
    user, uid = console_user()
    if uid is None:
        return True  # Login-Fenster == gesperrt
    try:
        out = subprocess.run(
            ["/bin/launchctl", "asuser", str(uid), "/usr/bin/python3", "-c",
             "import Quartz,sys;d=Quartz.CGSessionCopyCurrentDictionary();"
             "print(bool(d and d.get('CGSSessionScreenIsLocked',0)))"],
            capture_output=True, text=True, timeout=8,
        )
        val = out.stdout.strip()
        if val in ("True", "False"):
            return val == "True"
    except Exception:
        pass
    return None


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
        return None, f"Kommandoart '{kind}' wird von diesem Agenten nicht unterstuetzt"
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
        "code": args.code, "capabilities": CAPABILITIES, "facts": gather_facts(),
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

    log(f"Agent laeuft. Geraet={device_id} Hub={hub}")
    backoff = 1.0
    last_heartbeat = 0.0
    while True:
        try:
            if time.time() - last_heartbeat > 300:
                http("POST", f"{hub}/v1/agent/heartbeat", token,
                     {"facts": gather_facts()}, timeout=30)
                last_heartbeat = time.time()

            resp = http("GET", f"{hub}/v1/agent/poll?wait=25", token, timeout=45)
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
