# dsh-compaction-counter

在 DSH 输入框右下角的**上下文占用指示器**（那个圆环 + 百分比）右侧，显示**本会话上下文压缩（compaction）触发次数**。

```
…  12%   压缩 3 次
    ↑        ↑
 上下文占用   本插件
```

鼠标悬停可看到明细：成功 / 失败 / 手动 `/compact` 次数、最近一次触发时间、上次压缩覆盖的 token 数、上次失败原因。

## 计数口径

宿主侧注册了一个只读的 `compactionStats` 会话投影（session projection）。它把**实时事件折叠**和**启动时的日志补扫**合并起来，因此：

- **插件安装前就已经压缩过的旧会话也能显示真实次数**，不需要新开对话；插件启动后会在后台只读扫描 `$DSH_HOME/sessions` 下已有会话的完整日志（`sessionQuery.readSession`，由 DSH 处理多帧 zstd 格式），之后只重扫大小/修改时间变化的日志；
- 翻页加载更早历史、刷新页面、重新打开会话后数字不变；
- 统计的是 `compaction/start` 事件，也就是“压缩被触发”的次数（自动压缩和手动 `/compact` 都算）；
- 截图里 DSH 的“上下文已压缩”那种整段摘要压缩才计数；`compaction/prune`（单条超大工具结果的裁剪）只作为内部计数，不混入显示；
- 失败也会计入“触发”，失败次数单独统计并在悬停提示里展示；
- **按会话计数**：切换会话后显示的是该会话自己的次数；fork 出来的新会话从 0 开始。

| 字段 | 含义 |
|---|---|
| `count` | 触发次数（`compaction/start`） |
| `completed` | 成功结束的次数 |
| `failed` | 以错误结束的次数 |
| `manual` | 由手动 `/compact` 触发的次数 |
| `lastAt` | 最近一次触发时间（epoch ms） |
| `lastTokens` | 最近一次摘要压缩覆盖的 token 数 |
| `lastError` | 最近一次失败原因（截断到 300 字符） |

## 安装

### 方式 A：DSH 界面（推荐）

1. 打开侧边栏 **Plugins**；
2. **Add plugin** → 选择本地目录，填入本目录的绝对路径；或直接填 Git 地址：
   `https://github.com/Tech-yon/DSH_context_ziptimes_show`
3. 安装完成后点 **Enable now**（或在该 bundle 的卡片上打开开关）。

### 方式 B：命令行

```powershell
dsh plugin --profile desktop add link:"<本插件目录的绝对路径>"
```

> `desktop` profile 在 Electron 桌面端由应用自身管理，命令行安装会被拒绝；请优先用界面安装，或按下面“手动挂载”写入 profile。

### 方式 C：手动挂载（当前桌面端采用的方法）

1. 把本目录链接进 profile 的 `node_modules`：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-compaction-counter" `
     -Target "<本插件目录的绝对路径>"
   ```

2. 编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在文件末尾追加：

   ```yaml
   - insert:
       - id: compaction-counter
         name: dsh-compaction-counter
   ```

带 HMR 的 profile 会自动重组并加载；没有 HMR 时重启 DSH。

> 注意：方式 C 与方式 A/B 不要同时使用。如果以后用 Plugins 页面安装同一个包，先删掉 `cordis.patch.yml` 里的手动 `- insert:` 行，否则同一个 `id: compaction-counter` 会被挂载两次。

### 验证

- 宿主半通过配置热重组加载后，`session_projcache` 中会出现 `compactionStats`（`ver: 3`、`warm: 1`、`seenRev` 追平补扫 revision）；
- 补扫在本机 42 个会话日志上验证通过，能读出历史压缩次数（例如某会话 3 次、另一个会话 19 次）；
- `tools/selftest.mjs` 覆盖宿主折叠、补扫合并、schema、客户端 bundle 注册、locale 与组件渲染。

### 看到效果

计数位于输入框下方、上下文占用圆环/百分比的右侧。打开普通对话视图（不是“对话轨迹”视图）后即可看到。

插件刚加载时会在后台补扫已有会话日志（通常几秒到十几秒，取决于日志总量），补扫完成后旧会话就有历史计数。如果某个**已经打开**的会话仍显示 0，按一次 `Ctrl+R` 刷新页面，或切走再切回该会话；刷新后的 tail page 会带上补扫后的 `compactionStats`。新发生的压缩仍由实时事件折叠计数，不依赖补扫。

## 卸载

- 手动安装：从 `cordis.patch.yml` 删掉 `id: compaction-counter` 的 `- insert:` 行，并删除 `node_modules\dsh-compaction-counter` 链接；
- 界面安装：在 Plugins 里关闭/卸载该 bundle。

## 实现

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半：注册 `compactionStats` 投影；实时折叠压缩事件，并用 `sessionQuery.readSession` 后台补扫历史日志 |
| `lib/client.js` | 浏览器半：注册 `conversation.composer.dock` 条目（`order: 2`，CSS `order: 1` 使其排在 ContextMeter 右侧） |
| `cordis.patch.yml` | bundle 挂载声明 |

为什么用 `CSS order`：`conversation.composer.dock` 的渲染顺序是“插槽条目 → 内置 ContextMeter”，插槽条目天然在指示器左边；给条目自己的根元素设置 `order: 1` 后，它作为子项排到 `order: 0` 的 ContextMeter 之后，即右侧。插槽出口的 anchor 都是 `display: contents`，不会额外包一层盒子。

宿主半的两个“补帧”字段：

- `warm`：注册后的第一条无关会话事件把它从 0 翻到 1，发布一次带 `compactionStats` 的变更帧，让安装前已打开的页面也拿到这个键；
- `seenRev`：补扫表有一个单调 revision；补扫完成后，下一次会话事件会让 live cell 跟上 revision 并重发一次视图，把历史计数推到已打开的页面。

补扫计数和实时折叠都从日志起点计数，所以 wire view 用 `max(live, backfill)` 合并：既不会重复计数，也不会少于完整日志的计数。

## 排错

| 现象 | 处理 |
|---|---|
| 输入框右下角没有“压缩 N 次” | 确认在普通对话视图（不是“对话轨迹”）；按 `Ctrl+R` 刷新页面一次 |
| 插件列表里看不到 | 这是通过 `cordis.patch.yml` 手动挂载的，不会出现在 Plugins 的已安装列表；卸载见上文 |
| 宿主报 `session projection ... already registered` | `cordis.patch.yml` 里重复了 `id: compaction-counter`，或同时又通过 bundle 安装了一次 |
| 有压缩记录的旧会话仍显示 0 | 等后台补扫完成（几秒到十几秒），然后刷新页面或切走再切回该会话；仍为 0 时确认该会话日志里确实有 `compaction/start` |
| 当前会话一直是 0 | 当前会话确实还没触发过压缩；打开有压缩记录的会话即可看到历史计数 |

## 开发自测

```powershell
$env:ELECTRON_RUN_AS_NODE=1
& "<DSH 安装目录>\DeepSeek Harness.exe" --expose-internals .\tools\selftest.mjs .\tools\selftest-result.json
& "<DSH 安装目录>\DeepSeek Harness.exe" --expose-internals .\tools\fold-real-log.mjs <session.jsonl> .\tools\fold-real-log-result.json
```

`tools/selftest.mjs` 覆盖宿主折叠、schemas、客户端 bundle 注册、locale、组件渲染；`tools/fold-real-log.mjs` 用真实会话日志校验折叠结果与直接计数一致。

## 兼容性

- DSH `0.2.1-rc.3`（`dsh-manifestVersion: 1`、`dsh.client.platform: "web"`）；
- 不引入额外运行时依赖；宿主半使用 Cordis 服务 `sessionProjections`（必需）和 `sessionQuery`（可选，用于补扫历史日志）；
- 客户端入口是手写的 `window.__ModuleLoader__` bundle，只 `require("react")`。

## License

AGPL-3.0-only. See [LICENSE](LICENSE).