"""TOTP nach RFC 6238 - die zweite Schranke vor den Geraeten.

Warum ueberhaupt: Ein Control-Token liegt in einer Connector-Konfiguration
oder in Umgebungsvariablen. Wer den Claude-Account uebernimmt, hat es damit
auch. Ein zeitbasierter Code aus einer Authenticator-App liegt dagegen auf
einem Telefon, das der Angreifer nicht hat.

Nur Standardbibliothek: hmac, hashlib, base64, struct. Ein TOTP ist ein
HMAC ueber den Zeitschritt, mehr nicht - eine Abhaengigkeit dafuer waere
Ballast.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import struct
import urllib.parse

SCHRITT = 30          # Sekunden je Zeitfenster
STELLEN = 6
TOLERANZ = 1          # ein Fenster vor und zurueck, gegen schiefe Uhren

_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


def neues_geheimnis(bytes_: int = 20) -> str:
    """Base32 ohne Fuellzeichen - so wollen es die Authenticator-Apps."""
    roh = os.urandom(bytes_)
    return base64.b32encode(roh).decode("ascii").rstrip("=")


def _entschluessle(geheimnis: str) -> bytes:
    sauber = geheimnis.strip().replace(" ", "").upper()
    if not sauber or any(c not in _ALPHABET for c in sauber):
        raise ValueError("Geheimnis ist kein gueltiges Base32")
    fehlend = (-len(sauber)) % 8
    return base64.b32decode(sauber + "=" * fehlend)


def code_fuer(geheimnis: str, zaehler: int) -> str:
    """HOTP - TOTP ist HOTP mit der Zeit als Zaehler."""
    schluessel = _entschluessle(geheimnis)
    mac = hmac.new(schluessel, struct.pack(">Q", zaehler), hashlib.sha1).digest()
    versatz = mac[-1] & 0x0F
    ausschnitt = struct.unpack(">I", mac[versatz:versatz + 4])[0] & 0x7FFFFFFF
    return str(ausschnitt % (10 ** STELLEN)).zfill(STELLEN)


def zaehler_fuer(zeit: float) -> int:
    return int(zeit // SCHRITT)


def pruefe(geheimnis: str, eingabe: str, jetzt: float,
           zuletzt_benutzt: int | None = None) -> int | None:
    """Gibt den akzeptierten Zeitschritt zurueck, sonst None.

    'zuletzt_benutzt' verhindert die Wiederverwendung: Ein Code, der einmal
    gegolten hat, gilt kein zweites Mal - sonst reicht es, ihn einmal
    mitzulesen, und er bleibt bis zu 90 Sekunden lang gueltig.
    """
    ziffern = "".join(c for c in eingabe if c.isdigit())
    if len(ziffern) != STELLEN:
        return None
    jetzt_zaehler = zaehler_fuer(jetzt)
    for versatz in range(-TOLERANZ, TOLERANZ + 1):
        kandidat = jetzt_zaehler + versatz
        if zuletzt_benutzt is not None and kandidat <= zuletzt_benutzt:
            continue
        if hmac.compare_digest(code_fuer(geheimnis, kandidat), ziffern):
            return kandidat
    return None


def otpauth_uri(geheimnis: str, konto: str, herausgeber: str) -> str:
    """Der String hinter dem QR-Code in Google Authenticator und 1Password."""
    label = urllib.parse.quote(f"{herausgeber}:{konto}", safe="")
    parameter = urllib.parse.urlencode({
        "secret": geheimnis,
        "issuer": herausgeber,
        "algorithm": "SHA1",
        "digits": STELLEN,
        "period": SCHRITT,
    })
    return f"otpauth://totp/{label}?{parameter}"


def qr_ascii(text: str) -> str | None:
    """QR-Code fuers Terminal - wenn 'qrencode' da ist, sonst None."""
    import shutil
    import subprocess
    if not shutil.which("qrencode"):
        return None
    try:
        return subprocess.run(
            ["qrencode", "-t", "ANSIUTF8", text],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return None


def neue_notfallcodes(anzahl: int = 8) -> list[str]:
    """Einmalcodes fuer den Fall, dass das Telefon weg ist."""
    return ["-".join(secrets.token_hex(2) for _ in range(3)) for _ in range(anzahl)]
