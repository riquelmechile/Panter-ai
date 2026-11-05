# Downstream MCP servers

Panter can mount other MCP servers behind it. Each one lives in its own repository, runs as its own service with its own `/health` and deploy, and keeps its own approvals. Panter is the only client that holds its token. The hosts reach it through Panter, under Panter's identities, write grants and audit.

```
host (Claude, GPT, Grok, Gemini) ──MCP/OAuth──▶ Panter ──MCP + token──▶ downstream server
                                                 │ allowed hosts
                                                 │ read / write / destructive
                                                 │ write grants, timeout, circuit breaker
                                                 │ signed actor assertion (who, role, mission)
                                                 └ audit (metadata only for sensitive servers)
```

## Contract for a downstream server

- Serve MCP over Streamable HTTP. Plain `http` is accepted only to `localhost` or a literal private address (`127.0.0.0/8`, 10/8, 172.16/12, 192.168/16, `::1`, `fc00::/7`); a host name is never treated as private, so anything else must be `https`. The URL carries no user, password or query string. Redirects are refused, so the token only ever goes to the configured address.
- Require a bearer token. Either a fixed token, which Panter reads from an environment variable named `PANTER_DOWNSTREAM_*` (in `etc/panter.env`), or OAuth client credentials (see `oauth` below). The config file only names the variables.
- Annotate every tool. Panter follows the MCP defaults:
  - `readOnlyHint: true` → **read**
  - `destructiveHint: false` → **write**
  - anything else, including no annotations → **destructive**
- Keep your own approvals (for example a `proposal_hash` the caller must echo back). Panter's grant is a second lock on top, never a replacement.
- Each call carries `_meta["panter-ai/host"]` (the calling host), `_meta["panter-ai/role"]` (`leader`, `worker` or `operator`), `_meta["panter-ai/callId"]` (Panter's id for the request), `_meta["panter-ai/missionId"]` when the caller named one, and, for granted calls, `_meta["panter-ai/grantId"]`. These plain fields are informative. The one to trust is `_meta["panter-ai/actor"]`, the signed actor assertion (see [Who is calling](#who-is-calling)).
- Panter stops reading any single response past 4 MB and refuses a result over 2 MB. A tool's input schema over 64 KB is shown as a plain object.

The reference hosting is the same VM as Panter: one Unix user and one `systemd --user` service per downstream server, listening on a localhost port.

## Registering a server

Create a JSON file and point `PANTER_DOWNSTREAM_CONFIG` at it (for example `~/panter-ai/etc/downstream.json`), then restart Panter:

```json
{
  "servers": [
    {
      "name": "shop",
      "url": "http://127.0.0.1:18100/mcp",
      "tokenEnv": "PANTER_DOWNSTREAM_SHOP_TOKEN",
      "hosts": ["claude"],
      "writes": "grant",
      "timeoutMs": 30000,
      "description": "Store catalog and prices"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | 2-24 lowercase letters or digits. The router is `panter_ds_<name>`. |
| `url` | The server's MCP endpoint (see the address rule above). |
| `tokenEnv` | Optional. Name of the `PANTER_DOWNSTREAM_*` variable that holds a fixed token. |
| `oauth` | Optional, instead of `tokenEnv`: OAuth client credentials. `tokenUrl` (same address rule as `url`), `clientIdEnv` and `clientSecretEnv` (`PANTER_DOWNSTREAM_*` variables), and optionally `scope`, `resource` (the RFC 8707 resource indicator, for servers that bind tokens to their MCP URL) and `authMethod` (`basic`, the default, with the id and secret form-encoded as RFC 6749 asks, or `post`). Panter asks for a token, caches it until a minute before it expires, and renews it once when the server refuses it (401). A refused call to a tool that is not a read is never sent again by Panter (a 401 does not prove the call did not run): it fails, and the host decides whether to call again, with the new token. A late refusal for an older token does not discard a newer one. The token endpoint's answer is limited to 64 KB. No token Panter was issued (including one replaced while a call was running, until it expires) and no form of the client secret appears in errors, results or the audit. |
| `hosts` | Hosts that may use it (and see its router). The operator always may. Default: none. |
| `writes` | `deny`: no write or destructive call through Panter. `grant` (default): a host needs an operator grant. `allow`: allowed hosts write without a grant (only for servers whose own approvals are enough). |
| `timeoutMs` | Per call, 1000-300000. Default 30000. |
| `description` | Shown in status. |
| `sensitive` | `true` for any server whose calls carry data Panter must not keep (personal data, customer records, credentials of third parties, health data...). See [Sensitive servers](#sensitive-servers). Default `false`. |

A config that fails validation stops Panter from starting: a half-configured gateway is worse than none. Panter fetches each server's tools at start, every 10 minutes, on demand with `panter_downstream_refresh`, and before any call when the cached list is more than a minute old, so a tool whose annotations changed is classified by what the server says now. If that fetch fails, the call fails too (fail closed), and calls fail fast for 10 seconds before Panter asks again.

## Using it

Each server is one router tool, listed for its allowed hosts:

```
panter_ds_shop { "operation": "index" }
panter_ds_shop { "operation": "index", "arguments": { "operation": "set_price" } }
panter_ds_shop { "operation": "lookup", "arguments": { "sku": "A1" } }
panter_ds_shop { "operation": "set_price", "arguments": { "sku": "A1", "price": 9990 }, "grantId": "…" }
```

Add `"missionId": "<harness run id>"` to say which mission the call belongs to; it travels in the signed actor assertion, and a sensitive server requires it.

`index` lists each tool with its class; with `arguments.operation` it returns that tool's input schema. A downstream tool that is itself called `index` is reached as operation `@index`. A host not allowed on the server is refused, `index` included; those refusals are counted per host and server (`refusedWithoutAccess` in the audit tool) rather than written one by one, so they cannot push real calls out of the audit.

## Write grants

Only the operator (the admin socket or the admin token) issues grants:

```
panter_downstream_grant { "server": "shop", "host": "claude", "tools": "*", "ttlSeconds": 3600, "uses": 10, "reason": "November repricing" }
panter_downstream_revoke { "grantId": "…" }
```

- A grant is for one server and one host, expires, and has a number of uses. Each call spends one use atomically, so two calls can never share the last one.
- `"tools": "*"` covers **write** tools only. A **destructive** tool must be named in `tools`.
- The operator itself calls without a grant (`writes: "deny"` still applies). Here the operator is only the admin principal (the admin socket or token), never a host listed in `PANTER_OWNER_TRUSTED_HOSTS`.
- The use is spent before the call is forwarded: a call that then fails in transport has still used it (fail closed).

## Health, failures and audit

- `panter_downstream_status`: per server you may use, `OK`, `DEGRADED` (the last call failed), `CIRCUIT_OPEN`, `TOKEN_MISSING` or `NOT_CONTACTED`, with tool counts by class.
- Three transport failures in a row (timeouts, broken connections) open the circuit for 30 seconds: calls fail fast instead of piling up. A slow call that times out fails alone and never closes the connection other calls are using; calls that fail together because one connection broke count once. Any success resets the count. Tool errors (`isError`) and JSON-RPC errors are the server answering, not transport failures: they count nothing and keep the connection. An answer over 4 MB fails its own call (each request carries its own id in `_meta["panter-ai/callId"]`, so a cut is never blamed on another call) with that reason, once the call's timeout runs out, and counts nothing either.
- `panter_downstream_audit` (leader or operator): for the servers the caller may use, the grants, the sensitive missions and the last 2000 calls with host, role, mission, tool, class, grant, outcome (`OK`, `TOOL_ERROR`, `REFUSED`, `FAILED`), duration and error. Arguments are stored only as a keyed hash (HMAC-SHA-256 with a key kept in the ledger), so short values cannot be guessed back. The audit and the grants live in the SQLite ledger (`downstream`), so they are in every backup.
- Neither error messages nor results include the token: it is removed from the whole error text (also as `Bearer <token>`) before the text is shortened, and from every string of a result before it reaches the host.

## Who is calling

Without help a downstream server only sees "Panter". So every call Panter forwards carries `_meta["panter-ai/actor"]`: a compact JWS signed with Ed25519 (`alg: "EdDSA"`, `typ: "panter-actor+jwt"`, `kid`) whose claims say:

| Claim | Meaning |
|---|---|
| `iss` | Always `panter-ai`. |
| `aud` | The server's `name` in Panter's config: a token meant for another server fails. |
| `sub` | The authenticated host that made the call (`gpt-a`, `gpt-b`, `grok`, `gemini`, `claude`) or `admin` for the operator. |
| `role` | Its Panter role at that moment: `leader`, `worker` or `operator`. |
| `mission` | The `missionId` the caller gave, if any. |
| `tool` | The tool called. |
| `args` | base64url SHA-256 of the arguments as canonical JSON (keys sorted at every depth). |
| `jti` | Panter's id for this request (also `_meta["panter-ai/callId"]`). |
| `iat`, `exp` | Issued at, and expiry 120 seconds later. |

The public keys are a JWK set at `GET /.well-known/panter-downstream-keys` on Panter (and in `panter_downstream_status` as `actorKeys`). Fetch it once and pin it, rather than trusting whatever the network serves at call time. The key is created on first use and kept in Panter's ledger, so it survives restarts and is in every backup: protect the backups like the server itself, since whoever reads the private key can sign as any host. There is one key for now; `kid` leaves room for rotation.

To verify, copy [`src/core/actor-assertion.ts`](../src/core/actor-assertion.ts) (it only needs `node:crypto`) and call:

```ts
import { verifyActorAssertion } from './actor-assertion.js';

// args: the raw request.params.arguments, exactly as received, not the values after your schema parsed them
// (defaults, coercion and dropped keys would change the digest).
const claims = verifyActorAssertion(meta['panter-ai/actor'], pinnedKey, { aud: 'crm', tool: name, args: request.params.arguments });
// claims.sub === 'grok', claims.role === 'worker', claims.mission === '…'
```

It throws unless the signature, issuer, server, tool, arguments and lifetime all match (30 seconds of clock leeway). Remember each accepted `jti` until `exp` plus the leeway (the whole time the verifier would still accept it) and refuse a repeat, so a captured token cannot be replayed. Deduplicate on `jti`, never on the token string: a signature can be written in more than one way. A verifier in another language must hash the same canonical JSON (sorted keys, JavaScript number form; integers beyond 2^53 lose precision as JSON numbers, so send those as strings). Then apply your own rules: for example, which hosts may act as which panelist, and an audit row with `sub`, `role` and `mission`.

What it proves, and what not: Panter authenticated that host (OAuth or its host token) and that host made this exact call. It does not prove which model the host was running or what the model was told: that stays the host's own claim, and a compromised host can still make calls in its own name.

## Sensitive servers

`"sensitive": true` is for any downstream server whose calls carry data Panter must not keep: personal data, customer or account records, health data, anything under a confidentiality duty. It is a property of the server, not of one project. Panter still proxies the call and hands the answer to the host that asked (that is the point of the call), but it keeps none of it:

- The audit keeps only metadata: time, host, role, mission, tool, class, grant, outcome and duration. No argument hash (a hash of a short value, a RUT for example, can be guessed back) and no error text from the server.
- When the call itself fails (timeout, transport, a JSON-RPC error), the host, the audit, `lastError` in status and the log get only its kind (`timed out`, `transport error`, `the server answered with an error`): a downstream error message can echo the call. A tool result with `isError: true` is the server's answer and reaches the host as it is; the audit records only `TOOL_ERROR`.
- Results are not cached anywhere; the answer is marked `_meta["panter-ai/sensitive"]: true`.
- Every call must name its `missionId`.

The data does pass through Panter's memory while the call is proxied; it is not written to disk, the log, memory or the ledger.

**Sensitive missions.** Once a call to a sensitive server is forwarded for a mission, that mission is sensitive. The marks are listed as `sensitiveMissions` in `panter_downstream_audit` and kept in their own ledger, apart from the bounded audit. They are never dropped: they hold even if the server is later removed from the config (each Panter process loads them at start and keeps its own up to date; run one Panter per data directory), and if 100,000 marks were ever reached, new sensitive calls would be refused rather than an old mark forgotten. For a sensitive mission Panter:

- never mirrors the harness run to Engram (`memoryCheckpoint: "ENGRAM_SKIPPED_SENSITIVE"`);
- refuses new text that holds a personal identifier: from workers, their results and peer messages; from the leader, harness reports, corrections, unit reports and unit objectives, close reasons, delegated instructions and objectives (`panter_mesh_delegate`, `panter_mesh_delegate_auto`, `panter_specialist_delegate`), review objectives (`panter_review_start`, `panter_native_review_create`) and native and solo review reports. The write is refused, not cut: nothing is stored, and the error names the kind of data (never the value), so the host sends it again without it. A refused worker result leaves the work running: the worker must send it again without the data, and a worker that gives up instead leaves the work to its lease expiry (a writer then needs the operator's reconciliation). Over the Gemini mail relay the worker only sees a rejected delivery, not the reason.

Not checked: anything a worker writes outside Panter (commits, pull requests and issues through the GitHub workforce go to GitHub, not to Panter's stores), file paths, idempotency keys and grant fields, text Panter copies from what it already holds (a harness run's objective in the packets it dispatches, so a run never stalls on its own record), text Panter assembles itself (skill text, code material such as a diff), the legacy native flow tools, and the operator's reconciliation of a writer.

The mark follows the `missionId` the host names: a host that names another mission, or none, is not stopped by this. It is a guard against accidents by honest hosts, not against a host that wants to leak what it already received. A harness run id in upper case counts as the same run. The operator clears a mark set by mistake with `panter_downstream_unmark` (with a reason, kept in the ledger).

While any sensitive server is configured, `panter_memory_save` is checked the same way.

The check is the same for every sensitive server and looks only for identifiers with a reliable shape: a Chilean RUT with a valid check digit, an e-mail address and a +56 phone number. Not counted as e-mail addresses: no-reply senders, GitHub no-reply users, `git@` remotes, the user part of a URL (`scheme://user@host`, only user and password characters), and the domains reserved for examples and tests (`example.com`, `example.net`, `example.org`, `.example`, `.test`, `.invalid`, `.localhost`). Private names such as `.local` or `.internal` can be real mailboxes and count. A number shaped like a RUT with a valid check digit always counts, even when it is really something else (about 1 in 11 such numbers). It scans in linear time. It is a safety net, not a guarantee: it misses anything else (names, addresses, free-text records). The real protection is on the server's side: hand hosts pseudonymous ids (`C-0042`) and keep the mapping to real people to itself.

Data protection law still applies to the downstream server and to the hosts that receive the answers. This feature reduces what Panter keeps; it is not a compliance assessment.

## Adding a project

1. Build the MCP server in its own repository, following the contract above, with its own tests, CI and deploy.
2. Deploy it on the VM under its own Unix user and service, on a localhost port, with its own token.
3. Add the token to `etc/panter.env` as `PANTER_DOWNSTREAM_<NAME>_TOKEN`, and the server to the config file.
4. Restart Panter and check `panter_downstream_status`.
5. If its calls carry data Panter must not keep, set `"sensitive": true` and have it verify the actor assertion (pin the key from `/.well-known/panter-downstream-keys`).
6. Start with `writes: "deny"` until the tool annotations and the server's own approvals have been reviewed, then move to `grant`.
