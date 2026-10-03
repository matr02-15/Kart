/* sim.js -- a simulated indoor kart session. Used for the demo session in the app and, in the test
   suite, as ground truth: the true lap times are known exactly, so the lap timing can be checked.

   A point-mass kart on a closed indoor-style track (tight corners, short straights). Corner speed is
   limited by grip, the straights by engine and braking. Each lap the driver varies a little, and a few
   laps hold a planted mistake. */
(function (root) {
  "use strict";
  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

  // [straight length m, corner radius m, turned angle deg (+ left)]; angles add up to 360
  var TRACK = [[38, 7, 180], [22, 9, -90], [14, 6, 90], [30, 8, 135], [18, 10, -45], [12, 6, 90], [26, 7.5, -90], [20, 9, 100], [16, 8, -30], [24, 7, 80]];

  function build(step) {
    var k = [], names = [], corner = [], s = 0, ci = 0;
    TRACK.forEach(function (seg) {
      var n = Math.round(seg[0] / step), i;
      for (i = 0; i < n; i++) { k.push(0); corner.push(-1); }
      var len = Math.abs(seg[2]) * Math.PI / 180 * seg[1]; n = Math.round(len / step);
      for (i = 0; i < n; i++) { k.push((seg[2] > 0 ? 1 : -1) / seg[1]); corner.push(ci); }
      ci++;
    });
    // ease the curvature in and out over about 3 m
    var w = Math.round(3 / step), out = new Float64Array(k.length), N = k.length;
    for (var i = 0; i < N; i++) { var a = 0; for (var j = -w; j <= w; j++) a += k[(i + j + N) % N]; out[i] = a / (2 * w + 1); }
    return { k: out, corner: corner, step: step, length: N * step };
  }

  /* opts: laps, seed, mistakes: [{lap, corner, kind:'slow'|'brake'}], rate (Hz). Returns
     {t, yaw (deg/s), latG, lonG, speed (m/s), lapStarts (s, exact), track length, plan}. */
  function session(opts) {
    opts = opts || {};
    var laps = opts.laps || 12, r = rng(opts.seed || 3), rate = opts.rate || 60, tr = build(0.25), N = tr.k.length, step = tr.step;
    var G = 9.81, MU = 1.25, ACC = 2.6, BRK = 6.5, VMAX = 16.5;
    var mistakes = opts.mistakes || [{ lap: 4, corner: 3, kind: "slow" }, { lap: 7, corner: 0, kind: "brake" }, { lap: 9, corner: 6, kind: "slow" }];
    var T = [], YAW = [], LAT = [], LON = [], V = [], lapStarts = [], cornerSpans = [], t = 0, v = 0.5, nextSample = 0;
    var pit = opts.pitSeconds === undefined ? 6 : opts.pitSeconds;
    // sitting in the pits before the start
    for (; nextSample < pit; nextSample += 1 / rate) { T.push(nextSample); YAW.push(0.3 * gauss(r)); LAT.push(0); LON.push(0); V.push(0); }
    t = pit;
    for (var lap = 0; lap <= laps; lap++) {
      // lap 0 is the run out of the pits (cold tyres); it starts on the line too
      var grip = [], brake = [];
      for (var c = 0; c < TRACK.length; c++) { grip.push((lap === 0 ? 0.82 : 0.97) * (1 + 0.012 * gauss(r))); brake.push(1 + 0.03 * gauss(r)); }
      mistakes.forEach(function (m) { if (m.lap === lap) { if (m.kind === "slow") grip[m.corner] *= 0.86; else brake[m.corner] *= 0.45; } });
      // speed limit from grip, then backward pass for braking and forward pass for acceleration
      var lim = new Float64Array(N), i;
      for (i = 0; i < N; i++) { var kk = Math.abs(tr.k[i]), cc = tr.corner[i]; lim[i] = kk > 1e-4 ? Math.min(VMAX, Math.sqrt(MU * G * (cc >= 0 ? grip[cc] : 1) / kk)) : VMAX; }
      var vb = new Float64Array(N + 1); vb[N] = lim[0];
      for (i = N - 1; i >= 0; i--) { var nc = tr.corner[(i + Math.round(8 / step)) % N], bf = nc >= 0 ? brake[nc] : 1; vb[i] = Math.min(lim[i], Math.sqrt(vb[i + 1] * vb[i + 1] + 2 * BRK * bf * step)); }
      lapStarts.push(t);
      var spans = []; cornerSpans.push(spans);
      for (i = 0; i < N; i++) {
        var cc2 = tr.corner[i]; if (cc2 >= 0) { if (!spans[cc2]) spans[cc2] = [t, t]; }
        var target = vb[i + 1], vn = Math.min(target, Math.sqrt(v * v + 2 * ACC * (1 - v / 22) * step));
        var dt = step / Math.max(0.3, (v + vn) / 2), lon = (vn - v) / dt / G, yaw = (v + vn) / 2 * tr.k[i] * 180 / Math.PI, lat = Math.pow((v + vn) / 2, 2) * tr.k[i] / G;
        while (nextSample < t + dt) { T.push(nextSample); YAW.push(yaw + 1.5 * gauss(r)); LAT.push(lat + 0.06 * gauss(r)); LON.push(lon + 0.06 * gauss(r)); V.push(v); nextSample += 1 / rate; }
        t += dt; v = vn;
        if (cc2 >= 0) spans[cc2][1] = t;
      }
    }
    lapStarts.push(t);
    return { t: T, yaw: YAW, latG: LAT, lonG: LON, speed: V, lapStarts: lapStarts, cornerSpans: cornerSpans, length: tr.length, mistakes: mistakes, corners: TRACK.length };
  }

  var api = { session: session, rng: rng, gauss: gauss, TRACK: TRACK };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KartSim = api;
})(typeof self !== "undefined" ? self : this);
