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
import pathlib
import sys
import time
import urllib.error
import urllib.request

HUB_ENV = "/etc/skconnector/hub.env"


def aus_hub_env() -> tuple[str, str]:
    """Auf dem Hetzner steht alles Noetige schon in hub.env.

    Wer sich per ssh anmeldet, hat eine frische Shell ohne die Variablen und
    muss sie sonst jedes Mal von Hand exportieren - eine Zeile, die dabei zu
    leicht mit dem Token statt mit dem Muster gefuellt wird.
    """
    try:
        with open(HUB_ENV, encoding="utf-8") as f:
            inhalt = f.read()
    except OSError:
        return "", ""
    werte = {}
    for zeile in inhalt.splitlines():
        zeile = zeile.strip()
        if zeile and not zeile.startswith("#") and "=" in zeile:
            name, wert = zeile.split("=", 1)
            werte[name.strip()] = wert.strip()
    token = werte.get("CONNECTOR_CONTROL_TOKEN", "")
    bind = werte.get("CONNECTOR_BIND", "127.0.0.1")
    port = werte.get("CONNECTOR_PORT", "8787")
    if bind in ("0.0.0.0", "*", ""):
        bind = "127.0.0.1"
    return (f"http://{bind}:{port}" if token else ""), token


HUB = os.environ.get("CONNECTOR_HUB_URL", "").rstrip("/")
TOKEN = os.environ.get("CONNECTOR_CONTROL_TOKEN", "")
if not HUB or not TOKEN:
    _hub, _token = aus_hub_env()
    HUB = HUB or _hub
    TOKEN = TOKEN or _token


def call(method: str, path: str, body: dict | None = None, timeout: int = 60) -> dict:
    if not HUB or not TOKEN:
        sys.exit(
            "CONNECTOR_HUB_URL und CONNECTOR_CONTROL_TOKEN muessen gesetzt sein "
            f"(oder {HUB_ENV} lesbar - dann genuegt sudo)."
        )
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
    if args.platform == "macos":
        # setup-mac.sh statt install.sh: es setzt zusaetzlich die
        # Energieeinstellungen fuer den zugeklappten Betrieb und loest die
        # macOS-Freigabedialoge aus. OHNE sudo - es ruft sudo selbst auf, wo
        # noetig; mit sudo davor erscheinen die Dialoge im falschen
        # Benutzerkontext und damit gar nicht.
        print("Auf dem Mac ausfuehren - OHNE sudo, in der grafischen Sitzung:")
        print(f"  bash agent/macos/setup-mac.sh --hub {HUB} \\")
        print(f"       --code {out['enrollment_code']}")
    elif args.platform == "linux":
        print("Auf dem Geraet ausfuehren:")
        print(f"  sudo bash agent/linux/install.sh --hub {HUB} \\")
        print(f"       --code {out['enrollment_code']}")


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


def token_ziel(label: str, explizit: str) -> pathlib.Path:
    """Wohin das Token geschrieben wird, wenn es nicht angezeigt werden soll."""
    if explizit:
        return pathlib.Path(explizit).expanduser()
    for basis in ("/etc/skconnector/tokens", "~/.skconnector"):
        ordner = pathlib.Path(basis).expanduser()
        try:
            ordner.mkdir(parents=True, exist_ok=True)
            os.chmod(ordner, 0o700)
            return ordner / f"{label}.token"
        except OSError:
            continue
    return pathlib.Path(f"{label}.token")


def cmd_token_issue(args: argparse.Namespace) -> None:
    out = call("POST", "/v1/control-tokens", {
        "label": args.label, "ceiling": args.ceiling,
        "devices": [d for d in args.devices.split(",") if d],
    })
    print(f"Token '{out['label']}' ausgestellt (Obergrenze: {out['ceiling']}"
          + (f", nur {', '.join(out['devices'])}" if out["devices"] else "") + ")")
    print()

    if args.show:
        print("Einmalig angezeigt - jetzt kopieren:")
        print("  " + out["token"])
        return

    # Standardmaessig NICHT anzeigen. Terminal-Ausgabe landet zu leicht in
    # einem Chat oder Screenshot, und dieses Token ist ein Passwort. Es geht
    # in eine Datei, die nur der Besitzer lesen darf.
    ziel = token_ziel(args.label, args.out)
    fd = os.open(str(ziel), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(out["token"] + "\n")
    os.chmod(ziel, 0o600)

    print(f"Token geschrieben nach {ziel} (0600), {len(out['token'])} Zeichen,")
    print(f"beginnt mit {out['token'][:12]}...")
    print()
    print("In die Zwischenablage, ohne es ins Terminal zu drucken:")
    print(f"    pbcopy < {ziel}                 # macOS")
    print(f"    xclip -selection clipboard < {ziel}   # Linux mit X")
    print()
    print("Mit --show wird es stattdessen angezeigt. Dann aber die Ausgabe")
    print("nicht in einen Chat kopieren - wer das Token hat, hat den Zugriff.")


def cmd_token_list(args: argparse.Namespace) -> None:
    for t in call("GET", "/v1/control-tokens")["tokens"]:
        stand = "widerrufen" if t["revoked_at"] else "aktiv"
        zuletzt = (time.strftime("%Y-%m-%d %H:%M", time.localtime(t["last_used"]))
                   if t["last_used"] else "nie")
        geraete = ",".join(t["devices"]) or "alle"
        print(f"{t['label']:<20} {stand:<12} {t['ceiling']:<10} "
              f"Geraete={geraete:<24} zuletzt={zuletzt}")


def cmd_token_revoke(args: argparse.Namespace) -> None:
    print(json.dumps(call("DELETE", f"/v1/control-tokens/{args.label}"), ensure_ascii=False))


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

    ti = sub.add_parser("token-issue", help="abgestuftes Control-Token ausstellen")
    ti.add_argument("label", help="z.B. chat, cowork")
    ti.add_argument("--ceiling", default="readonly",
                    choices=["notify", "readonly", "full"],
                    help="Obergrenze - hoechstens das darf dieses Token")
    ti.add_argument("--devices", default="",
                    help="Komma-Liste; leer = alle Geraete")
    ti.add_argument("--out", default="",
                    help="Datei fuer das Token (Vorgabe: /etc/skconnector/tokens/<label>.token)")
    ti.add_argument("--show", action="store_true",
                    help="Token im Terminal anzeigen statt in eine Datei zu schreiben")
    ti.set_defaults(func=cmd_token_issue)

    tl = sub.add_parser("token-list", help="ausgestellte Control-Tokens anzeigen")
    tl.set_defaults(func=cmd_token_list)

    tr = sub.add_parser("token-revoke", help="Control-Token widerrufen")
    tr.add_argument("label")
    tr.set_defaults(func=cmd_token_revoke)

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
