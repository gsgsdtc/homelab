#!/usr/bin/env node
import { runInitCommand } from "../src/init-rules.js";

process.exitCode = await runInitCommand({ agent: "codex" });
