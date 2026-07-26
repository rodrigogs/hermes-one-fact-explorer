"""The graph is derived, not stored, so its derivation carries all the risk.

These tests pin the rules that keep the picture honest: one edge per pair, every
edge able to justify itself, hub entities excluded, isolated facts counted rather
than dropped, and a missing store raising instead of rendering as "no memories".
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from memory.graph import build_graph, shared_entity_edges
from memory.store_reader import Entity, Fact, MemoryStoreReader, StoreUnavailable


def fact(fact_id: int, *entity_ids: int, **kw) -> Fact:
    return Fact(
        fact_id=fact_id,
        content=kw.get("content", f"fact {fact_id}"),
        category=kw.get("category", "general"),
        tags=tuple(kw.get("tags", ())),
        trust_score=kw.get("trust", 0.5),
        retrieval_count=kw.get("retrievals", 0),
        helpful_count=kw.get("helpful", 0),
        created_at=kw.get("created_at", "2026-07-01 00:00:00"),
        updated_at=kw.get("updated_at", "2026-07-01 00:00:00"),
        entity_ids=tuple(entity_ids),
    )


def entity(entity_id: int, name: str, fact_count: int) -> Entity:
    return Entity(entity_id=entity_id, name=name, entity_type="unknown",
                  aliases=(), fact_count=fact_count)


def test_two_facts_sharing_an_entity_get_exactly_one_edge_that_explains_itself():
    facts = [fact(1, 10), fact(2, 10), fact(3)]
    entities = [entity(10, "capability-router", 2)]

    edges = shared_entity_edges(facts, entities)

    assert len(edges) == 1, "one edge per pair, not one per shared entity"
    edge = edges[0]
    assert (edge["source"], edge["target"]) == (1, 2)
    assert edge["kind"] == "shares"
    # "Why are these connected?" must be answerable from the edge alone.
    assert edge["via"] == ["capability-router"]
    assert edge["weight"] == 1


def test_more_shared_entities_mean_a_heavier_edge():
    facts = [fact(1, 10, 11), fact(2, 10, 11)]
    entities = [entity(10, "router", 2), entity(11, "sidecar", 2)]

    edge = shared_entity_edges(facts, entities)[0]

    assert edge["weight"] == 2, "sharing two entities is a stronger claim than one"
    assert edge["via"] == ["router", "sidecar"]


def test_an_entity_mentioned_by_almost_everything_draws_no_edges():
    # "Hermes" appears on every fact in this store. Wiring all of them together
    # would turn the graph into a hairball that says nothing.
    facts = [fact(i, 99) for i in range(1, 5)]
    entities = [entity(99, "Hermes", 4)]

    assert shared_entity_edges(facts, entities) == []


def test_a_hub_does_not_suppress_a_real_relationship():
    # Sharing a hub AND a specific entity is still a relationship; the edge must
    # survive and be justified by the specific entity only.
    facts = [fact(1, 99, 10), fact(2, 99, 10), fact(3, 99), fact(4, 99)]
    entities = [entity(99, "Hermes", 4), entity(10, "capability-router", 2)]

    edges = shared_entity_edges(facts, entities)

    assert len(edges) == 1
    assert edges[0]["via"] == ["capability-router"], "the hub is not evidence"


def test_facts_no_entity_was_extracted_from_are_counted_not_hidden():
    """A fact with no entity is unreachable by entity-based retrieval.

    That is a finding about the memory, so the payload must surface it rather
    than quietly omitting the node.
    """
    facts = [fact(1, 10), fact(2, 10), fact(3), fact(4)]
    entities = [entity(10, "router", 2)]

    graph = build_graph(facts, entities, [(1, 10), (2, 10)])

    assert graph["stats"]["isolated"] == 2
    assert graph["isolated_facts"] == [3, 4]
    assert len(graph["facts"]) == 4, "isolated facts are still nodes"


def test_mention_edges_are_reported_separately_from_derived_ones():
    """Recorded truth and inference must never be conflated on screen."""
    facts = [fact(1, 10), fact(2, 10)]
    entities = [entity(10, "router", 2)]

    graph = build_graph(facts, entities, [(1, 10), (2, 10)])
    kinds = {edge["kind"] for edge in graph["edges"]}

    assert kinds == {"mentions", "shares"}
    assert graph["stats"]["mentions"] == 2
    assert graph["stats"]["shares"] == 1


def test_an_empty_store_is_an_empty_graph_not_a_crash():
    graph = build_graph([], [], [])
    assert graph["stats"] == {
        "facts": 0, "entities": 0, "mentions": 0, "shares": 0,
        "isolated": 0, "hub_entities": [],
    }


# ── reader ─────────────────────────────────────────────────────────────
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
def store(tmp_path) -> Path:
    path = tmp_path / "memory_store.db"
    connection = sqlite3.connect(path)
    connection.executescript(SCHEMA)
    connection.execute(
        "INSERT INTO facts (fact_id, content, category, tags, trust_score,"
        " retrieval_count, helpful_count, created_at, updated_at)"
        " VALUES (1, 'Router pins T4', 'project', 'router, tiers', 0.95, 3, 2,"
        " '2026-07-01 10:00:00', '2026-07-02 11:00:00')"
    )
    connection.execute(
        "INSERT INTO entities (entity_id, name, entity_type, aliases)"
        " VALUES (10, 'capability-router', 'unknown', 'router, cr')"
    )
    connection.execute("INSERT INTO fact_entities VALUES (1, 10)")
    connection.commit()
    connection.close()
    return path


def test_the_reader_translates_the_stores_packed_columns(store):
    """tags and aliases are comma-joined strings on disk, lists to a caller."""
    reader = MemoryStoreReader(store)

    fact_row = reader.facts()[0]
    assert fact_row.tags == ("router", "tiers"), "whitespace after commas is stripped"
    assert fact_row.entity_ids == (10,)
    assert fact_row.as_dict()["trust"] == 0.95

    entity_row = reader.entities()[0]
    assert entity_row.aliases == ("router", "cr")
    assert entity_row.fact_count == 1, "the reader counts the entity's facts"


def test_the_reader_never_takes_a_write_lock_on_the_live_store(store):
    """The agent writes to this file continuously.

    An observability surface must not be able to lock or corrupt it, so every
    connection is read-only — a write attempt through the reader's own path must
    be refused by SQLite itself.
    """
    reader = MemoryStoreReader(store)
    connection = reader._connect()
    try:
        with pytest.raises(sqlite3.OperationalError):
            connection.execute("DELETE FROM facts")
    finally:
        connection.close()


def test_a_missing_store_raises_instead_of_looking_empty(tmp_path):
    """"No memories" and "cannot read the memories" are different claims.

    Reporting the first when the second is true is the worst thing this surface
    could do, so the reader refuses to guess.
    """
    reader = MemoryStoreReader(tmp_path / "absent.db")
    with pytest.raises(StoreUnavailable) as excinfo:
        reader.facts()
    assert "absent.db" in str(excinfo.value)
