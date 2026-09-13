#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
from urllib.parse import quote_plus, urljoin, urlparse

import feedparser
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
SOURCES_PATH = ROOT / "sources.json"
PREFS_PATH = ROOT / "preferences.json"
WATCHES_PATH = ROOT / "veilles.json"
OUTPUT_PATH = ROOT / "data" / "actualites.json"
AI_USAGE_PATH = ROOT / "data" / "ai-usage.json"

TAG_RE = re.compile(r"<[^>]+>")
IMG_RE = re.compile(r'<img[^>]+src=["\']([^"\']+)["\']', re.I)
SNAPSHOT_PATH_RE = re.compile(r"/([A-Za-z0-9]{5,})/?$")
USER_AGENT = "LenaicExpress/2.0 (+personal news reader; GitHub Actions)"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.6"})


def load_json(path: Path, fallback=None):
    if not path.exists():
        return fallback
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


def sha_text(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:20]


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


def prepare_watch_sources(watches_cfg: dict) -> list[dict]:
    out = []
    for idx, item in enumerate(watches_cfg.get("watches", []) or []):
        if not item.get("enabled", True):
            continue
        term = str(item.get("term", "")).strip()
        if not term:
            continue
        query = f'"{term}"' if " " in term else term
        out.append({
            "id": f"watch-{hashlib.sha1(term.encode('utf-8')).hexdigest()[:10]}",
            "name": f"Veille · {term}",
            "type": "google_news",
            "query": query,
            "category": item.get("category") or "general",
            "priority": 8.0,
            "enabled": True,
            "watch_term": term,
            "watch_index": idx,
        })
    return out


def match_watches(article: dict, watches_cfg: dict) -> list[str]:
    fields = watches_cfg.get("match_fields") or ["title", "summary", "source"]
    haystack = normalize(" ".join(str(article.get(f, "")) for f in fields))
    matches = []
    for item in watches_cfg.get("watches", []) or []:
        if not item.get("enabled", True):
            continue
        term = str(item.get("term", "")).strip()
        if term and normalize(term) in haystack:
            matches.append(term)
    return matches[:12]


def article_score(article, source, prefs, now, watches_cfg):
    category_conf = prefs.get("categories", {}).get(article["category"], {})
    score = float(category_conf.get("weight", 1)) * 8
    score += float(source.get("priority", 1)) * 6

    haystack = normalize(" ".join([
        article.get("title", ""),
        article.get("summary", ""),
        article.get("source", ""),
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

    watch_matches = match_watches(article, watches_cfg)
    if source.get("watch_term") and source["watch_term"] not in watch_matches:
        watch_matches.append(source["watch_term"])
    if watch_matches:
        score += 500

    age_hours = max(
        0,
        (now - datetime.fromisoformat(article["published_at"].replace("Z", "+00:00"))).total_seconds() / 3600,
    )
    score += max(0, 28 - age_hours / 8)
    return round(score, 2), matched[:8], watch_matches[:12]


def parse_feed(source, prefs):
    url = source.get("url")
    if source.get("type") == "google_news":
        url = google_news_url(
            source.get("query", ""), prefs.get("language", "fr"), prefs.get("country", "FR")
        )

    parsed = feedparser.parse(url, request_headers={"User-Agent": USER_AGENT})
    if parsed.bozo and not parsed.entries:
        raise RuntimeError(str(getattr(parsed, "bozo_exception", "flux illisible")))

    out = []
    for entry in parsed.entries:
        title = clean_html(entry.get("title", ""))
        link = entry.get("link", "")
        if not title or not link:
            continue

        summary = clean_html(entry.get("summary", "") or entry.get("description", ""))
        if len(summary) > 650:
            summary = summary[:647].rsplit(" ", 1)[0] + "…"

        dt = parse_entry_date(entry)
        item_source = source["name"]
        if source.get("type") == "google_news":
            origin = entry.get("source")
            if isinstance(origin, dict) and origin.get("title"):
                item_source = origin["title"]
            if item_source and title.endswith(" - " + item_source):
                title = title[: -(len(item_source) + 3)].strip()

        out.append({
            "id": make_id(source["id"], title, link),
            "title": title,
            "summary": summary,
            "url": link,
            "resolved_url": link,
            "source": item_source,
            "source_id": source["id"],
            "category": source.get("category", "general"),
            "published_at": dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "image": extract_image(entry),
            "score": 0,
            "matched_keywords": [],
            "watch_matches": [],
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


def apply_category_limits(articles: list[dict], prefs: dict, max_articles: int) -> list[dict]:
    limits = {
        key: int(conf.get("limit", max_articles))
        for key, conf in (prefs.get("categories") or {}).items()
    }
    counts = {}
    selected = []
    # Les veilles passent avant les quotas de rubrique.
    for a in articles:
        if a.get("watch_matches") and len(selected) < max_articles:
            selected.append(a)
            counts[a.get("category", "general")] = counts.get(a.get("category", "general"), 0) + 1
    chosen_ids = {a["id"] for a in selected}
    for a in articles:
        if len(selected) >= max_articles:
            break
        if a["id"] in chosen_ids:
            continue
        cat = a.get("category", "general")
        if counts.get(cat, 0) >= limits.get(cat, max_articles):
            continue
        selected.append(a)
        counts[cat] = counts.get(cat, 0) + 1
    return selected


def known_paywall(source_name: str, prefs: dict) -> bool:
    n = normalize(source_name)
    return any(normalize(x) in n for x in prefs.get("paywall_sources", []) if x)


def detect_paywall(soup: BeautifulSoup, raw_html: str) -> bool:
    text = normalize(raw_html[:200000])
    patterns = [
        "abonnez-vous pour lire",
        "article reserve aux abonnes",
        "contenu reserve aux abonnes",
        "pour continuer votre lecture",
        "subscribe to continue",
        "subscriber-only",
        "paywall",
    ]
    if any(p in text for p in patterns):
        return True
    for node in soup.select('[class*="paywall"], [id*="paywall"], [data-testid*="paywall"]'):
        if node:
            return True
    # schema.org isAccessibleForFree=false
    if re.search(r'"isAccessibleForFree"\s*:\s*(false|"False")', raw_html, re.I):
        return True
    return False


def extract_article_text(url: str) -> dict:
    result = {"resolved_url": url, "text": "", "paywalled": False, "status": "unavailable"}
    try:
        r = SESSION.get(url, timeout=14, allow_redirects=True)
        result["resolved_url"] = r.url or url
        ctype = (r.headers.get("content-type") or "").lower()
        if not r.ok or "html" not in ctype:
            return result
        raw = r.text
        soup = BeautifulSoup(raw, "html.parser")
        canonical = soup.find("link", rel=lambda x: x and "canonical" in str(x).lower())
        if canonical and canonical.get("href"):
            candidate = urljoin(result["resolved_url"], canonical["href"])
            if urlparse(candidate).scheme in {"http", "https"}:
                result["resolved_url"] = candidate
        result["paywalled"] = detect_paywall(soup, raw)

        # Article body JSON-LD si disponible.
        bodies = []
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string or "null")
            except Exception:
                continue
            stack = data if isinstance(data, list) else [data]
            for obj in stack:
                if isinstance(obj, dict) and isinstance(obj.get("articleBody"), str):
                    bodies.append(obj["articleBody"])
        if bodies:
            text = max(bodies, key=len)
        else:
            for tag in soup(["script", "style", "noscript", "svg", "nav", "footer", "header", "form", "aside"]):
                tag.decompose()
            candidates = []
            for selector in ("article p", "main p", "[itemprop='articleBody'] p", ".article-body p", ".post-content p"):
                parts = [clean_html(p.get_text(" ", strip=True)) for p in soup.select(selector)]
                joined = "\n".join(p for p in parts if len(p) >= 35)
                if len(joined) > 300:
                    candidates.append(joined)
            text = max(candidates, key=len) if candidates else ""

        text = re.sub(r"\s+", " ", html.unescape(text or "")).strip()
        result["text"] = text[:18000]
        result["status"] = "article" if len(text) >= 500 else "thin"
        return result
    except Exception:
        return result


def archive_lookup(url: str) -> dict:
    if not url:
        return {"lookup_url": "", "status": "unknown", "snapshot_url": ""}
    lookup = "https://archive.is/" + url
    out = {"lookup_url": lookup, "status": "unknown", "snapshot_url": ""}
    try:
        r = SESSION.get(lookup, timeout=10, allow_redirects=True)
        final = r.url or lookup
        low = normalize(r.text[:120000] if r.text else "")
        if r.ok and SNAPSHOT_PATH_RE.search(urlparse(final).path or "") and "archive." in urlparse(final).netloc:
            out["status"] = "found"
            out["snapshot_url"] = final
        elif "no results" in low or "no snapshots" in low or "not archived" in low:
            out["status"] = "not_found"
        elif "captcha" in low:
            out["status"] = "unknown"
    except Exception:
        pass
    return out


def response_text(data: dict) -> str:
    if isinstance(data.get("output_text"), str):
        return data["output_text"].strip()
    chunks = []
    for out in data.get("output", []) or []:
        for c in out.get("content", []) if isinstance(out, dict) else []:
            if isinstance(c, dict) and c.get("type") in {"output_text", "text"} and c.get("text"):
                chunks.append(str(c["text"]))
    return "\n".join(chunks).strip()


def ai_limits(prefs: dict) -> dict:
    cfg = prefs.get("ai", {}) or {}
    return {
        "monthly_budget_usd": float(os.getenv("AI_MONTHLY_BUDGET_USD", cfg.get("monthly_budget_usd", 0.90))),
        "daily_summary_limit": int(os.getenv("AI_DAILY_SUMMARY_LIMIT", cfg.get("daily_summary_limit", 20))),
        "input_price_per_million_usd": float(cfg.get("input_price_per_million_usd", 0.20)),
        "output_price_per_million_usd": float(cfg.get("output_price_per_million_usd", 1.20)),
        "timezone": str(cfg.get("budget_timezone", "Europe/Paris")),
    }


def load_ai_usage(prefs: dict, now: datetime) -> dict:
    limits = ai_limits(prefs)
    try:
        local_now = now.astimezone(ZoneInfo(limits["timezone"]))
    except Exception:
        local_now = now
    month_key = local_now.strftime("%Y-%m")
    day_key = local_now.strftime("%Y-%m-%d")
    usage = load_json(AI_USAGE_PATH, {}) or {}
    if usage.get("month") != month_key:
        usage["month"] = month_key
        usage["month_spend_usd"] = 0.0
        usage["month_requests"] = 0
        usage["month_summaries"] = 0
    if usage.get("day") != day_key:
        usage["day"] = day_key
        usage["day_requests"] = 0
        usage["day_summaries"] = 0
    usage.setdefault("version", 1)
    usage.setdefault("lifetime_spend_usd", 0.0)
    usage.setdefault("month_spend_usd", 0.0)
    usage.setdefault("month_requests", 0)
    usage.setdefault("month_summaries", 0)
    usage.setdefault("day_requests", 0)
    usage.setdefault("day_summaries", 0)
    usage["limits"] = limits
    return usage


def save_ai_usage(usage: dict, now: datetime):
    usage["updated_at"] = now.isoformat().replace("+00:00", "Z")
    AI_USAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
    AI_USAGE_PATH.write_text(json.dumps(usage, ensure_ascii=False, indent=2), encoding="utf-8")


def estimated_max_call_cost(source_text: str, title: str, source: str, prefs: dict) -> float:
    """Réserve un coût volontairement conservateur avant chaque appel.

    Pour du texte français/latin, 1 caractère = 1 token est une forte surestimation.
    Elle évite qu'un dernier appel puisse franchir le plafond mensuel configuré.
    """
    cfg = prefs.get("ai", {}) or {}
    limits = ai_limits(prefs)
    max_chars = int(cfg.get("max_input_chars", 9000))
    max_output_tokens = int(cfg.get("max_output_tokens", 220))
    input_chars = min(len(source_text or ""), max_chars) + len(title or "") + len(source or "") + 3500
    conservative_input_tokens = input_chars
    return (
        conservative_input_tokens * limits["input_price_per_million_usd"] / 1_000_000
        + max_output_tokens * limits["output_price_per_million_usd"] / 1_000_000
    )


def actual_call_cost(data: dict, prefs: dict) -> tuple[int, int, float]:
    usage = data.get("usage") or {}
    input_tokens = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
    output_tokens = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
    limits = ai_limits(prefs)
    cost = (
        input_tokens * limits["input_price_per_million_usd"] / 1_000_000
        + output_tokens * limits["output_price_per_million_usd"] / 1_000_000
    )
    return input_tokens, output_tokens, cost


def ai_can_call(usage: dict, source_text: str, title: str, source: str, prefs: dict) -> tuple[bool, str]:
    limits = ai_limits(prefs)
    if int(usage.get("day_requests", 0)) >= limits["daily_summary_limit"]:
        return False, "daily_limit"
    remaining = limits["monthly_budget_usd"] - float(usage.get("month_spend_usd", 0.0))
    reserve = estimated_max_call_cost(source_text, title, source, prefs)
    if remaining <= 0 or reserve > remaining:
        return False, "monthly_budget"
    return True, ""


def ai_summary(title: str, source: str, source_text: str, basis: str, prefs: dict) -> dict:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        return {"summary": "", "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
    ai_cfg = prefs.get("ai", {})
    model = os.getenv("OPENAI_MODEL", ai_cfg.get("model", "gpt-5.6-luna"))
    max_chars = int(ai_cfg.get("max_input_chars", 9000))
    min_words = int(ai_cfg.get("summary_min_words", 35))
    max_words = int(ai_cfg.get("summary_max_words", 70))
    max_output_tokens = int(ai_cfg.get("max_output_tokens", 220))
    prompt = (
        "Tu rédiges les résumés de Lénaïc Express. Résume uniquement les informations présentes dans le texte fourni. "
        "N'ajoute aucun fait, chiffre, contexte ou conclusion absent du texte. Style journalistique neutre, français naturel, "
        f"un seul paragraphe de {min_words} à {max_words} mots. Pas de titre, pas de puces, pas de markdown. "
        "Si le texte est trop pauvre pour produire un résumé fiable, réponds exactement INSUFFICIENT."
    )
    user = f"Titre : {title}\nSource : {source}\nBase disponible : {basis}\n\nTexte :\n{source_text[:max_chars]}"
    payload = {
        "model": model,
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": prompt}]},
            {"role": "user", "content": [{"type": "input_text", "text": user}]},
        ],
        "max_output_tokens": max_output_tokens,
    }
    try:
        r = requests.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=45,
        )
        if not r.ok:
            print(f"AI ERR {r.status_code}: {r.text[:240]}", file=sys.stderr)
            return {"summary": "", "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
        data = r.json()
        input_tokens, output_tokens, cost_usd = actual_call_cost(data, prefs)
        text = response_text(data).strip()
        if not text or text.upper() == "INSUFFICIENT":
            text = ""
        return {
            "summary": re.sub(r"\s+", " ", text).strip(),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": cost_usd,
        }
    except Exception as exc:
        print(f"AI ERR: {exc}", file=sys.stderr)
        return {"summary": "", "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}


def enrich_articles(articles: list[dict], prefs: dict, old_payload: dict, now: datetime, ai_usage: dict):
    old_articles = old_payload.get("articles", []) if isinstance(old_payload, dict) else []
    old_by_title = {normalize(a.get("title", "")): a for a in old_articles if a.get("title")}
    ai_cfg = prefs.get("ai", {})
    ai_enabled = bool(ai_cfg.get("enabled", True)) and bool(os.getenv("OPENAI_API_KEY", "").strip())
    per_run_limit = int(ai_cfg.get("max_summaries_per_run", 20)) if ai_enabled else 0
    ai_calls_this_run = 0
    ai_summaries_this_run = 0
    pending = 0
    blocked_reason = ""

    for a in articles:
        old = old_by_title.get(normalize(a.get("title", "")), {})

        # Un article déjà enrichi est conservé tel quel : on évite de retélécharger
        # et de repayer un résumé à chaque passage du workflow.
        if old.get("ai_summary"):
            for key in (
                "resolved_url", "paywalled", "archive_url", "archive_status",
                "content_hash", "ai_summary", "ai_summary_basis", "ai_summary_at",
                "ai_summary_model", "why_for_you"
            ):
                if key in old:
                    a[key] = old[key]
            a["why_for_you"] = []
            if a.get("watch_matches"):
                a["why_for_you"].append("veille : " + ", ".join(a["watch_matches"][:2]))
            if a.get("matched_keywords"):
                a["why_for_you"].append("mots-clés : " + ", ".join(a["matched_keywords"][:3]))
            if not a["why_for_you"]:
                a["why_for_you"].append("rubrique prioritaire")
            continue

        # On ne télécharge le texte intégral que si un appel IA est encore envisageable.
        extracted = {"resolved_url": a.get("url", ""), "text": "", "paywalled": False, "status": "skipped"}
        can_attempt = ai_enabled and ai_calls_this_run < per_run_limit
        if can_attempt:
            extracted = extract_article_text(a.get("url", ""))

        a["resolved_url"] = extracted.get("resolved_url") or a.get("url", "")
        a["paywalled"] = bool(extracted.get("paywalled")) or known_paywall(a.get("source", ""), prefs)

        article_text = extracted.get("text", "")
        if len(article_text) >= 500:
            basis_text = article_text
            basis = "article"
        elif len(a.get("summary", "")) >= 90:
            basis_text = a.get("summary", "")
            basis = "rss"
        else:
            basis_text = ""
            basis = "insufficient"

        a["content_hash"] = sha_text(basis_text) if basis_text else ""
        a["ai_summary"] = ""
        a["ai_summary_basis"] = ""
        a["ai_summary_at"] = ""
        a["ai_summary_model"] = ""

        if basis_text and can_attempt:
            allowed, reason = ai_can_call(ai_usage, basis_text, a["title"], a.get("source", ""), prefs)
            if allowed:
                result = ai_summary(a["title"], a.get("source", ""), basis_text, basis, prefs)
                # Une requête réussie au niveau HTTP est comptabilisée dès qu'une consommation est remontée.
                if result.get("input_tokens") or result.get("output_tokens"):
                    ai_calls_this_run += 1
                    ai_usage["day_requests"] = int(ai_usage.get("day_requests", 0)) + 1
                    ai_usage["month_requests"] = int(ai_usage.get("month_requests", 0)) + 1
                    cost = float(result.get("cost_usd", 0.0))
                    ai_usage["month_spend_usd"] = round(float(ai_usage.get("month_spend_usd", 0.0)) + cost, 8)
                    ai_usage["lifetime_spend_usd"] = round(float(ai_usage.get("lifetime_spend_usd", 0.0)) + cost, 8)
                summary = result.get("summary", "")
                if summary:
                    a["ai_summary"] = summary
                    a["ai_summary_basis"] = basis
                    a["ai_summary_at"] = now.isoformat().replace("+00:00", "Z")
                    a["ai_summary_model"] = os.getenv("OPENAI_MODEL", ai_cfg.get("model", "gpt-5.6-luna"))
                    ai_summaries_this_run += 1
                    ai_usage["day_summaries"] = int(ai_usage.get("day_summaries", 0)) + 1
                    ai_usage["month_summaries"] = int(ai_usage.get("month_summaries", 0)) + 1
            else:
                blocked_reason = reason
                pending += 1
        elif basis_text:
            pending += 1

        # Archive.is : vérification best-effort, sans utiliser le contenu de l'archive
        # pour générer le résumé IA.
        if a["paywalled"]:
            archive = archive_lookup(a["resolved_url"])
            a["archive_url"] = archive.get("snapshot_url") or archive.get("lookup_url")
            a["archive_status"] = archive.get("status", "unknown")
        else:
            a["archive_url"] = ""
            a["archive_status"] = "not_needed"

        a["why_for_you"] = []
        if a.get("watch_matches"):
            a["why_for_you"].append("veille : " + ", ".join(a["watch_matches"][:2]))
        if a.get("matched_keywords"):
            a["why_for_you"].append("mots-clés : " + ", ".join(a["matched_keywords"][:3]))
        if not a["why_for_you"]:
            a["why_for_you"].append("rubrique prioritaire")

    return ai_summaries_this_run, ai_calls_this_run, pending, blocked_reason

def main():
    sources_cfg = load_json(SOURCES_PATH, {"sources": []})
    prefs = load_json(PREFS_PATH, {})
    watches_cfg = load_json(WATCHES_PATH, {"watches": []}) or {"watches": []}
    old_payload = load_json(OUTPUT_PATH, {}) or {}
    now = datetime.now(timezone.utc)
    max_age = timedelta(days=int(prefs.get("max_age_days", 10)))
    per_source = int(prefs.get("per_source_limit", 28))
    max_articles = int(prefs.get("max_articles", 160))
    all_articles = []
    errors = []

    sources = list(sources_cfg.get("sources", [])) + prepare_watch_sources(watches_cfg)
    for source in sources:
        if not source.get("enabled", True):
            continue
        try:
            items = parse_feed(source, prefs)[:per_source]
            kept = 0
            for a in items:
                published = datetime.fromisoformat(a["published_at"].replace("Z", "+00:00"))
                if now - published <= max_age:
                    a["score"], a["matched_keywords"], a["watch_matches"] = article_score(a, source, prefs, now, watches_cfg)
                    all_articles.append(a)
                    kept += 1
            print(f"OK  {source['name']}: {kept} entrée(s) retenue(s)")
        except Exception as exc:
            errors.append({"source": source.get("name", source.get("id")), "error": str(exc)})
            print(f"ERR {source.get('name')}: {exc}", file=sys.stderr)

    all_articles = dedupe(sorted(all_articles, key=lambda a: (a["score"], a["published_at"]), reverse=True))
    all_articles = apply_category_limits(all_articles, prefs, max_articles)

    if not all_articles and OUTPUT_PATH.exists():
        old_payload["last_attempt_at"] = now.isoformat().replace("+00:00", "Z")
        old_payload["fetch_errors"] = errors
        OUTPUT_PATH.write_text(json.dumps(old_payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print("Aucun nouvel article : édition précédente conservée.")
        return

    ai_usage = load_ai_usage(prefs, now)
    ai_done, ai_calls, ai_pending, ai_blocked_reason = enrich_articles(all_articles, prefs, old_payload, now, ai_usage)
    save_ai_usage(ai_usage, now)
    payload = {
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "mode": "live",
        "article_count": len(all_articles),
        "watch_count": len([w for w in watches_cfg.get("watches", []) if w.get("enabled", True)]),
        "ai": {
            "enabled": bool(os.getenv("OPENAI_API_KEY", "").strip()) and bool(prefs.get("ai", {}).get("enabled", True)),
            "model": os.getenv("OPENAI_MODEL", prefs.get("ai", {}).get("model", "gpt-5.6-luna")),
            "generated_this_run": ai_done,
            "requests_this_run": ai_calls,
            "pending": ai_pending,
            "blocked_reason": ai_blocked_reason,
            "budget": {
                "month": ai_usage.get("month"),
                "spent_usd": ai_usage.get("month_spend_usd", 0.0),
                "limit_usd": ai_usage.get("limits", {}).get("monthly_budget_usd"),
                "day": ai_usage.get("day"),
                "requests_today": ai_usage.get("day_requests", 0),
                "summaries_today": ai_usage.get("day_summaries", 0),
                "daily_summary_limit": ai_usage.get("limits", {}).get("daily_summary_limit"),
            },
        },
        "fetch_errors": errors,
        "articles": all_articles,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Écrit: {OUTPUT_PATH} ({len(all_articles)} articles, {ai_done} résumé(s) IA généré(s))")


if __name__ == "__main__":
    main()
