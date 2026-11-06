# Security policy

## Reporting a vulnerability

Report it privately through [GitHub's private vulnerability reporting](../../security/advisories/new): the **Security** tab → **Report a vulnerability**. Do not open a public issue, pull request or discussion for a security problem, and do not publish a proof of concept before a fix is released.

Include:

- what an attacker can do and under which conditions (which host or role, which mode: owner mode on or off);
- the version or commit you tested;
- the smallest steps that reproduce it.

Never include real tokens, passwords, OAuth secrets, `panter.env` contents or data from a live deployment. Use placeholders.

You can expect an acknowledgement within 7 days. Once the report is confirmed, the fix goes into a release and the advisory is published with credit, unless you ask to stay anonymous.

## Supported versions

Security fixes go into the latest release only. Upgrade to it before reporting.

## In scope

- OAuth, consent and host binding (`/mcp`, `/oauth/*`);
- authorization between the leader and the workers: a worker merging, approving, writing protected branches, CI or git config, reading secrets, or getting more than its grant allows;
- the GitHub delivery gate and the review gate accepting the wrong commit or reviewer;
- the downstream MCP gateway leaking a token or reaching an address it should refuse;
- anything that exposes data from another host or another mission.

## Out of scope

- Problems that need an attacker who already controls your server, your `panter.env` or an approved host account.
- Findings about a deployment's own configuration that contradict [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).
- What a connected AI app (Claude, ChatGPT, Grok, Gemini) does inside its own product: report that to its vendor.
