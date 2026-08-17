"""
Said Medha Institute - Comprehensive Scoring & Integration Test Suite (Phase 2)
================================================================================
Verifies:
1. Answer key encryption/decryption round-trip
2. Marking scheme math (positive marks, negative marks, multiple marks penalties)
3. End-to-end pipeline (OMR image -> CV answer extraction -> grading -> scorecard)
4. Teacher Item Analysis (class analytics & question difficulty rankings)
"""

import json
import os
import unittest
import numpy as np

from scoring_engine import (
    MarkingScheme,
    encrypt_answer_key,
    decrypt_answer_key,
    validate_answer_key,
    evaluate_student_sheet,
    generate_student_view,
    generate_teacher_item_analysis
)
from omr_engine import process_omr_sheet
from test_sample_generator import load_template, render_filled_sheet, fill_bubble


class TestScoringEngine(unittest.TestCase):

    def setUp(self):
        # 50-question mock answer key
        self.sample_key = {str(i): ["A", "B", "C", "D"][(i - 1) % 4] for i in range(1, 51)}

    def test_01_answer_key_encryption_roundtrip(self):
        """Test Fernet symmetric encryption and decryption of answer key."""
        encrypted_token, secret_key = encrypt_answer_key(self.sample_key)
        self.assertIsInstance(encrypted_token, str)
        self.assertIsInstance(secret_key, str)
        
        # Verify decrypted payload matches original exactly
        decrypted = decrypt_answer_key(encrypted_token, secret_key)
        self.assertEqual(decrypted, self.sample_key)

    def test_02_marking_scheme_perfect_score(self):
        """Test 100% correct answers with +1 per question."""
        # Simulated 50 correct results
        mock_omr = {
            "results": [
                {"question": i, "selected": self.sample_key[str(i)], "status": "ANSWERED", "confidence": 1.0}
                for i in range(1, 51)
            ]
        }
        scheme = MarkingScheme(marks_per_correct=1.0, negative_marking=True, negative_marks_per_wrong=0.25)
        report = evaluate_student_sheet(mock_omr, self.sample_key, scheme, student_id="TOPPER-01")
        
        summary = report["summary"]
        self.assertEqual(summary["correct"], 50)
        self.assertEqual(summary["wrong"], 0)
        self.assertEqual(summary["unanswered"], 0)
        self.assertEqual(summary["raw_score"], 50.0)
        self.assertEqual(summary["max_marks"], 50.0)
        self.assertEqual(summary["score_percentage"], 100.0)

    def test_03_marking_scheme_with_negatives_and_blanks(self):
        """Test scoring with 35 correct, 10 wrong (-0.25 each), 5 unanswered."""
        mock_results = []
        for i in range(1, 51):
            if i <= 35:
                mock_results.append({"question": i, "selected": self.sample_key[str(i)], "status": "ANSWERED"})
            elif i <= 45:
                # Wrong answer
                wrong_opt = "B" if self.sample_key[str(i)] != "B" else "C"
                mock_results.append({"question": i, "selected": wrong_opt, "status": "ANSWERED"})
            else:
                # Unanswered
                mock_results.append({"question": i, "selected": None, "status": "UNANSWERED"})

        scheme = MarkingScheme(marks_per_correct=1.0, negative_marking=True, negative_marks_per_wrong=0.25)
        report = evaluate_student_sheet({"results": mock_results}, self.sample_key, scheme)
        
        summary = report["summary"]
        self.assertEqual(summary["correct"], 35)
        self.assertEqual(summary["wrong"], 10)
        self.assertEqual(summary["unanswered"], 5)
        # 35 * 1.0 - 10 * 0.25 = 35 - 2.5 = 32.5
        self.assertEqual(summary["raw_score"], 32.5)
        self.assertEqual(summary["score_percentage"], 65.0)

    def test_04_multiple_marks_handling(self):
        """Test that double bubbles are penalized under strict negative marking."""
        mock_results = [
            {"question": 1, "selected": "MULTIPLE", "status": "INVALID_MULTIPLE_FILLS"},
            {"question": 2, "selected": self.sample_key["2"], "status": "ANSWERED"}
        ]
        # Remaining 48 unanswered
        for i in range(3, 51):
            mock_results.append({"question": i, "selected": None, "status": "UNANSWERED"})

        scheme = MarkingScheme(marks_per_correct=1.0, negative_marking=True, negative_marks_per_wrong=0.25, penalize_multiple_marks=True)
        report = evaluate_student_sheet({"results": mock_results}, self.sample_key, scheme)
        
        # Q1: -0.25, Q2: +1.00 -> 0.75
        self.assertEqual(report["summary"]["raw_score"], 0.75)
        self.assertEqual(report["summary"]["multiple_marks"], 1)

    def test_05_teacher_item_analysis(self):
        """Test item analysis across a batch of 3 student reports."""
        student_reports = []
        
        # Student 1 (40 correct)
        s1_results = [{"question": i, "selected": self.sample_key[str(i)] if i <= 40 else "D", "status": "ANSWERED"} for i in range(1, 51)]
        student_reports.append(evaluate_student_sheet({"results": s1_results}, self.sample_key))

        # Student 2 (30 correct, failed Q41..Q50)
        s2_results = [{"question": i, "selected": self.sample_key[str(i)] if i <= 30 else "A", "status": "ANSWERED"} for i in range(1, 51)]
        student_reports.append(evaluate_student_sheet({"results": s2_results}, self.sample_key))

        # Student 3 (20 correct, failed Q41..Q50)
        s3_results = [{"question": i, "selected": self.sample_key[str(i)] if i <= 20 else "A", "status": "ANSWERED"} for i in range(1, 51)]
        student_reports.append(evaluate_student_sheet({"results": s3_results}, self.sample_key))

        analysis = generate_teacher_item_analysis(student_reports)
        self.assertEqual(analysis["total_students"], 3)
        self.assertIn("flagged_hard_questions", analysis)
        self.assertTrue(len(analysis["flagged_hard_questions"]) > 0)

    def test_06_full_end_to_end_cv_to_grading(self):
        """End-to-end test: evaluate an actual test sample photo from Phase 1."""
        test_img_path = "test_samples/test_001_clean_1.png"
        gt_path = "test_samples/test_001_clean_1_ground_truth.json"

        if os.path.exists(test_img_path) and os.path.exists(gt_path):
            with open(gt_path, "r") as f:
                gt = json.load(f)
            
            # Construct answer key directly matching expected answers
            key = {}
            for q_k, v in gt.items():
                if v["expected_selected"] in ["A", "B", "C", "D"]:
                    key[q_k] = v["expected_selected"]
                else:
                    key[q_k] = "A" # fallback

            # Run CV Engine
            omr_out = process_omr_sheet(test_img_path, "template_spec.json", debug=False)
            self.assertEqual(omr_out["status"], "SUCCESS")

            # Run Scoring
            report = evaluate_student_sheet(omr_out, key)
            self.assertEqual(report["status"], "EVALUATION_SUCCESS")
            self.assertGreaterEqual(report["summary"]["correct"], 45)


if __name__ == "__main__":
    unittest.main(verbosity=2)
