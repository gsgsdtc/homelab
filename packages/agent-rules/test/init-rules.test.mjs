import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initAgentRules } from "../src/init-rules.js";

async function withTempProject(run) {
  const dir = await mkdtemp(join(tmpdir(), "agent-rules-"));
  try {
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "package.json"), "{}\n", "utf8");
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("codex init creates AGENTS.md without touching CLAUDE.md", async () => {
  await withTempProject(async (dir) => {
    const result = await initAgentRules({ agent: "codex", cwd: dir });

    assert.equal(result.status, "created");
    const content = await readFile(join(dir, "AGENTS.md"), "utf8");
    assert.match(content, /BEGIN MULTICA CODEX RULES/);
    assert.match(content, /项目背景/);
    assert.match(content, /工作流程/);
    assert.match(content, /代码修改约束/);
    assert.match(content, /测试验证/);
    assert.match(content, /Multica issue 协作/);
    assert.match(content, /最终交付格式/);
    await assert.rejects(readFile(join(dir, "CLAUDE.md"), "utf8"), {
      code: "ENOENT",
    });
  });
});

test("claude init creates CLAUDE.md without touching AGENTS.md", async () => {
  await withTempProject(async (dir) => {
    const result = await initAgentRules({ agent: "claude", cwd: dir });

    assert.equal(result.status, "created");
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    assert.match(content, /BEGIN MULTICA CLAUDE RULES/);
    assert.match(content, /Claude/);
    await assert.rejects(readFile(join(dir, "AGENTS.md"), "utf8"), {
      code: "ENOENT",
    });
  });
});

test("init appends a managed block after existing human content", async () => {
  await withTempProject(async (dir) => {
    await writeFile(
      join(dir, "AGENTS.md"),
      "# Existing Rules\n\nKeep this paragraph.\n",
      "utf8",
    );

    const result = await initAgentRules({ agent: "codex", cwd: dir });

    assert.equal(result.status, "appended");
    const content = await readFile(join(dir, "AGENTS.md"), "utf8");
    assert.match(content, /^# Existing Rules\n\nKeep this paragraph\./);
    assert.equal((content.match(/BEGIN MULTICA CODEX RULES/g) ?? []).length, 1);
  });
});

test("init updates only an existing managed block and preserves surrounding content", async () => {
  await withTempProject(async (dir) => {
    await writeFile(
      join(dir, "CLAUDE.md"),
      [
        "# Human intro",
        "",
        "<!-- BEGIN MULTICA CLAUDE RULES -->",
        "old managed text",
        "<!-- END MULTICA CLAUDE RULES -->",
        "",
        "Human footer.",
      ].join("\n"),
      "utf8",
    );

    const result = await initAgentRules({ agent: "claude", cwd: dir });

    assert.equal(result.status, "updated");
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    assert.match(content, /^# Human intro/);
    assert.match(content, /Human footer\.$/);
    assert.doesNotMatch(content, /old managed text/);
    assert.equal(
      (content.match(/BEGIN MULTICA CLAUDE RULES/g) ?? []).length,
      1,
    );
  });
});

test("init is idempotent when the managed block is current", async () => {
  await withTempProject(async (dir) => {
    await initAgentRules({ agent: "codex", cwd: dir });
    const before = await readFile(join(dir, "AGENTS.md"), "utf8");

    const result = await initAgentRules({ agent: "codex", cwd: dir });

    assert.equal(result.status, "unchanged");
    assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), before);
  });
});

test("init run from a nested package writes only to the git root", async () => {
  await withTempProject(async (dir) => {
    const nestedPackage = join(dir, "packages", "app");
    await mkdir(nestedPackage, { recursive: true });
    await writeFile(join(nestedPackage, "package.json"), "{}\n", "utf8");

    const result = await initAgentRules({ agent: "codex", cwd: nestedPackage });

    assert.equal(result.status, "created");
    assert.match(
      await readFile(join(dir, "AGENTS.md"), "utf8"),
      /BEGIN MULTICA CODEX RULES/,
    );
    await assert.rejects(readFile(join(nestedPackage, "AGENTS.md"), "utf8"), {
      code: "ENOENT",
    });
  });
});

test("init fails without modifying files when managed markers are incomplete", async () => {
  await withTempProject(async (dir) => {
    const initial =
      "# Existing\n\n<!-- BEGIN MULTICA CODEX RULES -->\nmissing end marker\n";
    await writeFile(join(dir, "AGENTS.md"), initial, "utf8");

    await assert.rejects(
      initAgentRules({ agent: "codex", cwd: dir }),
      /managed block markers are incomplete/,
    );
    assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), initial);
  });
});

test("init fails without modifying files when multiple managed blocks exist", async () => {
  await withTempProject(async (dir) => {
    const block =
      "<!-- BEGIN MULTICA CLAUDE RULES -->\ntext\n<!-- END MULTICA CLAUDE RULES -->";
    const initial = `${block}\n\n${block}\n`;
    await writeFile(join(dir, "CLAUDE.md"), initial, "utf8");

    await assert.rejects(
      initAgentRules({ agent: "claude", cwd: dir }),
      /multiple managed blocks/,
    );
    assert.equal(await readFile(join(dir, "CLAUDE.md"), "utf8"), initial);
  });
});
