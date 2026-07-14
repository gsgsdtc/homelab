"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

const nav = [
  { href: "/agents", label: "Agent 管理" },
  { href: "/users", label: "用户管理" },
  { href: "/app-keys", label: "AppKey 管理" },
  { href: "/model-providers", label: "模型提供方" },
];

export function AuthShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [status, setStatus] = useState<
    "checking" | "ready" | "login" | "forbidden"
  >("checking");

  useEffect(() => {
    if (!api.getToken()) {
      setStatus("login");
      router.replace("/login");
      return;
    }

    let active = true;
    api
      .me()
      .then((user) => {
        if (active) {
          setStatus(user.role === "ADMIN" ? "ready" : "forbidden");
        }
      })
      .catch(() => {
        if (active) {
          setStatus("login");
          router.replace("/login");
        }
      });
    return () => {
      active = false;
    };
  }, [router]);

  if (status === "checking") {
    return <main className="center-state">正在校验登录态...</main>;
  }

  if (status === "login") {
    return <main className="center-state">请先登录</main>;
  }

  if (status === "forbidden") {
    return (
      <main className="center-state">
        <section
          className="permission-panel"
          aria-labelledby="permission-title"
        >
          <p className="eyebrow">Permission denied</p>
          <h1 id="permission-title">当前账号无权访问管理后台</h1>
          <p>Agent 管理仅向 ADMIN 开放。请使用管理员账号重新登录。</p>
          <button
            onClick={() => {
              api.logout();
              router.replace("/login");
            }}
            type="button"
          >
            返回登录
          </button>
        </section>
      </main>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Homelab</p>
          <h1>管理后台</h1>
        </div>
        <nav>
          {nav.map((item) => (
            <Link
              key={item.href}
              className={pathname === item.href ? "active" : ""}
              href={item.href}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <button
          className="ghost-button"
          type="button"
          onClick={() => {
            api.logout();
            router.replace("/login");
          }}
        >
          退出登录
        </button>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
