# Measurements

All figures are from the real path (PrivaSearch, `@privanet/sdk`, Coordinator, one authenticated PrivaNode running `web.fetch.v1`), crawling a **synthetic local site** with the node owner's local host mapping. That relaxes the node's SSRF policy for the test hosts only. This is not the public web, there is one node with one job slot, Linux, Node 22 in a sandbox, and each figure is a single run. Treat them as a baseline, not a benchmark.

| Pages | Hosts | Seconds | Pages/min | Fetched | Invalid | Transport errors | Latency p50 / p95 (ms) | Node CPU s | Coordinator CPU s | Peak RSS node / coordinator (MiB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 2 | 0.9 | 661 | 10 | 0 | 0 | 63 / 167 | 0.17 | 0.13 | 85 / 80 |
| 100 | 10 | 6.3 | 950 | 100 | 0 | 0 | 258 / 511 | 0.83 | 1.12 | 90 / 91 |
| 1,000 | 50 | 63 | 952 | 1,000 | 0 | 0 | 1,014 / 1,924 | 7.49 | 18.5 | 119 / 132 |

Average result payload: about 1.4 KB per page. Coordinator database after 1,000 jobs: 4.1 MB.

## What the numbers say

- Throughput is flat at about 950 pages/min from 100 to 1,000 pages: a single node with one job slot processes jobs one after another, so latency grows with the queue (p50 1 s at 32 in flight) while throughput does not.
- The Coordinator spent 2.5 times the CPU of the node. The likely cause is the SDK's per-job polling (32 concurrent waiters polling every 25 ms), not fetching. Evidence for batch status polling or long-poll on the Coordinator (PrivaNet-Core extension point E6).
- Multi-slot nodes (E7) are the next throughput lever; measure after fixing polling so the two effects are not confused.
- Zero invalid results and zero transport errors at every size: the schema validation and cross-checks never fired on honest data, as expected.

## Not yet measured

Public-web behaviour (robots variety, slow and failing hosts, redirects), 10,000 and 100,000 pages, memory growth of a long-running node, and behaviour with more than one node.
