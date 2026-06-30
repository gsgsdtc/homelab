import { describe, expect, it } from "vitest";

import robots from "./robots";

describe("robots.txt", () => {
  it("allows public crawling and points to the sitemap", () => {
    expect(robots()).toEqual({
      rules: {
        userAgent: "*",
        allow: "/"
      },
      sitemap: "https://homelab.local/sitemap.xml"
    });
  });
});
