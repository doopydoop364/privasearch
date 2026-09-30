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

## Experiment 3: continuous pipeline instead of batches (PrivaSearch driver)

After the Core fix, 1,000 pages, 50 hosts, default node poll interval (1000 ms), `pollMs` 100, one run per row.

| Driver | Concurrency | Pages/min | Latency p50 / p95 (ms) | Coordinator CPU s | Node CPU s |
| --- | --- | --- | --- | --- | --- |
| batch (`runOnce`) | 8 | 426 | 1,045 / 1,148 | 9.3 | 7.1 |
| batch (`runOnce`) | 32 | 1,281 | 1,178 / 1,332 | 9.3 | 6.5 |
| batch (`runOnce`) | 128 | 1,606 | 1,217 / 1,455 | 9.0 | 5.8 |
| pipeline (`run`) | 8 | 741 | 1,025 / 1,139 | 7.7 | 6.5 |
| pipeline (`run`) | 32 | **3,404** | 422 / 575 | 6.6 | 5.9 |
| pipeline (`run`) | 128 | **4,317** | 533 / 1,083 | 7.3 | 5.8 |

Reading:
- The batch driver made throughput proportional to batch size: each pass waited for its slowest job, the queue at PrivaNet drained empty, and the idle node then paid its 1 s poll interval before the next batch. `Crawler.run` refills a slot the moment one frees, so the queue stays non-empty. At 32 in flight that is 2.7 times the batch driver.
- At 128 the in-flight count peaks at 50: the frontier allows one in-flight URL per host and this test site has 50 hosts. That is the politeness rule working, not a limit to remove.
- At concurrency 8 the pipeline is still latency bound (p50 about 1 s): with few jobs queued the node goes idle between jobs and a new job waits for the next idle poll. Throughput is roughly concurrency divided by latency, so lowering pickup latency helps low-concurrency and demand-queue (interactive) crawls. That points at a Core change (a lease that waits for work instead of the node polling), not a PrivaSearch one.
- Zero invalid results and zero transport errors in every run. Single runs on one sandbox machine.

Reproduce: `SCALE_MODE=pipeline SCALE_BATCH=32 SCALE_NODE_POLL_MS=1000 SCALE_POLL_MS=100 node dist/tests/scale-crawl.js 1000` (`SCALE_MODE=batch` for the old driver).

## Experiment 4: a lease that waits for work (Core: PrivaNet-Core PR "Lease requests that wait for work")

After the node poll fix, a node with nothing to do still checked for work once per poll interval, so a new job waited up to one interval before pickup (about 1 s at the default). The Coordinator can hold the node's lease request open until work exists. 1,000 pages, 50 hosts, default node poll interval, `pollMs` 100, one run per row, pipeline driver, one node with one job slot:

| Concurrency | Before | After |
| --- | --- | --- |
| 8 | 741 pages/min, latency p50 1,025 ms | **3,814 pages/min, p50 120 ms** (5.1x) |
| 32 | 3,404 pages/min, p50 422 ms | 4,482 pages/min, p50 369 ms |
| 128 | 4,317 pages/min, p50 533 ms | 4,471 pages/min, p50 546 ms |

Reading: low-concurrency and interactive (demand queue) crawls were pickup-latency bound and now are not. All three concurrencies plateau near 4,500 pages/min, about 13 ms of serial work per job: with instant local pages the single job slot is now the limit.

## Experiment 5: what a real network does to a one-slot node

The local site answers instantly, which hides network latency. `SCALE_SITE_DELAY_MS` adds a per-request delay, and `SCALE_NODES` runs several PrivaNode processes (the only way to get more job slots today). 600 pages, 50 hosts, 128 in flight, 200 ms per request (a page is a robots fetch plus the page, so about 400 ms per job):

| Nodes | Pages/min | Latency p50 (ms) | Node processes RSS total | Coordinator CPU s (before job waits) |
| --- | --- | --- | --- | --- |
| 1 | 259 | 10,646 | 117 MiB | 34.8 |
| 4 | 849 | 3,142 | 368 MiB | 13.2 |
| 16 | 2,537 | 1,132 | 1,283 MiB | 6.2 |

Reading:
- A one-slot node's throughput is one job per (network time + about 13 ms of overhead): 259 pages/min at 200 ms per request, and it would be about 60 to 120 per minute at typical public-web latencies. Public crawling at a useful rate needs many concurrent fetches per node.
- Adding node processes scales almost linearly (259, 849, 2,537), so the architecture parallelises; but every process costs about 80 MiB and its own identity, and owner limits are then per process, not per machine. That is an argument for **multi-slot nodes** (PrivaNet-Core extension point E7), which would keep one identity, one budget and one process. It needs careful resource accounting across concurrent jobs (see the PrivaNet-Core boundary document), so it is proposed, not built.
- With a long queue, application job polling dominated the Coordinator: 35 s of CPU for 600 pages with one node. That led to Experiment 6.

## Experiment 6: applications wait for results instead of polling (Core: "Job reads that wait for the result")

`waitForResult` polled the Coordinator every `pollMs` per job. With 128 jobs waiting behind a slow node that is over a thousand status reads a second. The Coordinator now holds a job read until the job finishes and the SDK uses it. Same runs as Experiment 5:

| Nodes | Coordinator CPU s, polling | Coordinator CPU s, job waits | Pages/min |
| --- | --- | --- | --- |
| 1 | 34.8 | **7.3** | 259, 258 |
| 4 | 13.2 | **4.0** | 849, 846 |

Throughput is unchanged (it is slot bound); the Coordinator load falls 3 to 5 times, which is what limits how many applications and nodes one Coordinator can serve. Zero invalid results and zero transport errors in every run of Experiments 4 to 6. Single runs, one sandbox machine, synthetic local site.

Reproduce: `SCALE_SITE_DELAY_MS=200 SCALE_NODES=4 SCALE_BATCH=128 SCALE_POLL_MS=100 SCALE_HOST_DELAY_MS=50 node dist/tests/scale-crawl.js 600` (`SCALE_NODES`, `SCALE_SITE_DELAY_MS` are new).

## Experiment 7: multi-slot nodes (Core: "Multi-slot PrivaNodes")

One node process running several jobs at once, against the same one-slot baseline and the 16-process workaround from Experiment 5. 600 pages, 50 hosts, 128 in flight, 200 ms per request, one run per row:

| Configuration | Pages/min | Latency p50 (ms) | Node RSS (MiB) | Coordinator CPU s |
| --- | --- | --- | --- | --- |
| 1 process, 1 slot | 259 | 10,661 | 116 | 7.3 |
| 1 process, 4 slots | 988 | 2,741 | 118 | 3.8 |
| 1 process, 16 slots | **2,103** | 1,230 | **133** | 3.7 |
| 1 process, 32 slots | 2,118 | 1,202 | 133 | 7.3 |
| 16 processes, 1 slot each | 2,537 | 1,132 | 1,283 | 6.2 (polling era) |

Reading:
- Slots inside one process give about 10 times less memory for about 83% of the throughput of separate processes, with one identity and one set of owner limits.
- Throughput stops at 16 to 32 slots because the Coordinator reserves the CPU class of every running job (5% each for `web.fetch.v1`) against the CPU budget the node reported, so about 16 fit in this run. That is the owner's limit being honoured, not a bug: an owner with the default policy (25% CPU) would run about five at once. Raising concurrency further is an owner policy decision, and a measured CPU figure for the fetch handler (about 1.5% per active fetch here, against the 5% declared) would justify a lower CPU class for it if it holds on real networks.
- Zero invalid results and zero transport errors in every run.

Reproduce: `SCALE_SLOTS=16 SCALE_SITE_DELAY_MS=200 SCALE_BATCH=128 SCALE_POLL_MS=100 SCALE_HOST_DELAY_MS=50 node dist/tests/scale-crawl.js 600` (`SCALE_SLOTS` is new).

## Where this leaves the pipeline

Each experiment removed one bottleneck and exposed the next: node poll loop (59 to 1,018 pages per minute on default settings), pipelining (batch to continuous), lease pickup latency, application polling (Coordinator CPU 5 times lower), job slots (259 to 2,103 pages per minute per process at 200 ms latency). What is measured is a synthetic local site on one machine. The next honest step is real sites (robots variety, slow and failing hosts, redirects), where the per-host politeness rules and the network, not the platform, should be the limit.
