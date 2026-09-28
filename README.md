# Unified AI Memory Gateway

API-only Node.js/TypeScript gateway for using multiple AI providers through one authenticated URL. It stores session history, summaries, long-term memory, procedural memory, usage, and provider attempts. It does not execute tools; external agents remain responsible for tools and planning.

## Current capabilities

- OpenAI-compatible `POST /v1/chat/completions`
- Provider routes for OpenRouter, Gemini, Groq, NVIDIA, Mistral, and Cohere
- Model aliases with ordered fallback chains
- Retry, timeout, cooldown, and provider failover
- Session IDs through `X-Agent-ID` and `X-Session-ID`
- Persistent PostgreSQL storage with an in-memory development fallback
- Long-term semantic, procedural, and episodic memory records
- Rolling summaries and context-budget trimming
- Optional pgvector embeddings with keyword fallback
- Streaming pass-through for OpenAI-compatible providers and basic Cohere normalization
- Optional automatic continuation for non-streaming responses that hit the output limit
- Session and memory management endpoints
- No frontend and no provider keys stored in the database

## Run locally

1. Copy `.env.example` to `.env` and set `GATEWAY_API_KEY`.
2. Start PostgreSQL and Redis if you want persistence:

```bash
docker compose up -d
```

3. Install and run:

```bash
npm install
npm run dev
```

The API listens on `http://localhost:8787`.

If `DATABASE_URL` is empty, the gateway uses in-memory storage. That is useful for a quick smoke test but is not suitable for real memory persistence.

## Example request

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer replace-with-a-long-random-token" \
  -H "Content-Type: application/json" \
  -H "X-Agent-ID: personal-agent" \
  -H "X-Session-ID: demo-session" \
  -d '{
    "model": "balanced",
    "messages": [{"role":"user","content":"Remember that I prefer concise answers."}]
  }'
```

The model aliases are configured through `ROUTE_FAST`, `ROUTE_BALANCED`, `ROUTE_REASONING`, `ROUTE_LONG_CONTEXT`, and `ROUTE_CHEAP_SUMMARY`. Each route is a comma-separated priority list such as `groq:model-a,gemini:model-b`.

Use `POST /v1/sessions` to create a session, then send its ID through `X-Session-ID`. For memory administration, use `GET/POST/DELETE /v1/memories` with the same gateway key. For non-streaming responses, clients may set `auto_continue: true` and optionally `max_continuations`.

Provider base URLs can be overridden with `*_BASE_URL` environment variables for private endpoints and local contract testing.

## Important security rules

- Never commit `.env`.
- Never put provider keys in request bodies or database rows.
- Use Secret Manager-backed environment variables in Cloud Run.
- Keep `GATEWAY_API_KEY` long and random.
- Keep prompt logging disabled outside the database memory features.
- Rotate provider keys by updating the deployment secret and creating a new revision.

## Production notes

The in-memory fallback is intentionally available for development. Production should use PostgreSQL with pgvector enabled. Configure a compatible 1536-dimensional embedding model before enabling `EMBEDDING_PROVIDER`; otherwise memory search uses keyword matching.
