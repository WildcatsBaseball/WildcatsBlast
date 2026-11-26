#!/usr/bin/env python3
"""Turn WIN Reality / Blast "All swings by player" CSV exports into the dashboard data file.

  1. Read every CSV in data/inbox/ (raw exports).
  2. Normalize to one row per swing and merge into data/swings.csv, the running
     history. Swings are de-duplicated by capture id, so re-importing overlapping
     date ranges is safe. Raw exports are deleted after import.
  3. Join data/roster.csv (grad year, weight / weight class). With "roster_only": true
     (the default here) only roster players are shown; anyone else is listed in
     data/unmatched_players.csv. With false, new players are appended to the roster.
  4. Compute per-player averages and peaks (all time + last N days) plus weekly
     trend points, and write site/data.json.

Standard library only:  python scripts/build_data.py
"""
from __future__ import annotations

import csv
import hashlib
import json
import math
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "settings.json"
INBOX = ROOT / "data" / "inbox"
SWINGS = ROOT / "data" / "swings.csv"
ROSTER = ROOT / "data" / "roster.csv"
UNMATCHED = ROOT / "data" / "unmatched_players.csv"
OUT = ROOT / "site" / "data.json"

ROSTER_FIELDS = ["name", "user_id", "grad_year", "weight_lbs", "weight_class", "active", "notes"]
INACTIVE = {"no", "n", "false", "0", "inactive"}


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def norm_env(e: str) -> str:
    """'pitching_machine' / 'Pitching Machine ' -> 'pitching machine'."""
    return re.sub(r"[\s_]+", " ", (e or "").strip().lower())


def norm_header(h: str) -> str:
    return re.sub(r"[^a-z0-9%°]+", " ", (h or "").replace("﻿", "").lower()).strip()


def norm_name(n: str) -> str:
    return re.sub(r"\s+", " ", (n or "").strip()).lower()


def clean_name(n: str) -> str:
    return re.sub(r"\s+", " ", (n or "").strip())


def slugify(n: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", n.lower()).strip("-")


def find_col(headers: list[str], aliases: list[str]) -> str | None:
    lookup = {norm_header(h): h for h in headers}
    for a in aliases:
        if norm_header(a) in lookup:
            return lookup[norm_header(a)]
    return None


DATE_FORMATS = [
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
    "%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %I:%M %p", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%m/%d/%Y",
]


def parse_dt(value: str) -> datetime | None:
    v = (value or "").strip()
    if not v:
        return None
    try:
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
        return d.astimezone(timezone.utc).replace(tzinfo=None) if d.tzinfo else d
    except ValueError:
        pass
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(v, fmt)
        except ValueError:
            continue
    return None


def utc_offset(tz_field: str) -> timedelta | None:
    """'America/Edmonton\\ndaylight\\nGMT-6' -> -6h. Falls back to the IANA name if no GMT offset."""
    m = re.search(r"GMT\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?", tz_field or "")
    if m:
        sign = -1 if m.group(1) == "-" else 1
        return sign * timedelta(hours=int(m.group(2)), minutes=int(m.group(3) or 0))
    return None


def parse_num(value) -> float | None:
    v = re.sub(r"[^0-9.\-eE]", "", str(value or "").replace(",", ""))
    try:
        return float(v) if v not in ("", "-", ".") else None
    except ValueError:
        return None


# --------------------------------------------------------------------------- ingest

def read_export(path: Path, cfg: dict) -> list[dict]:
    with path.open(encoding="utf-8-sig", errors="replace", newline="") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        cols = cfg["columns"]
        c = {k: find_col(headers, cols.get(k, [])) for k in
             ("id", "user_id", "player", "first_name", "last_name", "date", "timezone", "action_type", "environment")}
        if not (c["player"] or (c["first_name"] and c["last_name"])):
            raise SystemExit(f"{path.name}: no player-name column. Headers: {headers}\n"
                             "Add the header to columns.player in config/settings.json.")
        if not c["date"]:
            raise SystemExit(f"{path.name}: no date column. Headers: {headers}\n"
                             "Add the header to columns.date in config/settings.json.")
        metric_cols = {m["key"]: find_col(headers, m["columns"]) for m in cfg["metrics"] if not m.get("derived")}
        missing = [m["label"] for m in cfg["metrics"] if not m.get("derived") and not metric_cols[m["key"]]]
        if missing:
            log(f"  {path.name}: not in this file: {', '.join(missing)}")
        known = {v for v in c.values() if v} | {v for v in metric_cols.values() if v}
        numeric_unmapped = [h for h in headers if h not in known and re.search(r"\(.*\)", h)]
        if numeric_unmapped:
            log(f"  {path.name}: columns not used (add to config to show them): {', '.join(numeric_unmapped)}")

        exclude = {a.lower() for a in cfg.get("exclude_action_types", [])}
        fallback_tz = ZoneInfo(cfg.get("timezone") or "UTC")
        frac = {m["key"] for m in cfg["metrics"] if m.get("fraction_to_percent")}
        rows, skipped, excluded = [], 0, 0
        for r in reader:
            if c["action_type"] and (r.get(c["action_type"]) or "").strip().lower() in exclude:
                excluded += 1
                continue
            name = clean_name(r.get(c["player"], "")) if c["player"] else \
                clean_name(f"{r.get(c['first_name'], '')} {r.get(c['last_name'], '')}")
            dt = parse_dt(r.get(c["date"], ""))
            if not name or not dt:
                skipped += 1
                continue
            if cfg.get("timestamps_are_utc", False):
                off = utc_offset(r.get(c["timezone"], "")) if c["timezone"] else None
                if off is not None:
                    dt = dt + off
                else:
                    dt = dt.replace(tzinfo=timezone.utc).astimezone(fallback_tz).replace(tzinfo=None)
            out = {"user_id": (r.get(c["user_id"]) or "").strip() if c["user_id"] else "",
                   "player": name, "datetime": dt.strftime("%Y-%m-%dT%H:%M:%S"),
                   "environment": norm_env(r.get(c["environment"], "")) if c["environment"] else ""}
            has_value = False
            for key, col in metric_cols.items():
                val = parse_num(r.get(col)) if col else None
                if val is not None and key in frac and abs(val) <= 1.0:
                    val *= 100
                out[key] = "" if val is None else f"{round(val, 4):g}"
                has_value = has_value or val is not None
            if not has_value:
                skipped += 1
                continue
            raw_id = (r.get(c["id"]) or "").strip() if c["id"] else ""
            out["id"] = raw_id or hashlib.sha1(
                "|".join([out["user_id"] or norm_name(name), out["datetime"]]).encode()).hexdigest()[:16]
            rows.append(out)
    log(f"  {path.name}: {len(rows)} swings"
        + (f", {excluded} excluded by action type" if excluded else "")
        + (f", {skipped} unusable rows skipped" if skipped else ""))
    return rows


def load_swings() -> dict[str, dict]:
    if not SWINGS.exists():
        return {}
    with SWINGS.open(newline="", encoding="utf-8") as f:
        return {r["id"]: r for r in csv.DictReader(f)}


def save_swings(swings: dict[str, dict], metric_keys: list[str]) -> None:
    fields = ["id", "user_id", "player", "datetime", "environment"] + metric_keys
    rows = sorted(swings.values(), key=lambda r: (r["datetime"], r["player"]))
    with SWINGS.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fields})


# --------------------------------------------------------------------------- roster

def load_roster() -> list[dict]:
    if not ROSTER.exists():
        return []
    with ROSTER.open(newline="", encoding="utf-8-sig") as f:
        return [{k.strip(): (v or "").strip() for k, v in r.items() if k} for r in csv.DictReader(f)]


def save_roster(rows: list[dict]) -> None:
    rows = sorted(rows, key=lambda r: norm_name(r.get("name", "")))
    with ROSTER.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=ROSTER_FIELDS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in ROSTER_FIELDS})


def weight_class_for(weight: float | None, classes: list[dict]) -> str:
    if weight is None:
        return ""
    for c in classes:
        if c.get("min", float("-inf")) <= weight <= c.get("max", float("inf")):
            return c["name"]
    return ""


def weight_range_label(c: dict) -> str:
    """{"max": 164.99} -> "under 165 lbs"; {"min": 165, "max": 179.99} -> "165–179 lbs"; {"min": 180} -> "180+ lbs"."""
    lo, hi = c.get("min"), c.get("max")
    if lo is None and hi is not None:
        return f"under {math.ceil(hi)} lbs"
    if lo is not None and hi is None:
        return f"{lo:g}+ lbs"
    if lo is not None and hi is not None:
        return f"{lo:g}–{math.floor(hi)} lbs"
    return ""


def match_roster(swings: dict[str, dict], roster: list[dict], roster_only: bool) -> dict[str, dict | None]:
    """Map each swing's player key to a roster row.

    roster_only=True: players not on the roster are left out (listed in data/unmatched_players.csv).
    roster_only=False: they are appended to the roster with blank fields.
    """
    by_uid = {r["user_id"]: r for r in roster if r.get("user_id")}
    by_name = {norm_name(r.get("name", "")): r for r in roster}
    mapping, added = {}, []
    unmatched: dict[str, dict] = {}
    for s in sorted(swings.values(), key=lambda s: s["datetime"]):
        key = s.get("user_id") or norm_name(s["player"])
        row = by_uid.get(s.get("user_id")) if s.get("user_id") else None
        if row is None:
            row = by_name.get(norm_name(s["player"]))
            if row is not None and s.get("user_id") and not row.get("user_id"):
                row["user_id"] = s["user_id"]  # first time we see this player's id: remember it
                by_uid[s["user_id"]] = row
        if row is None and roster_only:
            u = unmatched.setdefault(key, {"name": s["player"], "user_id": s.get("user_id", ""),
                                           "swings": 0, "last_swing": ""})
            u["swings"] += 1
            u["last_swing"] = s["datetime"][:10]
        elif row is None:
            row = {"name": s["player"], "user_id": s.get("user_id", ""), "active": "yes"}
            roster.append(row)
            added.append(s["player"])
            by_name[norm_name(s["player"])] = row
            if row["user_id"]:
                by_uid[row["user_id"]] = row
        mapping[key] = row
    if added:
        log(f"Added {len(added)} new player(s) to data/roster.csv (fill in grad_year and weight_lbs): "
            + ", ".join(added))
    if unmatched:
        log(f"Not on roster, left out ({len(unmatched)}): "
            + ", ".join(f"{u['name']} ({u['swings']} swings)" for u in unmatched.values())
            + ". If one of these is a misspelled roster name, fix the spelling in data/roster.csv.")
        with UNMATCHED.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["name", "user_id", "swings", "last_swing"])
            w.writeheader()
            w.writerows(sorted(unmatched.values(), key=lambda u: norm_name(u["name"])))
    elif UNMATCHED.exists():
        UNMATCHED.unlink()
    return mapping


# --------------------------------------------------------------------------- stats

def connection_score(ec: float | None, ci: float | None, p: dict) -> float | None:
    """Wildcats Connection Score, 20-80, per swing (an estimate, not Blast's own formula).

    Uses Blast's published targets: Early Connection 80-105 deg, Connection at Impact 80-95 deg,
    the two within 15 deg of each other, ~90 deg ideal for both. A swing at 90/90 scores 80;
    every degree of "miss" costs `points_per_degree` points:
      miss = we * deg outside early range + wi * deg outside impact range
             + deg of gap beyond max_gap
             + center_weight * (we * |EC - 90| + wi * |CI - 90|) / 2
    we : wi = early_weight : impact_weight (default 2 : 1), scaled so they average 1.
    """
    if ec is None or ci is None:
        return None
    def outside(x, lo, hi):
        return lo - x if x < lo else (x - hi if x > hi else 0.0)
    (elo, ehi), (ilo, ihi) = p.get("early_range", [80, 105]), p.get("impact_range", [80, 95])
    ew, iw = float(p.get("early_weight", 1)), float(p.get("impact_weight", 1))
    we, wi = 2 * ew / (ew + iw), 2 * iw / (ew + iw)
    miss = (we * outside(ec, elo, ehi) + wi * outside(ci, ilo, ihi)
            + max(0.0, abs(ec - ci) - p.get("max_gap", 15))
            + p.get("center_weight", 0.2) * (we * abs(ec - 90) + wi * abs(ci - 90)) / 2)
    return max(20.0, min(80.0, 80.0 - p.get("points_per_degree", 2) * miss))


def peak_of(values: list[float], direction: str, method: str) -> float | None:
    if not values or direction == "none":
        return None
    vals = sorted(values, reverse=(direction == "higher"))
    if method == "max" or len(vals) < 10:
        return vals[0]
    return vals[max(0, round(len(vals) * 0.10) - 1)]  # "p90": ignores one-off glitches


def summarize(swings: list[dict], metrics: list[dict], peak_method: str) -> dict | None:
    if not swings:
        return None
    out = {"n": len(swings), "last": max(s["datetime"] for s in swings)[:10], "avg": {}, "peak": {}}
    for m in metrics:
        vals = [s[m["key"]] for s in swings if s.get(m["key"]) is not None]
        if not vals:
            continue
        out["avg"][m["key"]] = round(mean(vals), m["decimals"] + 1)
        p = peak_of(vals, m["direction"], peak_method)
        if p is not None:
            out["peak"][m["key"]] = round(p, m["decimals"] + 1)
    return out


def by_env(swings: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {"all": swings}
    for s in swings:
        out.setdefault(s["env"], []).append(s)
    return out


def window_stats(swings: list[dict], metrics: list[dict], peak_method: str, cutoffs: dict) -> dict:
    res = {"overall": summarize(swings, metrics, peak_method)}
    for k, c in cutoffs.items():
        res[k] = summarize([s for s in swings if s["datetime"][:10] >= c], metrics, peak_method)
    return res


def weekly(swings: list[dict], metrics: list[dict]) -> dict:
    buckets: dict[str, list[dict]] = defaultdict(list)
    for s in swings:
        d = datetime.fromisoformat(s["datetime"]).date()
        buckets[(d - timedelta(days=d.weekday())).isoformat()].append(s)
    weeks = sorted(buckets)
    res = {"weeks": weeks, "n": [len(buckets[w]) for w in weeks], "m": {}}
    for m in metrics:
        series = []
        for w in weeks:
            vals = [s[m["key"]] for s in buckets[w] if s.get(m["key"]) is not None]
            series.append(round(mean(vals), m["decimals"] + 1) if vals else None)
        res["m"][m["key"]] = series
    return res


# --------------------------------------------------------------------------- main

def main() -> None:
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    metrics_cfg = cfg["metrics"]
    metric_keys = [m["key"] for m in metrics_cfg]
    raw_keys = [m["key"] for m in metrics_cfg if not m.get("derived")]

    # Raw exports belong in data/inbox/, but also accept ones dropped straight into data/
    known = {ROSTER.name, SWINGS.name, UNMATCHED.name}
    stray = [p for p in ROSTER.parent.glob("*.csv") if p.name not in known]
    inbox_files = sorted(INBOX.glob("*.csv")) + sorted(stray)
    replace = cfg.get("history_mode") == "replace" and inbox_files
    swings = {} if replace else load_swings()
    before = len(swings)
    for p in inbox_files:
        log(f"Reading {p.relative_to(ROOT)}")
        for r in read_export(p, cfg):
            swings[r["id"]] = r
    if inbox_files:
        save_swings(swings, raw_keys)
        for p in inbox_files:
            p.unlink()
    log(f"Swing history: {len(swings)} swings ({len(swings) - before:+d} new)")

    roster = load_roster()
    mapping = match_roster(swings, roster, bool(cfg.get("roster_only", False)))
    save_roster(roster)

    tz = ZoneInfo(cfg.get("timezone") or "UTC")
    now = datetime.now(tz)
    window_days = [int(d) for d in cfg.get("recent_windows_days", [cfg.get("recent_days", 30)])]
    cutoffs = {f"d{d}": (now.date() - timedelta(days=d - 1)).isoformat() for d in window_days}

    groups: dict[int, list[dict]] = defaultdict(list)
    row_of: dict[int, dict] = {}
    # swing_filters: {"bat_speed": {"min": 30}} drops swings outside a fixed range from all stats
    # (they stay in data/swings.csv, so changing the threshold needs no re-upload).
    filters = cfg.get("swing_filters", {})
    filtered_out = 0
    for s in swings.values():
        row = mapping[s.get("user_id") or norm_name(s["player"])]
        if row is None or (row.get("active") or "yes").lower() in INACTIVE:
            continue
        parsed = {"datetime": s["datetime"], "env": norm_env(s.get("environment")) or "untagged"}
        for k in metric_keys:
            parsed[k] = parse_num(s.get(k))
        if "connection_score" in parsed:
            parsed["connection_score"] = connection_score(parsed.get("early_conn"), parsed.get("conn_impact"),
                                                          cfg.get("connection_score", {}))
        if any(parsed.get(k) is not None and (parsed[k] < f.get("min", float("-inf")) or parsed[k] > f.get("max", float("inf")))
               for k, f in filters.items()):
            filtered_out += 1
            continue
        groups[id(row)].append(parsed)
        row_of[id(row)] = row
    # Relative filters: {"bat_speed": {"below_player_avg": 10}} drops a player's swings that are more
    # than 10 below that player's own all-time average (all environments) for that metric.
    for k, f in filters.items():
        margin = f.get("below_player_avg")
        if margin is None:
            continue
        for rid, lst in groups.items():
            vals = [s[k] for s in lst if s.get(k) is not None]
            if not vals:
                continue
            floor = mean(vals) - float(margin)
            keep = [s for s in lst if s.get(k) is None or s[k] >= floor]
            filtered_out += len(lst) - len(keep)
            groups[rid] = keep
    groups = {rid: lst for rid, lst in groups.items() if lst}
    if filters:
        log(f"Swing filters {filters}: {filtered_out} swing(s) left out of the stats")

    present = [m for m in metrics_cfg
               if any(s.get(m["key"]) is not None for lst in groups.values() for s in lst)]
    peak_method = cfg.get("peak_method", "max")

    env_counts: dict[str, int] = defaultdict(int)
    for lst in groups.values():
        for s in lst:
            env_counts[s["env"]] += 1

    players, used = [], set()
    for rid, lst in groups.items():
        row = row_of[rid]
        pid = slugify(row["name"]) or "player"
        while pid in used:
            pid += "-2"
        used.add(pid)
        grad = row.get("grad_year", "")
        players.append({
            "id": pid,
            "name": row["name"],
            "grad": int(grad) if grad.isdigit() else None,
            "wclass": row.get("weight_class") or weight_class_for(parse_num(row.get("weight_lbs")),
                                                                  cfg.get("weight_classes", [])),
            # stats[environment][window]; "all" = every environment
            "stats": {env: window_stats(sub, present, peak_method, cutoffs) for env, sub in by_env(lst).items()},
            "trend": {env: weekly(sub, present) for env, sub in by_env(lst).items()},
        })
    players.sort(key=lambda p: norm_name(p["name"]))

    out = {
        "generated_at": now.isoformat(timespec="minutes"),
        "data_through": max((s["datetime"][:10] for s in swings.values()), default=None),
        "team_name": cfg.get("team_name", ""),
        "site_title": cfg.get("site_title", "Swing Metrics"),
        "environments": [{"key": "all", "label": "All environments", "n": sum(env_counts.values())}]
                        + [{"key": e, "label": e[:1].upper() + e[1:], "n": n}
                           for e, n in sorted(env_counts.items(), key=lambda kv: -kv[1])],
        "windows": [{"key": "overall", "label": "All time"}]
                   + [{"key": f"d{d}", "label": f"Last {d} days", "days": d} for d in window_days],
        "min_swings": int(cfg.get("min_swings", 10)),
        "peak_method": peak_method,
        "metrics": [{k: m[k] for k in ("key", "label", "short", "unit", "direction", "decimals", "note") if k in m} for m in present],
        "grad_classes": sorted({p["grad"] for p in players if p["grad"]}),
        "weight_classes": [c["name"] for c in cfg.get("weight_classes", [])
                           if any(p["wclass"] == c["name"] for p in players)],
        "weight_class_ranges": {c["name"]: weight_range_label(c) for c in cfg.get("weight_classes", [])},
        "players": players,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    log(f"Wrote {OUT.relative_to(ROOT)}: {len(players)} players, {len(present)} metrics, "
        f"{OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
