# Cross-repository findings

Findings this repository cannot act on, raised from the work on the freshness
report's remediation instruction.

## nanohype/nanohype — `library/scripts/sync-vendored.mjs` names the commit it resolved

`runFreshness` prints its remediation as:

```
    Adopt the newer library when convenient: `npm run sync:vendored -- --ref=${tip}`,
```

`tip` is `git rev-parse HEAD` on the upstream checkout, resolved during that
run. The verdict line above it carries the same commit abbreviated to twelve
characters. `nanohype/portal` states the rule that answers this in `scripts/crd.sh`: name
the command that resolves upstream HEAD, not the commit a run resolved. The
instruction here is correct only until upstream moves, and nothing about the way
it is presented says so.

It cannot be fixed here. That script is a vendored copy — `scripts/vendored.json`
declares `library/scripts/sync-vendored.mjs` → `scripts/sync-vendored.mjs`, and
`npm run sync:vendored:check` requires the two to be byte-identical at the pin.
The fix belongs upstream, with its tests, and reaches every consumer through
`npm run sync:vendored -- --ref=<sha>`.

The shape it needs is the same two-part change made here for the CRD schemas:

- `--ref=latest`, resolving the newest upstream commit that touched a vendored
  path, at the moment the re-vendor runs. `main` rejects anything but a
  40-character SHA, so there is no command the report can name that resolves
  upstream — a report naming `--ref=<sha>` would be unfollowable rather than
  stale.
- A freshness report that names that command and prints no commit it resolved,
  held by a behavioural gate on the emitted bytes rather than on how the report
  is constructed.

One difference in consequence: `.github/workflows/vendored-freshness.yml` in
this repository files no issue, so this report reaches a reader only through a
scheduled run's log. A wrong instruction there is read less often than the CRD
one, not less wrongly.

## nanohype/eks-agent-platform — the vendored CRD schema pin is behind

`npm run schemas:freshness` reports two of the four vendored schemas changed
upstream since the pinned `0f56302c9e2d`:

- `platform.nanohype.dev_platforms.yaml`
- `agents.nanohype.dev_modelgateways.yaml`

Adopting them is separate work and wants the schema diff read: a bound the
operator's CRD has gained is enforced against `platform.yaml` only once the pin
moves, so a re-vendor can require a manifest change in the same commit. The
command is `npm run schemas:sync -- --ref=latest` followed by
`npm run platform:validate`.

## nanohype/portal — `latest` from a checkout can move a pin backwards

`upstream_head` in `scripts/crd.sh` and `scripts/xrd.sh` resolves
`git log -1 --format=%H -- "$UPSTREAM_PATH"` inside `$EKS_AGENT_PLATFORM_DIR` /
`$EKS_FLEET_DIR`, and `cmd_sync latest` repins to whatever that returns. Nothing
fetches, so the answer is the newest commit *that clone holds*, not the newest
upstream has. A clone that predates the pin — a developer's checkout forked
before it, or left unpulled — makes `freshness` print "current" while upstream
has moved, and makes the remediation the report names move the pin BACKWARDS
onto older schemas. Both are indistinguishable from the truth downstream.

The guard that costs nothing is to refuse a resolved head the pin does not
descend from: `git merge-base --is-ancestor "$pin" "$head" || die`. It catches
the backwards case exactly, leaves the equal case ("current") alone, and needs
no network. It does not catch a clone forked *at* the pin, which is why the
scheduled workflow should keep supplying a fresh default-branch checkout rather
than relying on the guard — a limit worth stating rather than papering over.

## nanohype/.github — the editorconfig-gate adoption table stops at the workflow

The per-repository table in that repository's REPORT.md names the workflow, the
job and the step to remove, and says "Nothing else." For this repository that is
one call site short: `npm run editorconfig` was also a Taskfile target
(`task editorconfig`) and a step in `task ci`, so dropping the npm script by the
table alone leaves a task that invokes a script no longer declared — `task ci`
fails at that step rather than at a formatting defect.

Worth naming in the table for any consumer carrying a Taskfile, alongside the
`package.json` and workflow entries it already carries. The wider question the
adoption raises and the table does not settle: a repository whose `task ci` is
documented as running what CI blocks on cannot keep that claim once one gate
moves into a shared action, so the desc has to say which gate it no longer runs.

## The merge order and the editorconfig gate deadlock each other

The estate's ruling is that a gate failing on an advisory a pull request did not
introduce is the gate working, and the bump lands in its own pull request cut
from main, merged first, after which the branch takes main. The `fast-uri` /
`qs` bump follows it and is cut from main.

Its only failing check is not the bump. It is the `Editorconfig` step in
`build + lint + typecheck + test`:

```
> editorconfig-checker -disable-indent-size -disable-indentation
Failed to download binary:
Error: The binary 'ec-linux-amd64*' not found
```

That is one of the three failure modes the shared editorconfig gate exists to
remove, on a tree with no formatting defect. `merge gate` fails only because it
needs that job.

The deadlock is in the order. The bump has to merge before the freshness branch
takes main, and it cannot go green while main still runs the npm shim — and the
adoption that removes the shim is a commit on the freshness branch, which by the
same order merges second. Neither can be first.

Whichever way it is broken, the fix is not to fold anything together:

- Cut the editorconfig adoption out of the freshness branch into its own pull
  request from main and merge that first. It is a fix for a defect neither of
  the other two introduced, which is the same shape the ruling already
  prescribes for the bump, so this is the ruling applied one level up rather
  than an exception to it. The bump then reruns green, and the freshness branch
  keeps only what it argues.
- Or merge the bump with the editorconfig check knowingly red, which trades a
  legible order for an override and leaves the next pull request meeting the
  same wall.

The first is the one that leaves nothing owed. Naming it here rather than acting
on it: the branch this file sits on is not the place to reorganise which branch
carries what.

## What the reference implementation does not cover

`nanohype/portal` holds this property in `scripts/freshness_test.sh`. Three
gaps in it, each closed by a case in `node scripts/sync-crd-schemas.mjs --self-test`:

- **Abbreviated commit ids.** Its assertion is `grep -qE '[0-9a-f]{40}'` — no
  40-character id. The reports here abbreviate to twelve, so a verdict line
  carrying `${tip.slice(0, 12)}` would satisfy that assertion and be exactly as
  stale. The gate here forbids any prefix of seven characters or more — git's
  shortest abbreviation, and a prefix of every longer one — of a commit the run
  resolved, and keeps the 40-character refusal as well.
- **A repository tip that is not the path's tip.** Its fixture commits only to
  the vendored path, so upstream's tip and the newest commit touching that path
  are the same commit, and resolving `latest` as `git log -1` without the
  pathspec passes. The fixture here adds a commit touching nothing under the
  vendored path, so a `latest` that repins onto the repository tip — a ref
  nobody read a schema diff for — fails.
- **Report branches no fixture reaches.** Its fixture moves exactly one file and
  never removes one, so the multi-file shape — the one a controller-gen
  regeneration produces, and the shape this repository's own pin is behind by —
  and the removed-or-renamed branch are never emitted. An assertion over bytes
  nothing produced is green by vacancy: a leak keyed to `behind.length > 1`, or
  printed on the removed-upstream branch, passes. The fixtures here drive both,
  plus the `✓ current` verdict in the one state where a leak there is
  distinguishable from printing the pin.
- **The state the remediation leaves behind.** Its gate stops once `sync latest`
  names the fixture's head. The gate here goes on to require that the pin the
  remediation landed on reports current, that its report also names no resolved
  commit, that the digests were rewritten with the vendored bytes, and that the
  blocking gate passes at that pin — so the instruction cannot land the tree
  somewhere `schemas:check` would reject.
