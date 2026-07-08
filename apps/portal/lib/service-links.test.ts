import { describe, expect, it } from "vitest";

import { homelabServiceLinks, uniqueServiceLinks, type ServiceLink } from "./service-links";

const expectedLinks = [
  ["📊", "Grafana", "https://home.gfun.vip:8300"],
  ["📋", "Plane", "https://home.gfun.vip:8301"],
  ["📚", "Outline Wiki", "https://home.gfun.vip:8302"],
  ["🔐", "Authentik", "https://home.gfun.vip:8500"],
  ["🖥️", "Bastion 跳板机", "https://home.gfun.vip:8800"],
  ["🪣", "MinIO Console", "https://home.gfun.vip:8900"],
  ["🔑", "Bitwarden", "https://home.gfun.vip:8980"],
  ["🪣", "MinIO S3 API", "https://home.gfun.vip:9000"],
  ["🧭", "服务导航", "https://home.gfun.vip:8080"],
  ["⚙️", "CLIProxyAPI Backend", "https://home.gfun.vip:8317"],
  ["🛠️", "CLIProxyAPI Management Center", "https://home.gfun.vip:8318"],
  ["🚀", "Dokploy", "https://home.gfun.vip:8319"],
  ["🤖", "Multica", "https://home.gfun.vip:8320"],
  ["🏡", "Homelab Portal", "https://home.gfun.vip:8321"],
  ["👨‍💼", "Homelab Admin", "https://home.gfun.vip:8322"],
  ["🔌", "Homelab API", "https://home.gfun.vip:8323"]
] satisfies Array<[string, string, string]>;

describe("homelab service links", () => {
  it("keeps the accepted service list complete and ordered", () => {
    expect(homelabServiceLinks).toHaveLength(16);
    expect(homelabServiceLinks.map(({ icon, title, href }) => [icon, title, href])).toEqual(
      expectedLinks
    );
  });

  it("deduplicates by service name or URL while preserving first-seen order", () => {
    const links: ServiceLink[] = [
      { icon: "📊", title: "Grafana", href: "https://home.gfun.vip:8300" },
      { icon: "📋", title: "Plane", href: "https://home.gfun.vip:8301" },
      { icon: "📊", title: "Grafana", href: "https://duplicate.example.com" },
      { icon: "🧭", title: "Duplicate URL", href: "https://home.gfun.vip:8301" },
      { icon: "📚", title: "Outline Wiki", href: "https://home.gfun.vip:8302" }
    ];

    expect(uniqueServiceLinks(links)).toEqual([links[0], links[1], links[4]]);
  });
});
