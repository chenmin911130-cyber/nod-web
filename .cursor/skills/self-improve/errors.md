# Agent error log

Newest first. Read before Watch / listen / Translate / phone-sync work.

## 2026-09-25 · #316 暂停中的无 stream ping 被当成上行流

- 我以为：`--check-uplink` 里 ticks < 2 一律 insufficient，并且 inflight 能挡住同一时刻的 pause/stop。
- 实际：手机暂停或停听时 socket 仍开着，`uplink_ping stream=` 没有 listener，会落进空 stream 桶。pause/stop 必须在周期 tick 正在写日志时照样打出。insufficient 的退出码是 2，有 FAIL 时优先 1。
- 规则：少于 2 个 tick 的 insufficient 只打在至少有一条 `listen_summary` 的流上；跳过无 listener 的空 stream 桶。周期 tick 才去重，pause/stop 不去重。
- 涉及：#316 · `server/latency_report.py` · `Session._maybe_listen_summary`

## 2026-09-23 · #303 正文写了的修法没进 main

- 我以为：PR 正文「补：reap 第四分支」+ 用例名 + 28 passed 输出，等于那段改动在合并进来的树里。
- 实际：那条提交 `712d324` 是在 #303 合并 4 分钟后才推到分支的，`main` 上 `uplink.py` 第四分支仍是 60s、测试只有 15 条。批次集成时对 `git diff <合并前> <合并后>` 才发现。
- 规则：审已合并 PR 看 `git diff <base-merge> <merge-commit>` 的树，不看 PR 正文；再 `git log origin/<branch> ^origin/main` 一眼有没有合并后的孤儿提交。正文里提到的用例名，`rg` 一下 merged 树里有没有。
- 涉及：#303 · #308 · `server/uplink.py`

## 2026-09-22 · #289–#297 静态审查写成 PASS

- 我以为：diff 对得上执行单、新测试断言落点正确、PR 描述说测试跑过，就可以写 PASS；`test:golden` 不存在标成 blocked「不阻塞」。
- 实际：四张单都没有「修复前失败」的证据，模块测试结果只有实现方自述；GitHub Actions 自 2026-09-10 起在 repo 级关闭（付费），之后 70 个合并零 CI，`AGENTS.md` 里「核 CI」这步既没做、做了也是空。#289 + #290 都动了 `project.pbxproj`，合并后没人跑过 `check:ios`。真实结论只是「静态审查通过」。
- 规则：没看到修复前失败 / 修复后通过的原样输出，结论最高写「静态审查通过」，不写 PASS；单里要求的命令仓库里不存在，是写单的错，回头改单，不许放行。一批并行单合完，在 merged main 干净 worktree 跑固定集成命令再关单。
- 涉及：`docs/agents/ticket-template.md` 验收结论定义 · `AGENTS.md` 分工 · #289 #290 #296 #297

## 2026-09-14 · #232 锁屏 Watch Save 等打开手机

- 我以为：原生 `URLSession.shared` POST keep 已经不依赖 WKWebView，锁屏后台也能完成，Watch 会收到 `saved`。
- 实际：End 停录后 `audio` 后台结束，手机被挂起。`startNativeKeep` 没有 `beginBackgroundTask`，HTTP 要等 `didBecomeActive` → `resumeKeeps` 才跑完。用户必须打开手机，Watch 才能结束保存等待。`local` 不是成功。
- 规则：锁屏时 Watch Save 必须在收到 drain/save 时立刻 `beginBackgroundTask`，原生 keep HTTP 在该窗口内完成；云端 200 才通知 Watch `saved`。禁止用假音频保活，也不得把 JS 前台恢复当成锁屏修复。
- 涉及：#232 · `WatchBridge.startNativeKeep` / `holdKeepBackground` / `resumeKeeps`

## 2026-09-14 · #232 首次 End 只看手表 freeze lastByte

- 我以为：`finish()` 时 Watch `lastByte > 0` 才出 Save / No Save；`lastByte == 0` 就是空场，可以直接 Ready。bundle 103 能 Save 就表示 End 选择界面没问题。
- 实际：手表 freeze 时 `lastByte` 可以为 0，手机已经 hold 了本场 PCM（`heldByte` 几十万）。`maybeCompleteDrain` 见 `lastByte == 0` 立刻 Ready；迟到的 persist ack 到达时用户已在主界面。这不是用户点了 No Save。
- 规则：Meeting End 是否出 Save 不能只看手表 freeze 那一瞬间的 `lastByte`；本场 `persistAckByte > 0` 也要出。迟到 persist 在未选择时补出 Save / No Save。`declineSave` 必须 `saveDismissed = true`，挡住迟到 ack 把 No Save 再打开。
- 涉及：#232 · `WatchPhoneSession.finish` / `completeDrain` / `persistAckByte` / `offerSaveFromPersist`

## 2026-09-11 · 装完 iPhone 就当手表也更新了（表还停在 82）

- 我以为：`devicectl device install app` 把手机装到 84 后，内嵌的 `App.app/Watch/Nod.app` 会和 Xcode Run 一样由 iOS 推到已配对手表。
- 实际：手机 84 装好并启动，表上仍是 **82**（旧包）。`devicectl device info apps --device <watch-udid>` 能看到表在线、版本 82，但手机安装没有推表。必须单独装：`xcrun devicectl device install app --device <watch-udid> .../App.app/Watch/Nod.app`，装完再查一次版本（84 ✓）并确认能启动。另外表 app 是独立原生 SwiftUI（`otool -L` 只链系统框架，不链 nod-watch/nod-mic pod），`WatchBridge` / `WatchPcmIngest` 这类符号属于**手机**包，不能拿它们当表的验收条件。
- 规则：一次「手机 + 手表」的安装，两侧都要用 `devicectl device info apps` 核 Bundle Version，手机成功 ≠ 表已更新；表 app 单独装、单独核、单独启动验证。
- 涉及：#196 / #191 · Bundle 84 · `App.app/Watch/Nod.app` · `xcrun devicectl device install|info apps`

## 2026-09-11 · #193/#194 只按模式隐藏 Save 入口，没修保存状态归属
- 我以为：按模式不渲染 More 里的 Save 行、Translate 工作区不渲染 SavePrompt，就算把「Translate 不该有 Save」闭环了。
- 实际：待保存状态本身没有模式。`server/meter.py:list_pending_history` 只筛 kept/ended/discarded，`restoreLaunchSurface`/`savePromptSurface`/`sessionShouldOfferSave` 只看**当前工作区**，`HistoryPane` 给本地录音行硬编码 `mode:'meeting'`。于是 Translate 会话成了 pending：切回 Meeting 的那一刻工作区条件成立，恢复 + Save 又回来了；本地 Translate 录音还被当成待保存 Meeting（bundle 82 真机复测）。
- 规则：按模式隐藏入口只解决「看得见」。要同时把保存状态按**会话自己的模式**收口 —— 挂起查询（含 limit 之前的模式过滤）、恢复判定、保存簿、行标签、本地录音行元数据都读会话模式；未知/空模式保持可恢复（不猜成 meeting，也不隐藏）。原生 manifest 缺字段时用可信的云端会话元数据（sessionId）解析，仍解析不出就保持未知。
- 涉及：#193 #194 #196 · `list_pending_history` · `restoreLaunchSurface` · `SaveBook.sessionMode` · `HistoryPane` 本地录音行 · `PhonePcmStore` manifest
## 2026-09-11 · #191 复审：拒绝提交不撤销「已判定」，回答线程只在建线程前校验

- 我以为：`judged_at` 已接进 worker、generation 已在 `_start_interview_answer` 和 `_run_interview_answer` 各校验一次，剩下的窗口就算关掉了。
- 实际：worker 先写 `_qa_judged_version = version` 再调 `_qa_commit`。partial 落在 worker 自检与 commit 复检之间时提交被拒，但「已判定」标记留着 → `_qa_maybe_reschedule` 和之后的 settle 全部跳过，没有新 final 就永远不回答（安静后不恢复，用户看到问题挂着）。另一处：`_run_interview_answer` 的校验在建线程**之前**，线程体 `work()` 仍直接 `process_text`；`_pending_q` 项不带身份，`_qa_reset` 只能清队列、拦不住已 `popleft()` 的旧问题 —— 这一条与同日上一条的「同类第三处」逐字重复，说明上轮只把它写进 errors.md、没写进代码。
- 规则：写「拒绝/早退」分支时，必须在同一处撤销上一步留下的状态标记（这里 `_qa_judged_version` → `_qa_stale_version`），并补一条**安静后仍会恢复回答**的测试（只测「不抢答、缓冲保留」不算）。校验必须放进真正使用该值的线程体，而不是它的调用方。清空集合 ≠ 阻止已取出的元素：元素要自带可校验身份；两种身份不要混用（`_qa_gen` 是候选纪元、手动提交会推进，`_qa_session_gen` 只在 New/清空/切模式/关闭时推进）。
- 涉及：#191 · `server/app.py` `_qa_commit` / `_qa_keep_verdict_eligible` / `_qa_session_current` / `_run_interview_answer` · `tests/test_live_qa_buffer.py::ReviewFixTests`

## 2026-09-11 · #191 Hermes：守卫参数加了却没人传，早退漏掉 busy 释放

- 我以为：`_qa_commit` 新增 `judged_at` 就关掉了「判断期间来了 partial」的窗口；commit message 甚至写着「早退仍会通过既有 `finally` 释放 busy」。
- 实际：worker（`_qa_judge_worker`）调用 `_qa_commit` 时根本没传 `judged_at` —— 线上守卫是死代码，只有测试手工传参，所以全绿。而 `_run_interview_answer` 的 generation 早退发生在 `finally` **之前**，busy token 是 `_start_interview_answer` 先取的，早退后永不释放 → 会话一直 busy，后续问答全部排队。同类第三处：排队问题被 `_pending_q.popleft()` 取出时没有 generation 可校，而 `_qa_reset` 不清队列（New / 新 listen / close 都不清），被放弃会话的问题仍会开答。
- 规则：加「守卫参数」必须同时改**唯一的生产调用点**，并写一条从真实调用链注入竞态的测试（本次：把 partial 塞进 `_qa_commit` 调用内部 —— 唯一一个 worker 自检已跑完的窗口）。测试通过 ≠ 路径被覆盖：先问这条测试是走到生产代码，还是自己在构造前置条件。任何 `return` 前先问「这个 claim/token 是谁在哪取的、谁负责放」；带 claim 的早退必须走和正常结束同一条释放/交接路径。
- 涉及：#191 · `server/app.py` `_qa_judge_worker` / `_qa_commit(judged_at=)` / `_finish_interview_answer` · `tests/test_live_qa_buffer.py::ReviewFixTests`

## 2026-09-11 · Bundle 81：绕过受保护打包入口，把主仓旧插件编进 App（重演 Bundle 71）
- 我以为：在 `/tmp` 隔离 worktree 里手工拼 `prepare-ios-web → cap sync ios → patch-ios-plist → xcodebuild`，并让 `node_modules` / `web/node_modules` 软链到主仓共用依赖就够了；`cap sync` 自己会 `pod install`。
- 实际：`/tmp/ios-build` 的 `node_modules` 指向主仓 → Podfile.lock 与 Pods 工程按 realpath 解析到 `/Users/minchen/Projects/nod-web/plugins`（停在旧 commit），新的网页配旧的 `NodMic.framework`：`strings` 里 `startUplink` / `AudioUplink` / `PhonePcmStore` / `WatchPcmIngest` 全为 0，真机 Listen 报 “Background recording is unavailable. Reopen the app and try again.”。同一轮还把 `prepare-ios-web` 跑在 `npm run build --prefix web` **之前**，`web/dist/index.html` 的原生跳转桩被 vite 覆盖 —— 两处都不报错。
- 规则：iOS 打包只走仓库受保护入口 `npm run cap:sync`（`assert-roots → build → prepare → cap sync → patch → pin`）：它在编之前断言 `node_modules` 与 `nod-mic` / `nod-watch` / `nod-auth` 的 realpath 属于当前 worktree，并在 `pod install` 后断言 Pods 工程只编当前 checkout。隔离 worktree 必须自己 `npm ci`（根 + web），禁止把 `node_modules` / `web/node_modules` 链到别的 checkout，也不要手工拼 prepare/cap sync/patch。
- 装完只核 Bundle 数字不够：必须核最终 `App.app` 的框架符号与编译清单（`NodMic.SwiftFileList` 的源码路径、`startUplink`/`AudioUplink` 等），并核 `capacitor.config.json` 的 `packageClassList`。
- 涉及：#195 · Bundle 71 / 81 · `scripts/iosWorktreePods.mjs` · `scripts/package-ios.sh` · `/tmp/ios-build` → `/tmp/ios-82`

## 2026-09-11 · #190 Hermes：结束面板标签被 pointer capture 吃掉点击
- 我以为：把手和标签栏 pointerdown 一律 `setPointerCapture`，再靠 `skipEndedClick` 区分拖动和 click，就能同时支持拖动手势和键盘/点击。
- 实际：capture 会把后续 `click` 重定向到捕获元素，Live/Transcript/Notes 收不到 click，结束态切不了 tab；拖完留下的 `skipEndedClick` 还会吞下一次标签点击。9px 抖动会落在 tap/drag 缝里把面板展开。
- 规则：结束面板只在点在非按钮区域、或拖过共享 slop 之后才 capture；禁止在标签按钮 pointerdown 上抢捕获。
- 涉及：`ListenPane` `onEndedResizeDown` · `skipEndedClick` · `ENDED_TAP_SLOP` · ended sheet tabs

## 2026-09-11 · #190 审查：Continue 用 meetingStartedAt 当 Ask sessionKey
- 我以为：`meetingStartedAt` 能代表本场，草稿按它隔离即可。
- 实际：Continue / `meeting_resume` 会把 `meetingStartedAt` 改成 `now - elapsedMs` 让时钟接着走，ListenPane 当成新会话，草稿被清、Ask 被收起。
- 规则：Ask/Translate 草稿键必须用续录不变的会话标识（`composeSessionId`），禁止用会被 Continue 改写的时钟字段。
- 涉及：`sessionKey` · `applyMeetingResume` · `composeSessionId` · `ListenPane` Ask draft

## 2026-09-11 · #187 审查：Watch End 没 arm flush，回执没绑本次 End

## 2026-09-11 · #187 审查：Watch End 没 arm flush，回执没绑本次 End
- 我以为：手机 Stop 上 `expect_listen_flush`、每次等待清空 `listenFlushId`，下一条 `listen_flush` 就能放行笔记。
- 实际：Watch Stop / Record-while-listening 只 `stopListen()`，从未 pending，自动笔记会永远 wait。清空旧 id 后，上一轮迟到回执会完成当前 End。
- 规则：每次 Meeting End（含 Watch）必须带本场 nonce；`listen_flush` 必须回显并匹配该 nonce，禁止靠「下一条 flush」或清空旧 id 消歧义。
- 涉及：`endMeetingListeningRef` · `ListenFlushWait.waitId` · `stop_listen.flush_id`

## 2026-09-11 · 把仍 OPEN 的 #33 写成尚未实现
- 我以为：#33 仍 OPEN，本地 `meeting_lines.decide` 仍是 12s／480 字／80 词，所以第三轮断句还没做，列为「按 #33 原文全量实现」。
- 实际：PR #34 已于 2026-09-06 合并（`ba38eb9`）。OPEN 是验收未关 + 本次 PDF 补漏（日期／序数续接、提前 `closed`）。`_open_line` 已写入 History，不能在 close 时再保存整行。
- 规则：判断某单是否已落地，看 `origin/main` 代码和 issue 的合并评论，不看 OPEN，不看脏工作区。补漏单只写增量，不把已合并正文当未实现。
- 涉及：#33 · PR #34 · `server/meeting_lines.py` · `_open_line` / `save_history`

## 2026-09-10 · #185 审查：跨场 keep、旧 saved 吞新失败、status 触发无界重试
- 我以为：按 session 查文件、inbound 上记 native saved、每次 storeAccount 扫 keep 再 POST，手表 local/savedAck 就能收口。
- 实际：延迟 Save 会把当前 B 标 keep 却 keep(A)；failKeep 用另一场 inbound.saved 吞掉 B 的失败；每次 pushWatchStatus 都 restorePendingKeeps；saved 只在内存，重启当 pending；手表 savedAck 两秒后迟到 failed/local 会重开页面；缺 token 先 failed 再 publish local。
- 规则：Save 只写已验证的 session/capture 对，失败只查该场；keep 任务必须持久、串行、有界，不得绑 UI status；对象终态与两秒提示/Done 离页分开，鉴权失败不得再发 local。
- 涉及：`WatchPcmIngest.resolveCaptureLocked` · `failKeep` · `restorePendingKeeps` · `WatchPhoneSession.applySaveStatus`

## 2026-09-10 · 手表 Save 等手机网页 keep_history，App 没打开就卡在正在保存
- 我以为：End 已由手机原生落盘，Save 再走现有 JS `keep_history` 即可；锁屏/杀进程时 WCSession 会把命令交给网页。
- 实际：`WatchBridge` 在 `jsReady==false` 时把 `save` 排进 pending。Capacitor WKWebView 没起来就没有控制 WS，手表 `reply.save` 仍是旧状态，界面停在「正在保存…」。
- 规则：Watch Save 必须由 iPhone 原生处理（落 keep 意图 + HTTP keep）；不得等 WKWebView。未完成 History 只能回 `save=local`，禁止报 Saved to History。
- 涉及：`WatchBridge.handle save` · `WatchPhoneSession.applySaveStatus` · `/api/account/history/{id}/keep`

## 2026-09-09 · #165 复查：移交倒序、Retry 从零重发、join 超时仍取走缓冲
- 我以为：队列先出、缓冲后拼；Retry 清零 `nextByte` 才能避开 duplicate；`join(2.0)` 后取走缓冲即可。
- 实际：`_pcm_buf` 是已出队的较早音频，`_q` 是后续；先队列会倒序。手机从 0 重灌，服务端裸 PCM 无偏移，已送 STT 的前段会重复转写和计量。`ws.send()` 仍阻塞时未发帧在 sender 局部变量里，超时取走会漏。
- 规则：移交先缓冲再队列；Retry 只按 STT 已消费偏移恢复或重取确认，禁止从零重发；sender 未退出不得移交，超时应失败。
- 涉及：`CloudListener.take_unsent` · `WatchPcmIngest.beginDrain` · `watchIngestRewindForRetry`

## 2026-09-09 · #165 复查：STT 重连丢未发送缓冲后空 drain 假成功
- 我以为：回填 `_pcm_buf` 后同一 listener 再 drain 即可；测试替换 socket 覆盖了失败路径。
- 实际：生产 `_restart_listener` 丢开旧对象、不移交未发送音频；`_pcm_rx_bytes` 仍满，新空队列 `drain()` 成功并发 `pcm_drained`。手机 `nextByte` 不回退，Retry 文件被判 duplicate。
- 规则：重建 listener 必须移交未发送 PCM；确认要求 STT 已发出字节达到 End 偏移；Retry 回退手机 ingest 游标。
- 涉及：`_restart_listener` · `CloudListener.take_unsent` · `_finish_pcm_end_if_ready` · `WatchPcmIngest.beginDrain`

## 2026-09-09 · #165 复查：socket 确认删片、失败排空清空缓冲后 Retry 假成功
- 我以为：`pcmAckByte` 删已封片、`take_final_frames` 清空 `_pcm_buf` 后标失败即可，Retry 会再走一遍 drain。
- 实际：socket 成功不等于 STT 排空；删片后排空失败就没有可补原片。失败路径已把尾块从 `_pcm_buf` 拿走，下次 `drain()` 见空缓冲会直接成功。
- 规则：Watch 原片只在匹配的 `pcm_drained` 之后删除；STT 发送失败必须把未发出的帧放回缓冲，Retry 不能把空队列当成功。
- 涉及：`WatchPcmStore.ack` · `WatchPhoneSession.apply pcmAck` · `CloudListener._send_drain_tail`

## 2026-09-09 · #165 复审：假成功排空、park 丢确认、Resume 游标归零、删未封片、旧 drained 贴新 capture
- 我以为：`drain()` 之后一律 `pcm_drained`、控制 WS emit、`_pcm_rx_bytes` 跟 STT 子流走、ack 追上当前片长度即可删、sessionId 足够区分排空。
- 实际：`drain()==False` / listener 空 / STT socket 未连仍发成功；park 把 emit 换成空 sink 且 reattach 不重放；Pause/Resume 清累计字节，End 永远等不到；`deleteAckedShards` 不排除打开的 FileHandle；`markPcmDrained` 只核 session 再盖上当前 capture，旧确认能放行新录音。
- 规则：只在 STT 真正排空成功时确认并落可重放结果；累计偏移跟 capture 走、不跟子流重开走；只删已封片；drain 事件必须自带 capture+session+offset，禁止用当前场补标签。
- 涉及：`Session._finish_pcm_end_if_ready` · `CloudListener._send_stt_frame` · `reattach` · `_open_listener` · `WatchPcmStore.deleteAckedShards` · `WatchBridge.markPcmDrained`

## 2026-09-09 · #165 审查：双向同步、忙循环、无身份 ack、只等 socket、短尾不发、5 秒内存窗
- 我以为：ingest `queue.sync` + uplink `tryEnqueue`/`markSent` 同步、`pcmAckByte` 纯数字、socket send completion、160 kB 再落盘，就能完成有序补传和 End 排空。
- 实际：ingest 与 uplink 互相 `sync` 会死锁；队列满时 `pumpLocked` 立刻重读同一文件；ack 无 capture/session，旧确认能删新片；socket 成功后 `stop` 会截断服务端 `_q`；stash <50ms 永不 flush；当前片在内存最多约 5 秒。
- 规则：消费回调只异步回状态队列；容量不足必须退出 pump；ack 绑定 capture+session 且换场清零；End 等服务端 `pcm_drained` 再 stop；冻结时 flush 短尾；采集开始即追加写盘。
- 涉及：`WatchPcmIngest` · `AudioUplink.tryEnqueue` · `WatchPhoneSession.apply pcmAck` · `CloudListener.drain` · `WatchPcmStore.append`

## 2026-09-09 · Bundle 71 把 node_modules 链到脏主仓，编进旧原生插件
- 我以为：隔离 worktree 里 `node_modules` 链到主仓能共用依赖；committed `Podfile` 的 `../../plugins` 会编当前树。
- 实际：`nod-mic` 相对链接解析到 `/Users/minchen/Projects/nod-web/plugins`。`cap sync` 按 realpath 写进 Pods。71 归档的 `NodMic.framework` 没有 `startUplink` / `AudioUplink`，`NodWatch` 也缺新会话字段。网页是新的，框架是旧的。
- 规则：打包前 `node_modules` 与 `nod-mic` / `nod-watch` 的 realpath 必须在当前 worktree；禁止链到其他 checkout。Pods 工程不得引用主仓 `plugins`。装完核框架符号，不只核 Bundle 数字。
- 涉及：`node_modules` symlink · `ios/App/Podfile` · `Pods.xcodeproj` · Bundle 71

## 2026-09-09 · #164 Save 消息不带 sessionId，手机保存当前会话
- 我以为：手表本地 pin `saveRequestId`，手机 `keep_history` 当前 `liveId`，迟到 `sessionId` 闩进 requestId 就能 Saved。
- 实际：`send(action: "save")` 和 Bridge `command` 都不带 sessionId；JS `onSave()` 无参；Retry 每次 `confirmSave` 重读 `phoneSessionId`。请求延迟期间手机换场，会 keep 错场。
- 规则：首次 Save 钉死目标 ID 并写入 WCSession / Bridge / JS command；手机只 keep 该 ID，缺 ID 不得保存当前会话；Retry 沿用钉死的 ID，禁止重读当前会话。
- 涉及：`WatchPhoneSession.send` · `WatchBridge.emit` · `watch.ts onSave` · `saveLiveSession`

## 2026-09-09 · #171 补传审查只看入口帧率，漏了下游实时音频约束
- 我以为：把补传限制在 `WS_FRAMES_PER_SEC=40` 以内，就补齐了发送节奏约束；没有继续核对 AssemblyAI 的音频时长与墙钟约束。
- 实际：Bundle 67 用户报麦已开但不转写、自动停止。生产 2026-09-09 00:57:55Z `/ws/audio` accepted，随后反复收到 AssemblyAI 3007。官方文档列出两类原因：单块不在 50–1000ms 内，或音频发送快于实时。代码 `frameBytes=3200` 为 100ms，积压时按 40fps 补发允许约 4 倍实时；`scheduleFlush` 也可发不足 50ms 的尾块。当前日志未落完整 Error，尚不能判定此次具体触发哪一种。服务端 `_on_stt_drop` 超过 6 次会停听。
- 规则：音频补传必须同时检查入口限流与最终 STT 接收约束；按音频时长制定节奏，不用“每秒几帧”替代。3007 必须保存脱敏错误详情、块字节数/时长和发送间隔再归因，不把错误码直接等同于某个子原因。
- 涉及：#171 `AudioUplink.pump / scheduleFlush` · `CloudListener._sender` · https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures

## 2026-09-09 · #171 把 nod-mic 编进空 start/startUplink
- 我以为：`src/shims/nod-mic.ts` 只给浏览器；真机 Capacitor 仍走 `registerPlugin('NodMic')`。
- 实际：Vite/tsconfig 无条件 alias，WKWebView 也加载空实现。`start()` 假成功不开原生麦，`startUplink()` 假成功不连 `/ws/audio`，JS 拿到 token 后又停转 PCM。
- 规则：`nod-mic` 只能解析到本仓库 `plugins/nod-mic` 的 `registerPlugin`；禁止空 shim。`startUplink` 必须等 socket 打开才 resolve；失败不得先 `setUplinkActive` / 切断 JS PCM。
- 涉及：`web/vite.config.ts` · `web/src/shims/nod-mic.ts` · `bridge.ts applyUplinkToken` · `AudioUplink.start`

## 2026-09-09 · #171 审原生上行漏了 Vite 把插件指向空实现
- 我以为：`import('nod-mic')` 会调用包里的 `registerPlugin('NodMic')`；审 #171 只沿调用方与 Swift 插件看，没有核对构建时模块解析。
- 实际：Bundle 66 用户报告手机 Start 不开麦、表麦开了手机无内容。生产 00:38–00:41Z 多场 `audio_s=0`，近 30 分钟无 `/ws/audio`。`web/vite.config.ts` 无条件 alias `nod-mic` 到空 `start` / `startUplink`；拿到 token 后 JS 又停转 PCM。
- 规则：审原生插件必须核对构建 alias、`registerPlugin` 入口与同步产物；原生启动失败必须可观察，不能假成功后切断唯一数据通路。
- 涉及：#171 · `web/vite.config.ts` · `web/src/shims/nod-mic.ts` · `bridge.ts applyUplinkToken`

## 2026-09-09 · #171 断线把 isActive 关掉，PCM 交回 JS
- 我以为：`handleDrop()` 把 `isActive=false` 只表示 socket 断了，重连后会再打开；手机麦 / 表麦在这几秒走 JS 也没关系。
- 实际：`NodMicPlugin.emitPcm` 和 `WatchBridge` 用同一个 `isActive` 决定要不要 `notifyListeners`。断线后 PCM 立刻进 WKWebView，离线音频进不了原生 2 MB 缓冲，锁屏重连等于没缓冲。
- 规则：上行「模式已启用」和「socket 已连通」必须分开；`start()` 到 `stop()` / 4404 期间 PCM 只进原生队列，断线不得交回 JS。
- 涉及：`AudioUplink` `isEnabled` vs `isConnected` · `NodMicPlugin.emitPcm` · `WatchBridge` `.nodUplinkState`

## 2026-09-09 · #171 补发先清空缓冲且一次打完
- 我以为：重连后把 pending 整段 `send` 出去，失败再靠下一轮重连。
- 实际：`flushPending()` 先 `removeAll` 再忽略错误；服务端 `WS_FRAMES_PER_SEC = 40`，突发补发会被丢。失败的帧已经不在队列里。
- 规则：待发送列队头只在 send 成功后弹出；补发按音频时长 ≤ 实时（100ms 音频至少隔 100ms），不用帧率上限代替；新 PCM 追加在队尾，不得插到补发前面。尾块不足 50ms 不得发出。
- 涉及：`AudioUplink.flushPending` / `pump`

## 2026-09-09 · #171 attached 找不到 id 就用第一条历史
- 我以为：pending 列表通常只有当前这场，找不到 id 时用 `[0]` 总能补上锁屏转写。
- 实际：pending 可能有别的未保存场；异步回来时锁屏后的 `line_update` 已被 reducer 写进 `meetingLines`，整场 `restore_session` 会盖掉。
- 规则：认领只匹配 `usage_session_id`；对不上就不动；用序号丢掉过期响应；合并时保留请求期间新到的行。
- 涉及：`App.tsx` `attached` · `pickAttachedSession` · `mergeAttachedLines`

## 2026-09-08 · 手表 Resume 把手机麦会话翻成表麦

- 我以为：#134 把 `onResume` 列入 `applyWatchMic` 调用方，Resume 也要确认表麦。
- 实际：`applyWatchMic` 无条件 `setPreferWatchMic(true)`。手机 Start 的 Meeting 再手表 Pause→Resume：`preferWatchMic` 翻真 → `syncMic` 释放手机麦；手表 `localMic == false` 不开麦 → 两边无麦，25s 停听。
- 规则：麦归属只在 Start / Record 决定；Pause / Resume 继承，禁止 `applyWatchMic` / `setPreferWatchMic`。
- 涉及：`App.tsx` `installWatchRemote.onResume` · `watchResumeShouldChangeMic`

## 2026-09-08 · 阅读页 VStack 让滚出屏幕不触发 onDisappear

- 我以为：ForEach 单元的 `onAppear` / `onDisappear` 会在表冠滚出屏幕时翻转 `latestVisible`。
- 实际：非 lazy 的 `VStack` 一次把所有单元放进层级；`onDisappear` 只在视图移出层级时触发，滚出屏幕不触发 → `latestVisible` 恒 true → `readingAnchor` 恒滚到最新，`New translation ↓` 永不出现。
- 规则：用 appear/disappear 判断滚动可见性时必须 `LazyVStack`，禁止普通 `VStack`。
- 涉及：`WatchRootView.readingPage`

## 2026-09-08 · 过期 capture:off 在 Start 在途时杀掉手表麦

- 我以为：W5 等 `capture: listening` 才翻页就够；`syncFromCapture("off")` 见 `isRunning` 就停麦是正确镜像。
- 实际：W2 把 `saveBook` 加进 `pushWatchStatus` 依赖。手表 Start 立刻开 `WatchRecorder` 且 `starting=true`，手机 `commitBook` 180ms 后推的仍是 `capture: off`（Railway + AssemblyAI 握手还没完）。手表按过期 off 停麦；随后 `listening` 进阅读页但不重开麦 → 服务端 `audio_s=0`。Meeting / Lecture 手机麦没事。
- 规则：Start 在途时过期 `off` 不许停手表麦；`listening` 确认时若是手表麦模式且录音器已停，要补开。先读 `pushWatchStatus` 依赖会不会在 `phase(listening)` 之前发出 `off`。
- 涉及：`WatchPhoneSession.syncFromCapture` · `saveBook` / `pushWatchStatus` · Translate / Q&A 手表麦

## 2026-09-08 · Notes Auto 当成「隐藏目标语」而不是 Follow speech

- 我以为：#107 的 `notesTranslateTo` 默认 navigator/`zh` + `translateOn: true` 可以让 Auto 继续双语（Ask `:bi-zh`、Live 翻中文）。真机 Listen 仍翻成中文时，我先解释成「没关 More accurate」。
- 实际：Notes 选项文案是 `notesAutoHelp: 'Follow speech'`。用户选 Auto 就是不要指定笔记语、不要叠一层翻译。隐藏的 `notesTranslateTo=zh` 把 Follow speech 做成了跟 Speech Auto-detect 无关的「默认中文」。
- 规则：Notes Auto = 跟讲话走，不套 `notesTranslateTo`。双语只在具体 Notes 语言时生效。真机「还是翻成中文」先对 UI 文案，不要先教用户关开关。
- 涉及：`web/src/listen.ts` `notesBilingualOn` / `bilingualDisabled` · `askPrompt` · `pumpTranslate` · `iphoneCopy.ts` `notesAutoHelp`

## 2026-09-07 · listen_ask 输出语言把拉丁语 STT 锁当成「猜」

- 我以为：`detect_question_lang(transcript)` 能覆盖八种语言；`_confident_stt_lang` 的 `en` 分支表示「确定是英文」。
- 实际：拉丁语正则很弱（西语无 ñ 变 en；意语 `è ` 被法语先吃掉）。`en` 分支只是「≥16 个拉丁字母且无 CJK」，意语也命中。合上去会把 Speech 锁 Italian/Spanish 硬钉成 English/French，比不钉更差。服务端已有 `cfg.stt.language`。
- 规则：定输出语言要把八种语言逐个过一遍；有 STT 锁定信号先用它；"confident" 类函数采用前先读实现，拉丁字母多不算确定英文。
- 涉及：`server/lang.py` `listen_ask_lang` / `_confident_stt_lang` / `detect_question_lang` · `cfg.stt.language`


## 2026-09-05 · 给 Hermes 的清库单写成 Postgres

- 我以为：nodpilot 生产库是 Railway Postgres（看到 `docs/adr/0002-postgres-for-write-model.md` 的文件名就当已落地）。
- 实际：`railway variables` 只有 `DATA_DIR=/data`，没有 `DATABASE_URL`；`settings.database_url()` 回落到 volume 上的 SQLite `/data/nod.db`。Hermes 用 `railway ssh` + `sqlite3` 才做成。
- 规则：写涉及生产数据的指令前，先看 `settings.database_url()` 的实际分支和线上环境变量，不要拿 ADR 标题当现状。
- 涉及：`server/settings.py database_url` · Railway `nod-web-volume /data`

## 2026-09-05 · 把 History 条数当成月会话额度

- 我以为：`/api/me` 的 `sessions: 60` 就是用户在 History / Account 里能看见的 60 条。
- 实际：额度是 `count(UsageSession)`（本月每次 Listen 插一行，`kept=False`）。History 只列出 `kept=True` 且未 discarded 的。用户界面上一直只有约 9 条已保存会话；另外 ~50 条是点 Listen 但没 Save 的测试/短听，计入 60 但不出现在列表。删掉几条可见会话后额度从 60 降到 56，Listen 恢复；列表仍是 9 条左右。
- 规则：说「会话上限」时先查 `usage_snapshot` 的 `sessions` 聚合到底数哪些行，再和 History 的 `list_history` 过滤条件对照；两者口径不同就先指出来，禁止用列表条数反驳或解释 `sessions`。（2026-09-05 起产品决定：额度只数 `kept=True`，两边口径已对齐。）
- 涉及：`meter.py` `open_usage_session` / `usage_snapshot` / `list_history` · `kept`

## 2026-09-05 · e2e 本地绿、CI 连红三次没人看

- 我以为：`translate.spec.ts` 本地过了、变异测试能抓双发，就是「已验证」；push 完等于交付。
- 实际：CI 从 `d2f2bc2` 起连红三次（e6c22ac / a9e736f / d2f2bc2），没人看。本地绿是因为 `load_all_keys()` 先读仓库根 `.env` 的真 key，harness 传的 `DEEPSEEK_API_KEY=test` 被盖掉，LLM 真的回答了；CI 没有 `.env`，LLM 立刻失败 → `done(ok:false)` → 客户端按设计重试 → 2 秒内 3 个 `ask`。测试数的是「ask 总数」，分不清「顺序重试」和「在途重复」。抓 WS 帧还发现残留 bug：`done` 触发重试后，服务端紧跟的 `phase(off, idle)` 把刚发的重试当成卡住，再发一个——第 3 个 ask 在第 2 个在途时发出。
- 规则：push 后必须看 `gh run list` 的结论，红了当天处理，不许在 recap 里写「已 push」而 CI 是红的。本地 e2e 只有在服务端拿不到 `.env`（或 CI）下跑才算数。断言要写不变量（无在途重叠），不写会随 LLM 成败变化的计数。
- 涉及：`web/e2e/translate.spec.ts` · `server/app.py load_all_keys` · `App.tsx` `phase(off, idle)` 兜底 vs `done` 重试

## 2026-09-05 · 审 ADR 0001 漏了客户端对 `idle` 的旧依赖

- 我以为：`state` → `phase(capture, engine)` 只是把一个枚举拆成两轴，把 `state === 'idle'` 换成 `capture === 'off'` 就等价。
- 实际：旧 `state: idle` 只在会话级停止时发；新 `phase` 每次 engine 变化都发。`ask` 一开始就发 `phase(off, generating)`，`App.tsx` 里「idle 时释放卡住的翻译」的兜底把它当成会话停了：清 inflight、删 asked、重发。打字翻译（capture 本来就是 off）每句发两次 `ask`，译文叠两遍，多几次就 Failed。口说时 capture 是 listening，所以只有打字坏。
- 规则：把「按值判断」的事件换成「更频繁发」的事件时，逐个查旧值的消费方，问：它依赖的是**值**还是**这个值只在某种时刻出现**。后者必须补 engine / 转变条件。
- 涉及：`web/src/App.tsx` phase→`capture === 'off'` 释放翻译 · `server/app.py ask()` `_emit_phase`

## 2026-09-04 · Translate `think` 被当成 Phone Stop

- 我以为：手表跳回主界面是残留 idle、`sawPhoneListening` 闩锁、默认 Meeting、或抢麦。
- 实际：翻译出字时 `run` 会短暂变成 `think`。`buildWatchFace` 把这报成 `listening=false`。我加的「手机 Stop → 手表 Stop」把它当成真停，踢回 Ready。Hermes 改 `watchStatus.ts`：Meeting / Translate 的 `think` 仍算 listening；Interview 起草才不算。
- 规则：先看手机实际发出的 `run` / `listening` / `paused`，再改手表同步。禁止在没核对 `think` 之前加 Stop 闩锁。
- 涉及：`web/src/watchStatus.ts` · `WatchPhoneSession.phoneListenSync` · `pushWatchStatus`

## 2026-09-04 · 手表 UI 一天翻三次

- 我以为：「恢复原来的模式」= 换一套 Ready 交互（方块 → Picker → 昨天胶囊），可以和服务端同步一起改。
- 实际：用户要的是昨天能用的胶囊 + Start。界面和同步缠在一起，每次装包都像新 bug，时间全耗在来回。
- 规则：手表 Ready 冻在胶囊 + Start，未经用户点名禁止改模式选择 UI。同步和界面不许同一轮改。
- 涉及：`WatchRootView.swift` · `watchFace.ts`

## 2026-09-04 · 只装手表原生、手机网页仍是旧的

- 我以为：Watch Swift 改完 `xcodebuild` + 装表就够。
- 实际：抢麦、`think` 状态、`paused` 都在手机 JS / 插件。没 `cap:sync` 时手表新、手机旧，对不上。
- 规则：改了 `web/src` 或 `plugins/nod-watch` 必须 `cap:sync` 再装**手机和手表**。装完用设备上的 Bundle Version 核对，不要口头说已装。
- 涉及：`npm run cap:sync` · `CURRENT_PROJECT_VERSION`

## 2026-09-04 · 用新同步层盖误诊

- 我以为：再加 `localModeHeld` / `phoneModeSeen` / 不发 Meeting / 释放手机麦，就能修好跳回主界面。
- 实际：这些有的有用（不发残留 Meeting、释放手机麦），但都不是跳回主界面的根因。根因是 `think` → `listening=false`。
- 规则：用户说「还是不行」时，先复现手机发出的状态，禁止再叠一层闩锁碰运气。
- 涉及：`WatchPhoneSession.swift` · `web/src/watch.ts`
