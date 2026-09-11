# iOS 交付入口

唯一推荐入口：在**已审查提交**的隔离 worktree 里运行 `npm run cap:ios`。不要在主工作区、Desktop 快捷链接、或未锁定 SHA 的目录里直接打包，也不要手工拼 `prepare-ios-web` / `cap sync` / `xcodebuild`。

## 构建

```bash
git fetch origin
git worktree add -b deliver/<id> /tmp/wt-deliver-<id> <40-char-sha>
cd /tmp/wt-deliver-<id>
npm ci
(cd web && npm ci)
TEAM_ID=XXXXXXXXXX npm run cap:ios -- \
  --sha <40-char-sha> \
  --bundle <n> \
  --out /tmp/nod-deliver-<id> \
  --archive
```

`--ipa` 同样需要 `--sha`、`--bundle`、`--out`。`--open` 仍要锁定 SHA 和 bundle，它只打开 Xcode，不等于安装。

产物只写到 `--out`。不要从 `ios/dist` 按修改时间或通配符挑选 `.app` / `.ipa`。

## 安装

构建成功会写下 `/tmp/nod-deliver-<id>/manifest.json`。没有 `--install-ok` 就停在这份清单。

```bash
npm run cap:ios -- \
  --install /tmp/nod-deliver-<id>/manifest.json \
  --install-ok \
  --iphone-udid <udid> \
  --watch-udid <udid>
```

安装前会核清单与产物摘要。缺清单、摘要不对、或版本对不上会拒绝。手机和手表必须分别安装、分别用 `devicectl device info apps` 读回版本；只装手机不算手表已更新。

## 规则

1. `--sha` 必须是完整 40 位。HEAD 不一致或有未批准的源码改动则停止。
2. 根目录和 `web` 各自 `npm ci`。`node_modules`、插件、Pods 不得指向其他 checkout。目录存在不是依赖正确的证据。
3. 只运行当前提交里受保护的 `npm run cap:sync`（`assert-roots → build → prepare → cap sync → patch → pin`）。失败即停，不要跳过检查。
4. 使用本次 `--out` 下的 DerivedData / archive。`NOD_IOS_BUNDLE` 写成明确的本次 bundle。
5. 后端有改动时把 Railway 实际部署 SHA 记进 `--railway-sha`。健康检查通过不等于功能已上线。
6. 不要删除用户录音、数据库、签名资产、旧构建或 worktree 来解决路径混用。

## 测试

```bash
node scripts/iosWorktreePods.test.mjs
node scripts/iosDeliver.test.mjs
```
