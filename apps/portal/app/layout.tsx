import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { siteUrl } from "@/lib/site";
import { SiteShell } from "./site-shell";

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
        <SiteShell>{children}</SiteShell>
      </body>
    </html>
  );
}
