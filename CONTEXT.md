# CONTEXT — dsh-notify-focus

本地 fork 的领域词汇与硬性约束。**改代码前先读这一页**，尤其是「瀑布是串行的」那一条。

> 上游：`dsh-notify-windows` 0.8.1（SeverusZh）
> 本 fork 新增：宿主在前台时静默（参照 ZCode 桌面端）+ 审批/提问 toast 按钮
> 调研依据：`notes/dsh-approval-submission-path.md`

## 术语

| 词 | 含义 | 不是什么 |
|---|---|---|
| **waterfall**（瀑布） | Cordis 的串行事件。监听者依次拿到 `(request, next)`，返回结论即终止，调用 `next()` 才交给下一个 | 不是广播；不是并发 |
| **park** | 本插件持有 waterfall 不调 `next()`，把 Promise 挂在内存里等用户点按钮 | 不是「排队」 |
| **next()** | 把决定权交还给下游（浏览器） | 不是「拒绝」 |
| **token** | 本插件为一次具体 park 生成的一次性随机串，toast 按钮携带它回来 | 不是 `eventId`，也不是 `ApprovalRequestId` |
| **eventId** | DSH gateway 铸造、用于 `POST /api/$events/result` 关联的 id | 不对外可见，本插件不用 |
| **ApprovalRequestId** | 审计 id，只进 session log | 不能用来提交决定 |
| **回环通道**（decision channel） | 插件内的 `127.0.0.1` 随机端口 HTTP 服务，launcher 向它 post 决定 | 不是 DSH 的 API |

## 硬性约束

### 1. 瀑布是串行的 —— park 就等于让浏览器收不到

```
ApprovalService.request
  -> ctx.waterfall("approval/request", req, next)
      -> [本插件监听器]   <- 在这里 park，浏览器就永远收不到
      -> [api-remotes]    <- 转成 Remote Event，浏览器才看到审批卡
```

**推论**：只有当用户**不在电脑前**（宿主不在前台）时才 park。宿主在前台时必须直接 `next()`，让浏览器照常弹卡。否则用户会既看不到审批卡，又只有一个未必注意到的 toast——比原来更糟。

这条约束由 `skipWhenHostFocused` 与监听器共同实现，两者不能各自为政。

### 2. 只有 `approval/request` 和 `user-questions/request` 是 waterfall

转发的白名单里其余全是 `mode: "emit"`（`api-remotes/lib/types/remote-events.d.ts`）。只有这两个能 park。

### 3. `userQuestions/answer` RPC 只对「已 continued」的提问有效

`user-questions/lib/index.js:552-555` 的 `answer()` 第一步就 `continued(agent).find(...)`，找不到直接 `return false`。
**活着等待回答的提问（state=`open`）走不了这个 RPC**，只能回填 waterfall。

### 4. token 必须一一对应

frame 里没有 audit id，同时挂起多条审批时无法事后匹配。因此 token 只能由**发 toast 的这一方**生成并持有映射——这正是本插件内部 park 而非外部提交的理由。

### 5. 每个决定只能落一次

先到先得：浏览器先答，我们收到 cancel，必须清掉对应 token；我们先答，浏览器的卡会被撤。两条路径都要接受「自己这方已经失效」是正常结果，不是错误。

## 通道与值域

| 场景 | 事件 | 结论值 |
|---|---|---|
| 审批 | `approval/request` | `allowed-once` / `rejected` |
| 提问（活着） | `user-questions/request` | 结构化 answer batch |

## 协议形状

```
dshnotify://answer?t=<token>&v=allow|reject   -> POST 回环通道 -> 插件 resolve
dshnotify://open?u=<encoded-url>              -> 聚焦/打开 DSH 窗口
```

answer 失败（token 过期、宿主已退）必须**降级为 open**，不能让点击变成无反应。

## 平台限制与已踩的坑（2026-10-24 实测）

### 无法跳转到具体对话

前端**不读取** `?session=` 参数：在运行中的 `app.asar` 里 grep `get('session')` 零命中，只有 `sessionId`（文件上传专用）。

因此 toast 点击的极限是**把 DSH 窗口拉到前台**，会话停留在你当时打开的那个。要真正跳转需要改 DSH 前端（或写客户端插件），不是本插件能补的。

### `XmlElement.Name` 在 PowerShell 5.1 下是空的

`GetTemplateContent()` 返回的元素，`.Name` 为空字符串，标签名在 `.TagName` 上。

`if ($root.Name -eq "toast")` 因此**永远为 false**，导致 `SetAttribute` 从未执行——提问通知从来没有 `launch` 属性，点击毫无反应。这是上游自带的 bug。

### Windows 会把协议 URL 规范化

`dshnotify://answer?t=x` 到达处理器时是 `dshnotify://answer/?t=x`，多一个斜杠。正则必须写 `^answer/?\?`。

另：取 query 时要跳过 `?` 本身（`IndexOf("?") + 1`），否则第一个 key 是 `?t` 而不是 `t`。

### 两个进程看到不同的 TEMP

DSH 宿主把 `TEMP` 重定向到私有目录（`%LOCALAPPDATA%\DSH\temp\dsh-<id>\`），而协议处理器由系统 shell 启动，用普通用户 TEMP。

endpoint 文件查找**必须同时尝试两个位置**，否则按钮点击永远报 `no endpoint file`。

### 事件顺序：审计早于水瀑

`approval/asked`（审计）比 `approval/request`（水瀑）**早约 30ms**。

所以「水瀑是否已发过 toast」的检查必须在延迟后再做（`approvalDedupeDelayMs`，默认 400ms），否则永远返回 false，同一审批会发两条通知。

### CDP 探测是纯亏损

三个端口 × 1 秒超时 ≈ 3.1 秒，而桌面应用不开调试端口，永远失败。现已改为 `DSH_NOTIFY_CDP=1` 才启用；默认关闭后 open 路径从 7.9 秒降到 1.4 秒。


## 客户端插件（形态二：跳转会话）

### 页面运行在 `dsh-app://` 下，不是 http

客户端 `fetch` **必须用不带前导斜杠的相对路径**：

```js
fetch("api/dsh-notify/jump/pending")    // 对
fetch("/api/dsh-notify/jump/pending")   // 错：解析成 dsh-app://app/api/... → 400
```

官方插件都这么写（task-board 的 `CLIENT_API_PREFIX = TASK_BOARD_API_PREFIX.slice(1)`，即主动去掉前导斜杠）。这个 400 发生在 handler 之前，日志里什么都看不到，只能从浏览器 Network 面板发现。

### 宿主路由用 `ctx.webServer.register`，不是 `connection.fetch.register`

```js
ctx.webServer.register({
  kind: "exact",
  path: "/api/...",
  handler: async (req, res) => { /* 原生 Node req/res */ },
})
```

需要 `export const inject = ["connection", "webServer"]`。所有官方 HTTP 路由插件（open-in-app、client-hmr、client-modules）用的都是这个。

### 认证分两侧，各用各的凭据

| 方向 | 通道 | 凭据 |
|---|---|---|
| launcher → 宿主 | 回环端口 `POST /jump` | `x-dsh-notify-secret` |
| 浏览器 → 宿主 | 同源 GET | 页面 cookie（自动携带） |

外部进程**没有**浏览器 cookie，直接 POST 同源路由会得到 401。这是两条通道分开的原因。

### openSession 的约束

- 签名 `(target: SessionTarget): void`，同步，无返回
- 未知 id **同步抛错**（`sessions.retain: unknown session`），调用方必须 try/catch
- 跨 workspace 可用，但**不会自动切 workspace**
- 副作用：收起右侧面板

### 客户端插件声明

```json
"exports": { "./client": "./lib/client.js" },
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-workspace"] } }
```

两个 inject 不同义：
- `dsh.client.inject` → **包名**数组
- `export const inject` → **服务名**数组（`["uiWorkspace"]`）

### HMR

改 `lib/client.js` **保存即热替换**（宿主 500ms stat，SSE 推送，重新执行 apply）。
但改 `package.json` / `cordis.patch.yml` **必须重启**——插件发现只在启动时扫描。

### 协议处理器：用 wscript 而非 powershell（闪窗已消除）

**根因**：`powershell.exe` 的 PE 子系统是 `WINDOWS_CUI`（subsystem=3），控制台窗口由 OS 在进程启动阶段创建，**进程自己的参数管不到它**。`-WindowStyle Hidden` 不是无效，而是只能从 1395ms 压到约 247ms，压不到 0。

**解法**：协议处理器改指 `wscript.exe`。

```
"C:\Windows\System32\wscript.exe" //B //Nologo "<安装目录>\lib\forward.vbs" "%1"
```

- **wscript 用绝对路径**：裸 `wscript.exe` 靠 PATH 解析，多一个失败点
- **vbs 路径由 `register-protocol.ps1` 在运行时按 `$PSScriptRoot` 生成**，不是写死的

- `wscript.exe` 是 `WINDOWS_GUI` 子系统，**自身没有控制台**
- `forward.vbs` 用 `sh.Run(cmd, 0, False)` 启动 launcher，`0` = `SW_HIDE`，通过 `CreateProcess` 的 `STARTF_USESHOWWINDOW` 生效
- 父进程无控制台 + 显式 SW_HIDE ⇒ **子进程控制台创建时即隐藏**，无「先显示后隐藏」的窗口期
- `//B` 不可省：否则脚本错误会弹**模态对话框**，比闪窗更糟

**实测**：改动后点击通知与审批按钮，控制台窗口**完全不出现**。

### 坑：notify.ps1 会覆盖协议注册

上游代码每次发通知都执行：

```powershell
$command = '"powershell.exe" ... -File "launcher.ps1" "%1"'
Set-Item -Path $cmdKey -Value $command -Force    # 无条件覆盖
```

这是「自愈」逻辑，但它**会把任何手动修改静默改回 powershell**。第一次改注册表后仍然闪窗，就是因为下一次发通知又改回去了。

本 fork 已把注册抽成 `lib/register-protocol.ps1`，**三个调用点**都用它：

| 调用点 | 何时 |
|---|---|
| `notify.ps1` | 带 URL 且非前台抑制的普通通知 |
| `notify-actions.ps1` | 审批按钮通知（**它原本零注册表写入，这是新机器上最常撞的坑**） |
| `index.js` 的 `apply()` | 启动预热，确保第一条通知之前键就已存在 |

前两条都可能被跳过（前台抑制、`openOnClick:false` 等），所以启动预热是必要的补充。

### VBScript 的编码：BOM 致命，换行不是

**实测修正**（2026-11-12，三份独立审核之一）：LF 换行**不会**导致 `800A0401`——WSH 把 CR/LF/CRLF 都当行终止符。CRLF 是仓库约定（`.gitattributes` 强制），不是语法要求。

**真正致命的是 UTF-8 BOM**：

```
UTF-8 无 BOM  → 正常（按 ANSI 解码，纯 ASCII 内容无影响）
UTF-8 带 BOM  → exit 1，第 1 行 800A0401（BOM 三个字节被当成可见字符）
UTF-16LE+BOM  → 正常
```

`//B` 会吞掉错误对话框，所以 BOM 问题的表现是「点击彻底无反应」。

**验证**：

```powershell
$b = [System.IO.File]::ReadAllBytes($p)
($b[0..2] | ForEach-Object { $_.ToString('x2') }) -join ' '   # 不能是 "ef bb bf"
($b | Where-Object { $_ -gt 127 }).Count                       # 应为 0（纯 ASCII）
```

### 窗口类名用前缀匹配

Electron 的窗口类是 `Chrome_WidgetWin_0` 或 `_1`，取决于角色与状态。硬编码 `_1` 会漏掉有效主窗口，现已改为前缀 `Chrome_WidgetWin_`。

