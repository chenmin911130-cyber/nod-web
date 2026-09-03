# Nod Web · AI 辅助测试体系规划（v1）

> 本文档基于 nod-web 仓库的真实代码与现有测试诊断而生，不是通用模板。
> 目标：让「你写功能，AI 扛 QA」在 nod 上落地，且不重复造已有测试的轮子。

---

## 0. 一句话结论

nod 现在已经有一套**水平相当高**的 unit / API / 安全测试（23 个 pytest + 9 个前端逻辑测试），
但 **E2E 层完全空白**（无 Playwright），且**钱相关的计量/计费**与**实时 WebSocket 状态机**这两块
是最高风险、最值得优先补强的。补强顺序是：**P0 计量与计费 → P0 核心工作区冒烟 → P1 Stripe/认证 → P2 语言与转写边界**。

---

## 1. nod 测试现状诊断（先看缺什么，再谈建什么）

### 已有的（不要再重复建）

| 层 | 现有测试 | 覆盖了什么 |
|---|---|---|
| Backend Unit | `tests/test_hardening.py`（799 行）、`test_lang_filter.py`、`test_tts.py` 等 | 语言过滤 `matches_locked_speech`、问题过滤器 `guard_question`、转写 URL/参数 `assemblyai_ws_url`、`clean_transcript`、`apply_caption_repair`、`split_code_switched`、`manual_chunk_ready`、`model_allowed`（模型白名单） |
| Backend API/安全 | `test_hardening.py`（ApiGuardTests, StaticTraversalTests）、`test_clerk_auth.py`、`test_headers.py`、`test_cors.py`、`test_otp.py`、`test_register_race.py`、`test_host_lock.py` | Origin 锁、Admin token、路径穿越、Stripe webhook 签名、WS 匿名拒绝、CORS、Host 锁、OTP、注册并发、安全头 |
| Backend 数据/计量 | `test_history_fmt.py`、`test_history_delete.py`、`test_history_keep.py`、`test_keep_usage_null_keys.py`、`test_backup_archive.py`、`test_listen_idle.py`、`test_ask_busy.py`、`test_live.py`、`test_watch_*.py` | 历史格式、删除、保留、备份归档、监听空闲、busy 状态、live、Watch |
| Frontend 逻辑 | `src/*.test.ts`（9 个：audioRestart/historyRestore/meetingPause/micGuard/pdfBrand/recordReport/tts/watchMic/watchStatus） | 纯逻辑模块，**不含 DOM/组件**（用 `tsx` 跑），见下方注意 |
| 附件 | `test_attachments.py` | 附件解析/缓存 |

### 关键缺口（这是本方案的核心）

1. **E2E 层完全空白** —— 没有任何 Playwright / 真实浏览器流程测试。这是最大缺口。
2. **计量/计费（钱）** —— `meter.py` 的 `consume_stt`/`consume_llm`/`usage_snapshot`、Stripe checkout/webhook
   的高风险路径，现有测试覆盖明显不足（只有 websocket 匿名拒绝 + webhook 未签名，**没有测计量正确性、配额截断、Stripe 事件处理**）。
3. **前端测试是假的 Vitest** —— `package.json` 里 `test` 是 `for f in src/*.test.ts; do tsx "$f"`，
   没有 DOM 环境、没有组件渲染、没有 testing-library。只能测纯函数。**组件交互、状态机、快捷键逻辑**完全没测。
4. **WebSocket 状态机** —— `/ws` 的完整生命周期（connect → question → answer → disconnect，以及
   busy / idle 转换）目前没有端到端测试，只有 `test_live.py` 和 `test_ask_busy.py` 的局部覆盖。
5. **实时音频链路（AssemblyAI WS）** —— 依赖外部 API，必须 mock 才能稳定测试，但没有专门的 mock fixture。

---

## 2. 推荐技术栈（对 nod 定制）

```
tests/                          ← 后端 pytest（已有）
├── test_hardening.py           (已有)
├── test_meter_billing.py       ★ 新建 P0：计量正确性 + 配额 + Stripe
├── test_ws_lifecycle.py        ★ 新建 P0：/ws 状态机端到端
├── conftest.py                 ★ 新建：test DB、mock STT/LLM fixture

web/src/
├── .../*.test.ts               (现有纯逻辑)
├── __tests__/                  ★ 建议新增真正的组件测试环境

web/e2e/ 或 根目录 e2e/         ★ 新建 P0：Playwright
├── interview.spec.ts
├── meeting.spec.ts
├── translate.spec.ts
├── auth_flow.spec.ts           (注册/登录/OTP)
├── fixtures/                   ★ mock 真实 STT/LLM 的响应
└── playwright.config.ts
```

**要点：**

- **后端**：pytest（已是），`pyproject`/`pytest.ini` 已有，直接复用。
- **前端**：建议把现有 `tsx` 跑测试的玩法**保留**（它测纯逻辑快），但**新增 Vitest** 做组件/交互测试
  （因为 React 组件、WebSocket client 状态、快捷键 handler 都是纯逻辑测不到的）。Vitest 支持 `jsdom` +
  `@testing-library/react`。
- **E2E**：Playwright（对 nod 是最值得投入的一层）。
- **CI**：GitHub Actions。注意 nod 已有 Stripe、Clerk、R2(Cloudflare)、Resend、Sentry —— **绝不能把真实
  secret 放进 CI**，必须用 test 环境变量 + mock。

---

## 3. 测试金字塔与优先级（P0 / P1 / P2）

> 原则（来自你同意的方案）：先保证用户最常走的路径，90% 是 P0；钱和安全相关 = P0；
> 动画/次要 UI = P2，不做。

### P0 —— 必须自动化的（用户核心价值 + 钱 + 安全）

| 类别 | 具体测什么 | 技术 |
|---|---|---|
| 计量正确性 | `consume_stt`/`consume_llm` 正确累加分钟/ tokens / 成本；SQL 原子累加不丢更新（两会话并发同一天） | pytest |
| 配额截断 | 达到 `stt_limit` / `daily_stt` / `llm_tokens` / `daily_cost` / `global` 时 `usage_snapshot.ok=False` 且 reason 正确；触发后 `can_start_session`/`consume_llm` 拒绝 | pytest |
| 计划降级 | `subscription_status in (canceled, unpaid, incomplete_expired)` → `plan_of` 降为 free | pytest |
| Stripe webhook | 有效签名处理成功；无效签名拒绝；`checkout.session.completed` 等事件正确更新用户 plan / status；幂等处理重复事件 | pytest + mock stripe |
| 注册/登录/OTP | 注册成功、重复 email 409（含并发 race）、密码强度、登录失败统一 401、OTP 过期/错误 401、限流 429 | pytest（部分已有） |
| **核心工作区冒烟（E2E）** | Interview：注册→登录→进入→Start Listening→看到状态变化；Meeting：Start→Pause→Resume→Stop→Mark Action→Generate 纪要；Translate：选语言→翻译 | Playwright + mock |
| WebSocket 生命周期 | 连接→发 question→收到 answer 流→断开；busy 时二次 ask 被拒；idle 超时清理 | pytest（ws）|

### P1 —— 高频但非致命

| 类别 | 具体测什么 | 技术 |
|---|---|---|
| 附件上传 | 5 个上限、8MB 上限、PDF/docx/xlsx/pptx 解析、图片、非法类型拒绝 | pytest |
| 历史记录 | 保存、列表、删除、保留、文件下载 URL、PDF 导出文件名 | pytest（部分已有）|
| 模型切换/白名单 | 切换 model，非白名单模型被拒 | pytest（已有 model_allowed）|
| 前端组件交互 | 三个工作区切换、快捷键 F2/F3/F4、状态栏文案、按钮禁用逻辑 | Vitest + testing-library |
| 翻译 | 目标语言列表、Bilingual 开关、句子拆分、重试/Failed | pytest + Vitest |
| 语言边界 | 中英日意德法西葡的 `detect_question_lang`、`matches_locked_speech`、code-switching 拆分 | pytest（已有大部分）|

### P2 —— 不做 / 低优先级

- 动画、颜色、次要 UI、宣传页特效。**明确不做**，避免投入产出失衡。

---

## 4. E2E 层（Playwright）—— 当前最大缺口，重点部署

### 4.1 推荐目录与配置

```
e2e/
├── playwright.config.ts        (webServer 启动后端 + 前端；baseURL 9320)
├── fixtures/
│   ├── stt_mock.ts             mock AssemblyAI WS / /api/transcribe 响应
│   └── llm_mock.ts             mock DeepSeek/OpenRouter 流式响应
├── interview.spec.ts
├── meeting.spec.ts
├── translate.spec.ts
└── auth_flow.spec.ts
```

`playwright.config.ts` 关键项：
```ts
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:9320' },
  webServer: [
    { command: 'python -m uvicorn server.app:app --host 127.0.0.1 --port 9320', reuseExistingServer: true },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

### 4.2 为什么录音/麦克风是 E2E 的边界（必须 mock）

nod 的核心是「浏览器麦克风采音 → 云端转写」。**Playwright 无法模拟真实麦克风录音**，
所以 E2E 里测试「Start Listening」不靠真实说话，而是：
- **方案 A（推荐）**：在测试环境让后端 STT 走 mock fixture，E2E 只验证「点击 Start →
  状态栏变成 Listening → 前端进入监听态」这一层，**把真实的音频→转写→回答链路留给少量的集成/冒烟**（一次性）。
- **方案 B**：用 `<input type="file">` 注入一段固定 wav 作为「录音」，走测试后端 mock。

**决定：主路径（P0 冒烟）走 mock；真实 STT/LLM 只保留 1 个 nightly 冒烟（发布前跑，成本可控）。**

---

## 5. 计量/计费专项（P0，钱相关，必测）

这是 nod 商业化最核心、现有测试最薄弱的一块。务必新增 `tests/test_meter_billing.py`：

1. **原子累加**：两个会话并发 `consume_stt` 同一天，`UsageDay.stt_seconds` 必须是正确总和（当前代码用 SQL `+` 累加，测试要验证并发下不丢更新）。
2. **成本计算**：`_cost_stt`（分钟×单价）、`_cost_llm`（in/out tokens）数值正确。
3. **配额截断**：逐项测 `usage_snapshot.ok` 在每种配额耗尽时的 `reason` 正确。
4. **敏感降级**：订单取消/欠费 → plan 降级为 free。
5. **Stripe 幂等**：同一 webhook 事件重复投递，不重复加 plan/重复计费。
6. **checkout**：`/api/billing/checkout` 在未配置 Stripe 时 503，配置后正确创建 session。

用 mock 外部（stripe、httpx.AsyncClient）隔离，**不把真实 Stripe / key 放进测试**。

---

## 6. WebSocket 状态机专项（P0）

现有 `test_live.py` / `test_ask_busy.py` 已覆盖部分。补 `tests/test_ws_lifecycle.py`：

- `connect` → 发完整 question → 收到 `answer` 流（含 status 事件链：Transcribing→Checking→Generating→Answer ready）。
- busy 时二次 ask → 被拒（不叠加）。
- 断开 → 资源清理、计数正确。
- idle 超时 → 自动停止监听。

---

## 7. CI（GitHub Actions）

### 每次 push / PR（快，全 mock，无真实 key）

```yaml
name: CI
on: [push, pull_request]
jobs:
  backend:
    runs-on: ubuntu-latest
    env:
      # 用测试密钥，绝不上生产
      AUTH_SECRET: test-secret
      AUTH_DISABLED: "1"
      QUOTA_DISABLED: "1"
      ASSEMBLYAI_API_KEY: test
      DEEPSEEK_API_KEY: test
      DATA_DIR: /tmp/nod-data
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install -r requirements.txt
      - run: pytest -q
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd web && npm ci
      - run: cd web && npm run build && npm test   # 纯逻辑
      # 若加 Vitest: cd web && npx vitest run
  e2e:
    runs-on: ubuntu-latest
    env:
      AUTH_DISABLED: "1"
      ASSEMBLYAI_API_KEY: mock
      DEEPSEEK_API_KEY: mock
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install -r requirements.txt
      - run: cd web && npm ci && npm run build
      - run: npm ci && npx playwright install --with-deps chromium
      - run: npx playwright test
```

### 关键原则
- **CI 里任何真实 secret 都不要出现**（Stripe/Clerk/R2/Resend）。用 mock。
- **种子测试数据**在 `conftest.py` 里建（独立 test DB，用 `tmp_path` 或 `DATA_DIR` 指向临时目录），不污染生产 `data/nod.db`。

---

## 8. 成本与稳定性控制（避免 flaky）

nod 依赖大量外部 API，这是 flaky 的最大来源。原则：

- **普通 CI**：全 mock（ASM/LLM/Stripe/邮件/R2），每天可跑几百次，秒级完成，稳定。
- **集成冒烟**：只跑核心链路（发一段音频 → AssemblyAI → LLM → 回答），每天 1 次或发布前 1 次。
- **Healer / agentic 测试修复**：用 Playwright 的 Healer 时，**务必人工 review**——它可能把「页面变了」误判为「测试错了」，从而掩盖真实 bug。设置 human-review gate。

---

## 9. 建议的实施顺序（可执行，从今天能开始）

**第 1 天（P0 计量/计费）**：写 `tests/test_meter_billing.py`（原子累加 + 配额截断 + 计划降级）。
这是钱相关、现有最薄弱、也最容易用 pytest 一次性测透。

**第 2 天（P0 前端组件测试）**：给 web 加 Vitest + jsdom + testing-library，
把现有纯逻辑测试并进来，新增三个工作区的组件交互测试（切换、快捷键、状态栏文案）。

**第 3–4 天（P0 E2E Playwright 冒烟）**：pytest/mock 就绪后，建 `e2e/` 三个工作区 + 认证冒烟，
全走 mock，验证「点按钮 → 状态变化 → 显示结果」。

**第 5 天（CI）**：GitHub Actions 接上三步，每次 push 跑 pytest + vitest + e2e。

---

## 10. 总结：给 Cursor 的固定 AI QA Agent 指令

把这个粘到 Cursor 的 `.cursorrules` / AGENTS.md，以后每做完一个功能让 AI 自动测一遍：

```text
你是 nod-web 的 QA Agent。每完成一个功能改动：
1. 判断改动属于哪一层（server / web / e2e）。
2. 若是 server：在 tests/ 补对应 pytest；若有计费/计量/配额/Stripe 相关，必须一并测。
3. 若是 web：补 Vitest 组件测试；若涉及三个工作区交互，补 E2E 冒烟。
4. 运行 pytest && vitest，失败则分析：测试错 vs 代码 bug vs 环境/网络(flaky)。
   - 测试错 → 修测试。
   - 代码 bug → 修代码，不要为过测试而改逻辑。
   - flaky/网络 → 标 skip，不当作失败。
5. 绝不放真实 Stripe/Clerk/R2 key 进测试或 CI。
```
