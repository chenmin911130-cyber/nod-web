# Nod Web

网页版 Nod：浏览器麦克风采音，**AssemblyAI 云端流式转写**，DeepSeek / OpenRouter 流式回答。面试 / 会议 / 翻译三个工作区都保留。

完整用户文档见 **[产品说明书](docs/产品说明书.md)**（功能、快捷键、工作区、部署与常见问题）。

桌面版的置顶、隐身、系统扬声器抓取在浏览器里做不到，已去掉。其余快捷键、附件、导出打印都在。

## 本地运行

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
cd web && npm install && npm run build && cd ..
.venv\Scripts\python -m uvicorn server.app:app --host 127.0.0.1 --port 9320
```

打开 http://127.0.0.1:9320

iOS App（Capacitor 套现有网页，Apple Watch 表麦录音）见 **[ios/README.md](ios/README.md)**。需要 Mac + Xcode。

开发热更新：先起后端 `9320`，再 `cd web && npm run dev`（Vite `5174`，会把 `/ws` `/api` 代理到后端）。

Key 读取顺序：环境变量 → Hermes `.env` → `%APPDATA%\Nod\secrets.json`。也可以在页面里填写。

## 快捷键

| 键 | 功能 |
|---|---|
| F2 | 手动录音 |
| F3 | 自动监听 |
| F4 | 清空 |

允许浏览器使用麦克风后即可说话。转写走 AssemblyAI Universal 3.5 Pro。

## 部署

GitHub + Railway。Railway 服务需要环境变量：

- `DEEPSEEK_API_KEY` 或 `OPENROUTER_API_KEY`
- `ASSEMBLYAI_API_KEY`
