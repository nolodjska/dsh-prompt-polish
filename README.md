# dsh-prompt-polish · 提示词优化

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的输入框插件：在模型选择器旁边加一个按钮，**用它当前会话同一个模型、同一份上下文**，就地把输入框里的草稿改写成一条更好的提示词；生成结束后按钮变成撤回键。

```
┌──────────────────────────────────────────────────────────┐
│  (输入卡片)                                               │
│                                                          │
│   deepseek-v4.1-flash  Default  ✦        (↑)             │
└──────────────────────────────────────────────────────────┘
                                   ↑ 点这里 = 优化提示词
```

## 效果

| 状态 | 按钮 | 输入框 |
| --- | --- | --- |
| 空闲 | ✦ 优化提示词（草稿为空时禁用） | 正常 |
| 生成中 | 转圈 spinner，禁用 | 整片骨架屏微光遮罩，高度跟随输入框，仍可继续打字 |
| 完成 | ↺ 撤回优化 | 已替换为改写结果 |
| 失败 | 旁边一行中文提示，6 秒后消失 | 原草稿原样保留 |

- 撤回是**精确还原**生成前的那段文字；如果生成后你自己改过，撤回按钮会自动失效，不会覆盖你的编辑。
- **切会话不打断润色**：请求发出后你可以直接切到别的会话，它在后台继续跑完；结果只会写回**发起它的那个会话**的草稿，切回来就能看到（在那之前别的会话的草稿一动不动，按钮也不会卡在「优化中」）。
- 同一个会话同一时刻只有一个在途请求：连点、切走再切回都不会重复发起或重复写入。
- 发起润色的会话若在完成前被关闭/删除，结果会被静默丢弃，不弹错、不影响其他会话。
- **只留提示词本身**：改写走「结构化信封」——要求模型把正文放在 `[[PROMPT_BEGIN]] … [[PROMPT_END]]` 里、把说明放进会被丢弃的 NOTES 块，Host 只提取标记之间的内容。所以「改写如下：」「更短的版本」「改动说明」这类尾巴在结构上就进不了输入框；模型不按格式答时还有 JSON / `<prompt>` / 元信息截断三级兜底。

## 上下文包含什么

改写请求带的是「当前会话此刻能看到的全部相关上下文」，全部只读，**而且三类都可以为空**：
会话刚建好、一条消息都没发过的第一条输入同样能优化，不会因为没有上文而变灰、跳过或报错。

1. **同一个模型路由** —— 优先用会话日志里最后一条请求记录的 `provider`/`model`；会话还没有任何请求记录时，依次退到「输入框旁当前选中的模型」和「部署默认模型」，思考档位一并沿用。只有三层都解析不出模型时才会提示失败。
2. **最近对话** —— 最近 6 条用户/助手消息（只取文本，单条 1500 字、合计 6000 字），用来消解「这个 / 它 / 上面那个」这类指代；一条都没有时这一段完全不会出现。
3. **输入框上挂的附件**：
   - 图片：**真的作为图片发给模型看**（模型路由支持图片输入时），同时给出名称与尺寸；
   - 文本类文件（`.md` `.txt` `.json` `.ts` `.py` `.log` …）：读前 8 KB 正文，合计最多 24 KB；
   - 其他文件（PDF、压缩包…）：只给名称与大小。
   - 每次都会附带一段「附件清单」，逐项写明模型**能否**看到内容，所以改写结果不会凭空编造附件里的东西。

改写系统提示词里明确写了：草稿可能完全没有上下文（会话的第一条消息），这种情况直接依据草稿本身改写，不许反问用户要背景。

改写在**独立的辅助调用**里完成：不写会话日志、不产生对话消息、不动你的附件，对你和模型的正式对话零影响。

## 安装

本插件是 DSH 的**本地 bundle**（`package.json` 里声明了 `dsh.bundle.patch`），不需要编译。

```bash
git clone https://github.com/nolodjska/dsh-prompt-polish.git
```

然后在 DSH 里把它装进当前 profile（把目录换成你的克隆路径）：

```
plugin_manager install_bundle  →  target: <克隆目录的绝对路径>
```

装好后**刷新页面**（Ctrl+R / Cmd+R）加载浏览器端 bundle。卸载：

```
plugin_manager remove_bundle   →  target: @local/prompt-polish
```

> `private: true` 是故意的：这是从目录安装的本地 bundle，不发布到 npm。

## 可调参数

| 位置 | 常量 | 默认 | 含义 |
| --- | --- | --- | --- |
| `optimize.js` | `MAX_DRAFT_CHARS` | 20000 | 草稿长度上限，超过直接拒绝并提示 |
| `optimize.js` | `CALL_TIMEOUT_MS` | 60000 | 单次改写总超时 |
| `optimize.js` | `CONTEXT_MAX_MESSAGES` / `CONTEXT_TOTAL_MAX_CHARS` | 6 / 6000 | 对话上下文摘要规模 |
| `optimize.js` | `FILE_EXCERPT_BYTES` / `FILE_EXCERPT_TOTAL_BYTES` | 8192 / 24576 | 附件文本读取上限 |
| `optimize.js` | `SYSTEM_PROMPT` | — | 改写规则（语言、约束保留、只输出正文…） |
| `client.js` | `TIMEOUT_MS` / `TIMEOUT_MS_WITH_IMAGES` | 90000 / 120000 | 浏览器侧等待上限 |
| `client.js` | `MAX_ATTACHMENTS` / `MAX_IMAGE_ENCODED_CHARS` | 8 / 8.4e6 | 单次随请求的附件规模上限 |
| `client.js` | `SKELETON_BAR_PITCH` / `SKELETON_MAX_BARS` | 24 / 40 | 骨架屏行距与最大行数 |

## 目录结构

```
index.js           Host：注册 POST /api/prompt-polish/optimize
optimize.js        Host：路由解析 + 上下文/附件采集 + 一次 llm 调用 + 输出净化
client.js          浏览器：按钮、骨架屏、撤回（window.__ModuleLoader__ 工厂）
package.json       bundle 清单（dsh.bundle.patch + dsh.client）
cordis.patch.yml   Loader 补丁，插入插件行
locale/*.json      插件管理页的标题与描述（中/英）
icon.svg           插件图标
docs/protocol.md   内部协议与实现说明（维护者向）
test/*.mjs         离线测试（见下）
```

## 测试

不需要 DSH 运行实例，不联网，纯 Node：

```bash
node test/run-all.mjs
```

| harness | 覆盖 |
| --- | --- |
| `client.smoke.mjs` | 模块加载、槽位注册、locale 词典、effect 数量 |
| `client.behaviour.mjs` | 四个 UI 状态、撤回、编辑失效、切会话不中断/结果回原会话、并发保护、原会话消失丢弃、首条消息 |
| `client.attachments.mjs` | 附件采集、上限、线格式、序列化失败降级、切会话仍带附件、dock 只读审计 |
| `client.geometry.mjs` | 骨架屏跟随编辑器矩形、bar 数随高度、量不到时回退 |
| `host.optimize.mjs` | 路由解析、上下文摘要、附件处理、结构化输出提取（信封/JSON/XML/降级）、元信息截断、全部失败分支、超时取消、零 append |

## 兼容性说明

插件用了三处 Harness **内部实现细节**（不是公开契约）：

1. `ConversationService.serializeDraftAttachments()` —— 读输入框附件字节；
2. `[data-composer-card]` / `[data-composer-overlay]` / `[data-composer-input]` —— 量骨架屏高度；
3. `PreparedLlmCall.inputModalities` —— 判断模型是否收图片。

宿主升级后如果这几处变了，插件会**降级而不是崩溃**：附件不进上下文 / 骨架屏退回按行数估算 / 图片只给名称尺寸。控制台会有一行带 `[prompt-polish]` 前缀的日志。

## License

MIT
