# Agent notes

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `chenmin911130-cyber/nod-web` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root and ADRs in `docs/adr/`. See `docs/agents/domain.md`.

### iOS delivery (one entry point)

Exactly one recommended iOS build/install entry point: `scripts/ios-deliver.mjs`, reached
as `npm run cap:ios` (alias `npm run deliver:ios`). `scripts/package-ios.sh` is a
deprecated forwarding shim — do not add a second pipeline, it would bypass the Pods
realpath protection in `scripts/iosWorktreePods.mjs`, which this entry point imports.

```bash
npm run cap:ios -- build   --sha <40-hex> --version <short> --build <n> [--ipa]  # writes delivery-manifest.json
npm run cap:ios -- verify  --manifest <path> [--artifact <exact path>]
npm run cap:ios -- install --manifest <path> --device <udid> --authorize          # reads the device back
npm run cap:ios -- open    # development only (Xcode); not a delivery
```

`--build` is the bundle that run will carry: HEAD's `CURRENT_PROJECT_VERSION` + 1, because
the guarded `cap:sync` bumps it once. A wrong value refuses before `cap:sync`, so nothing is
mutated.

It refuses to build unless HEAD is the requested SHA (present on origin), the tree is
clean outside the generated set, and `node_modules` / `Pods` / local plugins resolve
inside this checkout. Installs are gated on `--authorize` and on the manifest matching
the exact artifact path + digest; a locked or unreadable device is recorded as
`unverified`, never as success. The manifest holds no key material or tokens. Covered by
`npm run test:ios-deliver` (`node scripts/ios-deliver.test.mjs`, fixtures only — no device,
no network). Details: `ios/README.md`.

## Division of labor

- **Fable**（规划 / 审查）：写 GitHub issue 执行单；读 PR diff 对照 issue；核 CI 与 Railway `/api/health`。不改产品代码，不合并。审查时不要跑本地 pytest / tsc / npm test / e2e、不要起本地服务器或搭复现 harness 来「证明修好了」——实现代理已经跑过；看 diff、CI（`gh run list`）、Railway SHA、以及还要不要 `cap:sync` / bundle bump。只有 diff 与执行单矛盾、CI 红、或用户报了真机问题时才往下查，并且从生产日志（Railway MCP `get-logs`）开始，不要先本地复现。
- **Grok**（实现）：按指定 issue 从 `origin/main` 开隔离 worktree 实现；跑该单要求的测试；开 PR；不合并。不要用当前脏工作区。不要把两张产品单塞进同一个 PR。
- 用户说「规划 / 写单 / 验收」→ 按 Fable 职责。用户说「执行 / 按清单做 / 开 PR」→ 按 Grok 职责。
- Hermes 工作台不再承担 nod-web 实现，除非用户当场点名。`#33` / `#35` / `#36` 已结束。

### Self-improve

Record confirmed agent misses in `.cursor/skills/self-improve/errors.md`. Read that log before Watch / listen / Translate / phone-sync work. After a miss, append one entry. See `.cursor/skills/self-improve/SKILL.md`.
