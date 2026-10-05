/* core.js -- the measuring part of Apex Trace Kart. No screen code here: the same file runs on the
   phone and in the test suite (node), so what is tested is what is shipped.

   Indoors there is no GPS. Everything is built on one signal the phone measures well: how fast the
   kart is turning (the gyroscope, projected on the vertical). A lap of a circuit is a fixed sequence
   of turns, so that signal repeats every lap like a fingerprint.

     LapDetector   finds the lap length from the repetition, picks the most recognisable moment of the
                   lap as its timing point, and reports every pass of it. Lap time = pass to pass, which
                   is a virtual-point interval, not necessarily an official-line lap time.
     alignLaps     lays one lap over another by matching their turn patterns (dynamic time warping), so
                   time gained or lost can be placed on the lap, corner by corner, without knowing speed.
     findCorners   splits the lap into corners from the turn rate.
*/
(function (root) {
  "use strict";

  var FS = 20;                       // Hz, working rate of the turn-rate signal
  var CUT = 0.3;                     // where a straight is cut between two corners (share of its length)

  // W3C DeviceMotionEvent: beta about X, gamma about Y, alpha about Z (deg/s).
  // Missing components are unknown, not measurements of zero.
  function browserRotation(r) {
    if (!r || ![r.beta, r.gamma, r.alpha].every(Number.isFinite)) return null;
    return [r.beta, r.gamma, r.alpha];
  }

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
  function turnRate(w, up, c) {
    var plain = w[0] * up[0] + w[1] * up[1] + w[2] * up[2];
    if (!c) {                                          // the usual case: the column along the phone's z axis
      var h2 = up[0] * up[0] + up[1] * up[1];
      if (h2 <= 0.12) return plain;
      var k = Math.min(1, (h2 - 0.12) / 0.18);
      return plain + k * ((w[0] * up[0] + w[1] * up[1]) / h2 - plain);
    }
    // c: the direction of the steering column in the phone's axes, when the phone is not square on the wheel
    var wc = w[0] * c[0] + w[1] * c[1] + w[2] * c[2], uc = up[0] * c[0] + up[1] * c[1] + up[2] * c[2];
    var ux = up[0] - uc * c[0], uy = up[1] - uc * c[1], uz = up[2] - uc * c[2], g2 = ux * ux + uy * uy + uz * uz;
    if (g2 <= 0.12) return plain;
    var k2 = Math.min(1, (g2 - 0.12) / 0.18);
    return plain + k2 * (((w[0] - wc * c[0]) * ux + (w[1] - wc * c[1]) * uy + (w[2] - wc * c[2]) * uz) / g2 - plain);
  }

  /* Where the steering column points in the phone's own axes.
     The phone turns in two ways: with the kart (slowly, corner by corner) and with the steering wheel
     (quickly: every correction of the hands). The quick part of its rotation is therefore almost all
     about the steering column. So: take the rotation-rate samples, remove their slow part, and find the
     direction along which what is left is strongest. This uses the gyroscope only, so an imperfect
     "level" in corners does not disturb it.
     ws: array of [x, y, z] rotation rates (deg/s) at `rate` samples a second. Returns a unit vector, or
     null when no direction stands out (a phone on a fixed mount, or too little driving): the phone's z
     axis is then used, which is right for a phone lying square in the plane of the wheel. */
  function mountAxis(ws, rate) {
    var n = ws.length, i, k, half = Math.max(2, Math.round(0.25 * (rate || 60)));
    if (n < 40 * half) return null;
    var cx = new Float64Array(n + 1), cy = new Float64Array(n + 1), cz = new Float64Array(n + 1);
    for (i = 0; i < n; i++) { cx[i + 1] = cx[i] + ws[i][0]; cy[i + 1] = cy[i] + ws[i][1]; cz[i + 1] = cz[i] + ws[i][2]; }
    var a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, m = 0;     // covariance [[a,b,c],[b,d,e],[c,e,f]] of the quick part
    for (i = half; i < n - half; i++) {
      var w0 = i - half, w1 = i + half + 1, len = w1 - w0;
      var x = ws[i][0] - (cx[w1] - cx[w0]) / len, y = ws[i][1] - (cy[w1] - cy[w0]) / len, z = ws[i][2] - (cz[w1] - cz[w0]) / len;
      a += x * x; b += x * y; c += x * z; d += y * y; e += y * z; f += z * z; m++;
    }
    var A = [[a / m, b / m, c / m], [b / m, d / m, e / m], [c / m, e / m, f / m]], V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], it, p, q;
    for (it = 0; it < 30; it++) {                            // Jacobi rotations: eigenvectors of a symmetric 3x3
      p = 0; q = 1; if (Math.abs(A[0][2]) > Math.abs(A[p][q])) { p = 0; q = 2; } if (Math.abs(A[1][2]) > Math.abs(A[p][q])) { p = 1; q = 2; }
      if (Math.abs(A[p][q]) < 1e-12) break;
      var th = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]), cs = Math.cos(th), sn = Math.sin(th);
      for (k = 0; k < 3; k++) { var akp = A[k][p], akq = A[k][q]; A[k][p] = cs * akp - sn * akq; A[k][q] = sn * akp + cs * akq; }
      for (k = 0; k < 3; k++) { var apk = A[p][k], aqk = A[q][k]; A[p][k] = cs * apk - sn * aqk; A[q][k] = sn * apk + cs * aqk; }
      for (k = 0; k < 3; k++) { var vkp = V[k][p], vkq = V[k][q]; V[k][p] = cs * vkp - sn * vkq; V[k][q] = sn * vkp + cs * vkq; }
    }
    var ev = [A[0][0], A[1][1], A[2][2]], order = [0, 1, 2].sort(function (x1, y1) { return ev[y1] - ev[x1]; }), hi = order[0], mid = order[1];
    // one direction must clearly stand out, and by more than sensor noise
    if (ev[hi] < 225 || ev[hi] < 5 * Math.max(ev[mid], 1e-9)) return null;
    var ax = [V[0][hi], V[1][hi], V[2][hi]], s = ax[2] < 0 ? -1 : 1, nn = Math.sqrt(ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2]) || 1;
    return { axis: [s * ax[0] / nn, s * ax[1] / nn, s * ax[2] / nn], strength: Math.sqrt(ev[hi]), ratio: ev[hi] / Math.max(ev[mid], 1e-9) };
  }

  /* ---------------------------------------------------------------- forces, speed and distance */
  /* The force on the kart, split into "forward" (+ accelerating, - braking) and "sideways" (+ towards the
     left), in m/s2, from the phone's acceleration with gravity removed (lin) and the direction of "up"
     (both in the phone's own axes).
     The phone turns with the wheel, so its own axes say nothing fixed about the kart. But the steering
     column does: it leans back towards the driver in the kart's fore-and-aft plane whatever the wheel
     angle, and a phone lying in the plane of the wheel has the column along its z axis (out of the
     screen, towards the driver). So the level part of the phone's z axis points to the back of the kart.
     Returns null when the screen faces straight up or down (no level part to go by).
     c: the direction of the column in the phone's axes when it is not the z axis (see mountAxis). */
  function kartForces(lin, up, c) {
    var cx = c ? c[0] : 0, cy = c ? c[1] : 0, cz = c ? c[2] : 1, uc = up[0] * cx + up[1] * cy + up[2] * cz;
    var bx = cx - uc * up[0], by = cy - uc * up[1], bz = cz - uc * up[2], n = Math.sqrt(bx * bx + by * by + bz * bz);
    if (n < 0.35) return null;
    var fx = -bx / n, fy = -by / n, fz = -bz / n;                                  // forward
    var lx = up[1] * fz - up[2] * fy, ly = up[2] * fx - up[0] * fz, lz = up[0] * fy - up[1] * fx;   // left = up x forward
    return [lin[0] * fx + lin[1] * fy + lin[2] * fz, lin[0] * lx + lin[1] * ly + lin[2] * lz];
  }

  /* Brings any stream of samples to the working rate (the same averaging as the lap detector's). */
  function Slots(fs) { this.fs = fs || FS; this.v = []; this._acc = 0; this._n = 0; this._next = 0; }
  Slots.prototype.push = function (t, x) {
    var silent = Math.floor(t * this.fs) - this._next > Math.round(0.5 * this.fs);
    while (t >= (this._next + 1) / this.fs) {
      this.v.push(this._n ? this._acc / this._n : (silent ? 0 : (this.v.length ? this.v[this.v.length - 1] : 0)));
      this._acc = 0; this._n = 0; this._next++;
    }
    if (isFinite(x)) { this._acc += x; this._n++; }
  };

  /* SPEED WITHOUT GPS. Two things the phone measures say something about speed:
       in a corner     speed = sideways force / turn rate          (an absolute value, but only while turning)
       everywhere      change of speed = forward force x time      (always there, but it drifts)
     They are combined the standard way (a Kalman filter run forwards, then smoothed backwards over the
     whole recording): the forward force carries the speed along, each corner corrects it, and a slow
     error of the forward force (the phone's idea of "level" is never perfect) is estimated on the way.
     The result is an ESTIMATE. Its accuracy on a real kart is not yet known.

       yaw     turn rate, deg/s, at fs          alat, alon   sideways and forward force, m/s2, at fs
       opts    lever: how far the phone sits ahead of the kart's rear axle, m (the kart's turning adds
               to what it feels there)
     Returns {v: speed m/s per sample, sd: its uncertainty, flipped, bias}. */
  var SPD = { sa: 0.5, sb: 0.04, st: 0.06, sl: 0.7, lever: 0.6 };
  function speedPrep(yaw, alat, alon, fs, opts) {
    var n = Math.min(yaw.length, alat.length, alon.length), lever = opts && opts.lever !== undefined ? opts.lever : SPD.lever, i, D2R = Math.PI / 180;
    var w = new Float64Array(n), lat = new Float64Array(n), lon = new Float64Array(n), wd = new Float64Array(n), sm = 2;
    function smooth(src, k0) { var cc = new Float64Array(n + 1), out = new Float64Array(n), k; for (k = 0; k < n; k++) cc[k + 1] = cc[k] + (isFinite(src[k]) ? src[k] * k0 : 0); for (k = 0; k < n; k++) { var a2 = Math.max(0, k - sm), b2 = Math.min(n, k + sm + 1); out[k] = (cc[b2] - cc[a2]) / (b2 - a2); } return out; }
    w = smooth(yaw, D2R);
    var la = smooth(alat, 1), lo = smooth(alon, 1), s = 0;
    for (i = 0; i < n; i++) s += la[i] * w[i];
    // a sideways force and a turn must point the same way (force = speed x turn rate, speed is positive):
    // if they do not, the phone faces the other way round, and forward is backward too
    var flip = s < 0 ? -1 : 1;
    for (i = 0; i < n; i++) {
      var i1 = Math.min(n - 1, i + 2), i0 = Math.max(0, i - 2);
      wd[i] = (w[i1] - w[i0]) * fs / (i1 - i0 || 1);
      lat[i] = flip * la[i] - lever * wd[i];          // take out what the phone feels from being ahead of the kart's centre
      lon[i] = flip * lo[i] + lever * w[i] * w[i];
    }
    // how noisy the turn rate still is after the smoothing above (rad/s), from how far each sample sits from its neighbours
    var d2 = [], sw = 0;
    for (i = 1; i < n - 1; i++) d2.push(Math.abs(yaw[i] - 0.5 * (yaw[i - 1] + yaw[i + 1])));
    if (d2.length) sw = median(d2) * 1.4826 / Math.sqrt(1.5) / Math.sqrt(2 * sm + 1) * D2R;
    return { n: n, w: w, wd: wd, lat: lat, lon: lon, flipped: flip < 0, lever: lever, sw: sw };
  }
  /* The filter. State: speed v, the slow error of the forward force (bl) and of the sideways force (bt).
       each step        v grows by (forward force - bl) x time
       each sample      sideways force = v x turn rate + bt        (the corner relation; on a straight it shows bt)
     Run forwards, then smoothed backwards over the whole recording (Rauch-Tung-Striebel). */
  function estimateSpeed(yaw, alat, alon, fs, opts) {
    fs = fs || FS;
    var P = speedPrep(yaw, alat, alon, fs, opts), n = P.n, dt = 1 / fs, i, r, c, k;
    var Q = [Math.pow(SPD.sa, 2) * dt, Math.pow(SPD.sb, 2) * dt, Math.pow(SPD.st, 2) * dt];
    var xf = new Float64Array(3 * n), Pf = new Float64Array(9 * n), xp = new Float64Array(3 * n), Pp = new Float64Array(9 * n);
    var x = [0, 0, 0], M = [4, 0, 0, 0, 0.3, 0, 0, 0, 0.3];
    function mul(A, B) { var o = new Array(9); for (r = 0; r < 3; r++) for (c = 0; c < 3; c++) { var t = 0; for (k = 0; k < 3; k++) t += A[r * 3 + k] * B[k * 3 + c]; o[r * 3 + c] = t; } return o; }
    function tr(A) { return [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]]; }
    function inv(A) {
      var a = A[0], b = A[1], cc = A[2], d = A[3], e = A[4], f = A[5], g = A[6], h = A[7], ii = A[8];
      var A0 = e * ii - f * h, B0 = -(d * ii - f * g), C0 = d * h - e * g, det = a * A0 + b * B0 + cc * C0; if (Math.abs(det) < 1e-18) det = 1e-18;
      return [A0 / det, -(b * ii - cc * h) / det, (b * f - cc * e) / det, B0 / det, (a * ii - cc * g) / det, -(a * f - cc * d) / det, C0 / det, -(a * h - b * g) / det, (a * e - b * d) / det];
    }
    var F = [1, -dt, 0, 0, 1, 0, 0, 0, 1], Ft = tr(F);
    for (i = 0; i < n; i++) {
      x = [x[0] + (P.lon[i] - x[1]) * dt, x[1], x[2]];
      M = mul(mul(F, M), Ft); M[0] += Q[0]; M[4] += Q[1]; M[8] += Q[2];
      for (k = 0; k < 3; k++) xp[3 * i + k] = x[k];
      for (k = 0; k < 9; k++) Pp[9 * i + k] = M[k];
      // measurement: lat = w v + bt. The turn rate w is itself noisy, and a noisy w on the right-hand side would pull
      // v towards zero. So: where w is not clear of its own noise (a straight) it tells nothing about v, only about bt;
      // elsewhere its noise is allowed for, in the value used and in how far the measurement is trusted.
      var w = P.w[i], sw2 = P.sw * P.sw, use = Math.abs(w) >= 3 * P.sw, H0 = use ? w : 0, H2 = 1, wp = use ? w - sw2 / w : 0;
      var PH = [M[0] * H0 + M[2] * H2, M[3] * H0 + M[5] * H2, M[6] * H0 + M[8] * H2];
      var R = Math.pow(SPD.sl, 2) + Math.pow(0.3 * P.wd[i], 2) + sw2 * x[0] * x[0], S = H0 * PH[0] + H2 * PH[2] + R, inn = P.lat[i] - (wp * x[0] + x[2]);
      var K0 = PH[0] / S, K1 = PH[1] / S, K2 = PH[2] / S;
      x = [x[0] + K0 * inn, x[1] + K1 * inn, x[2] + K2 * inn];
      var HP = [H0 * M[0] + H2 * M[6], H0 * M[1] + H2 * M[7], H0 * M[2] + H2 * M[8]], Kv = [K0, K1, K2], N = new Array(9);
      for (r = 0; r < 3; r++) for (c = 0; c < 3; c++) N[r * 3 + c] = M[r * 3 + c] - Kv[r] * HP[c];
      M = N; M[1] = M[3] = 0.5 * (M[1] + M[3]); M[2] = M[6] = 0.5 * (M[2] + M[6]); M[5] = M[7] = 0.5 * (M[5] + M[7]);
      for (k = 0; k < 3; k++) xf[3 * i + k] = x[k];
      for (k = 0; k < 9; k++) Pf[9 * i + k] = M[k];
    }
    var out = new Float32Array(n), sd = new Float32Array(n), xs = [0, 0, 0], Ps = new Array(9);
    if (n) { for (k = 0; k < 3; k++) xs[k] = xf[3 * (n - 1) + k]; for (k = 0; k < 9; k++) Ps[k] = Pf[9 * (n - 1) + k]; out[n - 1] = Math.max(0, xs[0]); sd[n - 1] = Math.sqrt(Math.max(Ps[0], 0)); }
    for (i = n - 2; i >= 0; i--) {
      var Pfi = Array.prototype.slice.call(Pf, 9 * i, 9 * i + 9), Ppn = Array.prototype.slice.call(Pp, 9 * (i + 1), 9 * (i + 1) + 9);
      var C = mul(mul(Pfi, Ft), inv(Ppn)), dx = [xs[0] - xp[3 * (i + 1)], xs[1] - xp[3 * (i + 1) + 1], xs[2] - xp[3 * (i + 1) + 2]], nx = [0, 0, 0];
      for (r = 0; r < 3; r++) nx[r] = xf[3 * i + r] + C[r * 3] * dx[0] + C[r * 3 + 1] * dx[1] + C[r * 3 + 2] * dx[2];
      var D = new Array(9); for (k = 0; k < 9; k++) D[k] = Ps[k] - Ppn[k];
      var CD = mul(mul(C, D), tr(C)); for (k = 0; k < 9; k++) Ps[k] = Pfi[k] + CD[k];
      xs = nx;
      out[i] = Math.max(0, xs[0]); sd[i] = Math.sqrt(Math.max(Ps[0], 0));
    }
    return { v: out, sd: sd, flipped: P.flipped, bias: n ? [xf[3 * (n - 1) + 1], xf[3 * (n - 1) + 2]] : [0, 0], fs: fs };
  }
  /* From a recording to the three signals the speed estimate needs, at the working rate.
     rec: flat array of rows, nc values each, as the app stores them:
          [t, lin x y z, with-gravity x y z, rotation x y z, ...]
     First the direction of the steering column in the phone's axes is found (mountAxis); then, sample by
     sample, the turn rate and the forward and sideways forces are worked out with it.
     Returns {yaw, lat, lon (arrays at fs), axis (or null), offSquare (deg), usable (share of samples with
     a usable phone position), rate}. */
  function motion(rec, nc, fs) {
    fs = fs || FS;
    var n = Math.floor(rec.length / nc), i, ws = [];
    if (n < 2) return { yaw: [], lat: [], lon: [], axis: null, offSquare: 0, usable: 0, rate: 0 };
    var rate = (n - 1) / Math.max(1e-6, rec[(n - 1) * nc] - rec[0]);
    for (i = 0; i < n; i++) ws.push([rec[i * nc + 7], rec[i * nc + 8], rec[i * nc + 9]]);
    var ma = mountAxis(ws, rate), c = ma ? ma.axis : null, off = c ? Math.acos(Math.min(1, c[2])) * 180 / Math.PI : 0;
    // A phone on a wheel lies roughly in the wheel's plane. A "column" far from the phone's z axis is not one: it is
    // vibration about one axis, or the kart's own turning seen by a phone on a fixed mount. Then z is used.
    if (c && off > 35) { c = null; ma = null; off = 0; }
    if (c && off < 2) c = null;                               // square on the wheel within the method's own precision
    var sy = new Slots(fs), sa = new Slots(fs), so = new Slots(fs), ok = 0;
    for (i = 0; i < n; i++) {
      var o = i * nc, t = rec[o], lin = [rec[o + 1], rec[o + 2], rec[o + 3]];
      var gx = rec[o + 4] - lin[0], gy = rec[o + 5] - lin[1], gz = rec[o + 6] - lin[2], gn = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1, up = [gx / gn, gy / gn, gz / gn];
      var f = kartForces(lin, up, c);
      sy.push(t, turnRate(ws[i], up, c));
      if (f) { ok++; sa.push(t, f[1]); so.push(t, f[0]); } else { sa.push(t, NaN); so.push(t, NaN); }
    }
    return { yaw: sy.v, lat: sa.v, lon: so.v, axis: c, offSquare: off, found: !!ma, usable: ok / n, rate: rate };
  }

  /* Distance covered between two times (s), from a speed trace at fs. */
  function distanceBetween(v, t0, t1, fs) {
    fs = fs || FS;
    var a = Math.max(0, t0 * fs - 0.5), b = Math.min(v.length - 1, t1 * fs - 0.5), s = 0, i0 = Math.ceil(a), i1 = Math.floor(b), i;   // sample i sits at (i + 0.5)/fs
    if (b <= a) return 0;
    for (i = i0; i < i1; i++) s += 0.5 * (v[i] + v[i + 1]) / fs;
    if (i0 > a && i0 <= i1) s += (i0 - a) * v[Math.max(0, i0 - 1)] / fs * 0.5 + (i0 - a) * v[i0] / fs * 0.5;
    if (i1 < b && i1 >= i0) s += (b - i1) * v[i1] / fs * 0.5 + (b - i1) * v[Math.min(v.length - 1, i1 + 1)] / fs * 0.5;
    return s;
  }

  /* ---------------------------------------------------------------- lap detector */
  function LapDetector(opts) {
    opts = opts || {};
    this.fs = FS;
    this.minLap = opts.minLap || 6;          // s: include short indoor laps
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
    this.gaps = []; this.lastSample = null;
    this.patternCandidate = null; this.discontinuities = [];
  }

  /* Feed raw samples: t in seconds from the start, turn rate in deg/s (any rate >= 20 Hz). */
  LapDetector.prototype.push = function (t, yaw) {
    if (!Number.isFinite(t) || !Number.isFinite(yaw) || t < 0 ||
        (this.lastSample !== null && t <= this.lastSample)) return false;
    if (this.lastSample !== null && t - this.lastSample > 0.5) this.gaps.push([this.lastSample, t]);
    this.lastSample = t;
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
  LapDetector.prototype.hasGap = function (start, end) {
    return this.gaps.some(function (g) { return g[0] < end && g[1] > start; });
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
    var first = this.wins[0], last = this.wins[this.wins.length - 1];
    for (var c = cLo; c <= cHi; c++) {
      var v = this._coarse(s, c, stretch);
      if (this.cycle && v >= this.thrLo) {
        var a = c > last ? last : c, e = c > last ? c : first;
        if (this._cycleScore(s, a, e) < 0.6) continue;
      }
      if (!b || v > b.v) b = { c: c, v: v };
    }
    return b;
  };

  // A local corner can look like another corner. Verify the complete ordered cycle before
  // accepting a normal interval. Correlation is a match diagnostic, not an error bound.
  LapDetector.prototype._cycleScore = function (s, a, b) {
    if (!this.cycle || b <= a) return 1;
    if (this.hasGap(a / this.fs, b / this.fs)) return -1;
    var T = this.cycle, m = T.length, V = new Float32Array(m);
    for (var j = 0; j < m; j++) {
      var x = a + (b - a) * j / m, i = Math.floor(x), f = x - i;
      if (i < 0 || i + 1 >= s.length) return -1;
      V[j] = s[i] * (1 - f) + s[i + 1] * f;
    }
    var st = stats(T); return ncc(T, V, 0, st.mean, st.norm);
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
        if (v >= this.thrHi && (!this.cycle || this._cycleScore(s, last, c) >= 0.6)) {
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
    var fs = this.fs, lo = Math.round(this.minLap * fs), hi = Math.round(this.maxLap * fs), p, method, t;
    var hp = this._headingPeriod(s);
    if (hp) {
      // sharpen with the repetition of the turn pattern, close to the heading's answer only
      p = this._repeatPeriod(s, Math.max(lo, Math.round(0.93 * hp.L)), Math.min(hi, Math.round(1.07 * hp.L)), false);
      if (!p || p.r < 0.35) p = { L: hp.L, r: 0.35 };
      method = "heading";
      t = this._chooseTemplate(s, p.L);
    } else {
      t = null;
    }
    // A phone's gravity estimate can change the measured yaw scale. A net-turn rule must not
    // veto clear repetition. Use recent windows so warm-up laps do not hide later steady laps.
    // This recognises a motion cycle; it does not establish metres or a geographic timing line.
    if (!t || t.score < 0.1 || t.own < 0.6) {
      var candidate = null, self = this;
      [90, 120, 180, 300].forEach(function (seconds) {
        var off = Math.max(0, s.length - seconds * fs), ss = s.subarray(off);
        if (self.hasGap(off / fs, s.length / fs)) return;
        var pp = self._repeatPeriod(ss, lo, Math.min(hi, Math.floor(ss.length / 3.1)), true);
        if (!pp || pp.r < 0.75) return;
        var tt = self._chooseTemplate(ss, pp.L);
        if (!tt || tt.score < 0.12 || tt.own < 0.8) return;
        var merit = pp.r + tt.score;
        if (!candidate || merit > candidate.merit) {
          tt.c += off; candidate = { p: pp, t: tt, merit: merit, start: off };
        }
      });
      if (!candidate) { this.patternCandidate = null; return false; }
      var previous = this.patternCandidate;
      this.patternCandidate = { L: candidate.p.L, at: s.length };
      // Two separate live evaluations must agree; a final pass can use three full repetitions.
      if (!final && (!previous || Math.abs(previous.L - candidate.p.L) > 0.1 * candidate.p.L)) return false;
      p = candidate.p; t = candidate.t; method = "repetition";
    }
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
    this.patternStart = method === "repetition" ? candidate.start : 0;
    this.cycle = null;
    if (method === "repetition" && t.c >= p.L) {
      this.cycle = new Float32Array(160);
      for (var ci = 0; ci < this.cycle.length; ci++) {
        var cx = t.c - p.L + p.L * ci / this.cycle.length, ii = Math.floor(cx), cf = cx - ii;
        this.cycle[ci] = s[ii] * (1 - cf) + s[ii + 1] * cf;
      }
    }
    // back-fill: follow the timing point back to the start of the recording, one lap at a time
    for (;;) {
      var first = this.wins[0], b = this._best(s, first - 1.22 * this.period, first - 0.82 * this.period);
      if (first - 1.3 * this.period < this.patternStart || first - 0.82 * this.period < 0.8 * this.pre) break;
      if (!b || b.v < this.thrLo) { b = this._best(s, first - 1.3 * this.period, first - 0.82 * this.period, true); if (!b || b.v < this.thrHi) break; }
      this._accept(s, b.c, b.v, false);
    }
    this._track(s, final);
    if (this.passes.length < (method === "repetition" ? 3 : 2)) { this.period = null; this.template = null; this.passes = []; this.scores = []; this.wins = []; return false; }
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
                   thrHi: this.thrHi, thrLo: this.thrLo, wins: this.wins, passes: this.passes, scores: this.scores, quality: this.quality, method: this.method, cycle: this.cycle, patternStart: this.patternStart };
      this.period = null;
      if (this._lock(sm, false)) {
        var boundary = this.passes[0], count = 0;
        while (count < keep.passes.length && keep.passes[count] < boundary - 0.5 * this.period) count++;
        if (count) {
          this.discontinuities.push([keep.passes[count - 1] / fs, boundary / fs]);
          this.passes = keep.passes.slice(0, count).concat(this.passes);
          this.wins = keep.wins.slice(0, count).concat(this.wins);
          this.scores = keep.scores.slice(0, count).concat(this.scores);
        }
        this.relearned = (this.relearned || 0) + 1; return true;
      }
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
      var start = this.passes[i - 1] / fs, end = this.passes[i] / fs;
      var gap = this.hasGap(start, end), transition = this.discontinuities.some(function (d) { return d[0] < end && d[1] > start; });
      out.push({ n: i, start: start, end: end, time: tt, interrupted: gap || transition || tt > 1.45 * med,
        reason: gap ? "sensor gap" : transition ? "pattern reacquisition" : tt > 1.45 * med ? "long interval" : null,
        matchScore: Math.min(this.scores[i - 1], this.scores[i]), timingBasis: "motion pattern", accuracyValidated: false });
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

  /* Marks placed by a tap or by GPS say WHICH lap, to a few tenths of a second. The turn pattern says WHEN, far
     more finely: the kart turns the same way every time it passes the same place. So take the turn-rate signal
     around one mark as the model, and move every other mark (by at most `reach` seconds) to where the signal
     around it fits the model best. Lap times are then pass-to-pass times of one place on the track.
     A mark whose surroundings do not fit (a lap at a very different pace, a spin) is left where it was.
     y: turn rate at fs. Returns {marks, moved (how many), shift (typical move, s)}. */
  function refineMarks(y, marks, fs, reach, useRef) {
    fs = fs || FS; reach = reach || 1.5;
    var n = y.length, m = marks.slice(), i, k;
    if (m.length < 3 || n < 20 * fs) return { marks: m, moved: 0, shift: 0 };
    var w = Math.round(0.3 * fs), sm = new Float32Array(n), c = new Float64Array(n + 1);
    for (i = 0; i < n; i++) c[i + 1] = c[i] + (isFinite(y[i]) ? y[i] : 0);
    for (i = 0; i < n; i++) { var a0 = Math.max(0, i - w), b0 = Math.min(n, i + w + 1); sm[i] = (c[b0] - c[a0]) / (b0 - a0); }
    var times = []; for (i = 1; i < m.length; i++) times.push(m[i] - m[i - 1]);
    var med = median(times), h = Math.round(Math.min(6, Math.max(2.5, 0.15 * med)) * fs), len = 2 * h + 1, S = Math.round(reach * fs);
    // the signal from o0 to o0 + L - 1 samples around `center`, time stretched by a about the centre
    function win(center, a, buf, o0, L) {
      var start = center + o0 * a; if (start < 0 || start + (L - 1) * a >= n - 1) return false;
      for (var q = 0; q < L; q++) { var x = start + q * a, i0 = Math.floor(x), f = x - i0; buf[q] = sm[i0] * (1 - f) + sm[i0 + 1] * f; }
      return true;
    }
    // the model: the mark with the most ordinary laps on both sides
    var ref = -1, bestD = 1e9, buf = new Float32Array(len);
    for (i = 0; i < m.length; i++) {
      var d = (i > 0 ? Math.abs(times[i - 1] - med) : 0.5 * med) + (i < times.length ? Math.abs(times[i] - med) : 0.5 * med);
      if (d < bestD && win(m[i] * fs, 1, buf, -h, len)) { bestD = d; ref = i; }
    }
    if (useRef !== undefined && useRef >= 0 && useRef < m.length) ref = useRef;
    if (ref < 0) return { marks: m, moved: 0, shift: 0 };
    var T0 = new Float32Array(len), M0 = win(m[ref] * fs, 1, T0, -h, len) ? { o0: -h, L: len, T: T0, st: stats(T0) } : null;
    if (!M0 || M0.st.norm < 3 * Math.sqrt(len)) return { marks: m, moved: 0, shift: 0 };      // nothing happens around the line: no pattern to go by
    function fit(M, c0) {
      var best = { v: -2, pos: 0, a: 1 }, b2 = new Float32Array(M.L);
      for (var a = 0.97; a <= 1.031; a += 0.03) {
        var sc = [], bi = -1;
        for (k = -S; k <= S; k++) { var v = win(c0 + k, a, b2, M.o0, M.L) ? ncc(M.T, b2, 0, M.st.mean, M.st.norm) : -2; sc.push(v); if (bi < 0 || v > sc[bi]) bi = sc.length - 1; }
        if (sc[bi] <= best.v) continue;
        var edge = bi === 0 || bi === sc.length - 1, l = edge ? -2 : sc[bi - 1], r = edge ? -2 : sc[bi + 1], den = l - 2 * sc[bi] + r;
        var frac = (l > -2 && r > -2 && Math.abs(den) > 1e-9) ? Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / den)) : 0;
        best = { v: sc[bi], pos: (bi - S + frac) / fs, a: a, edge: edge };
      }
      return best;
    }
    // A mark is only moved when the stretch around it fits very well AT THE USUAL PACE (within 3%). If the kart came
    // to the line clearly slower or faster than on the model pass (a poor last corner, traffic, the first pass after
    // the pits), a looser fit would shift part of that time into the next lap: the mark then stays where the tap or
    // the GPS put it.
    var moved = 0, shifts = [], sharp = m.map(function () { return false; }); sharp[ref] = true;
    for (i = 0; i < m.length; i++) {
      if (i === ref) continue;
      var got = fit(M0, m[i] * fs);
      if (refineMarks.debug) refineMarks.debug.push([i, got.v, got.pos, got.a]);
      if (got.v >= 0.85 && !got.edge) { m[i] = marks[i] + got.pos; moved++; shifts.push(Math.abs(got.pos)); sharp[i] = true; }
    }
    for (i = 1; i < m.length; i++) if (m[i] <= m[i - 1] + 1) return { marks: marks.slice(), moved: 0, shift: 0 };   // never let marks cross
    return { marks: m, moved: moved, shift: shifts.length ? median(shifts) : 0, ref: ref, sharp: sharp };
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


  /* ---------------------------------------------------------------- GPS: a track made once, laps timed at its line */
  /* Position in metres east and north of a reference point (flat-earth; exact enough over a kart track). */
  function toLocal(lat0, lon0, lat, lon) {
    var k = Math.PI / 180, R = 6371000;
    return [(lon - lon0) * k * R * Math.cos(lat0 * k), (lat - lat0) * k * R];
  }
  /* A track from the fixes of one lap that STARTS ON THE START/FINISH LINE (walking, or slowly in the kart).
     fixes: [[t, lat, lon, accuracy m], ...] in time order. start: [lat, lon] of the line (where the phone
     stood when the lap was started); the first fix is used when it is not given.
     The line is a gate through that point, square to the direction in which the lap leaves it.
     Returns {line: {lat, lon, dir}, length m, acc (typical accuracy m), n, gap (m from the last fix back to
     the line), path: [[east, north], ...]} or {error: text}. */
  function trackFromFixes(fixes, start) {
    var f = fixes.filter(function (p) { return p && isFinite(p[1]) && isFinite(p[2]); });
    if (f.length < 5) return { error: "Too few positions were received to make a track." };
    var lat0 = start ? start[0] : f[0][1], lon0 = start ? start[1] : f[0][2], i, pts = [], acc = [];
    for (i = 0; i < f.length; i++) { pts.push(toLocal(lat0, lon0, f[i][1], f[i][2])); if (isFinite(f[i][3]) && f[i][3] !== null) acc.push(f[i][3]); }
    // a position wobbles by metres even when standing. Average each with its neighbours, then only count a step
    // once it is clearly a move (further than the wobble).
    var sm = [], am = acc.length ? median(acc) : 5, d0 = Math.max(3, 0.8 * am), keep = [[0, 0]], len = 0, far = 0;
    // (walking, positions are a metre or two apart and need it; driven, they are far apart and averaging would cut the corners)
    var steps = []; for (i = 1; i < pts.length; i++) steps.push(Math.sqrt(Math.pow(pts[i][0] - pts[i - 1][0], 2) + Math.pow(pts[i][1] - pts[i - 1][1], 2)));
    var ms = median(steps), hw = ms >= 4 ? 0 : ms >= 2 ? 1 : 2;
    for (i = 0; i < pts.length; i++) { var x = 0, y = 0, c = 0; for (var j = Math.max(0, i - hw); j <= Math.min(pts.length - 1, i + hw); j++) { x += pts[j][0]; y += pts[j][1]; c++; } sm.push([x / c, y / c]); }
    for (i = 0; i < sm.length; i++) {
      var last = keep[keep.length - 1], dx = sm[i][0] - last[0], dy = sm[i][1] - last[1], d = Math.sqrt(dx * dx + dy * dy);
      if (d >= d0) { len += d; keep.push(sm[i]); }
      far = Math.max(far, Math.sqrt(sm[i][0] * sm[i][0] + sm[i][1] * sm[i][1]));
    }
    if (keep.length < 4 || far < 10) return { error: "The lap is too short to make a track: the positions never moved more than " + far.toFixed(0) + " m from the line." };
    // direction of travel leaving the line: the average direction to the first points 8 to 30 m away
    // (the first ones only, 8 to 12 m out: further on the track has already started to turn)
    var dir = null, sx = 0, sy = 0, gone = 0, rmax = 0;
    for (i = 1; i < keep.length; i++) {
      gone += Math.sqrt(Math.pow(keep[i][0] - keep[i - 1][0], 2) + Math.pow(keep[i][1] - keep[i - 1][1], 2));
      var r = Math.sqrt(keep[i][0] * keep[i][0] + keep[i][1] * keep[i][1]);
      if (r < rmax - 2 || ((r > 12.5 || gone > 16) && (sx !== 0 || sy !== 0))) break;
      rmax = Math.max(rmax, r);
      if (r >= 8) { sx += keep[i][0] / r; sy += keep[i][1] / r; }
    }
    if (sx !== 0 || sy !== 0) dir = Math.atan2(sx, sy) * 180 / Math.PI;
    if (dir === null) return { error: "The direction of the lap could not be found." };
    var end = keep[keep.length - 1], gap = Math.sqrt(end[0] * end[0] + end[1] * end[1]);
    // How wide the gate may be. The phone's position can be several metres out, so the gate should be wide; but
    // another part of the track that goes through the same line in the same direction must stay outside it.
    var ux = Math.sin(dir * Math.PI / 180), uy = Math.cos(dir * Math.PI / 180), near = 1e9, run = 0;
    for (i = 1; i < keep.length; i++) {
      run += Math.sqrt(Math.pow(keep[i][0] - keep[i - 1][0], 2) + Math.pow(keep[i][1] - keep[i - 1][1], 2));
      if (run < 25 || len - run < 25) continue;                         // the line's own surroundings
      var a0 = keep[i - 1][0] * ux + keep[i - 1][1] * uy, a1 = keep[i][0] * ux + keep[i][1] * uy;
      if (a0 < 0 && a1 >= 0) { var ff = -a0 / (a1 - a0), c0 = keep[i - 1][0] * uy - keep[i - 1][1] * ux, c1 = keep[i][0] * uy - keep[i][1] * ux; near = Math.min(near, Math.abs(c0 + ff * (c1 - c0))); }
    }
    var half = Math.max(6, Math.min(25, 0.45 * near));
    return { line: { lat: lat0, lon: lon0, dir: dir, half: Math.round(half * 10) / 10 }, length: len + gap, acc: acc.length ? median(acc) : null, n: f.length, gap: gap,
             path: keep.map(function (q) { return [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]; }) };
  }
  /* Times each pass of the line from the phone's positions (about one a second).
     A pass is two positions in a row with the line between them, going the way the track was made, and
     close enough to the line's centre (half, m). Its time is placed between the two positions in
     proportion to their distances from the line. Positions the phone itself calls poor are left out.
     push(t, lat, lon, acc) returns the time of a pass, or null. */
  function GpsTimer(line, opts) {
    opts = opts || {};
    this.line = line; this.half = opts.half || line.half || 12; this.maxAcc = opts.maxAcc || 20; this.minLap = opts.minLap || 8;
    var a = line.dir * Math.PI / 180; this.dx = Math.sin(a); this.dy = Math.cos(a);
    this.prev = null; this.marks = []; this.acc = null; this.lastT = null; this.dist = null;
  }
  GpsTimer.prototype.push = function (t, lat, lon, acc, speed) {
    if (!isFinite(lat) || !isFinite(lon) || lat === null || lon === null || !isFinite(t)) return null;
    if (this.lastT !== null && t <= this.lastT) return null;                 // an old or repeated position: ignored, the last good one stays
    this.acc = isFinite(acc) && acc !== null ? acc : null; this.lastT = t;
    var p = toLocal(this.line.lat, this.line.lon, lat, lon), along = p[0] * this.dx + p[1] * this.dy, across = p[0] * this.dy - p[1] * this.dx;
    this.dist = Math.sqrt(p[0] * p[0] + p[1] * p[1]);
    if (this.acc === null || this.acc < 0 || this.acc > this.maxAcc) return null;          // a poor position: not used, and not kept as the "previous" one
    var q = this.prev, out = null;
    if (q && t > q.t && t - q.t <= 6 && q.along < 0 && along >= 0) {
      var f = -q.along / (along - q.along), ac = q.across + f * (across - q.across), step = Math.sqrt(Math.pow(along - q.along, 2) + Math.pow(across - q.across, 2));
      var tc = q.t + f * (t - q.t), last = this.marks.length ? this.marks[this.marks.length - 1] : null;
      // A kart standing on the line must not count laps while its position wobbles: the kart has to be MOVING
      // through the gate.
      // The phone's own GPS speed tells standing from moving well (walking pace is enough); without it, only a clear
      // move between the two positions does.
      var hasV = isFinite(speed) && speed !== null && speed !== undefined;
      var moving = hasV && q.v !== null ? (speed >= 1 && q.v >= 1) : (step >= 3 && step / (t - q.t) >= 2.5);
      if (moving && Math.abs(ac) <= this.half && step <= 200 && (last === null || tc - last >= this.minLap)) { this.marks.push(tc); out = tc; }
    }
    this.prev = { t: t, along: along, across: across, v: isFinite(speed) && speed !== null && speed !== undefined ? speed : null };
    return out;
  };
  /* Is the position good enough to time with right now? (a recent position, of acceptable accuracy) */
  GpsTimer.prototype.healthy = function (now) { return this.lastT !== null && now - this.lastT <= 5 && this.acc !== null && this.acc <= this.maxAcc; };

  /* Speed from the phone's positions, at fs, over `n` samples: the phone's own GPS speed where it gives one,
     otherwise distance over time between positions. loc: [[t, lat, lon, acc, speed, heading], ...].
     Returns {v (m/s), n (positions used), every (s between positions), acc} or null when there are too few
     good positions between t0 and t1 to call it a measurement. */
  function gpsSpeed(loc, n, t0, t1, fs) {
    fs = fs || FS;
    var g = (loc || []).filter(function (p) { return p && p[1] !== null && p[2] !== null && p[3] !== null && p[3] <= 15; }), i, T = [], V = [], derived = 0;
    for (i = 0; i < g.length; i++) {
      var v = g[i][4];
      if (v === null || v === undefined || !isFinite(v)) {
        if (i === 0 || g[i][0] - g[i - 1][0] <= 0 || g[i][0] - g[i - 1][0] > 3) continue;
        var d = toLocal(g[i - 1][1], g[i - 1][2], g[i][1], g[i][2]); v = Math.sqrt(d[0] * d[0] + d[1] * d[1]) / (g[i][0] - g[i - 1][0]);
        T.push(0.5 * (g[i][0] + g[i - 1][0])); V.push(v); derived++; continue;
      }
      T.push(g[i][0]); V.push(v);
    }
    // speed worked out from positions jumps about: average each value with its two neighbours
    if (derived > 0.5 * V.length && V.length >= 3) { var V2 = V.slice(); for (i = 1; i < V.length - 1; i++) V2[i] = (V[i - 1] + V[i] + V[i + 1]) / 3; V = V2; }
    var inside = 0, gapMax = 0, lastIn = t0, accs = [];
    for (i = 0; i < T.length; i++) if (T[i] >= t0 && T[i] <= t1) { inside++; gapMax = Math.max(gapMax, T[i] - lastIn); lastIn = T[i]; }
    gapMax = Math.max(gapMax, t1 - lastIn);
    for (i = 0; i < g.length; i++) if (g[i][0] >= t0 && g[i][0] <= t1) accs.push(g[i][3]);
    if (t1 - t0 < 5 || inside < 10 || inside < 0.4 * (t1 - t0) || gapMax > 8) return null;
    var out = new Float32Array(n), k = 0;
    for (i = 0; i < n; i++) {
      var t = (i + 0.5) / fs;
      while (k < T.length - 2 && T[k + 1] < t) k++;
      if (t <= T[0]) out[i] = V[0]; else if (t >= T[T.length - 1]) out[i] = V[T.length - 1];
      else { var a = T[k], b = T[k + 1]; if (t < a) { k = 0; while (k < T.length - 2 && T[k + 1] < t) k++; a = T[k]; b = T[k + 1]; } out[i] = V[k] + (V[k + 1] - V[k]) * Math.max(0, Math.min(1, (t - a) / (b - a || 1))); }
    }
    return { v: out, n: inside, directCount: V.length - derived, derivedCount: derived, speedSource: derived ? "mixed or position-derived" : "provider speed", every: (t1 - t0) / inside, acc: accs.length ? median(accs) : null };
  }

  var api = { browserRotation: browserRotation, FS: FS, turnRate: turnRate, mountAxis: mountAxis, kartForces: kartForces, Slots: Slots, motion: motion, estimateSpeed: estimateSpeed, distanceBetween: distanceBetween, SPD: SPD, LapDetector: LapDetector, lapsFromMarks: lapsFromMarks, lapSignal: lapSignal, alignLaps: alignLaps,
              findCorners: findCorners, cornerTimes: cornerTimes, median: median, LiveTracker: LiveTracker, lapSignalFine: lapSignalFine, valueAt: valueAt, referenceLap: referenceLap,
              toLocal: toLocal, trackFromFixes: trackFromFixes, GpsTimer: GpsTimer, gpsSpeed: gpsSpeed, refineMarks: refineMarks };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KartCore = api;
})(typeof self !== "undefined" ? self : this);
