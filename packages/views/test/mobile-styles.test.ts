import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const adminCss = readFileSync(
  join(process.cwd(), "../../apps/admin/app/styles.css"),
  "utf8",
);

describe("admin mobile styles", () => {
  it("provides mobile table cards and keeps controls inside the viewport", () => {
    expect(adminCss).toContain("@media (max-width: 760px)");
    expect(adminCss).toContain("data-label");
    expect(adminCss).toContain("overflow-wrap: anywhere");
    expect(adminCss).toContain(".table-wrap");
    expect(adminCss).toContain("overflow-x: visible");
    expect(adminCss).not.toMatch(/font-size:\s*clamp\([^;]*vw/i);
  });

  it("keeps Agent compact priority columns readable at 390x844", () => {
    const compactQuery = adminCss.match(/@media \(max-width: (\d+)px\)/);
    expect(compactQuery).not.toBeNull();
    expect(390).toBeLessThanOrEqual(Number(compactQuery?.[1]));

    const compactCss = adminCss.slice(
      adminCss.indexOf("@media (max-width: 760px)"),
      adminCss.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(compactCss).toMatch(
      /\.agent-table \.agent-column-secondary\s*{[^}]*display:\s*none/s,
    );
    expect(compactCss).toMatch(
      /\.agent-table \.agent-column-name\s*{[^}]*width:\s*auto/s,
    );
    expect(compactCss).toMatch(
      /\.agent-table \.agent-column-status\s*{[^}]*width:\s*\d+(?:\.\d+)?rem/s,
    );
    expect(compactCss).toMatch(
      /\.agent-table \.agent-column-action\s*{[^}]*width:\s*\d+(?:\.\d+)?rem/s,
    );
  });
});
