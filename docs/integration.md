# PrivaNet integration

Authoritative contract: `docs/PRIVASEARCH_INTEGRATION.md`, `docs/APPLICATION_BOUNDARY.md` and `docs/PACKAGES.md` in PrivaNet-Core. The schemas are **imported** from `@privanet/protocol`; nothing is copied here, so a schema change arrives as a package upgrade and shows up as a type error or a failing test.

## Capability and permissions

- Job type: `web.fetch.v1` (confirmed by ADR 005). The constant lives in `src/privanet/contract.ts`.
- Two PrivaNet application credentials, `privasearch-demand` and `privasearch-public`, each with `allowedJobTypes` limited to the fetch capability. Tokens come from the environment, are never logged and never enter a job.
- **Fetch identity** is registered by the PrivaNet administrator on each application record (`PRIVANET_FETCH_PRODUCT`, `PRIVANET_FETCH_INFO_URL` for the admin script). The Coordinator stamps it into the lease, so the User-Agent and the robots.txt group come from that registration and not from anything PrivaSearch sends in a job. Without it, submission fails with 403 `FETCH_IDENTITY_REQUIRED`.
- Nothing user-derived goes into a job: no queries, no identifiers. The idempotency key `crawl:<sha256(url)[0:32]>:<generation>` carries the frontier entry.

## The transport port

`FetchTransport.fetch({ input, idempotencyKey, queue })` returns `unknown`. `PrivaNetTransport` wraps `@privanet/sdk` (`submit` with the key, then `waitForResult`), picks the credential by queue, and translates errors:

| Cause | `TransportError` | Retry |
| --- | --- | --- |
| 429 `QUEUE_LIMIT` | `QUEUE_FULL` | yes, back off |
| Wait timeout (408) | `TIMEOUT` | yes, same key returns the same job |
| Job failed inside PrivaNet (409) | `JOB_FAILED` | yes, later |
| 5xx, network failure | `UNAVAILABLE` | yes |
| 401/403 (credential, `JOB_TYPE_FORBIDDEN`, `FETCH_IDENTITY_REQUIRED`), other 4xx | `FORBIDDEN` | no: configuration |
| 426 protocol mismatch, an answer that violates the schema | `INCOMPATIBLE` | no: upgrade the packages |

The SDK validates a job result against the registered output schema before returning it; the driver then validates again and cross-checks it against what was asked, because a schema-valid result can still be dishonest (wrong URL, off-host final URL, impossible status).

## Version mismatch and upgrades

Packages are pinned to an exact version (`npm install --save-exact @privanet/sdk@next`, then the same version for `@privanet/protocol`). A Coordinator that speaks a different protocol version answers 426, which surfaces as `INCOMPATIBLE`. Upgrade `@privanet/*` together (see PrivaNet-Core `docs/PACKAGES.md`); the three must share a version.

## Open items on the PrivaNet side (owned by PrivaNet-Core)

1. ~~Publish the packages to the npm registry~~ Done: `@privanet/protocol`, `shared` and `sdk` are on public npm (`0.3.0-alpha.5`, trusted publishing). PrivaSearch depends on `@privanet/protocol` and `@privanet/sdk` at that exact version; `tests/dependencies.test.ts` guards against a release-asset URL or a sibling `file:` link coming back.
2. SDK polling cost: `waitForResult` polls per job; see [measurements.md](measurements.md) for the evidence and the batch or long-poll proposal.
3. Job cancellation, short retention, and per-host concurrency hints before untrusted nodes.

## PrivaProxy (the user interface)

PrivaProxy is a separate application and owns the search UI. Its server calls this service's `GET /search` ([search-api.md](search-api.md)) and returns a sanitised copy to the browser, so the browser never sees PrivaSearch's address or token. Configure PrivaProxy with `PRIVASEARCH_URL` (and `PRIVASEARCH_TOKEN` when this service has `PRIVASEARCH_API_TOKEN`); see [deployment.md](deployment.md#connecting-privaproxy). A search from PrivaProxy answers immediately from the index and, if the results are thin, starts demand crawling; PrivaProxy looks again a few times so the person sees results arrive.
