"""Token-, Policy- und Signatur-Helfer fuer den Connector-Hub.

Grundsaetze:
  * Tokens werden NIE im Klartext gespeichert - nur als SHA-256-Hash.
  * Jedes Geraet hat einen Modus (notify | readonly | full), der bestimmt,
    welche Kommandoarten es ueberhaupt annehmen darf.
  * Shell-Kommandos laufen zusaetzlich gegen eine Deny-Liste, die
    katastrophale Operationen blockt, bevor sie das Geraet erreichen.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass

TOKEN_PREFIX_DEVICE = "skc_dev_"
TOKEN_PREFIX_CONTROL = "skc_ctl_"
TOKEN_PREFIX_ENROLL = "skc_enr_"


def new_token(prefix: str) -> str:
    """Erzeugt ein Token mit 256 Bit Entropie."""
    return prefix + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def token_matches(token: str, stored_hash: str) -> bool:
    return hmac.compare_digest(hash_token(token), stored_hash)


# ---------------------------------------------------------------------------
# Geraetemodi und Faehigkeiten
# ---------------------------------------------------------------------------

MODES = ("notify", "readonly", "full")

#: Welche Kommandoarten setzen welche Geraetefaehigkeit voraus?
#:
#: 'mail.send' ist bewusst eine eigene Faehigkeit und nicht Teil von 'mail':
#: Mails lesen und Mails verschicken sind zwei verschiedene Vertrauensfragen.
#: Der Agent meldet sie nur, wenn sie beim Installieren ausdruecklich
#: freigeschaltet wurde.
KIND_CAPABILITY: dict[str, str] = {
    "notify": "notify",
    "shortcut": "shortcut",
    "probe": "probe",
    "permissions": "probe",
    "fs.list": "fs",
    "fs.read": "fs",
    "fs.write": "fs",
    "shell": "shell",
    "claude": "claude",
    # Browser (macOS, ueber AppleScript)
    "browser.tabs": "browser",
    "browser.read": "browser",
    "browser.open": "browser",
    "browser.js": "browser",
    "browser.close": "browser",
    # Beliebige Programme (macOS, ueber AppleScript)
    "app.list": "app",
    "app.launch": "app",
    "app.quit": "app",
    "app.applescript": "app",
    # Mail.app (macOS, ueber AppleScript)
    "mail.accounts": "mail",
    "mail.mailboxes": "mail",
    "mail.list": "mail",
    "mail.search": "mail",
    "mail.read": "mail",
    "mail.draft": "mail",
    "mail.send": "mail.send",
}

#: Nur beobachtend - aendert auf dem Geraet nichts.
_READONLY_KINDS = frozenset({
    "notify", "shortcut", "probe", "permissions",
    "fs.list", "fs.read",
    "app.list",
    "browser.tabs", "browser.read",
    "mail.accounts", "mail.mailboxes", "mail.list", "mail.search", "mail.read",
})

#: Welche Kommandoarten sind in welchem Modus erlaubt?
MODE_KINDS: dict[str, frozenset[str]] = {
    "notify": frozenset({"notify"}),
    "readonly": _READONLY_KINDS,
    "full": frozenset(KIND_CAPABILITY),
}

ALL_KINDS = frozenset(KIND_CAPABILITY)


# ---------------------------------------------------------------------------
# Shell-Policy
# ---------------------------------------------------------------------------

#: Muster, die auch im Modus "full" nie ausgefuehrt werden. Bewusst kurz
#: gehalten - eine Deny-Liste ist kein Sandbox-Ersatz, sondern eine
#: Stolperdraht gegen Unfaelle (Tippfehler, halluzinierte Pfade).
DENY_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-fr\b", "rekursives rm -rf"),
    (r"\bmkfs(\.[a-z0-9]+)?\b", "Dateisystem formatieren"),
    (r"\bdd\s+[^|;&]*\bof=/dev/(disk|sd|nvme|rdisk)", "dd auf Blockgeraet"),
    (r">\s*/dev/(disk|sd|nvme|rdisk)\w*", "Schreiben auf Blockgeraet"),
    (r"\bdiskutil\s+(erase|reformat|zeroDisk|secureErase)", "diskutil erase"),
    (r"\b(shutdown|halt|reboot)\b", "Herunterfahren/Neustart"),
    (r"\bcsrutil\s+disable\b", "SIP deaktivieren"),
    (r"\bspctl\s+--master-disable\b", "Gatekeeper deaktivieren"),
    (r":\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:", "Fork-Bomb"),
    (r"\bchmod\s+(-[a-zA-Z]+\s+)*777\s+/(\s|$)", "chmod 777 auf /"),
    (r"\bchown\s+(-[a-zA-Z]+\s+)*[^\s]+\s+/(\s|$)", "chown auf /"),
    (r"\bhistory\s+-c\b|\bshred\b|\bsrm\b", "Spurenverwischung"),
    (r"/etc/(sudoers|shadow|passwd)\b\s*$|>\s*/etc/(sudoers|shadow|passwd)", "Auth-Dateien schreiben"),
    (r"\bkeychain\b.*\bdump\b|\bsecurity\s+dump-keychain\b", "Keychain-Dump"),
)

_COMPILED_DENY = tuple((re.compile(p, re.IGNORECASE), why) for p, why in DENY_PATTERNS)


@dataclass(frozen=True)
class PolicyResult:
    allowed: bool
    reason: str = ""


def check_shell(command: str, allowlist: list[str] | None = None) -> PolicyResult:
    """Prueft ein Shell-Kommando gegen Deny-Liste und optionale Allowlist."""
    stripped = command.strip()
    if not stripped:
        return PolicyResult(False, "leeres Kommando")
    if len(stripped) > 8000:
        return PolicyResult(False, "Kommando laenger als 8000 Zeichen")

    for pattern, why in _COMPILED_DENY:
        if pattern.search(stripped):
            return PolicyResult(False, f"von der Deny-Liste blockiert ({why})")

    if allowlist:
        # Allowlist greift auf das erste Wort der ersten Anweisung.
        first = re.split(r"[\s|;&]+", stripped, maxsplit=1)[0]
        binary = first.rsplit("/", 1)[-1]
        if binary not in allowlist:
            return PolicyResult(
                False, f"'{binary}' steht nicht auf der Allowlist dieses Geraets"
            )
    return PolicyResult(True)


def check_command(
    kind: str,
    mode: str,
    capabilities: list[str],
    payload: dict,
    allowlist: list[str] | None = None,
) -> PolicyResult:
    """Zentrale Zulaessigkeitspruefung fuer ein Kommando."""
    if kind not in ALL_KINDS:
        return PolicyResult(False, f"unbekannte Kommandoart '{kind}'")
    if mode not in MODES:
        return PolicyResult(False, f"unbekannter Geraetemodus '{mode}'")
    if kind not in MODE_KINDS[mode]:
        return PolicyResult(
            False, f"Modus '{mode}' erlaubt keine Kommandoart '{kind}'"
        )
    needed = KIND_CAPABILITY[kind]
    if needed not in capabilities:
        return PolicyResult(
            False, f"Geraet meldet die Faehigkeit '{needed}' nicht"
        )
    if kind == "shell":
        return check_shell(str(payload.get("command", "")), allowlist)
    if kind in ("fs.read", "fs.write", "fs.list"):
        path = str(payload.get("path", ""))
        if not path:
            return PolicyResult(False, "'path' fehlt")
        if "\x00" in path:
            return PolicyResult(False, "ungueltiger Pfad")
    if kind.startswith("browser."):
        return _check_browser(kind, payload)
    if kind.startswith("mail."):
        return _check_mail(kind, payload)
    if kind.startswith("app."):
        return _check_app(kind, payload)
    return PolicyResult(True)


def _check_app(kind: str, payload: dict) -> PolicyResult:
    """Programmsteuerung: der Name wandert in ein AppleScript, der Text nicht."""
    if kind in ("app.launch", "app.quit"):
        name = str(payload.get("name", "")).strip()
        if not name:
            return PolicyResult(False, "'name' fehlt")
        if len(name) > 100 or any(c in name for c in '"\\\n\r\x00'):
            return PolicyResult(False, f"ungueltiger Programmname '{name}'")
    if kind == "app.applescript":
        script = str(payload.get("script", ""))
        if not script.strip():
            return PolicyResult(False, "'script' fehlt")
        if len(script) > 20000:
            return PolicyResult(False, "Skript laenger als 20000 Zeichen")
        # Ein AppleScript kann per 'do shell script' die Shell-Deny-Liste
        # umgehen. Deshalb laeuft der eingebettete Teil durch dieselbe Pruefung.
        for shell_part in re.findall(r'do shell script\s+"((?:[^"\\]|\\.)*)"', script):
            verdict = check_shell(shell_part.replace('\\"', '"'))
            if not verdict.allowed:
                return PolicyResult(
                    False, f"'do shell script' im AppleScript: {verdict.reason}")
    return PolicyResult(True)


#: Browser, die der Agent ansprechen kann. Alles andere wird abgelehnt, damit
#: kein beliebiger Anwendungsname in ein AppleScript wandert.
BROWSERS = ("Safari", "Google Chrome", "Brave Browser", "Microsoft Edge", "Arc")

_ALLOWED_SCHEMES = ("http://", "https://", "file://", "about:blank")


def _check_browser(kind: str, payload: dict) -> PolicyResult:
    app = str(payload.get("app", "Safari"))
    if app not in BROWSERS:
        return PolicyResult(False, f"unbekannter Browser '{app}' (erlaubt: {', '.join(BROWSERS)})")
    if kind == "browser.open":
        url = str(payload.get("url", "")).strip()
        if not url:
            return PolicyResult(False, "'url' fehlt")
        if not url.lower().startswith(_ALLOWED_SCHEMES):
            return PolicyResult(False, "nur http(s)-, file:- und about:blank-URLs")
        if any(c in url for c in "\"\\\n\r"):
            return PolicyResult(False, "URL enthaelt unzulaessige Zeichen")
    if kind == "browser.js":
        script = str(payload.get("script", ""))
        if not script.strip():
            return PolicyResult(False, "'script' fehlt")
        if len(script) > 20000:
            return PolicyResult(False, "Skript laenger als 20000 Zeichen")
    return PolicyResult(True)


def _check_mail(kind: str, payload: dict) -> PolicyResult:
    if kind in ("mail.send", "mail.draft"):
        recipients = payload.get("to") or []
        if isinstance(recipients, str):
            recipients = [recipients]
        if not recipients:
            return PolicyResult(False, "'to' fehlt")
        if len(recipients) > 20:
            return PolicyResult(False, "hoechstens 20 Empfaenger")
        for address in recipients:
            if "@" not in str(address) or any(c in str(address) for c in "\"\\\n\r"):
                return PolicyResult(False, f"ungueltige Adresse '{address}'")
        if len(str(payload.get("body", ""))) > 100000:
            return PolicyResult(False, "Text laenger als 100000 Zeichen")
    if kind == "mail.read":
        if not str(payload.get("id", "")).strip():
            return PolicyResult(False, "'id' fehlt")
    if kind == "mail.search":
        if not str(payload.get("query", "")).strip():
            return PolicyResult(False, "'query' fehlt")
    return PolicyResult(True)
