# Measurements

All figures are from the real path (PrivaSearch, `@privanet/sdk`, Coordinator, one authenticated PrivaNode running `web.fetch.v1`), crawling a **synthetic local site** with the node owner's local host mapping. That relaxes the node's SSRF policy for the test hosts only. This is not the public web, there is one node with one job slot, Linux, Node 22 in a sandbox, and each figure is a single run. Treat them as a baseline, not a benchmark.

| Pages | Hosts | Seconds | Pages/min | Fetched | Invalid | Transport errors | Latency p50 / p95 (ms) | Node CPU s | Coordinator CPU s | Peak RSS node / coordinator (MiB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 2 | 0.9 | 661 | 10 | 0 | 0 | 63 / 167 | 0.17 | 0.13 | 85 / 80 |
| 100 | 10 | 6.3 | 950 | 100 | 0 | 0 | 258 / 511 | 0.83 | 1.12 | 90 / 91 |
| 1,000 | 50 | 63 | 952 | 1,000 | 0 | 0 | 1,014 / 1,924 | 7.49 | 18.5 | 119 / 132 |

Average result payload: about 1.4 KB per page. Coordinator database after 1,000 jobs: 4.1 MB.

## What the numbers say (first run, superseded in part by the two experiments below)

- Throughput is flat at about 950 pages/min from 100 to 1,000 pages: a single node with one job slot processes jobs one after another, so latency grows with the queue (p50 1 s at 32 in flight) while throughput does not.
- The Coordinator spent 2.5 times the CPU of the node. The likely cause is the SDK's per-job polling (32 concurrent waiters polling every 25 ms), not fetching. Evidence for batch status polling or long-poll on the Coordinator (PrivaNet-Core extension point E6).
- Multi-slot nodes (E7) are the next throughput lever; measure after fixing polling so the two effects are not confused.
- Zero invalid results and zero transport errors at every size: the schema validation and cross-checks never fired on honest data, as expected.

## Not yet measured

Public-web behaviour (robots variety, slow and failing hosts, redirects), 10,000 and 100,000 pages, memory growth of a long-running node, and behaviour with more than one node.

## Experiment 1: SDK polling interval (PrivaSearch side, no Core change)

1,000 pages, 50 hosts, node poll 50 ms, two runs per setting. `pollMs` is how often PrivaSearch asks the Coordinator whether a job finished.

| `pollMs` | Pages/min | Latency p50 (ms) | Coordinator CPU s | Node CPU s |
| --- | --- | --- | --- | --- |
| 25 | 929, 935 | 1,058, 1,046 | 19.1, 18.4 | 8.5, 8.1 |
| 100 | 911, 926 | 1,096, 1,091 | 9.3, 8.8 | 8.6, 8.0 |
| 250 | 884, 886 | 1,102, 1,104 | 7.1, 7.1 | 8.4, 8.4 |

Reading: polling interval trades Coordinator CPU (19 s to 7 s) for a few percent of throughput, so the first hypothesis (polling costs the Coordinator CPU) holds. But throughput stayed near 930 pages/min at every setting, so polling was **not** the throughput ceiling. Something serial was.

## Experiment 2: the node's own poll loop (a Core bug, found by this measurement)

The constant ceiling of about 64 ms per job matched the node's 50 ms poll interval. Reading the node daemon confirmed it: after every tick, including one that had just finished a job, the run loop slept a full `PRIVANODE_POLL_MS`. With the default of 1000 ms a node could finish at most one job per second (60 pages/min) however fast the work was.

300 pages, 30 hosts, `pollMs` 100, one run per row, Core before the fix (v0.3.0-alpha.2) and after (PrivaNet-Core PR "poll again immediately after a finished job"):

| Node poll interval | Core | Pages/min | Latency p50 (ms) | Coordinator CPU s |
| --- | --- | --- | --- | --- |
| 50 ms | before | 894 | 978 | 3.1 |
| 50 ms | after | 3,498 | 254 | 1.6 |
| 1000 ms (default) | before | **59** | 15,175 | 21.3 |
| 1000 ms (default) | after | **1,018** | 1,170 | 3.3 |

The "before, default" row is the important one: 59 pages/min is the predicted cap of 60. An operator running a node with defaults would have seen a crawler about 17 times slower than the same node could sustain, and no application-side change could have fixed it. Zero invalid results and zero transport errors in every run.

Caveats: single runs, one sandbox machine, synthetic local site, one node with one job slot. Ratios are indicative, not benchmarks. The rerun of the 1,000-page table with the fix, and multi-slot nodes, are next.

Reproduce with a PrivaNet-Core checkout: `SCALE_NODE_POLL_MS=1000 SCALE_POLL_MS=100 node dist/tests/scale-crawl.js 300`.
