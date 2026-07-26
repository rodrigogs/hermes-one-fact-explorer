"""Derive a browsable graph from the fact store.

The store has no fact→fact edges. It has a fact↔entity join table, so relatedness
is derivable: two facts that mention the same entity are about the same thing.
That derivation is done here, in one place, because it is the claim the whole
graph view rests on — if it is wrong, every edge on screen is a lie.

Two edge kinds, never conflated:
  * ``mentions``  — fact → entity. Recorded by the agent. Ground truth.
  * ``shares``    — fact ↔ fact. Derived here, weighted by how many entities the
                    two facts have in common, and always carrying the names of
                    those entities so a reader can check the claim themselves.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Sequence, Tuple

from .store_reader import Entity, Fact

# An entity mentioned by nearly every fact ("Hermes") says nothing about which
# facts belong together — it would wire the graph into a useless hairball. Facts
# that share only such an entity get no edge.
_HUB_SHARE = 0.5


def _hub_entity_ids(facts: Sequence[Fact], entities: Sequence[Entity]) -> frozenset:
    """Entity ids too common to imply a relationship between two facts."""
    if not facts:
        return frozenset()
    limit = max(2, int(len(facts) * _HUB_SHARE))
    return frozenset(entity.entity_id for entity in entities if entity.fact_count > limit)


def shared_entity_edges(
    facts: Sequence[Fact], entities: Sequence[Entity]
) -> List[Dict[str, Any]]:
    """Undirected fact↔fact edges, one per pair, weighted by shared entities.

    Each edge names the entities it was derived from: an operator must be able to
    ask "why are these two connected?" and get an answer from the edge itself.
    """
    names = {entity.entity_id: entity.name for entity in entities}
    hubs = _hub_entity_ids(facts, entities)

    by_entity: Dict[int, List[int]] = {}
    for fact in facts:
        for entity_id in fact.entity_ids:
            if entity_id in hubs:
                continue
            by_entity.setdefault(entity_id, []).append(fact.fact_id)

    # Accumulate per unordered pair so each pair yields exactly one edge.
    pairs: Dict[Tuple[int, int], List[int]] = {}
    for entity_id, fact_ids in by_entity.items():
        ordered = sorted(fact_ids)
        for i, left in enumerate(ordered):
            for right in ordered[i + 1:]:
                pairs.setdefault((left, right), []).append(entity_id)

    edges = []
    for (left, right), entity_ids in sorted(pairs.items()):
        via = [names.get(eid, str(eid)) for eid in sorted(entity_ids)]
        edges.append({
            "kind": "shares",
            "source": left,
            "target": right,
            "weight": len(entity_ids),
            "via": via,
        })
    return edges


def mention_edges(mentions: Iterable[Tuple[int, int]]) -> List[Dict[str, Any]]:
    """Fact → entity edges exactly as the agent recorded them."""
    return [
        {"kind": "mentions", "source": fact_id, "target": entity_id}
        for fact_id, entity_id in mentions
    ]


def build_graph(
    facts: Sequence[Fact], entities: Sequence[Entity], mentions: Sequence[Tuple[int, int]]
) -> Dict[str, Any]:
    """Assemble the payload a graph view renders.

    Isolated facts are reported as a count, not hidden: a fact no entity was ever
    extracted from is invisible to entity-based retrieval, which is an operator
    finding rather than a rendering inconvenience.
    """
    shares = shared_entity_edges(facts, entities)
    linked = {fact.fact_id for fact in facts if fact.entity_ids}
    isolated = [fact.fact_id for fact in facts if fact.fact_id not in linked]
    hubs = _hub_entity_ids(facts, entities)

    return {
        "facts": [fact.as_dict() for fact in facts],
        "entities": [entity.as_dict() for entity in entities],
        "edges": mention_edges(mentions) + shares,
        "stats": {
            "facts": len(facts),
            "entities": len(entities),
            "mentions": len(mentions),
            "shares": len(shares),
            "isolated": len(isolated),
            # Named so the view can explain why a well-known entity draws no
            # fact-to-fact edges, instead of looking broken.
            "hub_entities": sorted(
                entity.name for entity in entities if entity.entity_id in hubs
            ),
        },
        "isolated_facts": isolated,
    }
