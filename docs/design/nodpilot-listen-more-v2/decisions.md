# Listen v2 · 落地决策（2026-09-07，修订版）

设计稿 `design.md` 与 `origin/main`（`a51d8a5`）现有行为有 5 处冲突。以下为最终决定，执行单以此为准。修订说明：画板 4 漏画了结束后继续录音的入口，这是设计遗漏，不据此把「结束即封会话」变成产品规则。

## D1 · 结束后可以继续录音；New session 才开新会话

- End 之后控制条显示 `Ended · mm:ss`，旁边保留 `Start listening`；点它**沿用当前会话**继续采集，内容与时钟接着走。
- New session 才创建新会话（走 D3 的离开流程）。
- 已保存的会话继续录音后，新产生的内容标为待保存：续录开始时清掉本地 Saved 状态，`Saved to History` 行和 More 里的 `Saved` 文案退回未保存态；再次 Save 走同一条 keep 路径。

现状核对：main 上 End → Start 会 dispatch `listen_new` 清空手机上的 `meetingLines / notesRaw / catchNotes`，但**不向服务端发 `clear`**；服务端 `stop_listen` 不清 `usage_session_id`，`_ensure_usage` 复用同一 id 继续 `save_history`。即服务端已经在续同一场，只是客户端把页面清了。D1 的实现就是让客户端与服务端一致，不涉及协议变更。`keep_usage_session` 幂等，重复 Save 安全。

## D2 · End 后用页内 Save 条；Not now 只关闭；可靠性一起做

- 手机端 End 后不弹 `SavePrompt` 模态，改为 Notes 底部页内条：`Save this session?` · `Not now` · `Save`。
- `Not now` 只收起条，**不发** `discard_history`；内容留在页面，More → Save 仍可用。
- `Save`：native 直接 `keep_history`（native 一直默认带录音）；非 native 手机宽度打开现有 `SavePrompt` 保留录音勾选，其次要按钮改为 `Cancel`（只关闭）。
- 与此同时实现 `Saving…`、超时、失败、`Retry save`。验收：**保存确认必须匹配发起请求的会话；仅在该会话收到成功确认后标记 Saved，或执行等待中的新建操作。失败、超时、旧会话迟到的确认均不能清空当前内容。**
- `Don't save`（真丢弃）只保留在 D3 的离开流程与恢复会话（restore）对话框里。
- 不直接搬未合并分支 `meeting-merge-and-dedup` 的 `sessionSave.ts`；可作参考，从 main 重写。

## D3 · 录音中允许 New session，专用三选面板

- 录音 / 暂停中点 New session 打开面板：`Save and start new` / `Discard and start new`（红）/ `Cancel`。
- 面板打开期间继续录音，`capture` 不变；`Cancel` 不发任何消息、不改任何状态。
- 选前两项之后才 `stop_listen`，等最后的转写落地；保存成功（该会话的 `history_kept`）或明确丢弃之后才 `clear` 并新建。保存失败留在原会话。
- 已保存或无内容：直接新建，不问。

## D4 · Ask 回答显示在 Live；Live Q&A 仍是独立场景

- Meeting / Lecture 的 Ask 用于询问当前已采集内容；回答按时间插入 Live 流（提问气泡 + Nodpilot 回答卡），**不写入 Transcript**，不中断录音。
- 回答卡是 `catchNotes` 里同一条 ask 记录的视图，Notes / PDF / History 不产生第二份。
- 两枚快捷 chip：`Summarize so far` → 现有 `onSummary`；`List action items` → `onAsk` 固定提问。复用同一请求流程，支持生成中、失败、重试状态。点击不切换到 Live Q&A 场景。
- 这是最后一单（④），依赖 Live 发言流（C）。

## D5 · Recording setup 先改草稿、Done 才提交；录音中设置只读

- 面板内持草稿，`Done` 一次性调用 `onScene` / `onMeetingSpeakers`；`X` / 遮罩 / `Cancel` 不提交。Done 语义随 Ready 页新面板（B 单）一起出，因为面板本身是新组件。
- Spoken language / Notes language 各自一个同样式的底部面板，单选点选即提交。
- listening / paused 期间场景、人数、口语语言、笔记语言均只读：入口折成一行只读元信息 `Meeting · Auto-detect · Chinese notes`，**并且** `onScene / onMeetingSpeakers / onSpeechLang / onTranslateTo` 处理函数同样门控，不能只隐藏控件。
- 结束后允许调整，下一次开始采集生效，不自动重写已有内容。

## 执行顺序

纯视觉（不夹带行为）：A 顶栏 / 控制条 Recording·Paused / 标签 / More 面板壳 / Notes 标题 → B Ready 页 + 面板（含 Done）、C Live 发言流、D Transcript（三者可并行）。

行为（串行）：① 续录 + Ended 条 → ② Save 条 + 状态机 → ③ 录音中 New session → ⑤ 设置门控 → ④ Live 内 Ask。行为线与视觉线可并行开工；④ 需等 C。

## D6 · History 恢复后再 Start = 续同一场（同 D1）

- History 打开已保存会话后，页面是 **Ended**（不是正在录）：时钟显示恢复会话的时长（优先最后一行 `ts`，否则 `stt_seconds`），`Saved to History` 可以留着。
- 再点 `Start listening` 走与 D1 相同的 `meeting_resume`：时钟接着走、旧段落保留、`historyKept` 清掉（Saved 行消失），End 后再次出 Save 条并覆盖同一条历史。
- **不是**「以旧内容开新场」：禁止 `restore_session` 把 `meetingEnded=false` + `meetingElapsedMs=0` 再 `meeting_clock` 从零起（那就是 00:03 控制条 + 01:05 段落 + Saved 行同时出现的截图）。

路径核对（代码，2026-09-07）：

- **A** End → Save → Start：`meetingEnded` + 有内容 → `meeting_resume` + `resumeResetsKept`。与截图不符，不是这张 bug。
- **B** History 恢复 → Start：修前 `restore_session` 设 `meetingEnded=false`、`elapsedMs=0`、`meetingStartedAt=now`，Start 落到 `meeting_clock` 从 0 起，且 `markHistoryKept(true)` 未清。与截图一致。



- 青色沿用现有 `#00d2ff`（品牌字标与手表侧一致）；其余 token 按 `design.md`。
- Translate 工作区、Live Q&A（interview）内容区、桌面 web、Electron 不在范围；只改 `html.nod-phone .app.iphone-v2` 作用域。
- Notes 下方现有 Export PDF / Copy / Share 三按钮保留。
