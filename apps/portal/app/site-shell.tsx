import Link from "next/link";
import type { ReactNode } from "react";

export function SiteShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="site-shell">
      <header className="site-header">
        <nav className="site-nav" aria-label="Primary navigation">
          <Link className="brand" href="/">
            Homelab Portal
          </Link>
          <div className="nav-links">
            <Link href="/">Home</Link>
            <Link href="/articles">Articles</Link>
            <a href="https://home.gfun.vip:8322/login" target="_blank" rel="noopener noreferrer">
              Admin
            </a>
          </div>
        </nav>
      </header>
      {children}
      <footer className="site-footer" aria-label="Portal shortcuts">
        <div className="footer-inner">
          <div>
            <p className="footer-heading">Quick links</p>
            <p className="footer-brand">Homelab Portal</p>
          </div>
          <nav className="footer-links" aria-label="Footer shortcuts">
            <Link href="/">Home</Link>
            <Link href="/articles">Articles</Link>
            <a href="https://home.gfun.vip:8322/login" target="_blank" rel="noopener noreferrer">
              Admin
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
