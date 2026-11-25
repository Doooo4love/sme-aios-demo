"""Reproducible work-boundary scorecard and local concurrent classifier benchmark."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
import json
import math
from pathlib import Path
import platform
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aios_platform.identity import DemoIdentity
from aios_platform.security_guard import evaluate_work_boundary

CORPUS = ROOT / "fixtures" / "work_boundary_eval.tsv"


def load_cases():
    with CORPUS.open(encoding="utf-8", newline="") as source:
        return [
            (row["expected"] == "off_topic", row["language"], row["text"], row["previous_user_text"] or None)
            for row in csv.DictReader(source, delimiter="\t", restval="")
        ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--requests", type=int, default=20_000)
    parser.add_argument("--workers", type=int, default=16)
    args = parser.parse_args()
    if args.requests < 1 or not 1 <= args.workers <= 64:
        parser.error("requests must be positive and workers must be 1–64")

    identity = DemoIdentity("x" * 32)
    actors = [identity.directory_actor("harbour", subject) for subject in (
        "viewer", "operator", "manager", "access-admin",
    )]
    cases = load_cases()
    results = []
    confusion = {"tp": 0, "tn": 0, "fp": 0, "fn": 0}
    breakdown = {}
    misses = []
    for expected, language, message, previous in cases:
        decisions = [
            evaluate_work_boundary(actor, message, previous_user_text=previous).is_off_topic for actor in actors
        ]
        if len(set(decisions)) != 1:
            raise AssertionError("Personal-chat routing differed by role")
        detected = decisions[0]
        results.append(detected)
        key = ("t" if detected == expected else "f") + ("p" if detected else "n")
        confusion[key] += 1
        counts = breakdown.setdefault(language, {"tp": 0, "tn": 0, "fp": 0, "fn": 0})
        counts[key] += 1
        if detected != expected:
            misses.append({"language": language, "text": message, "error": key})

    def job(index):
        case_index = index % len(cases)
        _, _, message, previous = cases[case_index]
        actor = actors[index % len(actors)]
        start = time.perf_counter_ns()
        detected = evaluate_work_boundary(actor, message, previous_user_text=previous).is_off_topic
        return time.perf_counter_ns() - start, detected == results[case_index]

    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        runs = list(executor.map(job, range(args.requests)))
    elapsed = time.perf_counter() - start
    latencies = sorted(value for value, _ in runs)
    mismatches = sum(not identical for _, identical in runs)
    tp, tn, fp, fn = (confusion[key] for key in ("tp", "tn", "fp", "fn"))
    print(json.dumps({
        "corpus_cases": len(cases),
        "metrics": {
            **confusion,
            "accuracy_pct": round(100 * (tp + tn) / len(cases), 2),
            "off_topic_recall_pct": round(100 * tp / (tp + fn), 2),
            "false_positive_rate_pct": round(100 * fp / (tn + fp), 2),
        },
        "languages": breakdown,
        "misses": misses,
        "classifier_only_load": {
            "requests": args.requests,
            "worker_threads": args.workers,
            "mismatches": mismatches,
            "p95_ms": round(latencies[math.ceil(len(latencies) * 0.95) - 1] / 1_000_000, 3),
            "requests_per_second": round(args.requests / elapsed),
            "python": platform.python_version(),
        },
    }, ensure_ascii=False, indent=2))
    return int(mismatches > 0)


if __name__ == "__main__":
    raise SystemExit(main())
