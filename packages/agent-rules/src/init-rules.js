import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const AGENTS = {
  codex: {
    displayName: "Codex",
    fileName: "AGENTS.md",
    begin: "<!-- BEGIN MULTICA CODEX RULES -->",
    end: "<!-- END MULTICA CODEX RULES -->",
  },
  claude: {
    displayName: "Claude",
    fileName: "CLAUDE.md",
    begin: "<!-- BEGIN MULTICA CLAUDE RULES -->",
    end: "<!-- END MULTICA CLAUDE RULES -->",
  },
};

export async function initAgentRules({ agent, cwd = process.cwd() }) {
  const config = AGENTS[agent];
  if (!config) {
    throw new Error(`unsupported agent: ${agent}`);
  }
  await assertProjectRoot(cwd);

  const filePath = join(cwd, config.fileName);
  const block = buildManagedBlock(config);
  const existing = await readOptional(filePath);
  if (existing === null) {
    await writeFile(filePath, `${block}\n`, "utf8");
    return { status: "created", fileName: config.fileName };
  }

  const next = mergeManagedBlock(existing, block, config);
  if (next.status === "unchanged") {
    return { status: "unchanged", fileName: config.fileName };
  }

  await writeFile(filePath, next.content, "utf8");
  return { status: next.status, fileName: config.fileName };
}

export async function runInitCommand({
  agent,
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  if (argv[0] !== "init" || argv.length > 1) {
    stderr.write(`Usage: ${agent} init\n`);
    return 2;
  }

  try {
    const result = await initAgentRules({ agent, cwd });
    stdout.write(`${result.fileName}: ${result.status}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function assertProjectRoot(cwd) {
  const hasPackage = await exists(join(cwd, "package.json"));
  const hasGit = await exists(join(cwd, ".git"));
  if (!hasPackage && !hasGit) {
    throw new Error(
      "project root not found; run this command from a repository root",
    );
  }
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function mergeManagedBlock(existing, block, config) {
  const beginMatches = [
    ...existing.matchAll(new RegExp(escapeRegExp(config.begin), "g")),
  ];
  const endMatches = [
    ...existing.matchAll(new RegExp(escapeRegExp(config.end), "g")),
  ];

  if (beginMatches.length !== endMatches.length) {
    throw new Error(`${config.fileName}: managed block markers are incomplete`);
  }
  if (beginMatches.length > 1) {
    throw new Error(`${config.fileName}: multiple managed blocks detected`);
  }

  if (beginMatches.length === 0) {
    return {
      status: "appended",
      content: `${trimTrailingWhitespace(existing)}\n\n${block}\n`,
    };
  }

  const start = beginMatches[0].index;
  const end = endMatches[0].index + config.end.length;
  if (endMatches[0].index < start) {
    throw new Error(`${config.fileName}: managed block markers are incomplete`);
  }

  const next = `${existing.slice(0, start)}${block}${existing.slice(end)}`;
  if (next === existing) {
    return { status: "unchanged", content: existing };
  }
  return { status: "updated", content: next };
}

function buildManagedBlock(config) {
  return [
    config.begin,
    `# Multica ${config.displayName} Agent Rules`,
    "",
    "## 项目背景",
    `本文件为 ${config.displayName} 本地 coding agent 提供项目级规则。执行任务前先阅读本文件以及相关代码上下文。`,
    "",
    "## 工作流程",
    "- 先理解 issue、最新评论和现有实现，再决定是否需要修改代码。",
    "- 变更应保持范围收敛，遵循仓库已有技术栈、目录结构和命名方式。",
    "",
    "## 代码修改约束",
    "- 默认保护人工内容，不进行无关重构，不提交密钥、token 或环境专属凭据。",
    "- 不自动创建 issue、不修改 issue 状态、不触发其他 agent，除非任务明确要求。",
    "",
    "## 测试验证",
    "- 对新增或变更行为补充自动化测试。",
    "- 提交前运行相关测试和构建命令，并在交付说明中记录结果。",
    "",
    "## Multica issue 协作",
    "- 读取触发评论并围绕当前请求交付，避免把旧讨论当作最新指令。",
    "- 回复 issue 时说明实现摘要、关键文件、测试命令和结果。",
    "",
    "## 最终交付格式",
    "- 简明说明完成内容、验证结果、PR 或阻塞点。",
    "- 如涉及接口或命令行为变更，明确调用方式和兼容性影响。",
    config.end,
  ].join("\n");
}

function trimTrailingWhitespace(value) {
  return value.replace(/\s+$/u, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
