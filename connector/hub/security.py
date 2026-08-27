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

#: Welche Kommandoarten sind in welchem Modus erlaubt?
MODE_KINDS: dict[str, frozenset[str]] = {
    "notify": frozenset({"notify"}),
    "readonly": frozenset({"notify", "shortcut", "fs.list", "fs.read", "probe"}),
    "full": frozenset(
        {
            "notify",
            "shortcut",
            "fs.list",
            "fs.read",
            "fs.write",
            "shell",
            "claude",
            "probe",
        }
    ),
}

#: Welche Kommandoarten setzen welche Geraetefaehigkeit voraus?
KIND_CAPABILITY: dict[str, str] = {
    "notify": "notify",
    "shortcut": "shortcut",
    "fs.list": "fs",
    "fs.read": "fs",
    "fs.write": "fs",
    "shell": "shell",
    "claude": "claude",
    "probe": "probe",
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
    return PolicyResult(True)
