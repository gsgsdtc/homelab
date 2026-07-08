export type ServiceLink = {
  icon: string;
  title: string;
  href: string;
};

export function uniqueServiceLinks(links: readonly ServiceLink[]) {
  const seenTitles = new Set<string>();
  const seenHrefs = new Set<string>();

  return links.filter((link) => {
    if (seenTitles.has(link.title) || seenHrefs.has(link.href)) {
      return false;
    }

    seenTitles.add(link.title);
    seenHrefs.add(link.href);
    return true;
  });
}

export const homelabServiceLinks = uniqueServiceLinks([
  { icon: "📊", title: "Grafana", href: "https://home.gfun.vip:8300" },
  { icon: "📋", title: "Plane", href: "https://home.gfun.vip:8301" },
  { icon: "📚", title: "Outline Wiki", href: "https://home.gfun.vip:8302" },
  { icon: "🔐", title: "Authentik", href: "https://home.gfun.vip:8500" },
  { icon: "🖥️", title: "Bastion 跳板机", href: "https://home.gfun.vip:8800" },
  { icon: "🪣", title: "MinIO Console", href: "https://home.gfun.vip:8900" },
  { icon: "🔑", title: "Bitwarden", href: "https://home.gfun.vip:8980" },
  { icon: "🪣", title: "MinIO S3 API", href: "https://home.gfun.vip:9000" },
  { icon: "🧭", title: "服务导航", href: "https://home.gfun.vip:8080" },
  { icon: "⚙️", title: "CLIProxyAPI Backend", href: "https://home.gfun.vip:8317" },
  {
    icon: "🛠️",
    title: "CLIProxyAPI Management Center",
    href: "https://home.gfun.vip:8318"
  },
  { icon: "🚀", title: "Dokploy", href: "https://home.gfun.vip:8319" },
  { icon: "🤖", title: "Multica", href: "https://home.gfun.vip:8320" },
  { icon: "🏡", title: "Homelab Portal", href: "https://home.gfun.vip:8321" },
  { icon: "👨‍💼", title: "Homelab Admin", href: "https://home.gfun.vip:8322" },
  { icon: "🔌", title: "Homelab API", href: "https://home.gfun.vip:8323" }
] as const);
