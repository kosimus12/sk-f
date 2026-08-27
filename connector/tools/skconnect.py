#!/usr/bin/env python3
"""skconnect - Kommandozeile fuer die Steuerseite des Hubs.

Nur Standardbibliothek. Nuetzlich, um Geraete anzulegen, Enrollment-Codes
auszugeben, den Not-Aus zu schalten und das Audit-Log zu lesen - ohne Claude.

    export CONNECTOR_HUB_URL=https://hub.example.de
    export CONNECTOR_CONTROL_TOKEN=skc_ctl_...

    skconnect.py devices
    skconnect.py add mac-simon "Simons Mac" macos --mode full --caps shell,fs,notify,probe
    skconnect.py add iphone-simon "Simons iPhone" ios --caps notify \\
        --push-url https://ntfy.example.de/simon-iphone
    skconnect.py run mac-simon "uptime"
    skconnect.py notify iphone-simon "Backup" "Fertig, 0 Fehler"
    skconnect.py revoke mac-freundin
    skconnect.py killswitch on
    skconnect.py audit --limit 30
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

HUB = os.environ.get("CONNECTOR_HUB_URL", "").rstrip("/")
TOKEN = os.environ.get("CONNECTOR_CONTROL_TOKEN", "")


def call(method: str, path: str, body: dict | None = None, timeout: int = 60) -> dict:
    if not HUB or not TOKEN:
        sys.exit("CONNECTOR_HUB_URL und CONNECTOR_CONTROL_TOKEN muessen gesetzt sein.")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(HUB + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        sys.exit(f"Hub antwortete {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        sys.exit(f"Hub nicht erreichbar: {exc.reason}")


def dispatch_and_wait(device: str, kind: str, payload: dict, timeout_s: int) -> dict:
    cmd = call("POST", f"/v1/devices/{device}/commands",
               {"kind": kind, "payload": payload, "timeout_s": timeout_s})
    if cmd["status"] in ("done", "error"):
        return cmd
    deadline = time.time() + timeout_s + 10
    while time.time() < deadline:
        time.sleep(1)
        cmd = call("GET", f"/v1/commands/{cmd['id']}")
        if cmd["status"] in ("done", "error", "timeout", "cancelled"):
            return cmd
    return cmd


# ---------------------------------------------------------------------------

def cmd_devices(args: argparse.Namespace) -> None:
    for d in call("GET", f"/v1/devices?include_revoked={str(args.all).lower()}")["devices"]:
        state = "online" if d["online"] else ("widerrufen" if d["revoked_at"] else "offline")
        if not d["enrolled"] and not d["push_configured"]:
            state = "nicht enrolled"
        print(f"{d['id']:<18} {state:<14} {d['platform']:<7} {d['mode']:<8} "
              f"{d['owner']:<9} {','.join(d['capabilities']) or '-'}")


def cmd_add(args: argparse.Namespace) -> None:
    body = {
        "device_id": args.device_id,
        "label": args.label,
        "platform": args.platform,
        "owner": args.owner,
        "mode": args.mode,
        "capabilities": [c for c in args.caps.split(",") if c],
        "allowlist": [a for a in args.allowlist.split(",") if a],
        "ttl_s": args.ttl,
    }
    if args.push_url:
        body["push_url"] = args.push_url
    out = call("POST", "/v1/devices", body)
    print(f"Geraet '{out['device']['id']}' angelegt (Modus {out['device']['mode']}).")
    print()
    print("Enrollment-Code (gueltig %d Minuten, einmal verwendbar):" % (args.ttl // 60))
    print("  " + out["enrollment_code"])
    print()
    if args.platform in ("macos", "linux"):
        sub = "macos" if args.platform == "macos" else "linux"
        print("Auf dem Geraet ausfuehren:")
        print(f"  sudo bash agent/{sub}/install.sh --hub {HUB} \\")
        print(f"       --code {out['enrollment_code']}"
              + (" --keep-awake" if args.platform == "macos" else ""))


def cmd_run(args: argparse.Namespace) -> None:
    cmd = dispatch_and_wait(args.device, "shell", {"command": args.command}, args.timeout)
    res = cmd.get("result") or {}
    if cmd["status"] != "done":
        sys.exit(f"[{cmd['status']}] {cmd.get('error')}")
    sys.stdout.write(res.get("stdout", ""))
    sys.stderr.write(res.get("stderr", ""))
    sys.exit(res.get("exit_code", 0))


def cmd_notify(args: argparse.Namespace) -> None:
    cmd = dispatch_and_wait(args.device, "notify",
                            {"title": args.title, "message": args.message}, 45)
    print(json.dumps(cmd.get("result") or {"error": cmd.get("error")},
                     indent=2, ensure_ascii=False))


def cmd_probe(args: argparse.Namespace) -> None:
    cmd = dispatch_and_wait(args.device, "probe", {}, 30)
    print(json.dumps(cmd.get("result") or {"error": cmd.get("error")},
                     indent=2, ensure_ascii=False))


def cmd_permissions(args: argparse.Namespace) -> None:
    cmd = dispatch_and_wait(args.device, "permissions", {}, 90)
    if cmd["status"] != "done":
        sys.exit(f"[{cmd['status']}] {cmd.get('error')}")
    for name, info in cmd["result"].items():
        mark = {True: "OK   ", False: "FEHLT", None: "--   "}[info.get("ok")]
        detail = info.get("hinweis")
        if detail is None:
            detail = info.get("wert")
        print(f"{mark} {name:<28} {detail if detail is not None else ''}")


def cmd_revoke(args: argparse.Namespace) -> None:
    print(json.dumps(call("POST", f"/v1/devices/{args.device}/revoke"), ensure_ascii=False))


def cmd_mode(args: argparse.Namespace) -> None:
    out = call("PATCH", f"/v1/devices/{args.device}", {"mode": args.mode})
    print(f"{out['id']}: Modus jetzt '{out['mode']}'")


def cmd_killswitch(args: argparse.Namespace) -> None:
    print(json.dumps(call("POST", f"/v1/killswitch/{args.state}"), ensure_ascii=False))


def cmd_audit(args: argparse.Namespace) -> None:
    path = f"/v1/audit?limit={args.limit}"
    if args.device:
        path += f"&device_id={args.device}"
    for e in call("GET", path)["entries"]:
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(e["ts"]))
        print(f"{ts}  {e['actor']:<22} {e['action']:<20} {e.get('device_id') or '-':<16} "
              f"{json.dumps(e['detail'], ensure_ascii=False)}")


def main() -> None:
    p = argparse.ArgumentParser(prog="skconnect", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("devices", help="Geraete auflisten")
    d.add_argument("--all", action="store_true", help="auch widerrufene")
    d.set_defaults(func=cmd_devices)

    a = sub.add_parser("add", help="Geraet anlegen und Enrollment-Code ausgeben")
    a.add_argument("device_id")
    a.add_argument("label")
    a.add_argument("platform", choices=["macos", "linux", "ios", "ipados"])
    a.add_argument("--owner", default="simon")
    a.add_argument("--mode", default="readonly", choices=["notify", "readonly", "full"])
    a.add_argument("--caps", default="", help="Komma-Liste: shell,fs,notify,probe,shortcut")
    a.add_argument("--allowlist", default="", help="erlaubte Binaries (leer = alle ausser Deny-Liste)")
    a.add_argument("--push-url", default="", dest="push_url")
    a.add_argument("--ttl", type=int, default=1800)
    a.set_defaults(func=cmd_add)

    r = sub.add_parser("run", help="Shell-Kommando ausfuehren")
    r.add_argument("device")
    r.add_argument("command")
    r.add_argument("--timeout", type=int, default=120)
    r.set_defaults(func=cmd_run)

    n = sub.add_parser("notify", help="Mitteilung schicken")
    n.add_argument("device")
    n.add_argument("title")
    n.add_argument("message")
    n.set_defaults(func=cmd_notify)

    pr = sub.add_parser("probe", help="Systemfakten live abfragen")
    pr.add_argument("device")
    pr.set_defaults(func=cmd_probe)

    pm = sub.add_parser("permissions", help="macOS-Freigaben eines Macs pruefen")
    pm.add_argument("device")
    pm.set_defaults(func=cmd_permissions)

    rv = sub.add_parser("revoke", help="Geraet sofort abklemmen")
    rv.add_argument("device")
    rv.set_defaults(func=cmd_revoke)

    m = sub.add_parser("mode", help="Berechtigungsstufe aendern")
    m.add_argument("device")
    m.add_argument("mode", choices=["notify", "readonly", "full"])
    m.set_defaults(func=cmd_mode)

    k = sub.add_parser("killswitch", help="Not-Aus fuer alle Geraete")
    k.add_argument("state", choices=["on", "off"])
    k.set_defaults(func=cmd_killswitch)

    au = sub.add_parser("audit", help="Audit-Log anzeigen")
    au.add_argument("--limit", type=int, default=50)
    au.add_argument("--device", default="")
    au.set_defaults(func=cmd_audit)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
