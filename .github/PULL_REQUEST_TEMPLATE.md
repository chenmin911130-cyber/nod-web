<!-- 实现者（Grok / Composer）填。每个 <...> 都要替换；留着 <...> 或删掉小节的 PR 不放行。规则见 docs/agents/ticket-template.md §5 和 AGENTS.md「实现者提交前自检」。 -->

## 单

Closes #<issue>。基线 `origin/main` = `<40 位 SHA>`（`git merge-base origin/main HEAD`）。

## 根因核对（§2）

<按 issue §2 逐条：文件:行 是否与基线一致；不一致的写在这里，并已在 issue 评论过>

## 改了什么（§3）

```
$ git diff --stat origin/main
<原样粘贴>
```

<若含 issue §3 未列的文件，逐个说明为什么必须改>

## 修复前失败（§4/§5，原样输出）

基线上只加新测试、不加修复：

```
$ <与 issue §5 完全相同的命令>
<原样粘贴：至少含失败断言行 + short test summary + 最后一行 N failed, M passed>
```

## 修复后通过（§5，原样输出）

```
$ <同一条命令>
<原样粘贴：最后一行含用例数>
```

## §5 其余命令

<issue §5 列的每条命令一段，命令 + 原样输出。动过 ios/**/*.swift、plugins/nod-*/ios/**、Podfile、pbxproj 的必须有 npm run check:ios>

## 单外发现

<按 §6：与本单同类但不在范围内的问题，一行一条，不并入本 PR；没有写「无」>
