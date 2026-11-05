# Downstream MCP servers

Panter can mount other MCP servers behind it. Each one lives in its own repository, runs as its own service with its own `/health` and deploy, and keeps its own approvals. Panter is the only client that holds its token. The hosts reach it through Panter, under Panter's identities, write grants and audit.

```
host (Claude, GPT, Grok, Gemini) ──MCP/OAuth──▶ Panter ──MCP + token──▶ downstream server
                                                 │ allowed hosts
                                                 │ read / write / destructive
                                                 │ write grants, timeout, circuit breaker
                                                 └ audit
```

## Contract for a downstream server

- Serve MCP over Streamable HTTP. Plain `http` is accepted only to `localhost`, `127.0.0.0/8`, `::1` or a private network (10/8, 172.16/12, 192.168/16); anything else must be `https`. Redirects are refused, so the token only ever goes to the configured address.
- Require a bearer token. Panter reads it from an environment variable named `PANTER_DOWNSTREAM_*` (in `etc/panter.env`); the config file only names the variable.
- Annotate every tool. Panter follows the MCP defaults:
  - `readOnlyHint: true` → **read**
  - `destructiveHint: false` → **write**
  - anything else, including no annotations → **destructive**
- Keep your own approvals (for example a `proposal_hash` the caller must echo back). Panter's grant is a second lock on top, never a replacement.
- Each call carries `_meta["panter-ai/host"]` (the calling host) and, for granted calls, `_meta["panter-ai/grantId"]`. Use them for your own logs; they are informative, not authentication.
- Panter caps a result at 2 MB.

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
| `tokenEnv` | Optional. Name of the `PANTER_DOWNSTREAM_*` variable that holds the token. |
| `hosts` | Hosts that may use it (and see its router). The operator always may. Default: none. |
| `writes` | `deny`: no write or destructive call through Panter. `grant` (default): a host needs an operator grant. `allow`: allowed hosts write without a grant (only for servers whose own approvals are enough). |
| `timeoutMs` | Per call, 1000-300000. Default 30000. |
| `description` | Shown in status. |

A config that fails validation stops Panter from starting: a half-configured gateway is worse than none. Panter fetches each server's tools at start and every 10 minutes; `panter_downstream_refresh` does it on demand.

## Using it

Each server is one router tool, listed for its allowed hosts:

```
panter_ds_shop { "operation": "index" }
panter_ds_shop { "operation": "index", "arguments": { "operation": "set_price" } }
panter_ds_shop { "operation": "lookup", "arguments": { "sku": "A1" } }
panter_ds_shop { "operation": "set_price", "arguments": { "sku": "A1", "price": 9990 }, "grantId": "…" }
```

`index` lists each tool with its class; with `arguments.operation` it returns that tool's input schema.

## Write grants

Only the operator (the admin socket or the admin token) issues grants:

```
panter_downstream_grant { "server": "shop", "host": "claude", "tools": "*", "ttlSeconds": 3600, "uses": 10, "reason": "November repricing" }
panter_downstream_revoke { "grantId": "…" }
```

- A grant is for one server and one host, expires, and has a number of uses. Each call spends one use atomically, so two calls can never share the last one.
- `"tools": "*"` covers **write** tools only. A **destructive** tool must be named in `tools`.
- The operator itself calls without a grant (`writes: "deny"` still applies).

## Health, failures and audit

- `panter_downstream_status`: per server you may use, `OK`, `DEGRADED` (the last call failed), `CIRCUIT_OPEN`, `TOKEN_MISSING` or `NOT_CONTACTED`, with tool counts by class.
- Three transport failures in a row (timeouts, connection errors) open the circuit for 30 seconds: calls fail fast instead of piling up. The first call after that tries again and closes it on success.
- `panter_downstream_audit` (leader or operator): the grants, and the last calls with host, tool, class, grant, outcome (`OK`, `TOOL_ERROR`, `REFUSED`, `FAILED`), duration and error. Arguments are stored only as a SHA-256 hash. The audit and the grants live in the SQLite ledger (`downstream`), so they are in every backup.
- Error messages never include the token.

## Adding a project

1. Build the MCP server in its own repository, following the contract above, with its own tests, CI and deploy.
2. Deploy it on the VM under its own Unix user and service, on a localhost port, with its own token.
3. Add the token to `etc/panter.env` as `PANTER_DOWNSTREAM_<NAME>_TOKEN`, and the server to the config file.
4. Restart Panter and check `panter_downstream_status`.
5. Start with `writes: "deny"` until the tool annotations and the server's own approvals have been reviewed, then move to `grant`.
