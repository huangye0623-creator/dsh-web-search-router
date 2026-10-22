# web-search-router 示例

这是 [docs/web-search-router.md](../../docs/search-router.md) 的参考实现：在提供方内部做 **Tavily ↔ DSH 内置搜索** 的按问题选路。

## 文件

| 文件 | 说明 |
|---|---|
| `index.js` | 插件主体：注册提供方、打分选路、失败降级/冷却、结果标记、状态工具 |
| `package.json` | 包名与 `dsh.bundle.patch` 声明 |
| `cordis.patch.yml` | bundle patch：把提供方插入 profile |
| `../templates/AGENTS-snippet.md` | 与本文无关，是协作规则 |

## 适用版本

- 作者验证过 `DSH 0.2.1-rc.2`；
- DSH 处于 developer preview，**升级后请按 `dsh-crash-avoidance` 仓库的 `docs/upgrade-checklist.md` 回归**。

## 配置思路

1. 外层把 `web.searchProvider` 钉到本插件注册的提供方 id（否则多提供方会 `WEB_PROVIDER_AMBIGUOUS`）；
2. 插件内部再按查询选择 Tavily/内置；
3. 失败分类 + 冷却 + 自动换另一条；
4. 结果里标出实际走了谁，并提供状态工具（`status/stats/recent/set_mode/dry_run`）。

> ⚠️ 不要把本示例直接当成“生产插件”：它依赖 DSH 内部 API 与 Web seam 行为；请按你的版本适配并自行测试。

## 许可

MIT（见仓库根目录 `LICENSE`）。
