import { describe, expect, it } from "vitest";
import { stripTypeScript } from "../src/isolate/run-code-tool.js";

describe("stripTypeScript", () => {
  it("strips types from a plain script", async () => {
    const out = await stripTypeScript("const x: number = 1; return x + 2;");
    expect(out).toContain("const x = 1");
    expect(out).toContain("return x + 2");
  });

  it("accepts top-level `export const run = ...` (drops the keyword)", async () => {
    const out = await stripTypeScript(
      "export const run = (i: { x: number }) => i.x * 2;",
    );
    expect(out).toContain("const run = ");
    expect(out).not.toContain("export const");
  });

  it("accepts `export default function`", async () => {
    const out = await stripTypeScript(
      "export default function double(i: { x: number }) { return i.x * 2; }",
    );
    expect(out).toContain("function double");
    expect(out).not.toContain("export default");
  });

  it("rewrites `export default <expr>;` to a __default binding", async () => {
    const out = await stripTypeScript(
      "export default (i: { x: number }) => i.x * 2;",
    );
    expect(out).toContain("const __default = (");
    expect(out).not.toMatch(/^[ \t]*export\s+default/m);
  });

  it("leaves bare scripts unchanged in semantics", async () => {
    const out = await stripTypeScript("return 42;");
    expect(out.trim()).toBe("return 42;");
  });

  it("strips `export function foo(...)`", async () => {
    const out = await stripTypeScript("export function run(i) { return i.x; }");
    expect(out).toContain("function run");
    expect(out).not.toContain("export function");
  });
});
