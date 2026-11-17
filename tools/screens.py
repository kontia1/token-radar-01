"""Render the built dashboard to three PNGs for the entry's screenshots directory.

Fixed viewport 1440x900: the long side stays under the kit's 1440 cap and the short side is 900,
clearing the 800 minimum. No network: the page is loaded from file:// and data.js comes from the build.
The three shots must show three different things (the board, a detail with the farm plan, and a filtered
view), so the script hashes them and refuses to hand in duplicates.
"""

import hashlib
import pathlib
import sys

from playwright.sync_api import sync_playwright

REPO = pathlib.Path("/root/makefun/tr-repo")
PAGE = (REPO / "out" / "dashboard" / "index.html").as_uri()
SHOTS = REPO / "screenshots"

problems: list[str] = []
digests: dict[str, str] = {}


def shot(page, name: str) -> None:
    out = SHOTS / name
    page.screenshot(path=str(out), full_page=False)
    data = out.read_bytes()
    digests[name] = hashlib.sha256(data).hexdigest()
    kb = len(data) / 1024
    print(f"  {name:<18} {kb:7.1f} KB")
    if kb > 512:
        problems.append(f"{name} is {kb:.0f} KB, over the 512 KB gate cap")
    elif kb < 300:
        print(f"  note: {name} is under the 300 KB the kit recommends, but inside the gate cap")


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

        # 2: the detail view, scrolled to the multiplier ladder and the farm plan.
        page.locator("#rows tr").first.click()
        page.evaluate("document.getElementById('detail').scrollTop = document.getElementById('detail').scrollHeight")
        page.wait_for_timeout(180)
        shot(page, "2-detail.png")

        # 3: filters in use — a search term and a TVL band, with the selected row's detail shown.
        page.fill("#q", "perp")
        page.select_option("#tvl", "10")
        page.wait_for_timeout(150)
        filtered = page.locator("#rows tr").count()
        print(f"rows after filters: {filtered}")
        if filtered == 0:
            problems.append("filter view rendered no rows")
        else:
            page.locator("#rows tr").first.click()
            page.evaluate("document.getElementById('detail').scrollTop = 0")
            page.wait_for_timeout(150)
        shot(page, "3-filtered.png")

        browser.close()

    if len(set(digests.values())) != len(digests):
        problems.append("two screenshots are byte-identical: the board, detail and filtered views must differ")

    for p_ in problems:
        print("PROBLEM:", p_)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
