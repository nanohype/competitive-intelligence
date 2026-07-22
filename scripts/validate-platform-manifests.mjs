#!/usr/bin/env node
/**
 * Validate `platform.yaml` — the tenant-boundary CRs this repo applies to a
 * cluster — against the real operator CRD schemas, before a cluster ever sees
 * them.
 *
 *   node scripts/validate-platform-manifests.mjs             # the gate
 *   node scripts/validate-platform-manifests.mjs --self-test # prove it rejects
 *   node scripts/validate-platform-manifests.mjs <path>      # a copy elsewhere
 *
 * Four layers of checking:
 *
 * 0. PROVENANCE. Every schema file declared in `schemas/crd/source.json` is
 *    hashed and compared to the SHA-256 recorded there before it is parsed, and
 *    stray YAML in that directory is an error. This is what makes the gate
 *    tamper-evident offline: widening an enum in a vendored copy so the
 *    manifest slips through is caught here, on a laptop with no network, not
 *    only by the CI job that checks the copies against the upstream ref.
 *
 * 1. SCHEMA. Every document is matched to a CRD by apiVersion + kind and walked
 *    against that CRD's `openAPIV3Schema`. The walk is STRICT about unknown
 *    fields, which a stock JSON-schema validator would not be: controller-gen
 *    emits no `additionalProperties: false`, so `allowedModls: [...]` validates
 *    clean under plain jsonschema and is then silently pruned by the apiserver,
 *    leaving a Platform that reconciles with no model access at all. The walker
 *    below treats any property absent from `properties` as an error unless the
 *    schema explicitly opts into open content (`additionalProperties` or
 *    `x-kubernetes-preserve-unknown-fields`).
 *
 * 2. SCOPE. `Tenant` is cluster-scoped and must carry no `metadata.namespace`;
 *    `Platform` and `BudgetPolicy` are namespaced and must carry one. Scope
 *    comes from the CRD's own `spec.scope`, not from a list kept here.
 *
 * 3. CONSISTENCY. The three documents cross-reference each other by name, and
 *    the chart repeats the same names as OTel resource attributes. A rename
 *    that lands in one place and not the others produces a Platform the
 *    operator cannot resolve or telemetry attributed to a tenant that does not
 *    exist, so the links are asserted here:
 *      - Platform.spec.tenant            == Tenant.metadata.name
 *      - Platform.spec.budget.name       == BudgetPolicy.metadata.name
 *      - BudgetPolicy.spec.platformRef   == Platform.metadata.name
 *      - agents.tenant / agents.platform in every chart values file == both
 *
 * Schemas come from `schemas/crd/`, vendored from the operator repo at the ref
 * pinned in `schemas/crd/source.json` by `scripts/sync-crd-schemas.mjs`. If
 * they are missing, altered, or unparseable this exits non-zero and says so — a
 * validation gate that passes because it could not find (or could not trust)
 * its schema is worse than no gate.
 *
 * `--self-test` breaks the inputs in memory several ways — including handing
 * the provenance check a tampered schema — and fails unless every one of them
 * is rejected. It writes nothing. Running it in CI next to the real validation
 * is what keeps the gate's rejection behaviour a tested property rather than an
 * assertion in a comment.
 *
 * CEL (`x-kubernetes-validations`) rules are not evaluated; they are enforced
 * at admission by the apiserver. The one rule that constrains this manifest —
 * `allowedModels` and `allowedModelFamilies` are mutually exclusive — is
 * asserted explicitly in the consistency pass instead.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments, parse as parseYaml } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(REPO_ROOT, "schemas", "crd");
const SOURCE_MANIFEST = join(SCHEMA_DIR, "source.json");

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");
const MANIFEST_PATH = args.find((a) => !a.startsWith("--")) ?? join(REPO_ROOT, "platform.yaml");
const CHART_DIR = join(REPO_ROOT, "chart");

/** Anything that stops the gate from running at all. Never a validation error. */
class GateError extends Error {}

const abort = (message) => {
  throw new GateError(message);
};

const digestOf = (buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * ObjectMeta as the apiserver enforces it. The CRDs describe `metadata` as a
 * bare `{type: object}`, so without this the strict walker would reject every
 * key under it — and a typo like `metadata.lables` would sail through.
 */
const METADATA_SCHEMA = {
  type: "object",
  required: ["name"],
  properties: {
    name: {
      type: "string",
      maxLength: 253,
      pattern: "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$",
    },
    namespace: {
      type: "string",
      maxLength: 63,
      pattern: "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$",
    },
    labels: { type: "object", additionalProperties: { type: "string" } },
    annotations: { type: "object", additionalProperties: { type: "string" } },
    finalizers: { type: "array", items: { type: "string" } },
  },
};

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Strict openAPIV3Schema walk. Pushes human-readable messages onto `errors`. */
function walk(value, schema, path, errors) {
  if (schema === true || schema === undefined || schema === null) return;
  if (schema["x-kubernetes-preserve-unknown-fields"] === true && schema.type === undefined) {
    return;
  }

  const { type } = schema;

  if (type === "object" || (type === undefined && schema.properties)) {
    if (typeOf(value) !== "object") {
      errors.push(`${path}: expected an object, got ${typeOf(value)}`);
      return;
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${path}.${key}: missing required field`);
      }
    }
    const properties = schema.properties ?? {};
    const additional = schema.additionalProperties;
    const open = additional === true || schema["x-kubernetes-preserve-unknown-fields"] === true;
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        walk(child, properties[key], `${path}.${key}`, errors);
      } else if (additional && typeof additional === "object") {
        walk(child, additional, `${path}.${key}`, errors);
      } else if (!open) {
        const known = Object.keys(properties).sort().join(", ");
        errors.push(
          `${path}.${key}: unknown field — not in the CRD schema` +
            (known ? ` (known fields: ${known})` : ""),
        );
      }
    }
    return;
  }

  if (type === "array") {
    if (typeOf(value) !== "array") {
      errors.push(`${path}: expected an array, got ${typeOf(value)}`);
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} items, got ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: expected at most ${schema.maxItems} items, got ${value.length}`);
    }
    for (const [index, item] of value.entries()) {
      walk(item, schema.items, `${path}[${index}]`, errors);
    }
    return;
  }

  if (type === "string") {
    if (typeOf(value) !== "string") {
      errors.push(`${path}: expected a string, got ${typeOf(value)}`);
      return;
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${path}: \`${value}\` is not one of: ${schema.enum.join(", ")}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: \`${value}\` does not match ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
    return;
  }

  if (type === "integer" || type === "number") {
    if (typeOf(value) !== "number" || (type === "integer" && !Number.isInteger(value))) {
      errors.push(
        `${path}: expected ${type === "integer" ? "an integer" : "a number"}, got ${typeOf(value)}`,
      );
      return;
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: ${value} is below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: ${value} is above maximum ${schema.maximum}`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${path}: ${value} is not one of: ${schema.enum.join(", ")}`);
    }
    return;
  }

  if (type === "boolean" && typeOf(value) !== "boolean") {
    errors.push(`${path}: expected a boolean, got ${typeOf(value)}`);
  }
}

// ── provenance ──────────────────────────────────────────────────────────────

async function readSourceManifest() {
  let raw;
  try {
    raw = await readFile(SOURCE_MANIFEST, "utf8");
  } catch (error) {
    abort(
      `cannot read schemas/crd/source.json (${error.message}) — the CRD schemas are vendored ` +
        "into this repo; restore them with `npm run schemas:sync`",
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    abort(`schemas/crd/source.json is not valid JSON: ${error.message}`);
  }
  if (!manifest.upstream?.repository || !/^[0-9a-f]{40}$/.test(manifest.upstream?.ref ?? "")) {
    abort(
      "schemas/crd/source.json needs `upstream.repository` and a full 40-character " +
        "`upstream.ref` — a branch name pins nothing, and the digests below describe " +
        "whatever commit that is",
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    abort("schemas/crd/source.json declares no schema files");
  }
  for (const entry of manifest.files) {
    if (typeof entry?.file !== "string") {
      abort("schemas/crd/source.json `files` entries must be objects with a `file` string");
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")) {
      abort(
        `schemas/crd/source.json entry \`${entry.file}\` carries no 64-character sha256 — ` +
          "the gate refuses to validate against a schema whose provenance it cannot check; " +
          "run `npm run schemas:sync`",
      );
    }
  }
  return manifest;
}

/**
 * Read every declared schema file and verify its digest. Returns the raw bytes
 * so callers (and the self-test) work from exactly what was verified.
 *
 * @returns {Promise<Map<string, Buffer>>} file name → verified bytes
 */
async function readVerifiedSchemaBytes(manifest) {
  let present;
  try {
    present = (await readdir(SCHEMA_DIR)).filter((f) => f.endsWith(".yaml"));
  } catch (error) {
    abort(
      `cannot read the vendored CRD schemas in schemas/crd (${error.message}) — ` +
        "run `npm run schemas:sync` to restore them",
    );
  }

  const declared = new Set(manifest.files.map((entry) => entry.file));
  const stray = present.filter((f) => !declared.has(f)).sort();
  if (stray.length > 0) {
    abort(
      `schemas/crd/ holds YAML that source.json does not declare: ${stray.join(", ")} — ` +
        "an undeclared schema has no recorded digest, so it cannot be trusted",
    );
  }

  const bytes = new Map();
  for (const entry of manifest.files) {
    const path = join(SCHEMA_DIR, entry.file);
    let raw;
    try {
      raw = await readFile(path);
    } catch (error) {
      abort(
        `vendored CRD schema schemas/crd/${entry.file} is missing (${error.message}) — ` +
          "restore it with `npm run schemas:sync`",
      );
    }
    verifyDigest(entry, raw);
    bytes.set(entry.file, raw);
  }
  return bytes;
}

/** Fatal unless `raw` hashes to the digest recorded for it in source.json. */
function verifyDigest(entry, raw) {
  const actual = digestOf(raw);
  if (actual === entry.sha256) return;
  abort(
    `vendored CRD schema schemas/crd/${entry.file} does not match its recorded digest ` +
      `(source.json records ${entry.sha256}, the file hashes ${actual}) — the copies are ` +
      "byte-identical controller-gen output and are never hand-edited; re-vendor with " +
      "`npm run schemas:sync` so the pinned commit and the digests agree",
  );
}

/** Parse verified schema bytes into a registry keyed `group/version/Kind`. */
function buildRegistry(bytes) {
  const byKind = new Map();
  for (const [file, raw] of bytes) {
    let crd;
    try {
      crd = parseYaml(raw.toString("utf8"));
    } catch (error) {
      abort(`schemas/crd/${file} is not parseable YAML: ${error.message}`);
    }
    if (crd?.kind !== "CustomResourceDefinition") {
      abort(`schemas/crd/${file} is not a CustomResourceDefinition`);
    }
    const group = crd.spec?.group;
    const kind = crd.spec?.names?.kind;
    const scope = crd.spec?.scope;
    if (!group || !kind || !scope) {
      abort(`schemas/crd/${file} is missing spec.group / spec.names.kind / spec.scope`);
    }
    for (const version of crd.spec?.versions ?? []) {
      const openAPIV3Schema = version.schema?.openAPIV3Schema;
      if (!openAPIV3Schema) {
        abort(`schemas/crd/${file} version ${version.name} carries no openAPIV3Schema`);
      }
      byKind.set(`${group}/${version.name}/${kind}`, { scope, openAPIV3Schema, file });
    }
  }
  return byKind;
}

// ── inputs ──────────────────────────────────────────────────────────────────

async function loadDocuments(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    abort(`cannot read ${path}: ${error.message}`);
  }
  const parsed = parseAllDocuments(text);
  const documents = [];
  parsed.forEach((doc, index) => {
    for (const error of doc.errors) abort(`${path} document ${index + 1}: ${error.message}`);
    const value = doc.toJS();
    if (value === null || value === undefined) return;
    documents.push(value);
  });
  if (documents.length === 0) abort(`${path} contains no documents`);
  return documents;
}

async function loadChartValues() {
  let files;
  try {
    files = (await readdir(CHART_DIR))
      .filter((f) => f === "values.yaml" || /^values-.+\.yaml$/.test(f))
      .sort();
  } catch (error) {
    abort(`cannot read ${CHART_DIR}: ${error.message}`);
  }
  if (files.length === 0) abort(`${CHART_DIR} contains no values files`);
  return Promise.all(
    files.map(async (file) => ({
      file: `chart/${file}`,
      values: parseYaml(await readFile(join(CHART_DIR, file), "utf8")) ?? {},
    })),
  );
}

// ── checks ──────────────────────────────────────────────────────────────────

/** Parse `k=v,k=v` OTEL_RESOURCE_ATTRIBUTES into a map. */
function parseResourceAttributes(raw) {
  const attributes = {};
  for (const pair of raw.split(",")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    attributes[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return attributes;
}

function checkChartValues(tenantName, platformName, chartValues, errors) {
  for (const { file, values } of chartValues) {
    const raw = values.env?.OTEL_RESOURCE_ATTRIBUTES;
    if (typeof raw !== "string") {
      errors.push(
        `${file}: env.OTEL_RESOURCE_ATTRIBUTES is missing — the platform-tenant ` +
          "contract requires agents.tenant + agents.platform in every values file",
      );
      continue;
    }
    const attributes = parseResourceAttributes(raw);
    for (const [key, expected] of [
      ["agents.tenant", tenantName],
      ["agents.platform", platformName],
    ]) {
      if (attributes[key] === undefined) {
        errors.push(`${file}: env.OTEL_RESOURCE_ATTRIBUTES has no \`${key}\``);
      } else if (attributes[key] !== expected) {
        errors.push(
          `${file}: env.OTEL_RESOURCE_ATTRIBUTES ${key}=\`${attributes[key]}\` ` +
            `but platform.yaml declares \`${expected}\``,
        );
      }
    }

    const declared = values.otel?.resourceAttributes;
    if (declared === undefined) continue;
    for (const [key, expected] of [
      ["agents.tenant", tenantName],
      ["agents.platform", platformName],
    ]) {
      if (declared[key] !== undefined && declared[key] !== expected) {
        errors.push(
          `${file}: otel.resourceAttributes.${key}=\`${declared[key]}\` ` +
            `but platform.yaml declares \`${expected}\``,
        );
      }
    }
  }
}

/**
 * Every check that reads the parsed inputs. Pure: no I/O, no exits — so the
 * self-test can run it over mutated copies.
 *
 * @returns {string[]} every problem found, empty when the manifest is valid.
 */
function validate(documents, schemas, chartValues) {
  const errors = [];

  // ── Layer 1 + 2: schema and scope, per document ──────────────────────────
  documents.forEach((doc, index) => {
    const label = `platform.yaml[${index}]`;
    const { apiVersion, kind } = doc;
    if (typeof apiVersion !== "string" || typeof kind !== "string") {
      errors.push(`${label}: every document needs a string apiVersion and kind`);
      return;
    }
    const crd = schemas.get(`${apiVersion}/${kind}`);
    if (!crd) {
      errors.push(
        `${label}: no vendored CRD for ${apiVersion} ${kind} — known: ` +
          `${[...schemas.keys()].sort().join(", ")}`,
      );
      return;
    }

    const name = doc.metadata?.name ?? "<unnamed>";
    const where = `${kind}/${name}`;
    const namespace = doc.metadata?.namespace;
    if (crd.scope === "Cluster" && namespace !== undefined) {
      errors.push(
        `${where}: ${kind} is cluster-scoped (${crd.file} spec.scope: Cluster) but carries ` +
          `metadata.namespace: ${namespace}`,
      );
    }
    if (crd.scope === "Namespaced" && (namespace === undefined || namespace === "")) {
      errors.push(
        `${where}: ${kind} is namespaced (${crd.file} spec.scope: Namespaced) but carries no ` +
          "metadata.namespace",
      );
    }

    const rootSchema = {
      ...crd.openAPIV3Schema,
      properties: { ...crd.openAPIV3Schema.properties, metadata: METADATA_SCHEMA },
    };
    walk(doc, rootSchema, where, errors);
  });

  // ── Layer 3: the documents cross-reference each other ────────────────────
  const of = (kind) => documents.filter((d) => d.kind === kind);
  const tenants = of("Tenant");
  const platforms = of("Platform");
  const budgets = of("BudgetPolicy");

  for (const [kind, found] of [
    ["Tenant", tenants],
    ["Platform", platforms],
    ["BudgetPolicy", budgets],
  ]) {
    if (found.length !== 1) {
      errors.push(`platform.yaml declares ${found.length} ${kind} documents, expected exactly 1`);
    }
  }

  const tenant = tenants[0];
  const platform = platforms[0];
  const budget = budgets[0];

  if (tenant && platform) {
    if (platform.spec?.tenant !== tenant.metadata?.name) {
      errors.push(
        `Platform.spec.tenant=\`${platform.spec?.tenant}\` does not match the Tenant in this ` +
          `file (\`${tenant.metadata?.name}\`) — the operator resolves the owning Tenant by ` +
          "that name and would find nothing",
      );
    }
    const expectedNamespace = `tenants-${tenant.metadata?.name}`;
    if (platform.metadata?.namespace !== expectedNamespace) {
      errors.push(
        `Platform.metadata.namespace=\`${platform.metadata?.namespace}\` — this repo authors ` +
          `the namespaced CRs in the owning team's control-plane namespace ` +
          `\`${expectedNamespace}\``,
      );
    }
  }

  if (platform) {
    // The CRD enforces this at admission with a CEL rule; CEL is not evaluated
    // here, so the one rule that constrains this manifest is asserted directly.
    const identity = platform.spec?.identity ?? {};
    if (identity.allowedModels?.length > 0 && identity.allowedModelFamilies?.length > 0) {
      errors.push(
        "Platform.spec.identity.allowedModels and allowedModelFamilies are mutually " +
          "exclusive (CRD admission rule) — declare one or the other",
      );
    }
  }

  if (platform && budget) {
    if (platform.spec?.budget?.name !== budget.metadata?.name) {
      errors.push(
        `Platform.spec.budget.name=\`${platform.spec?.budget?.name}\` does not match ` +
          `BudgetPolicy \`${budget.metadata?.name}\``,
      );
    }
    if (budget.spec?.platformRef?.name !== platform.metadata?.name) {
      errors.push(
        `BudgetPolicy.spec.platformRef.name=\`${budget.spec?.platformRef?.name}\` does not ` +
          `match Platform \`${platform.metadata?.name}\``,
      );
    }
    if (budget.metadata?.namespace !== platform.metadata?.namespace) {
      errors.push(
        `BudgetPolicy is in \`${budget.metadata?.namespace}\` but Platform is in ` +
          `\`${platform.metadata?.namespace}\` — a BudgetPolicy reference only resolves ` +
          "within one namespace",
      );
    }
  }

  if (tenant && budget) {
    const cap = Number(tenant.spec?.aggregateMonthlyBudgetUsd);
    const spend = Number(budget.spec?.monthlyUsd);
    if (Number.isFinite(cap) && Number.isFinite(spend) && spend > cap) {
      errors.push(
        `BudgetPolicy.spec.monthlyUsd=${spend} exceeds ` +
          `Tenant.spec.aggregateMonthlyBudgetUsd=${cap}`,
      );
    }
  }

  if (tenant && platform) {
    checkChartValues(tenant.metadata?.name, platform.metadata?.name, chartValues, errors);
  }

  return errors;
}

// ── self-test ───────────────────────────────────────────────────────────────

/**
 * Break the inputs in memory and assert each break is rejected, then assert the
 * committed inputs pass. Nothing is written. The first case covers the
 * provenance layer — the one a schema-trusting gate misses — by handing
 * `verifyDigest` a schema whose bytes have been edited the way a widened enum
 * would edit them.
 *
 * @returns {string[]} descriptions of the cases that did NOT behave
 */
function selfTest(documents, schemaBytes, sourceManifest, schemas, chartValues) {
  const failures = [];
  const log = (ok, line) => console.log(`  ${ok ? "PASS" : "FAIL"}  ${line}`);

  // Provenance: a tampered vendored schema must never reach the walker.
  {
    const entry = sourceManifest.files.find((f) => f.file.endsWith("_platforms.yaml"));
    const original = schemaBytes.get(entry.file).toString("utf8");
    const tampered = Buffer.from(
      original.replace("- vcluster", "- vcluster\n                - any"),
    );
    let rejected = false;
    let detail = "";
    if (tampered.equals(schemaBytes.get(entry.file))) {
      detail = "the tamper edit did not change the file — self-test case is stale";
    } else {
      try {
        verifyDigest(entry, tampered);
      } catch (error) {
        rejected = error instanceof GateError;
        detail = error.message.split(" — ")[0];
      }
    }
    log(rejected, `rejects: a tampered vendored schema (${entry.file}, isolation enum widened)`);
    if (rejected) console.log(`        → ${detail}`);
    else failures.push(`tampered schema accepted: ${detail || "no error raised"}`);
  }

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const find = (docs, kind) => docs.find((d) => d.kind === kind);

  const cases = [
    {
      name: "an unknown field on Tenant.spec",
      mutate: ({ docs }) => {
        find(docs, "Tenant").spec.aggregateMonthlyBudget = "5000";
      },
      expect: /unknown field/,
    },
    {
      name: "a required field removed from Platform.spec",
      mutate: ({ docs }) => {
        delete find(docs, "Platform").spec.budget;
      },
      expect: /\.budget: missing required field/,
    },
    {
      name: "Platform.spec.tenant naming a Tenant this file does not declare",
      mutate: ({ docs }) => {
        find(docs, "Platform").spec.tenant = "marketing";
      },
      expect: /does not match the Tenant in this file/,
    },
    {
      name: "metadata.namespace on the cluster-scoped Tenant",
      mutate: ({ docs }) => {
        find(docs, "Tenant").metadata.namespace = "tenants-strategy";
      },
      expect: /is cluster-scoped .* but carries metadata\.namespace/,
    },
    {
      name: "allowedModels and allowedModelFamilies both set",
      mutate: ({ docs }) => {
        find(docs, "Platform").spec.identity.allowedModelFamilies = ["anthropic.claude"];
      },
      expect: /mutually exclusive/,
    },
    {
      name: "a chart values file whose agents.tenant drifted from the Tenant",
      mutate: ({ values }) => {
        values[0].values.env.OTEL_RESOURCE_ATTRIBUTES = String(
          values[0].values.env.OTEL_RESOURCE_ATTRIBUTES,
        ).replace("agents.tenant=strategy", "agents.tenant=marketing");
      },
      expect: /agents\.tenant=`marketing`/,
    },
  ];

  for (const { name, mutate, expect } of cases) {
    const docs = clone(documents);
    const values = clone(chartValues);
    mutate({ docs, values });
    const errors = validate(docs, schemas, values);
    const hit = errors.find((e) => expect.test(e));
    log(Boolean(hit), `rejects: ${name}`);
    if (hit) console.log(`        → ${hit}`);
    else failures.push(`${name} (gate reported: ${errors.join("; ") || "no errors"})`);
  }

  const clean = validate(clone(documents), schemas, clone(chartValues));
  log(clean.length === 0, "accepts: the committed platform.yaml");
  if (clean.length > 0) failures.push(`committed platform.yaml rejected: ${clean.join("; ")}`);

  return failures;
}

// ── driver ──────────────────────────────────────────────────────────────────

async function main() {
  const sourceManifest = await readSourceManifest();
  const schemaBytes = await readVerifiedSchemaBytes(sourceManifest);
  const schemas = buildRegistry(schemaBytes);
  const documents = await loadDocuments(MANIFEST_PATH);
  const chartValues = await loadChartValues();

  if (SELF_TEST) {
    console.log("platform.yaml gate — self-test");
    const failures = selfTest(documents, schemaBytes, sourceManifest, schemas, chartValues);
    if (failures.length > 0) {
      console.error(`\n✗ gate self-test failed:\n${failures.map((f) => `    ${f}`).join("\n")}\n`);
      process.exit(1);
    }
    console.log("✓ gate self-test passed");
    return;
  }

  const errors = validate(documents, schemas, chartValues);
  if (errors.length > 0) {
    console.error(`✗ ${MANIFEST_PATH} failed validation (${errors.length} problems):\n`);
    for (const error of errors) console.error(`    ${error}`);
    console.error("");
    process.exit(1);
  }

  console.log(
    `✓ ${schemaBytes.size} vendored CRD schemas match the digests in schemas/crd/source.json ` +
      `(${sourceManifest.upstream.repository}@${sourceManifest.upstream.ref.slice(0, 12)})`,
  );
  console.log(`✓ ${documents.length} documents in platform.yaml validate against schemas/crd/`);
  for (const doc of documents) {
    const scope = schemas.get(`${doc.apiVersion}/${doc.kind}`).scope;
    const where = doc.metadata?.namespace ? ` in ${doc.metadata.namespace}` : " (cluster-scoped)";
    console.log(`    ${doc.kind}/${doc.metadata.name}${where} — ${scope}`);
  }
  const tenant = documents.find((d) => d.kind === "Tenant");
  const platform = documents.find((d) => d.kind === "Platform");
  console.log(
    `✓ tenant \`${tenant.metadata.name}\` / platform \`${platform.metadata.name}\` consistent ` +
      `across platform.yaml and ${chartValues.length} chart values files`,
  );
}

await main().catch((error) => {
  console.error(
    error instanceof GateError
      ? `✗ the platform.yaml gate cannot run: ${error.message}`
      : `✗ the platform.yaml gate failed: ${error.stack ?? error.message}`,
  );
  process.exit(1);
});
