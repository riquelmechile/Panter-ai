# Oracle ARM64 developer deployment (not production)

Panter-ai can run on an ARM64 Linux VM with 4 OCPU, 16 GiB RAM and 150 GB disk. The server is an MCP **control plane**, not a model inference server. It does not require provider API keys. The AI hosts must connect through their own authorized MCP clients.

## Preflight

Run these commands from your own SSH session on the Oracle VM. Do not paste SSH keys, cloud credentials or peer bearer tokens into an issue or chat.

```sh
uname -m                         # expect aarch64
cat /etc/os-release
free -h
df -h /
command -v docker && docker compose version
command -v git && command -v gh
```

Install Git, Docker Engine with the Docker Compose plugin, and the GitHub CLI using their official ARM64 installation instructions if missing. Limit SSH to key-based logins through the OCI firewall and an access-controlled network path. Do not open port 8080 in the OCI security list.

## Run a private developer instance

Clone the repository only after the reviewed PR is merged or use the explicit feature branch for testing:

```sh
# Test branch; switch to the reviewed release branch for later deployments.
git clone --branch feat/initial-a2a-mesh-v0.3.0 https://github.com/riquelmechile/Panter-ai.git
cd Panter-ai
cp .env.example .env
chmod 600 .env
```

Generate distinct random tokens locally, for example `openssl rand -hex 32` for the admin token and one for each trusted host, then edit `.env` without displaying its contents in logs. Set a real `PANTER_TOKEN`, and optionally `PANTER_PEER_TOKENS` with five **different** strong random tokens. All tokens remain alpha-only; bearer identity does not yet provide interactive OAuth 2.1 consent, per-tool grants, issuer/audience binding, or full revocation.

```sh
docker compose -f compose.dev.yml up -d --build
docker compose -f compose.dev.yml ps
curl -fsS http://127.0.0.1:18080/health
```

The container listens internally on port 8080; Docker publishes it only to **127.0.0.1 of the Oracle host** at port **18080 by default** (set `PANTER_HOST_PORT` to another free local port in `.env`). Do not collide with an existing Xanxittoo or other Oracle service. To inspect remotely, use SSH local forwarding from a separate trusted workstation:

```sh
ssh -N -L 18080:127.0.0.1:18080 user@oracle-host
# On the trusted workstation: http://127.0.0.1:18080/health
```

A browser AI app on the public Internet **cannot** connect to a loopback-only MCP; this is intentional at the present security stage. Do not publish the MCP endpoint with a plain shared bearer. A production-facing endpoint requires HTTPS, OAuth 2.1 with PKCE, protected-resource discovery, per-host actor identification, scopes and consent, and a verified host-native acceptance test for each application.

## Validate the software and event stream

In a local checkout with an npm registry connection:

```sh
npm ci --no-audit --no-fund
npm run check
npm test
npm run build
npm run smoke:http
```

The smoke test opens a real MCP 2026-07-28 connection, requests a modern `subscriptions/listen` resource stream and observes an event after a state change. This verifies the transport and local callback, **not** autonomous reasoning or wake inside GPT-A, GPT-B, Grok, Gemini or Claude. Real host tests require explicit connections and permissions in each provider app.

## Persistence and recovery

The named Docker volume contains the JSON ledgers. Back up `/data` while stopping the service; the alpha persistence is serialized in **one process**, not transactional across replicas. Keep exactly one replica. After interrupted writes, reconcile work results before retrying effectful operations. Upgrades should preserve backups and run the full test suite before any public exposure.

## Security release gate

Do not label this production ready until all conditions are demonstrated: OAuth 2.1 multi-client authorization, source/target identity enforcement, lease fencing, repeatable backup/restore, server-side workspace scope isolation, tool approval for shell and Git, host-native listening/wake observations, and a clean security review. A cloud VM alone does not grant ChatGPT remote SSH access.

## External OAuth validation (pre-production only)

For a private proof on Oracle, use a trusted identity provider and keep its signing public JWKS and actor mapping mounted read-only outside the repository. Set `PANTER_AUTH_MODE=external-jwt`, HTTPS `PANTER_PUBLIC_MCP_URL`, issuer, and paths documented in [OAUTH_EXTERNAL.md](OAUTH_EXTERNAL.md). Do **not** mount an identity provider's private key. Verify `/.well-known/oauth-protected-resource` and that an unauthenticated `/mcp` request returns 401 with a resource metadata challenge; then confirm two distinct OAuth client identities cannot impersonate each other. Do not replace validated OAuth with an unprotected shared bearer on a public endpoint.

## Panter-RDD trusted-runner acceptance (v0.15)

The code can verify Ed25519 signatures **but does not create a trusted signer or native ChatGPT child**. Provision a separate authenticated runner, keep its private key outside MCP/model context, and mount its **public** key registry as `PANTER_RDD_RUNNER_KEYS_FILE`. For local Git approvals, pin the worktree and check argv in `PANTER_RDD_LOCAL_WORKTREES_FILE` on an operator-only read-only configuration volume. No caller may change those paths. Install `git` in the runtime image. A positive CI test using ephemeral fixture keys does not replace a live trust-chain acceptance test.

## Operator admin path and Docker network caveat

In embedded or external OAuth mode, `PANTER_OPERATOR_TOKEN` is a **separate** administrator secret, not a GPT-A client token. The HTTP server only recognizes it on direct loopback requests without `Origin` or forwarded headers. The embedded OAuth smoke suite exercises this directly and verifies that a GPT-A OAuth token cannot grant write permission. **Important:** traffic forwarded into a Docker container over a published TCP port can appear to originate from a Docker bridge IP rather than 127.0.0.1; a successful external SSH tunnel to a host loopback port does **not** itself prove operator admin access inside the container. Validate an actual admin MCP session from inside an operator-controlled local environment before enabling writable missions. Never weaken the remote-address check or expose the operator token to the browser or external AI clients to work around this limitation. Production administration needs an explicitly reviewed operator channel.
