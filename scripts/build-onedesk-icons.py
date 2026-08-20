#!/usr/bin/env python3
"""Generate the OneDesk icon system from one geometry source."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

PURPLE = "#6D5EFC"
PURPLE_DARK = "#5346D6"
PURPLE_DEEP = "#3D34B0"
INK = "#1A1D23"
PAPER = "#F3F4F6"
WHITE = "#FFFFFF"
MIST = "#E4E6EA"
SLATE = "#5C6370"
CHARCOAL = "#141416"
PANEL = "#1B1C20"
LINE = "#2A2C32"

# Glyph lives on a 64 grid. Padding is already built in.
STEM = (18.0, 10.0, 30.0, 42.0)
STEM_R = 4.0
BAR = (33.0, 30.0, 48.0, 38.0)
BAR_R = 4.0
DESK = (12.0, 44.0, 52.0, 54.0)
DESK_R = 5.0
APP_R = 14.2

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "apps" / "web-hub" / "public"
ICONS = PUBLIC / "icons"


def svg_rect(box: tuple[float, float, float, float], r: float, fill: str) -> str:
    x1, y1, x2, y2 = box
    return (
        f'<rect x="{x1:.2f}" y="{y1:.2f}" width="{x2 - x1:.2f}" '
        f'height="{y2 - y1:.2f}" rx="{r:.2f}" fill="{fill}"/>'
    )


def mark_shapes(fill: str) -> str:
    return "\n  ".join(
        [
            svg_rect(STEM, STEM_R, fill),
            svg_rect(BAR, BAR_R, fill),
            svg_rect(DESK, DESK_R, fill),
        ]
    )


def wrap_svg(body: str, view: int = 64, size: int | None = None) -> str:
    wh = f' width="{size}" height="{size}"' if size else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {view} {view}"'
        f'{wh} fill="none">\n  {body}\n</svg>\n'
    )


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def mark_svg(fill: str = "currentColor") -> str:
    return wrap_svg(mark_shapes(fill))


def app_svg(rounded: bool = True) -> str:
    radius = APP_R if rounded else 0
    body = (
        f'<rect width="64" height="64" rx="{radius:.2f}" fill="{PURPLE}"/>\n  '
        + mark_shapes(WHITE)
    )
    return wrap_svg(body)


def maskable_svg() -> str:
    # Extra inset so circle / squircle crops keep the desk intact.
    body = (
        f'<rect width="64" height="64" fill="{PURPLE}"/>\n'
        f'  <g transform="translate(32 32) scale(0.82) translate(-32 -32)">\n'
        f"    {mark_shapes(WHITE)}\n"
        f"  </g>"
    )
    return wrap_svg(body)


def lockup_svg(dark: bool = False) -> str:
    fg = WHITE if dark else INK
    bg = CHARCOAL if dark else WHITE
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 96" fill="none">
  <rect width="360" height="96" rx="20" fill="{bg}"/>
  <g transform="translate(16 16)">
    <rect width="64" height="64" rx="{APP_R:.2f}" fill="{PURPLE}"/>
    {mark_shapes(WHITE)}
  </g>
  <text x="98" y="58" fill="{fg}" font-family="Inter, Segoe UI, system-ui, sans-serif"
        font-size="34" font-weight="650" letter-spacing="-0.04em">OneDesk</text>
</svg>
"""


def wordmark_svg() -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 48" fill="none">
  <text x="0" y="36" fill="{INK}" font-family="Inter, Segoe UI, system-ui, sans-serif"
        font-size="36" font-weight="650" letter-spacing="-0.045em">OneDesk</text>
</svg>
"""


def brand_board_svg() -> str:
    mark_white = mark_shapes(WHITE)
    mark_purple = mark_shapes(PURPLE)
    mark_ink = mark_shapes(INK)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" fill="none">
  <rect width="1600" height="1000" fill="{CHARCOAL}"/>
  <text x="36" y="28" fill="#6B6E76" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="11" letter-spacing="0.18em">ONEDESK / IDENTITY</text>
  <text x="1488" y="28" fill="#6B6E76" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="11">01</text>

  <!-- 1 Cover -->
  <g transform="translate(32 40)">
    <rect width="500" height="300" rx="18" fill="{PURPLE}"/>
    <g transform="translate(186 48) scale(2)">
      {mark_white}
    </g>
    <text x="36" y="268" fill="{WHITE}" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="34" font-weight="650" letter-spacing="-0.045em">OneDesk</text>
  </g>

  <!-- 2 Construction -->
  <g transform="translate(550 40)">
    <rect width="500" height="300" rx="18" fill="{PANEL}"/>
    <g stroke="{LINE}" stroke-width="1">
      <path d="M40 40h420M40 260h420M40 40v220M460 40v220"/>
      <path d="M40 96h420M40 204h420M151 40v220M349 40v220" stroke-dasharray="3 5"/>
    </g>
    <g transform="translate(186 86)">
      {mark_white}
    </g>
    <rect x="{186 + STEM[0]}" y="{86 + STEM[1]}" width="{STEM[2]-STEM[0]}" height="{STEM[3]-STEM[1]}" rx="{STEM_R}" stroke="#8B83FF" fill="none"/>
    <rect x="{186 + BAR[0]}" y="{86 + BAR[1]}" width="{BAR[2]-BAR[0]}" height="{BAR[3]-BAR[1]}" rx="{BAR_R}" stroke="#8B83FF" fill="none"/>
    <rect x="{186 + DESK[0]}" y="{86 + DESK[1]}" width="{DESK[2]-DESK[0]}" height="{DESK[3]-DESK[1]}" rx="{DESK_R}" stroke="#8B83FF" fill="none"/>
    <text x="36" y="280" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="12" letter-spacing="0.12em">ONE + SESSION + DESK</text>
  </g>

  <!-- 3 App icon -->
  <g transform="translate(1068 40)">
    <rect width="500" height="300" rx="18" fill="{PANEL}"/>
    <rect x="48" y="54" width="192" height="192" rx="44" fill="{PURPLE}"/>
    <g transform="translate(48 54) scale(3)">
      {mark_white}
    </g>
    <g transform="translate(276 70)">
      <rect width="64" height="64" rx="14" fill="{PURPLE}"/>
      <g>{mark_white}</g>
    </g>
    <g transform="translate(360 86)">
      <rect width="32" height="32" rx="8" fill="{PURPLE}"/>
      <g transform="scale(0.5)">{mark_white}</g>
    </g>
    <g transform="translate(408 94)">
      <rect width="16" height="16" rx="4" fill="{PURPLE}"/>
      <g transform="scale(0.25)">{mark_white}</g>
    </g>
    <text x="276" y="168" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="12">64 / 32 / 16</text>
    <text x="36" y="280" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="12" letter-spacing="0.12em">APP ICON</text>
  </g>

  <!-- 4 Tagline -->
  <g transform="translate(32 358)">
    <rect width="500" height="300" rx="18" fill="{PANEL}"/>
    <text x="40" y="132" fill="{WHITE}" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="36" font-weight="600" letter-spacing="-0.04em">All sessions.</text>
    <text x="40" y="178" fill="{PURPLE}" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="36" font-weight="600" letter-spacing="-0.04em">One desk.</text>
  </g>

  <!-- 5 Color -->
  <g transform="translate(550 358)">
    <rect width="500" height="300" rx="18" fill="{PANEL}"/>
    <rect x="36" y="40" width="200" height="200" rx="16" fill="{PURPLE}"/>
    <rect x="252" y="40" width="92" height="92" rx="14" fill="{PURPLE_DARK}"/>
    <rect x="360" y="40" width="92" height="92" rx="14" fill="{INK}"/>
    <rect x="252" y="148" width="92" height="92" rx="14" fill="{PAPER}"/>
    <rect x="360" y="148" width="92" height="92" rx="14" fill="{WHITE}"/>
    <text x="48" y="272" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="12" letter-spacing="0.12em">6D5EFC  /  1A1D23  /  F3F4F6</text>
  </g>

  <!-- 6 Type -->
  <g transform="translate(1068 358)">
    <rect width="500" height="300" rx="18" fill="{PANEL}"/>
    <text x="36" y="92" fill="{WHITE}" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="54" font-weight="650" letter-spacing="-0.05em">OneDesk</text>
    <text x="36" y="138" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="16" letter-spacing="0.16em">INTER  /  650</text>
    <text x="36" y="200" fill="{WHITE}" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="22" letter-spacing="-0.03em">Aa Bb Cc  123</text>
    <text x="36" y="250" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="14">Remote control. Session hub.</text>
  </g>

  <!-- 7 Product surface -->
  <g transform="translate(32 676)">
    <rect width="500" height="284" rx="18" fill="{PAPER}"/>
    <rect x="20" y="20" width="168" height="244" rx="14" fill="{WHITE}"/>
    <g transform="translate(32 34) scale(0.36)">
      <rect width="64" height="64" rx="{APP_R:.2f}" fill="{PURPLE}"/>
      {mark_white}
    </g>
    <text x="62" y="50" fill="{INK}" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="14" font-weight="650">OneDesk</text>
    <rect x="32" y="68" width="144" height="22" rx="7" fill="{PAPER}"/>
    <rect x="32" y="98" width="144" height="28" rx="8" fill="#EEEFF3"/>
    <rect x="32" y="134" width="144" height="28" rx="8" fill="{PAPER}"/>
    <rect x="200" y="20" width="280" height="244" rx="14" fill="{WHITE}"/>
    <rect x="220" y="40" width="120" height="10" rx="5" fill="{MIST}"/>
    <rect x="220" y="68" width="240" height="8" rx="4" fill="#F0F1F4"/>
    <rect x="220" y="86" width="200" height="8" rx="4" fill="#F0F1F4"/>
    <rect x="220" y="210" width="240" height="36" rx="12" fill="{PAPER}"/>
    <text x="36" y="272" fill="{SLATE}" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="12" letter-spacing="0.12em">PRODUCT</text>
  </g>

  <!-- 8 Glyph states -->
  <g transform="translate(550 676)">
    <rect width="500" height="284" rx="18" fill="{PANEL}"/>
    <g transform="translate(48 70)">{mark_white}</g>
    <g transform="translate(148 70)">{mark_purple}</g>
    <rect x="232" y="70" width="64" height="64" rx="14" fill="{WHITE}"/>
    <g transform="translate(232 70)">{mark_ink}</g>
    <rect x="328" y="70" width="64" height="64" rx="14" fill="{PURPLE}"/>
    <g transform="translate(328 70)">{mark_white}</g>
    <text x="48" y="168" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="11">WHITE</text>
    <text x="148" y="168" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="11">COLOR</text>
    <text x="240" y="168" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="11">INK</text>
    <text x="336" y="168" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="11">APP</text>
    <text x="36" y="256" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="12" letter-spacing="0.12em">MARK STATES</text>
  </g>

  <!-- 9 Detail -->
  <g transform="translate(1068 676)">
    <rect width="500" height="284" rx="18" fill="{PANEL}"/>
    <rect x="36" y="48" width="428" height="54" rx="14" fill="#111216" stroke="{LINE}"/>
    <circle cx="62" cy="75" r="6" fill="#FF5F57"/>
    <circle cx="82" cy="75" r="6" fill="#FEBC2E"/>
    <circle cx="102" cy="75" r="6" fill="#28C840"/>
    <text x="128" y="80" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="14">onedesk.app</text>
    <g transform="translate(36 126)">
      <rect width="44" height="44" rx="12" fill="{PURPLE}"/>
      <g transform="scale(0.6875)">{mark_white}</g>
    </g>
    <text x="92" y="154" fill="{WHITE}" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="16" font-weight="600">One surface for every session.</text>
    <text x="36" y="256" fill="#8B909A" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="12" letter-spacing="0.12em">SYSTEM</text>
  </g>
</svg>
"""


def preview_html() -> str:
    return """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OneDesk Icons</title>
  <style>
    :root { font-family: Inter, Segoe UI, system-ui, sans-serif; }
    body { margin: 0; background: #f3f4f6; color: #1a1d23; }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
    h1 { font-size: 28px; letter-spacing: -0.04em; margin: 0 0 8px; }
    p { color: #5c6370; margin: 0 0 28px; }
    section { margin: 28px 0; }
    .row { display: flex; flex-wrap: wrap; gap: 16px; align-items: end; }
    .card { background: #fff; border-radius: 16px; padding: 16px; }
    .dark { background: #141416; color: #fff; }
    .label { display: block; margin-top: 8px; font-size: 12px; color: #8b909a; }
    img, object { display: block; }
    .board { width: 100%; border-radius: 16px; background: #141416; }
  </style>
</head>
<body>
  <main>
    <h1>OneDesk icon system</h1>
    <p>One + session + desk. Source SVGs in this folder; PWA rasters live in <code>../</code>.</p>
    <section>
      <object class="board" data="onedesk-brand-board.svg" type="image/svg+xml"></object>
    </section>
    <section class="row">
      <div class="card"><img src="onedesk-app.svg" width="96" height="96"><span class="label">app 96</span></div>
      <div class="card"><img src="onedesk-app.svg" width="64" height="64"><span class="label">app 64</span></div>
      <div class="card"><img src="onedesk-app.svg" width="32" height="32"><span class="label">app 32</span></div>
      <div class="card"><img src="onedesk-app.svg" width="16" height="16"><span class="label">app 16</span></div>
      <div class="card dark"><img src="onedesk-mark.svg" width="64" height="64"><span class="label">mark white</span></div>
      <div class="card"><img src="onedesk-mark-color.svg" width="64" height="64"><span class="label">mark color</span></div>
    </section>
    <section class="row">
      <div class="card"><img src="onedesk-lockup.svg" width="280"><span class="label">lockup</span></div>
      <div class="card dark"><img src="onedesk-lockup-dark.svg" width="280"><span class="label">lockup dark</span></div>
    </section>
  </main>
</body>
</html>
"""


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def render_icon(size: int, *, maskable: bool = False, rounded: bool = False) -> Image.Image:
    over = 4
    canvas = size * over
    image = Image.new("RGBA", (canvas, canvas), hex_to_rgb(PURPLE) + (255,))
    draw = ImageDraw.Draw(image)
    scale = canvas / 64.0
    if maskable:
        scale *= 0.82
        origin = (canvas - 64.0 * scale) / 2.0
        ox = oy = origin
    else:
        ox = oy = 0.0

    def box(src: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
        x1, y1, x2, y2 = src
        return (ox + x1 * scale, oy + y1 * scale, ox + x2 * scale, oy + y2 * scale)

    draw.rounded_rectangle(box(STEM), radius=STEM_R * scale, fill=hex_to_rgb(WHITE) + (255,))
    draw.rounded_rectangle(box(BAR), radius=BAR_R * scale, fill=hex_to_rgb(WHITE) + (255,))
    draw.rounded_rectangle(box(DESK), radius=DESK_R * scale, fill=hex_to_rgb(WHITE) + (255,))

    if rounded:
        mask = Image.new("L", (canvas, canvas), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, canvas - 1, canvas - 1),
            radius=APP_R * (canvas / 64.0),
            fill=255,
        )
        image.putalpha(mask)

    return image.resize((size, size), Image.Resampling.LANCZOS)


def save_png(path: Path, size: int, **kwargs) -> None:
    render_icon(size, **kwargs).save(path, format="PNG", optimize=True)


def save_ico(path: Path) -> None:
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64)]
    render_icon(256).save(path, format="ICO", sizes=sizes)


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)

    write(ICONS / "onedesk-mark.svg", mark_svg("currentColor"))
    write(ICONS / "onedesk-mark-color.svg", mark_svg(PURPLE))
    write(ICONS / "onedesk-app.svg", app_svg(rounded=True))
    write(ICONS / "onedesk-app-square.svg", app_svg(rounded=False))
    write(ICONS / "onedesk-app-maskable.svg", maskable_svg())
    write(ICONS / "onedesk-lockup.svg", lockup_svg(dark=False))
    write(ICONS / "onedesk-lockup-dark.svg", lockup_svg(dark=True))
    write(ICONS / "onedesk-wordmark.svg", wordmark_svg())
    write(ICONS / "onedesk-brand-board.svg", brand_board_svg())
    write(ICONS / "preview.html", preview_html())
    write(PUBLIC / "favicon.svg", app_svg(rounded=True))

    save_png(ICONS / "icon-32.png", 32)
    save_png(ICONS / "icon-180.png", 180)
    save_png(ICONS / "icon-1024.png", 1024)
    save_png(PUBLIC / "favicon-192.png", 192)
    save_png(PUBLIC / "favicon-512.png", 512)
    save_png(PUBLIC / "apple-touch-icon.png", 180)
    save_png(PUBLIC / "icon-maskable-192.png", 192, maskable=True)
    save_png(PUBLIC / "icon-maskable-512.png", 512, maskable=True)
    save_ico(PUBLIC / "favicon.ico")

    print(f"wrote icons to {PUBLIC}")


if __name__ == "__main__":
    main()
