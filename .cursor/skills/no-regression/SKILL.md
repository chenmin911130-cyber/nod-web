---
name: no-regression
description: >-
  Prevents fixing one Nod bug from breaking adjacent features. Use after any
  code change, bug fix, UI tweak, or when touching listen, start_listen, ask,
  busy, rail, Interview, Meeting, Translate, WebSocket, or cancel/done. Also
  use when the user says 修复, 改界面, 别引出新 bug, or 回归.
---

# No Regression

修一个问题之前，先圈出共享状态；改完必须用真实路径验证相邻功能。没有相邻路径验证，不得声称完成。

## Before you edit

1. 用一句话说清这次只改哪条产品行为。不要把侧栏显隐和答案生成塞进同一次改动。
2. 列出本次会碰到的共享状态（见下方耦合表）。碰到其中任一项，就按「相邻路径」整表测，不要只测眼前这一个按钮。
3. 能写成测试的，先写一条会失败的测试再改。修好后这条测试留下。

## Shared state (do not clobber)

这些状态被多个模式共用。改 A 时禁止顺手改 B 的语义：

| 状态 | 谁在用 | 禁止 |
|---|---|---|
| `busy` | Interview 问答、笔记、翻译、Ask | 听写的 `state: listen/idle` 不得清掉问答 busy |
| `state: listen/idle/think` | 听写、生成 | `listen` 只表示在听，不表示生成结束 |
| `_cancel` / `_gen_seq` | LLM 生成 | 停听不得取消正在写的答案 |
| `start_listen` / `stop_listen` | Meeting / Interview / Translate | 旧进程或漏掉的 command 会表现为「不能听」 |
| 手表残留 file / queued start | iPhone 听写 | 不得自动 `start_listen`，也不得 `preferWatchMic`；只有手表当场 Listen/Record 才能走手表麦 |
| 手表残留 speech file / context | 打开 Watch | 不得自动播放上一句 TTS；不要再 `transferFile` 排队语音；只有当场 live sendMessage 才能播 |
| 手表息屏录音 / pendingPcm / 断连 flush | Watch 麦 → 手机听写 | `WKBackgroundModes=audio` + 听写中起 `WKExtendedRuntimeSession`；`pendingPcm` 必须加锁；断连要把 `liveStreamed` 复位并只 flush 未发出的尾包；flush 的 PCM file 仍不得 `start_listen` |
| 手表模式 Meeting / Lecture / Interview / Translate | 手机 workspace + `start_listen` | 只在当场 Listen/Record 且未 Pause 时切模式；Pause / Resume / Done / 残留 file 不得改 workspace；空/未知 mode 保持手机当前模式；Translate 不得覆盖 `listenScene`；切模式不得单独 `start_listen`，必须仍走现有 Listen 路径 |
| 手机麦 dummy / 无 PCM | Meeting / Interview / Translate | 手机 Start 必须重开 NodMic；听写中 4 秒无 PCM 必须报错，不能静默 Listening |
| `inQa` / rail | Interview 侧栏 | 只控制显隐，不得 `stop_listen` 或 `cancel_generate` |
| `done` / `error` | 前端收尾 | 任何提前 `return` 或 `_cancel` 必须发 `done` 或 `error` |

取消路径必须有收尾：`process_text` 中途退出要 `emit done`；`ask` 抢不到 busy 也要给前端一个结束信号。

## After you edit

按这次改动勾相邻路径。没碰到的可以跳过；碰到共享状态的必须全做。

**Interview**

- 空状态能看到 Start Listening
- 打字提问 → 答案出现（不能停在 Waiting / Asking）
- 再问第二条 → 两条都有对应答案
- 听写中提问 → 停听 → 答案仍在生成或已经写完
- 进入问答后侧栏收起，Controls 能再打开并 Stop Listening

**Meeting**

- Start Listening → 状态变成 Stop / In meeting
- Stop → 再 Start 或 Resume，没有 `Unknown command: start_listen`
- 听写中 Ask / Summarize 仍能出结果

**Translate**

- 开着听写再来一句，翻译会完成，不能 Failed / 一直 Translating
- 切语言或停听，不打断无关的问答（Interview 不在此页）

**iPhone / Watch mic**

- 手机 Start Listening → 必须出 PCM 或明确报 Microphone is silent，不能只亮 Listening
- 今天没碰手表时，打开 App 不得自己开始听写
- 手表 Listen/Record 仍能用手表麦；手机再点 Start 必须抢回手机麦
- 手表选 Interview / Translate / Lecture 再 Listen：手机切到对应页再 `start_listen`，不能停在旧 Meeting 页
- 手表 Pause / Resume / Done：手机模式不变，不能把问答 busy 清掉或误切 Translate
- 残留 queued `start` + mode 仍受 30s 时间戳限制，不得自己切模式并听写
- 打开手表 Nod 不得自动播放上一句语音；手机 Play / Stop 仍只控制手机端 TTS
- 改手表界面后必须把 WatchApp 直接装到手表（只装 iPhone 常会留下旧 Live / Play，看不到模式选择）
- 手表息屏后 Listen 必须还能录；断连后 Done 要把未发出的 PCM 传给手机，不能因为曾经 liveStreamed 就丢尾包

**空 / 失败**

- 空状态文案正常
- 生成失败有 error，busy 会清掉
- 清会话后能重新听、重新问

## How to verify

1. 后端改了就重启 9320，确认不是旧进程。
2. 有测试就跑相关 pytest / `tsc --noEmit`。
3. Web 改动用浏览器走完主路径：点、打字、提交，不要只截一张图。
4. 发现回归先修再重测，不要带着 Waiting / Unknown command 结束。

本地常用：

```text
http://127.0.0.1:5174/app
http://127.0.0.1:9320/api/health
```

## Done means

- 原 bug 已复现并修掉
- 相邻路径已走通，或写明哪条因缺环境没测到
- 新测试（如有）是绿的
- 没有把「听写状态」写成「问答结束」
