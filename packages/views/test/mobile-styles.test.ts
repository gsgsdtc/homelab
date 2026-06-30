import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const adminCss = readFileSync(join(process.cwd(), "../../apps/admin/app/styles.css"), "utf8");

describe("admin mobile styles", () => {
  it("provides mobile table cards and keeps controls inside the viewport", () => {
    expect(adminCss).toContain("@media (max-width: 760px)");
    expect(adminCss).toContain("data-label");
    expect(adminCss).toContain("overflow-wrap: anywhere");
    expect(adminCss).toContain(".table-wrap");
    expect(adminCss).toContain("overflow-x: visible");
    expect(adminCss).not.toMatch(/font-size:\s*clamp\([^;]*vw/i);
  });
});
