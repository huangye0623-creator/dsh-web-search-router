# DSH Web Search Router（Tavily 智能搜索选路器）

> 中文 | [English](README.en.md)

> 给 DeepSeek Harness 的 `web_search` 做**按问题选路**：重要/最新/对比走 Tavily，简单/定义/报错走内置搜索；失败自动降级，结果标出实际后端。
>
> 非官方 · 适配 DSH `0.2.1-rc.2`（dev preview）· 代码 MIT / 文档 CC BY 4.0

## 这个仓库有什么

| 内容 | 说明 |
|---|---|
| [docs/search-router.md](docs/search-router.md) | 设计：提供方内部路由、打分、回退/冷却、结果标记、状态工具 |
| [docs/search-api-guide.md](docs/search-api-guide.md) | Tavily API 使用指南：search/extract/crawl/map/research + MCP + 选型对比 |
| [examples/web-search-router/](examples/web-search-router/) | 插件参考实现（`index.js` / `package.json` / `cordis.patch.yml`） |
| [examples/tavily_probe.py](examples/tavily_probe.py) | 最小连通性/答案模式验证（只读环境变量） |
| [examples/mcp-tavily.patch.yml](examples/mcp-tavily.patch.yml) | Tavily 远程 MCP 的 DSH 配置示例 |

## 核心数字（作者环境）

- 一天 32 次搜索：Tavily 23 / 内置 9；失败 0、降级 0；
- 简单问题约 274 ms，复杂问题约 5.4 s（含总结）；
- 结果顶部显示“搜索后端：…”，并提供 `web_search_router` 状态工具。

## 快速开始

1. 先读 [docs/search-router.md](docs/search-router.md)；
2. 按你的 DSH 版本调整 `examples/web-search-router/`；
3. **外层 `web.searchProvider` 必须显式钉住**，否则多提供方会 `WEB_PROVIDER_AMBIGUOUS`；
4. 升级 DSH 后按 `dsh-crash-avoidance` 仓库的升级清单回归。

## 边界

- 插件示例依赖 DSH 内部 Web seam 行为，**不是 npm 包**；升级后可能需要适配；
- 不包含任何 API Key；
- 不提供绕过付费/访问控制的功能。

## 许可证

代码 MIT（[LICENSE](LICENSE)）；文档 CC BY 4.0；非官方、不提供担保。详见 [LEGAL.md](LEGAL.md) / [THIRD-PARTY.md](THIRD-PARTY.md)。

---

*English summary: a per-query router for DSH's `web_search` — route important/current/comparison queries to Tavily, simple/definition/error queries to the built-in search, with fallback, cooldowns, a backend marker, and a status tool. Includes a Tavily API/MCP usage guide. Unofficial; code MIT, docs CC BY 4.0.*
