"""
AOTS - Database Persistence & Data Access Layer (Phase 3)
=========================================================
Supports:
1. SQLite (local/embedded) & PostgreSQL-ready schema
2. Role-based user management (ADMIN, TEACHER, STUDENT) with bcrypt/SHA-256 secure password hashing
3. Secure test creation with locked & encrypted answer keys
4. OMR exam result submission with automatic score computation
5. Real-time class analytics & question-by-question difficulty tracking

Usage:
  from database import AOTSDatabase
  db = AOTSDatabase("aots.db")
"""

import sqlite3
import json
import os
import hashlib
import secrets
from datetime import datetime
from typing import Dict, List, Optional, Tuple, Any

from scoring_engine import (
    MarkingScheme,
    encrypt_answer_key,
    decrypt_answer_key,
    evaluate_student_sheet,
    generate_teacher_item_analysis
)


class AOTSDatabase:
    def __init__(self, db_path: str = "aots.db"):
        self.db_path = db_path
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _init_db(self):
        """Initializes database schema with optimized indexing."""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            # 1. Users Table
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                role TEXT CHECK(role IN ('ADMIN', 'TEACHER', 'STUDENT')) NOT NULL,
                full_name TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)

            # 2. Tests Table
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS tests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                test_code TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                created_by INTEGER NOT NULL,
                total_questions INTEGER DEFAULT 50,
                duration_mins INTEGER DEFAULT 120,
                encrypted_answer_key TEXT NOT NULL,
                secret_key TEXT NOT NULL,
                marks_per_correct REAL DEFAULT 1.0,
                negative_marks_per_wrong REAL DEFAULT 0.25,
                negative_marking INTEGER DEFAULT 1,
                penalize_multiple_marks INTEGER DEFAULT 1,
                is_active INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
            );
            """)

            # 3. Exam Submissions Table
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS exam_submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                test_id INTEGER NOT NULL,
                student_id INTEGER NOT NULL,
                sheet_image_path TEXT,
                raw_detected_answers TEXT NOT NULL,
                raw_score REAL NOT NULL,
                max_marks REAL NOT NULL,
                score_percentage REAL NOT NULL,
                correct_count INTEGER NOT NULL,
                wrong_count INTEGER NOT NULL,
                unanswered_count INTEGER NOT NULL,
                multiple_marks_count INTEGER NOT NULL,
                evaluation_report TEXT NOT NULL,
                submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE,
                FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(test_id, student_id)
            );
            """)

            # 4. Question Item Analytics Cache
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS question_analytics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                test_id INTEGER NOT NULL,
                question_number INTEGER NOT NULL,
                correct_count INTEGER DEFAULT 0,
                wrong_count INTEGER DEFAULT 0,
                unanswered_count INTEGER DEFAULT 0,
                option_distribution TEXT DEFAULT '{}',
                difficulty_rating TEXT DEFAULT 'MEDIUM',
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE,
                UNIQUE(test_id, question_number)
            );
            """)

            # Indexes for fast lookup
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_tests_code ON tests(test_code);")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_submissions_test ON exam_submissions(test_id);")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_submissions_student ON exam_submissions(student_id);")
            conn.commit()

    # ─────────────────────────────────────────────────────────────────────────
    # User Management & Security
    # ─────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _hash_password(password: str, salt: Optional[str] = None) -> Tuple[str, str]:
        if salt is None:
            salt = secrets.token_hex(16)
        salted = (password + salt).encode("utf-8")
        pw_hash = hashlib.sha256(salted).hexdigest()
        return pw_hash, salt

    def create_user(self, username: str, email: str, password: str, role: str, full_name: str = "") -> dict:
        """Create a new user (ADMIN, TEACHER, STUDENT)."""
        role = role.upper()
        if role not in ('ADMIN', 'TEACHER', 'STUDENT'):
            raise ValueError(f"Invalid role: {role}. Must be ADMIN, TEACHER, or STUDENT.")

        pw_hash, salt = self._hash_password(password)

        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                INSERT INTO users (username, email, password_hash, salt, role, full_name)
                VALUES (?, ?, ?, ?, ?, ?)
                """, (username.strip(), email.strip().lower(), pw_hash, salt, role, full_name.strip()))
                user_id = cursor.lastrowid
                conn.commit()
                return {
                    "id": user_id,
                    "username": username,
                    "email": email,
                    "role": role,
                    "full_name": full_name
                }
        except sqlite3.IntegrityError as e:
            raise ValueError(f"User with username '{username}' or email '{email}' already exists.") from e

    def authenticate_user(self, username: str, password: str) -> Optional[dict]:
        """Authenticate user credentials and return user info dict if valid."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE username = ? OR email = ?", (username.strip(), username.strip().lower()))
            row = cursor.fetchone()
            if not row:
                return None

            pw_hash, _ = self._hash_password(password, row["salt"])
            if pw_hash == row["password_hash"]:
                return {
                    "id": row["id"],
                    "username": row["username"],
                    "email": row["email"],
                    "role": row["role"],
                    "full_name": row["full_name"]
                }
            return None

    def get_user_by_id(self, user_id: int) -> Optional[dict]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, username, email, role, full_name, created_at FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    # ─────────────────────────────────────────────────────────────────────────
    # Test Management
    # ─────────────────────────────────────────────────────────────────────────

    def create_test(
        self,
        title: str,
        test_code: str,
        created_by_user_id: int,
        answer_key: Dict[str, str],
        marking_scheme: Optional[MarkingScheme] = None,
        duration_mins: int = 120,
        total_questions: int = 50
    ) -> dict:
        """Create a new mock test with encrypted answer key."""
        if marking_scheme is None:
            marking_scheme = MarkingScheme()

        # Encrypt the answer key before saving to DB
        encrypted_token, secret_key = encrypt_answer_key(answer_key)

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            INSERT INTO tests (
                test_code, title, created_by, total_questions, duration_mins,
                encrypted_answer_key, secret_key, marks_per_correct,
                negative_marks_per_wrong, negative_marking, penalize_multiple_marks
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                test_code.strip().upper(),
                title.strip(),
                created_by_user_id,
                total_questions,
                duration_mins,
                encrypted_token,
                secret_key,
                marking_scheme.marks_per_correct,
                marking_scheme.negative_marks_per_wrong,
                1 if marking_scheme.negative_marking else 0,
                1 if marking_scheme.penalize_multiple_marks else 0
            ))
            test_id = cursor.lastrowid
            conn.commit()

            return {
                "id": test_id,
                "test_code": test_code.upper(),
                "title": title,
                "created_by": created_by_user_id,
                "total_questions": total_questions,
                "duration_mins": duration_mins,
                "marking_scheme": marking_scheme.to_dict()
            }

    def get_test_by_code(self, test_code: str, include_decrypted_key: bool = False) -> Optional[dict]:
        """Fetch test details by test code, optionally decrypting the answer key."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM tests WHERE test_code = ?", (test_code.strip().upper(),))
            row = cursor.fetchone()
            if not row:
                return None

            test_dict = dict(row)
            test_dict["marking_scheme"] = {
                "marks_per_correct": row["marks_per_correct"],
                "negative_marks_per_wrong": row["negative_marks_per_wrong"],
                "negative_marking": bool(row["negative_marking"]),
                "penalize_multiple_marks": bool(row["penalize_multiple_marks"])
            }

            if include_decrypted_key:
                test_dict["answer_key"] = decrypt_answer_key(
                    row["encrypted_answer_key"], row["secret_key"]
                )
            else:
                test_dict.pop("secret_key", None)
                test_dict.pop("encrypted_answer_key", None)

            return test_dict

    def list_tests(self, active_only: bool = True) -> List[dict]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            query = "SELECT id, test_code, title, total_questions, duration_mins, is_active, created_at FROM tests"
            if active_only:
                query += " WHERE is_active = 1"
            query += " ORDER BY created_at DESC"
            cursor.execute(query)
            return [dict(r) for r in cursor.fetchall()]

    # ─────────────────────────────────────────────────────────────────────────
    # Exam Submission & Grading
    # ─────────────────────────────────────────────────────────────────────────

    def submit_exam_result(
        self,
        test_code: str,
        student_id: int,
        omr_output: dict,
        sheet_image_path: str = ""
    ) -> dict:
        """
        Grades an OMR sheet output and persists submission to database.
        Returns the complete evaluation report.
        """
        # Fetch test and decrypted answer key
        test = self.get_test_by_code(test_code, include_decrypted_key=True)
        if not test:
            raise ValueError(f"Test '{test_code}' not found.")

        scheme = MarkingScheme(
            marks_per_correct=test["marking_scheme"]["marks_per_correct"],
            negative_marks_per_wrong=test["marking_scheme"]["negative_marks_per_wrong"],
            negative_marking=test["marking_scheme"]["negative_marking"],
            penalize_multiple_marks=test["marking_scheme"]["penalize_multiple_marks"]
        )

        student_user = self.get_user_by_id(student_id)
        student_name = student_user["username"] if student_user else f"STUDENT-{student_id}"

        # Evaluate score
        report = evaluate_student_sheet(
            omr_results=omr_output,
            answer_key=test["answer_key"],
            marking_scheme=scheme,
            student_id=student_name,
            test_code=test_code
        )

        summary = report["summary"]
        raw_answers_json = json.dumps([
            {"q": r["question"], "ans": r["selected"], "conf": r.get("confidence", 1.0)}
            for r in omr_output.get("results", [])
        ])
        eval_report_json = json.dumps(report)

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            INSERT OR REPLACE INTO exam_submissions (
                test_id, student_id, sheet_image_path, raw_detected_answers,
                raw_score, max_marks, score_percentage, correct_count,
                wrong_count, unanswered_count, multiple_marks_count, evaluation_report
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                test["id"],
                student_id,
                sheet_image_path,
                raw_answers_json,
                summary["raw_score"],
                summary["max_marks"],
                summary["score_percentage"],
                summary["correct"],
                summary["wrong"],
                summary["unanswered"],
                summary["multiple_marks"],
                eval_report_json
            ))
            conn.commit()

        return report

    def get_student_submission(self, test_code: str, student_id: int) -> Optional[dict]:
        """Fetch past exam submission for a student."""
        test = self.get_test_by_code(test_code)
        if not test:
            return None

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT * FROM exam_submissions WHERE test_id = ? AND student_id = ?
            """, (test["id"], student_id))
            row = cursor.fetchone()
            if not row:
                return None

            sub = dict(row)
            sub["evaluation_report"] = json.loads(row["evaluation_report"])
            return sub

    def get_all_test_submissions(self, test_code: str) -> List[dict]:
        """Fetch all student submissions for a test (for teacher analytics)."""
        test = self.get_test_by_code(test_code)
        if not test:
            return []

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT s.*, u.username, u.full_name
            FROM exam_submissions s
            JOIN users u ON s.student_id = u.id
            WHERE s.test_id = ?
            ORDER BY s.raw_score DESC
            """, (test["id"],))
            
            results = []
            for r in cursor.fetchall():
                d = dict(r)
                d["evaluation_report"] = json.loads(r["evaluation_report"])
                results.append(d)
            return results

    def get_test_analytics(self, test_code: str) -> dict:
        """Compute comprehensive class performance & question item analysis."""
        submissions = self.get_all_test_submissions(test_code)
        if not submissions:
            return {"total_students": 0, "class_average": 0.0, "toppers": []}

        reports = [s["evaluation_report"] for s in submissions]
        item_analysis = generate_teacher_item_analysis(reports)

        toppers = [
            {
                "rank": idx + 1,
                "student_id": s["username"],
                "name": s["full_name"] or s["username"],
                "score": s["raw_score"],
                "max_marks": s["max_marks"],
                "percentage": s["score_percentage"]
            }
            for idx, s in enumerate(submissions[:5])
        ]

        item_analysis["toppers"] = toppers
        return item_analysis
