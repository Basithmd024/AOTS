"""
Said Medha Institute - Unified OMR Evaluation & Grading CLI (Phase 2)
=====================================================================
Single-command end-to-end pipeline:
  Image Photo + Answer Key (or Encrypted Key) -> Instant Detailed Grading & Scorecard

Usage:
  python3 grade_sheet.py <image_path> --key-file <answer_key.json> [options]
  python3 grade_sheet.py <image_path> --encrypted-key <payload> --secret-key <key> [options]
"""

import json
import sys
import os
import argparse
from omr_engine import process_omr_sheet
from scoring_engine import (
    MarkingScheme,
    evaluate_student_sheet,
    generate_student_view,
    encrypt_answer_key,
    decrypt_answer_key,
    validate_answer_key
)


def print_formatted_card(report: dict, student_view_only: bool = False):
    summary = report["summary"]
    scheme = report["marking_scheme"]

    print("\n" + "=" * 70)
    print("  SAID MEDHA INSTITUTE — ECET EXAMINATION SCORECARD")
    print("=" * 70)
    print(f"  Student ID:     {report.get('student_id', 'N/A')}")
    print(f"  Test Code:      {report.get('test_code', 'N/A')}")
    print(f"  Marking Scheme: +{scheme['marks_per_correct']} correct, "
          f"-{scheme['negative_marks_per_wrong']} wrong (Negative Marking: {scheme['negative_marking']})")
    print("─" * 70)
    print(f"  🎯 FINAL SCORE:       {summary['raw_score']:>6.2f} / {summary['max_marks']:<6.2f} "
          f"({summary['score_percentage']}%)")
    print(f"  📊 ACCURACY:          {summary['accuracy_on_attempted_pct']}% (on attempted)")
    print("─" * 70)
    print(f"  ✅ Correct:           {summary['correct']:>3} questions")
    print(f"  ❌ Wrong:             {summary['wrong']:>3} questions")
    print(f"  ⚠️  Unanswered:        {summary['unanswered']:>3} questions")
    print(f"  🚫 Multiple Marks:    {summary['multiple_marks']:>3} questions")
    print("=" * 70)

    if not student_view_only:
        print("\n  DETAILED QUESTION BREAKDOWN (Teacher View):")
        print(f"  {'Q.No':<6} {'Marked':<8} {'Key':<6} {'Result':<16} {'Marks':<8} {'Confidence':<10}")
        print("  " + "─" * 58)

        for q in report["detailed_results"]:
            q_num = f"Q{q['question']:02d}"
            marked = q['student_answer'] if q['student_answer'] is not None else "BLANK"
            key = q['correct_answer'] or "N/A"
            status = q['evaluation_status']
            marks = f"{q['marks_awarded']:+.2f}"
            conf = f"{q['confidence']:.2f}"

            status_symbol = {
                "CORRECT": "✅ CORRECT",
                "WRONG": "❌ WRONG",
                "UNANSWERED": "⚪ BLANK",
                "MULTIPLE_MARKS": "🚫 MULTIPLE"
            }.get(status, status)

            print(f"  {q_num:<6} {marked:<8} {key:<6} {status_symbol:<16} {marks:<8} {conf:<10}")

        print("=" * 70 + "\n")


def main():
    parser = argparse.ArgumentParser(
        description="Said Medha Institute — End-to-End OMR Grading CLI"
    )
    parser.add_argument("image", help="Path to the OMR sheet photo/image")
    parser.add_argument("--key-file", "-k", help="Path to answer key JSON file")
    parser.add_argument("--encrypted-key", help="Encrypted answer key payload (Fernet base64)")
    parser.add_argument("--secret-key", help="Secret key for decrypting answer key")
    parser.add_argument("--student-id", default="SM-STUDENT-2026", help="Student ID / Roll No")
    parser.add_argument("--test-code", default="SM-ECET-003", help="Exam Test Code")
    parser.add_argument("--marks-correct", type=float, default=1.0, help="Marks for correct answer")
    parser.add_argument("--marks-wrong", type=float, default=0.25, help="Penalty for wrong answer")
    parser.add_argument("--no-negative", action="store_true", help="Disable negative marking")
    parser.add_argument("--student-view", action="store_true", help="Display only student summary (hide answer key)")
    parser.add_argument("--output", "-o", help="Save complete evaluation JSON to file")
    parser.add_argument("--spec", default="template_spec.json", help="Path to template spec")

    args = parser.parse_args()

    # 1. Resolve Answer Key
    answer_key = None
    if args.encrypted_key and args.secret_key:
        try:
            answer_key = decrypt_answer_key(args.encrypted_key, args.secret_key)
        except Exception as e:
            print(f"❌ Error decrypting answer key: {e}")
            sys.exit(1)
    elif args.key_file:
        if not os.path.exists(args.key_file):
            print(f"❌ Answer key file not found: {args.key_file}")
            sys.exit(1)
        with open(args.key_file, "r") as f:
            answer_key = json.load(f)
    else:
        print("❌ Error: You must provide either --key-file OR both --encrypted-key and --secret-key.")
        sys.exit(1)

    # 2. Run Computer Vision OMR Engine
    print(f"🔍 [1/2] Processing OMR image: {args.image}...")
    omr_output = process_omr_sheet(args.image, spec_path=args.spec, debug=False)
    
    if omr_output.get("status") != "SUCCESS":
        print(f"❌ OMR Processing failed: {omr_output.get('error')}")
        sys.exit(1)

    # 3. Configure Marking Scheme
    scheme = MarkingScheme(
        marks_per_correct=args.marks_correct,
        negative_marks_per_wrong=args.marks_wrong,
        negative_marking=not args.no_negative,
        penalize_multiple_marks=True
    )

    # 4. Evaluate Score
    print("📊 [2/2] Evaluating answers against locked answer key...")
    report = evaluate_student_sheet(
        omr_results=omr_output,
        answer_key=answer_key,
        marking_scheme=scheme,
        student_id=args.student_id,
        test_code=args.test_code
    )

    # 5. Display Output
    print_formatted_card(report, student_view_only=args.student_view)

    # 6. Save JSON Output if requested
    if args.output:
        with open(args.output, "w") as f:
            json.dump(report, f, indent=2)
        print(f"💾 Detailed report saved to: {args.output}\n")


if __name__ == "__main__":
    main()
