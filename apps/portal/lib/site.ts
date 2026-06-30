export const siteUrl = "https://homelab.local";
export const publishedAt = new Date("2026-06-30T00:00:00.000Z");

export const publicPages = [
  {
    path: "/",
    priority: 1
  },
  {
    path: "/articles",
    priority: 0.7
  }
] as const;

export function absoluteUrl(path: string) {
  return `${siteUrl}${path}`;
}
