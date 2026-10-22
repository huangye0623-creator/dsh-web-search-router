#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tavily 最小连通性/答案模式验证：只读环境变量，不写死 Key。

用法：
  export TAVILY_API_KEY="tvly-..."       # Windows: set TAVILY_API_KEY=...
  python tavily_probe.py "查询词" [--depth basic|advanced]

输出：HTTP 状态、是否有 answer、来源数与标题。不打印 Key。
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.tavily.com/search"


def main():
    key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not key:
        print("缺少 TAVILY_API_KEY 环境变量（不要把 Key 写进文件）")
        return 2
    query = " ".join(a for a in sys.argv[1:] if not a.startswith("--")) or "Tavily search API for AI agents"
    depth = "basic"
    for a in sys.argv[1:]:
        if a.startswith("--depth="):
            depth = a.split("=", 1)[1]

    body = json.dumps({
        "query": query,
        "max_results": 5,
        "search_depth": depth,
        "include_answer": True,
    }).encode("utf-8")
    req = urllib.request.Request(
        API,
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status = resp.status
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"请求失败：{e}")
        return 1

    answer = payload.get("answer")
    results = payload.get("results") or []
    print(f"HTTP {status}")
    print(f"answer_present={bool(answer)}")
    if answer:
        print("answer:", answer[:200].replace("\n", " "))
    print(f"results={len(results)}")
    for r in results[:3]:
        print("-", (r.get("title") or r.get("url") or "")[:120])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
