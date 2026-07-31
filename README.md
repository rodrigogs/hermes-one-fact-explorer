# Hermes One Fact Explorer

A read-only local explorer for the Holographic Memory fact store used by
Hermes Agent.

The product answers three operational questions:

1. What does the agent know?
2. Why is a fact trusted?
3. What knowledge cannot currently be reached?

The list is the primary interface. A graph view is available for inspecting
relationships, but it is not treated as the product's default when the live
store is too dense for topology to be informative.

## Components

- `memory/` — local SQLite reader and loopback-only HTTP sidecar;
- `webui_extension/` — Hermes One panel assets;
- `tests/` — Python and Node regression tests.

The service is read-only. Every content-bearing route requires the token
injected by the Hermes One consented sidecar proxy. It has no memory write
endpoint.

## Development

```bash
python3 -m pytest -q
node --test tests/*.js
node --check webui_extension/hermes-one-fact-explorer/memory-nav.js
```

## Runtime safety

Never commit a fact-store database, a sidecar token, profile configuration,
credentials or generated cache files. The sidecar must remain loopback-only.

## License

MIT. See [LICENSE](LICENSE).
