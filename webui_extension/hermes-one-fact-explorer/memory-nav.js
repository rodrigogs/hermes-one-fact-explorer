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
  // hermes-one-extension-kit/hermes-panel-nav.js for what that fixes and why.
  const EXT_ID = 'hermes-one-fact-explorer';
  const SIDE = `/api/extensions/${EXT_ID}/sidecar`;
  const PANEL_ID = 'hermes-one-fact-explorer-panel';
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
    panel = el('section', 'main-view hermes-panel hermes-one-fact-explorer-panel');
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
      // Not once: a reload replaces the document and the observer with it.
      frame.addEventListener('load', watchModes);
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
    // Re-open of an already-loaded console: the frame fired 'load' long ago.
    watchModes();
  }

  /** The sidebar's mode list, kept so the console can report back into it. */
  let sideNav = null;
  let modeObserver = null;

  // The Office's shape, applied here.
  //
  // This console carried a 43px masthead reading "Memory" directly under a rail icon
  // already lit and labelled Fact Explorer, with the List/Graph switch beside it.
  // The Office lost the same masthead for the same reason. Here the two VIEW MODES
  // become the sidebar — the rail picks the panel, the sidebar picks the mode — and
  // the head keeps the search field, which has no other home.
  //
  // The head mirrors the host's .panel-head: 11px/600 uppercase at .08em in --muted,
  // 41px min-height, one hairline below, measured off the running shell.
  function buildSidebar(view) {
    const head = el('div', 'panel-head');
    const title = document.createElement('span');
    title.textContent = 'Fact Explorer';
    head.append(title);
    view.append(head);

    const list = el('nav', 'facts-modes');
    list.setAttribute('aria-label', 'Modo de visualiza\u00e7\u00e3o');
    for (const [id, label] of [['modeList', 'Lista'], ['modeGraph', 'Grafo']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'facts-mode';
      button.dataset.mode = id;
      button.textContent = label;
      // Same-origin, so drive the console's own control rather than duplicating its
      // state: one source of truth for which mode is up.
      button.addEventListener('click', () => selectMode(id));
      list.append(button);
    }
    view.append(list);
    sideNav = list;
    syncModes();
  }

  function selectMode(id) {
    const frame = document.querySelector('.hermes-one-fact-explorer-panel [data-console-frame]');
    try {
      const doc = frame && frame.contentDocument;
      const button = doc && doc.getElementById(id);
      if (button) button.click();
    } catch (error) {
      console.warn('[hermes-one-fact-explorer] cannot reach the console modes', error);
    }
    syncModes();
  }

  /** Mirror aria-selected from the console's mode buttons onto the sidebar rows. */
  function syncModes() {
    if (!sideNav) return;
    const frame = document.querySelector('.hermes-one-fact-explorer-panel [data-console-frame]');
    let doc = null;
    try { doc = frame && frame.contentDocument; } catch (error) { return; }
    for (const row of sideNav.querySelectorAll('.facts-mode')) {
      const button = doc && doc.getElementById(row.dataset.mode);
      const on = button ? button.getAttribute('aria-selected') === 'true' : false;
      row.classList.toggle('is-on', on);
      row.setAttribute('aria-current', on ? 'true' : 'false');
    }
    // The store's own tally, so the column says how much there is to read.
    const tally = doc && doc.getElementById('tally');
    let note = sideNav.parentElement.querySelector('.facts-tally');
    const text = tally ? tally.textContent.replace(/\s+/g, ' ').trim() : '';
    if (text) {
      if (!note) { note = el('p', 'facts-tally'); sideNav.parentElement.append(note); }
      note.textContent = text;
    } else if (note) note.remove();
  }

  /** Re-mirror once the console document exists; buildSidebar runs before it does. */
  function watchModes() {
    const frame = document.querySelector('.hermes-one-fact-explorer-panel [data-console-frame]');
    if (!frame) return;
    let doc = null;
    try { doc = frame.contentDocument; } catch (error) { return; }
    const modes = doc && doc.querySelector('.modes');
    if (!modes) return;
    syncModes();
    if (modeObserver) modeObserver.disconnect();
    modeObserver = new MutationObserver(syncModes);
    // #tally lives outside .modes, so observe the shell and filter on what moves.
    modeObserver.observe(doc.querySelector('.shell') || modes, {
      subtree: true, attributes: true, attributeFilter: ['aria-selected'],
      childList: true, characterData: true,
    });
  }

  if (!window.HermesPanelNav) {
    console.error('[hermes-one-fact-explorer] Hermes One Extension Kit did not load; the Graph '
      + 'button cannot be installed. Check that "hermes-one-extension-kit" is listed BEFORE '
      + '"hermes-one-fact-explorer" in extensions.json.');
    return;
  }

  nav = window.HermesPanelNav.register({
    token: 'memory',
    // "Graph", not "Memory": the host already has a native Memory panel in the
    // same list, and two buttons reading Memory that open different screens is a
    // guess the operator has to make every time. The tooltip carries the full
    // name.
    label: 'Facts',
    title: 'Fact Explorer',
    iconPath: ICON,
    navClass: 'hermes-one-fact-explorer-nav',
    onOpen,
    // Beside the host's own Memory tab, because that is where someone looking for
    // what the agent knows will look. Previously this landed after Settings while
    // its two siblings landed after Kanban.
    after: 'memory',
    sidebarView: buildSidebar,
  });
})();
