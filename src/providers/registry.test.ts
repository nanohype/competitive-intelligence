import { describe, it, expect } from "vitest";
import { createRegistry } from "./registry.js";

describe("createRegistry", () => {
  it("registers and retrieves a provider", () => {
    const reg = createRegistry<string>("test");
    reg.register("a", () => "hello");
    expect(reg.get("a")).toBe("hello");
  });

  it("throws on unknown provider with available list", () => {
    const reg = createRegistry<string>("widget");
    reg.register("foo", () => "f");
    reg.register("bar", () => "b");
    expect(() => reg.get("baz")).toThrow('Unknown widget provider "baz". Available: foo, bar');
  });

  it("has() returns correct membership", () => {
    const reg = createRegistry<number>("num");
    reg.register("one", () => 1);
    expect(reg.has("one")).toBe(true);
    expect(reg.has("two")).toBe(false);
  });

  it("names() returns registered names", () => {
    const reg = createRegistry<string>("test");
    reg.register("x", () => "x");
    reg.register("y", () => "y");
    expect(reg.names()).toEqual(["x", "y"]);
  });

  it("creates a new instance on each get()", () => {
    const reg = createRegistry<object>("obj");
    reg.register("fresh", () => ({}));
    const a = reg.get("fresh");
    const b = reg.get("fresh");
    expect(a).not.toBe(b);
  });
});
