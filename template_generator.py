"""
AOTS - OMR Template & Layout Generator
Generates:
1. template_spec.json (canonical coordinate map of all fiducials and bubbles)
2. blank_omr.png (high-resolution standard printable OMR sheet)
"""

import json
import os
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

CANVAS_WIDTH = 1200
CANVAS_HEIGHT = 1600

def create_omr_template(output_dir: str = "."):
    os.makedirs(output_dir, exist_ok=True)
    
    # Create white canvas (RGB)
    img = Image.new("RGB", (CANVAS_WIDTH, CANVAS_HEIGHT), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    
    # Fiducial Marker Configuration (4 Corners)
    # High-contrast solid black squares with white inner center
    marker_size = 48
    corner_offset = 36
    
    markers = {
        "top_left": {"center": [corner_offset + marker_size // 2, corner_offset + marker_size // 2]},
        "top_right": {"center": [CANVAS_WIDTH - corner_offset - marker_size // 2, corner_offset + marker_size // 2]},
        "bottom_right": {"center": [CANVAS_WIDTH - corner_offset - marker_size // 2, CANVAS_HEIGHT - corner_offset - marker_size // 2]},
        "bottom_left": {"center": [corner_offset + marker_size // 2, CANVAS_HEIGHT - corner_offset - marker_size // 2]}
    }
    
    def draw_fiducial(center_x, center_y, size):
        half = size // 2
        # Outer black box
        draw.rectangle([center_x - half, center_y - half, center_x + half, center_y + half], fill=(0, 0, 0))
        # Inner white box
        inner_half = half // 2
        draw.rectangle([center_x - inner_half, center_y - inner_half, center_x + inner_half, center_y + inner_half], fill=(255, 255, 255))
        # Center black dot
        core_half = inner_half // 2
        draw.rectangle([center_x - core_half, center_y - core_half, center_x + core_half, center_y + core_half], fill=(0, 0, 0))

    for m in markers.values():
        draw_fiducial(m["center"][0], m["center"][1], marker_size)
        
    # Outer Border Box
    draw.rectangle([corner_offset + 10, corner_offset + 10, CANVAS_WIDTH - corner_offset - 10, CANVAS_HEIGHT - corner_offset - 10], outline=(0, 0, 0), width=3)
    
    # Header Section
    header_top = corner_offset + 25
    header_bottom = header_top + 160
    draw.rectangle([corner_offset + 20, header_top, CANVAS_WIDTH - corner_offset - 20, header_bottom], outline=(0, 0, 0), width=2)
    
    # Institute Name & Title Text (Using standard default font with fallback rendering)
    try:
        font_title = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 34)
        font_sub = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 20)
        font_label = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 16)
        font_q = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 16)
        font_opt = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 13)
    except Exception:
        font_title = ImageFont.load_default()
        font_sub = ImageFont.load_default()
        font_label = ImageFont.load_default()
        font_q = ImageFont.load_default()
        font_opt = ImageFont.load_default()
        
    draw.text((CANVAS_WIDTH // 2, header_top + 28), "AOTS EXAMINATION SYSTEM", fill=(0, 0, 0), font=font_title, anchor="mm")
    draw.text((CANVAS_WIDTH // 2, header_top + 65), "ECET PREPARATION EXAM — OFFICIAL OMR ANSWER SHEET", fill=(60, 60, 60), font=font_sub, anchor="mm")
    
    # Metadata fields in header
    draw.line([corner_offset + 20, header_top + 95, CANVAS_WIDTH - corner_offset - 20, header_top + 95], fill=(0, 0, 0), width=1)
    
    draw.text((corner_offset + 40, header_top + 125), "STUDENT NAME: ____________________________", fill=(0, 0, 0), font=font_label, anchor="lm")
    draw.text((corner_offset + 480, header_top + 125), "ROLL NO: ____________", fill=(0, 0, 0), font=font_label, anchor="lm")
    draw.text((corner_offset + 740, header_top + 125), "TEST CODE: SM-ECET-003", fill=(0, 0, 0), font=font_label, anchor="lm")
    draw.text((corner_offset + 1000, header_top + 125), "BATCH: 2026", fill=(0, 0, 0), font=font_label, anchor="lm")

    # Instructions box
    inst_top = header_bottom + 15
    inst_bottom = inst_top + 60
    draw.rectangle([corner_offset + 20, inst_top, CANVAS_WIDTH - corner_offset - 20, inst_bottom], fill=(245, 245, 245), outline=(150, 150, 150), width=1)
    draw.text((CANVAS_WIDTH // 2, inst_top + 20), "INSTRUCTIONS: Darken completely with Blue/Black Ballpoint Pen or HB Pencil. Fill like (●), not (✓) or (✗).", fill=(0, 0, 0), font=font_label, anchor="mm")
    draw.text((CANVAS_WIDTH // 2, inst_top + 42), "Only one bubble per question. Multiple marks will be treated as invalid.", fill=(100, 0, 0), font=font_sub, anchor="mm")

    # Grid Setup (50 Questions total, 2 Columns of 25 Questions)
    # Column 1: Q1 - Q25
    # Column 2: Q26 - Q50
    grid_top = inst_bottom + 25
    num_rows = 25
    row_height = 44
    bubble_radius = 12
    opt_spacing = 42
    
    col1_start_x = corner_offset + 50
    col2_start_x = CANVAS_WIDTH // 2 + 30
    
    col_width = (CANVAS_WIDTH // 2) - corner_offset - 60
    
    # Template specification dictionary
    template_spec = {
        "canvas_size": {"width": CANVAS_WIDTH, "height": CANVAS_HEIGHT},
        "fiducial_markers": markers,
        "marker_size": marker_size,
        "bubble_radius": bubble_radius,
        "inner_sample_radius": bubble_radius - 2,
        "fill_threshold_pct": 42.0,
        "empty_threshold_pct": 18.0,
        "questions": {}
    }
    
    def render_question_block(start_q, end_q, col_x):
        # Column Header Box
        header_y = grid_top
        draw.rectangle([col_x, header_y, col_x + col_width, header_y + 35], fill=(230, 235, 245), outline=(0, 0, 0), width=1)
        draw.text((col_x + 35, header_y + 18), "Q.No", fill=(0, 0, 0), font=font_label, anchor="mm")
        
        opt_start_x = col_x + 120
        options = ["A", "B", "C", "D"]
        for idx, opt in enumerate(options):
            bx = opt_start_x + idx * opt_spacing
            draw.text((bx, header_y + 18), opt, fill=(0, 0, 0), font=font_label, anchor="mm")
            
        current_y = header_y + 35
        
        for q_num in range(start_q, end_q + 1):
            q_idx = q_num - start_q
            row_y = current_y + q_idx * row_height
            
            # Alternating row background for visual contrast
            if q_idx % 2 == 1:
                draw.rectangle([col_x, row_y, col_x + col_width, row_y + row_height], fill=(250, 250, 252), outline=None)
            
            # Row divider
            draw.line([col_x, row_y + row_height, col_x + col_width, row_y + row_height], fill=(210, 210, 210), width=1)
            
            # Question number
            draw.text((col_x + 35, row_y + row_height // 2), f"{q_num:02d}", fill=(0, 0, 0), font=font_q, anchor="mm")
            
            q_bubbles = {}
            for opt_idx, opt in enumerate(options):
                bx = opt_start_x + opt_idx * opt_spacing
                by = row_y + row_height // 2
                
                # Draw bubble ring
                draw.ellipse([bx - bubble_radius, by - bubble_radius, bx + bubble_radius, by + bubble_radius], outline=(0, 0, 0), width=2)
                # Option letter inside bubble
                draw.text((bx, by), opt, fill=(90, 90, 90), font=font_opt, anchor="mm")
                
                q_bubbles[opt] = {
                    "center": [bx, by],
                    "radius": bubble_radius,
                    "bbox": [bx - bubble_radius, by - bubble_radius, bx + bubble_radius, by + bubble_radius]
                }
                
            template_spec["questions"][str(q_num)] = {
                "question_number": q_num,
                "options": q_bubbles
            }
            
        # Outer column border
        total_grid_h = 35 + num_rows * row_height
        draw.rectangle([col_x, header_y, col_x + col_width, header_y + total_grid_h], outline=(0, 0, 0), width=2)

    # Render Column 1 (Q1 - Q25) and Column 2 (Q26 - Q50)
    render_question_block(1, 25, col1_start_x)
    render_question_block(26, 50, col2_start_x)

    # Footer note
    draw.text((CANVAS_WIDTH // 2, CANVAS_HEIGHT - corner_offset - 25), "AOTS ECET Assessment Engine • System-Generated OMR Template • Do Not Fold", fill=(120, 120, 120), font=font_sub, anchor="mm")

    # Save Template Image
    template_img_path = os.path.join(output_dir, "blank_omr.png")
    img.save(template_img_path, "PNG", dpi=(300, 300))
    
    # Save Template Spec JSON
    spec_json_path = os.path.join(output_dir, "template_spec.json")
    with open(spec_json_path, "w") as f:
        json.dump(template_spec, f, indent=2)
        
    print(f"Generated OMR Template: {template_img_path}")
    print(f"Generated Template Spec: {spec_json_path}")
    return template_img_path, spec_json_path

if __name__ == "__main__":
    create_omr_template()
