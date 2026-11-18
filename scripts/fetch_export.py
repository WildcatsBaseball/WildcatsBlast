#!/usr/bin/env python3
"""Log into teams.winreality.com and download the swing CSV export into data/inbox/.

Credentials come from environment variables (GitHub Actions secrets):
    WR_EMAIL, WR_PASSWORD

The clicks are driven by the "export" section of config/settings.json, so you can
adjust selectors without touching this file. To discover the right selectors, run
on your own computer:
    pip install playwright && playwright install chromium
    playwright codegen https://teams.winreality.com/insights
and copy the clicks it records into export.before_export_steps / export.export_steps.

Step types (each step is a JSON object with one action):
    {"click": "<selector>"}            click; fail if not found
    {"click_optional": "<selector>"}   click if it appears within a few seconds
    {"fill": "<selector>", "value": "<text>"}   value may use {today}, {days_ago:N} (YYYY-MM-DD)
    {"press": "<selector>", "key": "Enter"}
    {"wait_for": "<selector>"}
    {"wait_ms": 1500}
    {"goto": "<url>"}
The download must be triggered by the last step in export_steps.

On failure a screenshot + HTML snapshot are written to debug/ (uploaded by the workflow).
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "config" / "settings.json").read_text(encoding="utf-8"))["export"]
INBOX = ROOT / "data" / "inbox"
DEBUG = ROOT / "debug"


def expand(value: str) -> str:
    today = date.today()
    out = value.replace("{today}", today.isoformat())
    while "{days_ago:" in out:
        start = out.index("{days_ago:")
        end = out.index("}", start)
        n = int(out[start + 10:end])
        out = out[:start] + (today - timedelta(days=n)).isoformat() + out[end + 1:]
    return out


def wait_hidden(locator, ms: int) -> bool:
    try:
        locator.wait_for(state="hidden", timeout=ms)
        return True
    except PWTimeout:
        return False


def page_text(page) -> str:
    """Visible text of the page (never includes typed input values), for the failure log."""
    try:
        txt = page.inner_text("body", timeout=5000)
    except Exception:
        return "(unavailable)"
    return " | ".join(line.strip() for line in txt.splitlines() if line.strip())[:1500]


def run_step(page, step: dict, timeout: int) -> None:
    if "click" in step:
        page.locator(step["click"]).first.click(timeout=timeout)
    elif "click_optional" in step:
        loc = page.locator(step["click_optional"]).first
        try:
            loc.wait_for(state="visible", timeout=5000)
            loc.click(timeout=timeout)
        except PWTimeout:
            print(f"  (optional step skipped: {step['click_optional']})")
    elif "fill" in step:
        page.locator(step["fill"]).first.fill(expand(step.get("value", "")), timeout=timeout)
    elif "press" in step:
        page.locator(step["press"]).first.press(step.get("key", "Enter"), timeout=timeout)
    elif "wait_for" in step:
        page.locator(step["wait_for"]).first.wait_for(state="visible", timeout=timeout)
    elif "wait_ms" in step:
        page.wait_for_timeout(int(step["wait_ms"]))
    elif "goto" in step:
        page.goto(step["goto"], wait_until="networkidle", timeout=timeout)
    else:
        raise ValueError(f"Unknown step: {step}")


def main() -> int:
    email, password = os.environ.get("WR_EMAIL"), os.environ.get("WR_PASSWORD")
    if not email or not password:
        print("WR_EMAIL / WR_PASSWORD not set; skipping automatic export.")
        return 0
    timeout = int(CFG.get("timeout_ms", 60000))
    INBOX.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(accept_downloads=True, viewport={"width": 1440, "height": 1000})
        page = ctx.new_page()
        try:
            print(f"Opening {CFG['insights_url']}")
            page.goto(CFG["insights_url"], wait_until="networkidle", timeout=timeout)

            login = CFG["login"]
            pw_field = page.locator(login["password_selector"]).first
            if not pw_field.is_visible():
                try:
                    pw_field.wait_for(state="visible", timeout=8000)
                except PWTimeout:
                    pass
            if pw_field.is_visible():
                print("Logging in")
                page.locator(login["email_selector"]).first.fill(email)
                # some logins ask for email first, then show the password on the next screen
                if not pw_field.is_editable():
                    page.locator(login["submit_selector"]).first.click()
                    pw_field.wait_for(state="visible", timeout=timeout)
                pw_field.fill(password)
                page.locator(login["submit_selector"]).first.click()
                # Single-page apps log in without a page load: wait for the password box to go away.
                if not wait_hidden(pw_field, 30000):
                    print("  login form still showing; trying Enter key")
                    if pw_field.is_visible():
                        pw_field.press("Enter")
                    if not wait_hidden(pw_field, 20000):
                        raise RuntimeError("Still on the login page after submitting. Page text: " + page_text(page))
                page.wait_for_load_state("networkidle", timeout=timeout)
                print(f"  logged in; now at {page.url}")
                if "insights" not in page.url:
                    page.goto(CFG["insights_url"], wait_until="networkidle", timeout=timeout)

            for step in CFG.get("before_export_steps", []):
                print(f"  step: {step}")
                run_step(page, step, timeout)

            steps = CFG["export_steps"]
            for step in steps[:-1]:
                print(f"  step: {step}")
                run_step(page, step, timeout)
            print(f"  step (download): {steps[-1]}")
            with page.expect_download(timeout=timeout) as dl_info:
                run_step(page, steps[-1], timeout)
            dl = dl_info.value
            dest = INBOX / f"export-{date.today().isoformat()}.csv"
            dl.save_as(dest)
            size = dest.stat().st_size
            print(f"Saved {dest.relative_to(ROOT)} ({size / 1024:.0f} KB, suggested name {dl.suggested_filename})")
            if size < 200:
                raise RuntimeError("Downloaded file is suspiciously small.")
            return 0
        except Exception as exc:  # save evidence for debugging, then fail the job
            DEBUG.mkdir(exist_ok=True)
            try:
                page.screenshot(path=str(DEBUG / "failure.png"), full_page=True)
                (DEBUG / "failure.html").write_text(page.content(), encoding="utf-8")
                (DEBUG / "url.txt").write_text(page.url, encoding="utf-8")
            except Exception:
                pass
            print(f"EXPORT FAILED: {exc}", file=sys.stderr)
            try:
                print(f"  page url: {page.url}", file=sys.stderr)
                print(f"  page text: {page_text(page)}", file=sys.stderr)
                buttons = page.locator("button, a[role=button], [role=button]").all_inner_texts()
                print(f"  buttons: {[b.strip() for b in buttons if b.strip()][:40]}", file=sys.stderr)
            except Exception:
                pass
            return 1
        finally:
            browser.close()


if __name__ == "__main__":
    sys.exit(main())
