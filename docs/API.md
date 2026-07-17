# API

Interactive OpenAPI documentation is served at `/api/docs`.

- `GET /api/v1/health` — component health.
- `GET /api/v1/alerts?limit=&offset=` — paginated alert log.
- `GET /api/v1/history/{symbol}` — recent complete market states.
- `GET /api/v1/configuration` — active validated configuration.
- `POST /api/v1/replay` — synchronous historical replay request.
- `POST /api/v1/live/start` and `/live/stop` — engine lifecycle.
- `WS /api/v1/stream` — `market_state`, `alert`, and `system_event` envelopes.

Production should place the API behind SSO/mTLS and a reverse proxy. The application
does not include order execution; that boundary must have independent risk controls,
authorization, idempotency, and kill switches.

