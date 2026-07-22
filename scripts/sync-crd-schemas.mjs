#!/usr/bin/env node
/**
 * Sync the vendored CRD schemas under `schemas/crd/` from the operator repo
 * that generates them (nanohype/eks-agent-platform, `make manifests` →
 * controller-gen). `scripts/validate-platform-manifests.mjs` validates
 * `platform.yaml` against these copies, so they are the gate's ground truth
 * and must stay byte-identical to the generated originals.
 *
 *   node scripts/sync-crd-schemas.mjs            # (re)write the copies + digests
 *   node scripts/sync-crd-schemas.mjs --check    # CI gate: exit 1 on drift
 *
 * `schemas/crd/source.json` pins the upstream repo, the commit SHA, the source
 * directory, and a SHA-256 per vendored file. The two pins do different jobs:
 *
 *   - `ref` makes the gate deterministic. The schema CI validates against today
 *     is the schema it validated against yesterday, and adopting a newer
 *     operator API is an explicit commit that bumps the SHA.
 *   - the per-file `sha256` makes the copies tamper-evident offline. The
 *     validator verifies those digests before it reads a single schema, so
 *     widening an enum in a vendored copy fails the gate on a laptop with no
 *     network, not just in the job that has an upstream checkout.
 *
 * This script is the drift half of that pair: it re-reads the upstream files
 * at the pinned ref and fails if a vendored copy, or its recorded digest, has
 * moved away from them. A copy edited *and* re-digested consistently passes
 * the validator and fails here; a copy edited without re-digesting fails the
 * validator. Neither hole is reachable from the other side.
 *
 * Two source modes, both deterministic:
 *   - $EKS_AGENT_PLATFORM_DIR points at a checkout. Its `git rev-parse HEAD`
 *     must equal the pinned ref — a sibling working tree on some other branch
 *     is not the upstream this repo pinned, and silently comparing against it
 *     would let a stale pin pass. `--from-worktree` relaxes that for local
 *     iteration on unreleased CRDs, and is refused in `--check` mode.
 *   - otherwise the files are fetched from raw.githubusercontent.com at the
 *     pinned ref.
 *
 * Every failure is loud and fatal — an unreachable source, a missing file, an
 * unreadable manifest, or an undeclared stray file in `schemas/crd/` exits
 * non-zero rather than leaving the validator to run against whatever happens
 * to be on disk.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(REPO_ROOT, "schemas", "crd");
const MANIFEST = join(SCHEMA_DIR, "source.json");

const digestOf = (buffer) => createHash("sha256").update(buffer).digest("hex");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function readManifest({ check }) {
  let raw;
  try {
    raw = await readFile(MANIFEST, "utf8");
  } catch (error) {
    fail(`cannot read ${MANIFEST}: ${error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    fail(`${MANIFEST} is not valid JSON: ${error.message}`);
  }
  for (const key of ["repo", "ref", "sourceDir", "files"]) {
    if (!manifest[key]) fail(`${MANIFEST} is missing \`${key}\``);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail(`${MANIFEST} \`files\` must be a non-empty array`);
  }
  for (const entry of manifest.files) {
    if (typeof entry?.file !== "string" || entry.file.length === 0) {
      fail(`${MANIFEST} \`files\` entries must be objects with a \`file\` string`);
    }
    if (check && !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")) {
      fail(
        `${MANIFEST} entry \`${entry.file}\` is missing a 64-character sha256 — ` +
          "run `npm run schemas:sync` to record one",
      );
    }
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.ref)) {
    fail(`${MANIFEST} \`ref\` must be a full 40-character commit SHA, got \`${manifest.ref}\``);
  }
  return manifest;
}

/**
 * A checkout is only the pinned upstream if its HEAD *is* the pinned ref.
 * Anything else is some other tree, and comparing against it would report a
 * verdict about a commit this repo never pinned.
 */
async function assertCheckoutAtRef(checkout, ref, { allowUnpinned }) {
  let head;
  try {
    const { stdout } = await execFileAsync("git", ["-C", checkout, "rev-parse", "HEAD"]);
    head = stdout.trim();
  } catch (error) {
    fail(
      `cannot resolve the HEAD commit of $EKS_AGENT_PLATFORM_DIR (${checkout}): ${error.message} — ` +
        "point it at a git checkout of the operator repo, or unset it to fetch the pinned ref " +
        "over HTTPS instead",
    );
  }
  if (head === ref) return head;
  if (allowUnpinned) {
    console.warn(
      `! $EKS_AGENT_PLATFORM_DIR is at ${head}, not the pinned ${ref} — vendoring from the ` +
        "working tree because --from-worktree was passed. Bump `ref` in schemas/crd/source.json " +
        "and re-sync before committing, or the drift gate will fail.",
    );
    return head;
  }
  fail(
    `$EKS_AGENT_PLATFORM_DIR (${checkout}) is at ${head} but schemas/crd/source.json pins ` +
      `${ref} — check the pinned commit out (\`git -C ${checkout} checkout ${ref}\`) so the ` +
      "comparison is against the commit this repo actually vendored from",
  );
}

async function fetchFromCheckout(checkout, manifest, file) {
  const path = join(checkout, manifest.sourceDir, file);
  try {
    return await readFile(path);
  } catch (error) {
    fail(`cannot read ${path} from $EKS_AGENT_PLATFORM_DIR: ${error.message}`);
  }
}

async function fetchFromGithub(manifest, file) {
  const url = `https://raw.githubusercontent.com/${manifest.repo}/${manifest.ref}/${manifest.sourceDir}/${file}`;
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    fail(`cannot fetch ${url}: ${error.message}`);
  }
  if (!response.ok) {
    fail(`cannot fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Anything in schemas/crd/ that source.json does not declare is unaccounted for. */
async function assertNoStrayFiles(declared) {
  let present;
  try {
    present = (await readdir(SCHEMA_DIR)).filter((f) => f.endsWith(".yaml"));
  } catch (error) {
    fail(`cannot read ${SCHEMA_DIR}: ${error.message}`);
  }
  const stray = present.filter((f) => !declared.has(f)).sort();
  if (stray.length > 0) {
    fail(
      `schemas/crd/ holds YAML not declared in source.json: ${stray.join(", ")} — ` +
        "declare it in `files` and re-sync, or delete it",
    );
  }
}

async function main() {
  const check = process.argv.includes("--check");
  const fromWorktree = process.argv.includes("--from-worktree");
  if (check && fromWorktree) {
    fail("--from-worktree is a local convenience for re-vendoring; it cannot relax --check");
  }

  const manifest = await readManifest({ check });
  const checkout = process.env.EKS_AGENT_PLATFORM_DIR;
  let origin;
  if (checkout) {
    const head = await assertCheckoutAtRef(checkout, manifest.ref, {
      allowUnpinned: fromWorktree,
    });
    origin = `${checkout} @ ${head} ($EKS_AGENT_PLATFORM_DIR)`;
  } else {
    origin = `${manifest.repo}@${manifest.ref} (raw.githubusercontent.com)`;
  }

  await assertNoStrayFiles(new Set(manifest.files.map((entry) => entry.file)));

  const drifted = [];
  const stale = [];
  const synced = [];

  for (const entry of manifest.files) {
    const { file } = entry;
    const upstream = checkout
      ? await fetchFromCheckout(checkout, manifest, file)
      : await fetchFromGithub(manifest, file);
    if (!upstream.toString("utf8").includes("kind: CustomResourceDefinition")) {
      fail(`${file} from ${origin} does not look like a CRD — refusing to vendor it`);
    }

    const dest = join(SCHEMA_DIR, file);
    const current = await readFile(dest).catch(() => null);
    const matches = Boolean(current?.equals(upstream));

    if (check) {
      if (!matches) {
        drifted.push(current === null ? `${file} (missing)` : file);
        continue;
      }
      // Bytes agree with upstream, so the digest must agree with the bytes.
      // A mismatch here means source.json's digests were not regenerated when
      // the copies were — the validator would then reject a file this job
      // called clean.
      const actual = digestOf(current);
      if (actual !== entry.sha256) {
        stale.push(`${file} (source.json records ${entry.sha256}, file hashes ${actual})`);
      }
      continue;
    }

    if (!matches) await writeFile(dest, upstream);
    entry.sha256 = digestOf(upstream);
    synced.push({ file, rewritten: !matches });
  }

  if (check) {
    if (drifted.length > 0) {
      console.error(`✗ vendored CRD schemas drifted from ${origin}:`);
      for (const file of drifted) console.error(`    schemas/crd/${file}`);
      console.error("  run `npm run schemas:sync` to re-sync (never hand-edit the copies)");
      process.exit(1);
    }
    if (stale.length > 0) {
      console.error("✗ recorded digests do not match the vendored files:");
      for (const line of stale) console.error(`    schemas/crd/${line}`);
      console.error("  run `npm run schemas:sync` to re-record them");
      process.exit(1);
    }
    console.log(
      `✓ ${manifest.files.length} vendored CRD schemas byte-identical to ${origin}, ` +
        "digests in source.json current",
    );
    return;
  }

  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const { file, rewritten } of synced) console.log(`${rewritten ? "↻" : "="} ${file}`);
  console.log(`✓ synced ${synced.length} CRD schemas + digests from ${origin}`);
}

await main();
