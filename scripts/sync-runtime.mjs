#!/usr/bin/env node
/**
 * Vendor @nanohype/runtime modules into src/vendor/runtime/.
 *
 * `nanohype/library/runtime` is the single source of truth for these
 * primitives — the same consumption model as the vendored
 * `chart/charts/tenant-chart-base` library chart: consumers carry a
 * byte-identical copy so the repo stays self-contained (no shared package
 * registry between tenant apps at runtime), and a copy that drifts from
 * the source is the defect. Fixes propagate outward from the library,
 * never inward — behavior changes land upstream with their tests, then
 * re-sync here.
 *
 *   node scripts/sync-runtime.mjs            # (re)write the vendored copies
 *   node scripts/sync-runtime.mjs --check    # CI gate: exit 1 if any copy drifted
 *
 * The library source is located via NANOHYPE_DIR (a checkout of
 * nanohype/nanohype), defaulting to a sibling checkout at ../nanohype.
 * Only the modules this app consumes are vendored; the check also fails
 * on unlisted files under src/vendor/runtime/ so unconsumed modules can't
 * accumulate.
 */
import { mkdir, readdir, readFile, rm, copyFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NANOHYPE_DIR = process.env.NANOHYPE_DIR ?? join(ROOT, "..", "nanohype");
const LIB_SRC = join(NANOHYPE_DIR, "library", "runtime", "src");
const DEST = join(ROOT, "src", "vendor", "runtime");
const CHECK = process.argv.includes("--check");

// The modules this app consumes. Vendor only what's used.
const MODULES = ["circuit-breaker.ts", "registry.ts"];

async function main() {
  try {
    await access(LIB_SRC);
  } catch {
    console.error(
      `library source not found at ${LIB_SRC} — set NANOHYPE_DIR to a nanohype/nanohype checkout`,
    );
    process.exit(1);
  }

  let drift = 0;

  if (CHECK) {
    for (const mod of MODULES) {
      let same = false;
      try {
        same =
          (await readFile(join(LIB_SRC, mod), "utf8")) ===
          (await readFile(join(DEST, mod), "utf8"));
      } catch {
        same = false;
      }
      if (same) {
        console.log(`ok  src/vendor/runtime/${mod}`);
      } else {
        console.error(`DRIFT  src/vendor/runtime/${mod} — run \`npm run sync:runtime\``);
        drift++;
      }
    }
    // Unlisted files under the vendor dir are drift too — either the module
    // list above is stale or something unconsumed crept in.
    let present = [];
    try {
      present = await readdir(DEST);
    } catch {
      present = [];
    }
    for (const f of present.sort()) {
      if (!MODULES.includes(f)) {
        console.error(`DRIFT  src/vendor/runtime/${f} is not in the vendored module list`);
        drift++;
      }
    }
    if (drift > 0) process.exit(1);
  } else {
    await rm(DEST, { recursive: true, force: true });
    await mkdir(DEST, { recursive: true });
    for (const mod of MODULES) {
      await copyFile(join(LIB_SRC, mod), join(DEST, mod));
      console.log(`vendored ${mod} -> src/vendor/runtime/${mod}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
