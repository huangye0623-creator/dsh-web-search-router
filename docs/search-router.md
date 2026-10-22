# 给 `web_search` 做多后端选路（Tavily ↔ 内置搜索）

> 中文 | [English](search-router.en.md)

> 目标：**该省的钱省，该好的质量好**。简单问题走免费/便宜的内置搜索，重要/最新/对比类问题走 Tavily，失败自动切换，并在结果里标出实际走了谁。

---

## 1. 背景：为什么需要“选路”

DSH 的联网搜索分三层：

```text
工具（web_search） → 服务（ctx.web，负责选提供方） → 提供方（真正发请求）
```

默认情况下，服务把搜索“钉”在某个提供方上。问题：

- 全走 Tavily：简单问题也花额度；
- 全走内置：复杂/最新问题质量不稳，且内置搜索可能是一次完整模型回合（更慢、更贵）；
- 多提供方同时注册而不钉住：**`WEB_PROVIDER_AMBIGUOUS`**（多个可用，不知道选谁）。

所以需要一个“**在提供方内部做路由**”的设计。

## 2. 设计：在外层钉住一个提供方，在内部做路由

```text
web_search(query)
   │
   ├─ 读手动模式（如有：tavily / builtin / auto）
   ├─ 给查询打分（重要性/时效性/对比/长度/报错/定义…）
   ├─ 按顺序尝试：
   │     首选 → 另一条（冷却中的排后面，但不会彻底禁用）
   ├─ 失败分类：429/额度/钥匙/超时 → 冷却 + 自动换另一条
   └─ 成功：结果 content 顶部加一行“搜索后端：…”，并写本地日志
```

关键点：

1. **外层仍只注册一个提供方 id**（例如 `tavily`），避免 `WEB_PROVIDER_AMBIGUOUS`；
2. 路由发生在提供方的 `search()` 内部：它可以**直接调用内置提供方的 `search()`**；
3. 失败要**分类**（限流/鉴权/额度/超时），不同类型给不同冷却时间；
4. 结果里必须**可见地标出走了谁**，否则调试时只能猜。

## 3. 打分规则（可调）

示例实现里，按查询词和当前用户原话给分：

| 信号 | 倾向 |
|---|---|
| 短查询、定义类（“是什么”） | 内置 |
| 报错/排查（含 error、exception、怎么解决） | 内置 |
| “最新/今天/本周/2026”、对比/全面/多来源 | Tavily |
| 长查询、复杂条件 | Tavily |
| 用户明确说“要官方来源/重要” | Tavily |

分数 ≥ 阈值 → Tavily；否则 → 内置。阈值可配置（调大=更省 Tavily 额度；调小=更多走 Tavily）。

## 4. 配置长什么样（profile 的 `cordis.patch.yml`）

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: tavily   # 外层钉住路由器自己
    fetchProvider: http

- id: web-search-router
  name: dsh-web-search-router
  config:
    apiKeyEnv: TAVILY_API_KEY
    keyless: true            # 允许无钥匙兜底（注意：静默降级）
    mode: auto               # auto / tavily / builtin
    fallback: true
    showMarker: true
    timeoutMs: 45000
    importanceThreshold: 2
```

> 注意：按 id 覆盖会**整段替换** `config`，所以 `fetchProvider` 等必须一起写。

## 5. 验证：不要只看“加载成功”

| 验证 | 做法 |
|---|---|
| 提供方是否注册 | 看插件自己的 load-trace / 日志 |
| 是否真的被选路 | 看结果顶部标记；或看本地搜索日志 |
| 失败降级是否生效 | 临时制造失败（无效 key / 断网）观察是否切到另一条 |
| 内置是否正常 | 用简单定义类问题，确认走内置且没报错 |

真实观测（作者环境，一天 32 次）：Tavily 23 / 内置 9，失败 0、降级 0；简单问题约 274 ms，复杂问题约 5.4 s（含总结）。

## 6. 踩过的坑

1. **预览版 API 变更**：外层选路字段从“公开属性”改成“配置项”，旧插件静默失效。→ 做能力探测 + 升级回归。
2. **`keyless: true` 是兜底不是优先**：钥匙失效时会悄悄降级为免费限速模式，**不会报错**。→ 别用“还能搜到”证明 key 有效。
3. **不钉住外层会歧义**：多个可用提供方同时注册时，必须显式指定。
4. **工具参数传不进提供方**：`web_search` 只带 `query`/`maxResults`，时间范围/站点过滤等只能做成静态配置，或另开 MCP 工具。
5. **内置搜索也烧钱**：有的内置搜索是一次模型回合（消耗 token），不是免费；选路前先确认成本模型。

## 7. 什么时候值得做

- 你同时在为“搜索质量”和“搜索额度”付钱；
- 你有多个后端（Tavily/Exa/Brave/免费 DDG/SearXNG）；
- 你能接受“同一问题偶尔换后端”的不确定性。

如果只用一个后端、额度充足，**不需要**选路——直接钉住即可。

## 8. 同类项目（选型参考）

- [Kerberos255/dsh-web-search-router](https://github.com/Kerberos255/dsh-web-search-router)：多 provider 优先级回退、冷却、宿主管钥匙（和本设计最接近）
- [gordan-code/dsh-search-ledger](https://github.com/gordan-code/dsh-search-ledger)：路由 + 钥匙管理 + 用量/成本账本
- [DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search)：免费 DuckDuckGo 提供方（可做第三层后备）
- [spences10/mcp-omnisearch](https://github.com/spences10/mcp-omnisearch)：MCP 聚合器（多引擎/提取），适合“加工具”而不是“换后端”

> 这些项目都很年轻；选之前先看最近更新、Issue 和是否适配你的 DSH 版本。

## 9. 本文示例

- 源码：`examples/web-search-router/`（`index.js`、`package.json`、`cordis.patch.yml`）
- 这是**参考实现**，不是 npm 包；请按你所用 DSH 版本的 API 适配。
