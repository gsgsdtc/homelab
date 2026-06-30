import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";
import { siteUrl } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "Homelab Portal",
  alternates: {
    canonical: "/"
  }
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="site-shell">
          <header className="site-header">
            <nav className="site-nav" aria-label="Primary navigation">
              <Link className="brand" href="/">
                Homelab Portal
              </Link>
              <div className="nav-links">
                <Link href="/">Home</Link>
                <Link href="/articles">Articles</Link>
              </div>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
