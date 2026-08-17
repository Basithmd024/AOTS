"""
AOTS - Core OMR Engine (Phase 1)
================================
6-Stage Computer Vision Pipeline:
  Stage 1: Image Quality Validation (blur, exposure)
  Stage 2: Sheet Alignment (auto-detect if warp needed, fiducial-based warp)
  Stage 3: Preprocessing (grayscale, blur, Otsu/adaptive threshold)
  Stage 4: Bubble ROI Extraction from template_spec coordinates
  Stage 5: Fill Ratio Calculation & Answer Classification
  Stage 6: Structured JSON Output with Confidence Scores

Usage:
  python3 omr_engine.py <image_path> [--spec template_spec.json] [--debug]
"""

import json
import sys
import os
import time
import argparse
import numpy as np
import cv2


# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Image Quality Gate
# ─────────────────────────────────────────────────────────────────────────────

def check_image_quality(image: np.ndarray) -> dict:
    """Validate image is usable: blur detection & illumination check."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    is_blurry = laplacian_var < 80.0
    mean_brightness = float(np.mean(gray))
    # For OMR sheets (white paper), high brightness is normal — only flag extremes
    is_too_dark = mean_brightness < 50
    is_overexposed = mean_brightness > 250

    warnings = []
    if is_blurry:
        warnings.append("Image is blurry — retake with steady hands")
    if is_too_dark:
        warnings.append("Image is too dark — improve lighting")
    if is_overexposed:
        warnings.append("Image is overexposed — reduce brightness")

    return {
        "laplacian_variance": round(float(laplacian_var), 2),
        "is_blurry": bool(is_blurry),
        "mean_brightness": round(float(mean_brightness), 2),
        "is_too_dark": bool(is_too_dark),
        "is_overexposed": bool(is_overexposed),
        "quality_ok": bool(not is_blurry and not is_too_dark and not is_overexposed),
        "warnings": warnings
    }


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Sheet Alignment & Perspective Correction
# ─────────────────────────────────────────────────────────────────────────────

def order_points(pts: np.ndarray) -> np.ndarray:
    """Order 4 points as [top-left, top-right, bottom-right, bottom-left]."""
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    d = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(d)]
    rect[3] = pts[np.argmax(d)]
    return rect


def find_sheet_contour(image: np.ndarray, debug: bool = False) -> np.ndarray:
    """
    Find the OMR sheet boundary as the largest rectangular contour.
    This works for real photos where the sheet is on a desk/surface.
    Returns 4 corner points or None if not found.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (7, 7), 0)
    
    # Edge detection
    edges = cv2.Canny(blurred, 30, 100)
    
    # Dilate to close gaps in edges
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    edges = cv2.dilate(edges, kernel, iterations=2)
    
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    if not contours:
        return None
    
    # Sort by area, take largest
    contours = sorted(contours, key=cv2.contourArea, reverse=True)
    
    for c in contours[:5]:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        
        if len(approx) == 4:
            area = cv2.contourArea(approx)
            img_area = image.shape[0] * image.shape[1]
            # Sheet should be at least 20% of image area
            if area > img_area * 0.20:
                if debug:
                    print(f"    Found sheet contour: area={area:.0f} "
                          f"({area/img_area*100:.1f}% of image)")
                return approx.reshape(4, 2).astype("float32")
    
    return None


def find_fiducial_by_template(image: np.ndarray, spec: dict,
                              debug: bool = False) -> np.ndarray:
    """
    Robust full-image fiducial marker search.
    Finds dark square-like clusters across multiple threshold levels,
    groups them relative to the document center, and returns the 4 corner points.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    canvas_w = spec.get("canvas_size", {}).get("width", 1200)
    canvas_h = spec.get("canvas_size", {}).get("height", 1600)

    for th in [70, 90, 110, 130, 150]:
        _, binary = cv2.threshold(blurred, th, 255, cv2.THRESH_BINARY_INV)
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        candidates = []
        for c in contours:
            area = cv2.contourArea(c)
            if area < 60 or area > 35000:
                continue
            bx, by, bw, bh = cv2.boundingRect(c)
            aspect = min(bw, bh) / max(bw, bh)
            if aspect < 0.55:
                continue
            M = cv2.moments(c)
            if M["m00"] == 0:
                continue
            cx = int(M["m10"] / M["m00"])
            cy = int(M["m01"] / M["m00"])
            candidates.append((cx, cy, area * aspect))

        if len(candidates) >= 4:
            all_x = [c[0] for c in candidates]
            all_y = [c[1] for c in candidates]
            mid_x = np.median(all_x)
            mid_y = np.median(all_y)

            tl = [c for c in candidates if c[0] < mid_x and c[1] < mid_y]
            tr = [c for c in candidates if c[0] >= mid_x and c[1] < mid_y]
            br = [c for c in candidates if c[0] >= mid_x and c[1] >= mid_y]
            bl = [c for c in candidates if c[0] < mid_x and c[1] >= mid_y]

            if tl and tr and br and bl:
                tl_pt = max(tl, key=lambda c: c[2])[:2]
                tr_pt = max(tr, key=lambda c: c[2])[:2]
                br_pt = max(br, key=lambda c: c[2])[:2]
                bl_pt = max(bl, key=lambda c: c[2])[:2]
                if debug:
                    print(f"    Dynamic fiducials found: TL={tl_pt}, TR={tr_pt}, BR={br_pt}, BL={bl_pt}")
                return np.array([tl_pt, tr_pt, br_pt, bl_pt], dtype="float32")

    # Fallback to corner estimates
    tl_spec = spec.get("fiducial_markers", {}).get("top_left", {}).get("center", (60, 60))
    tr_spec = spec.get("fiducial_markers", {}).get("top_right", {}).get("center", (1140, 60))
    br_spec = spec.get("fiducial_markers", {}).get("bottom_right", {}).get("center", (1140, 1540))
    bl_spec = spec.get("fiducial_markers", {}).get("bottom_left", {}).get("center", (60, 1540))

    return np.array([
        [int(tl_spec[0] / canvas_w * w), int(tl_spec[1] / canvas_h * h)],
        [int(tr_spec[0] / canvas_w * w), int(tr_spec[1] / canvas_h * h)],
        [int(br_spec[0] / canvas_w * w), int(br_spec[1] / canvas_h * h)],
        [int(bl_spec[0] / canvas_w * w), int(bl_spec[1] / canvas_h * h)]
    ], dtype="float32")


def verify_fiducials(image: np.ndarray, spec: dict, tolerance: int = 15,
                     debug: bool = False) -> tuple:
    """
    Find fiducial markers, searching a wide neighborhood around expected positions.
    Returns (is_aligned, detected_corners).
    
    Strategy: For each expected corner, search in a generous region
    (search_radius pixels) for a dark, square-ish cluster matching the
    marker pattern. This handles rotation/perspective shifts.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    marker_size = spec["marker_size"]
    half_marker = marker_size // 2
    h, w = gray.shape
    
    # Wide search radius to handle significant displacement
    search_radius = max(120, marker_size * 3)

    expected_centers = []
    corner_names = ["top_left", "top_right", "bottom_right", "bottom_left"]
    for name in corner_names:
        expected_centers.append(spec["fiducial_markers"][name]["center"])

    all_ok = True
    detected = []

    # Threshold the full image once for marker detection
    _, binary_full = cv2.threshold(gray, 100, 255, cv2.THRESH_BINARY_INV)

    for i, (ex, ey) in enumerate(expected_centers):
        # Search in a wide region around expected position
        sx1 = max(0, ex - search_radius)
        sy1 = max(0, ey - search_radius)
        sx2 = min(w, ex + search_radius)
        sy2 = min(h, ey + search_radius)

        search_roi = binary_full[sy1:sy2, sx1:sx2]
        
        # Find contours in the search region
        contours, _ = cv2.findContours(
            search_roi, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        
        best_center = None
        best_score = -1
        
        for c in contours:
            area = cv2.contourArea(c)
            # Marker area should be in reasonable range
            expected_area = marker_size * marker_size
            if area < expected_area * 0.15 or area > expected_area * 6:
                continue
            
            # Check squareness
            bx, by, bw, bh = cv2.boundingRect(c)
            aspect = min(bw, bh) / (max(bw, bh) + 1e-5)
            if aspect < 0.5:
                continue
            
            # Get center
            M_c = cv2.moments(c)
            if M_c["m00"] == 0:
                continue
            cx = int(M_c["m10"] / M_c["m00"]) + sx1
            cy = int(M_c["m01"] / M_c["m00"]) + sy1
            
            # Score: prefer larger, more square contours closer to expected
            dist = np.sqrt((cx - ex) ** 2 + (cy - ey) ** 2)
            proximity = max(0, 1 - dist / search_radius)
            score = area * aspect * (0.3 + 0.7 * proximity)
            
            if score > best_score:
                best_score = score
                best_center = (cx, cy)
        
        if best_center is not None:
            detected.append(best_center)
            dist = np.sqrt((best_center[0] - ex) ** 2 + (best_center[1] - ey) ** 2)
            if dist > tolerance:
                all_ok = False
            if debug:
                print(f"      {corner_names[i]}: FOUND at {best_center} "
                      f"(dist={dist:.1f}px, score={best_score:.0f})")
        else:
            all_ok = False
            detected.append((ex, ey))
            if debug:
                print(f"      {corner_names[i]}: NOT FOUND — fallback to ({ex},{ey})")

    return all_ok, np.array(detected, dtype="float32")


def align_sheet(image: np.ndarray, spec: dict, debug: bool = False) -> np.ndarray:
    """
    Smart alignment with verification:
    1. If dimensions match AND fiducials are in place → use directly
    2. If dimensions match but fiducials displaced → warp to correct
    3. If dimensions differ → full perspective correction
    """
    canvas_w = spec["canvas_size"]["width"]
    canvas_h = spec["canvas_size"]["height"]
    img_h, img_w = image.shape[:2]

    size_match = (abs(img_w - canvas_w) <= 5 and abs(img_h - canvas_h) <= 5)

    if size_match:
        if debug:
            print(f"    Dimensions match ({img_w}x{img_h}). Verifying fiducials...")

        is_aligned, detected_corners = verify_fiducials(
            image, spec, tolerance=12, debug=debug
        )

        if is_aligned:
            if debug:
                print(f"    ✓ Path A: Fiducials verified — no correction needed")
            if img_w != canvas_w or img_h != canvas_h:
                return cv2.resize(image, (canvas_w, canvas_h))
            return image.copy()
        else:
            if debug:
                print(f"    ⚠ Path B: Fiducials displaced — applying warp correction")
            # Warp from detected positions to expected positions
            ordered = order_points(detected_corners)
            dst = np.array([
                spec["fiducial_markers"]["top_left"]["center"],
                spec["fiducial_markers"]["top_right"]["center"],
                spec["fiducial_markers"]["bottom_right"]["center"],
                spec["fiducial_markers"]["bottom_left"]["center"]
            ], dtype="float32")

            M = cv2.getPerspectiveTransform(ordered, dst)
            warped = cv2.warpPerspective(
                image, M, (canvas_w, canvas_h),
                flags=cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_REPLICATE
            )
            return warped

    if debug:
        print(f"    Path C: Image size ({img_w}x{img_h}) differs from canvas "
              f"({canvas_w}x{canvas_h}) — full perspective correction")

    # Try finding sheet contour first
    corners = find_sheet_contour(image, debug=debug)

    if corners is None:
        if debug:
            print("    Sheet contour not found — using fiducial search")
        corners = find_fiducial_by_template(image, spec, debug=debug)

    ordered = order_points(corners)
    dst = np.array([
        [0, 0],
        [canvas_w - 1, 0],
        [canvas_w - 1, canvas_h - 1],
        [0, canvas_h - 1]
    ], dtype="float32")

    M = cv2.getPerspectiveTransform(ordered, dst)
    warped = cv2.warpPerspective(image, M, (canvas_w, canvas_h),
                                  flags=cv2.INTER_LINEAR,
                                  borderMode=cv2.BORDER_REPLICATE)
    return warped


# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — Image Preprocessing
# ─────────────────────────────────────────────────────────────────────────────

def preprocess(image: np.ndarray, debug: bool = False) -> np.ndarray:
    """
    Convert to clean binary image optimized for bubble detection.
    Uses Otsu's method for global threshold on white-paper OMR sheets,
    with adaptive threshold as secondary signal.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    # Light Gaussian blur to reduce noise without destroying bubble fills
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    
    # Otsu's thresholding — automatically finds optimal threshold for
    # bimodal distribution (white paper + dark marks)
    otsu_thresh, binary_otsu = cv2.threshold(
        blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
    )
    
    if debug:
        print(f"    Otsu threshold value: {otsu_thresh}")
    
    return binary_otsu


# ─────────────────────────────────────────────────────────────────────────────
# Stage 4 & 5 — Bubble ROI Extraction & Fill Ratio Calculation
# ─────────────────────────────────────────────────────────────────────────────

def analyze_bubbles(binary_image: np.ndarray, spec: dict,
                    debug: bool = False) -> list:
    """
    For each question in the spec, extract bubble ROIs and calculate fill ratios.
    Uses a circular inner mask to exclude the printed bubble ring outline.
    """
    bubble_radius = spec["bubble_radius"]
    inner_radius = spec.get("inner_sample_radius", bubble_radius - 2)
    fill_threshold = spec.get("fill_threshold_pct", 42.0)
    empty_threshold = spec.get("empty_threshold_pct", 18.0)
    questions = spec["questions"]

    # Pre-compute circular inner mask
    mask_diameter = inner_radius * 2 + 1
    inner_mask = np.zeros((mask_diameter, mask_diameter), dtype=np.uint8)
    cv2.circle(inner_mask, (inner_radius, inner_radius), inner_radius, 255, -1)
    total_mask_pixels = cv2.countNonZero(inner_mask)

    results = []
    h, w = binary_image.shape

    for q_key in sorted(questions.keys(), key=lambda x: int(x)):
        q_data = questions[q_key]
        q_num = q_data["question_number"]
        fill_ratios = {}
        option_fills = {}

        for opt_name, opt_data in q_data["options"].items():
            cx, cy = opt_data["center"]

            # Extract ROI centered on bubble
            x1 = cx - inner_radius
            y1 = cy - inner_radius
            x2 = cx + inner_radius + 1
            y2 = cy + inner_radius + 1

            # Bounds check
            x1_clamped = max(0, x1)
            y1_clamped = max(0, y1)
            x2_clamped = min(w, x2)
            y2_clamped = min(h, y2)

            roi = binary_image[y1_clamped:y2_clamped, x1_clamped:x2_clamped]
            roi_h, roi_w = roi.shape

            if roi_h == 0 or roi_w == 0:
                fill_ratios[opt_name] = 0.0
                option_fills[opt_name] = 0.0
                continue

            # Pad ROI if it was clamped at image edges
            if roi_h < mask_diameter or roi_w < mask_diameter:
                padded = np.zeros((mask_diameter, mask_diameter), dtype=np.uint8)
                # Calculate paste offsets
                paste_x = x1_clamped - x1
                paste_y = y1_clamped - y1
                padded[paste_y:paste_y + roi_h, paste_x:paste_x + roi_w] = roi
                roi = padded

            # Apply circular mask and count filled (foreground) pixels
            masked = cv2.bitwise_and(
                roi[:mask_diameter, :mask_diameter], inner_mask
            )
            filled_pixels = cv2.countNonZero(masked)
            fill_pct = (filled_pixels / total_mask_pixels) * 100.0

            fill_ratios[opt_name] = round(fill_pct, 1)
            option_fills[opt_name] = fill_pct

        # ── Relative Contrast Classification Logic ──
        sorted_opts = sorted(option_fills.items(), key=lambda x: x[1], reverse=True)
        top_opt, top_fill = sorted_opts[0]
        second_opt, second_fill = sorted_opts[1]
        fill_gap = top_fill - second_fill

        if top_fill < 28.0:
            # All bubbles are blank/empty
            selected = None
            status = "UNANSWERED"
            confidence = 1.0

        elif top_fill >= fill_threshold:
            # Top option is strong
            if second_fill >= fill_threshold and fill_gap < 18.0:
                # Two bubbles are both heavily marked and close to each other
                selected = "MULTIPLE"
                status = "INVALID_MULTIPLE_FILLS"
                confidence = 0.5
            else:
                selected = top_opt
                status = "ANSWERED"
                confidence = min(1.0, max(0.6, fill_gap / 45.0))

        elif top_fill >= 28.0:
            # Faint / light fill
            if fill_gap >= 12.0:
                selected = top_opt
                status = "ANSWERED_LOW_CONFIDENCE"
                confidence = min(0.75, max(0.35, fill_gap / 30.0))
            else:
                selected = None
                status = "UNANSWERED"
                confidence = 0.75

        else:
            selected = None
            status = "UNANSWERED"
            confidence = 1.0

        results.append({
            "question": q_num,
            "selected": selected,
            "fill_ratios": fill_ratios,
            "status": status,
            "confidence": round(confidence, 2)
        })

        if debug and status != "UNANSWERED":
            print(f"  Q{q_num:02d}: {fill_ratios} → {selected} "
                  f"({status}, conf={confidence:.2f})")

    return results


# ─────────────────────────────────────────────────────────────────────────────
# Stage 6 — Full Pipeline Orchestrator
# ─────────────────────────────────────────────────────────────────────────────

def process_omr_sheet(
    image_path: str,
    spec_path: str = "template_spec.json",
    debug: bool = False
) -> dict:
    """
    Full OMR processing pipeline.

    Args:
        image_path: Path to the OMR sheet photo
        spec_path: Path to template_spec.json
        debug: Print intermediate debug info

    Returns:
        Structured result dict with all question answers and confidence scores
    """
    start_time = time.time()

    # Load inputs
    image = cv2.imread(image_path)
    if image is None:
        return {"status": "ERROR", "error": f"Cannot read image: {image_path}"}

    with open(spec_path, "r") as f:
        spec = json.load(f)

    if debug:
        print(f"[OMR Engine v2] Processing: {image_path}")
        print(f"  Image size: {image.shape[1]}x{image.shape[0]}")

    # ── Stage 1: Quality Gate ──
    quality = check_image_quality(image)
    if debug:
        print(f"  [Stage 1] Quality: blur_var={quality['laplacian_variance']}, "
              f"brightness={quality['mean_brightness']}, ok={quality['quality_ok']}")
        for w in quality["warnings"]:
            print(f"    ⚠️  {w}")

    # ── Stage 2: Alignment ──
    if debug:
        print("  [Stage 2] Aligning sheet...")
    aligned = align_sheet(image, spec, debug=debug)

    if debug:
        debug_dir = os.path.join(os.path.dirname(image_path) or ".", "debug")
        os.makedirs(debug_dir, exist_ok=True)
        base = os.path.splitext(os.path.basename(image_path))[0]
        cv2.imwrite(os.path.join(debug_dir, f"{base}_aligned.png"), aligned)

    # ── Stage 3: Preprocess ──
    if debug:
        print("  [Stage 3] Preprocessing (grayscale → blur → Otsu threshold)...")
    binary = preprocess(aligned, debug=debug)

    if debug:
        cv2.imwrite(os.path.join(debug_dir, f"{base}_binary.png"), binary)

    # ── Stage 4 & 5: Bubble Analysis ──
    if debug:
        print("  [Stage 4-5] Analyzing bubble fill ratios...")
    results = analyze_bubbles(binary, spec, debug=debug)

    # ── Stage 6: Compile Output ──
    elapsed = round(time.time() - start_time, 3)

    answered = sum(1 for r in results if r["status"] == "ANSWERED")
    unanswered = sum(1 for r in results if r["status"] == "UNANSWERED")
    multiple = sum(1 for r in results if r["status"] == "INVALID_MULTIPLE_FILLS")
    low_conf = sum(1 for r in results if r["status"] == "ANSWERED_LOW_CONFIDENCE")
    total = len(results)
    avg_confidence = round(
        sum(r["confidence"] for r in results) / max(total, 1), 3
    )

    output = {
        "status": "SUCCESS",
        "image_path": image_path,
        "processing_time_sec": elapsed,
        "image_quality": {k: v for k, v in quality.items() if k != "warnings"},
        "quality_warnings": quality["warnings"],
        "summary": {
            "total_questions": total,
            "answered": answered,
            "unanswered": unanswered,
            "multiple_marks": multiple,
            "low_confidence": low_conf,
            "overall_confidence": avg_confidence
        },
        "results": results
    }

    if debug:
        print(f"\n  ✅ Done in {elapsed}s — {answered}/{total} answered, "
              f"{unanswered} unanswered, {multiple} multiple, "
              f"confidence={avg_confidence}")

    return output


# ─────────────────────────────────────────────────────────────────────────────
# CLI Entry Point
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="AOTS — OMR Sheet Evaluation Engine"
    )
    parser.add_argument("image", help="Path to the OMR sheet image")
    parser.add_argument(
        "--spec", default="template_spec.json",
        help="Path to template_spec.json (default: template_spec.json)"
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="Print detailed debug output and save intermediate images"
    )
    parser.add_argument(
        "--output", "-o", default=None,
        help="Save JSON result to this file (default: print to stdout)"
    )
    args = parser.parse_args()

    result = process_omr_sheet(args.image, args.spec, debug=args.debug)

    json_output = json.dumps(result, indent=2)

    if args.output:
        with open(args.output, "w") as f:
            f.write(json_output)
        print(f"Result saved to {args.output}")
    else:
        print(json_output)


if __name__ == "__main__":
    main()
