> [中文](search-router.md) | English

# Multi-backend routing for `web_search` (Tavily ↔ built-in search)

> Goal: **save the money that should be saved, get the quality that matters**. Simple questions go to the free/cheap built-in search; important/latest/comparison questions go to Tavily; failures switch automatically; and results show which backend actually served the query.

---

## 1. Background: why "routing"

DSH's web search has three layers:

```text
tool (web_search) → service (ctx.web, chooses the provider) → provider (sends the actual request)
```

By default, the service "pins" search to one provider. Problems:

- All through Tavily: simple questions also consume quota;
- All through built-in: complex/latest questions have unstable quality, and the built-in search may be a full model turn (slower, more expensive);
- Multiple providers registered without pinning: **`WEB_PROVIDER_AMBIGUOUS`** (several available, no idea which to pick).

So we need a design that "**routes inside the provider**".

## 2. Design: pin one provider outside, route inside

```text
web_search(query)
   │
   ├─ read manual mode (if any: tavily / builtin / auto)
   ├─ score the query (importance/freshness/comparison/length/errors/definitions…)
   ├─ try in order:
   │     first choice → the other one (cooling ones go later, but are never fully disabled)
   ├─ failure classification: 429/quota/key/timeout → cooldown + switch to the other one
   └─ success: prepend a "search backend: …" line to result content, and write a local log
```

Key points:

1. **The outer layer still registers only one provider id** (e.g. `tavily`), avoiding `WEB_PROVIDER_AMBIGUOUS`;
2. Routing happens inside the provider's `search()`: it can **call the built-in provider's `search()` directly**;
3. Failures must be **classified** (rate limit/authentication/quota/timeout), with different cooldown times per type;
4. Results must **visibly show which backend was used**, otherwise debugging is guesswork.

## 3. Scoring rules (tunable)

In the example implementation, scoring uses query terms and the user's current utterance:

| Signal | Leans |
|---|---|
| Short query, definition type ("what is") | built-in |
| Errors/troubleshooting (contains error, exception, how to solve) | built-in |
| "latest/today/this week/2026", comparison/comprehensive/multiple sources | Tavily |
| Long query, complex conditions | Tavily |
| User explicitly says "official source/important" | Tavily |

Score ≥ threshold → Tavily; otherwise → built-in. The threshold is configurable (higher = save more Tavily quota; lower = more queries go to Tavily).

## 4. What the config looks like (profile's `cordis.patch.yml`)

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: tavily   # pin the router itself at the outer layer
    fetchProvider: http

- id: web-search-router
  name: dsh-web-search-router
  config:
    apiKeyEnv: TAVILY_API_KEY
    keyless: true            # allow keyless fallback (note: silent degradation)
    mode: auto               # auto / tavily / builtin
    fallback: true
    showMarker: true
    timeoutMs: 45000
    importanceThreshold: 2
```

> Note: overriding by id **replaces the whole `config` block**, so `fetchProvider` etc. must be included as well.

## 5. Verification: don't just look at "loaded successfully"

| Check | How |
|---|---|
| Provider registered | Check the plugin's own load-trace/logs |
| Routing actually happens | Check the marker at the top of results; or check the local search log |
| Failure fallback works | Force a failure temporarily (invalid key / network down) and see whether it switches |
| Built-in works | Ask a simple definition question; confirm it goes to built-in without errors |

Real observation (author's environment, 32 searches in one day): Tavily 23 / built-in 9, 0 failures, 0 fallbacks; ~274 ms for simple questions, ~5.4 s for complex ones (including the summary).

## 6. Pitfalls

1. **Preview API changes**: the outer routing field changed from a "public property" to a "config option", and old plugins silently stopped working. → Do capability detection + upgrade regression.
2. **`keyless: true` is a fallback, not a preference**: when the key stops working it silently degrades to the free rate-limited mode, **without an error**. → Don't use "search still works" as proof that the key is valid.
3. **Not pinning the outer layer causes ambiguity**: with multiple available providers registered at once, you must specify one explicitly.
4. **Tool parameters don't reach the provider**: `web_search` only carries `query`/`maxResults`; time range/site filters can only be static config, or a separate MCP tool.
5. **Built-in search also costs money**: some built-in search is a full model turn (consuming tokens), not free; confirm the cost model before routing.

## 7. When is it worth doing

- You are paying for both "search quality" and "search quota";
- You have multiple backends (Tavily/Exa/Brave/free DDG/SearXNG);
- You can accept the uncertainty of "the same question occasionally hitting a different backend".

If you use only one backend and have enough quota, you **do not need** routing — just pin it.

## 8. Similar projects (for reference when choosing)

- [Kerberos255/dsh-web-search-router](https://github.com/Kerberos255/dsh-web-search-router): multi-provider priority fallback, cooldowns, host-managed keys (closest to this design)
- [gordan-code/dsh-search-ledger](https://github.com/gordan-code/dsh-search-ledger): routing + key management + usage/cost ledger
- [DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search): free DuckDuckGo provider (can serve as a third-tier fallback)
- [spences10/mcp-omnisearch](https://github.com/spences10/mcp-omnisearch): MCP aggregator (multi-engine/extract), good for "adding tools" rather than "switching backends"

> These projects are all young; before choosing, check recent updates, issues, and whether they match your DSH version.

## 9. Examples in this doc

- Source: `examples/web-search-router/` (`index.js`, `package.json`, `cordis.patch.yml`)
- This is a **reference implementation**, not an npm package; adapt it to the API of the DSH version you use.
