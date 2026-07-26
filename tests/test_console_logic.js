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

const sourcePath = 'webui_extension/memory-graph/console.html';

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

test('trust bands are distinct, so a half-believed fact never looks certain', () => {
  const { api } = loadConsole();
  assert.equal(api.trustBand(0.2), 't-low');
  assert.equal(api.trustBand(0.5), 't-mid');
  assert.equal(api.trustBand(0.95), 't-high');
  // The boundaries must not overlap or a fact would carry two bands.
  assert.notEqual(api.trustBand(0.44), api.trustBand(0.45));
  assert.notEqual(api.trustBand(0.69), api.trustBand(0.7));
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
  const warning = textOf(dom.get('warning'));
  assert.match(warning, /unavailable/i);
  assert.match(warning, /no memory store/);
});

test('facts with no topic are surfaced as a finding, not silently dropped', () => {
  const { api, dom } = loadConsole();
  seed(api);
  api.renderWarning();
  const text = textOf(dom.get('warning'));
  // Topic-based recall cannot reach them, so they are effectively write-only.
  assert.match(text, /1 facts have no topic/);
  assert.equal(api.state.facts.length, 3, 'and they remain nodes on the graph');
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
  assert.match(text, /shares capability-router/);
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
  api.layout(900, 560);
  api.select(api.factKey(1));
  const focused = { ...api.state.view };
  api.select(api.factKey(1));
  assert.equal(api.state.selected, null);
  // The view must not stay zoomed into a node the operator just dismissed.
  assert.notEqual(`${api.state.view.k}`, `${focused.k}`);
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
