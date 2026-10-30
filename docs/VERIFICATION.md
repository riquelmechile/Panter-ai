# Verification (current developer preview)

## Repeatable CI checks

Run `npm run check`, `npm run build`, `npm test`, `npm run smoke:http`, `npm run smoke:oauth`, and `npm run smoke:embedded` from a clean checkout. The package requires Node 22 and dependencies installed by npm. Check GitHub Actions on the exact commit SHA before describing CI as successful.

## What CI cannot prove

Passing tests does not prove production OAuth with each provider app, Oracle host process health, user-visible Fast tier, actual GPT-A native child invocations, a trusted Ed25519 signer outside the model, or operating-system worktree isolation. Panter-RDD refuses positive unsigned evidence. See [`CANONICAL_HARNESS_POLICY.md`](CANONICAL_HARNESS_POLICY.md) for current acceptance gates.

## Historical v0.2 verification

Past v0.2 assessments are not current behavior claims. The canonical state is the code under the reviewed SHA and the observed CI run.
