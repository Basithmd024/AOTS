"""
AOTS - Database Integration & Persistence Test Suite (Phase 3)
==============================================================
Verifies:
1. User role-based registration & authentication
2. Test creation with encrypted answer key storage
3. Submitting OMR exam sheet results & persistence
4. Student score retrieval & teacher class analytics
"""

import os
import unittest
import json
from database import AOTSDatabase
from scoring_engine import MarkingScheme
from omr_engine import process_omr_sheet

TEST_DB_PATH = "test_aots.db"


class TestAOTSDatabase(unittest.TestCase):

    def setUp(self):
        if os.path.exists(TEST_DB_PATH):
            os.remove(TEST_DB_PATH)
        self.db = AOTSDatabase(TEST_DB_PATH)
        self.sample_key = {str(i): ["A", "B", "C", "D"][(i - 1) % 4] for i in range(1, 51)}

    def tearDown(self):
        if os.path.exists(TEST_DB_PATH):
            os.remove(TEST_DB_PATH)

    def test_01_user_management(self):
        """Test user creation and secure authentication."""
        # Create Teacher
        teacher = self.db.create_user("teacher_ramesh", "ramesh@aots.edu", "securePass123", "TEACHER", "Ramesh Kumar")
        self.assertEqual(teacher["role"], "TEACHER")

        # Create Student
        student = self.db.create_user("student_suresh", "suresh@aots.edu", "studentPass456", "STUDENT", "Suresh Reddy")
        self.assertEqual(student["role"], "STUDENT")

        # Successful auth
        auth_user = self.db.authenticate_user("teacher_ramesh", "securePass123")
        self.assertIsNotNone(auth_user)
        self.assertEqual(auth_user["username"], "teacher_ramesh")

        # Failed auth (wrong pass)
        self.assertIsNone(self.db.authenticate_user("teacher_ramesh", "wrongPass"))

    def test_02_test_creation_with_encrypted_key(self):
        """Test creating an exam with encrypted answer key."""
        teacher = self.db.create_user("prof_sharma", "sharma@aots.edu", "pass123", "TEACHER")
        test = self.db.create_test(
            title="ECET Mock Assessment 01",
            test_code="AOTS-ECET-001",
            created_by_user_id=teacher["id"],
            answer_key=self.sample_key,
            marking_scheme=MarkingScheme(marks_per_correct=1.0, negative_marks_per_wrong=0.25)
        )
        self.assertEqual(test["test_code"], "AOTS-ECET-001")

        # Fetch without decrypted key
        public_view = self.db.get_test_by_code("AOTS-ECET-001", include_decrypted_key=False)
        self.assertNotIn("answer_key", public_view)
        self.assertNotIn("secret_key", public_view)

        # Fetch with decrypted key
        private_view = self.db.get_test_by_code("AOTS-ECET-001", include_decrypted_key=True)
        self.assertIn("answer_key", private_view)
        self.assertEqual(private_view["answer_key"], self.sample_key)

    def test_03_submit_exam_and_query_analytics(self):
        """Test end-to-end exam submission and teacher analytics aggregation."""
        # 1. Setup Users & Test
        teacher = self.db.create_user("inst_admin", "admin@aots.edu", "pass123", "ADMIN")
        s1 = self.db.create_user("suresh_01", "suresh1@aots.edu", "pass", "STUDENT", "Suresh")
        s2 = self.db.create_user("anitha_02", "anitha@aots.edu", "pass", "STUDENT", "Anitha")
        s3 = self.db.create_user("kavitha_03", "kavitha@aots.edu", "pass", "STUDENT", "Kavitha")

        self.db.create_test(
            title="AOTS ECET Grand Mock",
            test_code="AOTS-MOCK-100",
            created_by_user_id=teacher["id"],
            answer_key=self.sample_key
        )

        # 2. Mock OMR outputs
        # S1: 50 correct (Topper)
        s1_omr = {"results": [{"question": i, "selected": self.sample_key[str(i)], "status": "ANSWERED"} for i in range(1, 51)]}
        # S2: 40 correct, 10 wrong
        s2_omr = {"results": [{"question": i, "selected": self.sample_key[str(i)] if i <= 40 else "D", "status": "ANSWERED"} for i in range(1, 51)]}
        # S3: 20 correct, 30 wrong
        s3_omr = {"results": [{"question": i, "selected": self.sample_key[str(i)] if i <= 20 else "D", "status": "ANSWERED"} for i in range(1, 51)]}

        # 3. Submit Results
        rep1 = self.db.submit_exam_result("AOTS-MOCK-100", s1["id"], s1_omr)
        rep2 = self.db.submit_exam_result("AOTS-MOCK-100", s2["id"], s2_omr)
        rep3 = self.db.submit_exam_result("AOTS-MOCK-100", s3["id"], s3_omr)

        self.assertEqual(rep1["summary"]["raw_score"], 50.0)

        # 4. Check Student Submission View
        saved_sub = self.db.get_student_submission("AOTS-MOCK-100", s1["id"])
        self.assertIsNotNone(saved_sub)
        self.assertEqual(saved_sub["raw_score"], 50.0)

        # 5. Teacher Analytics
        analytics = self.db.get_test_analytics("AOTS-MOCK-100")
        self.assertEqual(analytics["total_students"], 3)
        self.assertEqual(len(analytics["toppers"]), 3)
        self.assertEqual(analytics["toppers"][0]["student_id"], "suresh_01")
        self.assertEqual(analytics["toppers"][0]["score"], 50.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
