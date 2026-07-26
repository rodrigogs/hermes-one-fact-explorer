(() => {
  'use strict';

  /*
   * THESIS: The agent's knowledge deserves a place in the shell, next to the
   *   sessions it was learned from.
   * OWN-WORLD: The host's rail and main-view; the console owns its own world.
   * STORY: An operator clicks Memory, the constellation opens in the central
   *   panel, and clicking a node explains itself.
   * FIRST VIEWPORT: The console's own — this file adds no chrome above it.
   * FORM: Hermes One rail/sidebar extension, not a new application route.
   */
  // Mounted in the host document rather than opened standalone, for the same
  // reason as the router console: the WebUI grants its CSRF token only to pages
  // it renders itself. This surface is read-only so it needs no token today, but
  // being same-origin is what lets it reach the consented sidecar proxy with the
  // session cookie at all.
  const EXT_ID = 'memory-graph';
  const SIDE = `/api/extensions/${EXT_ID}/sidecar`;
  const PANEL_ID = 'memory-graph-panel';
  const icon =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="17" r="2.4"/><circle cx="19" cy="17" r="2.4"/><path d="M10.4 6.8 6.6 14.9"/><path d="M13.6 6.8l3.8 8.1"/><path d="M7.4 17h9.2"/></svg>';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = el('section', 'main-view memory-graph-panel');
    panel.id = PANEL_ID;
    panel.hidden = true;
    // srcdoc, not src: the sidecar refuses to be framed by URL, and srcdoc
    // inherits this document's origin so the proxy call carries the cookie.
    const frame = el('iframe', 'mg-frame');
    frame.title = 'Memory graph';
    frame.dataset.consoleFrame = 'true';
    panel.append(frame);
    document.querySelector('main')?.append(panel);
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
    let message = panel.querySelector('.mg-error');
    if (!message) {
      message = el('div', 'mg-error');
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

  function showPanel() {
    document.querySelectorAll('main > .main-view').forEach((view) => { view.hidden = view.id !== PANEL_ID; });
  }

  function onOpen() {
    const panel = ensurePanel();
    showPanel();
    load(panel);
  }

  function installRailButton() {
    const rail = document.querySelector('.rail');
    if (!rail) return false;
    if (rail.querySelector('[data-memory-graph]')) return true;
    const button = el('button', 'rail-btn nav-tab has-tooltip memory-graph-nav');
    button.type = 'button'; button.dataset.memoryGraph = 'true'; button.dataset.tooltip = 'Memory graph';
    button.setAttribute('aria-label', 'Memory graph');
    button.innerHTML = icon; // Trusted static icon only.
    button.addEventListener('click', onOpen);
    rail.insertBefore(button, rail.querySelector('.rail-spacer') || null);
    return true;
  }

  function installSidebarButton() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return false;
    if (nav.querySelector('[data-memory-graph]')) return true;
    const button = el('button', 'nav-tab has-tooltip has-tooltip--bottom memory-graph-nav');
    button.type = 'button'; button.dataset.memoryGraph = 'true'; button.dataset.tooltip = 'Memory graph';
    button.setAttribute('aria-label', 'Memory graph');
    button.innerHTML = `${icon}<span class="memory-graph-nav-label">Memory</span>`; // Trusted static markup only.
    button.addEventListener('click', onOpen);
    nav.append(button);
    return true;
  }

  function bootstrap() {
    if (installRailButton() && installSidebarButton()) return;
    const observer = new MutationObserver(() => { if (installRailButton() && installSidebarButton()) observer.disconnect(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  else bootstrap();
})();
