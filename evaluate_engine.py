"""
Said Medha Institute - OMR Engine Accuracy Evaluator
=====================================================
Runs the OMR engine against all test samples and compares
with ground truth to produce an accuracy report.

Usage:
  python3 evaluate_engine.py [--test-dir test_samples] [--debug]
"""

import json
import os
import sys
import argparse
from omr_engine import process_omr_sheet


def load_ground_truth(gt_path: str) -> dict:
    """Load ground truth JSON file."""
    with open(gt_path, "r") as f:
        return json.load(f)


def compare_results(engine_results: list, ground_truth: dict) -> dict:
    """Compare engine output against ground truth question by question."""
    correct = 0
    wrong = 0
    total = len(ground_truth)
    mismatches = []
    
    # Build lookup from engine results
    engine_map = {}
    for r in engine_results:
        engine_map[str(r["question"])] = r
    
    for q_key, gt in ground_truth.items():
        expected_selected = gt["expected_selected"]
        expected_status = gt["expected_status"]
        
        if q_key not in engine_map:
            wrong += 1
            mismatches.append({
                "question": int(q_key),
                "expected": expected_selected,
                "got": "MISSING",
                "expected_status": expected_status,
                "got_status": "MISSING"
            })
            continue
        
        engine_q = engine_map[q_key]
        got_selected = engine_q["selected"]
        got_status = engine_q["status"]
        
        # Match logic
        match = False
        if expected_status == "UNANSWERED":
            match = got_status in ("UNANSWERED",)
        elif expected_status == "INVALID_MULTIPLE_FILLS":
            match = got_status == "INVALID_MULTIPLE_FILLS"
        elif expected_status == "ANSWERED":
            match = (got_selected == expected_selected and 
                     got_status in ("ANSWERED", "ANSWERED_LOW_CONFIDENCE"))
        
        if match:
            correct += 1
        else:
            wrong += 1
            mismatches.append({
                "question": int(q_key),
                "expected": expected_selected,
                "got": got_selected,
                "expected_status": expected_status,
                "got_status": got_status,
                "fill_ratios": engine_q.get("fill_ratios", {})
            })
    
    accuracy = (correct / total * 100) if total > 0 else 0.0
    
    return {
        "total": total,
        "correct": correct,
        "wrong": wrong,
        "accuracy_pct": round(accuracy, 2),
        "mismatches": mismatches
    }


def run_evaluation(test_dir: str = "test_samples",
                   spec_path: str = "template_spec.json",
                   debug: bool = False):
    """Run engine on all test samples and produce accuracy report."""
    manifest_path = os.path.join(test_dir, "test_manifest.json")
    
    if not os.path.exists(manifest_path):
        print(f"❌ Test manifest not found: {manifest_path}")
        print("   Run test_sample_generator.py first!")
        sys.exit(1)
    
    with open(manifest_path, "r") as f:
        manifest = json.load(f)
    
    print("=" * 70)
    print("  Said Medha OMR Engine — Accuracy Evaluation Report")
    print("=" * 70)
    print()
    
    overall_correct = 0
    overall_total = 0
    test_results = []
    
    for test in manifest["tests"]:
        test_id = test["id"]
        name = test["name"]
        img_path = os.path.join(test_dir, test["image"])
        gt_path = os.path.join(test_dir, test["ground_truth"])
        
        print(f"━━━ Test {test_id:03d}: {name} ━━━")
        print(f"    {test['description']}")
        
        # Run engine
        engine_output = process_omr_sheet(img_path, spec_path, debug=debug)
        
        if engine_output["status"] != "SUCCESS":
            print(f"    ❌ ENGINE ERROR: {engine_output.get('error', 'Unknown')}")
            test_results.append({
                "test_id": test_id,
                "name": name,
                "status": "ENGINE_ERROR",
                "accuracy_pct": 0.0
            })
            continue
        
        # Compare with ground truth
        ground_truth = load_ground_truth(gt_path)
        comparison = compare_results(engine_output["results"], ground_truth)
        
        overall_correct += comparison["correct"]
        overall_total += comparison["total"]
        
        # Status emoji
        if comparison["accuracy_pct"] >= 98:
            status = "✅"
        elif comparison["accuracy_pct"] >= 90:
            status = "⚠️ "
        else:
            status = "❌"
        
        print(f"    {status} Accuracy: {comparison['accuracy_pct']}% "
              f"({comparison['correct']}/{comparison['total']})")
        print(f"    Processing time: {engine_output['processing_time_sec']}s")
        print(f"    Engine confidence: {engine_output['summary']['overall_confidence']}")
        
        if comparison["mismatches"]:
            print(f"    Mismatches ({len(comparison['mismatches'])}):")
            for mm in comparison["mismatches"][:5]:  # Show first 5
                print(f"      Q{mm['question']:02d}: expected={mm['expected']} "
                      f"got={mm['got']} "
                      f"(expected_status={mm['expected_status']}, "
                      f"got_status={mm['got_status']})")
                if "fill_ratios" in mm:
                    print(f"             fill_ratios={mm['fill_ratios']}")
            if len(comparison["mismatches"]) > 5:
                print(f"      ... and {len(comparison['mismatches']) - 5} more")
        
        print()
        
        test_results.append({
            "test_id": test_id,
            "name": name,
            "status": "OK",
            "accuracy_pct": comparison["accuracy_pct"],
            "correct": comparison["correct"],
            "total": comparison["total"],
            "processing_time": engine_output["processing_time_sec"],
            "confidence": engine_output["summary"]["overall_confidence"],
            "mismatch_count": len(comparison["mismatches"])
        })
    
    # Overall summary
    overall_accuracy = (overall_correct / overall_total * 100) if overall_total > 0 else 0
    
    print("=" * 70)
    print("  OVERALL RESULTS")
    print("=" * 70)
    print(f"  Total questions evaluated: {overall_total}")
    print(f"  Correctly detected:        {overall_correct}")
    print(f"  Overall accuracy:          {overall_accuracy:.2f}%")
    print()
    
    # Per-test summary table
    print(f"  {'Test':<30} {'Accuracy':>10} {'Time':>8} {'Conf':>8}")
    print(f"  {'─' * 30} {'─' * 10} {'─' * 8} {'─' * 8}")
    for tr in test_results:
        if tr["status"] == "ENGINE_ERROR":
            print(f"  {tr['name']:<30} {'ERROR':>10} {'N/A':>8} {'N/A':>8}")
        else:
            print(f"  {tr['name']:<30} {tr['accuracy_pct']:>9.1f}% "
                  f"{tr['processing_time']:>7.2f}s "
                  f"{tr['confidence']:>7.3f}")
    
    print()
    target = 98.0
    if overall_accuracy >= target:
        print(f"  🎯 TARGET MET: {overall_accuracy:.2f}% ≥ {target}% ✅")
    else:
        print(f"  ⚠️  TARGET NOT MET: {overall_accuracy:.2f}% < {target}%")
        print(f"     Need to improve by {target - overall_accuracy:.2f}%")
    
    print("=" * 70)
    
    # Save report
    report = {
        "overall_accuracy_pct": round(overall_accuracy, 2),
        "overall_correct": overall_correct,
        "overall_total": overall_total,
        "target_accuracy": target,
        "target_met": overall_accuracy >= target,
        "tests": test_results
    }
    report_path = os.path.join(test_dir, "evaluation_report.json")
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\n📊 Full report saved: {report_path}")
    
    return report


def main():
    parser = argparse.ArgumentParser(
        description="OMR Engine Accuracy Evaluator"
    )
    parser.add_argument(
        "--test-dir", default="test_samples",
        help="Directory containing test samples (default: test_samples)"
    )
    parser.add_argument(
        "--spec", default="template_spec.json",
        help="Path to template_spec.json"
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="Print debug output from engine"
    )
    args = parser.parse_args()
    
    run_evaluation(args.test_dir, args.spec, debug=args.debug)


if __name__ == "__main__":
    main()
