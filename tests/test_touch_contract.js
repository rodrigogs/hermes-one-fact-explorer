// The gesture plumbing, which a stub DOM cannot exercise.
//
// A jsdom-free VM has no real hit-testing, no pointer capture and no notion of
// what the browser does with a drag BEFORE a listener runs — and that last one is
// where the original bug lived. The graph had correct-looking drag handlers and
// still could not be panned by finger, because with no touch-action the browser
// claimed the gesture as a page scroll and never dispatched a move to the SVG.
//
// So these read the source. That is a weaker test than behaviour and it is
// chosen deliberately: the alternative is asserting nothing about the one
// property that broke. Each assertion names a specific mechanism and would fail
// if that mechanism were removed — not a grep for a word that happens to appear.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const CONSOLE = 'webui_extension/memory-graph/console.html';
const html = () => fs.readFileSync(CONSOLE, 'utf8');

function styleBlock() {
  return html().match(/<style>([\s\S]*?)<\/style>/)[1];
}

function scriptBlock() {
  return html().match(/<script>([\s\S]*?)<\/script>/)[1];
}

test('the canvas claims both axes, or the browser scrolls the page instead', () => {
  const css = styleBlock();
  const graphRule = css.match(/#graph\s*\{([\s\S]*?)\}/);
  assert.ok(graphRule, '#graph must have a rule');
  // pan-x or pan-y would leave one axis to the browser, so a diagonal drag would
  // fight the graph. manipulation would leave pinch to the browser, which zooms
  // the whole document rather than the graph.
  assert.match(graphRule[1], /touch-action:\s*none/,
    'touch-action:none is what makes a finger drag reach the pointer handlers');
});

test('interaction is pointer-based, so one code path serves mouse and finger', () => {
  const js = scriptBlock();
  for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    assert.match(js, new RegExp(`addEventListener\\('${event}'`),
      `${event} must be handled`);
  }
  // pointercancel is the one people forget: the OS takes the pointer away (a
  // notification, a system gesture) and without it the graph stays stuck in
  // "dragging" forever, panning on every subsequent touch.
  assert.match(js, /pointercancel/, 'a cancelled gesture must reset the drag state');

  // The mouse-only handlers must be gone, not merely supplemented — two systems
  // both moving state.view double every mouse pan on hybrid devices.
  assert.doesNotMatch(js, /addEventListener\('mousedown'/, 'mousedown is superseded by pointerdown');
  assert.doesNotMatch(js, /addEventListener\('mousemove'/, 'mousemove is superseded by pointermove');
  assert.doesNotMatch(js, /addEventListener\('mouseup'/, 'mouseup is superseded by pointerup');
});

test('a second finger pinches instead of starting a second pan', () => {
  const js = scriptBlock();
  // Two fingers on a one-pointer pan handler means both drag the view, which
  // moves it twice as fast in the average of two directions — the graph appears
  // to fly away.
  assert.match(js, /touches\.size === 2/, 'the second pointer must switch modes');
  assert.match(js, /panning = false/, 'panning must stop when the pinch begins');
  // The scale must be measured from the spread at gesture start, not accumulated
  // per event.
  assert.match(js, /pinch\.k \* \(distance \/ pinch\.distance\)/,
    'pinch scale is absolute: start scale times spread ratio');
});

test('lifting one finger of a pinch does not make the graph jump', () => {
  const js = scriptBlock();
  // The remaining finger is somewhere else entirely; without re-anchoring, the
  // next pointermove computes a delta from the lifted finger's last position and
  // the graph leaps by that distance.
  assert.match(js, /re-anchor/i, 'the remaining pointer must be re-anchored');
  assert.match(js, /lastX = remaining\.x/, 'and that means resetting the pan origin');
});

test('a tap clears the focus but a drag does not', () => {
  const js = scriptBlock();
  // Without the slop test, every pan ended in a click that cleared the focus —
  // so panning while inspecting a node threw the inspection away. A finger never
  // holds perfectly still, which is why the threshold is not zero.
  assert.match(js, /moved < 8/, 'a small movement is still a tap');
  assert.match(js, /moved \+= Math\.abs\(dx\) \+ Math\.abs\(dy\)/,
    'movement must be accumulated to be compared');
});

test('touch targets meet the size the host requires', () => {
  const css = styleBlock();
  const coarse = css.match(/@media \(hover: none\) and \(pointer: coarse\)\s*\{([\s\S]*?)\n    \}/);
  assert.ok(coarse, 'there must be a coarse-pointer block, as the host has');
  // The zoom buttons were 26px squares over a canvas that pans by finger, so a
  // missed tap panned the graph instead of zooming.
  assert.match(coarse[1], /\.zoom button \{[^}]*width: 44px;[^}]*height: 44px/,
    'the zoom buttons must be 44px on touch');
  assert.match(coarse[1], /\.item \{[^}]*min-height: 44px/, 'inspector rows must be tappable');
  // The redesign made the LIST the primary surface, so its row is now the most
  // tapped control on the screen and needs the floor more than anything else does.
  assert.match(coarse[1], /\.row \{[^}]*min-height: 44px/, 'list rows must be tappable');
  // And every control the redesign added: the mode switch, the scope chips, the
  // graph's own topic toggle, and the recovery buttons in the empty state. A
  // control that only exists on the new design is exactly the one a copied
  // touch block forgets.
  assert.match(coarse[1], /\.mode \{[^}]*min-height: 44px/, 'the mode switch must be tappable');
  assert.match(coarse[1], /\.scope \{[^}]*min-height: 44px/, 'scope chips must be tappable');
  assert.match(coarse[1], /\.scope-graph[^}]*min-height: 44px/, 'the topic toggle must be tappable');
  assert.match(coarse[1], /\.btn[^}]*min-height: 44px/, 'empty-state recovery must be tappable');
});

test('the panel inherits the shell\'s theme rather than carrying a palette', () => {
  const css = styleBlock();
  // The host ships 21 skins x light/dark. Hard-coding #0a0a0c made this console a
  // black rectangle inside a parchment shell in every light skin. The bridge
  // forwards --host-* onto this frame's documentElement; the fallbacks after each
  // comma are the OLD palette and may only ever be fallbacks.
  const root = css.match(/:root \{([\s\S]*?)\n    \}/);
  assert.ok(root, 'there must be a :root token block');
  assert.match(root[1], /--bg: var\(--host-bg,/, 'the background must be inherited');
  assert.match(root[1], /--text: var\(--host-text,/);
  assert.match(root[1], /--accent: var\(--host-accent,/);
  // A light skin with dark scrollbars and dark form controls is the tell that the
  // polarity was hard-coded. The host carries it as a CLASS, so the bridge
  // resolves it into a property for us.
  assert.match(root[1], /color-scheme: var\(--host-color-scheme,/);
  // And nothing may re-hard-code a colour further down the sheet.
  const body = css.replace(/:root \{[\s\S]*?\n    \}/, '');
  const literal = body.match(/(?:^|[^-])(?:background|color|fill|stroke):\s*#[0-9a-fA-F]{3,8}/);
  assert.equal(literal, null,
    `no literal colour may be painted outside the token block, found ${literal && literal[0]}`);
});

test('the meta-viewport does not pin a colour scheme the shell may not use', () => {
  const html = require('node:fs').readFileSync(CONSOLE, 'utf8');
  // <meta name="color-scheme" content="dark"> forced dark UA styling on form
  // controls and scrollbars in all 21 light skins, ahead of any CSS.
  assert.doesNotMatch(html, /<meta[^>]*name="color-scheme"/,
    'polarity comes from the shell at runtime, not from a static meta');
});

test('the hint tells the truth about the gesture the hand can make', () => {
  const js = scriptBlock();
  assert.match(js, /pinch to zoom/, 'touch copy must exist');
  assert.match(js, /scroll to zoom/, 'mouse copy must remain for a mouse');
  // Chosen by pointer type, not by width: a narrow desktop window still has a
  // wheel, and a wide tablet still has fingers.
  assert.match(js, /function isTouch\(\)[\s\S]*?pointer:\s*coarse/,
    'the choice must be made on pointer capability');
  assert.match(js, /isTouch\(\)\s*\n?\s*\?\s*'drag to pan · pinch to zoom/,
    'the touch copy must be the one selected when isTouch() is true');
});

test('mobile heights use dvh, because vh lies on a phone', () => {
  const css = styleBlock();
  // vh measures the viewport as though the browser chrome were absent, so a
  // canvas sized in vh is taller than the space it actually has and its bottom
  // edge — where the zoom buttons live — sits under the chrome.
  const mobile = css.match(/@media \(max-width: 640px\)\s*\{([\s\S]*?)\n    \}/);
  assert.ok(mobile, 'there must be a 640px block, matching the host breakpoint');
  assert.match(mobile[1], /dvh/, 'the stacked canvas must be sized in dvh');
  assert.doesNotMatch(css, /height:\s*\d+vh/, 'no bare vh heights anywhere');
});

test('the mobile breakpoint is the host\'s, not one of our own', () => {
  const css = styleBlock();
  // The host hides the rail below 641px and makes the drawer the only
  // navigation. Changing shape at a different width than the shell around us is
  // how a panel starts feeling like a guest.
  assert.match(css, /@media \(max-width: 640px\)/, 'must use the host 640px breakpoint');
});

test('a focused input cannot trigger the iOS zoom trap', () => {
  const css = styleBlock();
  const coarse = css.match(/@media \(hover: none\) and \(pointer: coarse\)\s*\{([\s\S]*?)\n    \}/);
  assert.ok(coarse, 'the coarse-pointer block must exist');
  // iOS Safari zooms the page in when a focused input's font-size is under 16px
  // and does NOT zoom back out — the operator is left on a magnified,
  // sideways-scrolling console. The host fixes its own inputs at
  // hermes-webui/static/style.css:6597, but this console is a separate document
  // and inherits none of the host's CSS, so the rule must exist here.
  assert.match(coarse[1], /input, textarea, select \{ font-size: max\(16px, 1em\)/,
    'inputs need a 16px floor on touch, in this document');
  // max(), not a flat 16px: the floor must not shrink an input that is already
  // larger for a reason.
  assert.doesNotMatch(coarse[1], /input[^}]*font-size: 16px;/,
    'a flat 16px would override a deliberately larger field');
});

test('resize does not recompute the layout, only the framing', () => {
  const js = scriptBlock();
  const handler = js.match(/addEventListener\('resize',[\s\S]{0,900}?\n        \}\);/);
  assert.ok(handler, 'there must be a resize handler');
  // layout() is 420 iterations of an O(n^2) repulsion pass over 461 nodes. Running
  // it per resize event is expensive, but the real defect is that it re-seeds every
  // position from the viewport: an operator who panned somewhere and then opened
  // the keyboard came back to a DIFFERENT graph. Positions are a function of the
  // data, not of the box.
  assert.doesNotMatch(handler[0], /\blayout\(/,
    'a resize must not re-seed node positions');
  assert.match(handler[0], /\bfit\(/, 'it must re-frame the existing constellation');
  // Rotating a phone fires a burst of resize events; iOS fires several for one
  // rotation.
  assert.match(handler[0], /setTimeout/, 'the burst must be debounced');
  assert.match(handler[0], /clearTimeout/, 'and the pending one cancelled');
});

test('the phone split follows the task instead of halving the screen', () => {
  const css = styleBlock();
  const mobile = css.match(/@media \(max-width: 640px\)\s*\{([\s\S]*?)\n    \}/);
  assert.ok(mobile, 'there must be a 640px block');
  // Measured at 390x844: the frame is 791px tall, so an even split gave the LIST
  // — now the primary surface — 263px, which is two rows of a 104-fact list,
  // while the inspector spent its half on a four-line summary.
  assert.match(mobile[1], /\.stage \{ grid-template-rows: 62dvh/,
    'with nothing selected, scanning gets the room');
  assert.match(mobile[1], /\.stage\.has-subject \{ grid-template-rows: 34dvh/,
    'with a fact open, reading gets it');
  // dvh throughout, never vh: vh measures the viewport as though the browser
  // chrome were absent.
  assert.doesNotMatch(mobile[1], /\d+vh[^a-z]/, 'no bare vh in the mobile block');

  // And the class has to actually be driven, or the rule is decoration.
  const js = scriptBlock();
  assert.match(js, /classList\.toggle\('has-subject', !!state\.selected\)/,
    'the weighting must follow the real selection state');
});
