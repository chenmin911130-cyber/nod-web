# Agent notes

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `chenmin911130-cyber/nod-web` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root and ADRs in `docs/adr/`. See `docs/agents/domain.md`.

## Division of labor

- **Fable**（规划 / 审查）：写 GitHub issue 执行单；读 PR diff 对照 issue；核 CI 与 Railway `/api/health`。不改产品代码，不合并。审查时不要跑本地 pytest / tsc / npm test / e2e、不要起本地服务器或搭复现 harness 来「证明修好了」——实现代理已经跑过；看 diff、CI（`gh run list`）、Railway SHA、以及还要不要 `cap:sync` / bundle bump。只有 diff 与执行单矛盾、CI 红、或用户报了真机问题时才往下查，并且从生产日志（Railway MCP `get-logs`）开始，不要先本地复现。
- **Grok**（实现）：按指定 issue 从 `origin/main` 开隔离 worktree 实现；跑该单要求的测试；开 PR；不合并。不要用当前脏工作区。不要把两张产品单塞进同一个 PR。
- 用户说「规划 / 写单 / 验收」→ 按 Fable 职责。用户说「执行 / 按清单做 / 开 PR」→ 按 Grok 职责。
- Hermes 工作台不再承担 nod-web 实现，除非用户当场点名。`#33` / `#35` / `#36` 已结束。

### Self-improve

Record confirmed agent misses in `.cursor/skills/self-improve/errors.md`. Read that log before Watch / listen / Translate / phone-sync work. After a miss, append one entry. See `.cursor/skills/self-improve/SKILL.md`.

## iOS 交付

只走 [docs/ios-deliver.md](docs/ios-deliver.md)：隔离 worktree、完整 SHA、受保护 `cap:sync`、`--out` 清单。不要在主工作区或 Desktop 快捷链接上直接 `npm run cap:ios`，也不要手工 `cap sync`。未给 `--install-ok` 不得装机。
