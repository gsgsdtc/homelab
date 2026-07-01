import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initAgentRules } from "./init-agent-rules.mjs";

async function withProject(run) {
  const dir = await mkdtemp(join(tmpdir(), "simple-agent-rules-"));
  try {
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "package.json"), "{}\n", "utf8");
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("creates an initial CLAUDE.md rules file", async () => {
  await withProject(async (cwd) => {
    const result = await initAgentRules({ cwd, file: "CLAUDE.md" });

    assert.equal(result.status, "created");
    assert.equal(result.file, "CLAUDE.md");

    const content = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    assert.match(content, /^# Project Agent Rules/m);
    assert.match(content, /## 项目背景/);
    assert.match(content, /## 开发流程/);
    assert.match(content, /## 代码修改原则/);
    assert.match(content, /## 测试要求/);
    assert.match(content, /## 交付说明/);
  });
});

test("creates an initial AGENTS.md rules file", async () => {
  await withProject(async (cwd) => {
    const result = await initAgentRules({ cwd, file: "AGENTS.md" });

    assert.equal(result.status, "created");
    assert.match(await readFile(join(cwd, "AGENTS.md"), "utf8"), /AGENTS.md/);
  });
});

test("skips an existing rules file without changing it", async () => {
  await withProject(async (cwd) => {
    const existing = "# Existing Rules\n\nKeep manual notes.\n";
    await writeFile(join(cwd, "CLAUDE.md"), existing, "utf8");

    const result = await initAgentRules({ cwd, file: "CLAUDE.md" });

    assert.equal(result.status, "skipped");
    assert.equal(await readFile(join(cwd, "CLAUDE.md"), "utf8"), existing);
  });
});

test("requires an explicit supported rules file", async () => {
  await withProject(async (cwd) => {
    await assert.rejects(
      initAgentRules({ cwd, file: undefined }),
      /choose CLAUDE.md or AGENTS.md/,
    );
    await assert.rejects(
      initAgentRules({ cwd, file: "README.md" }),
      /choose CLAUDE.md or AGENTS.md/,
    );
  });
});

test("requires running from the project root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "simple-agent-rules-"));
  try {
    await assert.rejects(
      initAgentRules({ cwd: dir, file: "CLAUDE.md" }),
      /run this command from the project root/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not treat a nested package.json as the project root", async () => {
  await withProject(async (cwd) => {
    const nested = join(cwd, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "package.json"), "{}\n", "utf8");

    await assert.rejects(
      initAgentRules({ cwd: nested, file: "AGENTS.md" }),
      /run this command from the project root/,
    );
  });
});
