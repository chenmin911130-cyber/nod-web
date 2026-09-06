# 执行单 · Translate（iPhone）重排：方向卡片 → 双语记录 → 语音控制与文字输入

参考图：`docs/design/translate-phone-redesign-mockup.jpg`（左：开始前；右：收音中）。
**文字规格优先于图片**：图里没画暂停态、失败态、live 卡；图里写 `End`，实现用 `Stop`。

## 0. 范围与约束

- 只改 **手机壳层**：`usePhoneChrome()` 为 true / CSS 前缀 `html.nod-phone .app.iphone-v2`。桌面与网页版布局不动。
- 不改：`server/`、`translateGate.ts`、`swapTranslatePair`、翻译 pump / 重试逻辑、`plugins/nod-watch`、Watch。
- Listen 页只因共用组件受两处影响（见 §1、§4），Listen 自身重排是另一单。
- 从 `origin/main`（`21afcb6`）开新分支。#25 已合入 main，工作区没有 #25 未提交改动；不要回退 #25。未提交的 `errors.md` / `AGENTS.md` 不是本单的一部分。
- 开工前读 `.cursor/skills/self-improve/errors.md`。

## 1. 顶部（`TitleBar.tsx`，仅 phone）

1. `titlebar-right` 里齿轮左侧新增 `…` 按钮（`tb-icon`，浅灰），`onClick → props.onMore`，打开现有 `IphoneActions` 底部菜单。菜单四项与灰掉规则不变：Export PDF / Save / History / New session，`moreMenuEnabled`。
2. 齿轮菜单（`TitleIcons` 的 `tb-menu`，`phone &&` 分支）：
   - 删掉 `History`、`More` 两项（已由 `…` 承接）。
   - 新增 **Read aloud · Auto**（开关，绑 `ttsMode` `'tap' | 'live'`，保留 `ttsAutoShouldConfirm` 的确认弹窗）和 **Voice · Female / Male**（绑 `ttsVoice`，写入 `writeTtsVoice`）。这两项现在在手机上因 `.tr-voice-row { display:none }` 完全不可达，这次给它们一个入口。
   - TTS 两项**只在 `mode === 'translate'`** 出现。Listen 齿轮不要 Auto / Voice（TTS 只属于 Translate）。
   - `TitleIcons` 增加 `ttsMode` / `ttsVoice` / `onTtsMode` / `onTtsVoice`。确认弹窗从 `TranslatePane` 的 `autoAsk` 迁到齿轮这一侧，文案与按钮保持现有 `Turn on Auto play?`。
   - 其余（Opacity、Version、Sign out）不动。手机顶栏 mic（`.src-btn`）已被 CSS 隐藏，保持。
3. `TranslatePane` 的 `voiceChrome`（第二份 `TitleIcons`）在 phone 上不再渲染（它随隐藏的 voice row 一起消失，但仍在 DOM 里；直接不传或条件渲染）。

分工规则写进注释：**齿轮 = 长期设置，`…` = 这次会话的操作**。

## 2. 语言方向卡片（`TranslatePane.tsx` toolbar，phone）

替换现有 `tr-head-row` 两个 chip（EarIcon / ArrowIcon）为一张卡片：

| From（小字标签） | 中间 | To（小字标签） |
|---|---|---|
| `Auto-detect ▾` 或语言名 | `→` 或 `⇄` | 语言名 `▾` |

- 两侧仍是现有 `<select>`（`onTranslateFrom` / `onTranslateTo`），只改外观。
- 文案：`IPHONE_COPY.hearAnything: 'Hear anything'` → 新键 `autoDetectFrom: 'Auto-detect'`；`translateFromChip('auto')` 改用新键。
- 中间控件，新增纯函数 `translateSwapAffordance({ from, heardFrom }): 'arrow' | 'swap'` 放 `iphoneCopy.ts`，加单测：
  - `from === 'auto'` 且 `heardFrom` 为空 → `'arrow'`：静态 `→`，`aria-hidden`，不可点。
  - `from === 'auto'` 且已有 `heardFrom` → `'swap'`：可点，title `Lock {heard} → {to} and swap`，`onClick → onSwap`（现有 `swapTranslatePair` 在 auto 下会把 From 锁成 To、To 换成 heard，正是这个语义）。
  - `from !== 'auto'` → `'swap'`，`onClick → onSwap`。
- 删掉 phone CSS 里 `.tr-swap { display:none }`，改由上面逻辑决定。

## 3. 空态（开始前）

- `EmptyState` 增加可选 `icon?: ReactNode`；Translate phone 传一个小的静态双语图标（两个圆角方块 `A` / `文`，约 56px，参考图左）。
- 文案：`emptyTranslate: 'Speak any language.'` → 拆两键：`emptyTranslateTitle: 'Ready to translate'`、`emptyTranslateSub: 'Tap the mic below to speak, or type to translate.'`。`sub` 在 native 下不再传空串。

## 4. 底部控制（`IphoneActions.tsx`，`variant='translate'`）

位置：phone 上 `actions` 从顶部 `iphone-stack` 移到 **`tr-sheet` 与 `iphone-tr-prompt` 之间**，紧贴输入框上方。键盘弹出（`html.nod-native.kb-open`）时随输入框一起上移；若空间不够，ready 态的大按钮可在 kb-open 时收起，listening 态的控制条必须始终可见。

- **Ready**：单个全宽青色按钮，麦克风图标 + 新键 `startTranslate: 'Start voice translation'`。**删掉旁边的 `MoreButton`（`iphone-more-sq`）**——这是共用组件，Listen 的 ready 行也会同时失去它，由 §1 的顶部 `…` 承接。
- **Listening**：紧凑控制条：红点 + `Listening` + `StatusWave` + `Pause` + `Stop`。不显示时钟（会话时长对 Translate 无意义，且 `meetingElapsedMs` 只在 Meeting 起跑）。现有 UI 是时钟和波形 XOR——**不要**改成全局 additive。Listen 保持 Listening + 红点 + 时钟、无波形；Interview 保持只有波形。
- **Paused**：`Paused` + `Resume`（麦克风图标，用 `IPHONE_COPY.resume` 而不是现在的 `startListening`）+ `Stop`。不显示时钟。**删掉行内 `MoreButton`（`iphone-more-inline`）**。
- `Stop` 文案保持 `Stop`，不用图里的 `End`。

## 5. 双语卡片（`NativeTranslateCard`）

每条从上到下：

1. **元信息行**（灰小字）：`{语言名} · {ts}`。新增 `translateSourceName`（同一套 from/locked/heard 输入），返回 `TRANSLATE_LANGS[].name`；auto 且未识别时返回 `''`，卡片只显示时间。**不要改** `translateSourceTag` 的返回值（桌面/测试仍用 `EN` / `CH`）。
2. **原文**：14px、`#9aa4ae`（现有样式），点文字仍复制原文（现有 `tr-copy-hit`）。
3. **译文**：17px、白色（现有 `iphone-tr-target`）。
4. **操作行**（右对齐）：复制译文图标（`onCopyField(p, 'translation')`，明确图标而不是只靠点文字）+ 现有播放按钮 `tr-speak`。播放按钮**保留**，Auto 朗读与音色移到齿轮（§1）。

状态：
- `Translating…` / `Waiting…`：译文位弱化文字（现有 `pending`），**上方控制条继续显示 Listening**——收音与生成分别表达，不许因翻译中改动控制条。
- `Failed` + `Retry`：现有逻辑，保证在新卡片布局里有位置。
- live 卡（`ts === 'live'`）：原文实时增长，译文位 `Listening…`，左侧细条微弱脉冲区分于已定稿卡片。
- `tr-queued` 计数在 phone 不显示（它本来就在隐藏的 voice row 里），无需另找位置。

不加 Live / Transcript / Notes 标签。

## 6. 底部输入框（`iphone-tr-prompt`）

- 占位符 `Type to translate` 不变（`translate.spec.ts` 依赖它）。
- 发送按钮：有内容 → 青色（加 `.ready` 类），空 → 灰（现有 `disabled`）。Enter 提交不变。
- 打字翻译不需要先开麦：现有 `handleTranslateTyped` 路径，不改。

## 7. 文案清单（`iphoneCopy.ts` + `iphoneCopy.test.ts`）

新增：`autoDetectFrom`、`emptyTranslateTitle`、`emptyTranslateSub`、`startTranslate`、`copyTranslation`（aria）。
删除/替换：`hearAnything`、`emptyTranslate`。`translateFromChip` 断言改为 `Auto-detect`。`translateSourceTag` 断言保持 tag。补 `translateSourceName` 与 `translateSwapAffordance` 三分支。`IPHONE_COPY.start` 可留着，Translate 按钮改用 `startTranslate`。

## 8. 非目标

无 Live/Transcript/Notes 标签；无「解释这句话」；不改服务端、桌面、Watch；不改 `swapTranslatePair` / `translateGate` / pump 与重试。

## 9. 测试

- 单测：`iphoneCopy.test.ts`（新文案、`translateSwapAffordance` 三分支）、`tts.test.ts` 不回归。`cd web && npm run typecheck`（含全部 `*.test.ts`）。
- e2e：`web/e2e/translate.spec.ts`（打字路径「asks never overlap」）和 `workspace.spec.ts`（`role=tab` Translate，桌面壳 `Mode · Translate`）必须仍绿。新增 phone 断言必须 `setViewportSize({ width: 390, height: 844 })`，否则 `usePhoneChrome()` 为 false、会打到桌面空态。断言：空态标题 `Ready to translate`；按钮文案 `Start voice translation`；方向卡显示 `Auto-detect` 与目标语言。不要改 pump / 重试；#11 不在本单。
- 桌面/网页不回归：非 phone 下 `tr-voice-row`、`tr-swap`、`PromptAttach` 输入区外观不变（可用 `phoneChrome.test.ts` 的方式断言分支）。

## 10. 交付

1. 新分支 + PR，`gh run list` 绿后再报完成（errors.md 09-05：不许 CI 红着说「已 push」）。
2. `npm run cap:sync`，`ios/App/App.xcodeproj/project.pbxproj` 的 `CURRENT_PROJECT_VERSION` **32 → 33（四处，不是两处）**，装 **手机**（本单不涉及 Watch，但 `web/src` 改了就要 cap:sync）。
3. 装完在设备上核对 Bundle Version。

## 11. 设备验收清单

- [ ] 顶部：Logo · `…` · 齿轮；`…` 打开 PDF/Save/History/New session，空会话时 PDF/Save/New 灰。
- [ ] 齿轮里能切 Auto 朗读（有确认弹窗）和男/女声；没有 History / More。
- [ ] 方向卡：Auto-detect → Chinese，中间是静态箭头；说一句英文后箭头变可点，点后变 Chinese → English。
- [ ] 锁定 English → Chinese 时中间可点交换。
- [ ] 空态：图标 + `Ready to translate` + 引导句；下方一个青色 `Start voice translation`，旁边没有 `…`。
- [ ] 开始后：控制条显示 Listening · 波形 · Pause · Stop；暂停后 Paused · Resume · Stop，无行内 `…`。
- [ ] 说话时先出 live 卡（原文增长 / `Listening…`），定稿后译文位 `Translating…`，期间控制条仍是 Listening。
- [ ] 卡片：`English · 09:42` / 原文灰 / 译文白 / 复制 + 播放；播放能出声。
- [ ] 断网或重试耗尽出现 `Failed` + Retry，Retry 可用。
- [ ] 不开麦直接打字翻译成功，发送键有字变青色。
- [ ] 键盘弹出时输入框上移，记录可滚动。
- [ ] Listen 页：ready 行只剩 Start Listening，`…` 在顶部；其余不变。
