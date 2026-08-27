"""Tests fuer Browser- und Mail-Steuerung.

Der Agent baut AppleScript aus Werten, die aus einem Kommando stammen. Wenn
das Escaping bricht, wird aus einem Betreff ausfuehrbarer Code. Diese Tests
pruefen genau das - sie brauchen keinen Mac.
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from hub import security  # noqa: E402

AGENT_PY = pathlib.Path(__file__).resolve().parent.parent / "agent" / "agent.py"


@pytest.fixture(scope="module")
def agent():
    spec = importlib.util.spec_from_file_location("skconnector_agent", AGENT_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ---------------------------------------------------------------------------
# AppleScript-Escaping
# ---------------------------------------------------------------------------

def test_quotes_are_escaped(agent):
    assert agent.as_literal('er sagte "hallo"') == '"er sagte \\"hallo\\""'


def test_backslashes_are_escaped(agent):
    assert agent.as_literal("C:\\pfad") == '"C:\\\\pfad"'


def test_newlines_do_not_break_out_of_the_literal(agent):
    literal = agent.as_literal("Zeile1\nZeile2\rZeile3")
    assert "\n" not in literal[1:-1].replace("\\n", "")
    assert literal.startswith('"') and literal.endswith('"')


def test_applescript_injection_via_subject_is_neutralised(agent):
    """Ein Betreff darf das Skript nicht verlassen koennen."""
    boese = '"} \ntell application "Finder" to delete every item of desktop\n--'
    script = agent.mail_script_compose(
        {"to": ["a@b.de"], "subject": boese, "body": "x"}, send=False)
    # Der Angriffstext darf nur als escapter String vorkommen, nie als Code.
    assert 'tell application "Finder"' not in script
    assert '\\"' in script


def test_injection_via_recipient_is_neutralised(agent):
    script = agent.mail_script_compose(
        {"to": ['x@y.de"}, {address:"opfer@z.de'], "subject": "s", "body": "b"}, send=False)
    assert script.count("make new to recipient") == 1


# ---------------------------------------------------------------------------
# Mail-Skripte
# ---------------------------------------------------------------------------

def test_draft_saves_and_send_sends(agent):
    payload = {"to": ["a@b.de"], "subject": "Test", "body": "Text"}
    assert "    save m" in agent.mail_script_compose(payload, send=False)
    assert "    send m" not in agent.mail_script_compose(payload, send=False)
    assert "    send m" in agent.mail_script_compose(payload, send=True)


def test_compose_handles_cc_and_sender(agent):
    script = agent.mail_script_compose({
        "to": ["a@b.de"], "cc": ["c@d.de"], "from": "Simon <simon@sk-finanzberatung.de>",
        "subject": "S", "body": "B",
    }, send=False)
    assert "make new cc recipient" in script
    assert "set sender of m to" in script


def test_list_script_respects_limit_and_unread_filter(agent):
    script = agent.mail_script_list("inbox", "", 25, unread_only=True)
    assert "read status is false" in script
    assert "if n > 25" in script
    assert "read status is false" not in agent.mail_script_list("inbox", "", 25, False)


def test_list_script_targets_account_mailbox(agent):
    script = agent.mail_script_list("Archiv", "Katya iCloud", 10, False)
    assert 'mailbox "Archiv" of account "Katya iCloud"' in script


# ---------------------------------------------------------------------------
# Browser-Skripte
# ---------------------------------------------------------------------------

def test_safari_and_chrome_use_their_own_vocabulary(agent):
    """Safari kennt 'name' und 'do JavaScript', Chrome 'title' und 'execute'."""
    safari = agent.browser_script_tabs("Safari")
    chrome = agent.browser_script_tabs("Google Chrome")
    assert "name of theTab" in safari and "title of theTab" not in safari
    assert "title of theTab" in chrome

    assert "do JavaScript" in agent.browser_script_js("Safari", "1+1", 1, 1)
    assert "execute tab" in agent.browser_script_js("Google Chrome", "1+1", 1, 1)


def test_javascript_is_passed_as_a_literal(agent):
    script = agent.browser_script_js("Safari", 'alert("hi")', 1, 2)
    assert '\\"hi\\"' in script


# ---------------------------------------------------------------------------
# Ausgabe-Parser
# ---------------------------------------------------------------------------

def test_parse_records_splits_fields_and_records(agent):
    raw = (f"1{agent.SEP}2{agent.SEP}Titel{agent.SEP}https://a.de{agent.REC}"
           f"1{agent.SEP}3{agent.SEP}Zweiter{agent.SEP}https://b.de{agent.REC}")
    rows = agent.parse_records(raw, ["window", "tab", "title", "url"])
    assert len(rows) == 2
    assert rows[1] == {"window": "1", "tab": "3", "title": "Zweiter", "url": "https://b.de"}


def test_parse_records_tolerates_missing_fields(agent):
    rows = agent.parse_records(f"nur-eins{agent.REC}", ["a", "b", "c"])
    assert rows == [{"a": "nur-eins", "b": "", "c": ""}]


# ---------------------------------------------------------------------------
# Rollen und Faehigkeiten
# ---------------------------------------------------------------------------

def test_system_role_never_claims_gui_commands(agent, monkeypatch):
    monkeypatch.setenv("CONNECTOR_ROLE", "system")
    kinds = agent.handled_kinds()
    assert "shell" in kinds
    assert not [k for k in kinds if k.startswith(("browser.", "mail."))]


def test_user_role_never_claims_shell(agent, monkeypatch):
    monkeypatch.setenv("CONNECTOR_ROLE", "user")
    kinds = agent.handled_kinds()
    assert "shell" not in kinds and "fs.write" not in kinds and "fs.read" not in kinds
    assert "notify" in kinds
    if agent.platform.system() == "Darwin":
        assert "browser.tabs" in kinds and "mail.list" in kinds


def test_user_role_kind_list_is_the_complement_of_system(agent, monkeypatch):
    """Zusammen decken beide Rollen alles ab, ohne sich zu ueberschneiden."""
    monkeypatch.setenv("CONNECTOR_ROLE", "system")
    system = set(agent.handled_kinds())
    monkeypatch.setenv("CONNECTOR_ROLE", "user")
    user = set(agent.handled_kinds())
    monkeypatch.setenv("CONNECTOR_ROLE", "all")
    alle = set(agent.handled_kinds())
    assert not (system & user)
    assert system | user == alle


def test_mail_send_is_off_unless_explicitly_enabled(agent, monkeypatch):
    monkeypatch.setenv("CONNECTOR_ROLE", "all")
    monkeypatch.delenv("CONNECTOR_ALLOW_MAIL_SEND", raising=False)
    assert "mail.send" not in agent.handled_kinds()
    assert "mail.send" not in agent.capabilities()

    monkeypatch.setenv("CONNECTOR_ALLOW_MAIL_SEND", "1")
    if agent.platform.system() == "Darwin":
        assert "mail.send" in agent.capabilities()
        assert "mail.send" in agent.handled_kinds()


def test_non_macos_never_claims_browser_or_mail_commands(agent, monkeypatch):
    """Sonst nimmt ein Linux-Agent Auftraege an, die er nicht ausfuehren kann."""
    monkeypatch.setenv("CONNECTOR_ROLE", "all")
    if agent.platform.system() != "Darwin":
        kinds = agent.handled_kinds()
        assert not [k for k in kinds if k.startswith(("browser.", "mail."))]
        assert "shell" in kinds and "notify" in kinds


def test_non_macos_does_not_advertise_browser_or_mail(agent, monkeypatch):
    monkeypatch.setenv("CONNECTOR_ROLE", "all")
    if agent.platform.system() != "Darwin":
        caps = agent.capabilities()
        assert "browser" not in caps and "mail" not in caps
        assert "shell" in caps


# ---------------------------------------------------------------------------
# Policy im Hub
# ---------------------------------------------------------------------------

def test_readonly_allows_looking_but_not_touching():
    caps = ["browser", "mail", "fs", "shell", "notify", "probe"]
    for kind, payload in (("browser.tabs", {}), ("browser.read", {}),
                          ("mail.list", {}), ("mail.read", {"id": "1"})):
        assert security.check_command(kind, "readonly", caps, payload).allowed, kind
    for kind, payload in (("browser.open", {"url": "https://a.de"}),
                          ("browser.js", {"script": "1"}),
                          ("mail.send", {"to": ["a@b.de"]}),
                          ("mail.draft", {"to": ["a@b.de"]})):
        assert not security.check_command(kind, "readonly", caps, payload).allowed, kind


def test_mail_send_needs_its_own_capability():
    """'mail' allein reicht nicht - Lesen und Senden sind getrennt."""
    nur_lesen = ["mail"]
    assert security.check_command("mail.list", "full", nur_lesen, {}).allowed
    verdict = security.check_command("mail.send", "full", nur_lesen, {"to": ["a@b.de"]})
    assert not verdict.allowed and "mail.send" in verdict.reason
    assert security.check_command(
        "mail.send", "full", ["mail", "mail.send"], {"to": ["a@b.de"]}).allowed


@pytest.mark.parametrize("url", [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    'https://a.de" & (do shell script "whoami") & "',
])
def test_browser_open_rejects_dangerous_urls(url):
    assert not security.check_command(
        "browser.open", "full", ["browser"], {"url": url}).allowed


def test_browser_rejects_unknown_application():
    verdict = security.check_command(
        "browser.tabs", "full", ["browser"], {"app": "Finder"})
    assert not verdict.allowed and "Finder" in verdict.reason


@pytest.mark.parametrize("payload", [
    {"to": []},
    {"to": ["keine-adresse"]},
    {"to": ['a@b.de"\nbeliebiger code']},
    {"to": [f"a{i}@b.de" for i in range(25)]},
])
def test_mail_send_rejects_bad_recipients(payload):
    assert not security.check_command(
        "mail.send", "full", ["mail", "mail.send"], payload).allowed


def test_browser_js_size_is_capped():
    assert not security.check_command(
        "browser.js", "full", ["browser"], {"script": "x" * 20001}).allowed
