# Agent notes

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `chenmin911130-cyber/nod-web` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### 执行单标准

每张交给实现代理的 issue 必须按 `docs/agents/ticket-template.md` 写，§0–§6 缺一节不算执行单：触发条件与期望行为、根因证据（基线 SHA + `文件:行`，未确认项标 `[未确认]`）、修改范围与禁改项、回归测试与边界条件、验收命令与通过标准、执行者质疑条款。验收命令只写仓库里真实存在的脚本（没有 `npm run test:golden`）。执行者发现证据不支持根因，先在 issue 评论反馈，不硬改。审查按 §5 逐条核，单里要求的测试没跑到，PR 不放行。

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

`--build` is the bundle this delivery carries, **given explicitly** as a non-negative integer;
the tool pins it by passing `NOD_IOS_BUNDLE` to the guarded `cap:sync` (`prepare-ios-web.mjs`
writes that value instead of incrementing). After `cap:sync` the run asserts
`CURRENT_PROJECT_VERSION == --build`; if the pin did not take effect it refuses to archive.
A missing or non-integer `--build` is refused. See `docs/ios-deliver.md`.

It refuses to build unless HEAD is the requested SHA (present on origin), the tree is
clean outside the generated set, and `node_modules` / `Pods` / local plugins resolve
inside this checkout. Installs are gated on `--authorize` and on the manifest matching
the exact artifact path + digest; a locked or unreadable device is recorded as
`unverified`, never as success. The manifest holds no key material or tokens. Covered by
`npm run test:ios-deliver` (`node scripts/ios-deliver.test.mjs`, fixtures only — no device,
no network). Details: `ios/README.md`.

### Native compile gate (before archive / install)

`npm run check:ios` (`node scripts/iosCompileGate.mjs`) compiles the **real** `App` scheme,
which builds the App target, the WatchApp target and the local pods (NodAuth / NodMic /
NodSplash / NodWatch) for iOS Simulator and watchOS Simulator in one pass. Run it after any
Swift change and before `cap:ios build`:

```bash
npm run check:ios                                       # ~3 s warm, ~25 s cold, ~65 s empty module cache
npm run check:ios -- --device --configuration Release    # device / Release variant
npm run check:ios -- --help
```

It exists because the hand-written file lists in `scripts/test-watch-replay.sh` and the
watchOS `swiftc -typecheck` both omitted
`plugins/nod-watch/ios/Sources/NodWatchPlugin/NodWatchPlugin.swift`: a duplicate `copyId:`
argument passed both gates and only failed at the first real `xcodebuild`, i.e. at install
time on an already merged `main` — neither list ever named that file. The `App` scheme is the
real build dependency graph, so everything that is in a target gets compiled, including a
plugin newly added to the Podfile; a new source file that was never added to a target's
membership still compiles to nothing and leaves this gate green. `test-watch-replay.sh` still
owns behaviour tests — this gate only answers "do the real targets still compile?", needs no
signing identity, and never writes inside the checkout.

Its precondition checks prove **presence and Pods/lock consistency, not freshness**: they do
not compare `ios/App/App/public` against the current `web/dist`, nor the Podfile against the
current plugin set, so a `cap:sync` skipped after a web or plugin change is not caught here
(the delivery path's `assertWebAssets` / `localPodFrameworks` cover that). A missing workspace,
Pods project, or either lock half, a `Podfile.lock` that disagrees with
`Pods/Manifest.lock`, and missing `cap:sync` outputs (`App/public`,
`capacitor.config.json`, `config.xml`) are all refused before `xcodebuild` runs.

## Division of labor

- **Fable**（规划 / 审查）：按 `docs/agents/ticket-template.md` 写 GitHub issue 执行单；读 PR diff 对照 issue §5 逐条核，要求的测试没跑到或注入点不对就不放行，没有「不阻塞的备注」这一档；核 CI 与 Railway `/api/health`。不改产品代码，不合并。审查时不要跑本地 pytest / tsc / npm test / e2e、不要起本地服务器或搭复现 harness 来「证明修好了」——实现代理已经跑过；看 diff、CI（`gh run list`）、Railway SHA、以及还要不要 `cap:sync` / bundle bump。只有 diff 与执行单矛盾、CI 红、或用户报了真机问题时才往下查，并且从生产日志（Railway MCP `get-logs`）开始，不要先本地复现。
- **Grok / Composer**（实现，规则相同）：按指定 issue 从 `origin/main` 开隔离 worktree 实现；动手前先按 issue §2 核根因证据，对不上先在 issue 评论反馈，不硬改；跑该单 §5 列出的每条命令并把命令与结果贴进 PR（含修复前失败、修复后通过）；开 PR；不合并。不要用当前脏工作区。不要把两张产品单塞进同一个 PR。不碰 issue §3 的禁改项。
- **装包 / 交付**：唯一入口是 `npm run cap:ios -- …`，见 `docs/ios-deliver.md`；不要手工拼 `cap sync` / `xcodebuild`。动过 `plugins/nod-*/ios/**` 或 `ios/**/*.swift` 的交付，archive 前必须先跑 `npm run check:ios`（它编译真实 `App` scheme，`test-watch-replay.sh` 的文件清单覆盖不到 `NodWatchPlugin.swift` 一类文件）。
- 用户说「规划 / 写单 / 验收」→ 按 Fable 职责。用户说「执行 / 按清单做 / 开 PR」→ 按实现者（Grok / Composer）职责；执行单 §0 写明交给谁。实现者不写单、不审查自己的 PR；Fable 不写产品代码。
- Hermes 工作台不再承担 nod-web 实现，除非用户当场点名。`#33` / `#35` / `#36` 已结束。

### Self-improve

Record confirmed agent misses in `.cursor/skills/self-improve/errors.md`. Read that log before Watch / listen / Translate / phone-sync work. After a miss, append one entry. See `.cursor/skills/self-improve/SKILL.md`.

## Android

Phone debug APK: [docs/android.md](docs/android.md) (`npm run cap:android`). Isolation worktrees go in `.worktrees/<id>/`, not `/private/tmp`. Matches iPhone phone features (Google, Listen uplink, save/play); no Watch; does not bump the iOS bundle.
