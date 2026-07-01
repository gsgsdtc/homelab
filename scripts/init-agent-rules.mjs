#!/usr/bin/env node
import { constants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_FILES = new Set(["CLAUDE.md", "AGENTS.md"]);

export async function initAgentRules({ cwd = process.cwd(), file } = {}) {
  if (!SUPPORTED_FILES.has(file)) {
    throw new Error("choose CLAUDE.md or AGENTS.md with --file");
  }
  if (!(await exists(join(cwd, ".git")))) {
    throw new Error("run this command from the project root");
  }

  const target = join(cwd, file);
  if (await exists(target)) {
    return {
      status: "skipped",
      file,
      message: `${file} already exists; edit it directly to add project rules.`,
    };
  }

  await writeFile(target, buildRulesTemplate(file), {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    status: "created",
    file,
    message: `${file} created. Edit it directly as project rules evolve.`,
  };
}

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
) {
  try {
    const result = await initAgentRules({ cwd, file: parseFileArg(argv) });
    process.stdout.write(`${result.message}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

function parseFileArg(argv) {
  const index = argv.indexOf("--file");
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  process.exitCode = await runCli();
}

function buildRulesTemplate(file) {
  return [
    "# Project Agent Rules",
    "",
    `This file is the initial project rules document for ${file}. Keep it simple and update it manually as the project evolves.`,
    "",
    "## 项目背景",
    "- 记录项目用途、主要模块、运行环境和重要约束。",
    "",
    "## 开发流程",
    "- 先阅读 issue、相关代码和已有规则，再开始修改。",
    "- 保持改动范围收敛，遵循仓库现有结构和风格。",
    "",
    "## 代码修改原则",
    "- 不做无关重构，不提交密钥、token 或本机专属配置。",
    "- 已有规则文件后续由人工直接追加和修订。",
    "",
    "## 测试要求",
    "- 对行为变更补充或更新测试。",
    "- 提交前运行相关测试和构建命令，并记录结果。",
    "",
    "## 交付说明",
    "- 交付时说明改动内容、关键文件、验证命令和剩余风险。",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
