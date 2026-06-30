import type { Metadata } from "next";
import Link from "next/link";
import React from "react";

export const metadata: Metadata = {
  title: "Articles | Homelab Portal",
  description:
    "Homelab content index placeholder for future articles, resources, and technical notes.",
  alternates: {
    canonical: "/articles",
  },
  openGraph: {
    title: "Articles | Homelab Portal",
    description:
      "Browse future Homelab articles, resources, and technical notes.",
    type: "website",
    url: "/articles",
  },
};

export default function ArticlesPage() {
  return (
    <div className="site-shell">
      <header aria-label="Homelab Portal" className="site-header">
        <Link className="brand" href="/">
          Homelab
        </Link>
        <nav aria-label="Primary navigation">
          <Link href="/articles" aria-current="page">
            Articles
          </Link>
        </nav>
      </header>

      <main className="article-main">
        <section className="page-heading" aria-labelledby="articles-heading">
          <p className="eyebrow">Content index</p>
          <h1 id="articles-heading">Articles and Resources</h1>
          <p>
            A public home for upcoming product announcements, setup guides, and
            technical notes.
          </p>
        </section>

        <section className="empty-state" aria-label="Article list status">
          <p role="status">
            No articles have been published yet. Check back soon for Homelab
            guides and product updates.
          </p>
        </section>
      </main>
    </div>
  );
}
