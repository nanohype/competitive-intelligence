# competitive-intelligence — Runbook

On-call reference for the `competitive-intelligence` Platform tenant. Pairs with
[`ARCHITECTURE.md`](../ARCHITECTURE.md) (how it works) and `chart/README.md`
(how it deploys).

## At a glance

- **What it is:** a single-writer radar — crawls competitor pages, semantic-diffs
  each against its own pgvector history, and alerts Slack (`#competitive-intel`)
  on meaningful change.
- **Topology:** `replicaCount: 1` (single writer; do not scale without leader
  election). Durable state in Aurora Serverless v2 (pgvector). Bedrock for
  LLM + embeddings via EKS Pod Identity.
- **Probes:** `/health` (liveness), `/readyz` (readiness — fails when the vector
  store is unreachable) on `PORT`. The MCP query surface runs on `MCP_PORT`,
  fronted by the mcp-tunnel.
- **MCP auth:** open by default (mcp-tunnel + NetworkPolicy only). Optionally an
  OAuth 2.1 resource server delegating to WorkOS AuthKit (`MCP_AUTH=workos`) so
  it can be a Claude custom connector — dashboard, env, connector, and
  self-tunnel steps in [`mcp-oauth.md`](mcp-oauth.md).
- **Logs:** structured JSON to stderr → cluster log forwarder → Loki.
- **Telemetry:** OTLP traces + metrics → `telemetry.monitoring` → Tempo + AMP.

## Dashboards

Grafana dashboard `competitive-intelligence` (from `chart/dashboards/`). Key panels:

- **Crawl — duration + sources by outcome** (`crawl_duration_ms`, `crawl_sources_total{outcome}`)
- **Pipeline — chunks + diffs processed, change-score distribution**
- **Alerts — fired vs send failures**
- **Bedrock — token usage by kind + cache-hit ratio**
- **Resilience — circuit breakers open & pgvector errors**

## Alerts → response

Alert rules live in `chart/templates/prometheusrule.yaml`. All metric names are
the `competitive_intelligence_*` series the rules query.

| Alert | Severity | Symptom | Likely cause | First steps |
|---|---|---|---|---|
| `CompetitiveIntelligenceCrawlFailureSpike` | page | ≥3 crawl failures / 15m | A target blocking the crawler, a per-host breaker stuck open, DNS/egress regression, or the NetworkPolicy denying outbound :443 | Check the "Crawl — sources by outcome" panel for which source(s) fail; tail logs for `crawl failed`; confirm the source URL still resolves and serves; check the egress NetworkPolicy. |
| `CompetitiveIntelligenceCircuitBreakerOpen` | warning | A breaker open ≥10m (`$labels.target`) | A host (crawl target, Bedrock, or Slack) failing fast and not recovering | Identify `target` from the alert; check that dependency directly (Bedrock model access / region, Slack API status, the target site). The breaker half-opens automatically once the dependency recovers. |
| `CompetitiveIntelligenceAlertSendFailure` | page | Slack sends failing / 5m | Bad/expired bot token, bot not in `#competitive-intel`, or Slack egress blocked | Verify `SLACK_BOT_TOKEN` (ExternalSecret synced), confirm bot membership in the channel, check Slack API status and the :443 egress path. Detected changes are computed but not delivered until resolved. |
| `CompetitiveIntelligencePgVectorUnreachable` | page | pgvector errors / 5m | Aurora down/failing over, the `db-credentials` ExternalSecret stale, or :5432 egress blocked | Check the Aurora endpoint health and recent failover events; confirm the `competitive-intelligence/<env>/db-credentials` secret synced; check the :5432 egress rule. `/readyz` will be failing, so the pod is pulled from rotation until recovery. |

## Playbooks

### Pod restart / rollout

No action. The vector backend is durable pgvector, so the first crawl after a
restart diffs against real history (not a flood of "everything is new"). If the
store happens to be empty for a source, the cold-start guard seeds it as a
baseline and suppresses alerts for that source on that crawl. (See
ARCHITECTURE.md → "Durable pgvector … cold-start baseline guard".)

### Aurora failover recovery

Transient `pgvector` errors are expected during a failover; the
`PgVectorUnreachable` alert may fire briefly. Once Aurora is back, confirm the
history is intact (the dashboard's pipeline panels should resume) and watch the
next crawl — because history persisted, it diffs normally rather than flooding
alerts. No manual reseed is required.

### Force a re-baseline for one source

If a source's stored chunks are corrupt or you want to reset its history,
delete that source's chunks from pgvector:

```sql
DELETE FROM ci_vectors WHERE metadata @> '{"sourceId":"<sourceId>"}'::jsonb;
```

The next crawl sees `count() == 0` for that source, treats it as cold-start
baseline seeding (ingest + embed, **no alert**), and resumes normal diffing on
the crawl after that. Scope the delete to one `sourceId` — a full-table wipe
re-baselines every source and silences one crawl's worth of real changes.

### Trigger an immediate crawl

The MCP `trigger_crawl` tool (from any Claude surface), or `npm run crawl`
locally. The crawl mutex serializes it against the scheduler, so it's safe to
run anytime.

### "Alerts stopped but crawls succeed"

Check, in order: the `AlertSendFailure` alert (Slack delivery), the
`SIGNIFICANCE_THRESHOLD` (too high suppresses everything), and whether recent
diffs are all baseline/below-threshold (the "change-score distribution" panel).
