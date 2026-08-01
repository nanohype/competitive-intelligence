#!/usr/bin/env node
/**
 * render-eval-gateway.mjs — emit an `aigw run` config from platform.yaml.
 *
 * The eval tier drives the same client the app does, against
 * MODEL_GATEWAY_ENDPOINT, so it measures the path production runs on. In
 * cluster that endpoint is the one the operator publishes. In CI there is no
 * cluster, and upstream ships `aigw` — the same Envoy AI Gateway translation
 * as a local process — so the tier needs a config describing the same routes.
 *
 * That config is generated rather than written down. A second copy of the
 * routes would drift from `platform.yaml` silently, and drift here does not
 * look like breakage: the gateway starts, the request is translated, and the
 * eval scores a model or a wire format no environment actually deploys. The
 * whole point of running the eval through a gateway is defeated by a gateway
 * configured differently from the real one.
 *
 * The mapping mirrors the operator's `ensureGatewayResources`, which is the
 * authority on how a ModelGateway becomes Envoy AI Gateway objects:
 *
 *   - an anthropic-family foundation route uses the AWSAnthropic upstream
 *     schema, which accepts native Anthropic Messages and translates to
 *     Bedrock; everything else uses AWSBedrock
 *   - the route's `name` is the alias callers send as the model, matched on the
 *     `x-ai-eg-model` header the extproc derives from the request body
 *   - `modelNameOverride` swaps in the real Bedrock identifier upstream, so
 *     model ids stay in the manifest rather than in application config
 *   - BackendSecurityPolicy names a region only; the AWS default credential
 *     chain supplies the rest, which in CI is the eval role
 *
 * Not mirrored, because they are cluster-shaped rather than gateway-shaped:
 * the EnvoyProxy (ServiceAccount pinning, ClusterIP Service) and the rate-limit
 * policy. An eval run is a handful of requests from one process; a limiter
 * would only ever fire as a false failure.
 *
 * Usage: node scripts/render-eval-gateway.mjs [--region <r>] > evals/aigw.yaml
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments, stringify } from "yaml";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The port `aigw run` serves on. Upstream's default; MODEL_GATEWAY_ENDPOINT must agree. */
const LISTENER_PORT = 1975;

/** Bedrock's own API version constant, carried on the backend schema. */
const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

const AI_GROUP = "aigateway.envoyproxy.io";
const AI_VERSION = "v1beta1";
const EG_GROUP = "gateway.envoyproxy.io";
const GW_GROUP = "gateway.networking.k8s.io";

/**
 * Which upstream schema serves a route — the operator's `backendSchemaFor`.
 *
 * An imported open-weight model is never Anthropic-shaped even when its family
 * says otherwise, which is why modelSource is part of the test rather than just
 * the family.
 */
function backendSchemaFor(route) {
  return route.modelSource !== "imported" && route.modelFamily === "anthropic"
    ? "AWSAnthropic"
    : "AWSBedrock";
}

/** The identifier sent upstream — the cross-region profile when one is declared. */
function effectiveModelID(route) {
  return route.crossRegionProfile || route.modelId;
}

function parseArgs(argv) {
  const args = { region: process.env.EVAL_REGION || "us-west-2" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--region") {
      const next = argv[++i];
      if (next === undefined) throw new Error("missing value for --region");
      args.region = next;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

/** Pull the ModelGateway document out of the multi-document manifest. */
export function readRoutes(manifest) {
  const docs = parseAllDocuments(manifest)
    .map((d) => d.toJS())
    .filter(Boolean);
  const gateway = docs.find((d) => d.kind === "ModelGateway");
  if (!gateway) {
    throw new Error("platform.yaml declares no ModelGateway document");
  }
  const routes = gateway.spec?.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    // An empty list would render a gateway that starts cleanly and matches
    // nothing — every eval request would fail routing, and the config would
    // look fine.
    throw new Error("the ModelGateway declares no routes");
  }
  return routes;
}

export function renderGateway(routes, region) {
  const docs = [
    {
      apiVersion: `${GW_GROUP}/v1`,
      kind: "Gateway",
      metadata: { name: "eval" },
      spec: {
        gatewayClassName: "envoy-ai-gateway",
        listeners: [{ name: "http", protocol: "HTTP", port: LISTENER_PORT }],
      },
    },
    {
      apiVersion: `${EG_GROUP}/v1alpha1`,
      kind: "Backend",
      metadata: { name: "bedrock" },
      spec: {
        endpoints: [{ fqdn: { hostname: `bedrock-runtime.${region}.amazonaws.com`, port: 443 } }],
      },
    },
    {
      apiVersion: `${AI_GROUP}/${AI_VERSION}`,
      kind: "AIGatewayRoute",
      metadata: { name: "eval" },
      spec: {
        parentRefs: [{ name: "eval", kind: "Gateway", group: GW_GROUP }],
        rules: routes.map((route) => ({
          matches: [{ headers: [{ type: "Exact", name: "x-ai-eg-model", value: route.name }] }],
          backendRefs: [{ name: route.name, modelNameOverride: effectiveModelID(route) }],
        })),
      },
    },
  ];

  for (const route of routes) {
    docs.push({
      apiVersion: `${AI_GROUP}/${AI_VERSION}`,
      kind: "AIServiceBackend",
      metadata: { name: route.name },
      spec: {
        schema: { name: backendSchemaFor(route), version: BEDROCK_ANTHROPIC_VERSION },
        backendRef: { group: EG_GROUP, kind: "Backend", name: "bedrock" },
      },
    });
    docs.push({
      apiVersion: `${AI_GROUP}/${AI_VERSION}`,
      kind: "BackendSecurityPolicy",
      metadata: { name: route.name },
      spec: {
        targetRefs: [{ group: AI_GROUP, kind: "AIServiceBackend", name: route.name }],
        type: "AWSCredentials",
        awsCredentials: { region },
      },
    });
  }

  const header =
    "# Generated by scripts/render-eval-gateway.mjs from platform.yaml. Do not edit.\n" +
    `# Routes and model ids come from the ModelGateway this app deploys, so the\n` +
    `# eval measures the same translation production does.\n`;

  return header + docs.map((d) => stringify(d, { lineWidth: 100 })).join("---\n");
}

function main() {
  const { region } = parseArgs(process.argv.slice(2));
  const manifest = readFileSync(join(repoRoot, "platform.yaml"), "utf8");
  process.stdout.write(renderGateway(readRoutes(manifest), region));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
