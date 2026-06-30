import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Homelab Portal | Private cloud operations",
  description:
    "A public entry point for Homelab operations, infrastructure notes, and future articles.",
  openGraph: {
    title: "Homelab Portal",
    description:
      "A public entry point for Homelab operations, infrastructure notes, and future articles.",
    type: "website",
    url: "/"
  }
};

const features = [
  {
    title: "Operational visibility",
    body: "A focused starting point for service status, maintenance notes, and system ownership."
  },
  {
    title: "Search-ready content",
    body: "Semantic pages, metadata, sitemap, and robots configuration are in place from day one."
  },
  {
    title: "Publishing path",
    body: "The articles entry is ready for future runbooks, postmortems, and architecture write-ups."
  }
];

export default function HomePage() {
  return (
    <main>
      <section className="section hero" aria-labelledby="portal-title">
        <div>
          <p className="eyebrow">Public portal</p>
          <h1 id="portal-title">Homelab Portal</h1>
          <p className="lead">
            Operate a resilient personal cloud with a public-facing home for service context,
            infrastructure notes, and future content publishing.
          </p>
          <div className="actions">
            <Link className="button" href="/articles">
              View articles
            </Link>
            <a className="button secondary" href="#platform">
              Explore platform
            </a>
          </div>
        </div>

        <figure className="portal-visual">
          <Image
            src="/images/homelab-portal-hero.png"
            alt="Homelab server nodes and an operations dashboard"
            width={1586}
            height={992}
            priority
            sizes="(max-width: 760px) 100vw, 48vw"
          />
          <figcaption>SEO-ready public gateway for homelab operations.</figcaption>
        </figure>
      </section>

      <section id="platform" className="content-band" aria-labelledby="platform-title">
        <div className="section">
          <h2 id="platform-title">Portal foundation</h2>
          <div className="feature-grid">
            {features.map((feature) => (
              <article className="feature" key={feature.title}>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
