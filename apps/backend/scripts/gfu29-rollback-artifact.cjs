#!/usr/bin/env node
"use strict";

const { createHash } = require("crypto");
const { execFileSync } = require("child_process");
const { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("fs");
const { resolve } = require("path");

const args = parseArgs(process.argv.slice(2));
const action = args.action || "build";
const repositoryRoot = resolve(__dirname, "../../..");
const outputRoot = resolve(required("output-root"));

if (action === "build") build();
else if (action === "clean") clean();
else fail("INVALID_ROLLBACK_ACTION", "--action must be build or clean");

function build() {
  const sourceRef = args.ref || "6c64adb";
  const sourceCommit = run("git", ["rev-parse", `${sourceRef}^{commit}`], repositoryRoot).trim();
  const artifactRoot = resolve(outputRoot, sourceCommit);
  const sourceRoot = resolve(artifactRoot, "source");
  if (existsSync(sourceRoot)) run("git", ["worktree", "remove", "--force", sourceRoot], repositoryRoot);
  rmSync(artifactRoot, { recursive: true, force: true });
  mkdirSync(artifactRoot, { recursive: true });
  run("git", ["worktree", "add", "--detach", sourceRoot, sourceCommit], repositoryRoot);
  symlinkSync(resolve(repositoryRoot, "node_modules"), resolve(sourceRoot, "node_modules"), "dir");
  symlinkSync(resolve(repositoryRoot, "apps/backend/node_modules"), resolve(sourceRoot, "apps/backend/node_modules"), "dir");
  run("pnpm", ["exec", "nest", "build"], resolve(sourceRoot, "apps/backend"));
  const entrypoint = resolve(sourceRoot, "apps/backend/dist/main.js");
  const artifact = {
    status: "ready",
    sourceCommit,
    artifactRoot,
    entrypoint,
    sha256: createHash("sha256").update(readFileSync(entrypoint)).digest("hex")
  };
  writeFileSync(resolve(artifactRoot, "artifact.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  output(artifact);
}

function clean() {
  if (existsSync(outputRoot)) {
    for (const entry of require("fs").readdirSync(outputRoot)) {
      const sourceRoot = resolve(outputRoot, entry, "source");
      if (existsSync(sourceRoot)) {
        try {
          run("git", ["worktree", "remove", "--force", sourceRoot], repositoryRoot);
        } catch (_error) {
          rmSync(sourceRoot, { recursive: true, force: true });
        }
      }
    }
  }
  rmSync(outputRoot, { recursive: true, force: true });
  run("git", ["worktree", "prune"], repositoryRoot);
  output({ status: "clean", artifactEntries: 0 });
}

function run(command, values, cwd) {
  return execFileSync(command, values, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function parseArgs(values) {
  const parsed = {};
  const normalized = values.filter((value) => value !== "--");
  for (let index = 0; index < normalized.length; index += 2) {
    if (!normalized[index]?.startsWith("--") || normalized[index + 1] === undefined) {
      fail("INVALID_ROLLBACK_ARGUMENTS", "arguments use --key value pairs");
    }
    parsed[normalized[index].slice(2)] = normalized[index + 1];
  }
  return parsed;
}

function required(key) {
  if (!args[key]) fail("INVALID_ROLLBACK_ARGUMENTS", `--${key} is required`);
  return args[key];
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ status: "error", code, message })}\n`);
  process.exit(1);
}
