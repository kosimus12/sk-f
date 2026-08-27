"""Sofort-Zustellung von Mitteilungen an Geraete, die nicht pollen koennen.

Ein iPhone kann im gesperrten Zustand keinen Agenten laufen lassen - eine
Push-Mitteilung erreicht es trotzdem, weil Apple sie ueber APNs zustellt.
Der Hub schickt sie deshalb nicht in die Kommando-Queue, sondern direkt an
eine Push-URL (ntfy, Pushcut oder Pushover).

Empfehlung: ntfy auf demselben Hetzner-Server. Dann verlaesst die Mitteilung
die eigene Infrastruktur nur noch als APNs-Payload.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

TIMEOUT = 15


def deliver(push_url: str, title: str, message: str, url: str = "",
            priority: str = "default") -> dict[str, Any]:
    """Stellt eine Mitteilung ueber die konfigurierte Push-URL zu.

    Das Format wird am Ziel erkannt:
      * ntfy    - https://ntfy.example.de/mein-topic
      * Pushcut - https://api.pushcut.io/<secret>/notifications/<name>
      * sonst   - generischer JSON-POST mit {title, message, url}
    """
    if "pushcut.io" in push_url:
        body: dict[str, Any] = {"title": title, "text": message}
        if url:
            body["input"] = url
        headers = {"Content-Type": "application/json"}
        data = json.dumps(body).encode("utf-8")
    elif "/ntfy" in push_url or _looks_like_ntfy(push_url):
        headers = {
            "Title": _header_safe(title),
            "Priority": {"low": "2", "default": "3", "high": "5"}.get(priority, "3"),
        }
        if url:
            headers["Click"] = url
        data = message.encode("utf-8")
    else:
        headers = {"Content-Type": "application/json"}
        data = json.dumps({"title": title, "message": message, "url": url}).encode("utf-8")

    req = urllib.request.Request(push_url, data=data, method="POST")
    for key, value in headers.items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return {"delivered": True, "status": resp.status, "via": _kind(push_url)}
    except urllib.error.HTTPError as exc:
        return {"delivered": False, "status": exc.code,
                "error": exc.read().decode("utf-8", "replace")[:500]}
    except urllib.error.URLError as exc:
        return {"delivered": False, "error": f"Push-Dienst nicht erreichbar: {exc.reason}"}


def _looks_like_ntfy(url: str) -> bool:
    # ntfy-Topics sind der letzte Pfadteil einer flachen URL: https://host/topic
    parts = url.split("://", 1)[-1].split("/")
    return len(parts) == 2 and bool(parts[1])


def _kind(url: str) -> str:
    if "pushcut.io" in url:
        return "pushcut"
    if _looks_like_ntfy(url) or "/ntfy" in url:
        return "ntfy"
    return "webhook"


def _header_safe(value: str) -> str:
    """Macht einen Text als HTTP-Header-Wert unschaedlich.

    Zwei Dinge: HTTP-Header duerfen nur ASCII enthalten (Umlaute umschreiben),
    und Zeilenumbrueche muessen raus. Ein Titel mit CR/LF koennte sonst
    zusaetzliche Header einschleusen - Pythons http.client faengt das zwar mit
    einem ValueError ab, aber dann scheitert die Zustellung still statt sauber.
    """
    replacements = {"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe",
                    "Ü": "Ue", "ß": "ss"}
    for src, dst in replacements.items():
        value = value.replace(src, dst)
    # Alle Steuerzeichen inklusive CR/LF und Tab durch Leerzeichen ersetzen.
    value = "".join(" " if ord(c) < 32 or ord(c) == 127 else c for c in value)
    return value.encode("ascii", "replace").decode("ascii")[:200]
