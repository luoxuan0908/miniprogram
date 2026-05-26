#!/usr/bin/env python3
"""Generate AI轻松英语 app icon as 240x240 PNG using Pillow."""
from PIL import Image, ImageDraw, ImageFont
import math

SIZE = 240
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded square background with gradient (dark blue to teal)
# Draw row by row for gradient effect
for y in range(SIZE):
    ratio = y / SIZE
    r = int(26 + (22 - 26) * ratio)   # #1a -> #16
    g = int(26 + (160 - 26) * ratio)   # #1a -> #a0
    b = int(46 + (133 - 46) * ratio)   # #2e -> #85
    for x in range(SIZE):
        # Check if inside rounded square
        cx, cy = SIZE // 2, SIZE // 2
        radius = 36  # corner radius
        half = SIZE // 2 - 2
        
        # Check corners
        in_shape = True
        for corner_x, corner_y in [(radius, radius), (SIZE - radius, radius), 
                                     (radius, SIZE - radius), (SIZE - radius, SIZE - radius)]:
            dx = abs(x - corner_x)
            dy = abs(y - corner_y)
            if x < radius and y < radius:
                if math.sqrt((x - radius)**2 + (y - radius)**2) > radius:
                    in_shape = False
                    break
            elif x > SIZE - radius and y < radius:
                if math.sqrt((x - (SIZE - radius))**2 + (y - radius)**2) > radius:
                    in_shape = False
                    break
            elif x < radius and y > SIZE - radius:
                if math.sqrt((x - radius)**2 + (y - (SIZE - radius))**2) > radius:
                    in_shape = False
                    break
            elif x > SIZE - radius and y > SIZE - radius:
                if math.sqrt((x - (SIZE - radius))**2 + (y - (SIZE - radius))**2) > radius:
                    in_shape = False
                    break
        
        if in_shape:
            img.putpixel((x, y), (r, g, b, 255))

# Draw headphone arc (top part)
arc_cx, arc_cy = SIZE // 2, 108
arc_rx, arc_ry = 52, 40
for angle in range(0, 180):
    rad = math.radians(angle)
    x = int(arc_cx + arc_rx * math.cos(rad))
    y = int(arc_cy - arc_ry * math.sin(rad))
    # Draw thick arc (3px)
    for dx in range(-2, 3):
        for dy in range(-2, 3):
            px, py = x + dx, y + dy
            if 0 <= px < SIZE and 0 <= py < SIZE:
                img.putpixel((px, py), (255, 255, 255, 255))

# Left earpiece
for y in range(95, 150):
    for x in range(55, 72):
        # Rounded rect
        if (x - 55) < 6 and (y - 95) < 6:
            if math.sqrt((x - 61)**2 + (y - 101)**2) > 6: continue
        if (x - 55) < 6 and (150 - y) < 6:
            if math.sqrt((x - 61)**2 + (y - 144)**2) > 6: continue
        img.putpixel((x, y), (255, 255, 255, 255))

# Right earpiece  
for y in range(95, 150):
    for x in range(168, 185):
        if (185 - x) < 6 and (y - 95) < 6:
            if math.sqrt((x - 179)**2 + (y - 101)**2) > 6: continue
        if (185 - x) < 6 and (150 - y) < 6:
            if math.sqrt((x - 179)**2 + (y - 144)**2) > 6: continue
        img.putpixel((x, y), (255, 255, 255, 255))

# Sound waves (3 arcs on right side)
for wave_i in range(3):
    wave_cx = 200
    wave_cy = 120
    wave_r = 16 + wave_i * 12
    alpha = 255 - wave_i * 70
    for angle in range(-50, 51):
        rad = math.radians(angle)
        x = int(wave_cx + wave_r * math.cos(rad))
        y = int(wave_cy + wave_r * math.sin(rad))
        for dx in range(-1, 2):
            px = x + dx
            if 0 <= px < SIZE and 0 <= y < SIZE:
                img.putpixel((px, y), (255, 255, 255, alpha))

# Letter "A" in the center
# Simple geometric A using lines
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 62)
    draw = ImageDraw.Draw(img)
    bbox = draw.textbbox((0, 0), "A", font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (SIZE - tw) // 2
    ty = 132
    draw.text((tx, ty), "A", fill=(255, 255, 255, 220), font=font)
except:
    # Fallback: draw A with lines
    ax, ay = SIZE // 2, 140
    draw.polygon([(ax, ay), (ax - 18, ay + 45), (ax + 18, ay + 45)], fill=(255, 255, 255, 220))
    draw.rectangle([ax - 14, ay + 22, ax + 14, ay + 28], fill=(26, 26, 46, 255))

# Save
output = '/Users/luoxuan/Workspace/Study/en/MiniProgram/miniprogram/images/app-icon-240.png'
img = img.resize((240, 240), Image.LANCZOS)
img.save(output, 'PNG')
print(f'Saved to {output}')
