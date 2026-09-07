# Agent error log

Newest first. Read before Watch / listen / Translate / phone-sync work.

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
