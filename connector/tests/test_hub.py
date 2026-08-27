"""Tests fuer Hub-Policy, Store und API.

    cd connector && python3 -m pytest tests -q
"""

from __future__ import annotations

import importlib
import os
import sys
import time

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hub import security  # noqa: E402
from hub.store import Store  # noqa: E402

CONTROL = "skc_ctl_test-token"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CONNECTOR_DB", str(tmp_path / "hub.db"))
    monkeypatch.setenv("CONNECTOR_CONTROL_TOKEN", CONTROL)
    monkeypatch.setenv("CONNECTOR_POLL_SECONDS", "1")
    import hub.app as app_module
    importlib.reload(app_module)
    with TestClient(app_module.app) as c:
        c.app_module = app_module  # type: ignore[attr-defined]
        yield c


def ctl(extra: dict | None = None) -> dict:
    return {"Authorization": f"Bearer {CONTROL}", **(extra or {})}


def make_device(client, device_id="mac-test", platform="macos", mode="full",
                caps=("shell", "fs", "notify", "probe"), **kw) -> dict:
    body = {
        "device_id": device_id, "label": device_id, "platform": platform,
        "mode": mode, "capabilities": list(caps), **kw,
    }
    resp = client.post("/v1/devices", json=body, headers=ctl())
    assert resp.status_code == 200, resp.text
    return resp.json()


def enroll(client, code, caps=("shell", "fs", "notify", "probe")) -> str:
    resp = client.post("/v1/agent/register",
                       json={"code": code, "capabilities": list(caps), "facts": {}})
    assert resp.status_code == 200, resp.text
    return resp.json()["device_token"]


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("command", [
    "rm -rf /",
    "sudo rm -rf ~/Documents",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/disk2",
    "diskutil eraseDisk JHFS+ x disk2",
    "sudo shutdown -h now",
    "csrutil disable",
    ":(){ :|:& };:",
    "security dump-keychain",
])
def test_deny_list_blocks_destructive_commands(command):
    assert not security.check_shell(command).allowed


@pytest.mark.parametrize("command", [
    "uptime",
    "ls -la ~/Projekte",
    "git -C /srv/app pull --rebase",
    "rm /tmp/eine-datei.txt",
    "grep -r TODO src/ | head -50",
])
def test_deny_list_allows_normal_commands(command):
    assert security.check_shell(command).allowed, command


def test_allowlist_restricts_binaries():
    assert security.check_shell("git status", ["git", "ls"]).allowed
    verdict = security.check_shell("curl https://example.com", ["git", "ls"])
    assert not verdict.allowed and "Allowlist" in verdict.reason


def test_mode_gates_command_kinds():
    caps = ["shell", "fs", "notify", "probe"]
    assert not security.check_command("shell", "readonly", caps, {"command": "ls"}).allowed
    assert security.check_command("fs.read", "readonly", caps, {"path": "/etc/hosts"}).allowed
    assert not security.check_command("fs.write", "readonly", caps, {"path": "/x"}).allowed
    assert security.check_command("shell", "full", caps, {"command": "ls"}).allowed
    # 'notify' ist in jedem Modus erlaubt - das ist die Basisstufe.
    assert security.check_command("notify", "notify", ["notify"], {}).allowed


def test_capability_required():
    verdict = security.check_command("shell", "full", ["notify"], {"command": "ls"})
    assert not verdict.allowed and "shell" in verdict.reason


def test_tokens_are_never_stored_in_clear(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.create_device("d1", "D1", "macos")
    code = store.create_enrollment("d1")
    device, token = store.redeem_enrollment(code)  # type: ignore[misc]
    raw = (tmp_path / "t.db").read_bytes()
    assert token.encode() not in raw
    assert code.encode() not in raw
    assert store.device_by_token(token)["id"] == "d1"


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

def test_enrollment_code_is_single_use(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.create_device("d1", "D1", "macos")
    code = store.create_enrollment("d1")
    assert store.redeem_enrollment(code) is not None
    assert store.redeem_enrollment(code) is None


def test_enrollment_code_expires(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.create_device("d1", "D1", "macos")
    code = store.create_enrollment("d1", ttl_s=60)
    with store.conn() as c:
        c.execute("UPDATE enrollments SET expires_at=?", (time.time() - 1,))
    assert store.redeem_enrollment(code) is None


def test_command_claimed_only_once(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.create_device("d1", "D1", "macos")
    store.enqueue("d1", "shell", {"command": "ls"})
    assert len(store.claim_next("d1")) == 1
    assert store.claim_next("d1") == []


def test_expire_stale_marks_timeout(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.create_device("d1", "D1", "macos")
    cmd = store.enqueue("d1", "shell", {"command": "sleep 999"}, timeout_s=5)
    with store.conn() as c:
        c.execute("UPDATE commands SET created_at=? WHERE id=?",
                  (time.time() - 60, cmd["id"]))
    assert store.expire_stale() == 1
    assert store.get_command(cmd["id"])["status"] == "timeout"


def test_revoke_cancels_open_commands(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.create_device("d1", "D1", "macos")
    code = store.create_enrollment("d1")
    _, token = store.redeem_enrollment(code)  # type: ignore[misc]
    cmd = store.enqueue("d1", "shell", {"command": "ls"})
    store.revoke_device("d1")
    assert store.get_command(cmd["id"])["status"] == "cancelled"
    assert store.device_by_token(token) is None


def test_push_url_not_exposed_in_device_payload(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    store.create_device("i1", "iPhone", "ios", capabilities=["notify"],
                        push_url="https://api.pushcut.io/GEHEIM/notifications/x")
    device = store.get_device("i1")
    assert "push_url" not in device
    assert device["push_configured"] is True
    assert store.get_push_url("i1").endswith("/notifications/x")


def test_migration_adds_push_url_to_old_db(tmp_path):
    """Eine Datenbank ohne push_url-Spalte wird beim Start ergaenzt."""
    import sqlite3
    path = str(tmp_path / "old.db")
    con = sqlite3.connect(path)
    con.executescript(
        "CREATE TABLE devices (id TEXT PRIMARY KEY, label TEXT NOT NULL,"
        " platform TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'simon',"
        " mode TEXT NOT NULL DEFAULT 'readonly', capabilities TEXT NOT NULL DEFAULT '[]',"
        " allowlist TEXT NOT NULL DEFAULT '[]', token_hash TEXT,"
        " facts TEXT NOT NULL DEFAULT '{}', enrolled_at REAL, last_seen REAL,"
        " revoked_at REAL, created_at REAL NOT NULL);"
    )
    con.execute("INSERT INTO devices(id,label,platform,created_at) VALUES('x','X','macos',0)")
    con.commit()
    con.close()
    store = Store(path)
    assert store.get_device("x")["push_configured"] is False


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

def test_control_token_required(client):
    assert client.get("/v1/devices").status_code == 401
    assert client.get("/v1/devices", headers={"Authorization": "Bearer falsch"}).status_code == 403


def test_full_roundtrip_enroll_poll_execute(client):
    created = make_device(client)
    token = enroll(client, created["enrollment_code"])
    dev = {"Authorization": f"Bearer {token}"}

    issued = client.post("/v1/devices/mac-test/commands",
                         json={"kind": "shell", "payload": {"command": "uptime"}},
                         headers=ctl()).json()
    assert issued["status"] == "queued"

    polled = client.get("/v1/agent/poll?wait=0", headers=dev).json()
    assert [c["id"] for c in polled["commands"]] == [issued["id"]]

    client.post("/v1/agent/result",
                json={"command_id": issued["id"],
                      "result": {"exit_code": 0, "stdout": "up 3 days"}},
                headers=dev)
    final = client.get(f"/v1/commands/{issued['id']}", headers=ctl()).json()
    assert final["status"] == "done"
    assert final["result"]["stdout"] == "up 3 days"


def test_device_cannot_complete_foreign_command(client):
    a = make_device(client, "mac-a")
    b = make_device(client, "mac-b")
    token_b = enroll(client, b["enrollment_code"])
    enroll(client, a["enrollment_code"])

    cmd = client.post("/v1/devices/mac-a/commands",
                      json={"kind": "shell", "payload": {"command": "ls"}},
                      headers=ctl()).json()
    resp = client.post("/v1/agent/result", json={"command_id": cmd["id"], "result": {}},
                       headers={"Authorization": f"Bearer {token_b}"})
    assert resp.status_code == 409


def test_readonly_device_rejects_shell(client):
    created = make_device(client, "mac-gf", mode="readonly")
    enroll(client, created["enrollment_code"])
    resp = client.post("/v1/devices/mac-gf/commands",
                       json={"kind": "shell", "payload": {"command": "ls"}}, headers=ctl())
    assert resp.status_code == 403
    assert "readonly" in resp.json()["error"]


def test_denied_command_is_audited(client):
    created = make_device(client)
    enroll(client, created["enrollment_code"])
    client.post("/v1/devices/mac-test/commands",
                json={"kind": "shell", "payload": {"command": "rm -rf /"}}, headers=ctl())
    actions = [e["action"] for e in client.get("/v1/audit", headers=ctl()).json()["entries"]]
    assert "command.denied" in actions


def test_revoked_token_is_refused(client):
    created = make_device(client)
    token = enroll(client, created["enrollment_code"])
    client.post("/v1/devices/mac-test/revoke", headers=ctl())
    resp = client.get("/v1/agent/poll?wait=0", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403


def test_killswitch_blocks_new_commands(client):
    created = make_device(client)
    enroll(client, created["enrollment_code"])
    client.post("/v1/killswitch/on", headers=ctl())
    resp = client.post("/v1/devices/mac-test/commands",
                       json={"kind": "shell", "payload": {"command": "ls"}}, headers=ctl())
    assert resp.status_code == 423
    client.post("/v1/killswitch/off", headers=ctl())
    assert client.post("/v1/devices/mac-test/commands",
                       json={"kind": "shell", "payload": {"command": "ls"}},
                       headers=ctl()).status_code == 200


def test_push_only_device_needs_no_enrollment(client, monkeypatch):
    sent: dict = {}

    def fake_deliver(push_url, title, message, url="", priority="default"):
        sent.update({"push_url": push_url, "title": title, "message": message})
        return {"delivered": True, "via": "ntfy", "status": 200}

    monkeypatch.setattr(client.app_module.push, "deliver", fake_deliver)  # type: ignore[attr-defined]
    make_device(client, "iphone-simon", platform="ios", mode="notify",
                caps=("notify",), push_url="https://ntfy.example.de/simon")
    resp = client.post("/v1/devices/iphone-simon/commands",
                       json={"kind": "notify",
                             "payload": {"title": "Test", "message": "Hallo"}},
                       headers=ctl())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "done"
    assert body["result"]["delivered"] is True
    assert sent["message"] == "Hallo"


def test_notify_only_device_rejects_everything_else(client):
    make_device(client, "iphone-gf", platform="ios", mode="notify", caps=("notify",),
                push_url="https://ntfy.example.de/gf")
    resp = client.post("/v1/devices/iphone-gf/commands",
                       json={"kind": "fs.read", "payload": {"path": "/etc/hosts"}},
                       headers=ctl())
    assert resp.status_code == 403


def test_unknown_capability_rejected(client):
    resp = client.post("/v1/devices", json={
        "device_id": "mac-x", "label": "X", "platform": "macos",
        "capabilities": ["root-alles"],
    }, headers=ctl())
    assert resp.status_code == 400
    assert "root-alles" in resp.json()["error"]


def test_device_id_is_validated(client):
    for bad in ("x", "Mac Simon", "../etc", "a" * 100):
        resp = client.post("/v1/devices", json={
            "device_id": bad, "label": "X", "platform": "macos",
        }, headers=ctl())
        assert resp.status_code == 422, bad


def test_healthz_needs_no_auth(client):
    assert client.get("/healthz").json()["ok"] is True
