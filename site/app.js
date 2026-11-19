/* Swing Metrics dashboard — plain JS, no build step. Reads data.json produced by scripts/build_data.py */
(() => {
  "use strict";

  // ------------------------------------------------------------------ state
  const STORE_KEY = "swing-metrics-prefs-v1";
  const S = { win: "overall", stat: "avg", grad: "", wclass: "", showLow: false, q: "",
              sort: "bat_speed", dir: -1, cmp: "all", trend: "bat_speed" };
  try { Object.assign(S, JSON.parse(localStorage.getItem(STORE_KEY) || "{}"), { q: "" }); } catch (e) { /* ignore */ }
  const save = () => { try { const { q, ...rest } = S; localStorage.setItem(STORE_KEY, JSON.stringify(rest)); } catch (e) { /* ignore */ } };

  let D = null;          // data.json
  let M = {};            // metric by key
  const app = document.getElementById("app");
  const tip = document.getElementById("tip");

  // ------------------------------------------------------------------ helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
  }
  const NS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
  }
  const fmt = (v, m) => {
    if (v == null || Number.isNaN(v)) return "—";
    const out = Number(v).toFixed(m.decimals);
    return /^-0(\.0+)?$/.test(out) ? out.slice(1) : out;
  };
  const unitStr = (m) => m.unit ? (m.unit === "°" || m.unit === "%" ? m.unit : " " + m.unit) : "";
  const ordinal = (n) => { const v = n % 100; return n + (["th", "st", "nd", "rd"][(v - 20) % 10] || ["th", "st", "nd", "rd"][v] || "th"); };
  const fmtDate = (iso, opts) => iso ? new Date(iso.length === 10 ? iso + "T12:00:00" : iso)
      .toLocaleDateString(undefined, opts || { month: "short", day: "numeric", year: "numeric" }) : "—";
  const statsOf = (p, win = S.win) => p.stats[win] || null;
  const ranked = (m) => m.direction !== "none";
  const winLabel = () => (D.windows.find((w) => w.key === S.win) || D.windows[0]).label.toLowerCase();
  const winOpts = () => D.windows.map((w) => [w.key, w.label]);

  /** Percentile (0-100) of value among others; ties count half. Higher = better for the metric. */
  function percentile(value, others, dir) {
    if (value == null || !others.length) return null;
    let below = 0, equal = 0;
    for (const o of others) { if (o < value) below++; else if (o === value) equal++; }
    let p = (below + equal / 2) / others.length * 100;
    if (dir === "lower") p = 100 - p;
    return Math.round(p);
  }
  const bin = (p) => p == null ? "" : p >= 80 ? "q5" : p >= 60 ? "q4" : p >= 40 ? "q3" : p >= 20 ? "q2" : "q1";

  function showTip(evt, ...lines) {
    tip.replaceChildren(...lines.map((l) => h("div", {}, l)));
    tip.hidden = false;
    const pad = 14, r = tip.getBoundingClientRect();
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  const hideTip = () => { tip.hidden = true; };

  function seg(options, value, onPick, label) {
    return h("div", { class: "seg", role: "group", "aria-label": label },
      options.map(([v, text]) => h("button", { type: "button", "aria-pressed": String(v === value),
        onclick: () => { onPick(v); } }, text)));
  }
  function select(label, options, value, onPick) {
    const sel = h("select", { "aria-label": label, onchange: (e) => onPick(e.target.value) },
      options.map(([v, text]) => h("option", { value: v, selected: v === value }, text)));
    return h("label", { class: "ctl" }, label, sel);
  }

  // ------------------------------------------------------------------ board
  function visibleMetrics() {
    return S.stat === "peak" ? D.metrics.filter(ranked) : D.metrics;
  }

  function renderBoard() {
    document.title = D.site_title;
    const ms = visibleMetrics();
    if (!["name", "grad", "wclass", "n"].includes(S.sort) && !ms.some((m) => m.key === S.sort)) {
      S.sort = ms[0].key; S.dir = -1;
    }

    const searchInput = h("input", { type: "search", placeholder: "Search your name…", value: S.q,
      list: "names", autocomplete: "off", "aria-label": "Search players",
      oninput: (e) => { S.q = e.target.value; drawTable(); },
      onkeydown: (e) => { if (e.key === "Enter") { const m = matches(); if (m.length === 1) location.hash = "#/p/" + m[0].id; } },
      onchange: (e) => { const p = D.players.find((p) => p.name.toLowerCase() === e.target.value.trim().toLowerCase()); if (p) location.hash = "#/p/" + p.id; } });
    const datalist = h("datalist", { id: "names" }, D.players.map((p) => h("option", { value: p.name })));
    const searchIcon = s("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2.2, "stroke-linecap": "round" },
      s("circle", { cx: 11, cy: 11, r: 7 }), s("path", { d: "M20 20l-3.5-3.5" }));

    const rerender = () => { save(); renderBoard(); };
    const controls = h("div", { class: "controls" },
      h("div", { class: "search" }, searchIcon, searchInput, datalist),
      seg(winOpts(), S.win, (v) => { S.win = v; rerender(); }, "Time window"),
      seg([["avg", "Average"], ["peak", "Peak"]], S.stat, (v) => { S.stat = v; rerender(); }, "Statistic"),
      D.grad_classes.length ? select("Grad class", [["", "All"], ...D.grad_classes.map((g) => [String(g), String(g)])], S.grad, (v) => { S.grad = v; rerender(); }) : null,
      D.weight_classes.length ? select("Weight class", [["", "All"], ...D.weight_classes.map((w) => [w, w])], S.wclass, (v) => { S.wclass = v; rerender(); }) : null,
      D.min_swings > 1 ? h("label", { class: "ctl" }, h("input", { type: "checkbox", checked: S.showLow, onchange: (e) => { S.showLow = e.target.checked; rerender(); } }),
        `Show players under ${D.min_swings} swings`) : null);

    const legend = h("div", { class: "legend" },
      h("span", { class: "scale", "aria-hidden": "true" }, h("em", {}, "Bottom"), ["q1", "q2", "q3", "q4", "q5"].map((q) => h("span", { style: `background:var(--${q})` })), h("em", {}, "Top")),
      h("span", {}, "Shading = percentile among the players shown: red = top 20%, navy = bottom 20%."),
      h("span", {}, S.stat === "peak" ? "Peak = best single swing." : "Angle metrics (°) aren't shaded — there's no single best value."),
      D.min_swings > 1 ? h("span", {}, `Ranked players need ${D.min_swings}+ swings (${winLabel()}).`) : null);

    app.replaceChildren(controls, legend, h("div", { class: "table-card", id: "tablecard" }));
    drawTable();
    if (S.q) { const i = app.querySelector(".search input"); i.focus(); i.setSelectionRange(S.q.length, S.q.length); }
  }

  function matches() {
    const q = S.q.trim().toLowerCase();
    return q ? D.players.filter((p) => statsOf(p) && p.name.toLowerCase().includes(q)) : [];
  }

  function drawTable() {
    const card = document.getElementById("tablecard");
    const ms = visibleMetrics();
    const st = S.stat;
    const q = S.q.trim().toLowerCase();

    const inGroup = D.players.filter((p) => statsOf(p)
      && (!S.grad || String(p.grad) === S.grad) && (!S.wclass || p.wclass === S.wclass));
    const qualified = inGroup.filter((p) => statsOf(p).n >= D.min_swings);

    // percentile pools from qualified players in the current filter group
    const pools = {};
    for (const m of ms) pools[m.key] = qualified.map((p) => statsOf(p)[st][m.key]).filter((v) => v != null);

    // rank by the sort column (only for ranked metrics)
    const rankOf = new Map();
    const sm = M[S.sort];
    if (sm && ranked(sm)) {
      const better = sm.direction === "lower" ? 1 : -1;
      const order = qualified.filter((p) => statsOf(p)[st][sm.key] != null)
        .sort((a, b) => better * (statsOf(a)[st][sm.key] - statsOf(b)[st][sm.key]));
      let prev = null, r = 0;
      order.forEach((p, i) => { const v = statsOf(p)[st][sm.key]; if (v !== prev) r = i + 1; prev = v; rankOf.set(p.id, r); });
    }

    let rows = inGroup.filter((p) => q ? p.name.toLowerCase().includes(q) : (S.showLow || statsOf(p).n >= D.min_swings));
    const key = (p) => S.sort === "name" ? p.name.toLowerCase() : S.sort === "grad" ? p.grad
      : S.sort === "wclass" ? (p.wclass ? D.weight_classes.indexOf(p.wclass) : null) : S.sort === "n" ? statsOf(p).n : statsOf(p)[st][S.sort];
    rows.sort((a, b) => {
      const la = statsOf(a).n < D.min_swings, lb = statsOf(b).n < D.min_swings;
      if (la !== lb) return la ? 1 : -1;
      const ka = key(a), kb = key(b);
      if (ka == null && kb == null) return a.name.localeCompare(b.name);
      if (ka == null) return 1;
      if (kb == null) return -1;
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * S.dir || a.name.localeCompare(b.name);
    });

    const th = (k, label, unit, cls, title) => {
      const active = S.sort === k;
      return h("th", { class: cls, scope: "col", title, "aria-sort": active ? (S.dir < 0 ? "descending" : "ascending") : null },
        h("button", { type: "button", onclick: () => {
          if (S.sort === k) S.dir = -S.dir;
          else { S.sort = k; const m = M[k]; S.dir = k === "name" || k === "wclass" || (m && m.direction === "lower") || k === "grad" ? 1 : -1; }
          save(); drawTable();
        } }, h("span", { class: "arrow" }, active ? (S.dir < 0 ? "▼" : "▲") : ""), label, unit ? h("span", { class: "unit" }, unit) : null));
    };
    const head = h("tr", {},
      h("th", { class: "l", scope: "col" }, "#"),
      th("name", "Player", null, "l sticky"),
      D.grad_classes.length ? th("grad", "Grad", null, "opt") : null,
      D.weight_classes.length ? th("wclass", "Wt class", null, "l opt") : null,
      th("n", "Swings", null, ""),
      ms.map((m) => th(m.key, m.short, m.unit || " ", "", `${m.label}${m.unit ? " (" + m.unit + ")" : ""}` +
        (m.direction === "lower" ? " — lower is better" : m.direction === "none" ? " — not ranked" : ""))));

    const body = rows.map((p) => {
      const stt = statsOf(p);
      const low = stt.n < D.min_swings;
      return h("tr", { class: low ? "low" : null },
        h("td", { class: "rank l" }, rankOf.get(p.id) || ""),
        h("td", { class: "name l sticky" }, h("a", { href: "#/p/" + p.id }, p.name), low ? h("span", { class: "tag" }, "few swings") : null),
        D.grad_classes.length ? h("td", { class: "dim opt" }, p.grad || "—") : null,
        D.weight_classes.length ? h("td", { class: "l dim opt" }, p.wclass || "—") : null,
        h("td", { class: "dim" }, stt.n),
        ms.map((m) => {
          const v = stt[st][m.key];
          const pc = !low && ranked(m) ? percentile(v, pools[m.key], m.direction) : null;
          const td = h("td", { class: [bin(pc), S.sort === m.key ? "sorted" : ""].join(" ").trim() || null }, fmt(v, m));
          if (v != null) td.addEventListener("pointermove", (e) => showTip(e,
            h("b", {}, fmt(v, m) + unitStr(m)),
            h("span", { class: "k" }, `${p.name} · ${m.label} ${st === "peak" ? "peak" : "avg"}`),
            pc != null ? `${ordinal(pc)} percentile of ${pools[m.key].length} players` : (low ? `Fewer than ${D.min_swings} swings — not ranked` : "Not ranked")));
          td.addEventListener("pointerleave", hideTip);
          return td;
        }));
    });

    const table = h("table", { class: "board" }, h("thead", {}, head), h("tbody", {}, body));
    card.replaceChildren(rows.length ? table : h("p", { class: "empty" },
      q ? `No player matching “${S.q}” has swings ${S.win !== "overall" ? "in the " + winLabel() : "recorded"}.` : "No players match these filters."));
  }

  // ------------------------------------------------------------------ player
  function peerGroup(p) {
    return D.players.filter((o) => statsOf(o) && statsOf(o).n >= D.min_swings
      && (S.cmp !== "grad" || o.grad === p.grad) && (S.cmp !== "wclass" || o.wclass === p.wclass));
  }

  function renderPlayer(id) {
    const p = D.players.find((x) => x.id === id);
    if (!p) { app.replaceChildren(h("a", { class: "back", href: "#/" }, "← All players"), h("p", { class: "empty" }, "Player not found.")); return; }
    document.title = `${p.name} · ${D.site_title}`;
    if ((S.cmp === "grad" && !p.grad) || (S.cmp === "wclass" && !p.wclass)) S.cmp = "all";
    const rer = () => { save(); renderPlayer(id); };

    const st = statsOf(p);
    const chips = h("div", { class: "chips" },
      p.grad ? h("span", { class: "chip" }, "Class of ", h("b", {}, p.grad)) : null,
      p.wclass ? h("span", { class: "chip" }, h("b", {}, p.wclass), " lbs") : null,
      h("span", { class: "chip" }, h("b", {}, p.stats.overall.n), " swings all time"),
      D.windows.filter((w) => w.days).map((w) => h("span", { class: "chip" }, h("b", {}, p.stats[w.key] ? p.stats[w.key].n : 0), ` in ${w.label.toLowerCase()}`)),
      h("span", { class: "chip" }, "Last swing ", h("b", {}, fmtDate(p.stats.overall.last, { month: "short", day: "numeric" }))));

    const cmpOpts = [["all", "All players"]];
    if (p.grad) cmpOpts.push(["grad", `Class of ${p.grad}`]);
    if (p.wclass) cmpOpts.push(["wclass", `${p.wclass} lbs`]);
    const head = h("div", { class: "p-head" },
      h("div", {}, h("h2", {}, p.name), chips),
      h("div", { class: "controls", style: "margin:0" },
        seg(winOpts(), S.win, (v) => { S.win = v; rer(); }, "Time window"),
        select("Compare to", cmpOpts, S.cmp, (v) => { S.cmp = v; rer(); })));

    const parts = [h("a", { class: "back", href: "#/" }, "← All players"), head];

    if (!st) {
      parts.push(h("div", { class: "card" }, h("p", { class: "empty" }, `No swings in the ${winLabel()}. Switch to “All time” to see this player's numbers.`)));
    } else {
      const peers = peerGroup(p);
      const others = peers.filter((o) => o.id !== p.id);
      const low = st.n < D.min_swings;
      const cmpName = cmpOpts.find(([v]) => v === S.cmp)[1].toLowerCase().replace("class", "Class");
      const sub = low
        ? `Only ${st.n} swing${st.n === 1 ? "" : "s"} (${winLabel()}) — percentiles appear at ${D.min_swings}+ swings.`
        : `Percentiles compare against ${others.length} other ${S.cmp === "all" ? "players" : "players in " + cmpName}${D.min_swings > 1 ? ` with ${D.min_swings}+ swings` : " with swings"} (${winLabel()}).`;

      const grid = h("div", { class: "mrows" },
        h("div", { class: "hd h-lbl" }, "Metric"), h("div", { class: "hd" }, "Average"), h("div", { class: "hd" }, "Peak"),
        h("div", { class: "hd h-strip" }, "Your average vs. peers' averages"));
      for (const m of D.metrics) {
        const v = st.avg[m.key], pk = st.peak[m.key];
        const pa = !low && ranked(m) ? percentile(v, others.map((o) => statsOf(o).avg[m.key]).filter((x) => x != null), m.direction) : null;
        const pp = !low && ranked(m) ? percentile(pk, others.map((o) => statsOf(o).peak[m.key]).filter((x) => x != null), m.direction) : null;
        const pctEl = (pc) => pc == null ? null : h("span", { class: "pct" + (pc >= 80 ? " top" : pc < 20 ? " low" : "") }, `${ordinal(pc)} percentile`);
        grid.append(
          h("div", { class: "lbl" }, m.label, m.direction === "lower" ? h("small", {}, " · lower is better") : null),
          h("div", { class: "cell-avg" }, h("span", { class: "val" }, fmt(v, m), h("span", { class: "u" }, m.unit)), pctEl(pa)),
          h("div", { class: "cell-peak" }, ranked(m) ? [h("span", { class: "val" }, fmt(pk, m), h("span", { class: "u" }, m.unit)), pctEl(pp)] : h("span", { class: "pct" }, "—")),
          h("div", { class: "strip" }, strip(p, others, m)));
      }
      parts.push(h("div", { class: "card" }, h("h3", {}, `Metrics · ${winLabel()}`), h("p", { class: "sub" }, sub), grid));
      parts.push(trendCard(p, others));
    }
    app.replaceChildren(...parts);
    drawTrend();
  }

  /** Dot strip: every peer's average as a gray dot, middle-50% band, this player as a large blue dot. */
  function strip(p, others, m) {
    const me = statsOf(p).avg[m.key];
    const pts = others.map((o) => ({ name: o.name, v: statsOf(o).avg[m.key] })).filter((d) => d.v != null);
    const all = pts.map((d) => d.v).concat(me != null ? [me] : []);
    if (!all.length) return h("span", { class: "pct" }, "—");
    let lo = Math.min(...all), hi = Math.max(...all);
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.04; lo -= pad; hi += pad;
    const x = (v) => ((v - lo) / (hi - lo) * 100).toFixed(2) + "%";
    const sorted = pts.map((d) => d.v).sort((a, b) => a - b);
    const q = (f) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * (sorted.length - 1) + 0.5))] : null;
    const svg = s("svg", { role: "img", "aria-label": `${m.label}: ${fmt(me, m)}${unitStr(m)}; peers range ${fmt(Math.min(...all), m)} to ${fmt(Math.max(...all), m)}` },
      s("line", { x1: "0%", x2: "100%", y1: 13, y2: 13, stroke: "var(--axis)", "stroke-width": 1 }),
      sorted.length >= 4 ? s("rect", { x: x(q(0.25)), y: 6, width: ((q(0.75) - q(0.25)) / (hi - lo) * 100).toFixed(2) + "%", height: 14, rx: 3, fill: "var(--band)" }) : null,
      sorted.length >= 3 ? s("line", { x1: x(q(0.5)), x2: x(q(0.5)), y1: 4, y2: 22, stroke: "var(--muted)", "stroke-width": 1.5 }) : null,
      pts.map((d) => s("circle", { cx: x(d.v), cy: 13, r: 4, fill: "var(--peer-dot)", stroke: "var(--surface)", "stroke-width": 1.5 })),
      me != null ? s("circle", { cx: x(me), cy: 13, r: 7, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2 }) : null,
      s("text", { x: "0%", y: 33, class: "axis-lbl" }, fmt(Math.min(...all), m)),
      s("text", { x: "100%", y: 33, "text-anchor": "end", class: "axis-lbl" }, fmt(Math.max(...all), m)),
      ranked(m) ? s("text", { x: "50%", y: 33, "text-anchor": "middle", class: "axis-lbl" }, m.direction === "lower" ? "← better" : "better →") : null);
    svg.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const v = lo + (e.clientX - r.left) / r.width * (hi - lo);
      const cand = pts.map((d) => ({ ...d, me: false })).concat(me != null ? [{ name: p.name, v: me, me: true }] : []);
      cand.sort((a, b) => Math.abs(a.v - v) - Math.abs(b.v - v) || (b.me - a.me));
      const n = cand[0];
      showTip(e, h("b", {}, fmt(n.v, m) + unitStr(m)), h("span", { class: "k" }, (n.me ? "You · " : "") + n.name + " · avg"),
        sorted.length >= 3 ? `Peer median ${fmt(q(0.5), m)}${unitStr(m)}` : null);
    });
    svg.addEventListener("pointerleave", hideTip);
    return svg;
  }

  // ------------------------------------------------------------------ trend
  let trendCtx = null;
  function trendCard(p, others) {
    if (!M[S.trend]) S.trend = D.metrics[0].key;
    trendCtx = { p, others };
    const sel = select("Metric", D.metrics.map((m) => [m.key, m.label]), S.trend, (v) => { S.trend = v; save(); drawTrend(); });
    return h("div", { class: "card trend" },
      h("div", { class: "trend-ctl" }, h("div", {}, h("h3", {}, "Weekly trend"), h("p", { class: "sub", style: "margin:0" }, "Average of each week's swings, all time")), sel),
      h("div", { id: "trendplot" }),
      h("div", { class: "trend-legend" }, h("span", {}, h("i"), trendCtx.p.name), h("span", { id: "reflegend" }, h("i", { class: "ref" }), "Peer average")));
  }

  function niceTicks(lo, hi, count) {
    const span = hi - lo || Math.abs(hi) || 1;
    const step0 = span / count, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((st) => span / st <= count) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return { ticks: out, step };
  }

  function drawTrend() {
    const host = document.getElementById("trendplot");
    if (!host || !trendCtx) return;
    const { p, others } = trendCtx;
    const m = M[S.trend];
    const t = p.trend;
    const pts = t.weeks.map((w, i) => ({ w, v: t.m[m.key] ? t.m[m.key][i] : null, n: t.n[i] })).filter((d) => d.v != null);
    const refVals = others.map((o) => statsOf(o).avg[m.key]).filter((v) => v != null);
    const ref = refVals.length ? refVals.reduce((a, b) => a + b, 0) / refVals.length : null;
    const reflegend = document.getElementById("reflegend");
    if (reflegend) reflegend.hidden = ref == null;
    if (!pts.length) { host.replaceChildren(h("p", { class: "empty" }, "No data")); return; }

    const W = Math.max(280, host.clientWidth), H = 260, L = 46, R = 12, T = 12, B = 28;
    const vals = pts.map((d) => d.v).concat(ref != null ? [ref] : []);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const padv = (hi - lo || Math.abs(hi) * 0.1 || 1) * 0.15; lo -= padv; hi += padv;
    const { ticks } = niceTicks(lo, hi, 4);
    lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
    const t0 = new Date(pts[0].w + "T12:00:00").getTime(), t1 = new Date(pts[pts.length - 1].w + "T12:00:00").getTime();
    const xs = (w) => pts.length === 1 ? L + (W - L - R) / 2 : L + (new Date(w + "T12:00:00").getTime() - t0) / (t1 - t0) * (W - L - R);
    const ys = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const stepStr = String(+((ticks[1] - ticks[0]) || 1).toFixed(6));
    const dec = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;

    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `${m.label} weekly average trend for ${p.name}` });
    for (const tk of ticks) {
      svg.append(s("line", { x1: L, x2: W - R, y1: ys(tk), y2: ys(tk), stroke: "var(--grid)", "stroke-width": 1 }),
        s("text", { x: L - 8, y: ys(tk) + 4, "text-anchor": "end", class: "tick" }, tk.toFixed(dec)));
    }
    // x labels: about 6 evenly spaced weeks
    const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor((W - L - R) / 70))));
    pts.forEach((d, i) => { if (i % every === 0) svg.append(s("text", { x: xs(d.w), y: H - 8, "text-anchor": "middle", class: "tick" }, fmtDate(d.w, { month: "short", day: "numeric" }))); });
    svg.append(s("line", { x1: L, x2: W - R, y1: H - B, y2: H - B, stroke: "var(--axis)", "stroke-width": 1 }));
    if (ref != null) svg.append(s("line", { x1: L, x2: W - R, y1: ys(ref), y2: ys(ref), stroke: "var(--muted)", "stroke-width": 1.5, "stroke-dasharray": "5 4" }));
    if (pts.length > 1) svg.append(s("path", { d: pts.map((d, i) => `${i ? "L" : "M"}${xs(d.w).toFixed(1)},${ys(d.v).toFixed(1)}`).join(""),
      fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    pts.forEach((d) => svg.append(s("circle", { cx: xs(d.w), cy: ys(d.v), r: 4, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2 })));
    const cross = s("line", { y1: T, y2: H - B, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" });
    const ring = s("circle", { r: 6, fill: "none", stroke: "var(--accent)", "stroke-width": 2, visibility: "hidden" });
    svg.append(cross, ring, s("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" }));
    svg.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) * (W / r.width);
      const d = pts.reduce((a, b) => Math.abs(xs(b.w) - px) < Math.abs(xs(a.w) - px) ? b : a);
      cross.setAttribute("x1", xs(d.w)); cross.setAttribute("x2", xs(d.w)); cross.setAttribute("visibility", "visible");
      ring.setAttribute("cx", xs(d.w)); ring.setAttribute("cy", ys(d.v)); ring.setAttribute("visibility", "visible");
      showTip(e, h("b", {}, fmt(d.v, m) + unitStr(m)), h("span", { class: "k" }, `Week of ${fmtDate(d.w, { month: "short", day: "numeric" })} · ${d.n} swings`),
        ref != null ? `Peer average ${fmt(ref, m)}${unitStr(m)}` : null);
    });
    svg.addEventListener("pointerleave", () => { hideTip(); cross.setAttribute("visibility", "hidden"); ring.setAttribute("visibility", "hidden"); });
    host.replaceChildren(svg);
  }

  // ------------------------------------------------------------------ routing
  function route() {
    hideTip();
    const m = location.hash.match(/^#\/p\/([^/?]+)/);
    if (m) { renderPlayer(decodeURIComponent(m[1])); window.scrollTo(0, 0); }
    else renderBoard();
  }

  let rt = null;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(drawTrend, 120); });
  addEventListener("hashchange", route);

  fetch("data.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      D = data;
      M = Object.fromEntries(D.metrics.map((m) => [m.key, m]));
      if (!D.windows.some((w) => w.key === S.win)) S.win = S.win === "recent" && D.windows.some((w) => w.key === "d30") ? "d30" : "overall";
      document.getElementById("title").textContent = D.site_title;
      document.getElementById("team").textContent = D.team_name || "";
      document.getElementById("meta").textContent =
        `Updated ${fmtDate(D.generated_at)} · swings through ${fmtDate(D.data_through)}`;
      document.getElementById("foot").textContent =
        `Blast Motion swing data via WIN Reality. ${D.players.length} players. Refreshed nightly.`;
      route();
    })
    .catch((e) => { app.replaceChildren(h("p", { class: "empty" }, "Couldn't load data (" + e.message + ").")); });
})();
