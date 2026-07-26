"""Read-only view over the holographic fact store.

Every query here opens the database with ``mode=ro`` and ``immutable=0``: the
agent writes to this file continuously, and an observability surface must never
be able to corrupt, lock or block the thing it observes. The reader takes no
write locks and holds no long transactions.

The store keeps facts, entities and a fact↔entity join table. It does NOT store
fact↔fact edges, so the graph a reader needs is derived here (two facts that
share an entity are related) rather than invented or persisted.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


class StoreUnavailable(RuntimeError):
    """The store could not be opened or read.

    Raised rather than swallowed: a memory surface that silently renders an
    empty graph when the database is missing tells the operator the memory is
    empty, which is a different and much worse claim.
    """


@dataclass(frozen=True)
class Fact:
    fact_id: int
    content: str
    category: str
    tags: Tuple[str, ...]
    trust_score: float
    retrieval_count: int
    helpful_count: int
    created_at: str
    updated_at: str
    entity_ids: Tuple[int, ...] = field(default=())

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.fact_id,
            "content": self.content,
            "category": self.category,
            "tags": list(self.tags),
            "trust": round(self.trust_score, 4),
            "retrievals": self.retrieval_count,
            "helpful": self.helpful_count,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "entities": list(self.entity_ids),
        }


@dataclass(frozen=True)
class Entity:
    entity_id: int
    name: str
    entity_type: str
    aliases: Tuple[str, ...]
    fact_count: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.entity_id,
            "name": self.name,
            # Every row in this deploy is 'unknown'; the reader reports what is
            # stored rather than guessing a type from the name.
            "type": self.entity_type,
            "aliases": list(self.aliases),
            "facts": self.fact_count,
        }


def _split(raw: Optional[str]) -> Tuple[str, ...]:
    """Split the store's comma-joined tag/alias columns."""
    if not raw:
        return ()
    return tuple(part.strip() for part in str(raw).split(",") if part.strip())


class MemoryStoreReader:
    """Read-only queries over one profile's ``memory_store.db``."""

    def __init__(self, db_path: Path) -> None:
        self._path = Path(db_path)

    @property
    def path(self) -> Path:
        return self._path

    def _connect(self) -> sqlite3.Connection:
        if not self._path.exists():
            raise StoreUnavailable(f"no memory store at {self._path}")
        try:
            connection = sqlite3.connect(f"file:{self._path}?mode=ro", uri=True)
        except sqlite3.Error as exc:
            raise StoreUnavailable(f"could not open {self._path}: {exc}") from exc
        connection.row_factory = sqlite3.Row
        return connection

    def _query(self, sql: str, params: Sequence[Any] = ()) -> List[sqlite3.Row]:
        connection = self._connect()
        try:
            return list(connection.execute(sql, tuple(params)))
        except sqlite3.Error as exc:
            raise StoreUnavailable(f"query failed: {exc}") from exc
        finally:
            connection.close()

    # ── facts ──────────────────────────────────────────────────────────
    def facts(self) -> List[Fact]:
        links: Dict[int, List[int]] = {}
        for row in self._query("SELECT fact_id, entity_id FROM fact_entities"):
            links.setdefault(row["fact_id"], []).append(row["entity_id"])
        rows = self._query(
            "SELECT fact_id, content, category, tags, trust_score, retrieval_count,"
            " helpful_count, created_at, updated_at FROM facts ORDER BY fact_id"
        )
        return [
            Fact(
                fact_id=row["fact_id"],
                content=row["content"] or "",
                category=row["category"] or "general",
                tags=_split(row["tags"]),
                trust_score=float(row["trust_score"] or 0.0),
                retrieval_count=int(row["retrieval_count"] or 0),
                helpful_count=int(row["helpful_count"] or 0),
                created_at=str(row["created_at"] or ""),
                updated_at=str(row["updated_at"] or ""),
                entity_ids=tuple(sorted(links.get(row["fact_id"], ()))),
            )
            for row in rows
        ]

    def entities(self) -> List[Entity]:
        counts: Dict[int, int] = {}
        for row in self._query(
            "SELECT entity_id, COUNT(*) AS n FROM fact_entities GROUP BY entity_id"
        ):
            counts[row["entity_id"]] = int(row["n"])
        rows = self._query(
            "SELECT entity_id, name, entity_type, aliases FROM entities ORDER BY entity_id"
        )
        return [
            Entity(
                entity_id=row["entity_id"],
                name=row["name"] or "",
                entity_type=row["entity_type"] or "unknown",
                aliases=_split(row["aliases"]),
                fact_count=counts.get(row["entity_id"], 0),
            )
            for row in rows
        ]

    def mentions(self) -> List[Tuple[int, int]]:
        """The stored fact↔entity edges, as ``(fact_id, entity_id)``."""
        return [
            (row["fact_id"], row["entity_id"])
            for row in self._query(
                "SELECT fact_id, entity_id FROM fact_entities ORDER BY fact_id, entity_id"
            )
        ]
