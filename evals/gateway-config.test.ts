/**
 * The generated eval gateway.
 *
 * `render-eval-gateway.mjs` decides what the eval tier actually measures. Get
 * the upstream schema wrong and it grades a different wire format; get the
 * model id wrong and it grades a different model. Neither looks like breakage —
 * the gateway starts, the request translates, and a number comes out.
 *
 * So these assert the mapping against `platform.yaml` itself rather than
 * against a fixture: a fixture would go on agreeing with the generator after
 * both had drifted away from what this app deploys.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
// @ts-expect-error — a plain .mjs script with no declarations; the shapes it
// returns are asserted here rather than typed.
import { readRoutes, renderGateway } from "../scripts/render-eval-gateway.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = readFileSync(join(repoRoot, "platform.yaml"), "utf8");

const routes = readRoutes(manifest) as Array<Record<string, unknown>>;
const rendered = renderGateway(routes, "us-west-2") as string;
const docs = rendered
  .split("\n---\n")
  .map((d) => parse(d))
  .filter(Boolean) as Array<Record<string, any>>;

const byKind = (kind: string) => docs.filter((d) => d.kind === kind);

/**
 * Look one document up, failing when it is absent.
 *
 * A route with no AIServiceBackend is a real defect — the rule matches and
 * then routes nowhere — so an absent document must fail the test rather than
 * make its assertions vacuous through optional chaining.
 */
function backendFor(name: string): Record<string, any> {
  const found = byKind("AIServiceBackend").find((d) => d.metadata.name === name);
  if (!found) throw new Error(`no AIServiceBackend rendered for route "${name}"`);
  return found;
}

describe("the routes come from platform.yaml", () => {
  it("reads the ModelGateway's routes, not another document's", () => {
    const declared = parseAllDocuments(manifest)
      .map((d) => d.toJS())
      .find((d: any) => d?.kind === "ModelGateway")?.spec.routes;
    expect(routes.map((r) => r.name)).toEqual(declared.map((r: any) => r.name));
  });

  it("refuses a manifest with no ModelGateway", () => {
    expect(() => readRoutes("kind: Platform\n")).toThrow(/no ModelGateway/);
  });

  it("refuses a ModelGateway with no routes", () => {
    // A gateway with zero rules starts cleanly and matches nothing. Every eval
    // request would fail routing while the config looked fine.
    expect(() => readRoutes("kind: ModelGateway\nspec:\n  routes: []\n")).toThrow(/no routes/);
  });
});

describe("the mapping mirrors the operator", () => {
  it("gives every declared route the schema its family and source imply", () => {
    // AWSAnthropic keeps the native Messages shape end to end — thinking
    // blocks, cache points and tool use intact. AWSBedrock on an
    // anthropic-family route would silently grade the OpenAI shape instead,
    // and the eval would still produce a number.
    //
    // Asserted per route rather than by partitioning and requiring both halves
    // to be non-empty: a repo may legitimately declare only one kind, and a
    // test that demanded both would fail on a correct manifest. The branch not
    // exercised here is covered by the synthetic case below.
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const expected =
        route.modelSource !== "imported" && route.modelFamily === "anthropic"
          ? "AWSAnthropic"
          : "AWSBedrock";
      expect(backendFor(String(route.name)).spec.schema.name).toBe(expected);
    }
  });

  it("treats an imported anthropic-family model as AWSBedrock", () => {
    // An imported open-weight model is not Anthropic-shaped whatever its family
    // says, which is why modelSource is part of the test and not just family.
    const imported = renderGateway(
      [{ name: "x", modelFamily: "anthropic", modelSource: "imported", modelId: "m" }],
      "us-west-2",
    ) as string;
    const backend = imported
      .split("\n---\n")
      .map((d) => parse(d))
      .find((d: any) => d?.kind === "AIServiceBackend") as any;
    expect(backend.spec.schema.name).toBe("AWSBedrock");
  });

  it("sends the cross-region profile upstream when one is declared", () => {
    // The bare foundation-model id is rejected by InvokeModel for the current
    // Claude family, so grading against it would fail every case at the model.
    const rules = byKind("AIGatewayRoute")[0].spec.rules;
    for (const route of routes) {
      const rule = rules.find((r: any) => r.matches[0].headers[0].value === route.name);
      expect(rule.backendRefs[0].modelNameOverride).toBe(route.crossRegionProfile ?? route.modelId);
    }
  });

  it("matches on the header the extproc derives from the body", () => {
    for (const rule of byKind("AIGatewayRoute")[0].spec.rules) {
      expect(rule.matches[0].headers[0]).toMatchObject({ type: "Exact", name: "x-ai-eg-model" });
    }
  });

  it("points every route's backend at the one Bedrock upstream", () => {
    const host = byKind("Backend")[0].spec.endpoints[0].fqdn;
    expect(host).toEqual({ hostname: "bedrock-runtime.us-west-2.amazonaws.com", port: 443 });
    for (const backend of byKind("AIServiceBackend")) {
      expect(backend.spec.backendRef.name).toBe("bedrock");
    }
  });

  it("carries a credential policy naming only a region", () => {
    // A static credential anywhere here would be a second way to reach a model.
    for (const policy of byKind("BackendSecurityPolicy")) {
      expect(policy.spec.type).toBe("AWSCredentials");
      expect(policy.spec.awsCredentials).toEqual({ region: "us-west-2" });
      expect(JSON.stringify(policy)).not.toMatch(/accessKey|secretKey|credentialsFile/i);
    }
  });

  it("honours the region it is given", () => {
    const eu = renderGateway(routes, "eu-west-1");
    expect(eu).toContain("bedrock-runtime.eu-west-1.amazonaws.com");
    expect(eu).not.toContain("us-west-2.amazonaws.com");
  });
});

describe("the listener agrees with what the workflow points at", () => {
  it("serves the port aigw defaults to", () => {
    // MODEL_GATEWAY_ENDPOINT in evals.yml is http://localhost:1975. A mismatch
    // here is a connection refused that reads as the gateway being broken.
    expect(byKind("Gateway")[0].spec.listeners[0].port).toBe(1975);
  });

  it("covers every declared route, so none fails to match at eval time", () => {
    const matched = byKind("AIGatewayRoute")[0].spec.rules.map(
      (r: any) => r.matches[0].headers[0].value,
    );
    expect(matched.sort()).toEqual(routes.map((r) => r.name).sort());
  });
});
