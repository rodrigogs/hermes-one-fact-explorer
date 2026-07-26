"""The sidecar guards the agent's accumulated knowledge.

Two properties matter more than any feature here: nothing reaches a caller
without the token, and nothing this surface exposes can mutate the memory.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from memory.sidecar import MemorySidecarApp, resolve_store_path
from memory.store_reader import MemoryStoreReader

TOKEN = "memory-sidecar-token"

SCHEMA = """
CREATE TABLE facts (fact_id INTEGER PRIMARY KEY, content TEXT UNIQUE,
  category TEXT DEFAULT 'general', tags TEXT, trust_score REAL DEFAULT 0.5,
  retrieval_count INTEGER DEFAULT 0, helpful_count INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT, hrr_vector BLOB);
CREATE TABLE entities (entity_id INTEGER PRIMARY KEY, name TEXT,
  entity_type TEXT DEFAULT 'unknown', aliases TEXT, created_at TEXT);
CREATE TABLE fact_entities (fact_id INTEGER, entity_id INTEGER,
  PRIMARY KEY (fact_id, entity_id));
"""


@pytest.fixture
def app(tmp_path) -> MemorySidecarApp:
    db = tmp_path / "memory_store.db"
    connection = sqlite3.connect(db)
    connection.executescript(SCHEMA)
    for fact_id, content in ((1, "Router pins T4"), (2, "Sidecar runs on 8791")):
        connection.execute(
            "INSERT INTO facts (fact_id, content, category, tags, trust_score,"
            " created_at, updated_at) VALUES (?, ?, 'project', 'router', 0.9,"
            " '2026-07-01 00:00:00', '2026-07-01 00:00:00')",
            (fact_id, content),
        )
    connection.execute("INSERT INTO entities (entity_id, name) VALUES (10, 'router')")
    connection.executemany("INSERT INTO fact_entities VALUES (?, 10)", [(1,), (2,)])
    connection.commit()
    connection.close()

    token_file = tmp_path / "token"
    token_file.write_text(TOKEN, encoding="utf-8")
    return MemorySidecarApp(MemoryStoreReader(db), token_path=lambda: token_file)


def auth() -> dict:
    return {"X-Hermes-Sidecar-Token": TOKEN}


def test_no_memory_content_escapes_without_the_token(app):
    """Facts are private. Every content-bearing route is gated, including the
    ones that only look like metadata."""
    for route in ("/graph", "/facts", "/entities", "/stats"):
        status, body = app.dispatch("GET", route, {})
        assert status == 401, f"{route} leaked without a token"
        assert "facts" not in body and "entities" not in body

    status, _ = app.dispatch("GET", "/graph", {"X-Hermes-Sidecar-Token": "wrong"})
    assert status == 401


def test_health_is_exempt_because_it_carries_no_memory(app):
    status, body = app.dispatch("GET", "/health", {})
    assert status == 200
    assert body["ok"] is True
    assert "facts" not in body


def test_the_surface_is_read_only_whatever_the_caller_asks(app):
    """No verb here may mutate the agent's knowledge — a browser bug must not be
    able to delete something learned weeks ago."""
    for method in ("POST", "PUT", "PATCH", "DELETE"):
        status, body = app.dispatch(method, "/graph", auth())
        assert status == 405, f"{method} must be refused outright"
        assert "read-only" in body["error"]


def test_the_graph_carries_both_recorded_and_derived_edges(app):
    status, body = app.dispatch("GET", "/graph", auth())
    assert status == 200
    assert body["stats"]["facts"] == 2
    assert body["stats"]["mentions"] == 2
    assert body["stats"]["shares"] == 1
    edge = [e for e in body["edges"] if e["kind"] == "shares"][0]
    assert edge["via"] == ["router"], "a derived edge must justify itself"


def test_an_unreadable_store_is_503_not_an_empty_graph(tmp_path):
    """Rendering an empty graph for a missing database would tell the operator
    their memory is gone. That claim must never be made by accident."""
    token_file = tmp_path / "token"
    token_file.write_text(TOKEN, encoding="utf-8")
    app = MemorySidecarApp(MemoryStoreReader(tmp_path / "gone.db"),
                           token_path=lambda: token_file)

    status, body = app.dispatch("GET", "/graph", auth())

    assert status == 503
    assert "gone.db" in body["error"]


def test_a_missing_token_file_denies_rather_than_admits_everyone(tmp_path):
    """Fail closed: if the token cannot be read, nothing is authorised."""
    app = MemorySidecarApp(MemoryStoreReader(tmp_path / "any.db"),
                           token_path=lambda: tmp_path / "absent-token")
    assert app.dispatch("GET", "/graph", auth())[0] == 401


def test_an_unknown_route_is_404_before_it_is_401(app):
    """A typo must not be reported as an auth problem."""
    assert app.dispatch("GET", "/../../etc/passwd", auth())[0] == 404
    assert app.dispatch("GET", "/nope", {})[0] == 404


def test_the_store_path_does_not_double_up_the_profile(monkeypatch, tmp_path):
    """The exact bug that made router compaction unreachable: HERMES_HOME is
    already profile-scoped, so appending profiles/<name> yields a path that
    cannot exist."""
    monkeypatch.delenv("HERMES_MEMORY_STORE_FILE", raising=False)
    scoped = tmp_path / "profiles" / "rodrigo"
    monkeypatch.setenv("HERMES_HOME", str(scoped))
    assert resolve_store_path() == scoped / "memory_store.db"

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "base"))
    monkeypatch.setenv("HERMES_PROFILE", "alice")
    assert resolve_store_path() == tmp_path / "base" / "profiles" / "alice" / "memory_store.db"

    monkeypatch.setenv("HERMES_MEMORY_STORE_FILE", str(tmp_path / "explicit.db"))
    assert resolve_store_path() == tmp_path / "explicit.db"


def test_the_console_is_served_as_html_not_json(app, tmp_path):
    """The nav reads this body straight into an iframe srcdoc.

    A JSON envelope around the HTML renders as literal JSON in the panel, which
    is exactly what a first pass at this did.
    """
    status, body, content_type = app.render_console()

    assert status == 200
    assert content_type.startswith("text/html")
    assert body.lstrip().startswith(b"<!doctype html>")
    assert b"__memory" in body, "the shell must carry its own script"


def test_a_missing_console_asset_is_404_json_not_a_blank_page(tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text(TOKEN, encoding="utf-8")
    app = MemorySidecarApp(MemoryStoreReader(tmp_path / "db"),
                           token_path=lambda: token_file,
                           console_path=tmp_path / "absent.html")

    status, body, content_type = app.render_console()

    assert status == 404
    assert content_type.startswith("application/json")
    assert b"unreadable" in body


def test_console_is_not_reachable_through_the_json_dispatcher(app):
    """It is transport-served; leaving it in the JSON route table would make an
    HTML asset answer as JSON depending on how it was called."""
    assert app.dispatch("GET", "/console", auth())[0] == 404
