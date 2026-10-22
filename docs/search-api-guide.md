# 搜索 API 使用指南（Tavily + MCP）

> 中文 | [English](search-api-guide.en.md)

> 一份“搜索 API 怎么用”的实战笔记：**search / extract / crawl / map / research 分别怎么用、什么时候用、花多少钱、怎么接 MCP**。
> 非官方 · 示例不含任何 Key · 文档 CC BY 4.0

---

## 1. Search API 基础：参数、答案、成本与查询写法

> 以 Tavily Search API 为例（其他搜索 API 概念相近）。端点与参数以官方文档为准：<https://docs.tavily.com/documentation/api-reference/endpoint/search>

## 1. 一次搜索长什么样

```bash
curl -s https://api.tavily.com/search \
  -H "Authorization: Bearer $TAVILY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "DeepSeek Harness 0.2.1 release notes",
    "max_results": 5,
    "search_depth": "advanced",
    "include_answer": true
  }'
```

返回核心字段：

| 字段 | 含义 |
|---|---|
| `answer` | 可选：综合答案（开了 `include_answer` 才有） |
| `results[]` | 来源列表：`url` / `title` / `content`（片段） / `score` / `published_date` |
| `response_time` | 耗时 |
| `request_id` | 排障用 |

## 2. 最常用参数

| 参数 | 取值 | 什么时候用 |
|---|---|---|
| `query` | 字符串 | 必填；写法见第 5 节 |
| `max_results` | 1~20 | 省 token 就 3~5 |
| `search_depth` | `basic` / `advanced` / `fast` / `ultra-fast` | 要快用 fast；要全用 advanced（更贵） |
| `topic` | `general` / `news` | 明确要新闻 |
| `time_range` | `day` / `week` / `month` / `year` | “最近一周” |
| `start_date` / `end_date` | `YYYY-MM-DD` | 精确区间 |
| `include_answer` | `true` / `false` / `basic` / `advanced` | 要一段综合答案 |
| `include_domains` / `exclude_domains` | 域名数组 | 只看官网 / 排除低质站 |
| `country` | 国家名 | 本地化结果 |
| `exact_match` | 布尔 | 只匹配原句（报错/引用） |
| `include_raw_content` | 布尔 | 连正文一起返回（更费 token） |
| `include_images` | 布尔 | 附带图片 |

## 3. 答案模式（include_answer）

- 开启后，Tavily 会生成一段**综合答案**，适合“事实型提问”；
- 不是所有查询都一定生成答案；没有答案时看 `results`；
- 如果你用 MCP 工具，**工具可能没有暴露 `include_answer`**——这时用 HTTP API，或换一个支持该参数的封装。

## 4. 成本与限速（记忆版）

- 按 **credits** 计费：`basic` 便宜，`advanced` 更贵；research/crawl 按量更贵；
- 免费/免登录（keyless）模式有限速，可能直接 429；
- 开发 Key 与生产 Key 的 RPM 不同；research 任务创建约 20 次/分钟；
- 具体价格/额度以官网控制台为准，会变。

常见状态码：

| 状态 | 含义 | 处理 |
|---|---|---|
| 200 | 成功 | — |
| 401/403 | Key 无效/权限不足 | 检查环境变量、Key 权限 |
| 429 | 限速/额度 | 退避重试；换 Key；减少 advanced |
| 5xx | 服务端错误 | 重试 + 降级 |

## 5. 查询怎么写（最重要）

一句话公式：**主体 + 限定（时间/站点/版本）+ 要什么**。

| 目的 | 差的写法 | 好的写法 |
|---|---|---|
| 查最新 | “DeepSeek 新模型” | “DeepSeek 最新模型发布 2026年10月” |
| 查报错 | “报错了” | “`Access is denied` arduino-cli build cache Windows” |
| 查官方 | “查一下文档” | “Tavily search API search_depth 参数 site:docs.tavily.com” |
| 对比 | “哪个好” | “ESP32-C3 vs S2 Mini 舵机 PWM 对比” |
| 找项目 | “有没有现成的” | “github ornithopter flapping wing ESP32” |

补充：

- 中文问题可以，但要中文来源就明确说“优先中文来源”；
- 一个目标一条查询；多目标拆成多条（并行）；
- 重要结论至少两个来源交叉核对。

## 6. 不要做的事

- 不要把 Key 写进代码/仓库/截图；
- 不要用搜索 API 抓私密/登录后内容（不是它的用途）；
- 不要把 `results[].content` 当全文（它只是片段，全文用 extract）；
- 不要用“能搜到”证明 Key 有效（keyless 兜底也会成功）。


---

## 2. Extract / Crawl / Map / Research：四个能力怎么用

> Search 只是入口。真正省时间的是“已知链接读正文、摸站点结构、批量抓取、深度调研”。

## 1. Extract（提取网页正文）

**用途**：已知 URL，抓正文；适合“读这篇文章/这份文档”。

| 参数 | 说明 |
|---|---|
| `urls` | 1~20 个 URL |
| `extract_depth` | `basic` / `advanced`（表格、JS 重、LinkedIn 等用 advanced） |
| `format` | `markdown`（推荐）/ `text` |
| `query` | 关键词，长文里优先返回相关段落 |
| `include_images` | 附带图片 |

```bash
curl -s https://api.tavily.com/extract \
  -H "Authorization: Bearer $TAVILY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com"],"extract_depth":"basic","format":"markdown"}'
```

**坑**：登录墙/付费墙抓不到；页面很长时用 `query` 过滤；抓下来的内容是外部数据，别当指令。

## 2. Map（站点地图/页面清单）

**用途**：还不知道一个站有哪些页，先列出来。

| 参数 | 说明 |
|---|---|
| `url` | 站点根/入口 |
| `max_depth` / `max_breadth` | 探索深度/每层跟随数 |
| `limit` | 总 URL 上限（**必设**） |
| `select_paths` / `select_domains` | 正则过滤（如 `/docs/.*`） |
| `instructions` | 自然语言说明你要哪类页面 |

**最佳实践**：`map(limit 50)` → 挑 3~5 个关键页 → `extract`，不要一上来全站抓。

## 3. Crawl（批量爬）

**用途**：把一个站的一批页面抓下来（正文 + 元数据）。

| 参数 | 说明 |
|---|---|
| `url` | 起点 |
| `limit` | 总页数上限（**必设**，否则可能很贵） |
| `max_depth` / `max_breadth` | 范围 |
| `instructions` | “只要教程/API 文档” |
| `select_paths` / `select_domains` | 正则过滤 |
| `extract_depth` / `format` | 抓取深度/格式 |

**和 Map 的区别**：map 只列 URL（快、便宜）；crawl 会抓正文（慢、贵）。
先 map 看结构，再决定 crawl 哪些路径。

## 4. Research（深度调研）

**用途**：复杂问题、多源综合、写调研/综述。

| 参数 | 说明 |
|---|---|
| `input` | 完整任务描述（背景 + 要什么 + 输出格式） |
| `model` | `mini`（快、窄）/ `pro`（全、慢）/ `auto` |

**注意**：

- 单次可能几十秒；限速约 20 次/分钟；
- 消耗比 search 大，先 mini 试；
- 适合“写报告”，不适合“今天天气”。

## 5. 怎么选（速查）

```text
知道链接、要正文        → Extract（复杂页 advanced）
不知道站点有哪些页      → Map
要一批页面              → Map 看结构 → Crawl（必设 limit）
要综合多源写报告        → Research（先 mini）
只要一段答案/来源        → Search（见 01）
```

## 6. 成本控制

- 先便宜后贵：Search `basic` → Extract basic → 再考虑 advanced/crawl/research；
- 设置上限：`max_results`、`limit`、`query` 过滤；
- 别重复抓同一页；把结果缓存到本地。


---

## 3. 把 Tavily 接成 MCP（在 DSH 里零安装挂载）

> 适用：想在 `web_search` 之外，再拿到 extract / crawl / map / research 这些工具。
> 原理：DSH 自带 MCP 客户端；只需在 profile patch 里 `insert:` 一行远程 MCP 配置。

## 1. 官方远程 MCP

- 地址：`https://mcp.tavily.com/mcp/`
- 鉴权：`Authorization: Bearer <你的 TAVILY_API_KEY>`（也支持 URL 查询参数方式）
- 工具：`tavily-search` / `tavily-extract` / `tavily-map` / `tavily-crawl` / `tavily-research`（以实际返回为准）

## 2. DSH 配置示例

```yaml
# profiles/<profile>/cordis.patch.yml
- insert:
    - id: mcp-tavily
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: tavily
        transport: streamable-http
        url: https://mcp.tavily.com/mcp/
        headers:
          Authorization: !!js '`Bearer ${process.env.TAVILY_API_KEY}`'
```

要点：

- **必须用 `insert:`**：裸的 `- id:` 会被当成“覆盖不存在的行”而忽略；
- Key 只写**变量名**，不要把值写进文件；
- app 自带 `@deepseek-ai/dsh-mcp-client`，**不需要安装任何包**；
- 改完一般热加载生效；不生效再重启。

## 3. 验证

1. 工具清单里出现 `mcp__tavily__*`；
2. 调用 `tavily_search`，返回里应有 `auth_mode: "keyed"`（说明 Key 生效）；
3. 调用 `tavily_extract` 抓一个公开页面，确认有正文；
4. 观察 `web_search` 原有功能未受影响。

## 4. 坑

| 坑 | 说明 |
|---|---|
| 工具数量增加 | 多 5 个工具，占一点上下文；不需要就别装 |
| Key 不生效 | 环境变量没进 app 进程；重启 app 或检查变量 |
| 没有 answer | MCP 搜索工具不一定暴露 `include_answer`；要总结用 HTTP API 或自带 `web_search` |
| 鉴权失败 | 检查 Key 权限/配额；远程 MCP 可能走 OAuth 流程 |
| 把 Key 写进 URL | 不要提交到仓库/截图；用 header + 环境变量 |

## 5. 什么时候值得接

- 你经常要“读全文/爬站点/列站点/深调研”；
- 你愿意多 5 个工具占一点上下文；
- 你有有效 Key，并接受研究任务较慢/较贵。

只做日常搜索，不需要接 MCP。


---

## 4. 搜索提供方对比：Tavily vs 内置 vs Brave/Exa/DDG/SearXNG

> 用于选型，不是评测排名。**价格与能力会变**，请以官网为准。

| 提供方 | 强项 | 弱项 | 成本 | 适合 |
|---|---|---|---|---|
| **Tavily** | 面向 Agent；search/extract/crawl/map/research 一体；带 answer | 免费额度有限；advanced 更贵 | credits | 需要“质量 + 一站式工具” |
| **DSH 内置搜索** | 零配置；与 Harness 集成；某些模式免费/低成本 | 质量/速度依实现；可能是完整模型回合 | 取决于实现 | 简单/定义类问题、兜底 |
| **Brave Search API** | 独立索引；隐私；有 LLM Context API | 需要 Key；生态工具少 | 订阅/按量 | 隐私敏感、独立索引 |
| **Exa** | 语义/嵌入检索；Websets；适合“找相似” | 不是传统关键词搜索 | credits | 语义发现、研究型 |
| **DuckDuckGo（免费）** | 无需 Key；可做后备 | 限速/稳定性一般；无 SLA | 免费 | 兜底、原型 |
| **SearXNG（自建）** | 开源自托管；聚合多引擎；可控 | 要自己部署/维护；结果质量看实例 | 服务器成本 | 隐私/自建/批量 |

## 怎么选（经验规则）

1. **先问预算**：没有预算 → 内置 + DDG/SearXNG；有预算 → Tavily/Exa。
2. **再问任务**：
   - 要“答案 + 来源” → Tavily / Perplexity 类；
   - 要“读全文/爬站” → Tavily extract/crawl 或 Firecrawl；
   - 要“语义找相似” → Exa；
   - 要“独立索引/隐私” → Brave。
3. **最后问运维**：能接受自建吗？能 → SearXNG；不能 → 托管 API。
4. **多后端**：用路由（见姊妹仓库 `dsh-search-routers`）按问题/成本切换；失败自动降级。

## 一个够用的组合

- 日常：内置搜索（免费/便宜）兜底；
- 重要/最新：Tavily；
- 已知链接：Tavily extract；
- 语义发现：Exa（可选）；
- 免费第三层：DuckDuckGo（可选）。

## 参考

- Tavily：<https://docs.tavily.com/>
- Tavily MCP：<https://docs.tavily.com/documentation/mcp>
- Brave Search API：<https://brave.com/search/api/>
- Exa：<https://exa.ai/>
- SearXNG：<https://github.com/searxng/searxng>
- 对比文章（第三方，注意时效）：<https://www.firecrawl.dev/alternatives/firecrawl-vs-tavily>


---
