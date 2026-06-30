import type { MetadataRoute } from "next";

import { absoluteUrl, publicPages, publishedAt } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPages.map((page) => ({
    url: absoluteUrl(page.path),
    lastModified: publishedAt,
    changeFrequency: "weekly",
    priority: page.priority
  }));
}
