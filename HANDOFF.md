# HANDOFF — 可移植性改造交接

生成：2026-11-15 ｜ 基线提交：`9ffef69`（改造前）

这份文档记录一次完整的可移植性改造：**为什么改、改了什么、怎么验证、什么还没解决**。
给接手的人（或未来的自己）省掉重新调研的成本。

> 日常排查请看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)；契约与坑看 [CONTEXT.md](CONTEXT.md)。

---

## 一、这次改造解决了什么

改造前：插件只能在本机用。换机器或移动目录 → **点击通知毫无反应，且两个日志都不留痕迹**。

> 2026-11-17 补充：本文档之后又做了两轮全仓审计（见「九」），覆盖聚焦目标、
> endpoint 自愈与规范收敛——那些改动不在这里，在各 PR 的提交信息里。

改造后三个场景都通了：

| 场景 | 机制 | 验证方式 |
|---|---|---|
| 本机使用 | — | 真实点击 |
| 移动插件目录 | 重启时预热用新的 `$PSScriptRoot` 重注册 | 复制到新路径后跑注册脚本，注册表跟随 |
| 换新机器 | 首次通知前启动预热已建好协议键 | 删键 → 发审批 → 键自动创建 |

### 没解决的

**不打包成 MSIX，就至少存在 1 处绝对路径**（注册表 `command` 必须写死宿主可执行文件路径）。
这是 Windows 机制约束，不是实现缺陷：环境变量在 `command` 里不被展开（实测 + 全机 1540 个协议处理器零反例）。

现在的做法是把这个路径变成「安装时生成 + 每次启动校正」，让它在正常使用中不会错。

---

## 二、改了什么

### 阶段一（`11b7566`）：forward.vbs 自解析

**问题**：`forward.vbs` 硬编码了 launcher 的绝对路径。

**修法**：用 `WScript.ScriptFullName` 推导同目录的 `launcher.ps1`。

审核顺带发现并修掉 5 个缺陷：

| # | 缺陷 | 事实 |
|---|---|---|
| 1 | 盘根双反斜杠 | `GetParentFolderName` 对 `C:\a.vbs` 返回 `C:\`（带尾反斜杠），朴素拼接得到**16 字符**的 `C:\\launcher.ps1`（逐字符验证）。改用 `fso.BuildPath` |
| 2 | fso 创建失败 | COM 策略拦截时脚本静默死亡。现在记日志后退出 |
| 3 | 日志器依赖 fso | `If fso Is Nothing Then Exit Sub` —— 已知局限，见下 |
| 4 | `sh.Run` 失败无痕迹 | 最可能失败的一步原本最安静。已加错误捕获 + 日志 |
| 5 | 时间戳缺时分秒 | 原写成 `2026-11-12.000`，与 launcher.ps1 的 `yyyy-MM-dd HH:mm:ss.fff` 不齐 |

### 阶段二（`3e69b8f`）：协议注册统一

**问题**（这是最隐蔽的一个）：

```
dshnotify:// 的注册代码只内联在 notify.ps1 里
但审批通知走 notify-actions.ps1 —— 该文件零注册表写入
按钮默认开启，所以新机器上第一条通知通常是审批
→ 注册表键从未被创建 → 点「允许」什么都不会发生，且不留痕迹
```

**修法**：

- 新建 `lib/register-protocol.ps1`，作为唯一实现
- `notify.ps1` 与 `notify-actions.ps1` 都调用它
- `index.js` 的 `apply()` 里预热一次（`protocol-warmup` 日志事件）—— 因为两个发送器路径都可能被跳过（前台抑制、`openOnClick:false` 等）
- wscript 改用绝对路径 `%SystemRoot%\System32\wscript.exe`（裸名依赖 PATH 解析）

### 收尾（`754c144`、`11da768`）

- 新建 `TROUBLESHOOTING.md`
- 修正 `CONTEXT.md` 两处**错误结论**（见「三、被推翻的说法」）
- `forward.vbs` 日志加 `AsciiOnly()`：非 ASCII 路径降级为 `?`，避免与 launcher.ps1 的 UTF-8 混排乱码
- `test/channel.e2e.mjs`（从未被 `npm test` 收集）改造成 `test/channel.test.mjs`，5 个用例

---

## 三、被推翻的说法（别再照着旧结论改）

这次改造推翻了四条流传在注释/文档里的说法：

| 旧说法 | 实测事实 |
|---|---|
| 「VBScript 必须用 CRLF，否则 800A0401」 | **LF 完全正常**（WSH 把 CR/LF/CRLF 都当行终止符）。真正致命的是 **UTF-8 BOM**：exit 1、第 1 行 800A0401，`//B` 吞掉弹窗后表现为「点了没反应」。CRLF 只是仓库约定 |
| 「有两处硬编码」 | **只有一处**（`forward.vbs`）。注册表那处由 `$PSScriptRoot` 运行时生成，换机器自动正确 |
| 「移动目录后需触发一次通知才重注册」 | **重启就够**。预热在 `apply()` 里跑，用的是当前 `$PSScriptRoot` |
| 「上游插件在抢同一个 ProgID」 | 那个包在 `web` profile 里，桌面端加载的是 `desktop` profile，两者互不相干 |

---

## 四、两个 launcher.log（最容易误判的坑）

同一个 `launcher.ps1`，因运行时 `$env:TEMP` 不同，会写到两个地方：

```
C:\Users\<user>\AppData\Local\Temp\dsh-notify\launcher.log
    ← 协议处理器进程写的
    ← 真实点击痕迹在这里
    ← 特征：URL 带斜杠  dshnotify://open/?u=...

C:\Users\<user>\AppData\Local\DSH\temp\dsh-notify\launcher.log
    ← 从 DSH 沙箱手动调 launcher.ps1 时写的
    ← 只有测试痕迹
    ← 特征：URL 无斜杠  dshnotify://open?u=...
```

**原因**：`launcher.ps1:117` 用 `$env:TEMP`。协议处理器由 ShellExecute 启动、继承普通用户 TEMP；DSH 宿主把 TEMP 重定向到了私有目录。两者永远不同。

**代价**：本次会话因此误判了一轮 —— 看错了文件，以为点击没记录。

---

## 五、验证方式（这次真的能变红）

改造前的教训是「测试全绿，但抓不到 bug」。这次的验证有三层：

### 1. 单元测试先红后绿

```powershell
npm test    # 49 个，8 个文件
```

### 2. 反向验证（证明测试有效）

```powershell
# 把 forward.vbs 的 cmd 行改回硬编码 → 3 个测试必须变红
# 把 notify-actions.ps1 的注册调用删掉 → protocol-registration 必须变红
```

### 3. 严格 A/B 对照

在两个位置各放一个会写标记文件的假 launcher，看哪个被调用：

| 版本 | 新位置 launcher | 原位置 launcher |
|---|---|---|
| 修复版 | ✅ 被调用 | ❌ 未调用 |
| 旧硬编码版 | ❌ 未调用 | ✅ 被调用 |

**行为完全相反**，这是最硬的证据。

### 4. 端到端真实点击

```
审批：[decision] ok=True reason=applied
跳转：[jump] offered session-... -> True
```

---

## 六、代码结构

```
lib/
  index.js                宿主侧插件（事件监听、决策注册、通知调度）
  client.js               浏览器侧（轮询跳转队列、上报当前会话）
  register-protocol.ps1   ★ 协议注册唯一实现
  notify.ps1              普通通知
  notify-actions.ps1      带按钮的通知
  launcher.ps1            点击处理（544 行，零依赖，可放任意位置）
  forward.vbs             ★ 协议转发器（wscript 无控制台）
  decision-channel.mjs    回环 HTTP 服务
  decision-registry.mjs   token 生命周期
  focus-gate.mjs          前台探测
  foreground-probe.ps1    前台探测的 PowerShell 端
```

### 关键设计约束

`launcher.ps1` **零 `$PSScriptRoot` 依赖**（544 行里出现 0 次），只读 `%LOCALAPPDATA%\DSH\temp\dsh-notify\endpoint.json` 这一个绝对路径文件。

所以**只需要固定 `forward.vbs` 这一个薄壳**，不需要复制 544 行的 launcher。这是阶段二能把改动压到 48 行的原因。

---

## 七、已知局限

| 局限 | 影响 | 为什么接受 |
|---|---|---|
| `fso` 完全不可用时无日志 | COM 策略极端拦截时，`forward.vbs` 静默退出 | 日志器第二次 `CreateObject` 只会把同样的失败往下推一层。已在代码注释和 TROUBLESHOOTING 注明 |
| 不打包就 ≥1 处绝对路径 | 注册表 command 写死路径 | Windows 机制约束，见「一」 |
| `test/channel.e2e.mjs` 不在 `npm test` | 手动脚本 | 它用 `console.log` 无 `test()`；已另建 `channel.test.mjs` 覆盖同一路径 |

---

## 八、为什么这次没再改坏

这个插件在本次改造前被改坏过 3 次：

| 事故 | 原因 |
|---|---|
| 宿主进程崩溃 3 次 | 抽模块时漏改 6 处调用点，`node --check` 和单测都抓不到 |
| 点击通知不跳转 | 尝试 C# 提速，引入 XML/编码问题 |

**共同点：只验证一半就推进。**

这次的对策：

1. 每个阶段**先写测试并确认它会红**
2. 用**严格 A/B 对照**（两个位置各放假探针）
3. 改完必须跑**端到端真实点击**
4. 分阶段提交，每阶段独立可回退

旧历史保留在远端 tag `archive/0.9.x-broken`（指向 `2820020`，包含那个导致崩溃的 `f152864`）。

---

## 九、2026-11-17 两轮审计（可移植性改造之后）

交接本文档写完的第二天，对整个 fork（`f657d1f..HEAD`）做了一次两轴审查
（Standards 轴：代码规范；Spec 轴：实现与规格一致性），分两个 PR 收口：

### PR #3 —— Spec 轴：文档与测试镜像对齐实现

| 发现 | 处理 |
|---|---|
| CONTEXT.md 约束 1 仍写 app 级语义，但 dab50af 已改为会话级 park | 约束改写为三情形规则，注明改写来源 |
| `test/endpoint-selection.test.mjs` 镜像守护着错误契约（死端点保留 vs 实现跳过） | 镜像与实现对齐，死-only 断言 null |
| `test/session-gate.test.mjs` 镜像缺 `lastKnownSessionId` 兜底 | 补齐 + 3 个回归 |

审查本身的两条误报（教训）：「notify-actions.ps1 被整文件重写 274 行」实为
+16 行 + CRLF 噪声（`git show -w` 揭示）；「TROUBLESHOOTING 仍写 800A0401」
为子代理把 CONTEXT.md 的历史章节误当 TROUBLESHOOTING。**子代理没有完整 diff
时（TEMP 路径不同导致），其行号级指控必须逐条核实后再采信。**

### PR #4 —— Standards 轴：六条规范项

| 发现 | 处理 |
|---|---|
| ST-1 前台探测三份拷贝（最严重） | `foreground-probe.ps1` 成唯一实现，fail-open |
| ST-2 `Find()`/`FindByTitle()` 死代码 | 删除 |
| ST-3 stdout marker 无契约 | 契约注释 + `toast-marker-contract.test.mjs` 锁定 |
| ST-4 Step 标签与执行序矛盾 | 统一为执行序 1-4 |
| ST-5 verdict 字面量跨进程重复 | JS 侧 import `VERDICTS`；launcher 侧锚点+测试 |
| ST-6 八参 param 块重复 | **有意保留**（PS 5.1 无跨文件参数对象），注释 + 测试锁定顺序 |

### 审计后的测试基线

57 → 60 → **66 项，全部通过**。行为经真机点击路径实测无退化。

### 审计中最有价值的模式

ST-1（三份探测拷贝）与「漏改 6 处调用点」事故（见「八」）是同一形状：
**同一逻辑的多份拷贝**。今后改任何跨文件共享的逻辑，先 grep 有几份拷贝。

---

## 十、相关调研（仓库外）

`G:\DSH\notes\` 下有 20 份调研与审核文档，**不在这个仓库里**（发布时不会带上）。最重要的几份：

| 文件 | 内容 |
|---|---|
| `PORTABILITY-DECISION.md` | 方案对比与最终决策（含「明确不做什么」） |
| `review-risk-final.md` | 风险审核，4 项 P0（已全部完成） |
| `review-test-final.md` | 测试设计，8 个断言 + 变异矩阵 |
| `url-protocol-path-independence.md` | 6 种解耦方案 + 全机 320 键普查 |
| `toast-activation-research.md` | Windows 通知激活机制全测绘（官方文档引用） |

**如果要长期维护这个插件，建议把这几份的关键结论搬进仓库**，否则换一台机器就丢了。
