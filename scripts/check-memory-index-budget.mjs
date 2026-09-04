#!/usr/bin/env node
// 本机记忆索引(Claude Code auto-memory 的 MEMORY.md)的字节预算 —— **只在超了才说话**。
//
// 它守的是启动上下文那一格:MEMORY.md 每个会话都整份装进系统提示。586 量到本机那份 32.8 KB
// ≈ 12k token,而它自己的规矩是「一行一钩子、内容在专条」。⛔ 这一格**不能**进共享的
// `branch-gate land`(codex 586 审时点名):MEMORY.md 是本机私有面,三个环境路径 / 有无 / 内容
// 各不同,拿它当 land 条件会让别的环境无端拒落地。所以走**本机** SessionStart hook
// (`.claude/settings.local.json`,不进仓),每次开会话核一眼,超了印一行提醒 —— 不拒、不改。
//
// 预算 12 KB:与 CLAUDE.md 那道同一个反推(≈ 2.7 B/token,「这一格 ≤ 4k token」⇒ 11 KB + 1 KB 余量)。
// ⚠ 地板:本机 157 条钩子光文件名就 ≈ 5.5 KB,一行一钩子压完 10.9 KB —— 再往下只能减条目,不是压句子。
// 静默是刻意的:hook 的 stdout 会进上下文,平时多印一行就是多花一行。
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUDGET = 12 * 1024;
// Claude Code 把 cwd 里的非字母数字全换成 `-` 当项目目录名(G:\x\y → G--x-y)。
const proj = process.cwd().replace(/[^A-Za-z0-9]/g, "-");
const p = join(homedir(), ".claude", "projects", proj, "memory", "MEMORY.md");

let size;
try { size = statSync(p).size; } catch { process.exit(0); } // 没有记忆索引的环境:无话可说
if (size <= BUDGET) process.exit(0);

const lines = readFileSync(p, "utf8").split("\n").length;
console.log(
  `⚠ 记忆索引 MEMORY.md 已 ${(size / 1024).toFixed(1)} KB / ${lines} 行,超过预算 ${BUDGET / 1024} KB —— ` +
    `它每个会话整份进上下文。规矩:一行一钩子(≤100 字),论证与判例留在各专条;` +
    `把长出来的那几行压回去。(${p})`,
);
