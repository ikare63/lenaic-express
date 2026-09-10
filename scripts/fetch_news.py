#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import html
import json
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import quote_plus

import feedparser

ROOT = Path(__file__).resolve().parents[1]
SOURCES_PATH = ROOT / "sources.json"
PREFS_PATH = ROOT / "preferences.json"
OUTPUT_PATH = ROOT / "data" / "actualites.json"

TAG_RE = re.compile(r"<[^>]+>")
IMG_RE = re.compile(r'<img[^>]+src=["\']([^"\']+)["\']', re.I)

def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))

def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", text.lower()).strip()

def clean_html(value: str) -> str:
    value = html.unescape(value or "")
    value = TAG_RE.sub(" ", value)
    return re.sub(r"\s+", " ", value).strip()

def make_id(source_id: str, title: str, url: str) -> str:
    raw = f"{source_id}|{normalize(title)}|{url}".encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:18]

def parse_entry_date(entry) -> datetime:
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        value = entry.get(key)
        if value:
            try:
                return datetime.fromtimestamp(time.mktime(value), tz=timezone.utc)
            except Exception:
                pass
    return datetime.now(timezone.utc)

def extract_image(entry) -> str:
    for field in ("media_content", "media_thumbnail"):
        items = entry.get(field) or []
        if items and isinstance(items, list):
            url = items[0].get("url")
            if url:
                return url
    for enclosure in entry.get("enclosures", []) or []:
        if str(enclosure.get("type", "")).startswith("image/") and enclosure.get("href"):
            return enclosure["href"]
    raw = entry.get("summary", "") or entry.get("description", "")
    m = IMG_RE.search(raw)
    return m.group(1) if m else ""

def google_news_url(query: str, language="fr", country="FR") -> str:
    return (
        "https://news.google.com/rss/search?"
        f"q={quote_plus(query)}&hl={language}&gl={country}&ceid={country}:{language}"
    )

def article_score(article, source, prefs, now):
    category_conf = prefs.get("categories", {}).get(article["category"], {})
    score = float(category_conf.get("weight", 1)) * 8
    score += float(source.get("priority", 1)) * 6

    haystack = normalize(" ".join([
        article.get("title", ""),
        article.get("summary", ""),
        article.get("source", "")
    ]))
    matched = []
    for item in prefs.get("keywords", []):
        term = normalize(item["term"])
        if term and term in haystack:
            score += float(item.get("weight", 1)) * 4
            matched.append(item["term"])
    for item in prefs.get("negative_keywords", []):
        term = normalize(item["term"])
        if term and term in haystack:
            score += float(item.get("weight", -1)) * 4

    age_hours = max(0, (now - datetime.fromisoformat(article["published_at"].replace("Z","+00:00"))).total_seconds() / 3600)
    score += max(0, 28 - age_hours / 8)
    return round(score, 2), matched[:8]

def parse_feed(source, prefs):
    url = source.get("url")
    if source.get("type") == "google_news":
        url = google_news_url(
            source.get("query", ""),
            prefs.get("language", "fr"),
            prefs.get("country", "FR")
        )

    parsed = feedparser.parse(
        url,
        request_headers={"User-Agent": "LenaicExpress/1.0 (+personal RSS reader)"}
    )
    if parsed.bozo and not parsed.entries:
        raise RuntimeError(str(getattr(parsed, "bozo_exception", "flux illisible")))

    out = []
    for entry in parsed.entries:
        title = clean_html(entry.get("title", ""))
        link = entry.get("link", "")
        if not title or not link:
            continue

        summary = clean_html(entry.get("summary", "") or entry.get("description", ""))
        if len(summary) > 430:
            summary = summary[:427].rsplit(" ", 1)[0] + "…"

        dt = parse_entry_date(entry)
        item_source = source["name"]

        # Google News fournit parfois le média d'origine dans entry.source.
        if source.get("type") == "google_news":
            origin = entry.get("source")
            if isinstance(origin, dict) and origin.get("title"):
                item_source = origin["title"]
            # Évite le " - NomDuMedia" souvent ajouté au titre Google News.
            if item_source and title.endswith(" - " + item_source):
                title = title[:-(len(item_source)+3)].strip()

        out.append({
            "id": make_id(source["id"], title, link),
            "title": title,
            "summary": summary,
            "url": link,
            "source": item_source,
            "source_id": source["id"],
            "category": source.get("category", "general"),
            "published_at": dt.astimezone(timezone.utc).isoformat().replace("+00:00","Z"),
            "image": extract_image(entry),
            "score": 0,
            "matched_keywords": []
        })
    return out

def dedupe(articles):
    seen_urls = set()
    seen_titles = set()
    out = []
    for a in articles:
        url_key = a["url"].split("?")[0].rstrip("/")
        title_key = normalize(a["title"])
        if url_key in seen_urls or title_key in seen_titles:
            continue
        seen_urls.add(url_key)
        seen_titles.add(title_key)
        out.append(a)
    return out

def main():
    sources_cfg = load_json(SOURCES_PATH)
    prefs = load_json(PREFS_PATH)
    now = datetime.now(timezone.utc)
    max_age = timedelta(days=int(prefs.get("max_age_days", 14)))
    per_source = int(prefs.get("per_source_limit", 30))
    all_articles = []
    errors = []

    for source in sources_cfg.get("sources", []):
        if not source.get("enabled", True):
            continue
        try:
            items = parse_feed(source, prefs)[:per_source]
            for a in items:
                published = datetime.fromisoformat(a["published_at"].replace("Z","+00:00"))
                if now - published <= max_age:
                    a["score"], a["matched_keywords"] = article_score(a, source, prefs, now)
                    all_articles.append(a)
            print(f"OK  {source['name']}: {len(items)} entrée(s)")
        except Exception as exc:
            errors.append({"source": source.get("name", source.get("id")), "error": str(exc)})
            print(f"ERR {source.get('name')}: {exc}", file=sys.stderr)

    all_articles = dedupe(sorted(all_articles, key=lambda a: (a["score"], a["published_at"]), reverse=True))
    all_articles = all_articles[:int(prefs.get("max_articles", 180))]

    # Ne pas écraser une édition existante si toutes les sources sont temporairement indisponibles.
    if not all_articles and OUTPUT_PATH.exists():
        old = load_json(OUTPUT_PATH)
        old["last_attempt_at"] = now.isoformat().replace("+00:00","Z")
        old["fetch_errors"] = errors
        OUTPUT_PATH.write_text(json.dumps(old, ensure_ascii=False, indent=2), encoding="utf-8")
        print("Aucun nouvel article : édition précédente conservée.")
        return

    payload = {
        "generated_at": now.isoformat().replace("+00:00","Z"),
        "mode": "live",
        "article_count": len(all_articles),
        "fetch_errors": errors,
        "articles": all_articles
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Écrit: {OUTPUT_PATH} ({len(all_articles)} articles)")

if __name__ == "__main__":
    main()
