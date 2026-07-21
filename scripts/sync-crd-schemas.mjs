#!/usr/bin/env node
/**
 * Sync the vendored CRD schemas under `schemas/crds/` from the operator repo
 * that generates them (nanohype/eks-agent-platform, `make manifests` →
 * controller-gen). `scripts/validate-platform-manifests.mjs` validates
 * `platform.yaml` against these copies, so they are the gate's ground truth
 * and must stay byte-identical to the generated originals.
 *
 *   node scripts/sync-crd-schemas.mjs            # (re)write the vendored copies
 *   node scripts/sync-crd-schemas.mjs --check    # CI gate: exit 1 on drift
 *
 * `schemas/crds/source.json` pins the upstream repo, the commit SHA, and the
 * file list. Pinning a SHA rather than a branch is what makes the gate
 * deterministic: the schema CI validates against today is the schema it
 * validated against yesterday, and adopting a newer operator API is an
 * explicit commit that bumps `ref`.
 *
 * Two source modes, both deterministic:
 *   - $EKS_AGENT_PLATFORM_DIR points at a checkout (CI checks the pinned SHA
 *     out; locally it can be a sibling working tree)
 *   - otherwise the files are fetched from raw.githubusercontent.com at the
 *     pinned SHA
 *
 * Every failure is loud and fatal — an unreachable source, a missing file, or
 * an unreadable manifest exits non-zero rather than leaving the validator to
 * run against whatever happens to be on disk.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(REPO_ROOT, "schemas", "crds");
const MANIFEST = join(SCHEMA_DIR, "source.json");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function readManifest() {
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
  if (!/^[0-9a-f]{40}$/.test(manifest.ref)) {
    fail(`${MANIFEST} \`ref\` must be a full 40-character commit SHA, got \`${manifest.ref}\``);
  }
  return manifest;
}

async function fetchFromCheckout(checkout, manifest, file) {
  const path = join(checkout, manifest.sourceDir, file);
  try {
    return await readFile(path, "utf8");
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
  return await response.text();
}

async function main() {
  const check = process.argv.includes("--check");
  const manifest = await readManifest();
  const checkout = process.env.EKS_AGENT_PLATFORM_DIR;
  const origin = checkout
    ? `${checkout} ($EKS_AGENT_PLATFORM_DIR)`
    : `${manifest.repo}@${manifest.ref} (raw.githubusercontent.com)`;

  const drifted = [];
  for (const file of manifest.files) {
    const upstream = checkout
      ? await fetchFromCheckout(checkout, manifest, file)
      : await fetchFromGithub(manifest, file);
    if (!upstream.includes("kind: CustomResourceDefinition")) {
      fail(`${file} from ${origin} does not look like a CRD — refusing to vendor it`);
    }
    const dest = join(SCHEMA_DIR, file);
    const current = await readFile(dest, "utf8").catch(() => null);
    if (current === upstream) continue;
    if (check) {
      drifted.push(current === null ? `${file} (missing)` : file);
      continue;
    }
    await writeFile(dest, upstream);
    console.log(`↻ ${file}`);
  }

  if (check && drifted.length > 0) {
    console.error(`✗ vendored CRD schemas drifted from ${origin}:`);
    for (const file of drifted) console.error(`    schemas/crds/${file}`);
    console.error("  run `npm run schemas:crds` to re-sync (never hand-edit the copies)");
    process.exit(1);
  }
  console.log(
    check
      ? `✓ ${manifest.files.length} vendored CRD schemas byte-identical to ${origin}`
      : `✓ synced ${manifest.files.length} CRD schemas from ${origin}`,
  );
}

await main();
