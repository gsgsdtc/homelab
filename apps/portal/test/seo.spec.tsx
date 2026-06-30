import React from "react";
import { render, screen } from "@testing-library/react";
import HomePage, { metadata as homeMetadata } from "../app/page";
import ArticlesPage, {
  metadata as articlesMetadata,
} from "../app/articles/page";
import RootLayout, { metadata as rootMetadata } from "../app/layout";
import robots from "../app/robots";
import sitemap from "../app/sitemap";

describe("portal public SEO surface", () => {
  it("renders a semantic homepage with SEO metadata and Open Graph information", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("banner", { name: /homelab portal/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /homelab public portal/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent(
      /public product updates, guides, and technical notes/i,
    );
    expect(
      screen.getByRole("link", { name: /view articles/i }),
    ).toHaveAttribute("href", "/articles");

    expect(homeMetadata.title).toBe("Homelab Public Portal");
    expect(homeMetadata.description).toContain("SEO-friendly entry point");
    expect(homeMetadata.openGraph).toMatchObject({
      title: "Homelab Public Portal",
      type: "website",
      url: "/",
    });
  });

  it("renders a clear empty state for the article list placeholder", () => {
    render(<ArticlesPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /articles and resources/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      /no articles have been published yet/i,
    );
    expect(articlesMetadata.title).toBe("Articles | Homelab Portal");
    expect(articlesMetadata.description).toContain("content index placeholder");
  });

  it("exposes crawlable robots rules and a sitemap with the public routes", () => {
    expect(robots()).toMatchObject({
      rules: {
        userAgent: "*",
        allow: "/",
      },
      sitemap: "https://homelab.local/sitemap.xml",
    });

    expect(sitemap()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://homelab.local/",
          changeFrequency: "weekly",
          priority: 1,
        }),
        expect.objectContaining({
          url: "https://homelab.local/articles",
          changeFrequency: "weekly",
          priority: 0.7,
        }),
      ]),
    );
  });

  it("defines root metadata and the English document shell", () => {
    const layout = RootLayout({
      children: <main>Portal content</main>,
    }) as React.ReactElement<{ children: React.ReactElement[]; lang: string }>;

    expect(rootMetadata.metadataBase?.toString()).toBe(
      "https://homelab.local/",
    );
    expect(rootMetadata.robots).toMatchObject({
      index: true,
      follow: true,
    });
    expect(layout.props.lang).toBe("en");
  });
});
