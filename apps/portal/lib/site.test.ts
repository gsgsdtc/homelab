import { afterEach, describe, expect, it, vi } from "vitest";

const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

async function loadSiteModule() {
  vi.resetModules();
  return import("./site");
}

describe("site URL configuration", () => {
  afterEach(() => {
    if (originalSiteUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    } else {
      process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
    }
    vi.resetModules();
  });

  it("uses a public default URL instead of a .local SEO URL", async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;

    const { absoluteUrl, siteUrl } = await loadSiteModule();

    expect(siteUrl).toBe("https://homelab.example.com");
    expect(siteUrl).not.toContain(".local");
    expect(absoluteUrl("/sitemap.xml")).toBe("https://homelab.example.com/sitemap.xml");
  });

  it("prefers NEXT_PUBLIC_SITE_URL and normalizes a trailing slash", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://portal.example.org/";

    const { absoluteUrl, siteUrl } = await loadSiteModule();

    expect(siteUrl).toBe("https://portal.example.org");
    expect(absoluteUrl("/articles")).toBe("https://portal.example.org/articles");
  });
});
