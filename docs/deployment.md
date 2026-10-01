# Deployment

PrivaSearch runs as one long-lived service next to (or apart from) your PrivaNet Coordinator. This guide assumes the setup in PrivaNet-Core's `docs/FIRST_DEPLOYMENT.md`: a home server running the Coordinator behind Caddy, and at least one PrivaNode (for example a desktop) offering `web.fetch.v1`. PrivaSearch does not need to be on the same machine as the Coordinator or any node, and it never installs into PrivaNet-Core.

```text
browser ─> PrivaProxy (user interface, engine dropdown, server-side route)
              │  PRIVASEARCH_URL (+ PRIVASEARCH_TOKEN)
              v
          PrivaSearch service ──────────────────────────────> index, frontier (SQLite)
              │  PRIVANET_COORDINATOR_URL, two application credentials
              v
          PrivaNet Coordinator ──> PrivaNode (web.fetch.v1) ──> the web
```

## Requirements

- Node.js 24.4 or newer.
- A PrivaNet Coordinator reachable over HTTPS, and one or more PrivaNodes enrolled for `web.fetch.v1`. With one desktop node as in the first deployment, PrivaSearch works; it just crawls at the pace one node allows.
- Two PrivaNet **application credentials** (one per queue) created on the Coordinator host, with a fetch identity:

  ```sh
  sudo PRIVANET_JOB_TYPES=web.fetch.v1 \
       PRIVANET_FETCH_PRODUCT=PrivaSearchBot PRIVANET_FETCH_INFO_URL=https://your-site.example/bot \
       privanet-admin application privasearch-demand
  sudo PRIVANET_JOB_TYPES=web.fetch.v1 \
       PRIVANET_FETCH_PRODUCT=PrivaSearchBot PRIVANET_FETCH_INFO_URL=https://your-site.example/bot \
       privanet-admin application privasearch-public
  ```

  Each prints `{"applicationId":...,"token":...}` once. The product name and info URL become the crawler's `User-Agent` on every site it visits, stamped by the Coordinator; PrivaSearch never sets one. Use a page you control that explains what the crawler is and how to contact you.

## Install (Linux, systemd)

From a release archive (`privasearch-<version>.tar.gz`) or a checkout (`npm ci && npm run build`, then use `dist/src` as `dist`):

```sh
sudo useradd --system --home-dir /var/lib/privasearch --shell /usr/sbin/nologin privasearch
sudo mkdir -p /opt/privasearch /etc/privasearch
sudo tar -xzf privasearch-0.4.0.tar.gz -C /opt && sudo mv /opt/privasearch-0.4.0/* /opt/privasearch/
(cd /opt/privasearch && sudo /opt/node/bin/npm ci --omit=dev)
sudo install -m 0600 -o root -g root /opt/privasearch/deploy/env/privasearch.env.example /etc/privasearch/privasearch.env
sudo install -m 0644 /opt/privasearch/deploy/seeds.example.txt /etc/privasearch/seeds.txt
sudo editor /etc/privasearch/privasearch.env     # the Coordinator URL, the two tokens, the seeds path, templates
sudo editor /etc/privasearch/seeds.txt           # choose the sites your crawler may start from
sudo cp /opt/privasearch/deploy/systemd/privasearch.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now privasearch
sudo journalctl -u privasearch -n 20             # expect {"event":"service.started", ...}
curl -s http://127.0.0.1:4020/health
```

The unit runs as the unprivileged `privasearch` user with a sandbox (no privileges, read-only system, only `/var/lib/privasearch` writable), keeps settings in the environment file (never in the unit), restarts on failure but not on a configuration mistake (exit status 78), and stops gracefully on `SIGTERM`.

If the Coordinator uses a private certificate authority (Caddy's local CA, as in the first deployment), copy its root certificate to the PrivaSearch host and set `NODE_EXTRA_CA_CERTS=/etc/privasearch/privanet-root.crt` in the environment file. Plain `http` is accepted only for a literal loopback Coordinator address with `PRIVASEARCH_ALLOW_INSECURE_LOOPBACK=true` (development only).

## Settings

All settings are environment variables; an invalid one is reported by name (never by value) as `service.config_invalid` and the process exits with status 78.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PRIVANET_COORDINATOR_URL`, `PRIVANET_DEMAND_TOKEN`, `PRIVANET_PUBLIC_TOKEN` | none | All three, or none for a **search-only** service that serves its index and crawls nothing. The two tokens must be different. The address must be `https://host` (no path or credentials); plain `http` only for a literal loopback address with `PRIVASEARCH_ALLOW_INSECURE_LOOPBACK=true`. Anything else is reported as `service.config_invalid` naming `PRIVANET_COORDINATOR_URL`. |
| `PRIVASEARCH_DB` | `./var/privasearch.sqlite` | The database file (use `/var/lib/privasearch/privasearch.sqlite` under systemd). |
| `PRIVASEARCH_HOST`, `PRIVASEARCH_PORT` | `127.0.0.1`, `4020` | Where the API listens. |
| `PRIVASEARCH_API_TOKEN` | none | Bearer token for `/search` and `/status` (at least 32 characters). **Required** when the host is not a loopback address. |
| `PRIVASEARCH_SEEDS` | none | A file of start URLs, one per line. |
| `PRIVASEARCH_DISCOVERY_TEMPLATES` | none | URL templates for demand-crawl discovery on an empty index ([crawling.md](crawling.md#query-to-url-discovery)). |
| `PRIVASEARCH_CONCURRENCY` | 8 | Fetches in flight (one per host at most). |
| `PRIVASEARCH_HOST_DELAY_MS`, `PRIVASEARCH_MAX_DEPTH`, `PRIVASEARCH_MAX_URLS_PER_HOST` | 2000, 8, 2000 | Politeness and crawl limits. |
| `PRIVASEARCH_RECRAWL_MS`, `_MIN_MS`, `_MAX_MS` | 7 d, 6 h, 60 d | Recrawl intervals ([crawling.md](crawling.md#recrawl)). |
| `PRIVASEARCH_DEMAND`, `PRIVASEARCH_DEMAND_*` | on; 3, 30 min, 12, 300, 30 | Demand-crawl switch and limits. |
| `PRIVASEARCH_WAIT_TIMEOUT_MS`, `PRIVASEARCH_POLL_MS` | 60000, 100 | How long to wait for a fetch result, and the poll interval. |
| `PRIVASEARCH_SHUTDOWN_MS`, `PRIVASEARCH_PROGRESS_MS` | 15000, 60000 | Graceful-stop window and progress-log interval. |

Logs are JSON lines with event names and aggregate counts only (`service.started`, `service.progress`, `service.stopping`, `service.stopped`): never a URL, a query or a credential.

## Connecting PrivaProxy

On the PrivaProxy host, set (in its environment, not on a command line):

```sh
PRIVASEARCH_URL=http://127.0.0.1:4020        # or https://search.example if PrivaSearch is elsewhere
PRIVASEARCH_TOKEN=<the same value as PRIVASEARCH_API_TOKEN>   # only if PrivaSearch requires one
```

and restart PrivaProxy. Its **Search** tab and the browser toolbar then offer "PrivaSearch" in the search-engine dropdown. See PrivaProxy's README.

## Operating it

- **Is it crawling?** `curl -s -H "Authorization: Bearer $PRIVASEARCH_API_TOKEN" http://127.0.0.1:4020/status` shows documents, links, frontier counts (`pendingDemand`, `pendingPublic`, `recrawlDue`) and the demand ledger size. On the Coordinator host, `sudo privanet-admin nodes` shows your nodes and their current jobs.
- **Restart**: `sudo systemctl restart privasearch`. The index, link graph, frontier and demand ledger are in the database; leases the old process held are returned at start. A Coordinator restart or a node reconnecting costs seconds (the crawler backs off and resubmits under the same idempotency keys).
- **Back up**: stop the service or use SQLite's online backup (`sqlite3 /var/lib/privasearch/privasearch.sqlite ".backup /path/backup.sqlite"`); the database is one file plus its `-wal`/`-shm` while running.
- **Upgrade**: unpack the new release over `/opt/privasearch`, `npm ci --omit=dev`, `sudo systemctl restart privasearch`. Databases from older versions are migrated in place on first open; take a backup first.
- **Stop crawling but keep serving**: remove the three `PRIVANET_*` settings (search-only), or set `PRIVASEARCH_DEMAND=false` to keep background crawling but stop searches from scheduling work.
- **Check it end to end**: search through PrivaProxy for a topic you have not crawled. The first answer is immediate; `journalctl -u privanet-node` on the node host shows the fetches; repeat the search after a few seconds.

## Current limitations

See [crawling.md](crawling.md#limitations-known-not-hidden). In short: one process and one database file; the index starts empty, so configure seeds and a template; default ports only; trusted nodes only; nothing has crawled the public web at scale.
