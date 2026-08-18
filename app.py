"""
AOTS - Automated Optical Testing System Web Server (Phase 4)
============================================================
Provides full REST API & Web UI for:
- Student instant mobile camera OMR scanning
- Teacher test creation, answer key encryption & batch grading
- Real-time class analytics, question item difficulty & CSV export

Usage:
  python3 app.py
"""

import os
import json
import csv
import io
from flask import Flask, request, jsonify, render_template, send_file, make_response
from werkzeug.utils import secure_filename

from database import AOTSDatabase
from omr_engine import process_omr_sheet
from scoring_engine import MarkingScheme, generate_student_view, generate_teacher_item_analysis
from template_generator import create_omr_template

# Initialize Flask App
app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["SECRET_KEY"] = "aots-super-secret-key-2026"
app.config["UPLOAD_FOLDER"] = os.path.join(os.path.dirname(__file__), "uploads")
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024  # 32MB max upload

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

# Initialize Database
db = AOTSDatabase("aots.db")

# Pre-populate sample test & accounts if database is fresh
def seed_default_data():
    try:
        # Check if users exist
        auth = db.authenticate_user("teacher", "pass123")
        if not auth:
            teacher = db.create_user("teacher", "teacher@aots.edu", "pass123", "TEACHER", "Prof. K. Sharma")
            student = db.create_user("student1", "student1@aots.edu", "pass123", "STUDENT", "Basith Mohammed")
            admin = db.create_user("admin", "admin@aots.edu", "admin123", "ADMIN", "AOTS System Administrator")
            
            # Default 50-question mock answer key
            default_key = {
                "1": "A", "2": "B", "3": "A", "4": "B", "5": "B",
                "6": "C", "7": "D", "8": "A", "9": "D", "10": "C",
                "11": "C", "12": "A", "13": "D", "14": "C", "15": "A",
                "16": "A", "17": "D", "18": "C", "19": "C", "20": "A",
                "21": "B", "22": "B", "23": "A", "24": "C", "25": "C",
                "26": "C", "27": "D", "28": "C", "29": "D", "30": "B",
                "31": "A", "32": "B", "33": "A", "34": "D", "35": "A",
                "36": "C", "37": "C", "38": "C", "39": "A", "40": "B",
                "41": "A", "42": "A", "43": "C", "44": "A", "45": "A",
                "46": "B", "47": "B", "48": "D", "49": "B", "50": "C"
            }

            db.create_test(
                title="ECET Mock Grand Assessment 01",
                test_code="AOTS-ECET-003",
                created_by_user_id=teacher["id"],
                answer_key=default_key,
                marking_scheme=MarkingScheme(marks_per_correct=1.0, negative_marks_per_wrong=0.25, negative_marking=True),
                duration_mins=120,
                total_questions=50
            )
            print("✅ Default accounts (teacher/pass123, student1/pass123) and test AOTS-ECET-003 seeded.")
    except Exception as e:
        print(f"Seed info: {e}")

seed_default_data()


# ─────────────────────────────────────────────────────────────────────────────
# Frontend Page Route
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ─────────────────────────────────────────────────────────────────────────────
# REST API: Authentication
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()

    user = db.authenticate_user(username, password)
    if not user:
        return jsonify({"success": False, "error": "Invalid username or password"}), 401

    return jsonify({"success": True, "user": user})


@app.route("/api/auth/register", methods=["POST"])
def register():
    data = request.get_json() or {}
    try:
        user = db.create_user(
            username=data.get("username"),
            email=data.get("email"),
            password=data.get("password"),
            role=data.get("role", "STUDENT"),
            full_name=data.get("full_name", "")
        )
        return jsonify({"success": True, "user": user})
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 400


# ─────────────────────────────────────────────────────────────────────────────
# REST API: Tests Management
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/tests", methods=["GET"])
def get_tests():
    tests = db.list_tests()
    return jsonify({"success": True, "tests": tests})


@app.route("/api/tests/<test_code>", methods=["GET"])
def get_test_detail(test_code):
    test = db.get_test_by_code(test_code, include_decrypted_key=False)
    if not test:
        return jsonify({"success": False, "error": "Test not found"}), 404
    return jsonify({"success": True, "test": test})


@app.route("/api/tests/create", methods=["POST"])
def create_test_endpoint():
    data = request.get_json() or {}
    title = data.get("title", "").strip()
    test_code = data.get("test_code", "").strip().upper()
    user_id = data.get("user_id", 1)
    duration = int(data.get("duration_mins", 120))
    total_q = int(data.get("total_questions", 50))
    answer_key = data.get("answer_key", {})

    marks_c = float(data.get("marks_per_correct", 1.0))
    marks_w = float(data.get("negative_marks_per_wrong", 0.25))
    neg_marking = bool(data.get("negative_marking", True))

    if not title or not test_code:
        return jsonify({"success": False, "error": "Title and Test Code are required."}), 400

    if len(answer_key) < total_q:
        return jsonify({"success": False, "error": f"Answer key must have all {total_q} questions filled."}), 400

    try:
        scheme = MarkingScheme(
            marks_per_correct=marks_c,
            negative_marks_per_wrong=marks_w,
            negative_marking=neg_marking
        )
        created = db.create_test(
            title=title,
            test_code=test_code,
            created_by_user_id=user_id,
            answer_key=answer_key,
            marking_scheme=scheme,
            duration_mins=duration,
            total_questions=total_q
        )
        return jsonify({"success": True, "test": created})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400


@app.route("/api/tests/template/download", methods=["GET"])
def download_omr_template():
    template_path = os.path.join(os.path.dirname(__file__), "blank_omr.png")
    if not os.path.exists(template_path):
        create_omr_template()
    return send_file(template_path, mimetype="image/png", as_attachment=True, download_name="AOTS_Official_OMR_Sheet.png")


# ─────────────────────────────────────────────────────────────────────────────
# REST API: OMR Scanning & Grading
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/scan", methods=["POST"])
def scan_omr():
    if "file" not in request.files:
        return jsonify({"success": False, "error": "No file uploaded."}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"success": False, "error": "Empty filename."}), 400

    test_code = request.form.get("test_code", "AOTS-ECET-003").strip().upper()
    student_id = request.form.get("student_id", "1")

    # Resolve student id if string/int
    try:
        student_user_id = int(student_id)
    except ValueError:
        # Lookup user by username
        user_auth = db.authenticate_user(student_id, "")
        student_user_id = user_auth["id"] if user_auth else 2

    # Save uploaded file
    filename = secure_filename(file.filename) or "scan.png"
    save_path = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    file.save(save_path)

    # Optional manual/adjusted corners
    custom_corners = None
    corners_raw = request.form.get("corners")
    if corners_raw:
        try:
            custom_corners = json.loads(corners_raw)
        except Exception:
            pass

    # Run CV OMR Engine
    spec_path = os.path.join(os.path.dirname(__file__), "template_spec.json")
    omr_output = process_omr_sheet(save_path, spec_path=spec_path, custom_corners=custom_corners, debug=True)

    if omr_output.get("status") != "SUCCESS":
        return jsonify({"success": False, "error": omr_output.get("error", "OMR detection failed.")}), 400

    # Retrieve debug aligned image for frontend DocScanner preview
    enhanced_b64 = None
    base_name = os.path.splitext(filename)[0]
    debug_aligned = os.path.join(app.config["UPLOAD_FOLDER"], "debug", f"{base_name}_aligned.png")
    if os.path.exists(debug_aligned):
        import base64
        with open(debug_aligned, "rb") as img_f:
            enhanced_b64 = f"data:image/png;base64,{base64.b64encode(img_f.read()).decode('utf-8')}"

    # Evaluate score and persist in DB
    try:
        report = db.submit_exam_result(
            test_code=test_code,
            student_id=student_user_id,
            omr_output=omr_output,
            sheet_image_path=save_path
        )
        return jsonify({
            "success": True,
            "report": report,
            "enhanced_image": enhanced_b64,
            "student_view": generate_student_view(report)
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400


# ─────────────────────────────────────────────────────────────────────────────
# REST API: Analytics & Submissions
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/analytics/<test_code>", methods=["GET"])
def get_analytics(test_code):
    try:
        analytics = db.get_test_analytics(test_code)
        return jsonify({"success": True, "analytics": analytics})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400


@app.route("/api/submissions/<test_code>", methods=["GET"])
def get_submissions(test_code):
    try:
        submissions = db.get_all_test_submissions(test_code)
        # Strip heavy raw payload for list view
        summary_list = []
        for s in submissions:
            summary_list.append({
                "student_id": s["username"],
                "name": s["full_name"] or s["username"],
                "score": s["raw_score"],
                "max_marks": s["max_marks"],
                "percentage": s["score_percentage"],
                "correct": s["correct_count"],
                "wrong": s["wrong_count"],
                "unanswered": s["unanswered_count"],
                "submitted_at": s["submitted_at"]
            })
        return jsonify({"success": True, "submissions": summary_list})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400


@app.route("/api/export/<test_code>.csv", methods=["GET"])
def export_csv(test_code):
    submissions = db.get_all_test_submissions(test_code)
    
    si = io.StringIO()
    writer = csv.writer(si)
    writer.writerow(["Rank", "Student ID", "Full Name", "Score", "Max Marks", "Percentage (%)", "Correct", "Wrong", "Unanswered", "Submitted At"])

    for rank, s in enumerate(submissions, 1):
        writer.writerow([
            rank,
            s["username"],
            s["full_name"] or s["username"],
            s["raw_score"],
            s["max_marks"],
            s["score_percentage"],
            s["correct_count"],
            s["wrong_count"],
            s["unanswered_count"],
            s["submitted_at"]
        ])

    output = make_response(si.getvalue())
    output.headers["Content-Disposition"] = f"attachment; filename=AOTS_{test_code}_Results.csv"
    output.headers["Content-type"] = "text/csv"
    return output


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    print(f"🚀 Starting AOTS Web Application on http://127.0.0.1:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
