# Embedded OAuth 2.1 — v0.6 developer preview

Panter-ai can be its own authorization server. No Keycloak, Auth0, external identity provider or model API key is required.

## Deployment configuration

```dotenv
PANTER_AUTH_MODE=embedded
PANTER_PUBLIC_MCP_URL=https://panter.example.org/mcp
PANTER_BIND_HOST=0.0.0.0
PANTER_ALLOWED_HOSTS=panter.example.org
PANTER_ALLOWED_ORIGINS=https://chatgpt.com,https://claude.ai,https://claude.com,https://grok.com,https://gemini.google.com
PANTER_DATA_DIR=/data
PANTER_CONSENT_PASSWORD=<random secret with 32+ characters>
PANTER_OAUTH_REDIRECT_URIS=https://chatgpt.com/connector_platform_oauth_redirect,https://claude.ai/api/mcp/auth_callback
```

**Never commit actual values.** Add other redirect URLs *only after verifying the callback for the real host*. These example redirect URIs are not proof of current eligibility or compatibility of any plan. `/data` must be an owner-private, persistent volume. Use one Panter-ai instance/process; the ledger is an atomic JSON file rather than a multi-replica SQL database. Terminate HTTPS at your trusted proxy; never forward a public TLS-free consent endpoint. Do not expose the `dev-static` mode publicly.

## Human-approved identity and scope

1. A supported MCP client discovers `/.well-known/oauth-protected-resource` and the authorization server metadata.
2. A public client registers through `/register` with only preapproved exact HTTPS callbacks. DCR is strictly allowlisted and bounded; unknown redirect URLs fail.
3. `/authorize` requires code + PKCE S256, pins the exact `/mcp` resource and creates an expiring authorization request.
4. `/oauth/consent` displays the client, callback and host choices. The operator approves via a private password. Same-origin POST and a one-time CSRF token are required.
5. `/token` exchanges the one-time code (5-minute TTL) with its PKCE verifier. Access tokens are opaque and valid for 1 hour. Refresh tokens are issued only on requested `offline_access`, expire after 90 days and rotate. Reuse of an old refresh revokes the token family.
6. `/mcp` checks the hashed access token against its approved client + host grant on every request. The app never selects the actor via a tool parameter; GPT-A and GPT-B use distinct client registrations and approved host choices.
7. `/revoke` invalidates a token family. Connections can also be disabled by a trusted operator using `revokeClient`, which needs a separate authenticated admin surface before remote use.

**Authorization is not a mission grant.** Choosing a host at consent never authorizes a new mission or a write outside that host's existing tool permissions.

## Compatibility, testing and known limits

- `npm test` covers consent, DCR, PKCE, restart persistence, disjoint GPT identities, forged callbacks, origin/CSRF failures, one-time codes, refresh replay and revocation.
- `npm run smoke:embedded` connects two MCP SDK clients through genuine HTTP endpoints, completes a GPT-A → GPT-B → GPT-A delegation, and checks revocation 401.
- This is a **single-owner developer preview**; no production security audit, no multi-replica database or external audit trail, no multi-user operator accounts, no client credential secrets, and no live ChatGPT/Claude/Grok/Gemini OAuth E2E yet.
- The OAuth implementation uses Node standard cryptographic and HTTP primitives. A standards conformance/security review against the official MCP authorization profile is mandatory before production. DCR should be behind rate limits at the edge, and the consent password should be rotated regularly.
- `subscriptions/listen` requires negotiated and observed client support; it cannot make a closed ChatGPT session think autonomously.

External signed JWT remains available with `PANTER_AUTH_MODE=external-jwt` as an optional identity-provider integration.
