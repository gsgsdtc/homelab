import type { MetadataRoute } from "next";

const siteUrl = "https://homelab.local";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${siteUrl}/`,
      lastModified: new Date("2026-06-30"),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${siteUrl}/articles`,
      lastModified: new Date("2026-06-30"),
      changeFrequency: "weekly",
      priority: 0.7,
    },
  ];
}
