#!/usr/bin/env python3
import json
import sys

try:
    from openbb import obb
except Exception as exc:
    print(json.dumps({"symbol": "", "articles": [], "error": str(exc)}))
    sys.exit(0)


def to_articles(data):
    articles = []
    rows = []

    if hasattr(data, "to_df"):
        try:
            df = data.to_df()
            rows = df.to_dict(orient="records")
        except Exception:
            rows = []

    if not rows and hasattr(data, "to_dataframe"):
        try:
            df = data.to_dataframe()
            rows = df.to_dict(orient="records")
        except Exception:
            rows = []

    if not rows and isinstance(data, list):
        rows = data

    for item in rows:
        if not isinstance(item, dict):
            continue
        articles.append(
            {
                "title": item.get("title", "") or item.get("headline", ""),
                "summary": item.get("summary", "") or item.get("text", ""),
                "source": item.get("source", "") or item.get("publisher", ""),
                "published_at": str(
                    item.get("date", "")
                    or item.get("published_at", "")
                    or item.get("datetime", "")
                ),
                "url": item.get("url", "") or item.get("link", ""),
                "provider": "openbb",
            }
        )

    return articles


def main():
    symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    try:
        data = obb.news.company(symbol=symbol)
        articles = to_articles(data)
        result = {"symbol": symbol, "articles": articles[:5]}
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({"symbol": symbol, "articles": [], "error": str(exc)}))


if __name__ == "__main__":
    main()
