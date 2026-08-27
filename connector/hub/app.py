"""Connector-Hub - laeuft auf dem Hetzner-Server.

Der Hub ist die einzige Komponente mit oeffentlicher Adresse. Alle Geraete
verbinden sich AUSGEHEND zu ihm (Long-Poll), niemand muss Ports oeffnen oder
hinter NAT/Carrier-Grade-NAT erreichbar sein.

    Claude  --(MCP)-->  Hub (Hetzner)  <--(Long-Poll)--  Mac / Linux / iOS

Zwei Authentifizierungsebenen:
  * Control-Token  - fuer die Steuerseite (MCP-Server, CLI)
  * Device-Token   - je Geraet, beim Enrollment vergeben, jederzeit widerrufbar
"""

from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import push, security
from .store import Store

DB_PATH = os.environ.get("CONNECTOR_DB", "/var/lib/skconnector/hub.db")
CONTROL_TOKEN = os.environ.get("CONNECTOR_CONTROL_TOKEN", "")
MAX_POLL_SECONDS = int(os.environ.get("CONNECTOR_POLL_SECONDS", "25"))
RETENTION_DAYS = int(os.environ.get("CONNECTOR_RETENTION_DAYS", "30"))

store = Store(DB_PATH)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    janitor = asyncio.create_task(_janitor())
    try:
        yield
    finally:
        janitor.cancel()


app = FastAPI(title="SK Connector Hub", version="1.0.0", docs_url=None,
              redoc_url=None, lifespan=lifespan)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Bearer-Token fehlt")
    return authorization.split(" ", 1)[1].strip()


def require_control(authorization: str | None = Header(default=None)) -> str:
    token = _bearer(authorization)
    if not CONTROL_TOKEN:
        raise HTTPException(503, "Hub ist nicht konfiguriert (CONNECTOR_CONTROL_TOKEN fehlt)")
    if not security.hmac.compare_digest(token, CONTROL_TOKEN):
        raise HTTPException(403, "ungueltiges Control-Token")
    return "control"


def require_device(authorization: str | None = Header(default=None)) -> dict:
    token = _bearer(authorization)
    device = store.device_by_token(token)
    if device is None:
        raise HTTPException(403, "ungueltiges oder widerrufenes Geraete-Token")
    return device


def killswitch_active() -> bool:
    return store.get_setting("killswitch", "off") == "on"


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class EnrollRequest(BaseModel):
    device_id: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    label: str = Field(min_length=1, max_length=120)
    platform: Literal["macos", "linux", "ios", "ipados"]
    owner: str = Field(default="simon", max_length=64)
    mode: Literal["notify", "readonly", "full"] = "readonly"
    capabilities: list[str] = []
    allowlist: list[str] = []
    push_url: str | None = None
    ttl_s: int = Field(default=1800, ge=60, le=86400)


class RegisterRequest(BaseModel):
    code: str
    capabilities: list[str] = []
    facts: dict[str, Any] = {}


class HeartbeatRequest(BaseModel):
    facts: dict[str, Any] = {}


class ResultRequest(BaseModel):
    command_id: str
    result: dict[str, Any] | None = None
    error: str | None = None


class CommandRequest(BaseModel):
    kind: str
    payload: dict[str, Any] = {}
    timeout_s: int = Field(default=120, ge=5, le=3600)


class DeviceUpdate(BaseModel):
    mode: Literal["notify", "readonly", "full"] | None = None
    label: str | None = None
    allowlist: list[str] | None = None
    push_url: str | None = None


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "ts": time.time(), "killswitch": killswitch_active()}


# ---------------------------------------------------------------------------
# Steuerseite (Control-Token)
# ---------------------------------------------------------------------------

@app.post("/v1/devices")
def create_device(req: EnrollRequest, actor: str = Depends(require_control)) -> dict:
    """Legt ein Geraet an (oder aktualisiert es) und gibt einen Enrollment-Code aus."""
    unknown = set(req.capabilities) - set(security.KIND_CAPABILITY.values())
    if unknown:
        raise HTTPException(400, f"unbekannte Faehigkeiten: {sorted(unknown)}")
    if req.push_url:
        verdict = security.check_push_url(req.push_url)
        if not verdict.allowed:
            raise HTTPException(400, f"Push-URL abgelehnt: {verdict.reason}")
    existing = store.get_device(req.device_id)
    if existing is None:
        store.create_device(
            req.device_id, req.label, req.platform, req.owner, req.mode,
            req.capabilities, req.allowlist, req.push_url,
        )
    else:
        fields: dict[str, Any] = dict(
            label=req.label, platform=req.platform, owner=req.owner, mode=req.mode,
            capabilities=req.capabilities, allowlist=req.allowlist,
        )
        if req.push_url is not None:
            fields["push_url"] = req.push_url
        store.update_device(req.device_id, **fields)
    code = store.create_enrollment(req.device_id, req.ttl_s)
    store.audit(actor, "device.enroll_code", req.device_id, mode=req.mode, owner=req.owner)
    return {
        "device": store.get_device(req.device_id),
        "enrollment_code": code,
        "expires_in_s": req.ttl_s,
    }


@app.get("/v1/devices")
def list_devices(include_revoked: bool = False, actor: str = Depends(require_control)) -> dict:
    return {"devices": store.list_devices(include_revoked)}


@app.get("/v1/devices/{device_id}")
def get_device(device_id: str, actor: str = Depends(require_control)) -> dict:
    device = store.get_device(device_id)
    if device is None:
        raise HTTPException(404, "unbekanntes Geraet")
    return device


@app.patch("/v1/devices/{device_id}")
def patch_device(device_id: str, req: DeviceUpdate, actor: str = Depends(require_control)) -> dict:
    if store.get_device(device_id) is None:
        raise HTTPException(404, "unbekanntes Geraet")
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    if fields.get("push_url"):
        verdict = security.check_push_url(str(fields["push_url"]))
        if not verdict.allowed:
            raise HTTPException(400, f"Push-URL abgelehnt: {verdict.reason}")
    device = store.update_device(device_id, **fields)
    # Die Push-URL ist ein Geheimnis - Pushcut-URLs enthalten den API-Key.
    # Ins Log gehoert nur, DASS sie geaendert wurde, nicht worauf.
    protokoll = {k: ("<gesetzt>" if k == "push_url" else v) for k, v in fields.items()}
    store.audit(actor, "device.update", device_id, **protokoll)
    return device  # type: ignore[return-value]


@app.post("/v1/devices/{device_id}/revoke")
def revoke_device(device_id: str, actor: str = Depends(require_control)) -> dict:
    if store.get_device(device_id) is None:
        raise HTTPException(404, "unbekanntes Geraet")
    store.revoke_device(device_id)
    store.audit(actor, "device.revoke", device_id)
    return {"revoked": device_id}


@app.post("/v1/devices/{device_id}/commands")
def issue_command(device_id: str, req: CommandRequest, actor: str = Depends(require_control)) -> dict:
    if killswitch_active():
        raise HTTPException(423, "Kill-Switch ist aktiv - der Hub nimmt keine Kommandos an")
    device = store.get_device(device_id)
    if device is None:
        raise HTTPException(404, "unbekanntes Geraet")
    if device["revoked_at"]:
        raise HTTPException(403, "Geraet ist widerrufen")
    # Policy zuerst: ob ein Geraet enrolled ist, aendert nichts daran, dass ein
    # unzulaessiges Kommando unzulaessig ist - und die Ablehnung gehoert ins Log.
    verdict = security.check_command(
        req.kind, device["mode"], device["capabilities"], req.payload, device["allowlist"]
    )
    if not verdict.allowed:
        store.audit(actor, "command.denied", device_id, kind=req.kind, reason=verdict.reason)
        raise HTTPException(403, f"Kommando abgelehnt: {verdict.reason}")

    # Reine Push-Ziele (iPhone ohne Kurzbefehl-Agent) haben kein Geraete-Token
    # und muessen sich nie enrollen - fuer sie ist 'notify' trotzdem moeglich.
    push_only = req.kind == "notify" and device["push_configured"]
    if not device["enrolled"] and not push_only:
        raise HTTPException(
            409, "Geraet ist noch nicht enrolled (Enrollment-Code einloesen)"
        )

    cmd = store.enqueue(device_id, req.kind, req.payload, req.timeout_s, issued_by=actor)
    store.audit(actor, "command.issued", device_id, kind=req.kind, command_id=cmd["id"])

    # Mitteilungen gehen nicht in die Poll-Queue, sobald eine Push-URL
    # hinterlegt ist: Push erreicht iPhone und iPad auch im gesperrten
    # Zustand, waehrend ein Poll erst beim naechsten Aufwachen passiert.
    if req.kind == "notify":
        push_url = store.get_push_url(device_id)
        if push_url:
            outcome = push.deliver(
                push_url,
                title=str(req.payload.get("title", "Claude")),
                message=str(req.payload.get("message", "")),
                url=str(req.payload.get("url", "")),
                priority=str(req.payload.get("priority", "default")),
            )
            delivered = bool(outcome.get("delivered"))
            store.force_complete(
                cmd["id"],
                result=outcome if delivered else None,
                error=None if delivered else str(outcome.get("error", "Push fehlgeschlagen")),
            )
            store.audit(actor, "notify.pushed", device_id, command_id=cmd["id"],
                        via=outcome.get("via"), delivered=delivered)
            return store.get_command(cmd["id"])  # type: ignore[return-value]
    return cmd


@app.get("/v1/commands/{command_id}")
def get_command(command_id: str, actor: str = Depends(require_control)) -> dict:
    store.expire_stale()
    cmd = store.get_command(command_id)
    if cmd is None:
        raise HTTPException(404, "unbekanntes Kommando")
    return cmd


@app.get("/v1/commands")
def list_commands(device_id: str | None = None, limit: int = 50,
                  actor: str = Depends(require_control)) -> dict:
    store.expire_stale()
    return {"commands": store.list_commands(device_id, min(limit, 200))}


@app.get("/v1/audit")
def audit(limit: int = 100, device_id: str | None = None,
          actor: str = Depends(require_control)) -> dict:
    return {"entries": store.audit_tail(min(limit, 500), device_id)}


@app.post("/v1/killswitch/{state}")
def killswitch(state: Literal["on", "off"], actor: str = Depends(require_control)) -> dict:
    store.set_setting("killswitch", state)
    store.audit(actor, f"killswitch.{state}")
    return {"killswitch": state}


# ---------------------------------------------------------------------------
# Geraeteseite (Device-Token bzw. Enrollment-Code)
# ---------------------------------------------------------------------------

@app.post("/v1/agent/register")
def agent_register(req: RegisterRequest, request: Request) -> dict:
    """Loest einen Enrollment-Code gegen ein dauerhaftes Geraete-Token ein."""
    redeemed = store.redeem_enrollment(req.code)
    if redeemed is None:
        raise HTTPException(403, "Enrollment-Code ungueltig, abgelaufen oder bereits benutzt")
    device, token = redeemed
    caps = req.capabilities or device["capabilities"]
    unknown = set(caps) - set(security.KIND_CAPABILITY.values())
    if unknown:
        raise HTTPException(400, f"unbekannte Faehigkeiten: {sorted(unknown)}")
    store.update_device(device["id"], capabilities=caps, facts=req.facts)
    store.touch_device(device["id"], req.facts)
    store.audit(
        f"device:{device['id']}", "device.registered", device["id"],
        ip=request.client.host if request.client else None, capabilities=caps,
    )
    return {"device_token": token, "device": store.get_device(device["id"])}


@app.get("/v1/agent/poll")
async def agent_poll(wait: int = MAX_POLL_SECONDS, kinds: str = "",
                     device: dict = Depends(require_device)) -> dict:
    """Long-Poll: haelt die Verbindung offen, bis ein Kommando vorliegt.

    Das Geraet haelt damit dauerhaft eine ausgehende Verbindung - genau das
    macht es auch im gesperrten Zustand und hinter NAT erreichbar.

    `kinds` (Komma-Liste) grenzt auf die Kommandoarten ein, die der fragende
    Prozess ausfuehren kann - noetig, wenn auf einem Mac System-Daemon und
    Sitzungsprozess parallel pollen.
    """
    store.touch_device(device["id"])
    if killswitch_active():
        return {"commands": [], "killswitch": True, "poll_after_s": 30}

    wanted = [k for k in kinds.split(",") if k.strip()] or None
    if wanted:
        unknown = set(wanted) - set(security.ALL_KINDS)
        if unknown:
            raise HTTPException(400, f"unbekannte Kommandoarten: {sorted(unknown)}")

    deadline = time.time() + max(0, min(wait, MAX_POLL_SECONDS))
    store.expire_stale()
    while True:
        # Kein expire_stale je Runde: der Janitor erledigt das im Hintergrund,
        # sonst oeffnet jedes Geraet im Sekundentakt eine DB-Verbindung.
        commands = store.claim_next(device["id"], limit=5, kinds=wanted)
        if commands:
            store.audit(f"device:{device['id']}", "command.claimed", device["id"],
                        command_ids=[c["id"] for c in commands])
            return {"commands": commands, "killswitch": False}
        if time.time() >= deadline:
            return {"commands": [], "killswitch": False}
        await asyncio.sleep(1.0)


@app.post("/v1/agent/result")
def agent_result(req: ResultRequest, device: dict = Depends(require_device)) -> dict:
    cmd = store.complete(req.command_id, device["id"], req.result, req.error)
    if cmd is None:
        raise HTTPException(409, "Kommando unbekannt, fremd oder nicht mehr offen")
    store.touch_device(device["id"])
    store.audit(f"device:{device['id']}", "command.finished", device["id"],
                command_id=req.command_id, status=cmd["status"])
    return {"ok": True, "status": cmd["status"]}


@app.post("/v1/agent/heartbeat")
def agent_heartbeat(req: HeartbeatRequest, device: dict = Depends(require_device)) -> dict:
    store.touch_device(device["id"], req.facts or None)
    return {"ok": True, "killswitch": killswitch_active(), "mode": device["mode"]}


# ---------------------------------------------------------------------------
# Hintergrundaufgaben
# ---------------------------------------------------------------------------

async def _janitor() -> None:
    """Laeuft alle 60s: Timeouts markieren, alte Zeilen aufraeumen."""
    while True:
        try:
            store.expire_stale()
            store.purge_before(time.time() - RETENTION_DAYS * 86400)
        except Exception:  # pragma: no cover - Janitor darf nie sterben
            pass
        await asyncio.sleep(60)


@app.exception_handler(HTTPException)
async def _http_error(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
