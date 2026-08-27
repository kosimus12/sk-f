"""SQLite-Persistenz fuer den Connector-Hub.

Bewusst ohne ORM: eine Datei, WAL-Modus, kurze Transaktionen. Der Hub
verwaltet ein paar Dutzend Zeilen pro Tag - alles andere waere Overbau.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from typing import Any, Iterator

from . import security

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    platform      TEXT NOT NULL,
    owner         TEXT NOT NULL DEFAULT 'simon',
    mode          TEXT NOT NULL DEFAULT 'readonly',
    capabilities  TEXT NOT NULL DEFAULT '[]',
    allowlist     TEXT NOT NULL DEFAULT '[]',
    token_hash    TEXT,
    push_url      TEXT,
    facts         TEXT NOT NULL DEFAULT '{}',
    enrolled_at   REAL,
    last_seen     REAL,
    revoked_at    REAL,
    created_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollments (
    code_hash   TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL,
    expires_at  REAL NOT NULL,
    used_at     REAL,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
    id           TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    payload      TEXT NOT NULL,
    status       TEXT NOT NULL,
    timeout_s    INTEGER NOT NULL DEFAULT 120,
    result       TEXT,
    error        TEXT,
    issued_by    TEXT NOT NULL DEFAULT 'control',
    created_at   REAL NOT NULL,
    claimed_at   REAL,
    finished_at  REAL
);
CREATE INDEX IF NOT EXISTS idx_commands_device_status
    ON commands(device_id, status, created_at);

CREATE TABLE IF NOT EXISTS audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         REAL NOT NULL,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    device_id  TEXT,
    detail     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);

CREATE TABLE IF NOT EXISTS control_tokens (
    token_hash  TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    ceiling     TEXT NOT NULL DEFAULT 'readonly',
    devices     TEXT NOT NULL DEFAULT '[]',
    created_at  REAL NOT NULL,
    last_used   REAL,
    revoked_at  REAL
);

CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
"""


def _now() -> float:
    return time.time()


class Store:
    def __init__(self, path: str):
        self.path = path
        directory = os.path.dirname(os.path.abspath(path))
        if directory:
            os.makedirs(directory, exist_ok=True)
        # Bewusst ausserhalb von conn(): executescript beendet eine offene
        # Transaktion, das anschliessende COMMIT wuerde fehlschlagen.
        c = sqlite3.connect(self.path, timeout=15)
        c.row_factory = sqlite3.Row
        try:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript(SCHEMA)
            self._migrate(c)
            c.commit()
        finally:
            c.close()

    @staticmethod
    def _migrate(c: sqlite3.Connection) -> None:
        """Additive Migrationen fuer Datenbanken aus aelteren Versionen."""
        have = {r["name"] for r in c.execute("PRAGMA table_info(devices)")}
        for column, ddl in (("push_url", "ALTER TABLE devices ADD COLUMN push_url TEXT"),):
            if column not in have:
                c.execute(ddl)

    @contextmanager
    def conn(self) -> Iterator[sqlite3.Connection]:
        c = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        c.row_factory = sqlite3.Row
        try:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA foreign_keys=ON")
            c.execute("BEGIN")
            yield c
            c.execute("COMMIT")
        except Exception:
            try:
                c.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            c.close()

    # -- Audit ------------------------------------------------------------
    def audit(self, actor: str, action: str, device_id: str | None = None, **detail: Any) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO audit(ts, actor, action, device_id, detail) VALUES(?,?,?,?,?)",
                (_now(), actor, action, device_id, json.dumps(detail, ensure_ascii=False)),
            )

    def audit_tail(self, limit: int = 100, device_id: str | None = None) -> list[dict]:
        q = "SELECT * FROM audit"
        args: list[Any] = []
        if device_id:
            q += " WHERE device_id = ?"
            args.append(device_id)
        q += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        with self.conn() as c:
            rows = c.execute(q, args).fetchall()
        return [
            {**dict(r), "detail": json.loads(r["detail"])} for r in rows
        ]

    # -- Settings ---------------------------------------------------------
    def get_setting(self, key: str, default: str | None = None) -> str | None:
        with self.conn() as c:
            row = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO settings(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )

    # -- Abgestufte Control-Tokens ----------------------------------------
    #
    # Das Master-Token aus hub.env kann alles. Fuer Oberflaechen, die fremde
    # Inhalte verarbeiten (Chat, Cowork), gibt es zusaetzliche Tokens mit
    # einer Obergrenze: sie duerfen hoechstens das, was ihr 'ceiling'
    # zulaesst, und optional nur auf bestimmten Geraeten arbeiten.

    def create_control_token(self, label: str, ceiling: str = "readonly",
                             devices: list[str] | None = None) -> str:
        token = security.new_token(security.TOKEN_PREFIX_CONTROL)
        with self.conn() as c:
            c.execute(
                "INSERT INTO control_tokens(token_hash,label,ceiling,devices,created_at)"
                " VALUES(?,?,?,?,?)",
                (security.hash_token(token), label, ceiling,
                 json.dumps(devices or []), _now()),
            )
        return token

    def control_token_by_value(self, token: str) -> dict | None:
        th = security.hash_token(token)
        with self.conn() as c:
            row = c.execute(
                "SELECT * FROM control_tokens WHERE token_hash=? AND revoked_at IS NULL",
                (th,),
            ).fetchone()
            if row is None:
                return None
            c.execute("UPDATE control_tokens SET last_used=? WHERE token_hash=?",
                      (_now(), th))
        d = dict(row)
        d["devices"] = json.loads(d["devices"] or "[]")
        d.pop("token_hash", None)
        return d

    def list_control_tokens(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT label,ceiling,devices,created_at,last_used,revoked_at"
                " FROM control_tokens ORDER BY created_at"
            ).fetchall()
        return [{**dict(r), "devices": json.loads(r["devices"] or "[]")} for r in rows]

    def revoke_control_token(self, label: str) -> int:
        with self.conn() as c:
            cur = c.execute(
                "UPDATE control_tokens SET revoked_at=? WHERE label=? AND revoked_at IS NULL",
                (_now(), label),
            )
            return cur.rowcount

    # -- Geraete ----------------------------------------------------------
    def create_device(
        self,
        device_id: str,
        label: str,
        platform: str,
        owner: str = "simon",
        mode: str = "readonly",
        capabilities: list[str] | None = None,
        allowlist: list[str] | None = None,
        push_url: str | None = None,
    ) -> dict:
        with self.conn() as c:
            c.execute(
                "INSERT INTO devices(id,label,platform,owner,mode,capabilities,allowlist,"
                "push_url,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    device_id,
                    label,
                    platform,
                    owner,
                    mode,
                    json.dumps(capabilities or []),
                    json.dumps(allowlist or []),
                    push_url,
                    _now(),
                ),
            )
        return self.get_device(device_id)  # type: ignore[return-value]

    def get_device(self, device_id: str) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
        return _device_row(row) if row else None

    def list_devices(self, include_revoked: bool = False) -> list[dict]:
        q = "SELECT * FROM devices"
        if not include_revoked:
            q += " WHERE revoked_at IS NULL"
        q += " ORDER BY owner, label"
        with self.conn() as c:
            rows = c.execute(q).fetchall()
        return [_device_row(r) for r in rows]

    def get_push_url(self, device_id: str) -> str | None:
        """Push-URL im Klartext - nur fuer die Zustellung, nie fuer Antworten."""
        with self.conn() as c:
            row = c.execute(
                "SELECT push_url FROM devices WHERE id=?", (device_id,)
            ).fetchone()
        return row["push_url"] if row else None

    def device_by_token(self, token: str) -> dict | None:
        th = security.hash_token(token)
        with self.conn() as c:
            row = c.execute(
                "SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL", (th,)
            ).fetchone()
        return _device_row(row) if row else None

    def update_device(self, device_id: str, **fields: Any) -> dict | None:
        if not fields:
            return self.get_device(device_id)
        encoded = {
            k: (json.dumps(v) if k in ("capabilities", "allowlist", "facts") else v)
            for k, v in fields.items()
        }
        sets = ", ".join(f"{k}=?" for k in encoded)
        with self.conn() as c:
            c.execute(
                f"UPDATE devices SET {sets} WHERE id=?", (*encoded.values(), device_id)
            )
        return self.get_device(device_id)

    def touch_device(self, device_id: str, facts: dict | None = None) -> None:
        with self.conn() as c:
            if facts is None:
                c.execute("UPDATE devices SET last_seen=? WHERE id=?", (_now(), device_id))
            else:
                c.execute(
                    "UPDATE devices SET last_seen=?, facts=? WHERE id=?",
                    (_now(), json.dumps(facts, ensure_ascii=False), device_id),
                )

    def revoke_device(self, device_id: str) -> None:
        with self.conn() as c:
            c.execute(
                "UPDATE devices SET revoked_at=?, token_hash=NULL WHERE id=?",
                (_now(), device_id),
            )
            c.execute(
                "UPDATE commands SET status='cancelled', error='Geraet widerrufen', finished_at=?"
                " WHERE device_id=? AND status IN ('queued','claimed')",
                (_now(), device_id),
            )

    # -- Enrollment -------------------------------------------------------
    def create_enrollment(self, device_id: str, ttl_s: int = 1800) -> str:
        code = security.new_token(security.TOKEN_PREFIX_ENROLL)
        with self.conn() as c:
            c.execute(
                "INSERT INTO enrollments(code_hash, device_id, expires_at, created_at)"
                " VALUES(?,?,?,?)",
                (security.hash_token(code), device_id, _now() + ttl_s, _now()),
            )
        return code

    def redeem_enrollment(self, code: str) -> tuple[dict, str] | None:
        """Loest einen Enrollment-Code ein und gibt (device, device_token) zurueck."""
        ch = security.hash_token(code)
        with self.conn() as c:
            row = c.execute(
                "SELECT * FROM enrollments WHERE code_hash=?", (ch,)
            ).fetchone()
            if row is None or row["used_at"] is not None or row["expires_at"] < _now():
                return None
            device_id = row["device_id"]
            token = security.new_token(security.TOKEN_PREFIX_DEVICE)
            c.execute("UPDATE enrollments SET used_at=? WHERE code_hash=?", (_now(), ch))
            c.execute(
                "UPDATE devices SET token_hash=?, enrolled_at=?, revoked_at=NULL WHERE id=?",
                (security.hash_token(token), _now(), device_id),
            )
        device = self.get_device(device_id)
        if device is None:
            return None
        return device, token

    # -- Kommandos --------------------------------------------------------
    def enqueue(
        self,
        device_id: str,
        kind: str,
        payload: dict,
        timeout_s: int = 120,
        issued_by: str = "control",
    ) -> dict:
        cid = "c-" + uuid.uuid4().hex[:16]
        with self.conn() as c:
            c.execute(
                "INSERT INTO commands(id,device_id,kind,payload,status,timeout_s,issued_by,created_at)"
                " VALUES(?,?,?,?, 'queued', ?,?,?)",
                (cid, device_id, kind, json.dumps(payload, ensure_ascii=False), timeout_s, issued_by, _now()),
            )
        return self.get_command(cid)  # type: ignore[return-value]

    def claim_next(self, device_id: str, limit: int = 1,
                   kinds: list[str] | None = None) -> list[dict]:
        """Nimmt bis zu `limit` wartende Kommandos fuer ein Geraet an.

        `kinds` grenzt auf die Arten ein, die der fragende Prozess auch
        ausfuehren kann. Auf dem Mac laufen zwei Prozesse mit demselben
        Token: der System-Daemon (Shell, Dateien) und - optional - ein
        Prozess in der Benutzersitzung (Browser, Mail). Ohne diesen Filter
        wuerde der eine Auftraege des anderen wegschnappen.
        """
        with self.conn() as c:
            if kinds:
                placeholders = ",".join("?" * len(kinds))
                rows = c.execute(
                    f"SELECT * FROM commands WHERE device_id=? AND status='queued'"
                    f" AND kind IN ({placeholders}) ORDER BY created_at LIMIT ?",
                    (device_id, *kinds, limit),
                ).fetchall()
            else:
                rows = c.execute(
                    "SELECT * FROM commands WHERE device_id=? AND status='queued'"
                    " ORDER BY created_at LIMIT ?",
                    (device_id, limit),
                ).fetchall()
            claimed = []
            for r in rows:
                c.execute(
                    "UPDATE commands SET status='claimed', claimed_at=? WHERE id=? AND status='queued'",
                    (_now(), r["id"]),
                )
                claimed.append(_command_row(r) | {"status": "claimed"})
        return claimed

    def complete(
        self, command_id: str, device_id: str, result: dict | None, error: str | None
    ) -> dict | None:
        status = "error" if error else "done"
        with self.conn() as c:
            cur = c.execute(
                "UPDATE commands SET status=?, result=?, error=?, finished_at=?"
                " WHERE id=? AND device_id=? AND status='claimed'",
                (
                    status,
                    json.dumps(result, ensure_ascii=False) if result is not None else None,
                    error,
                    _now(),
                    command_id,
                    device_id,
                ),
            )
            changed = cur.rowcount
        return self.get_command(command_id) if changed else None

    def force_complete(
        self, command_id: str, result: dict | None, error: str | None
    ) -> dict | None:
        """Schliesst ein Kommando ab, das der Hub selbst erledigt hat.

        Wird fuer Push-Mitteilungen genutzt: die stellt der Hub direkt zu,
        ohne dass das Geraet sie jemals abholt.
        """
        with self.conn() as c:
            c.execute(
                "UPDATE commands SET status=?, result=?, error=?, claimed_at=?, finished_at=?"
                " WHERE id=?",
                (
                    "error" if error else "done",
                    json.dumps(result, ensure_ascii=False) if result is not None else None,
                    error,
                    _now(),
                    _now(),
                    command_id,
                ),
            )
        return self.get_command(command_id)

    def get_command(self, command_id: str) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM commands WHERE id=?", (command_id,)).fetchone()
        return _command_row(row) if row else None

    def list_commands(self, device_id: str | None = None, limit: int = 50) -> list[dict]:
        q = "SELECT * FROM commands"
        args: list[Any] = []
        if device_id:
            q += " WHERE device_id=?"
            args.append(device_id)
        q += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        with self.conn() as c:
            rows = c.execute(q, args).fetchall()
        return [_command_row(r) for r in rows]

    def expire_stale(self) -> int:
        """Markiert Kommandos als abgelaufen, deren Timeout verstrichen ist."""
        now = _now()
        with self.conn() as c:
            cur = c.execute(
                "UPDATE commands SET status='timeout', error='Timeout - Geraet hat nicht geantwortet',"
                " finished_at=? WHERE status IN ('queued','claimed')"
                " AND (COALESCE(claimed_at, created_at) + timeout_s) < ?",
                (now, now),
            )
            return cur.rowcount

    def purge_before(self, cutoff: float) -> dict[str, int]:
        with self.conn() as c:
            cmds = c.execute(
                "DELETE FROM commands WHERE finished_at IS NOT NULL AND finished_at < ?",
                (cutoff,),
            ).rowcount
            aud = c.execute("DELETE FROM audit WHERE ts < ?", (cutoff,)).rowcount
            c.execute("DELETE FROM enrollments WHERE expires_at < ?", (cutoff,))
        return {"commands": cmds, "audit": aud}


def _device_row(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["capabilities"] = json.loads(d.get("capabilities") or "[]")
    d["allowlist"] = json.loads(d.get("allowlist") or "[]")
    d["facts"] = json.loads(d.get("facts") or "{}")
    d["enrolled"] = d.pop("token_hash", None) is not None
    d["push_configured"] = bool(d.pop("push_url", None))
    d["online"] = bool(d.get("last_seen") and (_now() - d["last_seen"]) < 180)
    return d


def _command_row(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["payload"] = json.loads(d.get("payload") or "{}")
    if d.get("result"):
        d["result"] = json.loads(d["result"])
    return d
