import type { Metadata } from "next";
import Link from "next/link";
import React from "react";

export const metadata: Metadata = {
  title: "Homelab Public Portal",
  description:
    "SEO-friendly entry point for Homelab product updates, guides, and technical notes.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Homelab Public Portal",
    description:
      "Public product updates, guides, and technical notes for Homelab.",
    type: "website",
    url: "/",
  },
};

export default function HomePage() {
  return (
    <div className="site-shell">
      <header aria-label="Homelab Portal" className="site-header">
        <Link className="brand" href="/">
          Homelab
        </Link>
        <nav aria-label="Primary navigation">
          <Link href="/articles">Articles</Link>
        </nav>
      </header>

      <main className="home-main">
        <section className="hero" aria-labelledby="portal-heading">
          <p className="eyebrow">Public portal</p>
          <h1 id="portal-heading">Homelab Public Portal</h1>
          <p className="hero-copy">
            Public product updates, guides, and technical notes for builders who
            need a clear path into Homelab.
          </p>
          <div className="hero-actions">
            <Link className="primary-link" href="/articles">
              View articles
            </Link>
          </div>
        </section>

        <section className="content-band" aria-labelledby="content-heading">
          <div>
            <p className="eyebrow">Content foundation</p>
            <h2 id="content-heading">Ready for future publishing</h2>
          </div>
          <p>
            The portal ships with crawlable routes, semantic page structure,
            Open Graph metadata, and a reserved article index so future content
            can be added without changing the public information architecture.
          </p>
        </section>
      </main>
    </div>
  );
}
