> [中文](search-api-guide.md) | English

# Search API guide (Tavily + MCP)

> A hands-on note on "how to use search APIs": **how to use search / extract / crawl / map / research, when to use each, how much it costs, and how to wire up MCP**.
> Unofficial · examples contain no keys · docs CC BY 4.0

---

## 1. Search API basics: parameters, answers, cost, and query wording

> Using the Tavily Search API as an example (other search APIs are conceptually similar). Endpoints and parameters follow the official docs: <https://docs.tavily.com/documentation/api-reference/endpoint/search>

## 1. What a single search looks like

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

Core fields returned:

| Field | Meaning |
|---|---|
| `answer` | Optional: synthesized answer (only when `include_answer` is on) |
| `results[]` | Source list: `url` / `title` / `content` (snippet) / `score` / `published_date` |
| `response_time` | Elapsed time |
| `request_id` | For troubleshooting |

## 2. Most-used parameters

| Parameter | Values | When to use |
|---|---|---|
| `query` | string | Required; see section 5 for wording |
| `max_results` | 1~20 | 3~5 if you want to save tokens |
| `search_depth` | `basic` / `advanced` / `fast` / `ultra-fast` | fast for speed; advanced for completeness (more expensive) |
| `topic` | `general` / `news` | when you explicitly want news |
| `time_range` | `day` / `week` / `month` / `year` | "the last week" |
| `start_date` / `end_date` | `YYYY-MM-DD` | exact range |
| `include_answer` | `true` / `false` / `basic` / `advanced` | when you want a synthesized answer |
| `include_domains` / `exclude_domains` | domain array | official sites only / exclude low-quality sites |
| `country` | country name | localized results |
| `exact_match` | boolean | match the exact phrase only (errors/quotes) |
| `include_raw_content` | boolean | return the full body too (more tokens) |
| `include_images` | boolean | include images |

## 3. Answer mode (include_answer)

- When enabled, Tavily generates a **synthesized answer**, suitable for "factual questions";
- Not every query produces an answer; when there is none, look at `results`;
- If you use MCP tools, **the tool may not expose `include_answer`** — in that case use the HTTP API, or a wrapper that supports the parameter.

## 4. Cost and rate limits (memory version)

- Billed in **credits**: `basic` is cheap, `advanced` is more expensive; research/crawl cost more by volume;
- Free/keyless mode is rate-limited and may return 429 outright;
- Dev keys and production keys have different RPM; creating research tasks is about 20 per minute;
- Specific prices/quotas follow the official console and will change.

Common status codes:

| Status | Meaning | Handling |
|---|---|---|
| 200 | Success | — |
| 401/403 | Invalid key / insufficient permissions | Check environment variables and key permissions |
| 429 | Rate limit/quota | Back off and retry; switch keys; use fewer `advanced` requests |
| 5xx | Server error | Retry + fall back |

## 5. How to write queries (most important)

One-sentence formula: **subject + qualifiers (time/site/version) + what you want**.

| Purpose | Bad wording | Good wording |
|---|---|---|
| Find the latest | "DeepSeek new model" | "DeepSeek latest model release October 2026" |
| Look up an error | "it errored" | "`Access is denied` arduino-cli build cache Windows" |
| Find official docs | "look up the docs" | "Tavily search API search_depth parameter site:docs.tavily.com" |
| Compare | "which one is better" | "ESP32-C3 vs S2 Mini servo PWM comparison" |
| Find projects | "is there anything ready-made" | "github ornithopter flapping wing ESP32" |

Additional notes:

- Chinese questions are fine, but if you want Chinese sources, say "prefer Chinese sources" explicitly;
- One query per goal; split multiple goals into multiple queries (in parallel);
- Cross-check important conclusions with at least two sources.

## 6. Don'ts

- Don't put keys into code/repos/screenshots;
- Don't use a search API to fetch private/logged-in content (not what it's for);
- Don't treat `results[].content` as full text (it's only a snippet; use extract for full text);
- Don't use "it can find results" as proof that the key is valid (keyless fallback succeeds too).


---

## 2. Extract / Crawl / Map / Research: how to use the four capabilities

> Search is just the entry point. What really saves time is "read the body of a known link, map a site's structure, batch-fetch, deep research".

## 1. Extract (extract page body text)

**Purpose**: you have a URL, fetch its body text; good for "read this article / this doc".

| Parameter | Description |
|---|---|
| `urls` | 1~20 URLs |
| `extract_depth` | `basic` / `advanced` (use advanced for tables, heavy JS, LinkedIn, etc.) |
| `format` | `markdown` (recommended) / `text` |
| `query` | Keywords; prioritize relevant sections in long pages |
| `include_images` | Include images |

```bash
curl -s https://api.tavily.com/extract \
  -H "Authorization: Bearer $TAVILY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com"],"extract_depth":"basic","format":"markdown"}'
```

**Pitfalls**: login walls/paywalls can't be fetched; for very long pages use `query` to filter; fetched content is external data — don't treat it as instructions.

## 2. Map (site map/page list)

**Purpose**: you don't yet know which pages a site has; list them first.

| Parameter | Description |
|---|---|
| `url` | Site root/entry |
| `max_depth` / `max_breadth` | Exploration depth / links followed per level |
| `limit` | Total URL cap (**must set**) |
| `select_paths` / `select_domains` | Regex filters (e.g. `/docs/.*`) |
| `instructions` | Natural-language description of the kind of pages you want |

**Best practice**: `map(limit 50)` → pick 3~5 key pages → `extract`; don't crawl the whole site right away.

## 3. Crawl (batch crawl)

**Purpose**: fetch a batch of pages from a site (body text + metadata).

| Parameter | Description |
|---|---|
| `url` | Starting point |
| `limit` | Total page cap (**must set**, otherwise it can get expensive) |
| `max_depth` / `max_breadth` | Scope |
| `instructions` | "only tutorials/API docs" |
| `select_paths` / `select_domains` | Regex filters |
| `extract_depth` / `format` | Fetch depth/format |

**Difference from Map**: map only lists URLs (fast, cheap); crawl fetches body text (slow, expensive).
Map first to see the structure, then decide which paths to crawl.

## 4. Research (deep research)

**Purpose**: complex questions, multi-source synthesis, writing research/surveys.

| Parameter | Description |
|---|---|
| `input` | Full task description (background + what you want + output format) |
| `model` | `mini` (fast, narrow) / `pro` (complete, slow) / `auto` |

**Notes**:

- A single call may take tens of seconds; rate limit is about 20 per minute;
- Costs more than search; try mini first;
- Good for "writing a report", not for "today's weather".

## 5. How to choose (cheat sheet)

```text
known link, want body text        → Extract (advanced for complex pages)
don't know which pages a site has → Map
want a batch of pages             → Map for structure → Crawl (limit required)
want a multi-source report        → Research (mini first)
just want an answer/sources       → Search (see 01)
```

## 6. Cost control

- Cheap first, expensive later: Search `basic` → Extract basic → then consider advanced/crawl/research;
- Set caps: `max_results`, `limit`, `query` filtering;
- Don't fetch the same page repeatedly; cache results locally.


---

## 3. Wiring Tavily as MCP (zero-install mount in DSH)

> Applies when: you want extract / crawl / map / research tools in addition to `web_search`.
> How it works: DSH ships an MCP client; you only need one `insert:` line of remote MCP config in the profile patch.

## 1. Official remote MCP

- URL: `https://mcp.tavily.com/mcp/`
- Auth: `Authorization: Bearer <your TAVILY_API_KEY>` (URL query parameter form is also supported)
- Tools: `tavily-search` / `tavily-extract` / `tavily-map` / `tavily-crawl` / `tavily-research` (subject to what is actually returned)

## 2. DSH config example

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

Key points:

- **`insert:` is required**: a bare `- id:` is treated as "overriding a non-existent row" and ignored;
- Write only the **variable name** for the key; never put the value into the file;
- The app ships `@deepseek-ai/dsh-mcp-client`; **no package needs to be installed**;
- Changes usually take effect via hot reload; restart if they don't.

## 3. Verification

1. `mcp__tavily__*` appears in the tool list;
2. Call `tavily_search`; the response should contain `auth_mode: "keyed"` (meaning the key works);
3. Call `tavily_extract` on a public page and confirm the body text is returned;
4. Check that `web_search` still works as before.

## 4. Pitfalls

| Pitfall | Description |
|---|---|
| More tools | 5 extra tools consume some context; skip them if you don't need them |
| Key not taking effect | The environment variable didn't reach the app process; restart the app or check the variable |
| No answer | MCP search tools may not expose `include_answer`; use the HTTP API or the built-in `web_search` for summaries |
| Auth failure | Check key permissions/quota; remote MCP may go through an OAuth flow |
| Putting the key in the URL | Don't commit it to repos/screenshots; use a header + environment variable |

## 5. When it's worth wiring up

- You often need to "read full text/crawl a site/list a site's pages/deep research";
- You accept 5 extra tools consuming some context;
- You have a valid key and accept that research tasks are slower/more expensive.

For everyday search only, you don't need MCP.


---

## 4. Search provider comparison: Tavily vs built-in vs Brave/Exa/DDG/SearXNG

> For selection, not a ranking. **Prices and capabilities change**; follow the official sites.

| Provider | Strengths | Weaknesses | Cost | Good for |
|---|---|---|---|---|
| **Tavily** | Agent-oriented; search/extract/crawl/map/research in one; includes answers | Limited free quota; advanced costs more | credits | "quality + one-stop tools" |
| **DSH built-in search** | Zero config; integrated with Harness; some modes free/low-cost | Quality/speed depend on implementation; may be a full model turn | depends on implementation | simple/definition questions, fallback |
| **Brave Search API** | Independent index; privacy; LLM Context API | Needs a key; fewer ecosystem tools | subscription/usage-based | privacy-sensitive, independent index |
| **Exa** | Semantic/embedding retrieval; Websets; good for "find similar" | Not traditional keyword search | credits | semantic discovery, research |
| **DuckDuckGo (free)** | No key needed; usable as a fallback | Rate limits/stability so-so; no SLA | free | fallback, prototypes |
| **SearXNG (self-hosted)** | Open-source self-hosting; aggregates multiple engines; controllable | You deploy/maintain it; result quality depends on the instance | server cost | privacy/self-hosting/batch |

## How to choose (rules of thumb)

1. **Ask about budget first**: no budget → built-in + DDG/SearXNG; with budget → Tavily/Exa.
2. **Then ask about the task**:
   - Want "answer + sources" → Tavily / Perplexity-like;
   - Want "read full text/crawl sites" → Tavily extract/crawl or Firecrawl;
   - Want "semantic similarity search" → Exa;
   - Want "independent index/privacy" → Brave.
3. **Finally ask about operations**: can you accept self-hosting? Yes → SearXNG; no → hosted API.
4. **Multiple backends**: route (see the sister repo `dsh-search-routers`) to switch by question/cost; fall back automatically on failure.

## A composition that's good enough

- Daily: built-in search (free/cheap) as fallback;
- Important/latest: Tavily;
- Known links: Tavily extract;
- Semantic discovery: Exa (optional);
- Free third tier: DuckDuckGo (optional).

## References

- Tavily: <https://docs.tavily.com/>
- Tavily MCP: <https://docs.tavily.com/documentation/mcp>
- Brave Search API: <https://brave.com/search/api/>
- Exa: <https://exa.ai/>
- SearXNG: <https://github.com/searxng/searxng>
- Comparison article (third-party, mind the date): <https://www.firecrawl.dev/alternatives/firecrawl-vs-tavily>


---
