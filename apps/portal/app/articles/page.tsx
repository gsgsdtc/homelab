import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Articles | Homelab Portal",
  description:
    "Browse operational notes, architecture write-ups, and Homelab articles as they are published.",
  openGraph: {
    title: "Articles | Homelab Portal",
    description:
      "Browse operational notes, architecture write-ups, and Homelab articles as they are published.",
    type: "website",
    url: "/articles"
  }
};

export default function ArticlesPage() {
  return (
    <main className="section article-page">
      <p className="eyebrow">Content</p>
      <h1>Articles</h1>
      <div className="empty-state" role="status">
        <h2>Publishing queue is ready</h2>
        <p>No articles have been published yet.</p>
        <p>
          Future runbooks, architecture notes, and release updates will appear here once the content
          pipeline is connected.
        </p>
        <Link className="button secondary" href="/">
          Back to portal
        </Link>
      </div>
    </main>
  );
}
