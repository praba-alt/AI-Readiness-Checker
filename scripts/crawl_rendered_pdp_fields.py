#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import json
import re
import socket
from collections import defaultdict
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, List
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


USER_AGENT = "CodexRenderedPDPAudit/1.0"


class ImgParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.images: List[Dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: List[tuple[str, str | None]]) -> None:
        if tag.lower() == "img":
            self.images.append({key: value or "" for key, value in attrs})


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def strip_html(value: str) -> str:
    return clean_text(re.sub(r"<[^>]+>", " ", value or ""))


def fetch_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=20) as response:
        return response.read().decode("utf-8", errors="replace")


def get_first(rows: List[Dict[str, str]], field: str) -> str:
    for row in rows:
        value = (row.get(field) or "").strip()
        if value:
            return value
    return ""


def parse_meta(html: str, key: str, attr: str = "name") -> str:
    pattern = re.compile(
        rf'<meta[^>]*{attr}=["\']{re.escape(key)}["\'][^>]*content=["\']([^"\']*)["\']',
        re.IGNORECASE,
    )
    match = pattern.search(html)
    return clean_text(match.group(1)) if match else ""


def parse_title(html: str) -> str:
    match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    return clean_text(match.group(1)) if match else ""


def parse_jsonld_types(html: str) -> List[str]:
    blocks = re.findall(
        r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html,
        re.IGNORECASE | re.DOTALL,
    )
    found: List[str] = []
    for block in blocks:
        text = block.replace("\\/", "/")
        found.extend(re.findall(r'"@type"\s*:\s*"([^"]+)"', text))
    deduped = []
    seen = set()
    for item in found:
        if item not in seen:
            seen.add(item)
            deduped.append(item)
    return deduped


def image_bucket(img: Dict[str, str]) -> str:
    src = (img.get("src") or img.get("data-src") or "").lower()
    classes = (img.get("class") or "").lower()
    alt = (img.get("alt") or "").strip()
    if any(marker in src for marker in ["/products/", "/files/"]) and any(
        marker in classes for marker in ["rounded", "product", "zoom", "media", "gallery"]
    ):
        return "product_gallery"
    if alt and "trailberg.com/cdn/shop/files/" in src and "header__logo-image" not in classes:
        return "possible_product_media"
    return "other"


def analyze_product(handle: str, rows: List[Dict[str, str]], base_url: str) -> Dict[str, Any]:
    primary_title = get_first(rows, "Title")
    csv_seo_title = get_first(rows, "SEO Title")
    csv_seo_description = get_first(rows, "SEO Description")
    csv_body_text = strip_html(get_first(rows, "Body (HTML)"))
    csv_image_alts = [clean_text(row.get("Image Alt Text") or "") for row in rows if (row.get("Image Src") or "").strip()]
    csv_image_alts_nonempty = [alt for alt in csv_image_alts if alt]

    url = f"{base_url.rstrip('/')}/products/{quote(handle, safe='')}"
    try:
        html = fetch_text(url)
    except (HTTPError, URLError, TimeoutError, socket.timeout, Exception) as error:
        return {"handle": handle, "url": url, "ok": False, "error": str(error)}

    parser = ImgParser()
    parser.feed(html)

    title = parse_title(html)
    meta_description = parse_meta(html, "description")
    og_title = parse_meta(html, "og:title", attr="property")
    og_description = parse_meta(html, "og:description", attr="property")
    twitter_image_alt = parse_meta(html, "twitter:image:alt")
    jsonld_types = parse_jsonld_types(html)

    product_gallery_images = []
    other_images = []
    for image in parser.images:
        bucket = image_bucket(image)
        entry = {
            "alt": clean_text(image.get("alt") or ""),
            "src": image.get("src") or image.get("data-src") or "",
            "class": image.get("class") or "",
        }
        if bucket == "product_gallery":
            product_gallery_images.append(entry)
        else:
            other_images.append(entry)

    if not product_gallery_images:
        product_gallery_images = [
            image
            for image in other_images
            if image["alt"] == primary_title and "cdn/shop/files/" in image["src"]
        ]

    gallery_alt_nonempty = sum(1 for image in product_gallery_images if image["alt"])
    gallery_alt_match_title = sum(1 for image in product_gallery_images if image["alt"] == primary_title)
    other_alt_nonempty = sum(1 for image in other_images if image["alt"])

    meta_desc_matches_body_prefix = False
    if meta_description and csv_body_text:
        normalized_body = csv_body_text.lower()
        normalized_meta = meta_description.lower()
        meta_desc_matches_body_prefix = normalized_body.startswith(normalized_meta[: min(len(normalized_meta), 120)])

    return {
        "handle": handle,
        "url": url,
        "ok": True,
        "csv": {
            "title": primary_title,
            "seo_title": csv_seo_title,
            "seo_description": csv_seo_description,
            "image_alt_nonempty_count": len(csv_image_alts_nonempty),
            "image_alt_total_count": len(csv_image_alts),
        },
        "rendered": {
            "title": title,
            "meta_description": meta_description,
            "og_title": og_title,
            "og_description": og_description,
            "twitter_image_alt": twitter_image_alt,
            "jsonld_types": jsonld_types,
            "product_gallery_image_count": len(product_gallery_images),
            "product_gallery_alt_nonempty_count": gallery_alt_nonempty,
            "product_gallery_alt_match_title_count": gallery_alt_match_title,
            "other_image_count": len(other_images),
            "other_image_alt_nonempty_count": other_alt_nonempty,
            "meta_desc_matches_body_prefix": meta_desc_matches_body_prefix,
        },
    }


def summarize(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    ok_results = [result for result in results if result.get("ok")]
    failures = [result for result in results if not result.get("ok")]

    rendered_meta_from_blank_csv = [
        result for result in ok_results if not result["csv"]["seo_description"] and result["rendered"]["meta_description"]
    ]
    rendered_title_from_blank_csv = [
        result for result in ok_results if not result["csv"]["seo_title"] and result["rendered"]["title"]
    ]
    rendered_gallery_alt_from_blank_csv = [
        result
        for result in ok_results
        if result["csv"]["image_alt_nonempty_count"] == 0 and result["rendered"]["product_gallery_alt_nonempty_count"] > 0
    ]
    rendered_gallery_alt_matching_title = [
        result
        for result in ok_results
        if result["rendered"]["product_gallery_image_count"] > 0
        and result["rendered"]["product_gallery_image_count"] == result["rendered"]["product_gallery_alt_match_title_count"]
    ]

    return {
        "totals": {
            "products_crawled": len(results),
            "products_ok": len(ok_results),
            "products_failed": len(failures),
        },
        "coverage": {
            "blank_csv_seo_title_but_rendered_title_pct": round(len(rendered_title_from_blank_csv) / max(len(ok_results), 1) * 100, 2),
            "blank_csv_seo_description_but_rendered_meta_description_pct": round(len(rendered_meta_from_blank_csv) / max(len(ok_results), 1) * 100, 2),
            "blank_csv_image_alt_but_rendered_gallery_alt_pct": round(len(rendered_gallery_alt_from_blank_csv) / max(len(ok_results), 1) * 100, 2),
            "all_gallery_alts_match_product_title_pct": round(len(rendered_gallery_alt_matching_title) / max(len(ok_results), 1) * 100, 2),
            "rendered_product_jsonld_pct": round(
                sum(1 for result in ok_results if any(item in {"Product", "ProductGroup"} for item in result["rendered"]["jsonld_types"]))
                / max(len(ok_results), 1)
                * 100,
                2,
            ),
            "twitter_image_alt_present_pct": round(
                sum(1 for result in ok_results if result["rendered"]["twitter_image_alt"])
                / max(len(ok_results), 1)
                * 100,
                2,
            ),
        },
        "examples": {
            "rendered_meta_from_blank_csv": [result["handle"] for result in rendered_meta_from_blank_csv[:10]],
            "rendered_gallery_alt_from_blank_csv": [result["handle"] for result in rendered_gallery_alt_from_blank_csv[:10]],
            "crawl_failures": [{"handle": result["handle"], "error": result["error"]} for result in failures[:10]],
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    with Path(args.input).open(newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))

    grouped: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for row in rows:
        grouped[row["Handle"]].append(row)

    results = [analyze_product(handle, handle_rows, args.base_url) for handle, handle_rows in grouped.items()]
    output = {
        "source_csv": args.input,
        "base_url": args.base_url,
        "summary": summarize(results),
        "results": results,
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
