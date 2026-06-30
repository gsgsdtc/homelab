import { describe, expect, it } from "vitest";

import sitemap from "./sitemap";

describe("sitemap.xml", () => {
  it("lists the public portal pages", () => {
    expect(sitemap()).toEqual([
      {
        url: "https://homelab.local/",
        lastModified: new Date("2026-06-30T00:00:00.000Z"),
        changeFrequency: "weekly",
        priority: 1
      },
      {
        url: "https://homelab.local/articles",
        lastModified: new Date("2026-06-30T00:00:00.000Z"),
        changeFrequency: "weekly",
        priority: 0.7
      }
    ]);
  });
});
