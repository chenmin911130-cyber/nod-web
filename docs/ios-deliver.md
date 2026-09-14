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
- `--build` 必须是**显式指定**的本次交付 bundle（非负整数，缺或非整数直接拒绝）。交付入口把
  它通过 `NOD_IOS_BUNDLE` 固定进受保护的 `cap:sync`：`prepare-ios-web.mjs` 在有该环境变量时
  原样写入该值，**不再自增**（未设置时保持原来的自增行为，手工 `cap:sync` 与其他流程不变）。
  同步后仍断言 `CURRENT_PROJECT_VERSION == --build`；没固定住就拒绝 archive，绝不会把非预期
  bundle 打进去。清单里 `app.buildSource` 为 `"pinned"`（本次由 `NOD_IOS_BUNDLE` 固定）或
  `"artifact"`（`--app` 复用已有产物，bundle 读自该 App，未经本次固定）。
- `--out` 必须是一个尚不存在的目录：交付不允许复用上一次的输出。
- 构建使用本次运行自己的 `DerivedData`（在 `--out` 下），archive 与 IPA 也在其下。

产出：`<out>/delivery-manifest.json`、`<out>/Nod.xcarchive`、`<out>/ipa/App.ipa`。

## 编译闸门 — archive 之前先编译真实 target

```bash
npm run check:ios                                        # 约 3 秒（暖）/ 约 25 秒（冷）/ 约 65 秒（模块缓存全空）
npm run check:ios -- --device --configuration Release     # 设备 / Release 变体
```

它编译**真实 `App` scheme**：App + WatchApp + 本地 pods（NodAuth / NodMic / NodSplash /
NodWatch），iOS 与 watchOS 模拟器一次编完。不需要签名证书或 Team，也不在 checkout 里写
任何文件——DerivedData 缓存在系统临时目录、按 worktree realpath 隔离，既避免 #213 的跨
worktree 陈旧对象，也不会污染交付的 clean-tree 守卫。

为什么不是「检查所有 Swift 文件」的脚本：`scripts/test-watch-replay.sh` 与 watchOS
`swiftc -typecheck` 各自维护一份**手写文件清单**，两份都没有列到
`plugins/nod-watch/ios/Sources/NodWatchPlugin/NodWatchPlugin.swift`；该文件里重复的
`copyId:` 实参能同时通过这两个闸门，直到第一次真实 `xcodebuild`（也就是装机时刻，而且已经
在合并后的 `main` 上）才报错。单独对那个文件跑 `swiftc -typecheck` 也不行：它没有 pod
模块路径，只会报 `no such module 'Capacitor'`。

真实 scheme 覆盖的是**真实构建依赖图**：在 target 里的文件都会编，新加进 Podfile 的插件也会
编。它看不见「新文件从没被加进任何 target membership」——那种文件编译为零，闸门仍然绿；把新
文件加进 target 仍然是作者的责任。

前置条件只证明**存在与一致性**，不证明「最新一次 `cap:sync` 跑过」：它不比对
`ios/App/App/public` 与当前 `web/dist`，也不比对 Podfile 与当前插件集合，所以 web 或插件改完
跳过 `cap:sync` 不会在这里被拦住（这两件事由交付路径的 `assertWebAssets` /
`localPodFrameworks` 负责）。workspace / Pods 工程 / `Podfile.lock` / `Pods/Manifest.lock`
任一半缺失，或后两者内容不一致，以及 `App/public`、`capacitor.config.json`、`config.xml`
（`cap:sync` 写入、仓库不跟踪）缺失，都会在调 `xcodebuild` 之前拒绝。

`test-watch-replay.sh` 仍然负责行为测试；这个闸门只回答「真实 target 还能不能编译」。
退出码：0 编译通过，1 编译失败，2 用法或前置条件不满足（前置条件会直接说清是缺
`cap:sync` 还是缺 `pod install`）。

## verify — 用清单校验确切产物

```bash
npm run cap:ios -- verify --manifest <out>/delivery-manifest.json
```

不需要设备。产物摘要与清单不一致（例如同一路径被换成旧产物）即拒绝。

## install — 授权安装并读回

```bash
npm run cap:ios -- install --manifest <out>/delivery-manifest.json \
  --device <phone-udid> --watch-device <watch-udid> --authorize [--dry-run]
```

- 未显式授权（`--authorize` 或 `IOS_DELIVER_INSTALL=1`）**不会**调用任何安装命令。
- 先按清单校验产物，然后**分两步安装**：手机 App 装到 `--device`；嵌入的手表 App
  （清单里的 `deviceTargets.watch.appPath`，即 archive 内 `<App.app>/Watch/…`）装到
  `--watch-device`。**装手机不会更新手表**（已在真机证实），所以手表必须单独装。
- 两步各自记录在 `readback.phone.install` / `readback.watch.install`（`installed` /
  `failed` / `skipped` + `device` / `appPath` / `detail`）。手表安装失败不回滚手机安装，
  但一定写进 `unverified[]`，整体也一定非成功。
- 再读回两边：手机与手表的 bundle id / 版本 / build 都应与清单一致，才记
  `readback.status: "verified"` 并退出 0。读不到（锁屏、隧道断开）记 `unverified`，
  读到的版本不符记 `mismatch`；**两者都不算成功**，退出码 3。
- 不传 `--watch-device` 时**不会**拿手机当成手表来读：`readback.watch.status` 记
  `unverified`，原因写明 `no --watch-device given; the watch half of the delivery was not
  installed or verified`。只想交付手机时必须用 `--no-watch` 显式声明（此时手表记
  `skipped`，`readback.scope: "phone-only"`，手机验证通过即退出 0）。`--no-watch` 与
  `--watch-device` 不能同时使用。

## open — 只开发用

```bash
npm run cap:ios -- open [--sha <40-char-sha>]
```

打开 Xcode。这不是交付：没有清单、没有校验、不安装。

## 清单里有什么

目标/实际 SHA、checkout realpath 与 origin、允许的生成文件差异、工具版本、
两个锁文件摘要、插件与 Pods 路径、web 资产三段摘要（dist / cap:sync / app 内）、
archive 与 IPA 路径与摘要、App 的 bundle id/版本/build 与摘要（含 `buildSource`：
`pinned` 表示本次用 `NOD_IOS_BUNDLE` 固定，`artifact` 表示复用已有产物）、嵌入框架标识、
手机与手表目标、部署 SHA 与测试证据槽位、`readback`（`scope`、`device` / `watchDevice`、
`phone.install` / `watch.install` 的状态、两边的 `status` 与 `observed`）、`verified[]`、
`unverified[]`。

不含任何 key、token 或签名私钥（`secretsIncluded: false`，origin 的 userinfo 打码）。
凡未检查的项一律进 `unverified[]`，不猜测。
