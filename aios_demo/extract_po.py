"""Extract evidence and preview a purchase order without writing to ERP."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import subprocess

from .parsing import MAX_UPLOAD_BYTES, Parsed, parse_page, read_image
from .routing import VisionReader, configured_vision, order_payload, route_on_demand


def extraction_result(data: bytes, parsed: Parsed, evidence: dict, mode: str) -> dict:
    review_fields = [name for name, field in evidence["fields"].items()
                     if field["confirmed"] is None]
    return {
        **evidence,
        "schema_version": 1,
        "mode": mode,
        "artifact_sha256": sha256(data).hexdigest(),
        "image_width": parsed.page.width,
        "image_height": parsed.page.height,
        "review_fields": review_fields,
        "status": "needs_review" if review_fields or not evidence["complete"] else "ready_for_preview",
        "metrics": {
            "vision_calls": sum(len(field["vision"]) for field in evidence["fields"].values()),
            **evidence.get("metrics", {}),
            "auto_passed_fields": len(evidence["fields"]) - len(review_fields),
            "disputed_fields": len(review_fields),
            "rules_blocked_count": sum(bool(f.get("initial_reading")) for f in evidence["fields"].values()),
            "memories_saved": 0,
        },
    }


def analyze_upload(data: bytes, reader: VisionReader | None = None, *, memory=None) -> tuple[dict, Parsed]:
    parsed = parse_page(read_image(data))
    evidence = route_on_demand(parsed, reader, memory=memory)
    mode = "vision-on-demand" if reader else "ocr"
    result = extraction_result(data, parsed, evidence, mode)
    result["reader_mode"] = "Live vision on demand" if reader else "Local OCR only"
    return result, parsed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document", type=Path)
    parser.add_argument("--mode", choices=("ocr", "vision-on-demand"), default="ocr")
    args = parser.parse_args()
    try:
        reader = configured_vision() if args.mode == "vision-on-demand" else None
    except ValueError as error:
        print(json.dumps({"schema_version": 1, "status": "error",
                          "error_code": "VISION_CONFIGURATION", "message": str(error)}))
        return 1
    try:
        with args.document.open("rb") as file:
            evidence, _ = analyze_upload(file.read(MAX_UPLOAD_BYTES + 1), reader)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"schema_version": 1, "status": "error", "error_code": "EXTRACTION_FAILED",
                          "message": str(error)}))
        return 1
    draft = order_payload(evidence) if evidence["status"] == "ready_for_preview" else None
    print(json.dumps({**evidence, "filename": args.document.name, "draft": draft}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
