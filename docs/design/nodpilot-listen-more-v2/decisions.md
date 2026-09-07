# Listen v2 · 落地决策（2026-09-07）

设计稿 `design.md` 与 `origin/main`（`a51d8a5`）现有行为有 5 处冲突。以下为设计侧最终决定，执行单以此为准；实现时不再重新讨论。

## D1 · End 封会话，Ended 条替代 Start

End 之后控制条显示 `Ended · mm:ss`，不再出现 Start listening。再录只能走 More → New session（含离开流程）。

理由：main 上 End 后再点 Start 会走 `listen_new`，直接清空 `meetingLines / notesRaw / catchNotes` 而不问保存——这是一条静默丢内容的路径。封会话同时修掉它。

## D2 · End 后用页内 Save 条；次要动作是 Not now，只关闭

- 手机端 End 后不弹 `SavePrompt` 模态，改为 Notes 底部页内条：`Save this session?` · `Not now` · `Save`。
- `Not now` 只收起条，**不发** `discard_history`；内容留在页面，More → Save 仍可用。
- `Save`：native 直接 `keep_history`（native 一直默认带录音）；非 native 手机宽度打开现有 `SavePrompt` 以保留录音勾选，但其次要按钮改为 `Cancel`（只关闭）。
- `Don't save`（真丢弃）只保留在 New session 离开流程与恢复会话（restore）对话框里。
- `Saved to History` 只在收到本会话的 `history_kept` ack 后显示。Saving… / Retry save 属于状态机单（F），布局单不做。

## D3 · 录音中允许 New session，走两步离开流程

- 录音 / 暂停中点 New session：先出 `End this recording?` 面板（`End and start new` / `Cancel`）。
- 结束后若有未保存内容：`Save and start new` / `Discard and start new`（红）/ `Cancel`。
- `Save and start new` 必须等 `history_kept` ack 后才清空开新（errors.md 2026-09-07 两条规则）。
- 已保存或无内容：直接新建，不问。

## D4 · Ask 回答显示在 Live；Notes 仍保留同一条记录

- Live 流按时间插入用户提问气泡与 Nodpilot 回答卡；它是 `catchNotes` 里同一条 ask 记录的另一种视图，不是第二份状态。
- Notes 的 Ask 卡、PDF、History 语义不变。
- 快捷 chip 两枚：`Summarize so far` → 现有 `onSummary`；`List action items` → `onAsk` 固定提问。只在 listening 且有内容时显示。
- 这是最后一单（H），A–E 先落地时回答仍去 Notes。

## D5 · Recording setup 用 Done 提交；录音中设置只读

- 面板内持草稿，`Done` 一次性调用 `onScene` / `onMeetingSpeakers`；`X` / 遮罩只关闭、不提交。
- Spoken language / Notes language 各自一个同样式的底部面板，选中即提交（单选无需 Done）。
- listening / paused / ended 期间三行设置折成一行只读元信息 `Meeting · Auto-detect · Chinese notes`，不可点。

## 其他

- 青色沿用现有 `#00d2ff`（品牌字标与手表侧一致），不切到 `#00C4E8`；其余 token 按 `design.md`。
- Translate 工作区、Live Q&A（interview）内容区、桌面 web、Electron 不在范围；只改 `html.nod-phone .app.iphone-v2` 作用域。
- Notes 下方现有 Export PDF / Copy / Share 三按钮保留。
