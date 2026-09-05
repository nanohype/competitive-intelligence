# Vendored operator CRD schemas

The `Tenant`, `Platform`, and `BudgetPolicy` CustomResourceDefinitions from
[`nanohype/eks-agent-platform`](https://github.com/nanohype/eks-agent-platform),
`operators/config/crd/bases/` — controller-gen output, copied byte for byte.
`scripts/validate-platform-manifests.mjs` validates `platform.yaml` against
these files, so they are the gate's ground truth.

**Never hand-edit them.** Fix the API types upstream, regenerate there, then
re-vendor here.

## source.json

`source.json` records where the copies came from — `upstream.repository`,
`upstream.path`, the pinned `upstream.ref` — plus a SHA-256 per file. The two
pins do different jobs:

- **`upstream.ref`** makes the gate deterministic. The schema CI validates
  against today is the schema it validated against yesterday; adopting a newer
  operator API is an explicit commit that moves the SHA. It must be a full
  40-character commit SHA: a branch name would make the verdict depend on when
  the gate ran.
- **`sha256`** makes the copies tamper-evident with no network. The validator
  hashes every file against its record before parsing it, so editing a vendored
  schema to admit the manifest under review — widening an enum, dropping a
  `required` entry — aborts the run.

Neither check subsumes the other, and each covers the other's blind spot:

| | edited copy, digest not updated | edited copy, digest updated to match | pin no longer describes the copies |
| --- | --- | --- | --- |
| `npm run platform:validate` (offline) | fails | passes | passes |
| `npm run schemas:check` (upstream at the pinned ref) | fails | **fails** | **fails** |

Both run in CI, and both fail loudly: an unreachable upstream, a missing file,
undeclared YAML in this directory, an unrecognised argument, or a checkout that
cannot resolve the pinned commit exits non-zero rather than skipping.

## Pin fidelity, not freshness

`schemas:check` asks one question: do the vendored bytes equal upstream **at the
pinned ref**? That answer depends only on the commit under test, which is what a
blocking gate needs — a required check that turns red because someone pushed to
another repository is not reproducible, and teaches people to re-run CI instead
of reading it.

Whether the pin has fallen behind upstream is a real question with a different
shape: its answer changes on someone else's schedule, and nothing is broken when
it comes back "behind" — the copies still match the commit they claim.
`npm run schemas:freshness` answers it, and the `crd-schema-freshness` workflow
runs it weekly (and on demand). It is never wired into pull-request CI.

That report is copied verbatim into an issue body which is re-edited weekly and
read on whatever day someone opens it, so it names a command rather than a
commit. A commit it resolved would be offered as the newest one until the next
run; following that offer re-vendors to a ref that is no longer newest and
closes the issue that warned about it. `npm run schemas:selftest` holds the
property on the emitted bytes — it builds a real upstream repository whose
history it knows, requires every hex-looking token the report prints to fail to
be a prefix of any commit that run resolved, and then runs the remediation the
report names and requires the pin to land on the newest commit that touched the
schemas. Its fixtures drive each branch of the report a reader can meet — more
than one schema behind, a schema removed upstream, and a pin that is current
while upstream has moved — because an assertion over text no fixture emits is
green by vacancy. It needs no network and runs on every pull
request, unlike the weekly report it constrains.

## Commands

```bash
npm run platform:validate   # the gate: digests, then platform.yaml, then a self-test
npm run schemas:sync        # re-vendor the copies + digests from the pinned ref
npm run schemas:sync -- --ref=latest  # ...from the newest upstream commit instead, and move the pin
npm run schemas:check       # blocking drift gate: copies vs upstream at the pinned ref
npm run schemas:freshness   # scheduled-only: has the pin fallen behind upstream?
npm run schemas:selftest    # blocking gate: the freshness report names a command, and it works
```

Upstream resolves two ways, both deterministic. With `$EKS_AGENT_PLATFORM_DIR`
set the files come from that checkout, read out of its object database at the
ref — so any commit answers as long as the ref is reachable there, and a dirty
working tree is never mistaken for upstream. Without it they are fetched from
raw.githubusercontent.com at that ref, and `--ref=latest` asks api.github.com
for the newest commit touching the vendored path. An unreachable upstream is a
failure, never a skip.

## Adopting a newer operator API

1. `npm run schemas:sync -- --ref=<40-char-sha>` — moves the pin and rewrites
   the copies and their digests in one step, so the two cannot drift apart.
   `--ref=latest` resolves the newest upstream commit touching
   `operators/config/crd/bases` as it runs, which is what the freshness report
   names: an instruction that stays correct on whatever day it is read.
2. `npm run platform:validate` — a CRD change that invalidates `platform.yaml`
   surfaces here, before a cluster sees it.
3. Commit the schema diff, the pin move, and any manifest changes together.
