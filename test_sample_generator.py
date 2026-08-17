"""
Said Medha Institute - OMR Test Sample Generator
=================================================
Generates synthetic filled OMR sheets for testing the engine.

Creates multiple test scenarios:
1. Clean fill (perfectly filled bubbles, ideal conditions)
2. Partial fills (lightly marked bubbles)
3. Multiple marks (2 options filled for some questions)
4. Unanswered questions (some left blank)
5. Perspective-distorted (simulates angled camera)
6. Noisy/shadow overlay (simulates poor lighting)

Each test sample is saved alongside a ground_truth.json for validation.
"""

import json
import os
import random
import numpy as np
import cv2
from PIL import Image, ImageDraw


def load_template(template_img_path: str = "blank_omr.png",
                  spec_path: str = "template_spec.json"):
    """Load the blank OMR template and its coordinate spec."""
    img = cv2.imread(template_img_path)
    if img is None:
        raise FileNotFoundError(f"Cannot load template: {template_img_path}")
    with open(spec_path, "r") as f:
        spec = json.load(f)
    return img, spec


def fill_bubble(image: np.ndarray, center: list, radius: int,
                fill_intensity: float = 1.0):
    """
    Fill a bubble on the OMR image.
    
    fill_intensity:
        1.0 = fully darkened (solid fill)
        0.5 = partial fill (light marks)
        0.2 = very faint (erased/ghost mark)
    """
    cx, cy = center
    # Create a filled circle with variable darkness
    color_val = int(255 * (1 - fill_intensity))  # 0=black (full), 255=white (empty)
    color = (color_val, color_val, color_val)
    inner_radius = radius - 1  # Slightly inside the printed ring
    cv2.circle(image, (cx, cy), inner_radius, color, -1, lineType=cv2.LINE_AA)
    return image


def generate_answer_set(num_questions: int = 50, 
                        unanswered_pct: float = 0.08,
                        multiple_pct: float = 0.04) -> dict:
    """
    Generate a random answer set with controlled edge cases.
    
    Returns dict mapping question number -> answer info:
        {"selected": "A"|"B"|"C"|"D"|None|"MULTIPLE", "fill_intensity": float}
    """
    options = ["A", "B", "C", "D"]
    answers = {}
    
    for q in range(1, num_questions + 1):
        r = random.random()
        if r < unanswered_pct:
            # Leave unanswered
            answers[q] = {"selected": None, "fill_intensity": 0.0, "extra": None}
        elif r < unanswered_pct + multiple_pct:
            # Multiple marks
            chosen = random.sample(options, 2)
            answers[q] = {
                "selected": chosen[0],  # ground truth: first chosen
                "fill_intensity": random.uniform(0.7, 1.0),
                "extra": chosen[1],  # second mark
                "is_multiple": True
            }
        else:
            # Normal single answer
            chosen = random.choice(options)
            intensity = random.uniform(0.65, 1.0)  # Varying fill darkness
            answers[q] = {
                "selected": chosen,
                "fill_intensity": intensity,
                "extra": None
            }
    
    return answers


def render_filled_sheet(template_img: np.ndarray, spec: dict, 
                        answers: dict) -> np.ndarray:
    """Apply answer fills to a copy of the blank OMR template."""
    filled = template_img.copy()
    bubble_radius = spec["bubble_radius"]
    
    for q_num, answer_info in answers.items():
        q_key = str(q_num)
        if q_key not in spec["questions"]:
            continue
            
        q_data = spec["questions"][q_key]
        
        if answer_info["selected"] is None:
            continue  # Skip unanswered
            
        # Fill primary answer
        opt = answer_info["selected"]
        if opt in q_data["options"]:
            center = q_data["options"][opt]["center"]
            fill_bubble(filled, center, bubble_radius, answer_info["fill_intensity"])
        
        # Fill extra mark if multiple
        extra = answer_info.get("extra")
        if extra and extra in q_data["options"]:
            center = q_data["options"][extra]["center"]
            fill_bubble(filled, center, bubble_radius, 
                       answer_info["fill_intensity"] * 0.9)
    
    return filled


def apply_perspective_distortion(image: np.ndarray, severity: float = 0.05) -> np.ndarray:
    """Simulate camera angle by applying random perspective transform."""
    h, w = image.shape[:2]
    
    # Random corner offsets
    offset = int(min(w, h) * severity)
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([
        [random.randint(0, offset), random.randint(0, offset)],
        [w - random.randint(0, offset), random.randint(0, offset)],
        [w - random.randint(0, offset * 2), h - random.randint(0, offset)],
        [random.randint(0, offset * 2), h - random.randint(0, offset)]
    ])
    
    M = cv2.getPerspectiveTransform(src, dst)
    # Warp onto a slightly larger canvas to avoid cropping
    result = cv2.warpPerspective(image, M, (w, h), 
                                  borderMode=cv2.BORDER_CONSTANT,
                                  borderValue=(240, 240, 240))
    return result


def apply_shadow(image: np.ndarray) -> np.ndarray:
    """Add a diagonal shadow gradient to simulate hand/phone shadow."""
    h, w = image.shape[:2]
    shadow = np.ones((h, w), dtype=np.float32)
    
    # Create diagonal gradient shadow
    for i in range(h):
        for j in range(w):
            # Shadow stronger in top-right corner
            factor = 1.0 - 0.35 * ((j / w) * 0.7 + (1 - i / h) * 0.3)
            shadow[i, j] = max(0.6, factor)
    
    # Apply shadow to all channels
    result = image.astype(np.float32)
    for c in range(3):
        result[:, :, c] *= shadow
    
    return np.clip(result, 0, 255).astype(np.uint8)


def apply_noise(image: np.ndarray, noise_level: float = 15.0) -> np.ndarray:
    """Add Gaussian noise to simulate camera sensor noise."""
    noise = np.random.normal(0, noise_level, image.shape).astype(np.float32)
    noisy = image.astype(np.float32) + noise
    return np.clip(noisy, 0, 255).astype(np.uint8)


def apply_rotation(image: np.ndarray, angle_deg: float = 2.0) -> np.ndarray:
    """Apply slight rotation to simulate tilted scan."""
    h, w = image.shape[:2]
    center = (w // 2, h // 2)
    M = cv2.getRotationMatrix2D(center, angle_deg, 1.0)
    rotated = cv2.warpAffine(image, M, (w, h), 
                              borderMode=cv2.BORDER_CONSTANT,
                              borderValue=(235, 235, 235))
    return rotated


def build_ground_truth(answers: dict) -> dict:
    """Convert answer set to expected engine output format for comparison."""
    ground_truth = {}
    for q_num, info in answers.items():
        if info["selected"] is None:
            expected_status = "UNANSWERED"
            expected_selected = None
        elif info.get("is_multiple"):
            expected_status = "INVALID_MULTIPLE_FILLS"
            expected_selected = "MULTIPLE"
        else:
            expected_status = "ANSWERED"
            expected_selected = info["selected"]
        
        ground_truth[str(q_num)] = {
            "question": q_num,
            "expected_selected": expected_selected,
            "expected_status": expected_status
        }
    
    return ground_truth


def generate_test_suite(output_dir: str = "test_samples",
                        template_img_path: str = "blank_omr.png",
                        spec_path: str = "template_spec.json",
                        num_clean: int = 3,
                        seed: int = 42):
    """Generate a full test suite of synthetic OMR samples."""
    random.seed(seed)
    np.random.seed(seed)
    
    os.makedirs(output_dir, exist_ok=True)
    template_img, spec = load_template(template_img_path, spec_path)
    
    test_manifest = {"tests": []}
    test_id = 0

    def save_test(name: str, image: np.ndarray, answers: dict, description: str):
        nonlocal test_id
        test_id += 1
        img_filename = f"test_{test_id:03d}_{name}.png"
        gt_filename = f"test_{test_id:03d}_{name}_ground_truth.json"
        
        img_path = os.path.join(output_dir, img_filename)
        gt_path = os.path.join(output_dir, gt_filename)
        
        cv2.imwrite(img_path, image)
        
        ground_truth = build_ground_truth(answers)
        with open(gt_path, "w") as f:
            json.dump(ground_truth, f, indent=2)
        
        test_manifest["tests"].append({
            "id": test_id,
            "name": name,
            "description": description,
            "image": img_filename,
            "ground_truth": gt_filename
        })
        print(f"  ✓ Test {test_id:03d}: {name} → {img_filename}")

    print(f"Generating OMR test suite in '{output_dir}/'...\n")

    # ── Test Type 1: Clean fills (ideal conditions) ──
    for i in range(num_clean):
        answers = generate_answer_set(unanswered_pct=0.06, multiple_pct=0.02)
        filled = render_filled_sheet(template_img, spec, answers)
        save_test(f"clean_{i+1}", filled, answers, 
                  "Ideal conditions: clean fills, no distortion")

    # ── Test Type 2: Light/partial fills ──
    answers = generate_answer_set(unanswered_pct=0.10, multiple_pct=0.0)
    # Override intensities to be lighter
    for q in answers:
        if answers[q]["selected"] is not None:
            answers[q]["fill_intensity"] = random.uniform(0.40, 0.60)
    filled = render_filled_sheet(template_img, spec, answers)
    save_test("partial_fill", filled, answers,
              "Light/partial bubble fills — tests threshold sensitivity")

    # ── Test Type 3: Multiple marks stress test ──
    answers = generate_answer_set(unanswered_pct=0.04, multiple_pct=0.20)
    filled = render_filled_sheet(template_img, spec, answers)
    save_test("multiple_marks", filled, answers,
              "Higher rate of multiple marks — tests invalid detection")

    # ── Test Type 4: Perspective distorted ──
    answers = generate_answer_set(unanswered_pct=0.06, multiple_pct=0.02)
    filled = render_filled_sheet(template_img, spec, answers)
    distorted = apply_perspective_distortion(filled, severity=0.04)
    save_test("perspective_skew", distorted, answers,
              "Perspective distortion — simulates angled camera shot")

    # ── Test Type 5: Slightly rotated ──
    answers = generate_answer_set(unanswered_pct=0.06, multiple_pct=0.02)
    filled = render_filled_sheet(template_img, spec, answers)
    rotated = apply_rotation(filled, angle_deg=random.uniform(1.5, 3.0))
    save_test("rotated", rotated, answers,
              "Slight rotation — simulates tilted phone capture")

    # ── Test Type 6: Noisy (camera sensor noise) ──
    answers = generate_answer_set(unanswered_pct=0.06, multiple_pct=0.02)
    filled = render_filled_sheet(template_img, spec, answers)
    noisy = apply_noise(filled, noise_level=20.0)
    save_test("noisy", noisy, answers,
              "Added Gaussian noise — simulates low-light camera sensor")

    # ── Test Type 7: Shadow overlay ──
    answers = generate_answer_set(unanswered_pct=0.06, multiple_pct=0.02)
    filled = render_filled_sheet(template_img, spec, answers)
    shadowed = apply_shadow(filled)
    save_test("shadow", shadowed, answers,
              "Diagonal shadow gradient — simulates hand shadow during capture")

    # ── Test Type 8: Combined worst case (rotate + noise + perspective) ──
    answers = generate_answer_set(unanswered_pct=0.08, multiple_pct=0.04)
    filled = render_filled_sheet(template_img, spec, answers)
    worst = apply_perspective_distortion(filled, severity=0.03)
    worst = apply_rotation(worst, angle_deg=1.5)
    worst = apply_noise(worst, noise_level=12.0)
    save_test("worst_case", worst, answers,
              "Combined: perspective + rotation + noise — hardest test case")

    # Save manifest
    manifest_path = os.path.join(output_dir, "test_manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(test_manifest, f, indent=2)
    
    print(f"\n✅ Generated {test_id} test samples")
    print(f"📋 Manifest: {manifest_path}")
    return manifest_path


if __name__ == "__main__":
    generate_test_suite()
