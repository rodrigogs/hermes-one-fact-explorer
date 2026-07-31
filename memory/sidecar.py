"""Loopback HTTP sidecar exposing the memory as a browsable graph.

Read-only by construction. The Hermes memory is the agent's accumulated
knowledge; an editing path here would let a browser bug delete something the
agent learned weeks ago and cannot re-derive. Observation first — the existing
`fact_store` tool remains the only writer.

Shape mirrors the capability-router sidecar so the WebUI's consented same-origin
proxy and token-v1 auth work unchanged: stdlib ThreadingHTTPServer bound to
127.0.0.1, every data route behind the shared token, /health and /console exempt
because they carry no memory content.
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from .graph import build_graph
from .store_reader import MemoryStoreReader, StoreUnavailable

DEFAULT_PORT = 8792
_TOKEN_HEADER = "X-Hermes-Sidecar-Token"


def resolve_store_path() -> Path:
    """Locate the active profile's fact store.

    HERMES_HOME is already profile-scoped inside a running agent, so appending
    profiles/<name> to it yields .../profiles/x/profiles/x — the bug that made
    router compaction unreachable. Peel instead of append.
    """
    explicit = os.environ.get("HERMES_MEMORY_STORE_FILE")
    if explicit:
        return Path(explicit)
    home = os.environ.get("HERMES_HOME")
    base = Path(home) if home else Path.home() / ".hermes"
    if base.parent.name == "profiles":
        return base / "memory_store.db"
    profile = os.environ.get("HERMES_PROFILE", "")
    if not profile:
        return base / "memory_store.db"
    return base / "profiles" / profile / "memory_store.db"


def resolve_token_path() -> Path:
    home = os.environ.get("HERMES_HOME")
    base = Path(home) if home else Path.home() / ".hermes"
    return base / "webui" / "sidecar-auth" / "hermes-one-fact-explorer.token"


def _error(status: int, message: str) -> Tuple[int, Dict[str, Any]]:
    return status, {"error": message}


class MemorySidecarApp:
    """Routing and authorisation, with no socket in sight.

    Kept transport-free so the whole surface is testable by calling dispatch()
    directly — an HTTP-only design is what lets auth bugs hide.
    """

    # /console is served by the transport as HTML, not through dispatch.
    _GET_ROUTES = ("/health", "/graph", "/facts", "/entities", "/stats")

    def __init__(
        self,
        reader: MemoryStoreReader,
        token_path: Callable[[], Path] = resolve_token_path,
        console_path: Optional[Path] = None,
    ) -> None:
        self._reader = reader
        self._token_path = token_path
        self._console_path = console_path or default_console_path()

    # ── auth ───────────────────────────────────────────────────────────
    def _expected_token(self) -> Optional[str]:
        try:
            return self._token_path().read_text(encoding="utf-8").strip() or None
        except OSError:
            return None

    def _authorised(self, headers: Dict[str, str]) -> bool:
        expected = self._expected_token()
        if not expected:
            return False
        presented = ""
        for name, value in (headers or {}).items():
            if name.lower() == _TOKEN_HEADER.lower():
                presented = str(value).strip()
                break
        return bool(presented) and presented == expected

    def render_console(self) -> Tuple[int, bytes, str]:
        """Return the console shell as ``(status, body, content_type)``.

        Auth-exempt like /health: it is the empty container the browser loads,
        and every datum it shows is fetched afterwards through the token-gated
        routes. It answers text/html — the nav reads this body straight into an
        iframe srcdoc, so a JSON envelope here would render as literal JSON.
        """
        try:
            return 200, self._console_path.read_bytes(), "text/html; charset=utf-8"
        except OSError as exc:
            body = json.dumps({"error": f"console asset unreadable: {exc}"}).encode("utf-8")
            return 404, body, "application/json; charset=utf-8"

    # ── dispatch ───────────────────────────────────────────────────────
    def dispatch(
        self,
        method: str,
        path: str,
        headers: Dict[str, str],
        query: Optional[Dict[str, Any]] = None,
    ) -> Tuple[int, Dict[str, Any]]:
        parts = urlparse(path)
        route = parts.path.rstrip("/") or "/health"

        # The method check comes before auth so a wrong verb never reads as an
        # auth failure, and this surface has no unsafe verbs to confuse it with.
        if method != "GET":
            return _error(405, "the memory graph is read-only")
        if route not in self._GET_ROUTES:
            return _error(404, "unknown route")

        if route == "/health":
            return 200, {"ok": True, "store": str(self._reader.path),
                         "present": self._reader.path.exists()}

        if not self._authorised(headers):
            return _error(401, "sidecar token required")

        try:
            if route == "/facts":
                return 200, {"facts": [f.as_dict() for f in self._reader.facts()]}
            if route == "/entities":
                return 200, {"entities": [e.as_dict() for e in self._reader.entities()]}
            graph = build_graph(
                self._reader.facts(), self._reader.entities(), self._reader.mentions()
            )
        except StoreUnavailable as exc:
            # 503, not 200-with-empty: the caller must be able to tell "the
            # memory is empty" from "the memory could not be read".
            return _error(503, str(exc))

        if route == "/stats":
            return 200, graph["stats"]
        return 200, graph


def default_console_path() -> Path:
    return Path(__file__).resolve().parent.parent / "webui_extension" / "hermes-one-fact-explorer" / "console.html"


class _Handler(BaseHTTPRequestHandler):
    server_version = "HermesMemorySidecar/1.0"
    app: MemorySidecarApp

    def do_GET(self) -> None:  # noqa: N802 - stdlib signature
        if urlparse(self.path).path.rstrip("/") == "/console":
            status, body, content_type = self.app.render_console()
            self._send(status, body, content_type)
            return
        status, payload = self.app.dispatch("GET", self.path, dict(self.headers),
                                            parse_qs(urlparse(self.path).query))
        self._respond(status, payload)

    def do_POST(self) -> None:  # noqa: N802 - stdlib signature
        self._respond(*self.app.dispatch("POST", self.path, dict(self.headers)))

    def _respond(self, status: int, payload: Dict[str, Any]) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # This surface is read-only, but the page that renders it must still not
        # be framable by a third party.
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: Any) -> None:
        """Silence per-request logging: fact content must not reach a log."""


def serve(port: int = DEFAULT_PORT, app: Optional[MemorySidecarApp] = None) -> None:
    handler = type("_BoundHandler", (_Handler,), {
        "app": app or MemorySidecarApp(MemoryStoreReader(resolve_store_path())),
    })
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
