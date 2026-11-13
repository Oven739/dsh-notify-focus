# 排查入口 TROUBLESHOOTING

出问题时先看这一页。它只回答三件事：**看哪个日志、对应哪段代码、谁改的**。
设计理由和调研过程不在仓库内（指向 `G:\\DSH\\notes\\`），仓库内只留结论。

---

## 一、症状 → 日志 → 代码

| 症状 | 先看 | 再看 |
|---|---|---|
| 点击通知**完全无反应** | `%TEMP%\\dsh-notify\\launcher.log`<br>（若为空，见下方「静默失败」） | `lib\\forward.vbs`、注册表 |
| 通知**不弹出** | `%LOCALAPPDATA%\\DSH\\temp\\dsh-notify\\notify.log`<br>搜 `skipped-foreground` / `toast-actionable` | `lib\\notify.ps1`、`lib\\notify-actions.ps1` |
| 通知弹出但**点按钮没反应** | `notify.log` 搜 `decision` / `approval-parked` | `lib\\launcher.ps1`、`lib\\decision-channel.mjs` |
| 点击后**窗口来了但会话没切换** | `notify.log` 搜 `jump-*` | `lib\\index.js`、`lib\\client.js` |
| 插件**没加载**（无通知、无日志） | DSH 宿主日志 | `package.json`、profile 的 `cordis.patch.yml` |

### 日志位置（两条不同的 TEMP）

```
%LOCALAPPDATA%\\DSH\\temp\\dsh-notify\\notify.log      通知发送侧（插件写）
%LOCALAPPDATA%\\DSH\\temp\\dsh-notify\\launcher.log    点击处理侧（launcher.ps1 写）
%TEMP%\\dsh-notify\\launcher.log                       协议处理器视角的 TEMP（可能不同！）
```

> **两个 TEMP 是已知陷阱**：宿主与协议处理器看到的 `%TEMP%` 可能不同。
> 搜不到日志时用 `Get-ChildItem $env:LOCALAPPDATA -Filter launcher.log -Recurse`。

---

## 二、「静默失败」专项

这个插件历史上最难的故障都是**静默的**：点了没反应，但两个日志都不留痕迹。
原因是整条链在 `wscript //B` 下运行，错误对话框被吞掉。

### 判断链条断在哪一环

```powershell
# 1. 协议处理器存在吗
Get-ItemProperty 'HKCU:\\Software\\Classes\\dshnotify\\shell\\open\\command' | Select -ExpandProperty '(default)'

# 2. 它指向的 vbs 存在吗（路径从上面命令里抄）
Test-Path '<上一步输出的路径>'

# 3. 手动触发一次，看 launcher.log 是否增长
$log = "$env:LOCALAPPDATA\\DSH\\temp\\dsh-notify\\launcher.log"
(Get-Item $log).Length
& wscript.exe '<vbs 路径>' 'dshnotify://open?u=http://127.0.0.1:9999/'
Start-Sleep 3
(Get-Item $log).Length
```

三步各自对应不同断点：

| 第几步失败 | 断点 | 修法 |
|---|---|---|
| 1 | 注册表键不存在 | 跑 `lib\register-protocol.ps1` |
| 2 | vbs 路径不存在（插件被移动/换机器） | 重跑 `register-protocol.ps1` |
| 3 | vbs 跑了但找不 launcher | 看 `forward.vbs` 的 `LogFail` 输出 |

---

## 三、改动留痕

### 可移植性两个阶段（2026-11-12/13）

| 提交 | 修了什么 | 为什么这么改 |
|---|---|---|
| `11b7566` | `forward.vbs` 用 `ScriptFullName` 推导 launcher | 硬编码路径换机器/移目录就失效，且失败静默 |
| `3e69b8f` | 协议注册抽成 `register-protocol.ps1`，三个调用点 | **审批通知走 notify-actions.ps1，它原本零注册表写入** |

**这两个提交的说明写清了完整理由，改代码前先 `git show <hash>` 读一遍。**

### 关键结论（不在代码里，只在提交信息里，容易丢）

1. **不打包成 MSIX，就至少 1 处绝对路径。** Windows 协议处理器不支持环境变量（实测 + 全机 1540 个处理器零反例）。
2. **不能像 ZCode 那样用 Electron `Notification`**：DSH 桌面端无内建通知能力（4.94MB 运行时里 `new Notification` 零命中），插件也拿不到 Electron。
3. **`notify-actions.ps1` 必须自己注册协议**：审批按钮默认开启，新机器上第一条通知就是审批。
4. **注册表的 `wscript.exe` 用绝对路径**：裸名靠 PATH 解析，多一个失败点。

---

## 四、验证命令

```powershell
cd G:\\DSH\\dsh-notify-focus

# 全部测试（44 个）
npm test

# 只跑可移植性相关
node --test test/forward-vbs-portability.test.mjs
node --test test/protocol-registration.test.mjs
```

> **注意**：`npm test` 的 glob 是 `test/*.test.mjs`，
> 所以 `test/channel.e2e.mjs`（后缀不是 `.test.mjs`）**从来没被跑过**。

### 反向验证（确认测试有效）

```powershell
# 把 forward.vbs 改回硬编码，测试应该变红（3 个失败）
# 把 notify-actions.ps1 的注册调用删掉，protocol-registration 应该变红
```

---

## 五、完整调研在哪

仓库外，`G:\\DSH\\notes\\`：

| 文件 | 内容 |
|---|---|
| `PORTABILITY-DECISION.md` | 最终决策（方案对比 + 不做什么） |
| `REVIEW-SYNTHESIS.md` | 三份审核汇总 |
| `url-protocol-path-independence.md` | 6 种解耦方案 + 全机 320 键普查 |
| `toast-activation-research.md` | Windows 通知激活机制全测绘（官方文档） |
| `auto-repair-claim-verification.md` | 「发一次通知就自愈」的证伪 |
| `review-vbs-static.md` | 技术审核（三处必须修） |
| `review-risk-final.md` | 风险审核（4 项 P0） |
| `review-test-final.md` | 测试设计（8 个断言） |

---

## 六、已知未做

| 项 | 影响 |
|---|---|
| `CONTEXT.md` 部分章节描述旧实现 | 已更新注册相关段落，其余待补 |
| `test/channel.e2e.mjs` 不在 `npm test` 里 | e2e 覆盖是空的 |
| 插件目录被移动后，需触发一次通知才会重注册 | 启动预热只覆盖「新装」，不覆盖「移动」 |