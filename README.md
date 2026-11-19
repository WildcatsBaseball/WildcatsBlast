# Wildcats Blast

Live site: **https://mikeozga.github.io/Wildcats-Blast/**

A free, public website that shows every hitter's Blast swing metrics (via WIN Reality) next to their peers'.

- **Leaderboard**: sortable by any metric, with averages or peaks and all-time or last-30-day windows. You can filter by grad class and weight class, and cells are shaded by percentile.
- **Player pages**: search your name to see your averages and peaks, your percentile against all players, your grad class or your weight class, where you sit among teammates, and a weekly trend chart.
- **Nightly refresh**: a GitHub Action downloads the export from teams.winreality.com, rebuilds the data and redeploys the site.

Hosting is GitHub Pages and the job runs on GitHub Actions. Both are free for a public repository.

```
config/settings.json      metrics, weight classes, column names, export clicks
data/roster.csv           YOU MAINTAIN: grad_year, weight_lbs (or weight_class), active
data/swings.csv           full swing history (auto-generated; merged from each export)
data/inbox/               drop raw CSV exports here (deleted after import)
scripts/build_data.py     export(s) + roster  ->  site/data.json
scripts/fetch_export.py   logs into WIN Reality and downloads the CSV (used by the nightly job)
site/                     the website (plain HTML/CSS/JS, no build step)
.github/workflows/refresh.yml
```

## One-time setup

1. **Create the repository.** On GitHub, create a new **public** repo (for example `Wildcats-Blast`), then push this folder:

   ```bash
   git remote add origin https://github.com/<you>/Wildcats-Blast.git
   ```

   ```bash
   git push -u origin main
   ```

2. **Turn on Pages.** In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. **Add the WIN Reality login.** Go to **Settings → Secrets and variables → Actions → New repository secret** and add `WR_EMAIL` and `WR_PASSWORD`. Use a coach login that can see the whole program. A dedicated "data" coach account is ideal.
4. **Run it.** Go to **Actions → Nightly refresh → Run workflow**. Your site will be at `https://<you>.github.io/Wildcats-Blast/`.

## Weekly upkeep

- **The roster is the master list.** Only players in `data/roster.csv` appear on the site. Swings from anyone else (coaches, players who left, misspelled names) are left out and listed in `data/unmatched_players.csv`. Check that file if a player is missing from the site; usually their name in the roster doesn't match WIN Reality's spelling. To add a player, add a row with their name exactly as WIN Reality spells it. (Set `"roster_only": false` in `config/settings.json` to instead auto-add unknown players to the roster.)
- **Players who left**: set `active` to `no` to hide them.
- **Weight classes** are defined in `config/settings.json → weight_classes`. You can also type a class name directly into the roster's `weight_class` column, which overrides the weight-based class.

## Automatic download (currently off)

The nightly job still runs every night. It rebuilds the site so the "last 30 days" and "last 7 days" windows stay current, but it does not log into WIN Reality right now. Automated sign-in didn't get past the login page. Load data by uploading an export (see below). To try the automatic download again later, add a repository **variable** (not a secret) named `AUTO_EXPORT` with the value `true` under **Settings → Secrets and variables → Actions → Variables**.

## Loading new data / if the nightly download breaks

The automatic export clicks through the WIN Reality site like a person would. If they redesign the page, the job fails and GitHub emails you. In the meantime:

- **Manual fallback (2 minutes):** export the CSV from teams.winreality.com/insights and upload it to `data/inbox/` on GitHub (**Add file → Upload files**). The site rebuilds automatically. Overlapping date ranges are fine because swings are de-duplicated by capture ID.
- **Fix the clicks:** open the failed run and download the `export-debug` artifact to see a screenshot of where it got stuck. To record the correct clicks, run this on your computer:

  ```bash
  pip install playwright && playwright install chromium
  ```

  ```bash
  playwright codegen https://teams.winreality.com/insights
  ```

  Then copy the selectors it shows into `export.before_export_steps` and `export.export_steps` in `config/settings.json`. The step syntax is documented at the top of `scripts/fetch_export.py`.

## Running locally

```bash
python3 scripts/build_data.py
```

```bash
cd site && python3 -m http.server 8000
```

Then open http://localhost:8000. The build script uses only the Python standard library.

## Settings worth knowing (`config/settings.json`)

| Setting | Meaning |
|---|---|
| `min_swings` | Swings needed in a window to be ranked or shaded (currently 1, meaning everyone with a swing is ranked; raise it to bring back the "few swings" toggle) |
| `recent_windows_days` | The recent-window tabs, in days (default `[30, 7]` gives "Last 30 days" and "Last 7 days" next to "All time") |
| `peak_method` | `max` uses the best single swing. `p90` ignores one-off glitch swings. |
| `swing_filters` | Leaves swings out of all stats by metric range. Default `{"bat_speed": {"min": 30}}` drops swings under 30 mph. Other metrics can be added the same way, with `min` and/or `max`. |
| `exclude_action_types` | Defaults to `["air Swing"]`, which drops swings with no ball contact. Use `[]` to include them. |
| `metrics[].direction` | `higher` / `lower` / `none`. `none` means the metric isn't ranked, as for angles. |
| `timezone` | Used for the 30-day cutoff |

## Connection Score (Wildcats estimate)

Blast's own Connection Score isn't in the WIN Reality export, so the site computes its own on the same 20–80 scale. It's built from Blast's published targets: Early Connection 80–105°, Connection at Impact 80–95°, the two within 15° of each other, and about 90° ideal for both.

Each swing starts at 80 (a perfect 90°/90°) and loses 2 points per degree of "miss". **Early Connection counts 2× as much as Connection at Impact.** A miss is:

- degrees outside the Early Connection range (weighted 2×), plus
- degrees outside the Connection at Impact range (weighted 1×), plus
- degrees by which the gap between the two exceeds 15°, plus
- a small penalty (0.2 per degree, same 2:1 weighting) for being away from 90° while still inside the ranges.

The result is floored at 20. A player's number is the average of their per-swing scores, so consistency counts. Examples: 90/90 → 80, 100/90 → 77, 90/82 → 79, 104/85 → 68, 110/90 → 51, 90/75 → 71, 110/85 → 41. All the numbers are adjustable under `connection_score` in `config/settings.json`.

## Notes

- Swing timestamps in the export are UTC and are converted to local dates using each row's GMT offset.
- On Plane Efficiency comes in as a fraction (0.72) and is shown as a percent (72).
- GitHub pauses scheduled workflows in repos with no activity for 60 days. The nightly data commit counts as activity, but if the schedule is ever paused, re-enable it on the Actions tab.
