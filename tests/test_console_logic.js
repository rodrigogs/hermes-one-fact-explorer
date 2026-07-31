// Behavioural tests for the graph console's own logic — the part a static scan
// cannot check and a screenshot cannot prove.
//
// The riskiest claims live here: that fact ids and entity ids are namespaced (a
// fact and an entity both start at 1, so conflating them wires nodes to the
// wrong neighbours), that the layout is deterministic, and that focus and search
// narrow the picture rather than lying about it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = 'webui_extension/hermes-one-fact-explorer/console.html';

function fakeDom() {
  const nodes = new Map();
  const make = (id) => {
    const node = {
      id, className: '', textContent: '', value: '', type: '', title: '',
      hidden: false, style: {}, dataset: {}, attrs: {}, children: [],
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
      append(...k) { node.children.push(...k); },
      appendChild(k) { node.children.push(k); return k; },
      removeChild(k) { node.children = node.children.filter((x) => x !== k); },
      addEventListener() {},
      setAttribute(n, v) { node.attrs[n] = String(v); },
      getAttribute(n) { return node.attrs[n]; },
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 900, height: 560, left: 0, top: 0, right: 900 }),
    };
    Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
    return node;
  };
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, make(id)); return nodes.get(id); };
  return {
    get,
    document: {
      documentElement: make('html'),
      getElementById: get,
      createElement: (tag) => Object.assign(make(`el:${tag}`), { tagName: tag }),
      createElementNS: (_ns, tag) => Object.assign(make(`svg:${tag}`), { tagName: tag }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      readyState: 'complete',
    },
  };
}

// Collect text from the whole subtree: the inspector nests groups inside groups,
// and a two-level walk silently misses the very lines under test.
function textOf(node) {
  const own = node.textContent || '';
  const kids = (node.children || []).map(textOf).join(' ');
  return `${own} ${kids}`.trim();
}

function loadConsole({ fetchStub } = {}) {
  const html = fs.readFileSync(sourcePath, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    // Skip the init calls that need a live browser; keep everything else intact.
    .replace(/\n      wire\(\);[\s\S]*?load\(\);\n/, '\n');
  const dom = fakeDom();
  const top = {};
  const win = { innerWidth: 1440, innerHeight: 900, addEventListener() {}, top };
  win.self = top;
  const context = {
    console, window: win, document: dom.document, globalThis: {},
    fetch: fetchStub || (() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') })),
    setTimeout() {}, Math, JSON, Number, Object, Array, String, Set, Map, Date,
    encodeURIComponent,
  };
  vm.runInNewContext(script, context, { filename: sourcePath });
  return { api: context.globalThis.__memory, dom };
}

// A graph where fact 1 and entity 1 both exist — the id-collision trap.
function seed(api) {
  api.state.facts = [
    { id: 1, content: 'Router pins hard verbs to T4', category: 'project', tags: ['router'], trust: 0.95, helpful: 2, retrievals: 0, created_at: '2026-07-01', entities: [1] },
    { id: 2, content: 'Sidecar listens on 8791', category: 'tool', tags: [], trust: 0.5, helpful: 0, retrievals: 0, created_at: '2026-07-02', entities: [1] },
    { id: 3, content: 'A fact nothing was extracted from', category: 'general', tags: [], trust: 0.4, helpful: 0, retrievals: 0, created_at: '2026-07-03', entities: [] },
  ];
  api.state.entities = [{ id: 1, name: 'capability-router', type: 'unknown', aliases: ['cr'], facts: 2 }];
  api.state.edges = [
    { kind: 'mentions', source: 1, target: 1 },
    { kind: 'mentions', source: 2, target: 1 },
    { kind: 'shares', source: 1, target: 2, weight: 1, via: ['capability-router'] },
  ];
  api.state.stats = { facts: 3, entities: 1, mentions: 2, shares: 1, isolated: 1, hub_entities: [] };
  // The response carries both: stats.isolated is a count and isolated_facts are
  // the ids. graph.py:93 builds them together, so a seed that sets one without
  // the other is not a shape the sidecar can produce.
  api.state.isolatedIds = [3];
  api.state.loading = false;
  api.buildModel();
}

test('fact ids and entity ids are namespaced, so nodes never cross-wire', () => {
  const { api } = loadConsole();
  seed(api);
  // Both a fact and an entity have id 1 here. Without namespacing, the mention
  // edge fact-1 -> entity-1 would become a self-loop and the entity would
  // inherit the fact's neighbours.
  assert.notEqual(api.factKey(1), api.entityKey(1));
  const factNode = api.state.byId.get(api.factKey(1));
  const entityNode = api.state.byId.get(api.entityKey(1));
  assert.equal(factNode.kind, 'fact');
  assert.equal(entityNode.kind, 'entity');

  const selfLoops = api.state.links.filter((l) => l.from.key === l.to.key);
  assert.equal(selfLoops.length, 0, 'no node may be linked to itself');
});

test('every derived link keeps the evidence that produced it', () => {
  const { api } = loadConsole();
  seed(api);
  const shares = api.state.links.filter((l) => l.kind === 'shares');
  assert.equal(shares.length, 1);
  // The inspector prints this verbatim; losing it would leave the operator with
  // a line they cannot verify.
  assert.equal(shares[0].via.join(','), 'capability-router');
});

test('a fact is sized by how connected it is, not by how new it is', () => {
  const { api } = loadConsole();
  seed(api);
  const connected = api.state.byId.get(api.factKey(1));
  const isolated = api.state.byId.get(api.factKey(3));
  assert.equal(connected.degree, 1);
  assert.equal(isolated.degree, 0, 'an unlinked fact must not borrow a degree');
});

test('the layout is deterministic, so the map is the same on every visit', () => {
  // Math.random would reshuffle the constellation on each load and destroy any
  // spatial familiarity an operator builds up.
  const first = loadConsole();
  seed(first.api);
  first.api.layout(900, 560);
  const a = first.api.state.nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`);

  const second = loadConsole();
  seed(second.api);
  second.api.layout(900, 560);
  const b = second.api.state.nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`);

  assert.equal(a.join(' '), b.join(' '));
  // Match a CALL, not the word: the source documents why it avoids randomness,
  // and a bare substring search flagged that comment as the defect.
  const script = fs.readFileSync(sourcePath, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(!/Math\.random\s*\(/.test(script), 'a random seed makes the map unrecognisable');
});

test('layout keeps every node inside a sane area, including isolated ones', () => {
  const { api } = loadConsole();
  seed(api);
  api.layout(900, 560);
  // Repulsion with no centring pushes disconnected nodes off screen forever.
  api.state.nodes.forEach((node) => {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), 'no NaN positions');
    assert.ok(Math.abs(node.x - 450) < 3000 && Math.abs(node.y - 280) < 3000);
  });
});

test('fit frames the whole graph rather than cropping it', () => {
  const { api } = loadConsole();
  seed(api);
  api.layout(900, 560);
  api.fit(900, 560);
  const { k } = api.state.view;
  assert.ok(k > 0 && k <= 1.7, 'scale stays within the declared bounds');
  assert.ok(Number.isFinite(api.state.view.x) && Number.isFinite(api.state.view.y));
});

test('search matches what an operator remembers about a fact', () => {
  const { api } = loadConsole();
  seed(api);
  const fact = api.state.byId.get(api.factKey(1));
  for (const q of ['router', 'PROJECT', 'hard verbs']) {
    assert.ok(api.matches(fact, q.toLowerCase()), `"${q}" should match`);
  }
  assert.equal(api.matches(fact, 'nonexistent'), false);
  // An entity is findable by its aliases, which is the only place they appear.
  const entity = api.state.byId.get(api.entityKey(1));
  assert.ok(api.matches(entity, 'cr'));
  assert.ok(api.matches(entity, ''), 'an empty query hides nothing');
});

test('neighbours are symmetric: focus works from either end of an edge', () => {
  const { api } = loadConsole();
  seed(api);
  assert.ok(api.neighbours(api.factKey(1)).has(api.factKey(2)));
  assert.ok(api.neighbours(api.factKey(2)).has(api.factKey(1)));
  assert.equal(api.neighbours(api.factKey(3)).size, 0, 'an isolated fact has none');
});

// The bands used to be <0.45 / <0.7 / else — thirds of the range, invented here.
// Measured against the live store that put the 37 facts sitting on the store's
// DEFAULT trust and the 6 sitting on the retrieval FLOOR in the same band, and
// painted a never-rated fact amber as though something had doubted it. The bands
// are now the store's own two constants, so each one names a mechanism.
test('trust bands are the store\'s own thresholds, not invented thirds', () => {
  const { api } = loadConsole();
  // ~/.hermes/config.yaml min_trust_threshold: 0.3, passed as min_trust to the
  // live retriever; store.py:23 trust_score REAL DEFAULT 0.5.
  assert.equal(api.TRUST_FLOOR, 0.3, 'the floor is the retrieval threshold');
  assert.equal(api.TRUST_DEFAULT, 0.5, 'the default is what add records');

  // Below the floor: retrieval will not serve it at all.
  assert.equal(api.trustBand(0.2), 't-floor');
  // On the floor is still servable, so it is NOT the same band as below it.
  assert.equal(api.trustBand(0.3), 't-low');
  assert.notEqual(api.trustBand(0.29), api.trustBand(0.3),
    'the floor itself must not read as unreachable');
  // Doubted but servable.
  assert.equal(api.trustBand(0.45), 't-low');
  // Exactly default: nothing has rated it. This is the band that did not exist.
  assert.equal(api.trustBand(0.5), 't-default');
  assert.notEqual(api.trustBand(0.5), api.trustBand(0.45),
    'a never-rated fact must not look doubted');
  assert.notEqual(api.trustBand(0.5), api.trustBand(0.55),
    'nor must it look promoted');
  // Above default.
  assert.equal(api.trustBand(0.55), 't-high');
  assert.equal(api.trustBand(0.95), 't-high');
});

test('every trust value is explained in the store\'s terms, never as a bare number', () => {
  const { api } = loadConsole();
  // The old inspector printed "trust 0.5" and left the operator to guess whether
  // that was good. Each band must name the mechanism that put it there.
  assert.match(api.trustWhy(0.2), /recall floor/, 'below the floor says it cannot be served');
  assert.match(api.trustWhy(0.2), /will not serve/);
  assert.match(api.trustWhy(0.3), /floor/, 'on the floor says it is first to be dropped');
  assert.match(api.trustWhy(0.45), /default/);
  assert.match(api.trustWhy(0.5), /Nothing has rated/, 'default means unrated, and must say so');
  assert.match(api.trustWhy(0.95), /default/);
  // And it must never claim a CAUSE it cannot know. Trust above the default can
  // come from feedback OR from an explicit value at add time, and /graph cannot
  // tell them apart — measured live: 61 facts above 0.50, only 16 with any
  // helpful_count at all.
  for (const t of [0.2, 0.3, 0.45, 0.5, 0.75, 0.95, 1]) {
    assert.doesNotMatch(api.trustWhy(t), /upvot|because .*helpful/i,
      `trustWhy(${t}) must not attribute the value to feedback it cannot verify`);
  }
});

test('selecting the same node twice returns to the whole picture', () => {
  const { api } = loadConsole();
  seed(api);
  api.select(api.factKey(1));
  assert.equal(api.state.selected, api.factKey(1));
  api.select(api.factKey(1));
  assert.equal(api.state.selected, null, 'a second click must clear the focus');
});

test('an unreachable memory is reported, never rendered as an empty graph', async () => {
  const { api, dom } = loadConsole({
    fetchStub: () => Promise.resolve({
      ok: false, status: 503,
      text: () => Promise.resolve(JSON.stringify({ error: 'no memory store at /x/db' })),
    }),
  });
  await api.load();
  assert.equal(api.state.error, 'no memory store at /x/db');
  assert.equal(api.state.loading, false);
  const notice = textOf(dom.get('notice'));
  assert.match(notice, /unavailable/i);
  assert.match(notice, /no memory store/, 'the notice must name the problem, not just report one');
  // And the inspector must not sit on "Reading the store…" forever.
  const side = textOf(dom.get('side'));
  assert.match(side, /could not read/i);
  assert.match(side, /no memory store/);
});

test('facts with no topic are surfaced as a finding AND are reachable', () => {
  const { api, dom } = loadConsole();
  seed(api);
  api.renderNotice();
  const text = textOf(dom.get('notice'));
  // Topic-based recall cannot reach them, so they are effectively write-only.
  assert.match(text, /1 fact has no topic/, 'singular reads as English, not "1 facts"');
  assert.match(text, /recall cannot reach/);

  // The old console named the count here and stopped: the 5 live facts it named
  // could not be opened from anywhere on the screen. The notice is now the way in.
  assert.match(text, /Open them/, 'the finding must offer a destination');
  const notice = dom.get('notice').children[0];
  assert.equal(notice.tagName, 'button', 'and that destination must be operable');

  const scope = api.SCOPES.find((s) => s.id === 'notopic');
  assert.ok(scope, 'there must be a scope that isolates them');
  assert.equal(scope.count(), 1, 'counted from isolated_facts, not guessed');
  assert.equal(scope.pick().map((f) => f.id).join(','), '3');
  assert.equal(api.state.facts.length, 3, 'and they remain in the store either way');
});

test('the 5 unlinked facts of the live store are reachable by two different routes', () => {
  // The live store has 9 facts with no shared-topic edge, of which 5 have no
  // topic at all. Both groups were previously visible only as a lone disc on the
  // canvas, and the second group only as a number in a notice.
  const { api } = loadConsole();
  seed(api);
  const noTopic = api.SCOPES.find((s) => s.id === 'notopic');
  const noShared = api.SCOPES.find((s) => s.id === 'unlinked');
  // Fact 3 has no topic at all, so it is in both.
  assert.equal(noTopic.pick().map((f) => f.id).join(','), '3');
  assert.equal(noShared.pick().map((f) => f.id).join(','), '3');
  // isolated comes from the response, degree is counted here; they must agree
  // about a fact with no topic, or one of the two is lying.
  assert.equal(api.degreeOf(3), 0);
  assert.equal(api.degreeOf(1), 1, 'and a linked fact is in neither');
  assert.ok(!noShared.pick().some((f) => f.id === 1));
});

test('zoom keeps the point under the cursor fixed', () => {
  const { api } = loadConsole();
  seed(api);
  api.state.view = { x: 0, y: 0, k: 1 };
  api.zoomAt(2, 100, 50);
  // A naive scale would drift the graph out from under the pointer.
  assert.equal(api.state.view.k, 2);
  assert.equal(api.state.view.x, -100);
  assert.equal(api.state.view.y, -50);
});

test('zoom is clamped so the graph can never be scaled into nothing', () => {
  const { api } = loadConsole();
  seed(api);
  for (let i = 0; i < 40; i++) api.zoomAt(0.5);
  assert.ok(api.state.view.k >= 0.25);
  for (let i = 0; i < 40; i++) api.zoomAt(2);
  assert.ok(api.state.view.k <= 4);
});

test('the inspector explains a fact without requiring the graph', () => {
  const { api, dom } = loadConsole();
  seed(api);
  api.select(api.factKey(1));
  api.renderSide();
  const text = textOf(dom.get('side'));
  assert.match(text, /Router pins hard verbs to T4/);
  assert.match(text, /project/);
  // The relationship must state its evidence in words.
  assert.match(text, /via capability-router/);
  // Trust must arrive with its scale, never as a bare decimal.
  assert.match(text, /0\.95/);
  assert.match(text, /0\.30 recall floor/);
  assert.match(text, /0\.50 default/);
});

test('usage is labelled for what the counter actually counts', () => {
  const { api, dom } = loadConsole();
  seed(api);
  // Fact 1 is seeded with retrievals: 0. The old console printed that as
  // "recorded uses 0", which reads as a measurement of nothing.
  api.select(api.factKey(1));
  api.renderSide();
  let text = textOf(dom.get('side'));
  assert.match(text, /never served/i, 'zero must be stated as never served');
  assert.match(text, /has not reached the model/, 'and what that means for the agent');

  // helpful_count is upvotes only: store.py increments it on helpful=True and
  // leaves it untouched on a downvote, so 0 must not read as "rated unhelpful".
  assert.match(text, /upvotes only/);

  api.state.facts[1].retrievals = 7;
  api.select(api.factKey(1));
  api.select(api.factKey(2));
  api.renderSide();
  text = textOf(dom.get('side'));
  assert.match(text, /7×/, 'a real count is shown as a count');
  assert.match(text, /served this fact to the model/, 'and sourced to the retrieval path');
});

test('a zero-trust-feedback fact never claims feedback it does not have', () => {
  const { api, dom } = loadConsole();
  seed(api);
  // Fact 2 is trust 0.5 / helpful 0: the 37-fact majority case on the live store.
  api.select(api.factKey(2));
  api.renderSide();
  const text = textOf(dom.get('side'));
  assert.match(text, /Nothing has rated this fact/);
  assert.match(text, /does not mean it was rated unhelpful/,
    'absence of an upvote is not a downvote, and the copy must not imply it');
});

test('an isolated fact says why nothing relates to it', () => {
  const { api, dom } = loadConsole();
  seed(api);
  api.select(api.factKey(3));
  api.renderSide();
  const text = textOf(dom.get('side'));
  assert.match(text, /No topic was extracted/, 'the cause, not just the absence');
});

test('long fact content is shortened for the label but never for the inspector', () => {
  const { api } = loadConsole();
  const long = 'x'.repeat(200);
  assert.ok(api.shortLabel(long).length < 40);
  assert.ok(api.shortLabel(long).endsWith('…'));
  assert.equal(api.shortLabel('short'), 'short', 'no ellipsis where none is needed');
  // Whitespace in stored content must not break the label.
  assert.equal(api.shortLabel('a\n  b'), 'a b');
});

test('focusing a node brings it and its neighbours into view', () => {
  const { api } = loadConsole();
  seed(api);
  api.layout(900, 560);
  api.state.view = { x: 0, y: 0, k: 1 };

  api.centreOn(api.factKey(1));

  // A highlight the operator has to hunt for is not a focus. The focused node
  // must land near the middle of the canvas.
  const node = api.state.byId.get(api.factKey(1));
  const screenX = node.x * api.state.view.k + api.state.view.x;
  const screenY = node.y * api.state.view.k + api.state.view.y;
  assert.ok(Math.abs(screenX - 450) < 420, `x=${screenX} should be roughly centred`);
  assert.ok(Math.abs(screenY - 280) < 260, `y=${screenY} should be roughly centred`);
  assert.ok(api.state.view.k >= 0.3 && api.state.view.k <= 2.2, 'scale stays bounded');
});

test('clearing the focus returns to the whole constellation', () => {
  const { api } = loadConsole();
  seed(api);
  api.setMode('graph');
  api.layout(900, 560);
  api.state.view = { x: 0, y: 0, k: 1 };
  api.select(api.factKey(1));
  const focused = { ...api.state.view };
  api.select(api.factKey(1));
  assert.equal(api.state.selected, null);
  // The view must not stay zoomed into a node the operator just dismissed.
  assert.notEqual(`${api.state.view.k}`, `${focused.k}`);
});

test('selecting in the list does not move a canvas nobody is looking at', () => {
  // The list is the default view, so most selections happen with the graph
  // hidden — where getBoundingClientRect is 0x0 and centring on it would compute
  // a view from a zero box, then keep it.
  const { api } = loadConsole();
  seed(api);
  api.layout(900, 560);
  assert.equal(api.state.mode, 'list', 'the list is the default');
  // Field by field, not deepEqual: state.view is created inside the vm realm, so
  // its prototype is the sandbox's Object.prototype and strict deepEqual compares
  // prototypes. The values are what this test is about.
  const before = { ...api.state.view };
  api.select(api.factKey(1));
  assert.equal(api.state.view.k, before.k, 'a list selection must not rescale the view');
  assert.equal(api.state.view.x, before.x, 'nor pan it');
  assert.equal(api.state.view.y, before.y);
  assert.equal(api.state.selected, api.factKey(1), 'but it must still select');
});

test('centring an isolated node does not divide by zero', () => {
  const { api } = loadConsole();
  seed(api);
  api.layout(900, 560);
  // Fact 3 has no neighbours, so the bounding box of the focus group is a point.
  assert.doesNotThrow(() => api.centreOn(api.factKey(3)));
  assert.ok(Number.isFinite(api.state.view.k) && api.state.view.k > 0);
  assert.ok(Number.isFinite(api.state.view.x));
});

test('focusing a crowded hub does not zoom into an unreadable mat', () => {
  const { api } = loadConsole();
  // A hub with many facts: the live store's "Hermes" entity has 29.
  api.state.facts = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, content: `Fact number ${i} about Hermes and its configuration`,
    category: 'project', tags: [], trust: 0.6, helpful: 0, retrievals: 0,
    created_at: '2026-07-01', entities: [1],
  }));
  api.state.entities = [{ id: 1, name: 'Hermes', type: 'unknown', aliases: [], facts: 30 }];
  api.state.edges = api.state.facts.map((f) => ({ kind: 'mentions', source: f.id, target: 1 }));
  api.state.stats = { facts: 30, entities: 1, mentions: 30, shares: 0, isolated: 0, hub_entities: [] };
  api.state.loading = false;
  api.buildModel();
  api.layout(900, 560);

  api.centreOn(api.entityKey(1));

  // Scaling to fit 30 neighbours crammed them into the middle and blew every
  // label up on top of its neighbour.
  assert.ok(api.state.view.k <= 0.85 + 1e-9,
    `a 30-node focus must stay zoomed out, got k=${api.state.view.k}`);
});

test('a small focus group is allowed a closer zoom than a crowded one', () => {
  // Geometry still has the final say — three nodes laid out 1200px apart cannot
  // be shown closer than the canvas allows — so this asserts the CAP, which is
  // the part centreOn controls.
  const { api } = loadConsole();
  seed(api);
  api.layout(900, 560);

  // Same span, different crowd: the cap must be the only difference.
  const nodes = api.state.nodes;
  nodes.forEach((n, i) => { n.x = 450 + (i % 2) * 40; n.y = 280 + i * 20; });
  api.centreOn(api.factKey(1));
  const smallGroupK = api.state.view.k;

  assert.ok(smallGroupK > 0.85,
    `a 3-node focus over a small span should zoom in, got ${smallGroupK}`);
});

// ── touch ────────────────────────────────────────────────────────────────
// The graph was pan-by-mousedown and zoom-by-wheel, so on a phone — where this
// panel is now reachable from the drawer — it could not be panned or zoomed at
// all. These pin the arithmetic of the replacement; the gesture plumbing itself
// (pointer capture, touch-action) is asserted in test_touch_contract.js, which
// can read the source for the parts a stub DOM cannot exercise.

test('zooming keeps the point under the fingers fixed', () => {
  const { api } = loadConsole();
  seed(api);
  api.layout(900, 560);
  api.state.view = { k: 1, x: 0, y: 0 };

  // The graph coordinate currently under screen point (300, 200)...
  const graphX = (300 - api.state.view.x) / api.state.view.k;
  const graphY = (200 - api.state.view.y) / api.state.view.k;

  api.zoomTo(2, 300, 200);

  // ...must still be under it afterwards. A zoom that drifts makes pinch feel
  // like the graph is fighting the hand.
  const afterX = graphX * api.state.view.k + api.state.view.x;
  const afterY = graphY * api.state.view.k + api.state.view.y;
  assert.ok(Math.abs(afterX - 300) < 0.001, `x drifted to ${afterX}`);
  assert.ok(Math.abs(afterY - 200) < 0.001, `y drifted to ${afterY}`);
  assert.equal(api.state.view.k, 2);
});

test('pinch cannot reach a scale the buttons refuse', () => {
  // A pinch is absolute — spread ratio times the scale at gesture start — so
  // without a shared clamp a two-finger fling could reach 40x while the zoom-in
  // button stopped at 4x, and there would be no way back except Fit.
  const { api } = loadConsole();
  seed(api);
  api.layout(900, 560);

  assert.equal(api.clampScale(999), 4, 'the ceiling must hold');
  assert.equal(api.clampScale(0.0001), 0.25, 'the floor must hold');
  assert.equal(api.clampScale(1.5), 1.5, 'anything in range passes through');

  api.state.view = { k: 1, x: 0, y: 0 };
  api.zoomTo(999, 450, 280);
  assert.equal(api.state.view.k, 4);
  api.zoomTo(0.0001, 450, 280);
  assert.equal(api.state.view.k, 0.25);
});

test('a zoom to the scale already in effect changes nothing', () => {
  // Pinch fires a move event per frame, most of them reporting a spread that
  // rounds to the same scale. Recomputing the translation each time accumulated
  // float error and made a held pinch slowly slide the graph.
  const { api } = loadConsole();
  seed(api);
  api.layout(900, 560);
  api.state.view = { k: 1.5, x: 120, y: 90 };
  api.zoomTo(1.5, 300, 200);
  assert.deepEqual(api.state.view, { k: 1.5, x: 120, y: 90 });
});

test('the first paint never renders nodes too small to see', () => {
  // fit() was Math.min(fitX, fitY, 1.7) with a ceiling and no floor. On a 390px
  // phone canvas with 461 nodes spread over ~2000 units that yields k≈0.21 —
  // every node a 2-6px speck, every label unreadable, and below the 0.25 the
  // zoom buttons themselves refuse to go. Overflowing and letting the operator
  // pan is strictly better than painting something nobody can read.
  const { api } = loadConsole();
  seed(api);
  api.layout(900, 560);
  // Spread the nodes far enough that an unclamped fit would go well under 0.25.
  api.state.nodes.forEach((n, i) => { n.x = i * 4000; n.y = i * 3000; });

  api.fit(390, 500);
  assert.ok(api.state.view.k >= 0.25,
    `first paint must respect the zoom floor, got k=${api.state.view.k}`);
});

test('a phone canvas does not spend a quarter of its width on padding', () => {
  // 54px of margin each side of a 390px canvas is 28% of the width given to
  // nothing, which on top of the floor above leaves very little graph.
  const { api } = loadConsole();
  seed(api);
  api.layout(900, 560);
  api.state.nodes.forEach((n, i) => { n.x = 100 + i * 60; n.y = 100 + i * 40; });

  api.fit(390, 500);
  const phoneK = api.state.view.k;
  api.fit(900, 560);
  const deskK = api.state.view.k;
  // Same graph, narrower canvas: the phone must not be penalised twice, once by
  // width and again by a desktop-sized margin.
  assert.ok(phoneK > 0, 'a phone fit must produce a usable scale');
  assert.ok(deskK > 0, 'and so must a desktop one');
});

// ── the list leads, the graph is a mode ──────────────────────────────────────
// This was the graph as the default view. The decision to demote it is measured,
// not stylistic — see the file header of console.html for the three numbers — and
// these tests pin the mechanisms that decision produced, so a future change that
// quietly restores the old default fails here.

test('the list is the first viewport and the graph is a named mode', () => {
  const { api } = loadConsole();
  assert.equal(api.state.mode, 'list',
    'a 16%-dense graph of 461 nodes cannot answer what/why/unreachable, so it does not open');
  api.setMode('graph');
  assert.equal(api.state.mode, 'graph', 'but it must be one click away');
  api.setMode('list');
  assert.equal(api.state.mode, 'list');
});

test('the canvas hides topics that cannot express a relationship, and says how many', () => {
  const { api, dom } = loadConsole();
  // Two topics: one linking two facts, one carrying a single fact. The live store
  // is 275 of the second kind out of 357 topics — 59.7% of the nodes the old
  // default drew were diamonds with one edge.
  api.state.facts = [
    { id: 1, content: 'a', category: 'tool', tags: [], trust: 0.5, helpful: 0, retrievals: 0, created_at: '2026-07-01', entities: [1, 2] },
    { id: 2, content: 'b', category: 'tool', tags: [], trust: 0.5, helpful: 0, retrievals: 0, created_at: '2026-07-02', entities: [1] },
  ];
  api.state.entities = [
    { id: 1, name: 'shared', type: 'unknown', aliases: [], facts: 2 },
    { id: 2, name: 'lonely', type: 'unknown', aliases: [], facts: 1 },
  ];
  api.state.edges = [{ kind: 'shares', source: 1, target: 2, weight: 1, via: ['shared'] }];
  api.state.stats = { facts: 2, entities: 2, mentions: 3, shares: 1, isolated: 0, hub_entities: [] };
  api.state.loading = false;
  api.buildModel();

  assert.equal(api.LINKING_MIN_FACTS, 2, 'one fact cannot make a relationship');
  // join, not deepEqual: arrays derived from vm-realm arrays carry the sandbox's
  // Array.prototype, which strict deepEqual rejects regardless of contents.
  const drawn = api.state.nodes.filter((n) => n.kind === 'entity').map((n) => n.entity.name);
  assert.equal(drawn.join(','), 'shared', 'the single-fact topic is not drawn by default');
  // But the DATA is whole: the inspector must still name it and the Topics scope
  // must still list it.
  assert.equal(api.state.entities.length, 2, 'filtering the canvas must not drop data');
  assert.equal(api.topicsOf(api.state.facts[0]).length, 2,
    'the fact still knows both of its topics');

  // And the graph must confess the omission with a real count.
  api.renderLegend();
  const legend = textOf(dom.get('legend'));
  assert.match(legend, /1 topic carrying a single fact hidden/,
    'a hidden node must be declared, with its count');
  // The count and its explanation are separate elements because the 640px block
  // hides the explanation on a phone. The COUNT must never be the part that goes:
  // a graph that silently drops 275 of 357 topics is lying by omission.
  const why = dom.get('legend').children
    .flatMap((p) => p.children || [])
    .filter((s) => s.className === 'why');
  assert.equal(why.length, 1, 'the explanation is its own element, so CSS can drop it');
  assert.doesNotMatch(why[0].textContent, /\d/,
    'and no number may live inside the droppable part');

  // Asking for all of them must actually draw them.
  api.setGraphTopics('all');
  const all = api.state.nodes.filter((n) => n.kind === 'entity').map((n) => n.entity.name);
  assert.equal([...all].sort().join(','), 'lonely,shared', 'the operator can still see everything');
});

test('a subject selected while filtered out of the canvas is still inspectable', () => {
  // Selecting a single-fact topic from the Topics list, then having the canvas
  // not contain that node, must not blank the inspector.
  const { api, dom } = loadConsole();
  seed(api);
  api.state.entities.push({ id: 9, name: 'solo', type: 'unknown', aliases: [], facts: 1 });
  api.buildModel();
  assert.equal(api.state.byId.has(api.entityKey(9)), false, 'not a node');
  api.select(api.entityKey(9));
  api.renderSide();
  const text = textOf(dom.get('side'));
  assert.match(text, /solo/, 'the inspector resolves it from the data, not the canvas');
  assert.match(text, /links nothing/, 'and explains why the graph omits it');
});

test('node size is described as exposure, never as importance', () => {
  // The old "Most connected" list ranked facts by edge count. Measured on the
  // live store: 350 of 857 edges (41%) have "Hermes" as their ONLY evidence and
  // "Hermes" is 36.6% of all via mentions — so that ranking measured how often
  // one near-universal token appears.
  const { api, dom } = loadConsole();
  seed(api);
  api.renderLegend();
  const legend = textOf(dom.get('legend'));
  assert.match(legend, /sized by shared topics/,
    'the legend must say what the size means');
  assert.doesNotMatch(legend, /important|most connected/i);

  // And the no-selection panel must rank by what the agent DID, not by degree.
  api.state.facts[0].retrievals = 9;
  api.state.selected = null;
  api.renderSide();
  const side = textOf(dom.get('side'));
  assert.match(side, /Most served to the model/);
  assert.doesNotMatch(side, /Most connected/,
    'a word-frequency ranking must not be presented as significance');
});

// ── search reports itself ────────────────────────────────────────────────────

test('search always states its match count', () => {
  const { api, dom } = loadConsole();
  seed(api);
  api.renderTally();
  assert.match(textOf(dom.get('tally')), /3 facts/, 'the unfiltered total is stated too');

  // 'hard verbs' appears in fact 1 only. ('router' would match TWO facts here,
  // because fact 2's topic is named capability-router and search reads topic
  // names — which is the feature, not a miscount.)
  api.state.query = 'hard verbs';
  api.renderTally();
  const text = textOf(dom.get('tally'));
  // "of" is the load-bearing part: 1 alone cannot be told from a broken filter.
  assert.match(text, /1 of 3 facts/, 'a filtered view must state both numbers');
});

test('a query that matches nothing says so, and offers a way out', () => {
  const { api, dom } = loadConsole();
  seed(api);
  api.state.query = 'zzzznotathing';
  api.renderList();
  const text = textOf(dom.get('rows'));
  // The old console dimmed every node and left a canvas of grey specks with no
  // words on it at all.
  assert.match(text, /No fact matches/, 'the zero state must be named');
  assert.match(text, /zzzznotathing/, 'and must quote what was searched');
  assert.match(text, /content, category, tags and topic names/,
    'and say what search actually reads, so the operator can retry usefully');
  assert.match(text, /Clear search/, 'and the recovery must be a control');
});

test('search reads topic names, so a fact is findable by what it is about', () => {
  const { api } = loadConsole();
  seed(api);
  // "capability-router" is the TOPIC of fact 2, and appears nowhere in its
  // content, category or tags.
  const f = api.state.facts[1];
  assert.equal(f.content.includes('capability-router'), false);
  assert.ok(api.matchesFact(f, 'capability-router'),
    'a fact must be findable by its topic');
  assert.ok(api.matchesFact(f, 'cr'), 'and by that topic\'s alias');
});

test('a zero-match scope is never offered as a filter', () => {
  const { api, dom } = loadConsole();
  seed(api);
  // Nothing in this seed is below the recall floor, so "Under default trust"
  // must be absent rather than present and permanently empty.
  api.state.facts.forEach((f) => { f.trust = 0.8; });
  api.renderScopes();
  const labels = dom.get('scopes').children.map((b) => textOf(b));
  assert.ok(!labels.some((l) => /Under default trust/.test(l)),
    'a filter that can only be empty must not be shown');
  assert.ok(labels.some((l) => /All facts/.test(l)), 'All is always available');
});

test('every scope count is derived from the response, never asserted', () => {
  const { api } = loadConsole();
  seed(api);
  for (const scope of api.SCOPES) {
    const count = scope.count();
    assert.ok(Number.isInteger(count) && count >= 0, `${scope.id} must count an integer`);
    if (scope.id === 'topics') continue;
    assert.equal(scope.pick().length, count,
      `${scope.id} must return exactly as many rows as it claims`);
  }
});

test('sorting by trust and by usage reads the real fields', () => {
  const { api } = loadConsole();
  seed(api);
  api.state.facts[0].retrievals = 5;
  api.state.facts[2].retrievals = 12;

  api.state.sort = 'served';
  assert.equal(api.visible().rows.map((f) => f.id).join(','), '3,1,2');

  api.state.sort = 'trust';
  assert.equal(api.visible().rows.map((f) => f.id).join(','), '3,2,1',
    'lowest trust first: 0.4, 0.5, 0.95');
});

test('the wordmark is gone and the header is the host\'s own shape', () => {
  const html = fs.readFileSync(sourcePath, 'utf8');
  // "MEMORY / HERMES ONE" was a 54px masthead announcing the product inside the
  // product. The host rail already says which surface this is.
  assert.doesNotMatch(html, /class="brand/, 'the wordmark element must be gone');
  assert.doesNotMatch(html, /Hermes One/, 'and so must the product name');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  // The host's measured .main-view-header / .main-view-title.
  const head = css.match(/\.head \{([\s\S]*?)\}/);
  assert.ok(head, 'there must be a header rule');
  assert.match(head[1], /min-height: 41px/, 'the host measures 41px');
  assert.match(head[1], /padding: 8px/, 'and 8px vertical padding');
  const title = css.match(/\.head-title \{([\s\S]*?)\}/);
  assert.match(title[1], /600 var\(--t-head\)/, '18px/600');
  assert.match(title[1], /var\(--sans\)/, 'SANS, not the mono of a wordmark');
  assert.doesNotMatch(title[1], /text-transform: uppercase/, 'and not tracked caps');
});

test('the palette is inherited from the shell, never hard-coded', () => {
  const css = fs.readFileSync(sourcePath, 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
  const root = css.match(/:root \{([\s\S]*?)\n    \}/)[1];
  // The host ships 21 skins x light/dark. A hard-coded palette is wrong in 20 of
  // them, and in any light skin this console was a black rectangle inside a
  // parchment shell.
  for (const token of ['--bg', '--surface', '--text', '--muted', '--accent', '--line']) {
    const decl = root.match(new RegExp(`\\n\\s*${token}:\\s*([^;]+);`));
    assert.ok(decl, `${token} must be declared`);
    assert.match(decl[1], /var\(--host-/,
      `${token} must read a forwarded host token, not a literal colour`);
  }
  // The old fallbacks may remain ONLY as fallbacks, after a comma.
  const bare = root.match(/\n\s*--(?:bg|surface|text|accent):\s*#[0-9a-f]{3,8}\s*;/i);
  assert.equal(bare, null, 'no bare hex may sit in a colour token');
  // And the polarity has to come from the shell too, or a light skin gets dark
  // scrollbars and form controls.
  assert.match(root, /color-scheme: var\(--host-color-scheme/);
});

test('nothing in the console can inject markup', () => {
  // Fact content and topic names are attacker-influenceable text: they are
  // whatever went into the store. Every insertion path must be textContent.
  const html = fs.readFileSync(sourcePath, 'utf8');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) {
    assert.ok(!html.includes(sink), `${sink} must not appear anywhere`);
  }
  assert.doesNotMatch(html, /new Function/);
});

test('the console never writes, matching a sidecar that answers 405', () => {
  const script = fs.readFileSync(sourcePath, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  // memory/sidecar.py returns 405 "the memory graph is read-only" for any verb
  // but GET, so a write control here could only ever produce an error.
  assert.doesNotMatch(script, /method:\s*['"]POST/i);
  assert.doesNotMatch(script, /method:\s*['"](PUT|PATCH|DELETE)/i);
  const fetches = script.match(/fetch\([^)]*\)/g) || [];
  assert.ok(fetches.length >= 1, 'it does fetch');
  assert.equal(fetches.filter((f) => /method/i.test(f)).length, 0,
    'every fetch is a default GET');
});
