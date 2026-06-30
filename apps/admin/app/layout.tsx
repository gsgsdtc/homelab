import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Homelab Admin",
  description: "Admin console for Homelab users and AppKeys"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
