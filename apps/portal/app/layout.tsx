import type { Metadata } from "next";
import type { ReactNode } from "react";
import React from "react";
import "./styles.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://homelab.local"),
  title: {
    default: "Homelab Public Portal",
    template: "%s | Homelab Portal",
  },
  description:
    "SEO-friendly public entry point for Homelab updates, guides, and product resources.",
  applicationName: "Homelab Portal",
  openGraph: {
    siteName: "Homelab Portal",
    locale: "en_US",
    type: "website",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
