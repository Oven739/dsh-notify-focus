# Changelog

本仓库是 `dsh-notify-windows` 的本地 fork，包名改为 `dsh-notify-focus`。
上游：https://github.com/SeverusZh/dsh-notify-windows (MIT)

## 0.9.1

### 修复

- **宿主崩溃（严重）**：`0.9.0` 的 `f152864` 把会话判定抽到 `lib/session-gate.mjs` 时，
  删除了 `index.js` 里的本地 `isOnScreen`，但只更新了 2 处调用，**漏了 6 处**。
  `node --check` 抓不到（语法合法），单测也抓不到（测的是模块，没 import
  `index.js`）。只有在审批真正弹出时，`setTimeout` 回调里才抛
  `ReferenceError: isOnScreen is not defined` —— 未捕获异常直接杀死宿主进程，
  表现为「应用无法启动或已意外停止」而日志看起来一切正常。
  6 处调用已全部改为 `sessionGate.isOnScreen(...)`。

- **`spawn()` 同步异常会杀死宿主**：`sendToast` 里 `spawn(POWERSHELL, ...)` 只处理了
  `child.on("error")`（异步错误），而 `spawn` 本身可以**同步抛出**
  （受限策略下 EPERM、powershell 缺失时 ENOENT）。该调用位于定时器回调中，
  同步异常即成未捕获异常。现已包 try/catch：通知发不出去只是通知失败，
  不该让整个应用退出。

### 新增

- `test/smoke-index.test.mjs`：import **真实的** `lib/index.js` 并驱动审批路径。
  上面那个崩溃能复发的话，这个测试会失败，而不是等你下次点审批时炸掉宿主。

## 0.9.0

首个独立发布版本。在上游 0.8.1 基础上的全部改动：

### 新增

- **前台静默**：DSH 窗口在前台时不发通知。由 `lib/focus-gate.mjs` 每 5 秒采样判定，
  采样失败或过期时保守地认为“在前台”，不会误把提示藏起来。
- **会话级判定**：区分“DSH 在前台”和“这个会话正在被看”。浏览器半边每秒上报当前
  mainView 会话，宿主据此决定是否抑制。空上报视为“未知”并沿用上次有效值。
- **审批按钮**：用户不在电脑前时 park 水瀑，toast 带「允许一次 / 拒绝」，点击经回环
  通道直接结算审批，不必切回浏览器。
  宿主在前台时**从不 park**：同会话直接交给浏览器；别的会话则发一条不带按钮的
  toast，同时让审批卡照常到达浏览器（park 会让卡片消失，人却在电脑前）。
- **会话跳转**：点击通知不仅聚焦窗口，还会切到对应会话。由插件自带浏览器半边轮询
  宿主队列后调用 `ctx.uiWorkspace.openSession()`。
- **无控制台闪窗**：协议处理器由 `powershell.exe` 改为 `wscript.exe` + `forward.vbs`。

### 修复

- **`XmlElement.Name` 恒为空**：PowerShell 5.1 的 WinRT 投影下该属性返回空字符串，
  导致 `launch` 属性从未写入，提问通知点击毫无反应。改用 `TagName`。
- **协议 URL 被规范化**：Windows 把 `dshnotify://answer?t=x` 送达成
  `dshnotify://answer/?t=x`，解析需容忍可选斜杠且跳过 `?` 本身。
- **两个进程的 TEMP 不同**：宿主把 TEMP 重定向到私有目录，协议处理器用普通用户 TEMP。
  endpoint 查找必须同时考虑，且**只信任活着的端口**。
- **孤儿 endpoint 劫持**：`$env:TEMP\dsh-notify\endpoint.json` 是插件永不写入的路径，
  任何残留文件都会让每次点击连到死端口。已移除该候选。
- **审计事件早于水瀑约 30ms**：去重检查必须延迟后再做，否则同一审批发两条通知。
- **窗口形态被重置**：`ShowWindow(SW_RESTORE)` 无条件调用会把最大化窗口打回原尺寸。
  改为仅在 `IsIconic` / 不可见时调用。
- **跳转延迟**：先聚焦再入队会让页面轮询到空队列，隐藏窗口的定时器又被节流（实测最慢
  6183ms）。改为先入队再聚焦，并在获得焦点时连发三次轮询。

### 已知限制

- **无法跳转到具体对话**：DSH 前端不消费 `?session=` 参数。跳转由插件自己的浏览器半边
  实现，需要该半边被加载。
- **协议处理器会闪控制台约 250ms**：`powershell.exe` 是 WINDOWS_CUI 子系统，控制台由
  系统在进程启动阶段创建，`-WindowStyle Hidden` 只能缩短不能消除。已改用 wscript 规避。
- **审批被 park 时浏览器看不到卡片**：水瀑是串行的，park 即意味着下游收不到。
  只有用户不在看该会话时才会 park。
