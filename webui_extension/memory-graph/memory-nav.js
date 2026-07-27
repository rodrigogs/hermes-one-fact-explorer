(() => {
  'use strict';

  /*
   * THESIS: The agent's knowledge deserves a place in the shell, next to the
   *   sessions it was learned from.
   * OWN-WORLD: The host's rail and main-view; the console owns its own world.
   * STORY: An operator taps Graph, the constellation opens in the central panel,
   *   and tapping a node explains itself.
   * FIRST VIEWPORT: The console's own — this file adds no chrome above it.
   * FORM: Hermes One rail/sidebar extension, not a new application route.
   */
  // Mounted in the host document rather than opened standalone, for the same
  // reason as the router console: the WebUI grants its CSRF token only to pages
  // it renders itself. This surface is read-only so it needs no token today, but
  // being same-origin is what lets it reach the consented sidecar proxy with the
  // session cookie at all.
  //
  // Navigation and visibility come from the shared HermesPanelNav; see
  // hermes-panel/hermes-panel-nav.js for what that fixes and why.
  const EXT_ID = 'memory-graph';
  const SIDE = `/api/extensions/${EXT_ID}/sidecar`;
  const PANEL_ID = 'memory-graph-panel';
  const ICON = '<circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="17" r="2.4"/>'
    + '<circle cx="19" cy="17" r="2.4"/><path d="M10.4 6.8 6.6 14.9"/>'
    + '<path d="M13.6 6.8l3.8 8.1"/><path d="M7.4 17h9.2"/>';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  let nav = null;

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = el('section', 'main-view hermes-panel memory-graph-panel');
    panel.id = PANEL_ID;
    // srcdoc, not src: the sidecar refuses to be framed by URL, and srcdoc
    // inherits this document's origin so the proxy call carries the cookie.
    const frame = el('iframe', 'hp-frame');
    frame.title = 'Memory graph';
    frame.dataset.consoleFrame = 'true';
    panel.append(frame);
    document.querySelector('main')?.append(panel);
    if (nav) nav.adopt(panel);
    return panel;
  }

  async function load(panel) {
    const frame = panel.querySelector('[data-console-frame]');
    if (!frame || frame.dataset.loaded === 'true') return;
    try {
      const response = await fetch(`${SIDE}/console`, {
        credentials: 'same-origin',
        headers: { Accept: 'text/html' },
      });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      frame.srcdoc = await response.text();
      frame.dataset.loaded = 'true';
    } catch (error) {
      renderError(panel, error);
    }
  }

  function renderError(panel, error) {
    panel.querySelector('[data-console-frame]')?.remove();
    let message = panel.querySelector('.hp-error');
    if (!message) {
      message = el('div', 'hp-error');
      message.setAttribute('role', 'alert');
      message.setAttribute('aria-live', 'assertive');
      panel.append(message);
    }
    const code = error?.status || '?';
    message.textContent = code === 403
      ? 'Sidecar proxy not consented. Approve it in Settings → Extensions, then refresh.'
      : code === 503
        ? 'Memory sidecar is not running. Start hermes-memory-sidecar, then refresh.'
        : `Could not reach the memory sidecar (HTTP ${code}).`;
  }

  function onOpen() {
    const panel = ensurePanel();
    if (nav) nav.show();
    load(panel);
  }

  if (!window.HermesPanelNav) {
    console.error('[memory-graph] hermes-panel extension did not load; the Graph '
      + 'button cannot be installed. Check that "hermes-panel" is listed BEFORE '
      + '"memory-graph" in extensions.json.');
    return;
  }

  nav = window.HermesPanelNav.register({
    token: 'memory',
    // "Graph", not "Memory": the host already has a native Memory panel in the
    // same list, and two buttons reading Memory that open different screens is a
    // guess the operator has to make every time. The tooltip carries the full
    // name.
    label: 'Graph',
    title: 'Memory graph',
    iconPath: ICON,
    navClass: 'memory-graph-nav',
    onOpen,
    // Beside the host's own Memory tab, because that is where someone looking for
    // what the agent knows will look. Previously this landed after Settings while
    // its two siblings landed after Kanban.
    after: 'memory',
  });
})();
