# iOS 交付入口

唯一推荐入口：在**已审查提交**的隔离 worktree 里跑

```bash
npm run cap:ios -- <子命令> ...
```

不要在主工作区、Desktop 符号链接或未锁定 SHA 的目录里直接打包，也不要手工拼
`prepare-ios-web` / `cap sync` / `xcodebuild` —— 那条路径没有下面这些守卫。

## build — 出产物并写清单

```bash
git fetch origin
git worktree add -b deliver/<id> /tmp/wt-deliver-<id> <40-char-sha>
cd /tmp/wt-deliver-<id>
npm ci && npm ci --prefix web
TEAM_ID=XXXXXXXXXX npm run cap:ios -- build \
  --sha <40-char-sha> --version <short> --build <n> \
  --out /private/tmp/nod-deliver-<id> --ipa
```

- `--sha` 必须是完整的 40 位小写 commit SHA，且本 worktree 的 HEAD 就是它、`origin` 也有它。
- `--build` 必须是**本次**要携带的 bundle：HEAD 的 `CURRENT_PROJECT_VERSION` + 1，
  因为受保护的 `cap:sync` 会自增一次。写错会在 `cap:sync` **之前**就拒绝，checkout 不被改动。
- `--out` 必须是一个尚不存在的目录：交付不允许复用上一次的输出。
- 构建使用本次运行自己的 `DerivedData`（在 `--out` 下），archive 与 IPA 也在其下。

产出：`<out>/delivery-manifest.json`、`<out>/Nod.xcarchive`、`<out>/ipa/App.ipa`。

## verify — 用清单校验确切产物

```bash
npm run cap:ios -- verify --manifest <out>/delivery-manifest.json
```

不需要设备。产物摘要与清单不一致（例如同一路径被换成旧产物）即拒绝。

## install — 授权安装并读回

```bash
npm run cap:ios -- install --manifest <out>/delivery-manifest.json \
  --device <phone-udid> [--watch-device <watch-udid>] --authorize [--dry-run]
```

- 未显式授权（`--authorize` 或 `IOS_DELIVER_INSTALL=1`）**不会**调用任何安装命令。
- 先按清单校验产物，再安装，然后用 `devicectl` 读回手机（和手表）上的
  bundle id / 版本 / build，并写回清单的 `readback`。
- 读不到（设备锁屏、隧道断开）记 `unverified`；读到的版本与清单不符记 `mismatch`；
  **两种都不算成功**，进程非零退出。

## open — 只开发用

```bash
npm run cap:ios -- open [--sha <40-char-sha>]
```

打开 Xcode。这不是交付：没有清单、没有校验、不安装。

## 清单里有什么

目标/实际 SHA、checkout realpath 与 origin、允许的生成文件差异、工具版本、
两个锁文件摘要、插件与 Pods 路径、web 资产三段摘要（dist / cap:sync / app 内）、
archive 与 IPA 路径与摘要、App 的 bundle id/版本/build 与摘要、嵌入框架标识、
手机与手表目标、部署 SHA 与测试证据槽位、`readback`、`verified[]`、`unverified[]`。

不含任何 key、token 或签名私钥（`secretsIncluded: false`，origin 的 userinfo 打码）。
凡未检查的项一律进 `unverified[]`，不猜测。
