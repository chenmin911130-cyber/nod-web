# Capture-Engine-State 迁移 · 执行进度

单一事实来源（single source of truth）文档：所有"做到哪层了 / 下一步做什么"都在这里更新，**不要**只写在对话上下文里。设计依据见 `docs/adr/0001-capture-engine-two-axis-state.md`。

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
- [ ] **L5 删旧 state**：服务端 `_emit_run` 不发 `state`、删 `_active_run_state`；`bridge.ts` 去 `'state'`、reducer 删 `run`；Swift 删旧布尔读取；pushWatchStatus 去 `listening`/`paused`；ADR 0001 标 Done

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
