---
name: self-improve
description: >-
  Records agent misses and forces the next session to read them before touching
  the same area. Use at the start of Watch / listen / Translate / phone-sync
  work; when the user says 还是不行, 浪费时间, Hermes修好了, 总结自己的问题, or 提升自己;
  and immediately after a user-confirmed miss or a Hermes diagnosis you missed.
---

# Self-improve

像 Hermes：错一次就写下来，下次先读再动手。`no-regression` 管共享状态；本 skill 管**自己错过的因果**。

## Before you edit

1. Read [errors.md](errors.md)（只读和本次相关的条目）。
2. 若条目写着「先读状态再改」，先核对实际发出去的 `run` / `listening` / `paused` / `mode`，不要先加闩锁。
3. 一条产品行为只改一层。界面、同步、录音不要同一轮一起翻。

## After a miss (must write)

用户说还是不行、Hermes 指出你漏的根因、或你承认误诊时，**立刻**在 `errors.md` 顶部追加一条，不要等用户再提醒：

```markdown
## YYYY-MM-DD · 短标题
- 我以为：
- 实际：
- 规则：一句话，下次禁止再犯
- 涉及：文件或状态名
```

只记**已证实**的错。不要把猜测写成条目。同一根因不重复，改旧条。

## Done means

- 相关错误条目已读
- 若本次有新的证实失误，errors.md 已更新
- 没有用新的同步层去盖住旧误诊
