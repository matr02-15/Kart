/* core.js -- the measuring part of Apex Trace Kart. No screen code here: the same file runs on the
   phone and in the test suite (node), so what is tested is what is shipped.

   Indoors there is no GPS. Everything is built on one signal the phone measures well: how fast the
   kart is turning (the gyroscope, projected on the vertical). A lap of a circuit is a fixed sequence
   of turns, so that signal repeats every lap like a fingerprint.

     LapDetector   finds the lap length from the repetition, picks the most recognisable moment of the
                   lap as its timing point, and reports every pass of it. Lap time = pass to pass, which
                   equals the official lap time whatever point of the track is used.
     alignLaps     lays one lap over another by matching their turn patterns (dynamic time warping), so
                   time gained or lost can be placed on the lap, corner by corner, without knowing speed.
     findCorners   splits the lap into corners from the turn rate.
*/
(function (root) {
  "use strict";

  var FS = 20;                       // Hz, working rate of the turn-rate signal
  var CUT = 0.3;                     // where a straight is cut between two corners (share of its length)

  function median(a) { if (!a.length) return NaN; var b = Array.prototype.slice.call(a).sort(function (x, y) { return x - y; }); var m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }

  /* Zero-mean normalised correlation of template T with y at offset o. */
  function ncc(T, y, o, tMean, tNorm) {
    var n = T.length, s = 0, sy = 0, syy = 0, i, v;
    for (i = 0; i < n; i++) { v = y[o + i]; sy += v; syy += v * v; s += T[i] * v; }
    var my = sy / n, den = Math.sqrt(Math.max(syy - n * my * my, 1e-9)) * tNorm;
    return (s - n * tMean * my) / den;
  }
  function stats(T) { var n = T.length, s = 0, ss = 0, i; for (i = 0; i < n; i++) { s += T[i]; ss += T[i] * T[i]; } var m = s / n; return { mean: m, norm: Math.sqrt(Math.max(ss - n * m * m, 1e-9)) }; }

  /* How fast the kart is turning, from what the phone measures.
       w    the phone's rotation rate about its own x, y, z (deg/s); z is the axis through the screen
       up   the direction of "up" in the phone's own axes (unit length)
     The plain answer is the part of the rotation about the vertical (w . up). But a phone on the
     steering wheel also turns WITH the wheel, about the steering column, and the column leans, so part
     of every movement of the wheel would be read as the kart turning. A phone lying in the plane of the
     wheel has the column along its own z axis, so that rotation is all in w[2]: leave w[2] out and
     rebuild the turn rate from the rotation about the two axes in the screen. This is exact for a
     phone square on the wheel and equally exact for a phone on a fixed mount. It cannot work when the
     screen faces straight up (nothing of "up" lies in the screen), so the plain answer takes over there. */
  function turnRate(w, up) {
    var plain = w[0] * up[0] + w[1] * up[1] + w[2] * up[2], h2 = up[0] * up[0] + up[1] * up[1];
    if (h2 <= 0.12) return plain;
    var k = Math.min(1, (h2 - 0.12) / 0.18);
    return plain + k * ((w[0] * up[0] + w[1] * up[1]) / h2 - plain);
  }

  /* ---------------------------------------------------------------- lap detector */
  function LapDetector(opts) {
    opts = opts || {};
    this.fs = FS;
    this.minLap = opts.minLap || 10;         // s
    this.fineHalf = opts.fineHalf || 0;
    this.maxLap = opts.maxLap || 150;        // s
    this.y = [];                             // turn rate, deg/s, at FS
    this._acc = 0; this._n = 0; this._next = 0;   // resampler
    this.period = null;                      // lap length in samples
    this.template = null; this.tStats = null;
    this.passes = [];                        // sample index (fractional) of each pass of the timing point
    this.scores = [];
    this.wins = []; this._lastTry = 0;
    this.quality = 0;                        // how clearly the lap repeats (0..1)
    this.method = null;                      // how the lap length was found
  }

  /* Feed raw samples: t in seconds from the start, turn rate in deg/s (any rate >= 20 Hz). */
  LapDetector.prototype.push = function (t, yaw) {
    // average all raw samples falling in each 1/FS slot (a simple, robust low-pass)
    // A short silence repeats the last value. A long one (the app was in the background, the screen was
    // locked) is filled with "not turning": repeating a cornering value for half a minute would add
    // whole turns of heading that never happened.
    var silent = Math.floor(t * this.fs) - this._next > Math.round(0.5 * this.fs);
    while (t >= (this._next + 1) / this.fs) {
      var v = this._n ? this._acc / this._n : (silent ? 0 : (this.y.length ? this.y[this.y.length - 1] : 0));
      this.y.push(v); this._acc = 0; this._n = 0; this._next++;
    }
    if (isFinite(yaw)) { this._acc += yaw; this._n++; }
  };
  LapDetector.prototype.duration = function () { return this.y.length / this.fs; };

  /* Smoothed copy (moving average over about 0.6 s): the corners stay, kerbs and steering corrections go. */
  LapDetector.prototype._smooth = function () {
    var y = this.y, n = y.length, w = Math.round(0.3 * this.fs), out = new Float32Array(n), c = new Float64Array(n + 1), i;
    for (i = 0; i < n; i++) c[i + 1] = c[i] + y[i];
    for (i = 0; i < n; i++) { var a = Math.max(0, i - w), b = Math.min(n, i + w + 1); out[i] = (c[b] - c[a]) / (b - a); }
    return out;
  };

  /* Lap length from the heading. Over exactly one lap of a closed circuit the kart turns through one
     full turn, wherever on the lap you start counting. So the lap length is the one time span over
     which the heading always changes by the same amount, about 360 degrees: half a lap or a lap and a
     half give a change that depends on where you start, and two laps give 720. Returns
     {L (samples), spread (deg), turn (deg)} or null when no span qualifies (too early, or a figure of eight). */
  LapDetector.prototype._headingPeriod = function (s) {
    var n = s.length, fs = this.fs, N = Math.min(n, Math.round(420 * fs)), off = n - N, H = new Float64Array(N + 1), i;
    for (i = 0; i < N; i++) H[i + 1] = H[i] + s[off + i] / fs;
    var lo = Math.round(this.minLap * fs), hi = Math.min(Math.round(this.maxLap * fs), Math.floor(N / 2.2)), step = 8;
    // spread measured robustly (half of the laps may hold a spin or a stop): the share of start points
    // whose heading change lies within 30 degrees of the typical one
    var buf = new Float32Array(Math.ceil(N / step) + 2);
    function measure(L) {
      var c = 0, i2;
      for (i2 = L; i2 <= N; i2 += step) buf[c++] = H[i2] - H[i2 - L];
      if (c < 20) return null;
      var v = buf.subarray(0, c).slice().sort(), med = v[c >> 1];
      if (Math.abs(med) < 250 || Math.abs(med) > 470) return null;
      var inside = 0; for (i2 = 0; i2 < c; i2++) if (Math.abs(v[i2] - med) <= 30) inside++;
      return { L: L, agree: inside / c, turn: med, spread: v[Math.floor(0.75 * c)] - v[Math.floor(0.25 * c)] };
    }
    var best = null, L, m;
    for (L = lo; L <= hi; L += 4) { m = measure(L); if (m && (!best || m.agree > best.agree)) best = m; }
    if (!best) return null;
    for (L = Math.max(lo, best.L - 6); L <= Math.min(hi, best.L + 6); L++) { m = measure(L); if (m && (m.agree > best.agree || (m.agree === best.agree && m.spread < best.spread))) best = m; }
    return best.agree >= 0.6 ? best : null;
  };

  /* Does the heading build up at all? On a figure-of-eight track it does not, and the lap length has to
     come from the repetition alone. Degrees per second, averaged over the recording. */
  LapDetector.prototype._headingTrend = function (s) {
    var sum = 0; for (var i = 0; i < s.length; i++) sum += s[i];
    return Math.abs(sum) / Math.max(s.length, 1);
  };

  /* Lap length from the repetition of the turn pattern (autocorrelation) for lags lo..hi (samples).
     With `wide` (no heading estimate) the shortest lag that repeats nearly as well as the best is taken. */
  LapDetector.prototype._repeatPeriod = function (s, lo, hi, wide) {
    var n = s.length, fs = this.fs, N = Math.min(n, Math.round(420 * fs)), off = n - N, i, L;
    hi = Math.min(hi, Math.floor(N / (wide ? 2.15 : 1.6)));
    if (hi <= lo) return null;
    var mean = 0; for (i = off; i < n; i++) mean += s[i]; mean /= N;
    var best = null, r = new Float32Array(hi + 2);
    for (L = lo; L <= hi; L++) {
      var a = 0, b = 0, c = 0, m = N - L, x, z;
      for (i = 0; i < m; i += 2) { x = s[off + i] - mean; z = s[off + i + L] - mean; a += x * z; b += x * x; c += z * z; }
      r[L] = a / Math.sqrt(Math.max(b * c, 1e-9));
      if (!best || r[L] > best.r) best = { L: L, r: r[L] };
    }
    if (!best) return null;
    if (wide) {
      for (var k = 4; k >= 2; k--) {
        var c0 = Math.round(best.L / k), sub = null;
        if (c0 < lo) continue;
        for (L = Math.max(lo, Math.round(0.97 * c0) - 2); L <= Math.min(hi, Math.round(1.03 * c0) + 2); L++) if (!sub || r[L] > sub.r) sub = { L: L, r: r[L] };
        if (sub && sub.r >= 0.85 * best.r) { best = sub; break; }
      }
    }
    return best;
  };

  /* Choose the timing point: a stretch of the lap that is easy to recognise again and looks like no
     other part of the lap. Two templates are cut around it: a long one to find the right place on the
     lap, and a short one around the sharpest change of turn rate to time the pass precisely. */
  LapDetector.prototype._chooseTemplate = function (s, P) {
    var fs = this.fs, n = s.length, d = Math.round(0.5 * fs), i, Ps = P / fs;
    var halves = [0.07, 0.11, 0.16].map(function (f) { return Math.round(Math.min(13, Math.max(2.5, f * Ps)) * fs); });
    var hmax = halves[halves.length - 1];
    var start = Math.max(hmax + d + 1, Math.floor(n / 2 - P / 2)), end = Math.min(n - hmax - d - 2, start + P), list = [];
    for (i = start; i < end; i++) list.push([Math.abs(s[i + d] - s[i - d]), i]);
    list.sort(function (x, y) { return y[0] - x[0]; });
    var picked = [];
    for (i = 0; i < list.length && picked.length < 8; i++) { var c0 = list[i][1]; if (picked.every(function (q) { return Math.abs(q - c0) > 2 * fs; })) picked.push(c0); }
    var best = null;
    var post = Math.round(Math.min(2.5, Math.max(1.5, 0.06 * Ps)) * fs);
    picked.forEach(function (c) {
      halves.forEach(function (half) {
        // the window lies mostly BEFORE the timing point, so a pass is recognised soon after it happens
        var pre = 2 * half - post, a = c - pre, len = pre + post + 1;
        if (a < 0 || a + len > n) return;
        var T = s.subarray(a, a + len), st = stats(T);
        if (st.norm < 1e-3) return;
        var own = {}, other = -1;
        for (i = 0; i + len <= n; i += 2) {
          var v = ncc(T, s, i, st.mean, st.norm), phase = ((i - a) % P + P) % P, near = Math.min(phase, P - phase) < 0.1 * P;
          if (near) { var lap = Math.round((i - a) / P); if (own[lap] === undefined || v > own[lap]) own[lap] = v; }
          else if (v > other) other = v;
        }
        var vals = Object.keys(own).map(function (k) { return own[k]; }), o = median(vals), score = o - other;
        if (!best || score > best.score) best = { c: c, pre: pre, post: post, score: score, own: o, other: other };
      });
    });
    return best;
  };

  /* How well the long template fits with the timing point at c. A lap driven clearly slower or faster
     (cold tyres, traffic) stretches the pattern in time, so the template is also tried stretched and
     squeezed about the timing point; the best fit counts. */
  var SCALES = [1, 0.94, 1.06, 0.88, 1.13, 1.2, 0.82, 1.3];
  LapDetector.prototype._coarse = function (s, c, stretch) {
    var T = this.template, st = this.tStats, len = T.length, pre = this.pre, post = this.post, n = s.length, best = -2;
    if (c - pre >= 0 && c + post < n) best = ncc(T, s, c - pre, st.mean, st.norm);
    if (!stretch || best >= this.thrHi) return best;
    var buf = this._buf && this._buf.length === len ? this._buf : (this._buf = new Float32Array(len));
    for (var q = 1; q < SCALES.length; q++) {
      var a = SCALES[q], start = c - pre * a;
      if (start < 0 || c + post * a >= n - 1) continue;
      for (var k = 0; k < len; k++) { var x = start + k * a, i0 = Math.floor(x), f = x - i0; buf[k] = s[i0] * (1 - f) + s[i0 + 1] * f; }
      var v = ncc(T, buf, 0, st.mean, st.norm);
      if (v > best) best = v;
    }
    return best;
  };

  /* Best coarse match for the timing point with its centre between cLo and cHi. */
  LapDetector.prototype._best = function (s, cLo, cHi, stretch) {
    var b = null;
    cLo = Math.max(Math.round(0.8 * this.pre), Math.ceil(cLo)); cHi = Math.min(s.length - this.post - 1, Math.floor(cHi));
    for (var c = cLo; c <= cHi; c++) { var v = this._coarse(s, c, stretch); if (!b || v > b.v) b = { c: c, v: v }; }
    return b;
  };

  /* Exact position of the timing point near centre c. The kart does not take the same stretch at the
     same speed every lap, so the short template is also tried slightly stretched and squeezed in time. */
  LapDetector.prototype._refine = function (s, c, wide) {
    var T = this.fine, st = this.fStats, len = T.length, h = (len - 1) / 2, n = s.length, fs = this.fs, best = { score: -2, pos: c };
    // `wide`: the place was found with a poor fit (a lap at a very different pace), so look further around
    var buf = new Float32Array(len), span = wide ? Math.round(2.5 * this.span) : this.span, aLo = wide ? 0.78 : 0.86, aHi = wide ? 1.341 : 1.161;
    for (var a = aLo; a <= aHi; a += 0.02) {
      var scoreAt = [], b0 = null;
      for (var sh = -span; sh <= span; sh++) {
        var start = c + sh - h * a;
        if (start < 0 || start + (len - 1) * a >= n - 1) { scoreAt.push(-2); continue; }
        for (var k = 0; k < len; k++) { var x = start + k * a, i0 = Math.floor(x), f = x - i0; buf[k] = s[i0] * (1 - f) + s[i0 + 1] * f; }
        scoreAt.push(ncc(T, buf, 0, st.mean, st.norm));
        if (b0 === null || scoreAt[scoreAt.length - 1] > scoreAt[b0]) b0 = scoreAt.length - 1;
      }
      if (b0 === null || scoreAt[b0] <= best.score) continue;
      var l = b0 > 0 ? scoreAt[b0 - 1] : -2, r2 = b0 + 1 < scoreAt.length ? scoreAt[b0 + 1] : -2, den = l - 2 * scoreAt[b0] + r2;
      var frac = (l > -2 && r2 > -2 && Math.abs(den) > 1e-9) ? Math.max(-0.5, Math.min(0.5, 0.5 * (l - r2) / den)) : 0;
      best = { score: scoreAt[b0], pos: c - span + b0 + frac, scale: a };
    }
    return best;
  };

  LapDetector.prototype._accept = function (s, c, v, atEnd) {
    var fit = this._refine(s, c, v < this.thrHi);
    if (atEnd) { this.wins.push(c); this.passes.push(fit.pos); this.scores.push(v); }
    else { this.wins.unshift(c); this.passes.unshift(fit.pos); this.scores.unshift(v); }
  };

  /* Follow the timing point lap after lap from the last known pass. Normally the next pass comes one
     lap length later, give or take; if nothing is found there (a spin, a stop), the search carries on
     until the pattern is clearly seen again. `final`: the recording is over. */
  LapDetector.prototype._track = function (s, final) {
    // a pass is only timed once the data needed to place it precisely has arrived
    var fs = this.fs, n = s.length, guard = Math.max(Math.round(1.0 * fs), this.span + Math.ceil(1.16 * (this.fine.length - 1) / 2) - this.post + 4), changed = false;
    for (;;) {
      var P = this.period, last = this.wins[this.wins.length - 1], avail = n - this.post - 1 - (final ? 0 : guard);
      var lo = last + 0.82 * P, hi = last + 1.22 * P;
      if (avail < lo) break;
      var b = this._best(s, lo, Math.min(hi, avail));
      if (!b) break;
      var complete = avail >= hi;
      var localMax = b.c < Math.min(hi, avail) - 2 || complete;     // not still climbing at the edge of what we have
      if (b.v >= this.thrHi && localMax) { this._accept(s, b.c, b.v, true); changed = true; this.lost = 0; this._follow(); continue; }
      if (!complete) break;                                           // wait for the rest of the window
      if (b.v >= this.thrLo) { this._accept(s, b.c, b.v, true); changed = true; this.lost = 0; this._follow(); continue; }
      // nothing at normal pace where the pass was expected: a clearly slower or faster lap?
      var bs = this._best(s, lo, hi, true);
      if (bs && bs.v >= this.thrHi) { this._accept(s, bs.c, bs.v, true); changed = true; this.lost = 0; continue; }
      // lost: look further on for a clear match
      var from = Math.max(hi, this._lostFrom || 0), found = null;
      for (var c = Math.ceil(from); c <= avail; c++) {
        var v = this._coarse(s, c);
        if (v >= this.thrHi) {
          var bb = { c: c, v: v };
          for (var k = c + 1; k <= Math.min(avail, c + Math.round(0.3 * P)); k++) { var w = this._coarse(s, k); if (w > bb.v) bb = { c: k, v: w }; }
          if (bb.c + Math.round(0.3 * P) > avail && !final && bb.c > avail - 2) break;
          found = bb; break;
        }
      }
      if (found) { this._lostFrom = 0; this._accept(s, found.c, found.v, true); changed = true; this.lost = (this.lost || 0) + 1; continue; }
      this._lostFrom = avail; break;
    }
    return changed;
  };

  LapDetector.prototype._follow = function () {           // follow the driver's pace
    var k = this.wins.length;
    if (k < 3) return;
    var d = []; for (var q = Math.max(1, k - 4); q < k; q++) { var g = this.wins[q] - this.wins[q - 1]; if (g > 0.8 * this.period && g < 1.25 * this.period) d.push(g); }
    if (d.length >= 2) this.period = 0.6 * this.period + 0.4 * median(d);
  };

  LapDetector.prototype._lock = function (s, final) {
    var fs = this.fs, lo = Math.round(this.minLap * fs), hi = Math.round(this.maxLap * fs), p, method;
    var hp = this._headingPeriod(s);
    if (hp) {
      // sharpen with the repetition of the turn pattern, close to the heading's answer only
      p = this._repeatPeriod(s, Math.max(lo, Math.round(0.93 * hp.L)), Math.min(hi, Math.round(1.07 * hp.L)), false);
      if (!p || p.r < 0.35) p = { L: hp.L, r: 0.35 };
      method = "heading";
    } else {
      // the heading does not build up (a figure-of-eight track, or too early): only accept a very clear
      // repetition, and only after a good while
      if (s.length < 150 * fs || this._headingTrend(s) > 360 / this.maxLap) return false;
      p = this._repeatPeriod(s, lo, hi, true); method = "repetition";
      if (!p || p.r < 0.65) return false;
    }
    var t = this._chooseTemplate(s, p.L);
    if (!t || t.score < 0.1 || t.own < 0.6) return false;
    this.period = p.L; this.quality = p.r; this.method = method; this.pre = t.pre; this.post = t.post;
    this.template = new Float32Array(s.subarray(t.c - t.pre, t.c + t.post + 1)); this.tStats = stats(this.template);
    var fh = Math.min(t.post, Math.round((this.fineHalf || 2) * fs));
    this.fine = new Float32Array(s.subarray(t.c - fh, t.c + fh + 1)); this.fStats = stats(this.fine);
    // a long window matched at a different pace lands a little early or late: search that far around it
    this.span = Math.round(Math.max(0.9 * fs, 0.09 * t.pre));
    this.thrHi = Math.max(0.6, t.other + 0.5 * (t.own - t.other));
    this.thrLo = Math.max(0.45, Math.min(this.thrHi, t.other + 0.15 * (t.own - t.other), 0.7 * t.own));
    this.wins = [t.c]; this.passes = [t.c]; this.scores = [1]; this._lostFrom = 0; this.lost = 0;
    // back-fill: follow the timing point back to the start of the recording, one lap at a time
    for (;;) {
      var first = this.wins[0], b = this._best(s, first - 1.22 * this.period, first - 0.82 * this.period);
      if (first - 0.82 * this.period < 0.8 * this.pre) break;
      if (!b || b.v < this.thrLo) { b = this._best(s, first - 1.3 * this.period, first - 0.82 * this.period, true); if (!b || b.v < this.thrHi) break; }
      this._accept(s, b.c, b.v, false);
    }
    this._track(s, final);
    if (this.passes.length < 2) { this.period = null; this.template = null; this.passes = []; this.scores = []; this.wins = []; return false; }
    return true;
  };

  /* Call regularly (about once a second). Returns true when the list of laps changed. */
  LapDetector.prototype.update = function (final) {
    var n = this.y.length, fs = this.fs;
    if (this.period === null) {
      if (n < 2.2 * this.minLap * fs || (!final && n - this._lastTry < Math.max(3 * fs, 0.02 * n))) return false;
      this._lastTry = n;
      return this._lock(this._smooth(), !!final);
    }
    var sm = this._smooth(), changed = this._track(sm, !!final);
    var since = n - this.wins[this.wins.length - 1];
    if (!final && (this.lost >= 2 || since > 3.2 * this.period) && n - this._lastTry > 10 * fs) {
      // the pattern is not coming round as expected: what was learnt may not be the lap. Learn it again
      // from everything recorded so far.
      this._lastTry = n;
      var keep = { period: this.period, template: this.template, tStats: this.tStats, fine: this.fine, fStats: this.fStats, pre: this.pre, post: this.post, span: this.span,
                   thrHi: this.thrHi, thrLo: this.thrLo, wins: this.wins, passes: this.passes, scores: this.scores, quality: this.quality, method: this.method };
      this.period = null;
      if (this._lock(sm, false)) { this.relearned = (this.relearned || 0) + 1; return true; }
      for (var k in keep) this[k] = keep[k];
      this.lost = 0;
    }
    return changed;
  };

  /* Laps so far: [{n, start, end, time, interrupted}] in seconds. The stretch before the first pass is
     the run out of the pits and is not a lap. */
  LapDetector.prototype.laps = function () {
    var out = [], fs = this.fs, i, times = [];
    for (i = 1; i < this.passes.length; i++) times.push((this.passes[i] - this.passes[i - 1]) / fs);
    var med = median(times);
    for (i = 1; i < this.passes.length; i++) {
      var tt = times[i - 1];
      out.push({ n: i, start: this.passes[i - 1] / fs, end: this.passes[i] / fs, time: tt, interrupted: tt > 1.45 * med });
    }
    return out;
  };
  LapDetector.prototype.lastPass = function () { return this.passes.length ? this.passes[this.passes.length - 1] / this.fs : null; };
  LapDetector.prototype.state = function () { return this.period === null ? "learning" : (this.passes.length < 2 ? "found" : "timing"); };

  /* Laps from marks placed by hand (taps), same shape as LapDetector.laps(). */
  function lapsFromMarks(marks) {
    var out = [], i, times = [];
    for (i = 1; i < marks.length; i++) times.push(marks[i] - marks[i - 1]);
    var med = median(times);
    for (i = 1; i < marks.length; i++) out.push({ n: i, start: marks[i - 1], end: marks[i], time: times[i - 1], interrupted: times[i - 1] > 1.45 * med });
    return out;
  }

  /* ---------------------------------------------------------------- lap on lap */
  /* Turn rate of one lap at FS, smoothed. y: full-session signal at FS (array), start/end in seconds. */
  function lapSignal(y, start, end, fs) {
    fs = fs || FS;
    var a = Math.max(0, Math.round(start * fs)), b = Math.min(y.length, Math.round(end * fs)), n = b - a, out = new Float32Array(Math.max(n, 0)), w = Math.round(0.25 * fs), i, j;
    for (i = 0; i < n; i++) { var s = 0, c = 0; for (j = Math.max(a, a + i - w); j <= Math.min(b - 1, a + i + w); j++) { s += y[j]; c++; } out[i] = s / c; }
    return out;
  }

  /* Dynamic time warping of lap B onto reference lap A (both turn-rate signals at the same rate).
     Returns, for every sample i of A, the matching (fractional) sample of B. The path is kept inside a
     band so a lap can run at most `band` (share of the lap) ahead of or behind the reference. */
  function alignLaps(A, B, band) {
    var n = A.length, m = B.length;
    if (n < 4 || m < 4) return null;
    var w = Math.max(Math.round((band || 0.12) * Math.max(n, m)), Math.abs(n - m) + 4);
    // Only a band of the table around the diagonal is ever used, so only that band is stored: row i
    // holds columns base[i] .. base[i] + BW - 1. Outside the band the cost is "impossible".
    var INF = 1e30, BW = 2 * w + 3, i, j;
    if ((n + 1) * BW > 1.2e7) return null;                 // too long a lap for a phone's memory: no breakdown rather than a crash
    var D = new Float64Array((n + 1) * BW).fill(INF), base = new Int32Array(n + 1);
    for (i = 0; i <= n; i++) base[i] = Math.round(i * m / n) - w - 1;
    function get(r, col) { var q = col - base[r]; return q < 0 || q >= BW ? INF : D[r * BW + q]; }
    D[0 * BW + (0 - base[0])] = 0;
    // scale so the cost does not depend on how hard the kart turns
    var sc = 0; for (i = 0; i < n; i++) sc += Math.abs(A[i]); sc = sc / n || 1;
    for (i = 1; i <= n; i++) {
      var c = Math.round(i * m / n), jl = Math.max(1, c - w), jh = Math.min(m, c + w);
      for (j = jl; j <= jh; j++) {
        var d = Math.abs(A[i - 1] - B[j - 1]) / sc, a = get(i - 1, j - 1), b = get(i - 1, j) + PEN, e = get(i, j - 1) + PEN;
        D[i * BW + (j - base[i])] = d + Math.min(a, b, e);
      }
    }
    var total = get(n, m);
    if (total >= INF) return null;
    // walk back; several B samples can match one A sample: keep their mean
    var sum = new Float64Array(n), cnt = new Float64Array(n);
    i = n; j = m;
    while (i > 0 && j > 0) {
      sum[i - 1] += j - 1; cnt[i - 1]++;
      var p = get(i - 1, j - 1), q = get(i - 1, j), r = get(i, j - 1);
      if (p <= q && p <= r) { i--; j--; } else if (q <= r) i--; else j--;
    }
    var map = new Float32Array(n);
    for (i = 0; i < n; i++) map[i] = cnt[i] ? sum[i] / cnt[i] : (i ? map[i - 1] : 0);
    // a monotone, lightly smoothed path
    for (i = 1; i < n; i++) if (map[i] < map[i - 1]) map[i] = map[i - 1];
    var sm = new Float32Array(n), k = 3 * UP;
    for (i = 0; i < n; i++) { var s2 = 0, c2 = 0; for (j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) { s2 += map[j]; c2++; } sm[i] = s2 / c2; }
    sm[0] = 0; sm[n - 1] = m - 1;
    return { map: sm, cost: total / (n + m) };
  }

  /* Corners of a lap from its turn-rate signal: stretches of sustained turning, each with the piece
     of straight after it, tiling the whole lap (so corner times add up to the lap time). */
  function findCorners(A, fs) {
    fs = fs || FS;
    var n = A.length, i, peak = 0;
    var abs = []; for (i = 0; i < n; i++) abs.push(Math.abs(A[i]));
    var sorted = abs.slice().sort(function (a, b) { return a - b; }); peak = sorted[Math.floor(0.95 * (n - 1))] || 1;
    var on = Math.max(8, 0.35 * peak), off = Math.max(5, 0.2 * peak);
    var runs = [], state = 0, start = 0, below = 0, hold = Math.round(0.4 * fs);
    for (i = 0; i < n; i++) {
      var v = A[i], sgn = v > 0 ? 1 : -1;
      if (state === 0) { if (abs[i] >= on) { state = sgn; start = i; below = 0; } continue; }
      if (sgn !== state && abs[i] >= on) { runs.push([start, i - 1, state]); state = sgn; start = i; below = 0; continue; }
      below = abs[i] < off || sgn !== state ? below + 1 : 0;
      if (below >= hold) { runs.push([start, i - below, state]); state = 0; }
    }
    if (state !== 0) runs.push([start, n - 1, state]);
    runs = runs.filter(function (r) { return r[1] - r[0] >= 0.5 * fs; });
    if (!runs.length) return [{ name: "Lap", i0: 0, i1: n - 1, apex: n >> 1, dir: 0 }];
    var out = [];
    for (i = 0; i < runs.length; i++) {
      // each corner takes the last part of the straight before it (the braking) and the first part of
      // the straight after it (the exit)
      var i0 = i === 0 ? 0 : Math.round(runs[i - 1][1] + CUT * (runs[i][0] - runs[i - 1][1]));
      var i1 = i === runs.length - 1 ? n - 1 : Math.round(runs[i][1] + CUT * (runs[i + 1][0] - runs[i][1]));
      var apex = runs[i][0], best = 0;
      for (var j = runs[i][0]; j <= runs[i][1]; j++) if (abs[j] > best) { best = abs[j]; apex = j; }
      out.push({ name: "Turn " + (i + 1), i0: i0, i1: i1, apex: apex, dir: runs[i][2], peak: best });
    }
    return out;
  }

  /* A lap's turn rate at UP times the working rate (straight-line interpolation), so that laying laps
     over each other resolves time more finely than one working sample (0.05 s). */
  var UP = 3, PEN = 0.05;
  function lapSignalFine(y, start, end, fs) {
    // smooth over about half a second, then read the curve at exact times from the exact lap start
    var a = Math.max(0, Math.floor(start * fs) - 2), b = Math.min(y.length, Math.ceil(end * fs) + 3), w = Math.round(0.25 * fs), sm = new Float32Array(Math.max(b - a, 0)), i, j;
    for (i = a; i < b; i++) { var sum = 0, c = 0; for (j = Math.max(0, i - w); j <= Math.min(y.length - 1, i + w); j++) { sum += y[j]; c++; } sm[i - a] = sum / c; }
    var m = Math.max(2, Math.round((end - start) * fs * UP) + 1), out = new Float32Array(m);
    for (i = 0; i < m; i++) { var x = (start + i / (fs * UP)) * fs - a, i0 = Math.max(0, Math.min(sm.length - 2, Math.floor(x))), f = Math.max(0, Math.min(1, x - i0)); out[i] = sm[i0] * (1 - f) + sm[i0 + 1] * f; }
    return out;
  }

  /* Time of every lap through every corner of the reference lap. Returns {corners, table[lap][corner],
     maps, ref, sigs, fs}. laps: [{start,end}] in seconds; y: session turn rate at FS; ref: index of the
     reference lap. Corner indices, maps and signals are at the finer rate `fs` returned. */
  function cornerTimes(y, laps, ref, fs0) {
    fs0 = fs0 || FS;
    var fs = fs0 * UP, A = lapSignalFine(y, laps[ref].start, laps[ref].end, fs0), corners = findCorners(A, fs), table = [], maps = [], sigs = [];
    for (var k = 0; k < laps.length; k++) {
      var B = k === ref ? A : lapSignalFine(y, laps[k].start, laps[k].end, fs0), al = k === ref ? { map: Float32Array.from(A, function (_, i) { return i; }), cost: 0 } : alignLaps(A, B);
      sigs.push(B);
      if (!al) { table.push(null); maps.push(null); continue; }
      var row = [], total = laps[k].end - laps[k].start, lenB = B.length;
      for (var c = 0; c < corners.length; c++) {
        var a = c === 0 ? 0 : al.map[corners[c].i0], b = c === corners.length - 1 ? lenB : al.map[corners[c].i1];
        row.push((b - a) / fs);
      }
      // rounding of the lap ends: make the corners add up to the measured lap time exactly
      var sum = row.reduce(function (p, q) { return p + q; }, 0), f = sum > 0 ? total / sum : 1;
      table.push(row.map(function (v) { return v * f; }));
      maps.push(al);
    }
    return { corners: corners, table: table, maps: maps, ref: A, sigs: sigs, fs: fs };
  }

  /* ---------------------------------------------------------------- live position on the lap */
  /* Where is the kart on the lap right now, compared with a reference lap? Follows the reference lap's
     turn pattern sample by sample (online dynamic time warping over a small window around the current
     estimate). The reference is treated as a loop, so the tracker runs on from one lap into the next.

       ref    turn rate of the reference lap at FS, from timing point to timing point (smoothed)
       push   one smoothed turn-rate sample of the current driving, in order, at FS
       u      position reached in the reference, in samples since the tracker was anchored (keeps
              counting past the end of the lap)

     Time gained or lost = time driven since the anchor minus u / FS. On a straight nothing turns, so
     the position there is carried forward at the reference's pace and corrected at the next corner. */
  var HW = 0.5;                      // weight of the heading in the live match
  function LiveTracker(ref, fs) {
    this.ref = ref; this.n = ref.length; this.fs = fs || FS;
    var sc = 0; for (var i = 0; i < ref.length; i++) sc += Math.abs(ref[i]); this.sc = sc / Math.max(1, ref.length) || 1;
    // heading built up through the reference lap (degrees): at a given place on the track it is the same
    // on every lap whatever the speed, which the turn rate is not (a corner taken slower turns slower)
    this.H = new Float64Array(ref.length + 1); for (i = 0; i < ref.length; i++) this.H[i + 1] = this.H[i] + ref[i] / this.fs;
    this.hc = 0;                                           // heading built up by the kart since the anchor
    this.B = Math.round(1.6 * this.fs);                    // half-width of the search window
    this.D = new Float64Array(2 * this.B + 1).fill(1e9); this.D[this.B] = 0;
    this.c = 0;                                            // reference position (samples) at the window centre
    this.u = 0; this.k = 0;                                // estimate, and samples pushed
    this.lap = 0; this.kCross = 0;                         // laps of the reference completed, and when the last one ended
  }
  LiveTracker.prototype.push = function (v) {
    var B = this.B, W = 2 * B + 1, D = this.D, N = new Float64Array(W), n = this.n, ref = this.ref, sc = this.sc, PS = 0.06, i;
    this.c += 1; this.k += 1;                              // the kart is expected to advance one sample
    this.hc += v / this.fs;
    var H = this.H, Htot = H[n], hc = this.hc;
    var best = 0, bv = 1e18;
    for (i = 0; i < W; i++) {
      var pos = this.c + i - B, lapsDone = Math.floor(pos / n), pm = pos - lapsDone * n, r = ref[pm];
      var d = Math.abs(v - r) / sc + HW * Math.abs(hc - (H[pm] + lapsDone * Htot)) / 25;
      // from the same window offset one step ago (advanced with the reference), from one further on
      // (the kart stood still against the reference) or from the offset before in this step (it jumped on)
      var a = D[i], b = i + 1 < W ? D[i + 1] + PS : 1e18, e = i > 0 ? N[i - 1] + PS : 1e18;
      N[i] = d + Math.min(a, b, e);
      var biased = N[i] + 0.004 * Math.abs(i - B);         // when nothing tells (a straight), stay on pace
      if (biased < bv) { bv = biased; best = i; }
    }
    var mn = 1e18; for (i = 0; i < W; i++) if (N[i] < mn) mn = N[i];
    for (i = 0; i < W; i++) N[i] -= mn;
    // sub-sample position from the cost valley, then re-centre the window on the estimate
    var frac = 0;
    if (best > 0 && best < W - 1) { var l = N[best - 1], m = N[best], r2 = N[best + 1], den = l - 2 * m + r2; if (den > 1e-9) frac = Math.max(-0.5, Math.min(0.5, 0.5 * (l - r2) / den)); }
    var est = this.c + best - B + frac;
    var before = this.u;
    this.u += 0.35 * (est - (this.u + 1)) + 1;             // smooth: the estimate moves a third of the way each sample
    if (Math.floor(this.u / n) > this.lap) {               // passed the timing point: a new lap starts
      var edge = (this.lap + 1) * n, f = this.u > before ? (edge - before) / (this.u - before) : 1;
      this.kCross = this.k - 1 + f; this.lap += 1;
    }
    var shift = best - B;
    if (shift !== 0) {
      var S = new Float64Array(W).fill(1e9);
      for (i = 0; i < W; i++) { var src = i + shift; if (src >= 0 && src < W) S[i] = N[src]; }
      this.D = S; this.c += shift;
    } else this.D = N;
  };
  /* seconds gained (-) or lost (+) against the reference on the lap being driven */
  LiveTracker.prototype.delta = function () { return ((this.k - this.kCross) - (this.u - this.lap * this.n)) / this.fs; };
  /* seconds into the lap being driven, and its start as samples since the anchor */
  LiveTracker.prototype.lapClock = function () { return (this.k - this.kCross) / this.fs; };

  /* A smoothed signal read at an exact time (seconds), by straight-line interpolation. */
  function valueAt(sm, t, fs) { var x = t * (fs || FS), i0 = Math.max(0, Math.min(sm.length - 2, Math.floor(x))), f = Math.max(0, Math.min(1, x - i0)); return sm[i0] * (1 - f) + sm[i0 + 1] * f; }
  /* The reference lap for the tracker: the smoothed signal from its exact start, one value per working sample. */
  function referenceLap(sm, start, end, fs) { fs = fs || FS; var n = Math.max(2, Math.round((end - start) * fs)), out = new Float32Array(n); for (var i = 0; i < n; i++) out[i] = valueAt(sm, start + i / fs, fs); return out; }

  var api = { FS: FS, turnRate: turnRate, LapDetector: LapDetector, lapsFromMarks: lapsFromMarks, lapSignal: lapSignal, alignLaps: alignLaps,
              findCorners: findCorners, cornerTimes: cornerTimes, median: median, LiveTracker: LiveTracker, lapSignalFine: lapSignalFine, valueAt: valueAt, referenceLap: referenceLap };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KartCore = api;
})(typeof self !== "undefined" ? self : this);
