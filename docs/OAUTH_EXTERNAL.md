# External OAuth 2.1 resource-server adapter (v0.5 developer preview)

Panter-ai now accepts externally issued **RS256 JWT access tokens**. The authorization server (identity provider) is responsible for user login, consent, PKCE S256, client registration and token issuance. Panter-ai is a **resource server**: it validates public signatures and binds each authenticated application client to exactly one configured actor. It never asks for a model-provider inference API key and never treats a model name or user-supplied actor string as authentication.

This is not a production-ready identity deployment by itself. Each real application needs to complete its own OAuth flow against the configured identity provider. Only issue tokens to approved clients. **Do not expose the developer `dev-static` bearer mode publicly.**

## Required environment

```dotenv
PANTER_AUTH_MODE=external-jwt
PANTER_PUBLIC_MCP_URL=https://panter.example.org/mcp
PANTER_OAUTH_ISSUER=https://id.example.org
PANTER_OAUTH_JWKS_FILE=/run/panter-identity/jwks.json
PANTER_OAUTH_ACTORS_FILE=/run/panter-identity/actors.json
PANTER_ALLOWED_HOSTS=panter.example.org
PANTER_BIND_HOST=0.0.0.0
PANTER_ALLOWED_ORIGINS=https://chatgpt.com,https://claude.ai,https://claude.com,https://grok.com,https://gemini.google.com
```

The OAuth issuer metadata and authorization endpoints are **served by the external IdP**. Panter-ai publishes `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, and unauthorized `/mcp` requests include an RFC 9728 resource metadata link.

JWKS format: a local file with `{"keys":[{"kty":"RSA","kid":"...","alg":"RS256","use":"sig","n":"...","e":"..."}]}`. Keys must be public RSA 2048-bit or stronger. Provision via a trusted server operator, never from a caller-provided URL. Reload/restart Panter-ai after rotating signing keys, overlapping old/new public keys until old access tokens expire. The private signing key stays solely with the IdP.

Actor binding file example (replace sample `subject` and `clientId` with *observed, signed claims* issued by the chosen IdP):

```json
[
  { "host": "gpt-a", "subject": "owner-subject", "clientId": "chatgpt-orchestrator-client" },
  { "host": "gpt-b", "subject": "owner-subject", "clientId": "chatgpt-worker-client" },
  { "host": "grok", "subject": "owner-subject", "clientId": "grok-client" },
  { "host": "gemini", "subject": "owner-subject", "clientId": "gemini-client" },
  { "host": "claude", "subject": "owner-subject", "clientId": "claude-client" }
]
```

A valid token must be signed with an approved `kid` and `RS256` algorithm and include:

- Exact issuer (`iss`), exact Panter-ai `/mcp` resource in `aud`, valid `exp`/`iat` (and `nbf` if present).
- `sub` and `client_id` matching one configured `{host, subject, clientId}` tuple. **GPT-A and GPT-B must use separate client IDs even when the subject is the same**.
- `scope` containing `panter:mesh`. GPT-A additionally requires `panter:lead`.

Unknown clients, incorrect issuer/audience, malformed or expired tokens, invalid signatures, missing scopes and unregistered actor pairs are rejected. Host-specific tools enforce actor ownership in addition to the transport token.

This adapter does not host an authorization page, dynamic client registration or refresh token endpoint. Do not advertise this deployment as a full built-in OAuth authorization server. Choose an IdP that supports appropriate MCP redirect URIs, PKCE and JWT audience/scopes, and validate each real app connection.

## Local verification

```sh
npm install --no-audit --no-fund
npm run check && npm run build && npm test
npm run smoke:oauth
```

The smoke test generates throwaway RSA signing keys locally and starts Panter-ai on loopback. It verifies metadata discovery, rejection of an unregistered client, two distinct OAuth actors, leader-only configuration, and the GPT-A -> GPT-B -> GPT-A MCP delegation cycle. **It does not contact ChatGPT, Grok, Gemini, Claude or a real IdP**.

## Production release gates

1. Real IdP with PKCE, consent, issuer metadata, exact callback allowlists and refresh/revocation tested; prove auth against real clients, not fixture JWTs.
2. Protect externally exposed HTTPS with an access-controlled ingress and no unauthenticated direct origin path; do not trust forwarded origin/host headers.
3. Enforce per-project authorization, tool/side-effect scopes and production-grade tenant isolation before allowing shared server access.
4. Replace single-process JSON ledgers with transactional persistence and add backup/recovery, coordination idempotency and multi-replica event delivery before scaling.
5. Verify the **actual** host's subscription behavior, pickup and completion after an event; MCP `subscriptions/listen` alone does not start a closed host session.
6. Never put private signing keys, bearer tokens or identity config files in the public repository or the UI.
