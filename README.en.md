> [中文](README.md) | English

# DSH Web Search Router (Tavily smart search router)

> Per-query routing for DeepSeek Harness's `web_search`: important/latest/comparison queries go to Tavily, simple/definition/error queries go to the built-in search; failures fall back automatically, and results show the actual backend.
>
> Unofficial · adapted to DSH `0.2.1-rc.2` (dev preview) · code MIT / docs CC BY 4.0

## What's in this repo

| Content | Description |
|---|---|
| [docs/search-router.md](docs/search-router.en.md) | Design: in-provider routing, scoring, fallback/cooldown, result marker, status tool |
| [docs/search-api-guide.md](docs/search-api-guide.en.md) | Tavily API guide: search/extract/crawl/map/research + MCP + provider comparison |
| [examples/web-search-router/](examples/web-search-router/) | Reference plugin implementation (`index.js` / `package.json` / `cordis.patch.yml`) |
| [examples/tavily_probe.py](examples/tavily_probe.py) | Minimal connectivity/answer-mode check (reads environment variables only) |
| [examples/mcp-tavily.patch.yml](examples/mcp-tavily.patch.yml) | DSH config example for the Tavily remote MCP |

## Key numbers (author's environment)

- 32 searches in one day: Tavily 23 / built-in 9; 0 failures, 0 fallbacks;
- ~274 ms for simple questions, ~5.4 s for complex ones (including the summary);
- The top of results shows "search backend: …", and a `web_search_router` status tool is available.

## Quick start

1. Read [docs/search-router.md](docs/search-router.en.md) first;
2. Adapt `examples/web-search-router/` to your DSH version;
3. **The outer `web.searchProvider` must be pinned explicitly**, otherwise multiple providers cause `WEB_PROVIDER_AMBIGUOUS`;
4. After upgrading DSH, run the regression checklist from the `dsh-crash-avoidance` repo.

## Boundaries

- The example plugin depends on DSH's internal Web seam behavior; it is **not an npm package** and may need adaptation after upgrades;
- No API keys are included;
- No features that bypass payment or access controls are provided.

## License

Code MIT ([LICENSE](LICENSE)); docs CC BY 4.0; unofficial, no warranty. See [LEGAL.md](LEGAL.en.md) / [THIRD-PARTY.md](THIRD-PARTY.en.md).

---

*Summary: a per-query router for DSH's `web_search` — route important/current/comparison queries to Tavily, simple/definition/error queries to the built-in search, with fallback, cooldowns, a backend marker, and a status tool. Includes a Tavily API/MCP usage guide. Unofficial; code MIT, docs CC BY 4.0.*
