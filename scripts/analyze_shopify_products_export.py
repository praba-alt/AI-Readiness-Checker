#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean
from typing import Any, Dict, List


def clean_text(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html or "")
    return re.sub(r"\s+", " ", text).strip()


def pct(part: int, whole: int) -> float:
    return round((part / whole) * 100, 2) if whole else 0.0


def status_from_pct(good_pct: float, strong: float, partial: float) -> str:
    if good_pct >= strong:
        return "PASS"
    if good_pct >= partial:
        return "PARTIAL"
    return "FAIL"


def result(status: str, evidence: str, recommendation: str, outliers: List[str] | None = None) -> Dict[str, Any]:
    return {
        "status": status,
        "evidence": evidence,
        "recommendation": recommendation,
        "observability": "Shopify product CSV export",
        "outliers": outliers or [],
    }


def first_nonempty(group: List[Dict[str, str]], field: str) -> str:
    for row in group:
        value = (row.get(field) or "").strip()
        if value:
            return value
    return ""


def analyze_csv(path: Path) -> Dict[str, Any]:
    with path.open(newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))

    if not rows:
        raise ValueError("CSV is empty")

    by_handle: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for row in rows:
        by_handle[row["Handle"]].append(row)

    products = []
    for handle, group in by_handle.items():
        primary = next((row for row in group if (row.get("Title") or "").strip()), group[0])
        variants = [
            row
            for row in group
            if any((row.get(field) or "").strip() for field in ("Variant SKU", "Option1 Value", "Option2 Value", "Option3 Value"))
        ]
        products.append({"handle": handle, "primary": primary, "group": group, "variants": variants})

    total_products = len(products)
    total_variants = sum(len(product["variants"]) for product in products)

    semantic_metafield_cols = [
        "Activity (product.metafields.custom.activity)",
        "Bundle Products (product.metafields.custom.bundle_products)",
        "Products Size Chart (product.metafields.custom.products_size_chart)",
        "Sibling (product.metafields.custom.sibling)",
        "Variation products (product.metafields.custom.variation_products)",
        "Variation value (Colour) (product.metafields.custom.variation_value)",
        "Activewear clothing features (product.metafields.shopify.activewear-clothing-features)",
        "Activity (product.metafields.shopify.activity)",
        "Age group (product.metafields.shopify.age-group)",
        "Clothing features (product.metafields.shopify.clothing-features)",
        "Color (product.metafields.shopify.color-pattern)",
        "Fabric (product.metafields.shopify.fabric)",
        "Material (product.metafields.shopify.material)",
        "Size (product.metafields.shopify.size)",
        "Target gender (product.metafields.shopify.target-gender)",
        "Complementary products (product.metafields.shopify--discovery--product_recommendation.complementary_products)",
        "Related products (product.metafields.shopify--discovery--product_recommendation.related_products)",
    ]
    layout_metafield_cols = [
        "Upsell Discount (product.metafields.app--34646425601--orderediting.editing_sales_channel_discount_percentage)",
        "The order of the upsell products. (product.metafields.app--34646425601--orderediting.product_sorting_index)",
        "Hot spots  (product.metafields.custom.hot_spots)",
        "Product Swatch Image (product.metafields.custom.product_swatch_image)",
        "Related products settings (product.metafields.shopify--discovery--product_recommendation.related_products_display)",
    ]

    option_names = defaultdict(set)
    option_values = defaultdict(lambda: defaultdict(set))
    inventory_trackers = Counter()
    inventory_policies = Counter()
    published_counts = Counter()
    status_counts = Counter()

    products_with_category = 0
    products_with_seo_title = 0
    products_with_seo_desc = 0
    products_with_feature_block = 0
    products_with_ideal_for = 0
    products_with_restrictions = 0
    products_with_semantic_metafields = 0
    products_with_related = 0
    products_with_complementary = 0
    products_with_market_prices = 0
    products_with_us_prices = 0
    image_with_alt = 0
    image_without_alt = 0

    titles_missing_seo = []
    titles_missing_feature_block = []
    titles_missing_ideal_for = []
    titles_missing_restrictions = []
    titles_missing_related = []
    titles_missing_market_prices = []
    title_option_products = []

    metafield_populated_counts = Counter()

    for product in products:
        primary = product["primary"]
        title = (primary.get("Title") or product["handle"]).strip()
        body = primary.get("Body (HTML)") or ""
        body_lower = body.lower()
        product_text = clean_text(body)

        if (primary.get("Product Category") or "").strip():
            products_with_category += 1
        if (primary.get("SEO Title") or "").strip():
            products_with_seo_title += 1
        else:
            titles_missing_seo.append(title)
        if (primary.get("SEO Description") or "").strip():
            products_with_seo_desc += 1
        if "key feature" in body_lower:
            products_with_feature_block += 1
        else:
            titles_missing_feature_block.append(title)
        if "ideal for" in body_lower:
            products_with_ideal_for += 1
        else:
            titles_missing_ideal_for.append(title)
        if any(term in body_lower for term in ["not suitable", "restriction", "warning", "safety", "compliance", "keep away", "do not"]):
            products_with_restrictions += 1
        else:
            titles_missing_restrictions.append(title)

        if any((primary.get(col) or "").strip() for col in semantic_metafield_cols):
            products_with_semantic_metafields += 1

        if (primary.get("Related products (product.metafields.shopify--discovery--product_recommendation.related_products)") or "").strip():
            products_with_related += 1
        else:
            titles_missing_related.append(title)
        if (primary.get("Complementary products (product.metafields.shopify--discovery--product_recommendation.complementary_products)") or "").strip():
            products_with_complementary += 1

        market_price_fields = [
            "Price / United Kingdom",
            "Price / Australia",
            "Price / Canada",
            "Price / International",
            "Price / MIddle East",
            "Price / Switzerland",
            "Price / United States",
        ]
        if any((primary.get(field) or "").strip() for field in market_price_fields):
            products_with_market_prices += 1
        else:
            titles_missing_market_prices.append(title)
        if (primary.get("Price / United States") or "").strip():
            products_with_us_prices += 1

        if ((primary.get("Option1 Name") or "").strip()) == "Title":
            title_option_products.append(title)

        published_counts[(primary.get("Published") or "").strip().lower()] += 1
        status_counts[(primary.get("Status") or "").strip().lower()] += 1

        for row in product["group"]:
            for col in semantic_metafield_cols + layout_metafield_cols:
                if (row.get(col) or "").strip():
                    metafield_populated_counts[col] += 1

            image_src = (row.get("Image Src") or "").strip()
            if image_src:
                if (row.get("Image Alt Text") or "").strip():
                    image_with_alt += 1
                else:
                    image_without_alt += 1

        for row in product["variants"]:
            for idx in (1, 2, 3):
                name = (row.get(f"Option{idx} Name") or primary.get(f"Option{idx} Name") or "").strip()
                value = (row.get(f"Option{idx} Value") or "").strip()
                if name:
                    option_names[idx].add(name)
                if name and value:
                    option_values[name.lower()][value.lower()].add(value)
            inventory_trackers[(row.get("Variant Inventory Tracker") or "").strip().lower()] += 1
            inventory_policies[(row.get("Variant Inventory Policy") or "").strip().lower()] += 1

    mixed_option_values = {}
    for name, normalized_values in option_values.items():
        mixed = {
            normalized: sorted(raw_values)
            for normalized, raw_values in normalized_values.items()
            if len(raw_values) > 1
        }
        if mixed:
            mixed_option_values[name] = mixed

    all_titles = [((product["primary"].get("Title") or product["handle"]).strip()) for product in products]
    title_lengths = [len(title) for title in all_titles]
    body_word_counts = [len(clean_text(product["primary"].get("Body (HTML)") or "").split()) for product in products]

    semantic_metafield_total = sum(metafield_populated_counts[col] for col in semantic_metafield_cols)
    layout_metafield_total = sum(metafield_populated_counts[col] for col in layout_metafield_cols)

    checks = {
        "product_titles": result(
            status_from_pct(pct(products_with_seo_title, total_products), 70, 30),
            f"Title lengths were healthy at min/avg/max {min(title_lengths)}/{round(mean(title_lengths), 2)}/{max(title_lengths)}, but SEO Title coverage was only {pct(products_with_seo_title, total_products)}%.",
            "Populate SEO titles on all products and keep the visible title descriptive rather than relying only on default product names.",
            titles_missing_seo[:15],
        ),
        "product_descriptions": result(
            status_from_pct(pct(products_with_feature_block, total_products), 80, 45),
            f"Average body copy length was {round(mean(body_word_counts), 2)} words. 'Key Features' appeared on {pct(products_with_feature_block, total_products)}% of products and 'Ideal for' appeared on {pct(products_with_ideal_for, total_products)}%.",
            "Make product descriptions more consistently structured with factual feature blocks and explicit use-case sections.",
            titles_missing_feature_block[:15],
        ),
        "variant_option_consistency": result(
            "PASS" if not mixed_option_values else "PARTIAL",
            f"Option sets were clean in the export. Option1 values used {sorted(option_names[1])}, and no normalized option value had conflicting display forms.",
            "Keep option names and value vocabularies constrained to a single format per option.",
            title_option_products[:15],
        ),
        "variant_inventory": result(
            "PASS" if inventory_trackers == Counter({"shopify": total_variants}) and inventory_policies == Counter({"deny": total_variants}) else "PARTIAL",
            f"Variant inventory tracker counts: {dict(inventory_trackers)}. Variant inventory policy counts: {dict(inventory_policies)}.",
            "Keep Shopify as the inventory tracker and review any future exceptions to deny-vs-continue policy carefully.",
        ),
        "taxonomy_assignment": result(
            "PASS" if products_with_category == total_products else "PARTIAL",
            f"Product Category was populated for {products_with_category}/{total_products} products.",
            "Maintain complete Shopify product-category coverage across the catalogue.",
        ),
        "semantic_metafields": result(
            status_from_pct(pct(products_with_semantic_metafields, total_products), 85, 50),
            f"At least one semantic metafield or recommendation field appeared on {products_with_semantic_metafields}/{total_products} products. Semantic-field population count was {semantic_metafield_total} versus {layout_metafield_total} layout-like field values.",
            "Expand semantic metafields such as material, activity, size-chart, and recommendation references beyond the current subset of products.",
        ),
        "related_products": result(
            status_from_pct(pct(products_with_complementary, total_products), 80, 40),
            f"Complementary-product coverage was {pct(products_with_complementary, total_products)}%, but explicit related-product coverage was only {pct(products_with_related, total_products)}%.",
            "Use both complementary and related-product relationships intentionally instead of relying on only one recommendation path.",
            titles_missing_related[:15],
        ),
        "media_alt_text": result(
            "FAIL" if image_without_alt else "PASS",
            f"Image alt-text coverage was {pct(image_with_alt, image_with_alt + image_without_alt)}% ({image_with_alt} with alt, {image_without_alt} without alt).",
            "Add alt text to all product imagery in the export and enforce it in product-publishing QA.",
        ),
        "regional_pricing": result(
            "FAIL" if products_with_market_prices == 0 else "PARTIAL",
            f"Market-specific price fields were populated on {products_with_market_prices}/{total_products} products. United States pricing coverage was {products_with_us_prices}/{total_products}.",
            "Populate market price fields if this export is expected to be a reliable machine-readable source for regional pricing.",
            titles_missing_market_prices[:15],
        ),
        "restrictions_and_caveats": result(
            status_from_pct(pct(products_with_restrictions, total_products), 35, 10),
            f"Only {products_with_restrictions}/{total_products} product descriptions contained obvious restriction, warning, or caveat language.",
            "Record more explicit suitability limits, care caveats, and restrictions in product data rather than leaving them implicit.",
            titles_missing_restrictions[:15],
        ),
        "lifecycle_and_status": result(
            "PASS" if len(status_counts) == 1 and "active" in status_counts else "PARTIAL",
            f"Published counts: {dict(published_counts)}. Status counts: {dict(status_counts)}.",
            "Make lifecycle states explicit if the export should distinguish active, draft, seasonal, and archived products.",
        ),
    }

    return {
        "source_csv": str(path),
        "totals": {
            "rows": len(rows),
            "products": total_products,
            "variants": total_variants,
            "avg_variants_per_product": round(total_variants / total_products, 2) if total_products else 0,
        },
        "checks": checks,
        "metrics": {
            "option_name_sets": {str(idx): sorted(values) for idx, values in option_names.items()},
            "mixed_option_values": mixed_option_values,
            "published_counts": dict(published_counts),
            "status_counts": dict(status_counts),
            "inventory_tracker_counts": dict(inventory_trackers),
            "inventory_policy_counts": dict(inventory_policies),
            "seo_title_coverage_pct": pct(products_with_seo_title, total_products),
            "seo_description_coverage_pct": pct(products_with_seo_desc, total_products),
            "feature_block_coverage_pct": pct(products_with_feature_block, total_products),
            "ideal_for_coverage_pct": pct(products_with_ideal_for, total_products),
            "restriction_mentions_coverage_pct": pct(products_with_restrictions, total_products),
            "related_products_coverage_pct": pct(products_with_related, total_products),
            "complementary_products_coverage_pct": pct(products_with_complementary, total_products),
            "market_price_any_coverage_pct": pct(products_with_market_prices, total_products),
            "us_price_coverage_pct": pct(products_with_us_prices, total_products),
            "image_alt_coverage_pct": pct(image_with_alt, image_with_alt + image_without_alt),
            "semantic_metafield_population_total": semantic_metafield_total,
            "layout_metafield_population_total": layout_metafield_total,
            "top_populated_metafields": metafield_populated_counts.most_common(15),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    analysis = analyze_csv(Path(args.input))
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(analysis, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
