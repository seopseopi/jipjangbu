"""Regenerate compatible PNG/SVG logos from app/brand-mark.tsx.

The house silhouette contains an open ledger as negative space. The React mark
is the single geometry source; Pillow samples its SVG paths at 8x resolution.

    python3 scripts/make_logo.py

No additional raster/SVG dependency is required beyond Pillow. Keep the public
PNG names: worker/security.ts allows these before login.
"""
from html import escape
import math
from pathlib import Path
import re
from PIL import Image, ImageChops, ImageDraw

NAVY = "#2c394b"
TILE_BACKGROUND = "#ffffff"
TILE_BORDER = "#d8dde6"
TILE_RADIUS = 0.22
TILE_SYMBOL = 0.70


def rgba(value):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4)) + (255,)


def source_geometry(root):
    source = (root / "app" / "brand-mark.tsx").read_text()
    view_box = tuple(map(float, re.search(r'viewBox="([^"]+)"', source)[1].split()))
    paths = []
    for markup in re.findall(r'<path\b([^>]*?)/>', source):
        attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', markup))
        attrs = {re.sub(r'[A-Z]', lambda match: '-' + match[0].lower(), key): value.replace('currentColor', NAVY)
                 for key, value in attrs.items()}
        paths.append(attrs)
    if not paths or view_box[2] != view_box[3]:
        raise ValueError("The brand source must contain paths and a square viewBox")
    return view_box, paths


def arc_points(start, end, rx, ry, degrees, large, sweep):
    """SVG endpoint arc conversion, returning sampled points after start."""
    if start == end:
        return []
    rx, ry = abs(rx), abs(ry)
    if not rx or not ry:
        return [end]
    phi = math.radians(degrees)
    cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (start[0] - end[0]) / 2, (start[1] - end[1]) / 2
    xp, yp = cp * dx + sp * dy, -sp * dx + cp * dy
    radius_scale = xp * xp / (rx * rx) + yp * yp / (ry * ry)
    if radius_scale > 1:
        rx *= math.sqrt(radius_scale)
        ry *= math.sqrt(radius_scale)
    denominator = rx * rx * yp * yp + ry * ry * xp * xp
    numerator = max(0, rx * rx * ry * ry - denominator)
    coefficient = (-1 if bool(large) == bool(sweep) else 1) * math.sqrt(numerator / denominator) if denominator else 0
    cxp, cyp = coefficient * rx * yp / ry, -coefficient * ry * xp / rx
    cx = cp * cxp - sp * cyp + (start[0] + end[0]) / 2
    cy = sp * cxp + cp * cyp + (start[1] + end[1]) / 2
    theta = math.atan2((yp - cyp) / ry, (xp - cxp) / rx)
    finish = math.atan2((-yp - cyp) / ry, (-xp - cxp) / rx)
    delta = (finish - theta) % math.tau
    if not sweep and delta > 0:
        delta -= math.tau
    count = max(4, math.ceil(abs(delta) * 18))
    return [(cx + cp * rx * math.cos(theta + delta * step / count) - sp * ry * math.sin(theta + delta * step / count),
             cy + sp * rx * math.cos(theta + delta * step / count) + cp * ry * math.sin(theta + delta * step / count))
            for step in range(1, count + 1)]


def contours(data):
    """Flatten the mark's M/L/H/V/C/A/Z paths; reject unsupported commands."""
    tokens = re.findall(r'[A-Za-z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?', data)
    result, points = [], []
    current, start, command, index = (0.0, 0.0), (0.0, 0.0), None, 0
    while index < len(tokens):
        if tokens[index].isalpha():
            command = tokens[index]
            index += 1
        kind = command.upper()
        relative = command.islower()
        if kind == 'Z':
            if points:
                result.append((points + [start], True))
                points = []
            current, command = start, None
            continue
        count = {'M': 2, 'L': 2, 'H': 1, 'V': 1, 'C': 6, 'A': 7}.get(kind)
        if count is None:
            raise ValueError(f"Unsupported SVG path command: {command}")
        values = list(map(float, tokens[index:index + count]))
        if len(values) != count:
            raise ValueError("Incomplete SVG path")
        index += count
        def point(x, y):
            return (x + current[0], y + current[1]) if relative else (x, y)
        if kind in ('M', 'L'):
            target = point(*values)
            if kind == 'M':
                if points:
                    result.append((points, False))
                points, start = [], target
                command = 'l' if relative else 'L'
            points.append(target)
        elif kind == 'H':
            target = (values[0] + current[0] if relative else values[0], current[1])
            points.append(target)
        elif kind == 'V':
            target = (current[0], values[0] + current[1] if relative else values[0])
            points.append(target)
        elif kind == 'C':
            first, second, target = point(*values[:2]), point(*values[2:4]), point(*values[4:])
            for step in range(1, 33):
                t, u = step / 32, 1 - step / 32
                points.append(tuple(u ** 3 * current[k] + 3 * u * u * t * first[k] + 3 * u * t * t * second[k] + t ** 3 * target[k] for k in (0, 1)))
        else:
            target = point(*values[5:])
            points.extend(arc_points(current, target, *values[:5]))
        current = target
    if points:
        result.append((points, False))
    return result


def render(size, tile, out, view_box, paths):
    canvas = size * 8
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if tile:
        draw.rounded_rectangle([0, 0, canvas - 1, canvas - 1], radius=round(canvas * TILE_RADIUS),
                               fill=rgba(TILE_BACKGROUND), outline=rgba(TILE_BORDER), width=max(1, round(canvas / 96)))
    scale = canvas * (TILE_SYMBOL if tile else 1) / view_box[2]
    inset = (canvas - view_box[2] * scale) / 2
    def placed(points):
        return [((x - view_box[0]) * scale + inset, (y - view_box[1]) * scale + inset) for x, y in points]
    for attrs in paths:
        shapes = contours(attrs['d'])
        fill = attrs.get('fill', 'none')
        if fill != 'none':
            mask = Image.new('L', image.size)
            for points, _ in shapes:
                contour_mask = Image.new('L', image.size)
                ImageDraw.Draw(contour_mask).polygon(placed(points), fill=255)
                mask = ImageChops.difference(mask, contour_mask) if attrs.get('fill-rule') == 'evenodd' else ImageChops.lighter(mask, contour_mask)
            image.paste(rgba(fill), (0, 0), mask)
        if attrs.get('stroke', 'none') != 'none':
            draw = ImageDraw.Draw(image)
            for points, _ in shapes:
                draw.line(placed(points), fill=rgba(attrs['stroke']), width=round(float(attrs.get('stroke-width', 1)) * scale), joint='curve')
    image.resize((size, size), Image.Resampling.LANCZOS).save(out)


def svg_paths(paths):
    return ''.join('<path ' + ' '.join(f'{key}="{escape(value, quote=True)}"' for key, value in attrs.items()) + '/>' for attrs in paths)


def main():
    root = Path(__file__).resolve().parent.parent
    public, docs = root / "public", root / "docs" / "assets"
    view_box, paths = source_geometry(root)
    render(512, False, public / "jipjangbu-logo.png", view_box, paths)
    render(192, True, public / "jipjangbu-icon-bright.png", view_box, paths)
    render(96, True, public / "jipjangbu-icon.png", view_box, paths)
    mark = svg_paths(paths)
    vb = ' '.join(f'{number:g}' for number in view_box)
    (docs / "jipjangbu-mark.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" fill="none"><title>집장부 · 집과 열린 장부</title>{mark}</svg>\n')
    scale = 48 * TILE_SYMBOL / view_box[2]
    x = (48 - view_box[2] * scale) / 2 - view_box[0] * scale
    y = (48 - view_box[3] * scale) / 2 - view_box[1] * scale
    tile = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">'
            '<title>집장부 · 집과 열린 장부</title>'
            f'<rect x="0.25" y="0.25" width="47.5" height="47.5" rx="{48 * TILE_RADIUS:g}" fill="{TILE_BACKGROUND}" stroke="{TILE_BORDER}" stroke-width="0.5"/>'
            f'<g transform="translate({x:.8g} {y:.8g}) scale({scale:.8g})">{mark}</g></svg>\n')
    (docs / "jipjangbu-mark-tile.svg").write_text(tile)
    (public / "favicon.svg").write_text(tile)


if __name__ == "__main__":
    main()
