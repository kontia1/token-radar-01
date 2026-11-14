"""Render the built dashboard to three PNGs for the entry's screenshots directory.

Fixed viewport 1440x900: the long side stays under the kit's 1440 cap and the short side is 900,
clearing the 800 minimum. No network: the page is loaded from file:// and data.js comes from the build.
"""

import pathlib
import sys

from playwright.sync_api import sync_playwright

REPO = pathlib.Path("/root/makefun/tr-repo")
PAGE = (REPO / "out" / "dashboard" / "index.html").as_uri()
SHOTS = REPO / "screenshots"

problems: list[str] = []


def shot(page, name: str) -> None:
    out = SHOTS / name
    page.screenshot(path=str(out), full_page=False)
    kb = out.stat().st_size / 1024
    print(f"  {name:<18} {kb:7.1f} KB")
    if not (300 <= kb <= 512):
        problems.append(f"{name} is {kb:.0f} KB, outside 300-512 KB")


def main() -> int:
    SHOTS.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--force-color-profile=srgb",
        ])
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)

        page.on("console", lambda m: problems.append(f"console {m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))

        page.goto(PAGE, wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_selector("#rows tr")
        rows = page.locator("#rows tr").count()
        print(f"rows rendered: {rows}")
        if rows < 100:
            problems.append(f"only {rows} rows rendered")

        # 1: the board and the model, with rank 1 opened on the right.
        page.wait_for_timeout(150)
        shot(page, "1-board.png")

        # 2: the same page with the detail scrolled to the ladder and the farm plan.
        page.evaluate("document.getElementById('detail').scrollTop = 250")
        page.wait_for_timeout(120)
        shot(page, "2-plan.png")

        # 3: filters in use — a category, a chain, a TVL band and a search term.
        page.fill("#q", "perp")
        page.select_option("#tvl", "10")
        page.wait_for_timeout(120)
        filtered = page.locator("#rows tr").count()
        print(f"rows after filters: {filtered}")
        if filtered == 0:
            problems.append("filter view rendered no rows")
        else:
            page.locator("#rows tr").first.click()
            page.wait_for_timeout(150)
        shot(page, "3-filtered.png")

        browser.close()

    for p_ in problems:
        print("PROBLEM:", p_)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
