/* app.js -- Apex Trace Kart 2: screens, sensors and storage. The measuring is in core.js. */
(function () {
  "use strict";
  const K = window.KartCore, VERSION = "2.0.1", G0 = 9.80665;
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s === null || s === undefined ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const app = $("#app");
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function toast(msg, ms) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, ms || 3200); }

  /* lap time as a driver reads it: 32.41 or 1:02.41 */
  function lapTime(s, d) {
    if (s === null || s === undefined || !isFinite(s)) return "--.--";
    d = d === undefined ? 2 : d;
    const m = Math.floor(s / 60), r = s - 60 * m;
    return m ? `${m}:${r.toFixed(d).padStart(d + 3, "0")}` : r.toFixed(d);
  }
  const clock = s => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const signed = (x, d) => (x >= 0 ? "+" : "-") + Math.abs(x).toFixed(d === undefined ? 2 : d);
  const signedTxt = (x, d) => signed(x, d).replace("-", "−");
  const MARK = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#15171B"/><path d="M6 23 C 12 23, 12 10, 17 10 C 22 10, 21 18, 26 18" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="17" cy="10" r="2.6" fill="#FFB020"/></svg>`;

  /* ------------------------------------------------------------------ segment digits (the dash's own type) */
  /* Numbers on the dash are drawn as seven-segment digits, like the display of a kart or race dash:
     unlit segments stay faintly visible, so a figure never jumps sideways when it changes. */
  const SEG = (() => {
    const T = 13, L = 7.5, R = 48.5, Y0 = 7.5, Y1 = 50, Y2 = 92.5, g = 1.6;
    const Hs = (xl, xr, y) => `${xl},${y} ${xl + T / 2},${y - T / 2} ${xr - T / 2},${y - T / 2} ${xr},${y} ${xr - T / 2},${y + T / 2} ${xl + T / 2},${y + T / 2}`;
    const Vs = (x, yt, yb) => `${x},${yt} ${x + T / 2},${yt + T / 2} ${x + T / 2},${yb - T / 2} ${x},${yb} ${x - T / 2},${yb - T / 2} ${x - T / 2},${yt + T / 2}`;
    const P = { a: Hs(L + g, R - g, Y0), g: Hs(L + g, R - g, Y1), d: Hs(L + g, R - g, Y2), f: Vs(L, Y0 + g, Y1 - g), b: Vs(R, Y0 + g, Y1 - g), e: Vs(L, Y1 + g, Y2 - g), c: Vs(R, Y1 + g, Y2 - g) };
    const D = { "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc", "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abfgcd", "-": "g", " ": "" };
    return function (text, color) {
      let x = 6, out = "";
      const ghost = "rgba(255,255,255,0.055)";
      for (const ch of String(text)) {
        if (ch === ".") { out += `<rect x="${x + 2}" y="84" width="13" height="13" fill="${color}"/>`; x += 24; continue; }
        if (ch === ":") { out += `<rect x="${x + 4}" y="27" width="13" height="13" fill="${color}"/><rect x="${x + 4}" y="62" width="13" height="13" fill="${color}"/>`; x += 28; continue; }
        const plus = ch === "+", on = plus ? "g" : (D[ch] === undefined ? "" : D[ch]);
        let cell = "";
        for (const k of "abcdefg") cell += `<polygon points="${P[k]}" fill="${on.includes(k) ? color : ghost}"/>`;
        if (plus) cell += `<polygon points="${Vs(28, 27, Y1 - 5)}" fill="${color}"/><polygon points="${Vs(28, Y1 + 5, 73)}" fill="${color}"/>`;
        out += `<g transform="translate(${x} 0)">${cell}</g>`; x += 66;
      }
      const W = x + 2;
      return `<svg viewBox="0 0 ${W + 10} 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g transform="translate(11 0) skewX(-6)">${out}</g></svg>`;
    };
  })();

  /* ------------------------------------------------------------------ settings (this phone only) */
  const FIELD_KEYS = ["current", "delta", "pred", "last", "best", "lastdiff", "lastprev", "lap", "avg3", "clock", "left", "gnow", "gpeak"];
  const DEFAULT_DASH = { main: "current", tiles: ["delta", "last", "best", "lap"], deltaBar: true, gBar: true };
  const settings = { track: "", source: "auto", mic: true, minutes: 0, dash: JSON.parse(JSON.stringify(DEFAULT_DASH)) };
  try {
    const saved = JSON.parse(localStorage.getItem("atk-settings") || "{}");
    Object.assign(settings, saved);
    if (!settings.dash || !FIELD_KEYS.includes(settings.dash.main) || !Array.isArray(settings.dash.tiles)) settings.dash = JSON.parse(JSON.stringify(DEFAULT_DASH));
    settings.dash.tiles = settings.dash.tiles.filter(k => FIELD_KEYS.includes(k)).slice(0, 6);
  } catch (e) { /* private mode */ }
  function saveSettings() { try { localStorage.setItem("atk-settings", JSON.stringify(settings)); } catch (e) { /* fine */ } }

  /* ------------------------------------------------------------------ storage: sessions stay on the phone */
  const mem = { sessions: new Map(), data: new Map() };
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(resolve => {
      try {
        const rq = indexedDB.open("apex-trace-kart", 1);
        rq.onupgradeneeded = () => { rq.result.createObjectStore("sessions", { keyPath: "id" }); rq.result.createObjectStore("data", { keyPath: "id" }); };
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = rq.onblocked = () => resolve(null);
        setTimeout(() => resolve(null), 5000);          // storage that never answers: carry on in memory
      } catch (e) { resolve(null); }
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    if (!d) return fn(null);
    return new Promise((resolve, reject) => {
      // a write that is refused (storage full) ends in "abort", not "error"; and nothing here may wait for ever
      const timer = setTimeout(() => reject(new Error("storage did not answer")), 10000);
      const t = d.transaction(store, mode), st = t.objectStore(store), rq = fn(st);
      t.oncomplete = () => { clearTimeout(timer); resolve(rq && rq.result); };
      t.onerror = t.onabort = () => { clearTimeout(timer); reject(t.error || new Error("storage refused the write")); };
    });
  }
  const Store = {
    /* true when the phone's storage took it; false when it is only held in memory (lost if the app closes) */
    async put(store, val) { mem[store].set(val.id, val); try { const d = await db(); if (!d) return false; await tx(store, "readwrite", st => st.put(val)); return true; } catch (e) { return false; } },
    async get(store, id) { if (mem[store].has(id)) return mem[store].get(id); try { const v = await tx(store, "readonly", st => st && st.get(id)); if (v) return v; } catch (e) { /* fall through */ } return mem[store].get(id) || null; },
    async all() { let out = null; try { out = await tx("sessions", "readonly", st => st && st.getAll()); } catch (e) { out = null; } const by = new Map((out || []).map(x => [x.id, x])); mem.sessions.forEach((v, k) => by.set(k, v)); return Array.from(by.values()).sort((a, b) => b.started - a.started); },
    async del(id) { mem.sessions.delete(id); mem.data.delete(id); try { await tx("sessions", "readwrite", st => st && st.delete(id)); await tx("data", "readwrite", st => st && st.delete(id)); } catch (e) { /* gone anyway */ } },
  };

  /* ------------------------------------------------------------------ recorder */
  const COLS = ["t", "ax", "ay", "az", "gx", "gy", "gz", "rx", "ry", "rz", "yaw", "g", "steer"];
  class Rec {
    constructor() { this.nc = COLS.length; this.cap = 60 * 60 * 2; this.buf = new Float32Array(this.cap * this.nc); this.n = 0; }
    push(row) {
      if (this.n === this.cap) { const nb = new Float32Array(this.cap * 2 * this.nc); nb.set(this.buf); this.buf = nb; this.cap *= 2; }
      this.buf.set(row, this.n * this.nc); this.n++;
    }
    data() { return this.buf.slice(0, this.n * this.nc); }
  }

  /* ------------------------------------------------------------------ a session being driven */
  let cur = null;
  function newSession(source) {
    return { id: "s" + Date.now().toString(36), track: settings.track.trim() || "Unnamed track", started: Date.now(), source, rec: new Rec(), det: new K.LapDetector(),
             marks: [], t: 0, gf: null, gS: 0, gLapMax: 0, gMax: 0, events: 0, hasLin: false, hasGyro: false, audio: { t: [], bins: [] }, lastLapN: 0, sim: null,
             trk: null, trkRef: null, trkPasses: -1, trkAnchor: 0, log: [], gaps: 0, gapTime: 0, errs: 0, wake: "not asked", ending: false };
  }
  /* What happened during the session, with the time it happened: kept with the session and written into
     the data file, so that a problem at the track can be understood afterwards. */
  function note(s, text) { if (s && s.log.length < 300) s.log.push([+(s.t || 0).toFixed(1), String(text).slice(0, 160)]); }

  /* ------------------------------------------------------------------ laps and the live figure */
  /* Which timing drives the dash right now. With automatic timing, the driver's own taps stand in until
     the lap has been found (2 to 3 laps on a normal track, minutes on a track that crosses over itself). */
  function liveSource(s) { return s.source === "taps" || (s.det.state() === "learning" && s.marks.length >= 1) ? "taps" : "auto"; }
  function currentLaps(s) { return liveSource(s) === "taps" ? K.lapsFromMarks(s.marks) : s.det.laps(); }
  function lastPass(s) { return liveSource(s) === "taps" ? (s.marks.length ? s.marks[s.marks.length - 1] : null) : s.det.lastPass(); }
  function passCount(s) { return liveSource(s) === "taps" ? s.marks.length : s.det.passes.length; }

  /* Everything the dashboard can show, at this instant. */
  function model(s) {
    const t = s.t, laps = currentLaps(s), ok = laps.filter(l => !l.interrupted), last = laps.length ? laps[laps.length - 1] : null, prev = laps.length > 1 ? laps[laps.length - 2] : null;
    const best = ok.length ? ok.reduce((a, b) => b.time < a.time ? b : a) : null, pass = lastPass(s);
    const m = { t, laps, last, prev, best, timing: pass !== null, lapClock: pass !== null ? t - pass : null, delta: null, pred: null, lapN: laps.length + (pass !== null ? 1 : 0),
                gS: s.gS, gLapMax: s.gLapMax, left: settings.minutes > 0 ? Math.max(0, settings.minutes * 60 - t) : null, source: liveSource(s), standIn: s.source === "auto" && liveSource(s) === "taps", state: s.source === "taps" ? "taps" : s.det.state() };
    // live plus or minus to the best lap: follow the best lap's turn pattern from the last pass
    if (best && pass !== null && s.det.y.length > 20) {
      const fs = K.FS, sm = s.det._smooth(), n = passCount(s);
      if (!s.trk || s.trkRef !== best.start || s.trkPasses !== n) {
        s.trk = new K.LiveTracker(K.referenceLap(sm, best.start, best.end, fs), fs); s.trkRef = best.start; s.trkPasses = n; s.trkAnchor = pass;
      }
      const usable = (s.det.y.length - 7) / fs;
      let guard = 0;
      while (s.trkAnchor + (s.trk.k + 1) / fs <= usable && guard++ < 4000) s.trk.push(K.valueAt(sm, s.trkAnchor + (s.trk.k + 1) / fs, fs));
      const behind = t - (s.trkAnchor + s.trk.k / fs);                // the tracker runs a third of a second behind the clock
      m.delta = s.trk.delta(); m.pred = best.time + m.delta;
      m.lapClock = s.trk.lapClock() + behind;                         // restarts at the line at once, without waiting for the pass to be confirmed
      if (s.trk.lap > 0) m.lapN = laps.length + 1 + s.trk.lap;
    }
    return m;
  }

  /* purple = best of the session, green = quicker than the lap before, red = slower */
  function lapColour(laps, i) {
    const l = laps[i]; if (!l || l.interrupted) return "--ink-3";
    const ok = laps.filter(x => !x.interrupted), best = Math.min(...ok.map(x => x.time));
    if (l.time <= best + 1e-9) return "--best";
    let p = i - 1; while (p >= 0 && laps[p].interrupted) p--;
    if (p < 0) return "--ink";
    return l.time < laps[p].time ? "--faster" : "--slower";
  }

  /* What a tile or the main display can show. Each returns the text and its colour (a CSS variable). */
  const FIELDS = {
    current: { name: "This lap", label: "THIS LAP", get: m => ({ text: m.timing ? lapTime(m.lapClock, 1) : clock(m.t), color: "--ink" }) },
    delta: { name: "Plus or minus to best lap, live", label: "± BEST", get: m => m.delta === null ? { text: "-.--", color: "--ink-3" } : { text: signed(m.delta), color: m.delta <= 0 ? "--faster" : "--slower" } },
    pred: { name: "Predicted lap time", label: "PREDICTED", get: m => m.pred === null ? { text: "--.--", color: "--ink-3" } : { text: lapTime(m.pred), color: m.delta <= 0 ? "--faster" : "--ink" } },
    last: { name: "Last lap", label: "LAST LAP", get: m => m.last ? { text: lapTime(m.last.time), color: lapColour(m.laps, m.laps.length - 1) } : { text: "--.--", color: "--ink-3" } },
    best: { name: "Best lap", label: "BEST LAP", get: m => m.best ? { text: lapTime(m.best.time), color: "--best" } : { text: "--.--", color: "--ink-3" } },
    lastdiff: { name: "Last lap against best", label: "LAST ± BEST", get: m => m.last && m.best && !m.last.interrupted ? { text: signed(m.last.time - m.best.time), color: m.last === m.best ? "--best" : "--slower" } : { text: "-.--", color: "--ink-3" } },
    lastprev: { name: "Last lap against the one before", label: "LAST ± PREV", get: m => m.last && m.prev ? { text: signed(m.last.time - m.prev.time), color: m.last.time <= m.prev.time ? "--faster" : "--slower" } : { text: "-.--", color: "--ink-3" } },
    lap: { name: "Lap number", label: "LAP", get: m => ({ text: String(m.lapN), color: "--ink" }) },
    avg3: { name: "Average of the last 3 laps", label: "AVG LAST 3", get: m => { const v = m.laps.filter(l => !l.interrupted).slice(-3); return v.length ? { text: lapTime(v.reduce((a, b) => a + b.time, 0) / v.length), color: "--ink" } : { text: "--.--", color: "--ink-3" }; } },
    clock: { name: "Session time", label: "SESSION", get: m => ({ text: clock(m.t), color: "--ink" }) },
    left: { name: "Time left in the session", label: "TIME LEFT", get: m => m.left === null ? { text: "-:--", color: "--ink-3" } : { text: clock(m.left), color: m.left < 60 ? "--amber" : "--ink" } },
    gnow: { name: "Force now (G)", label: "FORCE G", get: m => ({ text: m.gS.toFixed(1), color: "--ink" }) },
    gpeak: { name: "Peak force this lap (G)", label: "PEAK G", get: m => ({ text: m.gLapMax.toFixed(1), color: "--ink" }) },
  };

  /* Build a dashboard from a configuration; returns a function that refreshes it from a model. */
  function buildDash(host, cfg, opts) {
    opts = opts || {};
    const tiles = cfg.tiles.filter(k => FIELDS[k]), n = tiles.length, cols = n <= 2 ? Math.max(1, n) : (n <= 4 ? 2 : 3);
    host.innerHTML = `<div class="dash${opts.preview ? " pv" : ""}" id="${opts.preview ? "pvdash" : "dash"}">
      ${cfg.deltaBar ? `<div class="dbar"><div class="ticks"></div><i data-r="dfill"></i><span class="zero"></span><div class="learn" data-r="learn" style="width:0"></div></div>` : ""}
      <div class="dgrid" style="${n ? "" : "grid-template-rows:1fr;grid-template-columns:1fr"}">
        <div class="dmain"><div class="dlabel" data-r="L-main"></div><div class="dval" data-r="V-main"></div></div>
        ${n ? `<div class="dtiles" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${tiles.map((k, i) => `<div class="dtile" data-tile="${k}"><div class="dlabel">${esc(FIELDS[k].label)}</div><div class="dval" data-r="V-${i}"></div></div>`).join("")}</div>` : ""}
      </div>
      ${cfg.gBar ? `<div class="gbar" aria-label="Cornering and braking force"><i data-r="gfill"></i><em data-r="gmark"></em></div>` : ""}
      ${opts.preview ? "" : `<div class="dfoot"><span class="dstatus" data-r="status"></span><button class="stop" id="stop" type="button">Stop</button></div><div class="tapmark" id="tapmark"></div>`}
    </div>`;
    const ref = {}; $$("[data-r]", host).forEach(e => { ref[e.dataset.r] = e; });
    const cache = {};
    const put = (key, el, f) => { const sig = f.text + "|" + f.color; if (cache[key] !== sig) { cache[key] = sig; el.innerHTML = SEG(f.text, css(f.color)); } };
    return function refresh(m) {
      const mainKey = cfg.main, learning = m.state === "learning";
      ref["L-main"].textContent = mainKey === "current" && !m.timing ? (m.source === "taps" ? "TAP AT THE LINE" : "LEARNING THE TRACK") : FIELDS[mainKey].label;
      put("main", ref["V-main"], FIELDS[mainKey].get(m));
      tiles.forEach((k, i) => put("t" + i, ref["V-" + i], FIELDS[k].get(m)));
      if (ref.dfill) {
        if (m.delta !== null) {
          const w = Math.min(50, 50 * Math.abs(m.delta) / 1.0);        // full half-bar at one second
          ref.dfill.style.cssText = m.delta <= 0 ? `right:50%;width:${w.toFixed(1)}%;background:var(--faster)` : `left:50%;width:${w.toFixed(1)}%;background:var(--slower)`;
          ref.learn.style.width = "0";
        } else { ref.dfill.style.width = "0"; ref.learn.style.width = learning && m.learn !== undefined ? (100 * m.learn).toFixed(0) + "%" : "0"; }
      }
      if (ref.gfill) { ref.gfill.style.width = Math.min(100, 100 * m.gS / 2.5).toFixed(1) + "%"; ref.gmark.style.left = Math.min(99.4, 100 * m.gLapMax / 2.5).toFixed(1) + "%"; }
      if (ref.status) ref.status.textContent = m.status || "";
    };
  }

  /* ------------------------------------------------------------------ driving */
  /* Everything here is written so that one thing going wrong cannot take the rest with it: the recording
     carries on if the lap timing fails, the session is kept if the app is closed or the phone locks, and
     leaving the dash always takes two deliberate taps. */
  let wake = null, refresh = null, ticks = 0, starting = false;
  const MAX_SESSION_S = 90 * 60;                 // a session left running is stopped and saved after this long

  /* Keep the screen on. The phone may refuse (battery saver) or take the lock back; ask again whenever
     the app comes back to the front. */
  async function holdScreen() {
    const s = cur; if (!s || s.ending) return;
    if (!("wakeLock" in navigator)) { s.wake = "not supported"; return; }
    try {
      const w = await navigator.wakeLock.request("screen");
      if (cur !== s || s.ending) { try { w.release(); } catch (e) { /* gone */ } return; }
      wake = w; if (s.wake !== "held") note(s, "screen kept on"); s.wake = "held";
      w.addEventListener("release", () => { if (wake === w) wake = null; if (cur === s && !s.ending) { s.wake = "released"; note(s, "the phone released the screen lock"); if (document.visibilityState === "visible") setTimeout(holdScreen, 400); } });
    } catch (e) { if (cur === s) { if (s.wake !== "refused") note(s, "screen lock refused (" + (e && e.name) + ")"); s.wake = "refused"; } }
  }
  async function goFullscreen() {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock(screen.orientation.type);
    } catch (e) { /* optional: the dash works without it */ }
  }

  /* Leaving the dash. One tap asks, a second tap on a large button confirms. Nothing is held down:
     a finger does not stay still on a vibrating wheel. The question goes away by itself. */
  function askStop(how) {
    const s = cur, dash = $("#dash"); if (!s || s.ending || !dash || $("#ask")) return;
    note(s, "stop asked (" + how + ")");
    const el = document.createElement("div"); el.className = "ask"; el.id = "ask"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Stop this session?");
    el.innerHTML = `<div class="askbox"><p class="askq">Stop this session?</p>
      <button type="button" class="askyes" id="askyes">Stop and save</button>
      <button type="button" class="askno" id="askno">Keep driving</button>
      <p class="asks">Timing is still running. This closes by itself.</p><div class="askbar"><i></i></div></div>`;
    dash.appendChild(el);
    const opened = performance.now();
    const close = why => { clearTimeout(timer); el.remove(); if (why) note(s, why); };
    const timer = setTimeout(() => close("stop not confirmed"), 8000);
    // act on the touch itself (no waiting for the finger to lift), but never on the touch that opened this
    const on = (b, fn) => {
      const go = e => {
        e.preventDefault(); e.stopPropagation(); if (performance.now() - opened < 350) return;
        if (e.type === "pointerdown") swallowClick();
        fn();
      };
      b.addEventListener("pointerdown", go);
      b.addEventListener("click", e => { if (!e.pointerType) go(e); });           // keyboard (a click made by a touch or a mouse names it)
    };
    on($("#askyes"), () => { close(); endDrive("stopped by the driver"); });
    on($("#askno"), () => close("carried on"));
  }
  /* The screen changes while the finger is still down, so when it lifts, its "click" would land on whatever
     is now underneath (a button of the next page). Swallow that one click. */
  function swallowClick() {
    const eat = c => { c.preventDefault(); c.stopImmediatePropagation(); done(); };
    const done = () => { window.removeEventListener("click", eat, true); clearTimeout(limit); };
    const off = () => setTimeout(done, 120);
    const limit = setTimeout(done, 4000);
    window.addEventListener("click", eat, true);
    window.addEventListener("pointerup", off, { once: true, capture: true }); window.addEventListener("pointercancel", off, { once: true, capture: true });
  }
  function onBack() {
    // the phone's back button or back swipe: never leaves a running session, it asks like the Stop button
    if (!cur || cur.ending) return;
    try { history.pushState({ drive: 1 }, ""); } catch (e) { /* fine */ }
    askStop("back button");
  }
  function onVisibility() {
    const s = cur; if (!s || s.ending) return;
    if (document.visibilityState === "hidden") { s.hiddenAt = performance.now(); note(s, "app went to the background"); if (!s.sim) persist(s, false).catch(() => {}); }
    else { note(s, "app came back after " + (s.hiddenAt ? ((performance.now() - s.hiddenAt) / 1000).toFixed(0) : "?") + " s"); holdScreen(); }
  }
  function onPageHide() { const s = cur; if (s && !s.sim && !s.ending) { note(s, "app closed while recording"); persist(s, false).catch(() => {}); } }

  async function startDrive(sim) {
    if (cur || starting) return;                 // a second tap on "Start" must not start a second session
    starting = true;
    try {
      const s = cur = newSession(settings.source);
      s.t0 = performance.now();
      if (sim) {
        const d = window.KartSim.session({ laps: 9, seed: 1 + Math.floor(Math.random() * 90) });
        s.sim = { d, i: 0, speed: sim.speed, t0: performance.now() }; s.track = "Simulated drive"; s.demo = true; s.source = "auto";
      } else {
        window.addEventListener("devicemotion", onMotion);
        startAudio();
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* optional */ }
      }
      refresh = buildDash(app, settings.dash, {});
      ticks = 0;
      const dash = $("#dash"), stop = $("#stop");
      dash.addEventListener("contextmenu", e => e.preventDefault());                // no long-press menu
      dash.addEventListener("pointerdown", e => {
        if (e.target.closest("#stop, #ask") || $("#ask") || !cur || cur.sim) return;
        // a tap anywhere marks the line. Time of the touch itself, not of its handling.
        const now = performance.now(), ts = e.timeStamp > 0 && Math.abs(e.timeStamp - now) < 2000 ? e.timeStamp : now, t = (ts - cur.t0) / 1000;
        if (cur.marks.length && t - cur.marks[cur.marks.length - 1] < 2) return;    // a second touch straight after is the same tap
        cur.marks.push(t);
        const m = $("#tapmark"); m.classList.remove("on"); void m.offsetWidth; m.classList.add("on");
      });
      dash.addEventListener("pointerup", () => { if (cur && !cur.sim && !document.fullscreenElement) goFullscreen(); });   // fullscreen was lost: take it back
      stop.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); askStop("stop button"); });
      stop.addEventListener("click", e => { if (!e.pointerType) askStop("stop button"); });
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("popstate", onBack);
      try { history.pushState({ drive: 1 }, ""); } catch (e) { /* fine */ }
      s.loop = setInterval(tick, 100);
      s.autosave = setInterval(() => { if (cur === s && !s.sim && !s.ending) persist(s, false).catch(() => {}); }, 15000);
      note(s, sim ? "simulated drive" : "session started");
      holdScreen();
      goFullscreen();
    } finally { starting = false; }
  }

  function tick() {
    const s = cur; if (!s || s.ending || !$("#dash")) return;
    if (s.sim) {                                   // feed the simulated kart, faster than real time
      const d = s.sim.d, until = (performance.now() - s.sim.t0) / 1000 * s.sim.speed;
      while (s.sim.i < d.t.length && d.t[s.sim.i] <= until) {
        const i = s.sim.i++;
        sample(d.t[i], [d.lonG[i] * G0, d.latG[i] * G0, 0], [d.lonG[i] * G0, d.latG[i] * G0, G0], [0, 0, d.yaw[i]]);
      }
      if (s.sim.i >= d.t.length) { endDrive("simulation finished"); return; }
    } else {
      s.t = (performance.now() - s.t0) / 1000;
      if (s.t > MAX_SESSION_S) { endDrive("stopped after 90 minutes"); return; }
    }
    ticks++;
    let m = null;
    try {
      if (ticks % 5 === 0 && s.source === "auto") { const was = s.det.relearned || 0; s.det.update(); if ((s.det.relearned || 0) !== was) note(s, "lap learnt again"); }
      m = model(s);
      if (s.source === "auto" && !s.found && s.det.state() !== "learning") { s.found = true; note(s, "lap found: " + (s.det.period / K.FS).toFixed(1) + " s, by " + s.det.method); }
    } catch (e) {
      // the timing failed on this data; the recording is separate and carries on
      s.errs++; s.errAt = s.t; if (s.errs <= 5) note(s, "timing error: " + (e && e.message));
      const pass = null;
      m = { t: s.t, laps: [], last: null, prev: null, best: null, timing: false, lapClock: pass, delta: null, pred: null, lapN: 0, gS: s.gS, gLapMax: s.gLapMax,
            left: settings.minutes > 0 ? Math.max(0, settings.minutes * 60 - s.t) : null, source: s.source, standIn: false, state: "error" };
    }
    if (m.laps.length !== s.lastLapN) {
      s.lastLapN = m.laps.length; s.gLapMax = s.gS;
      $$('[data-tile="last"]').forEach(c => { c.classList.remove("flash"); void c.offsetWidth; c.classList.add("flash"); });
    }
    if (m.state === "learning") m.learn = Math.min(0.97, Math.abs(s.det.y.reduce((a, b) => a + b, 0)) / K.FS / 360 / 2.4);
    const live = !s.sim;
    if (m.state === "error" || (s.errAt !== undefined && s.t - s.errAt < 5)) m.status = "Lap timing hit a problem. Still recording.";
    else if (live && s.t > 3 && s.events === 0) m.status = "No motion data from this phone";
    else if (live && s.events > 0 && s.t - (s.tS || 0) > 2) m.status = "Motion data has stopped";
    else if (live && s.t > 3 && !s.hasGyro && s.source === "auto") m.status = "No turn sensor: tap at the line";
    else if (live && s.t > 2 && s.t < 25 && s.wake !== "held") m.status = "Screen may switch off: battery saver?";
    else if (m.standIn) m.status = "Timing from your taps while the track is learnt";
    else if (m.state === "learning") m.status = s.t < 20 ? "Lap times appear after 2 to 3 laps" : s.t < 150 ? "Finding the lap. Tap at the line for times now" : "Lap not found yet. Tap at the line for times";
    else if (m.state === "taps" && !s.marks.length) m.status = "Tap anywhere as you cross the line";
    else m.status = (m.source === "taps" ? "Laps by your taps" : "Automatic laps") + "  ·  " + clock(s.t);
    try { refresh(m); } catch (e) { s.errs++; if (s.errs <= 5) note(s, "screen error: " + (e && e.message)); }
  }

  function summary(s, laps, source) {
    const ok = laps.filter(l => !l.interrupted), best = ok.length ? Math.min(...ok.map(l => l.time)) : null;
    return { id: s.id, track: s.track, started: s.started, duration: s.t, source, nLaps: laps.length, best, demo: !!s.demo, version: VERSION,
             times: laps.map(l => l.interrupted ? null : +l.time.toFixed(3)),
             sensors: { events: s.events, rate: s.t > 0 ? s.events / s.t : 0, gyro: s.hasGyro, linear: s.hasLin, mic: s.audio.t.length > 0, micDenied: !!s.audio.denied,
                        gaps: s.gaps, gapTime: +s.gapTime.toFixed(1), screen: s.wake, errors: s.errs },
             log: s.log.slice() };
  }
  /* Write the session to the phone. Called every 15 s while driving, when the app is hidden or closed,
     and at the end. Never throws; the answer says whether the phone's storage took it. */
  async function persist(s, final) {
    let auto = [], taps = [];
    if (final) { try { s.det.update(true); } catch (e) { s.errs++; note(s, "timing error at the end: " + (e && e.message)); } }
    try { auto = s.det.laps(); } catch (e) { auto = []; }
    try { taps = K.lapsFromMarks(s.marks); } catch (e) { taps = []; }
    // the automatic timing found nothing but the driver tapped: the taps are the lap times
    const fallback = s.source === "auto" && auto.length < 1 && taps.length >= 1, source = s.source === "taps" || fallback ? "taps" : "auto", laps = source === "taps" ? taps : auto;
    const meta = summary(s, laps, source);
    meta.fallback = fallback; meta.open = !final;                         // open: the session was not stopped (the app was closed, or it is still running)
    try { meta.detector = { state: s.det.state(), lapLength: s.det.period ? s.det.period / K.FS : null, method: s.det.method, quality: s.det.quality, relearned: s.det.relearned || 0 }; } catch (e) { meta.detector = { state: "error" }; }
    const ab = new Uint8Array(s.audio.bins.length * NB); s.audio.bins.forEach((row, i) => ab.set(row, i * NB));
    const data = { id: s.id, rec: s.rec.data(), nc: COLS.length, y20: Float32Array.from(s.det.y), marks: s.marks.slice(), autoLaps: auto, tapLaps: taps,
                   audioT: Float32Array.from(s.audio.t), audioBins: ab, nb: NB };
    // the measurements first: a session listed without its data would be worse than one not listed
    let ok = await Store.put("data", data);
    if (!ok && ab.length) ok = await Store.put("data", Object.assign({}, data, { audioT: new Float32Array(0), audioBins: new Uint8Array(0) }));   // short of space: drop the sound picture, keep the rest
    meta.stored = ok && await Store.put("sessions", meta);
    if (!meta.stored) mem.sessions.set(meta.id, meta);
    return meta;
  }
  async function endDrive(why) {
    const s = cur; if (!s || s.ending) return;
    s.ending = true; note(s, why || "stopped");
    clearInterval(s.loop); clearInterval(s.autosave);
    window.removeEventListener("devicemotion", onMotion); document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide); window.removeEventListener("popstate", onBack);
    stopAudio(s);
    try { wake && wake.release(); } catch (e) { /* released */ } wake = null;
    app.innerHTML = `<div class="page"><p class="sub" style="margin-top:40px">Saving the session…</p></div>`;
    let meta = null;
    try { meta = await persist(s, true); }
    catch (e) { meta = { id: s.id, track: s.track, started: s.started, duration: s.t, source: s.source, nLaps: 0, best: null, times: [], stored: false, version: VERSION, log: s.log.slice(), failed: String(e && e.message) }; mem.sessions.set(meta.id, meta); }
    cur = null;
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) { /* optional */ }
    try { if (history.state && history.state.drive) history.back(); } catch (e) { /* fine */ }
    viewSaved(meta);
  }

  /* The session is saved. Straight into the next one, or look at it. */
  function viewSaved(meta) {
    app.innerHTML = `<div class="page">
      <div class="top"><div class="mark">${MARK}Apex Trace Kart</div></div>
      <h1>${meta.stored ? "Session saved" : "Session not stored yet"}</h1>
      <p class="sub">${esc(meta.track)}, ${clock(meta.duration)} on track${meta.demo ? " (simulated)" : ""}.</p>
      ${meta.stored ? "" : `<div class="note bad">The phone's storage did not take this session (full, or blocked in private browsing). It is still held in memory: tap <b>Save data file</b> now, before closing the app.</div>`}
      <div class="kpis"><div class="kpi"><div class="k">Best lap</div><div class="v c-best">${lapTime(meta.best)}</div></div><div class="kpi"><div class="k">Laps timed</div><div class="v">${meta.nLaps}</div></div></div>
      ${meta.fallback ? `<p class="small" style="margin-top:10px">The automatic timing did not find the lap in this session, so these are the laps from your taps.</p>` : ""}
      ${!meta.nLaps && !meta.demo ? `<p class="small" style="margin-top:10px">No lap was timed. The recording itself is kept: open the session and save the data file.</p>` : ""}
      <button class="go" id="again" type="button" style="margin-top:18px">Start a new session</button>
      <div class="row" style="margin-top:12px"><button class="btn" id="see" type="button">See this session</button><button class="btn" id="savefile" type="button">Save data file</button><button class="btn" id="home" type="button">All sessions</button></div>
      <p class="small" style="margin-top:14px">The new session uses the same track name, lap timing and dashboard. Each session is kept separately on this phone.</p></div>`;
    const shown = performance.now(), ready = () => performance.now() - shown > 500;      // not the press that stopped the session
    $("#again").addEventListener("click", () => { if (ready()) startDrive(null); });
    $("#see").addEventListener("click", () => { if (ready()) viewReview(meta.id); });
    $("#savefile").addEventListener("click", async () => { if (!ready()) return; const data = await Store.get("data", meta.id); if (!data) { toast("The recording of this session is not available."); return; } saveDataFile(meta, data); });
    $("#home").addEventListener("click", () => { if (ready()) viewHome(); });
  }

  /* A finished simulated session, to show what a review looks like before the first real one. */
  async function makeDemo() {
    app.innerHTML = `<div class="page"><p class="sub" style="margin-top:40px">Building the demo session…</p></div>`;
    await new Promise(r => setTimeout(r, 30));
    const d = window.KartSim.session({ laps: 13, seed: 21 }), s = newSession("auto");
    cur = s; s.track = "Demo track (simulated)"; s.demo = true;
    try { for (let i = 0; i < d.t.length; i++) { sample(d.t[i], [d.lonG[i] * G0, d.latG[i] * G0, 0], [d.lonG[i] * G0, d.latG[i] * G0, G0], [0, 0, d.yaw[i]]); if (i % 60 === 0) s.det.update(); } }
    finally { cur = null; }
    const meta = await persist(s, true);
    viewReview(meta.id);
  }

  /* One motion sample. a: acceleration without gravity (may be null), g: with gravity, r: rotation rate
     about the phone's x, y, z in deg/s. All in the phone's own axes (x to the right of the screen, y to its
     top, z out of it). */
  function sample(t, a, g, r) {
    const s = cur; if (!s) return;
    let grav, lin;
    if (a) { grav = [g[0] - a[0], g[1] - a[1], g[2] - a[2]]; lin = a; s.hasLin = true; }
    else {
      // no gravity-free reading from the phone: take gravity as the slow part of the signal
      const k = s.gf ? Math.min(1, Math.max(0, t - (s.tS || 0)) / 1.2) : 1;
      s.gf = s.gf ? [s.gf[0] + k * (g[0] - s.gf[0]), s.gf[1] + k * (g[1] - s.gf[1]), s.gf[2] + k * (g[2] - s.gf[2])] : g.slice();
      grav = s.gf; lin = [g[0] - grav[0], g[1] - grav[1], g[2] - grav[2]];
    }
    const gn = Math.hypot(grav[0], grav[1], grav[2]) || 1, up = [grav[0] / gn, grav[1] / gn, grav[2] / gn];
    const w = r || [0, 0, 0]; if (r) s.hasGyro = true;
    // how fast the kart turns: the phone's rotation about the vertical, with the phone's own turning
    // with the steering wheel taken out (see turnRate in core.js)
    const yaw = K.turnRate ? K.turnRate(w, up) : w[0] * up[0] + w[1] * up[1] + w[2] * up[2];
    const v = lin[0] * up[0] + lin[1] * up[1] + lin[2] * up[2], h = [lin[0] - v * up[0], lin[1] - v * up[1], lin[2] - v * up[2]];
    const gH = Math.hypot(h[0], h[1], h[2]) / G0;
    // the phone turns with the wheel: the direction of "down" across the screen gives the wheel angle (rough)
    const steer = Math.atan2(up[0], up[1]) * 180 / Math.PI;
    const since = t - (s.tS || 0);
    if (s.events > 0 && since > 0.5) { s.gaps++; s.gapTime += since; note(s, "no motion data for " + since.toFixed(1) + " s"); }
    const dt = Math.max(0, Math.min(0.2, since)); s.tS = t; s.t = t; s.events++;
    s.gS += (gH - s.gS) * Math.min(1, dt / 0.25);                     // what the eye can follow
    if (s.gS > s.gLapMax) s.gLapMax = s.gS;
    if (s.gS > s.gMax) s.gMax = s.gS;
    s.rec.push([t, lin[0], lin[1], lin[2], g[0], g[1], g[2], w[0], w[1], w[2], yaw, gH, steer]);   // the recording first: it must survive anything below
    try { s.det.push(t, yaw); } catch (e) { s.errs++; }
  }

  function onMotion(e) {
    if (!cur || cur.sim || cur.ending) return;
    const g = e.accelerationIncludingGravity, a = e.acceleration, r = e.rotationRate;
    if (!g || g.x === null || g.x === undefined) return;
    const t = (performance.now() - cur.t0) / 1000;
    sample(t, a && a.x !== null && a.x !== undefined ? [a.x, a.y, a.z] : null, [g.x, g.y, g.z],
           r && r.alpha !== null && r.alpha !== undefined ? [r.alpha || 0, r.beta || 0, r.gamma || 0] : null);     // alpha, beta, gamma = about the phone's x, y, z
  }

  /* Engine sound: a compact picture of the sound spectrum ten times a second (not a recording of voices).
     Kept for later work on engine speed; nothing in this version depends on it. */
  const NB = 48, F_LO = 40, F_HI = 3000;
  async function startAudio() {
    const s = cur;
    if (!s || !settings.mic || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (cur !== s || s.ending) { stream.getTracks().forEach(t => t.stop()); return; }      // the session ended while the phone was asking for permission
      const AC = window.AudioContext || window.webkitAudioContext, ctx = new AC(), src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
      if (ctx.state === "suspended" && ctx.resume) ctx.resume().catch(() => {});
      an.fftSize = 4096; an.smoothingTimeConstant = 0.2; src.connect(an);
      const bins = new Uint8Array(an.frequencyBinCount), hz = ctx.sampleRate / an.fftSize, edges = [];
      for (let i = 0; i <= NB; i++) edges.push(Math.round(F_LO * Math.pow(F_HI / F_LO, i / NB) / hz));
      s.audio.stream = stream; s.audio.ctx = ctx;
      s.audio.timer = setInterval(() => {
        if (cur !== s || s.audio.t.length > 60000) return;
        try {
          an.getByteFrequencyData(bins);
          const row = new Uint8Array(NB);
          for (let i = 0; i < NB; i++) { let m = 0; for (let j = edges[i]; j <= Math.max(edges[i], edges[i + 1] - 1) && j < bins.length; j++) if (bins[j] > m) m = bins[j]; row[i] = m; }
          s.audio.t.push(s.t); s.audio.bins.push(row);
        } catch (e) { /* the sound picture is optional */ }
      }, 100);
    } catch (e) { s.audio.denied = true; note(s, "microphone not available (" + (e && e.name) + ")"); }
  }
  function stopAudio(s) { try { clearInterval(s.audio.timer); s.audio.stream && s.audio.stream.getTracks().forEach(t => t.stop()); s.audio.ctx && s.audio.ctx.close(); } catch (e) { /* already closed */ } }

  /* ------------------------------------------------------------------ home */
  function spark(times) {
    const v = (times || []).filter(x => x !== null); if (v.length < 2) return "";
    const mn = Math.min(...v), mx = Math.max(...v), W = 70, H = 22, sp = (mx - mn) || 1;
    const pts = v.map((x, i) => `${(2 + (W - 4) * i / (v.length - 1)).toFixed(1)},${(2 + (H - 4) * (x - mn) / sp).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${css("--ink-3")}" stroke-width="1.5"/></svg>`;
  }
  async function viewHome() {
    if (cur && !cur.ending && $("#dash")) return;   // never leave a running session by accident
    cur = null;
    const sessions = await Store.all();
    const fname = k => FIELDS[k].name.replace(/, live$/, "").toLowerCase();
    app.innerHTML = `<div class="page">
      <div class="top"><div class="mark">${MARK}Apex Trace Kart <small>${VERSION}</small></div></div>
      <div class="card">
        <div class="field" style="margin-top:0"><label for="track">Track</label><input type="text" id="track" value="${esc(settings.track)}" placeholder="Name of the track" autocomplete="off" maxlength="40"></div>
        <div class="lbl" style="margin-bottom:6px">Lap timing</div>
        <div class="seg2" role="group" aria-label="Lap timing"><button type="button" data-src="auto" aria-pressed="${settings.source === "auto"}">Automatic</button><button type="button" data-src="taps" aria-pressed="${settings.source === "taps"}">My taps at the line</button></div>
        <p class="small" id="srcnote" style="margin:8px 0 14px"></p>
        <button class="go" id="start" type="button">Start session</button>
      </div>
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        <div style="min-width:0"><b>Dashboard</b><div class="small">Big: ${esc(fname(settings.dash.main))}. Tiles: ${settings.dash.tiles.length ? esc(settings.dash.tiles.map(fname).join(", ")) : "none"}.</div></div>
        <button class="btn" id="setup" type="button">Set up</button>
      </div>
      <div class="row" style="margin-top:14px"><button class="btn" id="simdrive" type="button">Watch a simulated drive</button><button class="btn" id="demo" type="button">Open a demo session</button><button class="btn" id="check" type="button">Check this phone</button></div>
      <h2>Sessions</h2>
      ${sessions.length ? `<ul class="sessions">${sessions.map(s => `<li><button type="button" data-open="${esc(s.id)}"><span class="t">${esc(s.track)}</span>
        <span class="b"><b>${lapTime(s.best)}</b><span>best of ${s.nLaps} lap${s.nLaps === 1 ? "" : "s"}</span></span>
        <span class="d">${new Date(s.started).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${s.demo ? ", simulated" : ""}${s.open ? ", <b>not stopped: kept as far as it got</b>" : ""} &nbsp;${spark(s.times)}</span></button></li>`).join("")}</ul>`
        : `<p class="sub">No session yet. Every session you drive is kept on this phone and listed here.</p>`}
      <p class="small" id="offline" style="margin-top:26px"></p>
    </div>`;
    const note = () => { $("#srcnote").textContent = settings.source === "auto" ? "Laps are found from the way the kart turns. Lap times appear after 2 to 3 laps and include the laps already driven. If you also tap the screen at the line, you get times from the first lap, and your taps are kept as a second set of lap times." : "Tap anywhere on the screen each time you cross the line."; };
    note();
    $("#track").addEventListener("input", e => { settings.track = e.target.value; saveSettings(); });
    $$("[data-src]").forEach(b => b.addEventListener("click", () => { settings.source = b.dataset.src; saveSettings(); $$("[data-src]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); note(); }));
    $("#start").addEventListener("click", () => startDrive(null));
    $("#simdrive").addEventListener("click", () => startDrive({ speed: 12 }));
    $("#setup").addEventListener("click", viewSetup);
    $("#check").addEventListener("click", viewCheck);
    $("#demo").addEventListener("click", makeDemo);
    $$("[data-open]").forEach(b => b.addEventListener("click", () => viewReview(b.dataset.open)));
    offlineLine();
  }
  function offlineLine() {
    const el = $("#offline"); if (!el) return;
    const sw = "serviceWorker" in navigator && navigator.serviceWorker.controller;
    el.textContent = sw ? "Ready to work without a connection. Add it to your home screen from the browser menu to open it like an app."
                        : "Open this page once with a connection and reload it; after that it works without one.";
  }

  /* ------------------------------------------------------------------ dashboard set-up */
  const PREVIEW = (() => {      // a believable moment of a session, for the preview
    const laps = [32.61, 32.18, 31.92, 32.07, 31.84, 32.02].map((t, i) => ({ n: i + 1, time: t, interrupted: false }));
    return { t: 252, laps, last: laps[5], prev: laps[4], best: laps[4], timing: true, lapClock: 17.4, delta: -0.12, pred: 31.72, lapN: 7, gS: 1.1, gLapMax: 1.6, left: 348, source: "auto", state: "timing" };
  })();
  function viewSetup() {
    const d = settings.dash, opt = (sel, none) => (none ? `<option value="">Nothing</option>` : "") + FIELD_KEYS.map(k => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(FIELDS[k].name)}</option>`).join("");
    app.innerHTML = `<div class="page">
      <div class="top"><button class="linkbtn" id="back" type="button">&larr; Back</button></div>
      <h1>Your dashboard</h1>
      <p class="sub">Choose what the screen shows while you drive. The preview changes as you choose.</p>
      <div class="preview" id="preview"></div>
      <div class="field"><label for="main">Big display</label><select id="main">${opt(d.main)}</select></div>
      <div class="lbl" style="margin:14px 0 6px">Tiles (up to six)</div>
      <div class="slots">${[0, 1, 2, 3, 4, 5].map(i => `<select data-slot="${i}" aria-label="Tile ${i + 1}">${opt(d.tiles[i] || "", true)}</select>`).join("")}</div>
      <label class="switch" style="margin-top:14px"><input type="checkbox" id="dbar" ${d.deltaBar ? "checked" : ""}><span>Bar across the top: green grows to the left when you are ahead of your best lap, red to the right when behind</span></label>
      <label class="switch"><input type="checkbox" id="gbar" ${d.gBar ? "checked" : ""}><span>Force bar along the bottom</span></label>
      <div class="field"><label for="minutes">Session length in minutes, for “Time left” (0 = not used)</label><input type="number" id="minutes" min="0" max="120" step="1" value="${settings.minutes || 0}" inputmode="numeric"></div>
      <label class="switch"><input type="checkbox" id="mic" ${settings.mic ? "checked" : ""}><span>Log engine sound<br><span class="small">A picture of the sound's pitch ten times a second, not a recording. Kept for future work on engine speed.</span></span></label>
      <div class="row" style="margin-top:10px"><button class="btn" id="reset" type="button">Back to the standard dashboard</button></div>
      <div class="note">The live “plus or minus to best lap” needs one complete lap to compare with, so it starts once laps are being timed. It moves in the corners and holds on the straights, because it follows how the kart turns.</div></div>`;
    const draw = () => buildDash($("#preview"), settings.dash, { preview: true })(PREVIEW);
    const read = () => {
      settings.dash.main = $("#main").value; settings.dash.tiles = $$("[data-slot]").map(s => s.value).filter(Boolean);
      settings.dash.deltaBar = $("#dbar").checked; settings.dash.gBar = $("#gbar").checked;
      settings.minutes = Math.max(0, Math.min(120, Number($("#minutes").value) || 0)); settings.mic = $("#mic").checked;
      saveSettings(); draw();
    };
    $$("select, input", app).forEach(e => e.addEventListener("change", read));
    $("#reset").addEventListener("click", () => { settings.dash = JSON.parse(JSON.stringify(DEFAULT_DASH)); saveSettings(); viewSetup(); });
    $("#back").addEventListener("click", viewHome);
    draw();
  }

  /* ------------------------------------------------------------------ check this phone */
  function viewCheck() {
    app.innerHTML = `<div class="page"><div class="top"><button class="linkbtn" id="back" type="button">&larr; Back</button></div>
      <h1>Check this phone</h1>
      <p class="sub">Each line turns green when that sensor answers. Then try the two-step test under the list.</p>
      <ul class="checks" id="checks"></ul>
      <div class="kpis" style="margin-top:14px"><div class="kpi"><div class="k">Turned so far</div><div class="v"><span id="chead">0</span>°</div><div class="s">turn rate now <span id="cyaw">0</span> deg/s</div></div><div class="kpi"><div class="k">Force now</div><div class="v" id="cg">0.00</div><div class="s">G</div></div></div>
      <button class="btn" id="czero" type="button" style="margin-top:10px">Set “turned so far” to zero</button>
      <div class="note"><b>Test 1.</b> Hold the phone upright, screen facing you, as it will sit on the wheel. Set to zero, then turn yourself once round on the spot. “Turned so far” should end near 360 (or −360, turning right).<br>
        <b>Test 2.</b> Set to zero. Without turning yourself, rotate the phone left and right like a steering wheel. “Turned so far” should stay near 0: the wheel's own movement is not counted as the kart turning.</div>
      <div class="note">Before a session: switch off the screen's auto-rotate, switch off battery saver, switch on Do Not Disturb, raise the brightness. The screen stays on by itself while a session runs.</div></div>`;
    const st = { n: 0, lin: false, gyro: false, t0: performance.now(), yaw: 0, g: 0, wake: "", head: 0, last: 0 };
    (async () => { if (!("wakeLock" in navigator)) { st.wake = "none"; return; } try { const w = await navigator.wakeLock.request("screen"); st.wake = "ok"; setTimeout(() => { try { w.release(); } catch (e) { /* gone */ } }, 1500); } catch (e) { st.wake = "refused"; } })();
    const h = e => {
      const g = e.accelerationIncludingGravity, a = e.acceleration, r = e.rotationRate; if (!g || g.x === null) return;
      st.n++; if (a && a.x !== null && a.x !== undefined) st.lin = true; if (r && r.alpha !== null && r.alpha !== undefined) st.gyro = true;
      if (st.lin && st.gyro) {
        const gr = [g.x - a.x, g.y - a.y, g.z - a.z], n = Math.hypot(...gr) || 1, up = gr.map(x => x / n), w = [r.alpha || 0, r.beta || 0, r.gamma || 0];
        st.yaw = K.turnRate(w, up);
        const now = performance.now(); if (st.last && now - st.last < 500) st.head += st.yaw * (now - st.last) / 1000; st.last = now;
        const v = a.x * up[0] + a.y * up[1] + a.z * up[2]; st.g = Math.hypot(a.x - v * up[0], a.y - v * up[1], a.z - v * up[2]) / G0;
      }
    };
    window.addEventListener("devicemotion", h);
    const li = (state, title, text) => `<li><i class="dot ${state}"></i><div><b>${title}</b><span>${text}</span></div></li>`;
    const draw = async () => {
      if (!$("#checks")) { window.removeEventListener("devicemotion", h); clearInterval(timer); return; }
      const rate = st.n / Math.max(0.5, (performance.now() - st.t0) / 1000);
      let persisted = false; try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) { /* unknown */ }
      $("#checks").innerHTML =
        li(st.n ? "ok" : "bad", "Motion sensor", st.n ? `Answering ${rate.toFixed(0)} times a second.` : "No answer. This browser or device gives no motion data; lap timing cannot work here.") +
        li(st.gyro ? "ok" : (st.n ? "bad" : ""), "Turn sensor (gyroscope)", st.gyro ? "Present. This is what times your laps and drives the live figure." : "Not found. Without it laps can only be timed by tapping the screen.") +
        li(st.lin ? "ok" : (st.n ? "warn" : ""), "Gravity removed by the phone", st.lin ? "Yes: force readings use the phone's own gravity estimate." : "No: the app estimates gravity itself, force readings are rougher.") +
        li(st.wake === "ok" ? "ok" : (st.wake === "" ? "" : "warn"), "Keeps the screen on", st.wake === "ok" ? "Yes." : st.wake === "" ? "Checking…" : st.wake === "refused" ? "The phone refused. Switch off battery saver, and set the screen timeout to the longest setting before a session." : "Not supported here: set the screen timeout to the longest setting before a session.") +
        li(navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? "ok" : "warn", "Microphone", navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? "Available. You are asked for permission at the first session." : "Not available in this browser; engine sound is skipped.") +
        li(navigator.serviceWorker && navigator.serviceWorker.controller ? "ok" : "warn", "Works without a connection", navigator.serviceWorker && navigator.serviceWorker.controller ? "Yes." : "Not yet: reload this page once while connected.") +
        li(persisted ? "ok" : "warn", "Sessions protected from clean-up", persisted ? "Yes." : "The browser may clear saved sessions if the phone runs short of space. Save the data file of sessions you care about.");
      $("#cyaw").textContent = st.yaw.toFixed(0); $("#cg").textContent = st.g.toFixed(2); $("#chead").textContent = st.head.toFixed(0);
    };
    const timer = setInterval(draw, 500); draw();
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* optional */ }
    $("#back").addEventListener("click", () => { window.removeEventListener("devicemotion", h); clearInterval(timer); viewHome(); });
    $("#czero").addEventListener("click", () => { st.head = 0; $("#chead").textContent = "0"; });
  }

  /* ------------------------------------------------------------------ charts */
  function canvas(cv, h) {
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth; cv.style.height = h + "px";
    cv.width = Math.round(W * dpr); cv.height = Math.round(h * dpr);
    const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, h);
    c.font = "12px " + css("--font-text"); c.textBaseline = "middle";
    return { c, W, H: h };
  }
  function ticksFor(lo, hi, n) {
    const span = hi - lo, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw, out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  /* Lap times through the session: a line with a point per lap. Tap a point to look at that lap. */
  function lapChart(cv, tip, laps, bestI, sel, onSel) {
    const { c, W, H } = canvas(cv, 200), padL = 46, padR = 14, padT = 16, padB = 26, w = W - padL - padR, h = H - padT - padB;
    const times = laps.map(l => l.time), mn = Math.min(...times), mx = Math.max(...times), sp = Math.max(0.2, mx - mn), lo = mn - 0.12 * sp, hi = mx + 0.15 * sp;
    const X = i => padL + (laps.length === 1 ? w / 2 : w * i / (laps.length - 1)), Y = v => padT + h * (1 - (v - lo) / (hi - lo));
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    c.strokeStyle = css("--line"); c.lineWidth = 1; c.fillStyle = css("--ink-3"); c.textAlign = "right";
    ticksFor(lo, hi, 4).forEach(v => { c.beginPath(); c.moveTo(padL, Y(v)); c.lineTo(W - padR, Y(v)); c.stroke(); c.fillText(lapTime(v), padL - 8, Y(v)); });
    c.textAlign = "center"; const every = Math.ceil(laps.length / 10);
    laps.forEach((l, i) => { if (i % every === 0 || i === laps.length - 1) c.fillText(String(l.n), X(i), H - 10); });
    c.setLineDash([5, 4]); c.strokeStyle = css("--ink-3"); c.beginPath(); c.moveTo(padL, Y(mean)); c.lineTo(W - padR, Y(mean)); c.stroke(); c.setLineDash([]);
    c.strokeStyle = css("--ink-2"); c.lineWidth = 2; c.lineJoin = "round"; c.beginPath(); laps.forEach((l, i) => { if (i) c.lineTo(X(i), Y(l.time)); else c.moveTo(X(i), Y(l.time)); }); c.stroke();
    laps.forEach((l, i) => {
      const isBest = i === bestI, isSel = i === sel;
      c.beginPath(); c.arc(X(i), Y(l.time), isBest || isSel ? 6 : 4, 0, 6.3); c.fillStyle = isBest ? css("--best") : isSel ? css("--series-b") : css("--ink"); c.fill();
      c.lineWidth = 2; c.strokeStyle = css("--panel"); c.stroke();
    });
    c.fillStyle = css("--best"); c.textAlign = X(bestI) > W - 90 ? "right" : "left"; c.fillText("best " + lapTime(laps[bestI].time), X(bestI) + (c.textAlign === "left" ? 10 : -10), Y(laps[bestI].time) + 12);
    cv.onpointerdown = e => {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left; let k = 0, bd = 1e9;
      laps.forEach((l, i) => { const d = Math.abs(X(i) - x); if (d < bd) { bd = d; k = i; } });
      onSel(k);
    };
  }

  /* One lap against another, along the lap. Top: time gained or lost so far. Bottom: how the kart turned.
     Both share the same horizontal axis (position on the lap), so they read together. Drag a finger across
     to read any point. */
  function compareChart(cv, tip, ct, laps, bestI, refI, sel, names) {
    const { c, W, H } = canvas(cv, 340), padL = 46, padR = 12, padT = 24, gap = 26, padB = 26, w = W - padL - padR;
    const hTop = Math.round((H - padT - padB - gap) * 0.52), hBot = H - padT - padB - gap - hTop, y0 = padT, y1 = padT + hTop + gap;
    const n = ct.ref.length, fs = ct.fs, mapS = ct.maps[sel].map, mapR = ct.maps[refI].map, sigS = ct.sigs[sel], sigR = ct.sigs[refI];
    const at = (sig, x) => { const i0 = Math.max(0, Math.min(sig.length - 2, Math.floor(x))), f = x - i0; return sig[i0] * (1 - f) + sig[i0 + 1] * f; };
    const delta = new Float32Array(n), a = new Float32Array(n), b = new Float32Array(n); let dmax = 0.1, ymax = 10;
    for (let i = 0; i < n; i++) { delta[i] = (mapS[i] - mapR[i]) / fs; a[i] = at(sigR, mapR[i]); b[i] = at(sigS, mapS[i]); dmax = Math.max(dmax, Math.abs(delta[i])); ymax = Math.max(ymax, Math.abs(a[i]), Math.abs(b[i])); }
    dmax *= 1.15; ymax *= 1.1;
    const X = i => padL + w * i / (n - 1), Yd = v => y0 + hTop / 2 - (hTop / 2) * v / dmax, Yt = v => y1 + hBot / 2 - (hBot / 2) * v / ymax;
    const draw = hover => {
      c.clearRect(0, 0, W, H);
      // corners: a faint band and a number each, shared by both panels
      c.textAlign = "center";
      ct.corners.forEach((k, j) => { if (j % 2 === 0) { c.fillStyle = "rgba(255,255,255,0.04)"; c.fillRect(X(k.i0), y0, X(k.i1) - X(k.i0), H - padB - y0); } c.fillStyle = css("--ink-3"); c.fillText(String(j + 1), X(k.apex), y0 - 11); });
      // top panel: time gained or lost so far
      c.strokeStyle = css("--line"); c.lineWidth = 1; c.fillStyle = css("--ink-3"); c.textAlign = "right";
      ticksFor(-dmax, dmax, 4).forEach(v => { c.beginPath(); c.moveTo(padL, Yd(v)); c.lineTo(W - padR, Yd(v)); c.stroke(); c.fillText((v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2), padL - 8, Yd(v)); });
      const area = (pos, col) => { c.beginPath(); c.moveTo(X(0), Yd(0)); for (let i = 0; i < n; i++) c.lineTo(X(i), Yd(pos ? Math.max(0, delta[i]) : Math.min(0, delta[i]))); c.lineTo(X(n - 1), Yd(0)); c.closePath(); c.fillStyle = col; c.fill(); };
      area(true, "rgba(240,70,60,0.32)"); area(false, "rgba(25,196,90,0.32)");
      c.strokeStyle = css("--ink-2"); c.beginPath(); c.moveTo(padL, Yd(0)); c.lineTo(W - padR, Yd(0)); c.stroke();
      c.strokeStyle = css("--ink"); c.lineWidth = 2; c.lineJoin = "round"; c.beginPath(); for (let i = 0; i < n; i++) { if (i) c.lineTo(X(i), Yd(delta[i])); else c.moveTo(X(i), Yd(delta[i])); } c.stroke();
      c.textAlign = "left"; c.fillStyle = css("--slower"); c.fillText("slower", padL + 6, y0 + 9); c.fillStyle = css("--faster"); c.fillText("faster", padL + 6, y0 + hTop - 9);
      c.textAlign = "right"; c.fillStyle = css("--ink"); c.fillText((delta[n - 1] >= 0 ? "+" : "−") + Math.abs(delta[n - 1]).toFixed(2) + " s at the line", W - padR - 4, Math.max(y0 + 9, Math.min(y0 + hTop - 9, Yd(delta[n - 1]) - 11)));
      // bottom panel: turn rate of both laps
      c.strokeStyle = css("--line"); c.lineWidth = 1; c.beginPath(); c.moveTo(padL, Yt(0)); c.lineTo(W - padR, Yt(0)); c.stroke();
      c.fillStyle = css("--ink-3"); c.textAlign = "right"; c.fillText("left", padL - 8, y1 + 8); c.fillText("right", padL - 8, y1 + hBot - 8);
      const line = (arr, col, lw) => { c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); for (let i = 0; i < n; i++) { if (i) c.lineTo(X(i), Yt(arr[i])); else c.moveTo(X(i), Yt(arr[i])); } c.stroke(); };
      line(a, css("--series-a"), 4); line(b, css("--series-b"), 2);
      c.fillStyle = css("--ink-3"); c.textAlign = "center"; [0, 0.25, 0.5, 0.75, 1].forEach(f => c.fillText((f * (n - 1) / fs).toFixed(0) + " s", padL + w * f, H - 10));
      if (hover !== null && hover !== undefined) {
        c.strokeStyle = css("--ink-2"); c.lineWidth = 1; c.beginPath(); c.moveTo(X(hover), y0); c.lineTo(X(hover), H - padB); c.stroke();
        [[Yd(delta[hover]), css("--ink")], [Yt(a[hover]), css("--series-a")], [Yt(b[hover]), css("--series-b")]].forEach(p => { c.beginPath(); c.arc(X(hover), p[0], 4.5, 0, 6.3); c.fillStyle = p[1]; c.fill(); c.lineWidth = 2; c.strokeStyle = css("--panel"); c.stroke(); });
      }
    };
    draw(null);
    const move = e => {
      const r = cv.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left - padL) / w * (n - 1))));
      draw(i);
      const k = ct.corners.findIndex(q => i >= q.i0 && i <= q.i1), d = delta[i];
      tip.hidden = false;
      tip.innerHTML = `${k >= 0 ? "Turn " + (k + 1) : "Lap"}, ${(i / fs).toFixed(1)} s in<br><b style="color:${d > 0.005 ? css("--slower") : d < -0.005 ? css("--faster") : css("--ink")}">${signedTxt(d)} s</b> so far<br>` +
        `<span style="color:${css("--series-a")}">●</span> ${esc(names.ref)} <b>${a[i].toFixed(0)}</b> deg/s<br><span style="color:${css("--series-b")}">●</span> ${esc(names.sel)} <b>${b[i].toFixed(0)}</b> deg/s`;
      const px = e.clientX - r.left; tip.style.left = Math.max(4, Math.min(r.width - 150, px + (px > r.width / 2 ? -150 : 14))) + "px"; tip.style.top = (cv.offsetTop + y0 + 4) + "px";
    };
    cv.onpointerdown = cv.onpointermove = move;
    cv.onpointerleave = () => { tip.hidden = true; draw(null); };
  }

  /* blue ramp, dark (little time lost) to light (a lot): one hue, so it reads as "more" */
  function ramp(t) {
    const stops = [[13, 54, 107], [28, 92, 171], [57, 135, 229], [134, 182, 239], [205, 226, 251]], x = Math.max(0, Math.min(1, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    return "rgb(" + stops[i].map((v, k) => Math.round(v + f * (stops[i + 1][k] - v))).join(",") + ")";
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function canShareFiles() { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(["x"], "x.csv", { type: "text/csv" })] })); } catch (e) { return false; } }
  function shareFile(name, text) {
    const file = new File([text], name, { type: "text/csv" });
    navigator.share({ files: [file], title: name }).catch(() => {});
  }
  function fileBase(meta) { return ((meta.track || "session").replace(/[^\w]+/g, "_") || "session") + "_" + new Date(meta.started).toISOString().slice(0, 16).replace(/[:T]/g, "-"); }
  function saveDataFile(meta, data) {
    try { download(fileBase(meta) + ".csv", csvOf(meta, data)); toast("Saved to the phone's Downloads folder."); }
    catch (e) { toast("The file could not be made (" + (e && e.message) + "). The session is still on the phone."); }
  }
  function csvOf(meta, data) {
    const nc = data.nc, rec = data.rec, n = rec.length / nc, out = [], sn = meta.sensors || {};
    out.push(`# Apex Trace Kart ${meta.version || VERSION}`, `# Track,${JSON.stringify(meta.track)}`, `# Started,${new Date(meta.started).toISOString()}`, `# Lap timing,${meta.source}`,
      `# Taps (s),${data.marks.map(x => x.toFixed(3)).join(" ")}`, `# Automatic lap starts (s),${(data.autoLaps || []).map(l => l.start.toFixed(3)).concat((data.autoLaps || []).slice(-1).map(l => l.end.toFixed(3))).join(" ")}`,
      `# Sensors,${(sn.rate || 0).toFixed(1)} per second; turn sensor ${sn.gyro ? "yes" : "no"}; gravity removed by phone ${sn.linear ? "yes" : "no"}; silences ${sn.gaps || 0} (${sn.gapTime || 0} s); screen lock ${sn.screen || "?"}; errors ${sn.errors || 0}; stopped properly ${meta.open ? "no" : "yes"}`,
      `# Phone,${JSON.stringify(navigator.userAgent)}`,
      ...(meta.log || []).map(l => `# Log,${l[0]},${JSON.stringify(l[1])}`),
      "# Columns: time s; acceleration without gravity m/s2 (phone axes x y z); acceleration with gravity m/s2; rotation rate deg/s about x y z; turn rate of the kart deg/s (rotation about the vertical, the wheel's own rotation removed); horizontal force G; wheel angle estimate deg",
      "time,acc_x,acc_y,acc_z,accg_x,accg_y,accg_z,rot_x,rot_y,rot_z,turn_rate,g_horizontal,wheel_angle");
    const d = [3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 3, 1];
    for (let i = 0; i < n; i++) { const r = []; for (let c = 0; c < nc; c++) r.push(rec[i * nc + c].toFixed(d[c])); out.push(r.join(",")); }
    return out.join("\n") + "\n";
  }
  /* ------------------------------------------------------------------ review */
  function pct(arr, q) { if (!arr.length) return 0; const b = Array.from(arr).sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; }
  function sensorText(meta) {
    const s = meta.sensors || {}, d = meta.detector || {};
    const parts = [`Motion data ${s.rate ? s.rate.toFixed(0) + " times a second" : "not received"}`, s.gyro ? "turn sensor present" : "no turn sensor",
                   s.mic ? "engine sound logged" : (s.micDenied ? "microphone not allowed" : "engine sound not logged")];
    if (d.lapLength) parts.push(`lap found from the ${d.method === "heading" ? "heading (one full turn per lap)" : "repeating turn pattern"}, about ${d.lapLength.toFixed(1)} s long`);
    return parts.join("; ") + ".";
  }

  const headHtml = meta => `<div class="top"><button class="linkbtn" id="back" type="button">&larr; Sessions</button><button class="btn primary" id="again" type="button">New session</button></div>
      <h1>${esc(meta.track)}</h1>
      <p class="sub">${new Date(meta.started).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}, ${clock(meta.duration)} on track${meta.demo ? ". Simulated data, not a real drive." : ""}${meta.open ? ". This session was not stopped: the app was closed or interrupted, and it is kept as far as it got." : ""}</p>`;
  const footHtml = meta => `<h2>Session data</h2><p class="sub">${sensorText(meta)}</p>
      <div class="row"><button class="btn" id="csv" type="button">Save data file</button><button class="btn" id="lapscsv" type="button">Save lap times</button>${canShareFiles() ? `<button class="btn" id="share" type="button">Send data file</button>` : ""}<button class="btn" id="rename" type="button">Rename track</button><button class="btn danger" id="del" type="button">Delete session</button></div>
      <div id="confirm"></div>`;

  /* The review of a session. If the detailed page cannot be built from this session's data, a plain page
     takes its place: the lap times and the files are always reachable. */
  async function viewReview(id, opts) {
    try { await reviewFull(id, opts); }
    catch (e) { try { await reviewPlain(id, opts, e); } catch (e2) { toast("This session could not be opened (" + (e2 && e2.message) + "). It is still on the phone."); viewHome(); } }
  }
  async function reviewPlain(id, opts, err) {
    const meta = await Store.get("sessions", id), data = await Store.get("data", id);
    if (!meta || !data) { toast("That session is no longer on this phone."); return viewHome(); }
    const source = (opts && opts.source) || meta.source, laps = (source === "taps" ? data.tapLaps : data.autoLaps) || [], ok = laps.filter(l => !l.interrupted), best = ok.length ? Math.min(...ok.map(l => l.time)) : null;
    app.innerHTML = `<div class="page">${headHtml(meta)}
      <div class="note">The detailed charts could not be drawn for this session. The lap times and the recording are safe: save the data file and send it.<br><span class="small">${esc(err && err.message)}</span></div>
      <div class="kpis"><div class="kpi"><div class="k">Best lap</div><div class="v c-best">${lapTime(best)}</div></div><div class="kpi"><div class="k">Laps timed</div><div class="v">${laps.length}</div></div></div>
      <table class="laps"><thead><tr><th>Lap</th><th>Time</th><th>to best</th></tr></thead><tbody>${laps.map(l => `<tr><td>Lap ${l.n}</td><td class="tm ${l.time === best ? "c-best" : ""}">${l.interrupted ? "interrupted" : lapTime(l.time)}</td><td>${l.interrupted || best === null ? "" : l.time === best ? "best" : signedTxt(l.time - best)}</td></tr>`).join("")}</tbody></table>
      ${footHtml(meta)}</div>`;
    wireFoot(meta, data, laps, source);
    window.scrollTo(0, 0);
  }
  async function reviewFull(id, opts) {
    opts = opts || {};
    const meta = await Store.get("sessions", id), data = await Store.get("data", id);
    if (!meta || !data) { toast("That session is no longer on this phone."); return viewHome(); }
    const source = opts.source || meta.source, laps = (source === "taps" ? data.tapLaps : data.autoLaps) || [], ok = laps.filter(l => !l.interrupted);
    const head = headHtml(meta), foot = footHtml(meta);
    if (ok.length < 2) {
      app.innerHTML = `<div class="page">${head}
        <div class="note">${laps.length < 1 ? (source === "taps" ? "Fewer than two taps were recorded, so there is no lap to show." :
          "The lap could not be found in the turn pattern of this session. That needs about three laps of steady driving; a very short session, or a track that crosses over itself, can defeat it.") :
          "Only one complete lap was timed, so there is nothing to compare yet."}${data.marks.length >= 2 && source !== "taps" ? " You tapped the screen during the session: you can use your taps instead." : ""}</div>
        ${laps.length ? `<div class="kpis"><div class="kpi"><div class="k">Lap time</div><div class="v">${lapTime(laps[0].time)}</div></div></div>` : ""}
        ${data.marks.length >= 2 && source !== "taps" ? `<button class="btn" id="usetaps" type="button">Use my taps</button>` : ""}${foot}</div>`;
      wireFoot(meta, data, laps, source);
      const ut = $("#usetaps"); if (ut) ut.addEventListener("click", () => viewReview(id, { source: "taps" }));
      return;
    }
    const bestI = ok.reduce((a, l, i) => l.time < ok[a].time ? i : a, 0), best = ok[bestI];
    const times = ok.map(l => l.time), mean = times.reduce((a, b) => a + b, 0) / times.length, sd = Math.sqrt(times.reduce((a, b) => a + (b - mean) * (b - mean), 0) / times.length);
    const ct = K.cornerTimes(data.y20, ok, bestI), nC = ct.corners.length, rows = ct.table.map(r => r || new Array(nC).fill(NaN));
    if (ct.maps.some(m => !m)) throw new Error("a lap could not be laid over the best lap");
    const cornerBest = []; for (let c = 0; c < nC; c++) cornerBest.push(Math.min(...rows.map(r => r[c]).filter(isFinite)));
    const ideal = cornerBest.reduce((a, b) => a + b, 0);
    let sel = opts.sel; if (sel === undefined) { sel = ok.length - 1; if (sel === bestI) sel = Math.max(0, sel - 1); }
    let refMode = opts.ref || "best"; if (refMode === "prev" && sel === 0) refMode = "best";
    const refI = refMode === "prev" ? sel - 1 : bestI, refName = refMode === "prev" ? `Lap ${ok[refI].n} (the lap before)` : `Lap ${best.n} (best)`, selName = `Lap ${ok[sel].n}`;
    const same = sel === refI;
    const loss = rows[sel].map((v, c) => v - rows[refI][c]), lmax = Math.max(0.1, ...loss.map(Math.abs)), worst = loss.indexOf(Math.max(...loss));
    const rec = data.rec, nc = data.nc, nRec = rec.length / nc, gOf = l => { const v = []; for (let i = 0; i < nRec; i += 2) { const t = rec[i * nc]; if (t >= l.start && t < l.end) v.push(rec[i * nc + 11]); } return pct(v, 0.95); };
    const lapRows = laps.map(l => {
      const i = ok.indexOf(l), p = i > 0 ? ok[i - 1] : null;
      return `<tr data-sel="${i}" ${i === sel ? 'aria-selected="true"' : ""}><td>Lap ${l.n}</td><td class="tm ${l === best ? "c-best" : ""}">${l.interrupted ? "interrupted" : lapTime(l.time)}</td>
        <td>${l.interrupted ? "" : l === best ? "best" : signedTxt(l.time - best.time)}</td><td class="${p && !l.interrupted ? (l.time <= p.time ? "c-fast" : "c-slow") : ""}">${p && !l.interrupted ? signedTxt(l.time - p.time) : ""}</td>
        <td>${l.interrupted ? "" : gOf(l).toFixed(2)}</td></tr>`;
    }).join("");
    const cbars = ct.corners.map((c, k) => {
      const v = loss[k], w = 50 * Math.abs(v) / lmax, col = v >= 0.03 ? "--slower" : v <= -0.03 ? "--faster" : "--ink-3";
      return `<div class="cbar"><div class="nm">Turn ${k + 1} <small>${c.dir > 0 ? "left" : c.dir < 0 ? "right" : ""}</small></div>
        <div class="dv"><i style="${v >= 0 ? `left:50%;width:${w.toFixed(1)}%` : `right:50%;width:${w.toFixed(1)}%`};background:var(${col})"></i></div>
        <div class="val" style="color:var(${col === "--ink-3" ? "--ink-2" : col})">${signedTxt(v)}</div></div>`;
    }).join("");
    // every lap through every corner, against the best time anyone lap set in that corner
    let hmax = 0.15; rows.forEach(r => r.forEach((v, c) => { if (isFinite(v)) hmax = Math.max(hmax, v - cornerBest[c]); }));
    const heat = `<table><thead><tr><th></th>${ct.corners.map((c, k) => `<th>T${k + 1}</th>`).join("")}</tr></thead><tbody>${ok.map((l, i) => `<tr><th>Lap ${l.n}</th>${rows[i].map((v, c) => {
      const x = v - cornerBest[c], t = x / hmax; return isFinite(x) ? `<td class="${t < 0.45 ? "dim" : ""}" style="background:${ramp(t)}" title="Lap ${l.n}, turn ${c + 1}: ${x.toFixed(2)} s over the best">${x >= 0.05 ? x.toFixed(2).replace(/^0/, "") : ""}</td>` : "<td></td>"; }).join("")}</tr>`).join("")}</tbody></table>`;
    const tapsNote = data.marks.length >= 2 ? `<p class="small" style="margin-top:8px">${source === "taps" ? (meta.fallback && !opts.source ? `The automatic timing did not find the lap in this session, so these are the laps from your ${data.marks.length} taps.` : `Laps from your ${data.marks.length} taps.`) : `You also tapped the screen ${data.marks.length} times.`}
      ${data.autoLaps.length >= 2 ? `<button class="btn" id="swap" type="button" style="margin-left:6px">${source === "taps" ? "Use automatic timing" : "Use my taps"}</button>` : ""}</p>` : "";
    app.innerHTML = `<div class="page">${head}
      <div class="kpis">
        <div class="kpi"><div class="k">Best lap</div><div class="v c-best">${lapTime(best.time)}</div><div class="s">lap ${best.n} of ${laps.length}</div></div>
        <div class="kpi"><div class="k">Average lap</div><div class="v">${lapTime(mean)}</div><div class="s">${ok.length} complete laps</div></div>
        <div class="kpi"><div class="k">Consistency</div><div class="v">${sd.toFixed(2)} s</div><div class="s">typical gap between your laps</div></div>
        <div class="kpi"><div class="k">Best corners added up</div><div class="v">${lapTime(ideal)}</div><div class="s">${(best.time - ideal).toFixed(2)} s under your best lap</div></div>
      </div>
      <h2>Lap times</h2><p class="sub">Tap a point or a row to look at that lap.</p>
      <div class="chartcard"><div class="legend"><span><i class="sq" style="background:var(--best);border-radius:50%"></i>best lap</span><span><i class="sq" style="background:var(--series-b);border-radius:50%"></i>lap you are looking at</span><span><i style="background:repeating-linear-gradient(90deg,var(--ink-3) 0 5px,transparent 5px 9px)"></i>average ${lapTime(mean)}</span></div><canvas id="lapchart"></canvas></div>
      <table class="laps"><thead><tr><th>Lap</th><th>Time</th><th>to best</th><th>to the lap before</th><th>peak G</th></tr></thead><tbody>${lapRows}</tbody></table>
      ${tapsNote}
      <h2 id="cmp">${esc(selName)} compared</h2>
      <div class="seg2" role="group" aria-label="Compare with" style="max-width:420px"><button type="button" data-ref="best" aria-pressed="${refMode === "best"}">With the best lap</button><button type="button" data-ref="prev" aria-pressed="${refMode === "prev"}" ${sel === 0 ? "disabled" : ""}>With the lap before</button></div>
      ${same ? `<p class="sub" style="margin-top:12px">This is your best lap. Pick another lap, or compare it with the lap before.</p>` : `
      <p class="sub" style="margin-top:12px">${esc(selName)} was <b class="${ok[sel].time - ok[refI].time > 0 ? "c-slow" : "c-fast"}">${signedTxt(ok[sel].time - ok[refI].time)} s</b> against ${esc(refName.toLowerCase())}. ${loss[worst] >= 0.1 ? `Most of the loss is in <b>turn ${worst + 1}</b> (${loss[worst].toFixed(2)} s).` : "No single turn lost a tenth or more."}</p>
      <div class="chartcard"><div class="legend"><span><i style="background:var(--ink)"></i>time lost or gained so far</span><span><i style="background:var(--series-a)"></i>${esc(refName)}</span><span><i style="background:var(--series-b)"></i>${esc(selName)}</span></div>
        <canvas id="cmpchart"></canvas><div class="tip" id="tip" hidden></div></div>
      <p class="small" style="margin-top:8px">Top: the gap as the lap unfolds, rising where ${esc(selName.toLowerCase())} falls behind. Bottom: how the kart turned (up is left, down is right). The numbers along the top are the turns. Drag a finger across to read any point.</p>
      <h2>Turn by turn</h2><p class="sub">Time through each turn, with the run into it, against ${esc(refName.toLowerCase())}. Red is time lost, green is time gained.</p>
      <div class="cbars">${cbars}</div>
      <p class="small" style="margin-top:8px">Turns are placed by matching the turn pattern of the laps. A few hundredths is within the method's noise; a tenth or more is worth a look.</p>`}
      <h2>Where the time goes, every lap</h2><p class="sub">Each box is one lap through one turn: how much slower than your quickest pass of that turn. A light column is a turn you often get wrong; a light row is a poor lap.</p>
      <div class="chartcard"><div class="legend"><span><i class="sq" style="background:${ramp(0)}"></i>at your best</span><span><i class="sq" style="background:${ramp(0.5)}"></i></span><span><i class="sq" style="background:${ramp(1)}"></i>${hmax.toFixed(2)} s slower</span></div><div class="heat">${heat}</div></div>
      ${foot}</div>`;
    const go = o => viewReview(id, Object.assign({ source, sel, ref: refMode, scroll: "cmp" }, o));
    $$("[data-sel]").forEach(r => r.addEventListener("click", () => { const i = Number(r.dataset.sel); if (i >= 0) go({ sel: i }); }));
    $$("[data-ref]").forEach(b => b.addEventListener("click", () => { if (!b.disabled) go({ ref: b.dataset.ref }); }));
    const sw = $("#swap"); if (sw) sw.addEventListener("click", () => viewReview(id, { source: source === "taps" ? "auto" : "taps" }));
    wireFoot(meta, data, laps, source);
    const drawAll = () => {
      lapChart($("#lapchart"), null, ok, bestI, sel, i => go({ sel: i }));
      if (!same) compareChart($("#cmpchart"), $("#tip"), ct, ok, bestI, refI, sel, { ref: refName, sel: selName });
    };
    drawAll(); app._redraw = drawAll;
    if (opts.scroll) { const h = $("#" + opts.scroll); if (h) h.scrollIntoView({ block: "start" }); } else window.scrollTo(0, 0);
  }

  function wireFoot(meta, data, laps, source) {
    $("#back").addEventListener("click", viewHome);
    $("#again").addEventListener("click", () => startDrive(null));
    const base = fileBase(meta);
    $("#csv").addEventListener("click", () => saveDataFile(meta, data));
    const sh = $("#share"); if (sh) sh.addEventListener("click", () => shareFile(base + ".csv", csvOf(meta, data)));
    $("#lapscsv").addEventListener("click", () => download(base + "_laps.csv", "lap,time_s,start_s,end_s,timed_by,interrupted\n" + laps.map(l => [l.n, l.time.toFixed(3), l.start.toFixed(3), l.end.toFixed(3), source, l.interrupted ? "yes" : "no"].join(",")).join("\n") + "\n"));
    $("#rename").addEventListener("click", () => {
      $("#confirm").innerHTML = `<div class="field"><label for="newname">Track name</label><input type="text" id="newname" value="${esc(meta.track)}" maxlength="40"></div><div class="row"><button class="btn primary" id="oknm" type="button">Save name</button></div>`;
      $("#newname").focus();
      $("#oknm").addEventListener("click", async () => { meta.track = $("#newname").value.trim() || meta.track; await Store.put("sessions", meta); viewReview(meta.id, { source }); });
    });
    $("#del").addEventListener("click", () => {
      $("#confirm").innerHTML = `<div class="note">Delete this session from the phone? This cannot be undone.<div class="row" style="margin-top:8px"><button class="btn danger" id="yes" type="button">Delete</button><button class="btn" id="no" type="button">Keep</button></div></div>`;
      $("#yes").addEventListener("click", async () => { await Store.del(meta.id); toast("Session deleted."); viewHome(); });
      $("#no").addEventListener("click", () => { $("#confirm").innerHTML = ""; });
    });
  }

  /* ------------------------------------------------------------------ start */
  /* Anything that goes wrong unexpectedly is written into the running session's log (and so into its
     data file); with no session running it is shown. */
  function report(msg) { msg = String(msg || "unknown").slice(0, 160); if (cur) { cur.errs++; if (cur.errs <= 8) note(cur, "error: " + msg); } else toast("Something went wrong (" + msg + "). Saved sessions are not affected.", 6000); }
  window.addEventListener("error", e => report(e.message || (e.error && e.error.message)));
  window.addEventListener("unhandledrejection", e => report(e.reason && e.reason.message || e.reason));

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    const had = !!navigator.serviceWorker.controller;
    // a new version has just been installed in the background: show it, unless a session is running
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!had || cur || Array.from(mem.sessions.values()).some(m => m.stored === false)) return;
      try { const last = Number(sessionStorage.getItem("atk-reload") || 0); if (Date.now() - last < 15000) return; sessionStorage.setItem("atk-reload", String(Date.now())); } catch (e) { return; }
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").then(reg => { setTimeout(offlineLine, 1500); try { reg.update().catch(() => {}); } catch (e) { /* later */ } }).catch(() => {});
  }
  let rz = null;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (app._redraw && $("#lapchart")) app._redraw(); }, 150); });
  window.__kart = { get cur() { return cur; }, Store, viewHome, viewReview, model, settings, mem };      // for the test suite
  viewHome();
})();
