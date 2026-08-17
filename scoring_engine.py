"""
AOTS - Scoring & Answer Key Engine (Phase 2)
============================================
Handles:
1. Answer key schema validation & tamper-evident Fernet encryption
2. Flexible marking schemes (positive marks, negative marking, multiple marks policy)
3. Deterministic score evaluation & statistical analysis
4. Role-based output generation (Student summary vs. Teacher item analysis)

Usage:
  from scoring_engine import MarkingScheme, encrypt_answer_key, decrypt_answer_key, evaluate_student_sheet
"""

import json
import os
import base64
import hashlib
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Union, Tuple
from cryptography.fernet import Fernet


@dataclass
class MarkingScheme:
    """Configurable marking scheme for ECET and competitive mock tests."""
    marks_per_correct: float = 1.0
    negative_marks_per_wrong: float = 0.25
    negative_marking: bool = True
    penalize_multiple_marks: bool = True  # If True, multi-marked questions receive negative penalty
    unanswered_penalty: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Answer Key Encryption & Security Utilities
# ─────────────────────────────────────────────────────────────────────────────

def generate_secret_key() -> str:
    """Generate a high-entropy Fernet symmetric key (base64 URL-safe)."""
    return Fernet.generate_key().decode("utf-8")


def encrypt_answer_key(answer_key: Dict[str, str], secret_key: Optional[str] = None) -> Tuple[str, str]:
    """
    Encrypt answer key dictionary using Fernet AES-128-CBC + HMAC-SHA256.
    Returns: (encrypted_token_b64, secret_key)
    """
    if secret_key is None:
        secret_key = generate_secret_key()
    
    fernet = Fernet(secret_key.encode("utf-8"))
    payload_bytes = json.dumps(answer_key, sort_keys=True).encode("utf-8")
    encrypted_bytes = fernet.encrypt(payload_bytes)
    return encrypted_bytes.decode("utf-8"), secret_key


def decrypt_answer_key(encrypted_payload: str, secret_key: str) -> Dict[str, str]:
    """Decrypt an encrypted answer key payload using the provided secret key."""
    fernet = Fernet(secret_key.encode("utf-8"))
    decrypted_bytes = fernet.decrypt(encrypted_payload.encode("utf-8"))
    return json.loads(decrypted_bytes.decode("utf-8"))


def validate_answer_key(answer_key: Dict[Union[str, int], str], expected_count: int = 50) -> Dict[str, str]:
    """
    Validates answer key integrity (Q1..Q50, options A/B/C/D).
    Standardizes keys to strings: "1".."50".
    """
    cleaned = {}
    valid_options = {"A", "B", "C", "D"}
    
    for q_idx in range(1, expected_count + 1):
        q_str = str(q_idx)
        val = answer_key.get(q_str) or answer_key.get(q_idx)
        if not val:
            raise ValueError(f"Missing answer key definition for Question {q_idx}")
        val = str(val).strip().upper()
        if val not in valid_options:
            raise ValueError(f"Invalid option '{val}' for Question {q_idx}. Must be one of {valid_options}")
        cleaned[q_str] = val
        
    return cleaned


# ─────────────────────────────────────────────────────────────────────────────
# 2. Score Evaluation Core
# ─────────────────────────────────────────────────────────────────────────────

def evaluate_student_sheet(
    omr_results: dict,
    answer_key: Dict[str, str],
    marking_scheme: Optional[MarkingScheme] = None,
    student_id: Optional[str] = "STUDENT-ECET",
    test_code: Optional[str] = "SM-ECET-003"
) -> dict:
    """
    Evaluate detected student answers against the answer key.
    
    Args:
        omr_results: Output dictionary from omr_engine.py (`results` array)
        answer_key: Dict mapping str question number -> correct option (e.g. {"1": "A", "2": "C"})
        marking_scheme: MarkingScheme instance (defaults to +1 / -0.25)
        student_id: Optional student identifier
        test_code: Optional test code
        
    Returns:
        Structured evaluation report dict with total score, breakdowns, and question details.
    """
    if marking_scheme is None:
        marking_scheme = MarkingScheme()

    # Extract detected answers list
    raw_results = omr_results.get("results", [])
    if not raw_results:
        raise ValueError("Invalid OMR engine output: 'results' list is missing or empty.")

    cleaned_key = {str(k): v.upper() for k, v in answer_key.items()}
    
    total_questions = len(raw_results)
    correct_count = 0
    wrong_count = 0
    unanswered_count = 0
    multiple_marks_count = 0
    raw_score = 0.0

    question_breakdowns = []

    for q_item in raw_results:
        q_num = q_item["question"]
        q_key = str(q_num)
        selected = q_item.get("selected")
        status = q_item.get("status")
        confidence = q_item.get("confidence", 1.0)
        correct_ans = cleaned_key.get(q_key)

        if not correct_ans:
            # Fallback if key missing for this question
            evaluation_status = "UNKNOWN_KEY"
            marks = 0.0
        elif status == "UNANSWERED" or selected is None:
            evaluation_status = "UNANSWERED"
            unanswered_count += 1
            marks = -abs(marking_scheme.unanswered_penalty)
        elif status == "INVALID_MULTIPLE_FILLS" or selected == "MULTIPLE":
            evaluation_status = "MULTIPLE_MARKS"
            multiple_marks_count += 1
            if marking_scheme.penalize_multiple_marks and marking_scheme.negative_marking:
                marks = -abs(marking_scheme.negative_marks_per_wrong)
            else:
                marks = 0.0
        elif selected == correct_ans:
            evaluation_status = "CORRECT"
            correct_count += 1
            marks = marking_scheme.marks_per_correct
        else:
            evaluation_status = "WRONG"
            wrong_count += 1
            if marking_scheme.negative_marking:
                marks = -abs(marking_scheme.negative_marks_per_wrong)
            else:
                marks = 0.0

        raw_score += marks

        question_breakdowns.append({
            "question": q_num,
            "student_answer": selected,
            "correct_answer": correct_ans,
            "evaluation_status": evaluation_status,
            "marks_awarded": round(marks, 2),
            "confidence": confidence,
            "fill_ratios": q_item.get("fill_ratios", {})
        })

    max_marks = total_questions * marking_scheme.marks_per_correct
    attempted_count = correct_count + wrong_count + multiple_marks_count
    accuracy_pct = round((correct_count / attempted_count * 100), 2) if attempted_count > 0 else 0.0
    score_percentage = round((raw_score / max_marks * 100), 2) if max_marks > 0 else 0.0

    report = {
        "status": "EVALUATION_SUCCESS",
        "student_id": student_id,
        "test_code": test_code,
        "marking_scheme": marking_scheme.to_dict(),
        "summary": {
            "total_questions": total_questions,
            "attempted": attempted_count,
            "unanswered": unanswered_count,
            "correct": correct_count,
            "wrong": wrong_count,
            "multiple_marks": multiple_marks_count,
            "raw_score": round(raw_score, 2),
            "max_marks": round(max_marks, 2),
            "score_percentage": score_percentage,
            "accuracy_on_attempted_pct": accuracy_pct
        },
        "detailed_results": question_breakdowns
    }

    return report


def generate_student_view(evaluation_report: dict) -> dict:
    """
    Generates a secure, sanitized student view (omits raw answer keys if exam is ongoing).
    """
    summary = evaluation_report["summary"]
    return {
        "student_id": evaluation_report.get("student_id"),
        "test_code": evaluation_report.get("test_code"),
        "score": f"{summary['raw_score']} / {summary['max_marks']}",
        "percentage": f"{summary['score_percentage']}%",
        "correct": summary["correct"],
        "wrong": summary["wrong"],
        "unanswered": summary["unanswered"],
        "multiple_marks": summary["multiple_marks"],
        "accuracy_on_attempted": f"{summary['accuracy_on_attempted_pct']}%"
    }


def generate_teacher_item_analysis(evaluation_reports: List[dict]) -> dict:
    """
    Aggregates question-by-question metrics across a batch of student sheets:
    - Difficulty index per question (% of students who got it wrong)
    - Distractor analysis (which wrong options were chosen most often)
    - Toppers & class average
    """
    if not evaluation_reports:
        return {"total_students": 0, "questions": {}}

    total_students = len(evaluation_reports)
    total_scores = [r["summary"]["raw_score"] for r in evaluation_reports]
    class_average = round(sum(total_scores) / total_students, 2)
    max_marks = evaluation_reports[0]["summary"]["max_marks"]

    # Item analysis per question
    q_stats = {}
    num_questions = evaluation_reports[0]["summary"]["total_questions"]

    for q_idx in range(1, num_questions + 1):
        q_stats[q_idx] = {
            "correct_count": 0,
            "wrong_count": 0,
            "unanswered_count": 0,
            "option_distribution": {"A": 0, "B": 0, "C": 0, "D": 0, "MULTIPLE": 0, "NONE": 0}
        }

    for rep in evaluation_reports:
        for q_detail in rep["detailed_results"]:
            q_num = q_detail["question"]
            st = q_detail["evaluation_status"]
            ans = q_detail["student_answer"]

            if st == "CORRECT":
                q_stats[q_num]["correct_count"] += 1
            elif st == "WRONG" or st == "MULTIPLE_MARKS":
                q_stats[q_num]["wrong_count"] += 1
            elif st == "UNANSWERED":
                q_stats[q_num]["unanswered_count"] += 1

            if ans in ["A", "B", "C", "D"]:
                q_stats[q_num]["option_distribution"][ans] += 1
            elif ans == "MULTIPLE":
                q_stats[q_num]["option_distribution"]["MULTIPLE"] += 1
            else:
                q_stats[q_num]["option_distribution"]["NONE"] += 1

    # Format item analysis
    formatted_analysis = {}
    hard_questions = []

    for q_num, data in q_stats.items():
        correct_pct = round(data["correct_count"] / total_students * 100, 1)
        wrong_pct = round(data["wrong_count"] / total_students * 100, 1)
        
        formatted_analysis[str(q_num)] = {
            "question": q_num,
            "correct_pct": correct_pct,
            "wrong_pct": wrong_pct,
            "difficulty_level": "HARD" if correct_pct < 40 else ("MEDIUM" if correct_pct < 70 else "EASY"),
            "option_distribution": data["option_distribution"]
        }

        if wrong_pct >= 60:
            hard_questions.append({
                "question": q_num,
                "wrong_pct": wrong_pct,
                "note": f"{wrong_pct}% of students failed this question"
            })

    return {
        "total_students": total_students,
        "class_average_score": class_average,
        "max_marks": max_marks,
        "class_average_percentage": round(class_average / max_marks * 100, 2) if max_marks > 0 else 0,
        "flagged_hard_questions": sorted(hard_questions, key=lambda x: x["wrong_pct"], reverse=True),
        "question_item_analysis": formatted_analysis
    }
