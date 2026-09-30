# PrivaNet integration

Authoritative contract: `docs/PRIVASEARCH_INTEGRATION.md` and `docs/APPLICATION_BOUNDARY.md` in PrivaNet-Core (mirrored here from commit `ffc35e3`). If they disagree with `src/privanet/fetch-contract.ts`, the PrivaNet documents win and this repository must be updated.

## Capability and permissions

- Job type: `web.fetch.v1` (**provisional**; ADR 005 is proposed). Changing it is a one-line edit of `FETCH_JOB_TYPE`.
- Two PrivaNet application credentials, `privasearch-demand` and `privasearch-public`, each with `allowedJobTypes` limited to the fetch capability. Tokens come from the environment, are never logged, and never enter a job.
- Nothing user-derived goes into a job: no queries, no identifiers. The idempotency key carries the frontier entry.

## The transport port

`FetchTransport.fetch({ input, idempotencyKey, queue })` returns `unknown`. The real adapter will wrap `@privanet/sdk` (`submit` with the key, then `waitForResult`), pick the credential by queue, and translate SDK errors into `TransportError` codes (`UNAVAILABLE`, `QUEUE_FULL`, `FORBIDDEN`, `JOB_FAILED`, `TIMEOUT`). It is not written because the capability does not exist yet and the SDK cannot be installed here.

## Open items on the PrivaNet side (owned by PrivaNet-Core)

1. The fetch capability itself (guarded fetcher, robots, SSRF boundary, digest) and confirmation of ADR 005.
2. A way to consume `@privanet/sdk`: options are the pure-JavaScript `node_modules/@privanet/sdk` shipped in a PrivaNet release archive, a `file:` link to a sibling checkout, or publishing PrivaNet's packages to a registry.
3. Application fetch identity (product token and info URL) so the User-Agent and robots token are per application.
4. Job cancellation, short retention, and per-host concurrency hints before untrusted nodes.
