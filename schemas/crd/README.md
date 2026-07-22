# Vendored operator CRD schemas

The `Tenant`, `Platform`, and `BudgetPolicy` CustomResourceDefinitions from
[`nanohype/eks-agent-platform`](https://github.com/nanohype/eks-agent-platform),
`operators/config/crd/bases/` — controller-gen output, copied byte for byte.
`scripts/validate-platform-manifests.mjs` validates `platform.yaml` against
these files, so they are the gate's ground truth.

**Never hand-edit them.** Fix the API types upstream, regenerate there, then
re-vendor here.

## source.json

`source.json` records the upstream repo, the source directory, the pinned
commit, and a SHA-256 per file. The two pins do different jobs:

- **`ref`** makes the gate deterministic. The schema CI validates against today
  is the schema it validated against yesterday; adopting a newer operator API is
  an explicit commit that moves the SHA.
- **`sha256`** makes the copies tamper-evident with no network. The validator
  hashes every file against its record before parsing it, so editing a vendored
  schema to admit the manifest under review — widening an enum, dropping a
  `required` entry — aborts the run.

Neither check subsumes the other, and each covers the other's blind spot:

| | edited copy, digest not updated | edited copy, digest updated to match | pin no longer describes the copies |
| --- | --- | --- | --- |
| `npm run platform:validate` (offline) | fails | passes | passes |
| `npm run schemas:check` (upstream at `ref`) | fails | **fails** | **fails** |

Both run in CI, and both fail loudly: an unreachable upstream, a missing file,
undeclared YAML in this directory, or a checkout whose HEAD is not the pinned
commit exits non-zero rather than skipping.

## Commands

```bash
npm run platform:validate   # the gate: digests, then platform.yaml, then a self-test
npm run schemas:sync        # re-vendor the copies + digests from the pinned ref
npm run schemas:check       # CI drift gate: copies vs upstream at the pinned ref
```

Both sync modes are deterministic. With `$EKS_AGENT_PLATFORM_DIR` set the files
come from that checkout, whose HEAD must be the pinned commit; without it they
are fetched from raw.githubusercontent.com at the pinned commit.

## Adopting a newer operator API

1. Bump `ref` in `source.json` to the new commit.
2. `npm run schemas:sync` — rewrites the copies and their digests.
3. `npm run platform:validate` — a CRD change that invalidates `platform.yaml`
   surfaces here, before a cluster sees it.
4. Commit the schema diff and the manifest changes together.
