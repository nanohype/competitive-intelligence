# Security Policy

## Reporting a vulnerability

Email rackctl@gmail.com with subject `[security][competitive-intelligence]`. Do not open public issues for security reports.

Acknowledgement target: within 72 hours. Triage target: within 5 business days.

## Security posture

competitive-intelligence crawls external competitor websites and feeds the content through an LLM, so its defining controls are about **what the crawler is allowed to reach** and **never holding a credential in the app**.

### Crawler SSRF / URL guard

- Source URLs are operator-supplied (`sources.json`), so every outbound crawl URL passes through `guardUrl` (`src/crawler/url-guard.ts`) before the fetch. It rejects non-`http(s)` schemes and any host that resolves to loopback, RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16` — including the `169.254.169.254` cloud-metadata address), IPv6 loopback/link-local/unique-local, or the unspecified address.
- The hostname is resolved once and the guard gates on the resolved address. DNS-rebinding (the fetch re-resolving to a different address) is a known residual — acceptable for crawling external marketing pages, and defense-in-depth is provided by the NetworkPolicy below.
- At the network layer, the chart's default-deny `NetworkPolicy` egress allow-list **blocks `169.254.0.0/16`** (IMDS) outright, so even a guard bypass cannot reach instance metadata.

### Identity & secrets

- No long-lived credentials in the app. Pods get AWS access via **EKS Pod Identity** — the Bedrock LLM + Titan embeddings run on the AWS credential chain, which resolves to the landing-zone `competitive-intelligence-platform` role. There are no static keys anywhere in the repo or image; `config.ts` reads no `AWS_ACCESS_KEY_ID`.
- App-level secrets are projected at deploy time by External Secrets Operator from AWS Secrets Manager (`competitive-intelligence/<env>/*`) into a Kubernetes Secret, consumed via `envFrom` — never committed. Slack tokens and optional Anthropic/OpenAI keys come from `competitive-intelligence/<env>/app-secrets`; Postgres credentials come from the Aurora-managed `competitive-intelligence/<env>/db-credentials`.
- The optional Anthropic/OpenAI direct-API providers are off by default. Bedrock (on-account, EKS Pod Identity, no key) is the default for both LLM and embeddings.

### Data handling

- Inference runs on-account via Amazon Bedrock — crawled competitor content and intel queries are not sent to a third party. (The direct Anthropic/OpenAI providers are the exception and are opt-in.)
- Embeddings and chunk content are stored at rest in **Aurora PostgreSQL (pgvector)**, encrypted at rest by the engine. The crawl only collects publicly served competitor web pages; it stores no end-user PII.

### Network

- Default-deny `NetworkPolicy` with an explicit egress allow-list: DNS (kube-dns :53), HTTPS :443 to `0.0.0.0/0` **except `169.254.0.0/16`** (crawl targets + Bedrock + Slack, IMDS blocked), and Postgres :5432 to the cluster VPC CIDR.
- **No public ingress.** There is no inbound HTTP product surface — the Slack integration runs in Socket Mode (an outbound WebSocket), and the only inbound traffic allowed is same-namespace health probes against `/health` + `/readyz`.

## Known limitations

- **DNS rebinding.** The URL guard resolves and gates once; a host that re-resolves after the check could in theory be re-pointed. The IMDS-blocking NetworkPolicy egress rule is the backstop for the highest-value target.
- **Source trust.** `sources.json` is operator-controlled and Zod-validated, but the guard's protection is only as good as keeping that file under review — a malicious source entry is mitigated by the network egress rules, not eliminated.
- **Single-writer assumption.** The crawl mutex is in-process; correctness depends on `replicaCount: 1`. Running multiple writers without leader election is a correctness risk (double-crawl / racing diff-replace), not just a performance one.

## Compliance

competitive-intelligence exposes the controls needed for **SOC 2 Type II** — Pod-Identity-only access with no static credentials, secrets sourced from Secrets Manager via External Secrets (never committed), encrypted-at-rest data in Aurora, a default-deny network posture with IMDS blocked, and on-account inference with no third-party data egress on the default path. Substrate-level controls (CIS EKS baseline, Pod Security Standards, image signing) are enforced upstream by `landing-zone` and `eks-gitops`.
