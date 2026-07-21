#!/usr/bin/env node
/**
 * Validate `platform.yaml` — the tenant-boundary CRs this repo applies to a
 * cluster — against the real operator CRD schemas, before a cluster ever sees
 * them.
 *
 *   node scripts/validate-platform-manifests.mjs
 *
 * Three layers of checking:
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
 * Schemas come from `schemas/crds/`, vendored from the operator repo at a
 * pinned SHA by `scripts/sync-crd-schemas.mjs`. If they are missing or
 * unparseable this exits non-zero and says so — a validation gate that passes
 * because it could not find its schema is worse than no gate.
 *
 * CEL (`x-kubernetes-validations`) rules are not evaluated; they are enforced
 * at admission by the apiserver.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments, parse as parseYaml } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(REPO_ROOT, "schemas", "crds");

const MANIFEST_PATH = process.argv[2] ?? join(REPO_ROOT, "platform.yaml");
const CHART_DIR = process.argv[3] ?? join(REPO_ROOT, "chart");

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

function fatal(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

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

/** Load the vendored CRDs, keyed `group/version/Kind`. */
async function loadSchemas() {
  let entries;
  try {
    entries = (await readdir(SCHEMA_DIR)).filter((f) => f.endsWith(".yaml")).sort();
  } catch (error) {
    fatal(
      `cannot read the vendored CRD schemas in schemas/crds (${error.message}) — ` +
        "run `npm run schemas:crds` to restore them",
    );
  }
  if (entries.length === 0) {
    fatal("schemas/crds contains no CRD files — run `npm run schemas:crds` to restore them");
  }

  const byKind = new Map();
  for (const entry of entries) {
    const path = join(SCHEMA_DIR, entry);
    let crd;
    try {
      crd = parseYaml(await readFile(path, "utf8"));
    } catch (error) {
      fatal(`schemas/crds/${entry} is not parseable YAML: ${error.message}`);
    }
    if (crd?.kind !== "CustomResourceDefinition") {
      fatal(`schemas/crds/${entry} is not a CustomResourceDefinition`);
    }
    const group = crd.spec?.group;
    const kind = crd.spec?.names?.kind;
    const scope = crd.spec?.scope;
    if (!group || !kind || !scope) {
      fatal(`schemas/crds/${entry} is missing spec.group / spec.names.kind / spec.scope`);
    }
    for (const version of crd.spec?.versions ?? []) {
      const openAPIV3Schema = version.schema?.openAPIV3Schema;
      if (!openAPIV3Schema) {
        fatal(`schemas/crds/${entry} version ${version.name} carries no openAPIV3Schema`);
      }
      byKind.set(`${group}/${version.name}/${kind}`, { scope, openAPIV3Schema, file: entry });
    }
  }
  return byKind;
}

async function loadDocuments(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    fatal(`cannot read ${path}: ${error.message}`);
  }
  const parsed = parseAllDocuments(text);
  const documents = [];
  parsed.forEach((doc, index) => {
    for (const error of doc.errors) fatal(`${path} document ${index + 1}: ${error.message}`);
    const value = doc.toJS();
    if (value === null || value === undefined) return;
    documents.push(value);
  });
  if (documents.length === 0) fatal(`${path} contains no documents`);
  return documents;
}

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

async function checkChartValues(tenantName, platformName, errors) {
  let files;
  try {
    files = (await readdir(CHART_DIR))
      .filter((f) => f === "values.yaml" || /^values-.+\.yaml$/.test(f))
      .sort();
  } catch (error) {
    fatal(`cannot read ${CHART_DIR}: ${error.message}`);
  }
  if (files.length === 0) fatal(`${CHART_DIR} contains no values files`);

  for (const file of files) {
    const values = parseYaml(await readFile(join(CHART_DIR, file), "utf8")) ?? {};
    const raw = values.env?.OTEL_RESOURCE_ATTRIBUTES;
    if (typeof raw !== "string") {
      errors.push(
        `chart/${file}: env.OTEL_RESOURCE_ATTRIBUTES is missing — the platform-tenant ` +
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
        errors.push(`chart/${file}: env.OTEL_RESOURCE_ATTRIBUTES has no \`${key}\``);
      } else if (attributes[key] !== expected) {
        errors.push(
          `chart/${file}: env.OTEL_RESOURCE_ATTRIBUTES ${key}=\`${attributes[key]}\` ` +
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
          `chart/${file}: otel.resourceAttributes.${key}=\`${declared[key]}\` ` +
            `but platform.yaml declares \`${expected}\``,
        );
      }
    }
  }
  return files;
}

async function main() {
  const schemas = await loadSchemas();
  const documents = await loadDocuments(MANIFEST_PATH);
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

  const valuesFiles =
    tenant && platform
      ? await checkChartValues(tenant.metadata?.name, platform.metadata?.name, errors)
      : [];

  if (errors.length > 0) {
    console.error(`✗ ${MANIFEST_PATH} failed validation (${errors.length} problems):\n`);
    for (const error of errors) console.error(`    ${error}`);
    console.error("");
    process.exit(1);
  }

  console.log(`✓ ${documents.length} documents in platform.yaml validate against schemas/crds/`);
  for (const doc of documents) {
    const scope = schemas.get(`${doc.apiVersion}/${doc.kind}`).scope;
    const where = doc.metadata?.namespace ? ` in ${doc.metadata.namespace}` : " (cluster-scoped)";
    console.log(`    ${doc.kind}/${doc.metadata.name}${where} — ${scope}`);
  }
  console.log(
    `✓ tenant \`${tenant.metadata.name}\` / platform \`${platform.metadata.name}\` consistent ` +
      `across platform.yaml and ${valuesFiles.length} chart values files`,
  );
}

await main();
