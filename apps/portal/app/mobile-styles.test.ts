import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

describe("portal mobile styles", () => {
  it("keeps portal pages readable on mobile without viewport-scaled type", () => {
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain(".site-nav");
    expect(css).toContain("flex-direction: column");
    expect(css).toContain(".hero");
    expect(css).toContain("grid-template-columns: 1fr");
    expect(css).toContain(".article-page");
    expect(css).not.toMatch(/font-size:\s*clamp\([^;]*vw/i);
  });
});
