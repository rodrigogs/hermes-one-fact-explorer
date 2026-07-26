"""Entrypoint: ``python -m memory`` starts the read-only memory sidecar."""

from __future__ import annotations

import argparse

from .sidecar import DEFAULT_PORT, MemorySidecarApp, resolve_store_path, serve
from .store_reader import MemoryStoreReader


def main() -> None:
    parser = argparse.ArgumentParser(description="Hermes memory graph sidecar (read-only)")
    parser.add_argument("--host", default="127.0.0.1",
                        help="ignored; the sidecar is loopback-only by design")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--store", default=None, help="path to memory_store.db")
    args = parser.parse_args()

    store = args.store or resolve_store_path()
    app = MemorySidecarApp(MemoryStoreReader(store))
    print(f"memory sidecar on 127.0.0.1:{args.port} reading {store}", flush=True)
    serve(port=args.port, app=app)


if __name__ == "__main__":
    main()
