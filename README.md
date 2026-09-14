# Nod Web

Nodpilot：浏览器 / iPhone / Watch 上的 AI Listening Assistant。麦克风采音，**AssemblyAI** 流式转写，**DeepSeek** 生成笔记、翻译和问答。顶栏是 **Listen** 和 **Translate**；Meeting / Lecture / Live Q&A 是 Listen 里的场景。

Copyright © 2026 Min Chen. All rights reserved. NODPILOT™ is a trademark of Min Chen. See [LICENSE](LICENSE).

用户文档见 **[产品说明书](docs/产品说明书.md)**。功能设计见 **[docs/nodpilot-product-design.html](docs/nodpilot-product-design.html)**。

网页听不到 Zoom / Teams 系统声。废弃的桌面 Nod Agent（`dsh web` / 3080）不要再开。

## 本地运行

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
cd web && npm install && npm run build && cd ..
.venv/bin/python -m uvicorn server.app:app --host 127.0.0.1 --port 9320
```

打开 http://127.0.0.1:9320

iOS App（Capacitor 套现有网页，Apple Watch 表麦录音）见 **[ios/README.md](ios/README.md)**。必须在 Mac 上封装：`npm run cap:ios`。

Android 调试包（前台网页麦，无手表）见 **[docs/android.md](docs/android.md)**：`npm run cap:android`。

开发热更新：先起后端 `9320`，再 `cd web && npm run dev`（Vite `5174`，会把 `/ws` `/api` 代理到后端）。

Key 读取顺序：环境变量 → Hermes `.env` → 本机 secrets。也可以在页面里填写。

## 快捷键

| 键 | 功能 |
|---|---|
| F2 | 手动录音 |
| F3 | 开始 / 停止听写 |
| F4 | 清空 |

允许浏览器使用麦克风后即可说话。转写走 AssemblyAI Universal 3.5 Pro。

## 部署

GitHub + Railway。生产服务 `nod-web` 跟 `main`。Volume 必须挂到 `/data`（录音和 SQLite 都写这里）；`DATA_DIR=/data`。

`AUTH_SECRET` 用环境变量，不要把 `auth_secret.key` 提交进仓库。已在跑的实例改这个值会让所有用户重新登录。本地没有该变量时，开发机才会在 `DATA_DIR` 里生成文件。

Railway 服务还需要：

- `DEEPSEEK_API_KEY` 或 `OPENROUTER_API_KEY`
- `ASSEMBLYAI_API_KEY`
- `AUTH_SECRET`（`python -c "import secrets; print(secrets.token_hex(32))"`）
