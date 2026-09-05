# Capture-Engine-State 迁移 · 执行进度

单一事实来源（single source of truth）文档：所有"做到哪层了 / 下一步做什么"都在这里更新，**不要**只写在对话上下文里。设计依据见 `docs/adr/0001-capture-engine-two-axis-state.md`。

## 当前状态（2026-09-05）· 窗口交接快照

新会话从这里核对起（别考古）：`git -C ~/Projects/nod-web status` + `git log --oneline -4` 应看到下面这套。

**已核实（本会话工具验证）**
- `main` = `origin/main`，HEAD `d22a6c1`（e2e: mark translate overlap gate as expected-fail until #11 item(1) lands）；工作区干净，仅 2 个**未跟踪** docs：`docs/Nodpilot 产品功能设计.pdf`、`docs/nodpilot-product-design.html`（遗留，勿动）。
- CI 最新 run `33949673588` **success**（backend/frontend/e2e 全绿），headSha = `d22a6c1`。⚠️ 其前两个 run `33931234994`、`33928639290` 是 **failure** —— 即 e2e 本地绿/CI 红的坑，d22a6c1 用「帧级 gate 标 expected-fail」翻绿，并非无中生有。
- **依赖信息（用户快照，未再单独核实）**：Railway deploy `5a267579` SUCCESS、`/api/health` 200；iPhone 端无需重装。

**接下来（队列，按序）**
1. **item 1 · 客户端 `phase(off, idle)` 修复** —— 排在真机测试 ① 之后。根因/时序/修法在 **GitHub issue #11**（OPEN）。落地时删掉帧级翻译重叠 gate 的 `test.fail` 行（d22a6c1 里标 expected-fail 的那行）。
2. 重连排查（零 PCM 时间戳对部署时间）—— **不在交接顺序里，暂不开**，留到以后。

**Meeting 审查（09-05，已建 #12–#22；#12/#22 已关）**
- **#12** `lang.py` 拉丁句尾丢空格 —— **已推已上线**（`fcc4b71`，服务端，Railway `9c0338a7`），issue 已关。
- **#15 / #16** `pdf.ts` 拉丁词不中断 + `/Title` UTF-16BE —— **已推**（`1f289cd`），web 随 build 20 已装设备核对。
- **#17 Summary 语言通道** 服务端 `e78e682` 已上线，客户端 `afaa5ab` 随 build 20。
- **#18 capTranscript** `7b7da17` 随 build 20；**#20 Bilingual 修复** `96a72ae`+`ac27cf9` 随 build 20；**#21 ellipsize** `287e68c` 随 build 20。
- **#19 Meeting 人数选择** `9be703c`（web）+ `ce38869`（iPhone chip）随 build 20。
- **#22 STT trace** `05646e2`+`8b74ad2` 已上线（服务端），issue 已关。
- **#14** 笔记语言耦合 —— **待你确认根因**（12:16 History 的 `OUTPUT LANGUAGE (hard rule): … Italian only`）+ 定产品规则后再改。
- **#13** 按说话人拆 turn —— 设计改动，等 #22 trace 数据再定，不与 ① 抢。

**build 20（09-05）已装设备**：iPhone + Watch 均 `com.nodpilot.app` 1.0 **20**，Bundle Version 已核对，新 web bundle `App-CgUDCLxq.js` 在机内。剩真机验收：3=Pause/Resume 真暂停、4=手表跟随 capture、5=手表 Stop→Save 保护、手机麦→手表不开麦（双麦）、翻译到英文说拉丁语应出翻译。

**教训入口（动手上文工作前必读）**
- `.cursor/skills/self-improve/errors.md` —— e2e 本地绿 CI 红、`phase(off,idle)` 兜底 vs `done` 重试、`think` 被当 Phone Stop、手表 UI 翻面、只装手表原生没 `cap:sync` 等
- `nod-web` skill —— 零 PCM 守卫、终态 stop 非 paused、静音放置坑
- 本文件下方 L1–L5 迁移记录（09-04 已完成）

## 当前状态（2026-09-04）

- [x] **L1 服务端**：实现完成，`tests/test_phase.py` 12 个用例全绿，全套 `221 passed / 1 skipped`，`server.app import OK`
  - `server/app.py`：`_paused`/`_engine`、`_capture()`/`_emit_phase()`/`_set_engine()`/`_emit_run()`、`pause_listen`/`resume_listen`、21 处 `state` 发射改 `_emit_run(...)`（唯一裸 `state` 发射点在 `_emit_run` 内且紧跟 `_emit_phase`）、`start()` 的 `ready` 后立刻 `_emit_phase()`、向后兼容 `getattr` 兜底
  - 附加：`engine` 轴已接进 `_finish_manual`/`ask`/`_start_interview_answer`（transcribing→generating→idle）
  - ✅ **commit 状态**：已提交 `acd655d`（capture-engine-state）
  - ⏳ **部署**：未推送 Railway（推生产必须用户确认，不做）

- [x] **L2 手机 JS**：`capture` 成为 Ready/Listening/Paused 唯一事实来源；删 `sessionPaused` ref 与 `sessionListening` 的 `wanted` 推导；`handlePause`/watch `onPause`/手表 `onResume` 改发 `pause_listen`/`resume_listen`（不再 `stop_listen`）；`buildWatchFace` 读 `capture`；pushWatchStatus 负载新增 `capture` 字段；bridge 把麦克风从 `phase`(capture) 驱动
  - ✅ tsc --noEmit、vite build、web 全套测试 全绿
  - 改动了 `web/src/`（App/bridge/iphoneCopy/watch/watchStatus/types + 2 个测试）与 `plugins/nod-watch/src/definitions.ts`
  - ⏳ **装真机**：未 `cap:sync` / 未装手机+手表（需用户确认、需设备，且按纪律装完用 Bundle Version 核对）
- [x] **L3 手表 Swift**：`WatchPhoneSession.apply()` 读 `capture`（listing=capture是listening/recording, paused=capture是paused）；删 `sawPhoneListening`/`phoneListenSync`/`applyPhoneStop`/`applyPhonePause`；删 JS 镜像 `watchPhoneListenSync`/`watchStartShouldClearPhoneListenLatch`
  - ✅ Web 侧：`WatchPhoneSession.swift` 在 `WatchApp` target (`xcodebuild` generic watchOS, CODE_SIGNING_ALLOWED=NO) 编译通过 BUILD SUCCEEDED
  - ✅ Web 侧：删函数后 `tsc --noEmit`、web 全套测试 全绿；删了 Finder 重复 `watchMic.test 2.ts`
  - ⏳ **装真机**：未 `cap:sync` / 未装手机+手表（需用户确认、需设备；装完用 Bundle Version 核对；note：capture="off" 时保留 offeringSave/savedAck，手表 Stop→Save 流程不被手机回推冲掉）
- [x] **L5 删旧 state**：服务端 `_emit_run` 不再发 `state`、删 `_active_run_state`；`bridge.ts` 去 `'state'`、reducer 去 `run`；Swift 删旧布尔读取；pushWatchStatus 负载去 `listening`/`paused` 只留 `capture`；ADR 0001 标 Done
  - ✅ **修复 L3 缺口**：手机→手表负载原本由 `NodWatchPlugin.setStatus`/`WatchBridge.pushStatus` 构建，**并未携带 `capture`**（L3 改的 `apply()` 读不到）。L5 已把 `capture` 穿透进 Native 侧（plugin setStatus + WatchBridge payload + reply），并删掉 `listening`/`paused`
  - ✅ 服务端 pytest `220 passed / 1 skipped`；`tsc --noEmit`、`vite build`、web 全套测试 全绿；`xcodebuild` App 与 WatchApp 均 BUILD SUCCEEDED
  - ✅ **全部 4 层（L1/L2/L3/L5）代码完成**；⭐ **唯一剩余 = 真机部署验证**（未 cap:sync / 未装手机+手表；需用户确认，装完用 Bundle Version 核对）
- [x] 全链路：服务端 / 手机 JS / 手表 Swift 均已切到 `capture`（单一事实来源），旧 `state` 事件已彻底移除

## 关联文件（L2 从这些开始读）

- `web/src/App.tsx` — `sessionPaused` 909 行、onPause 1118-1125、onResume 1126-1133、onStop 1134-1143
- `web/src/iphoneCopy.ts`（197 行）
- `web/src/bridge.ts` — `EVENT_TYPES` 白名单 9-25 行、`state` 在 13 行
- `web/src/types.ts`（196 行）
- `web/src/recordReport.ts`（19 行）
- 相关测试 `qaCard.test.ts` 等在 `web/src/`

## 接续纪律（每个会话开头做，别考古）

1. `git -C ~/Projects/nod-web status` + `git diff --stat` —— 核实上一步改动是否还在
2. 读本文件 —— 确认做到哪层
3. 只做当前那层；做完 `git commit` + 更新本文件勾选，再结束会话
4. 项目统一用 `~/Projects/nod-web`（`~/Desktop/nod-web` 是软链，避免双拷贝漂移）
5. 部署节奏：L1 → Railway → 观察 1 天 → L2 → cap:sync 装手机（bump 10）→ 观察 → L3 → cap:sync 装手机+手表（bump 11）→ 验证清单。**推生产必须用户确认，不自动做**
