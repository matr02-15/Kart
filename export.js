/* Phone -> Apex Trace contract. Original event clock; no invented speed or metres. */
(function (root) {
  'use strict';
  const K = typeof module !== 'undefined' && module.exports ? require('./core.js') : root.KartCore;
  const SCHEMA = 5, MIN_ENGINE = '1.5.0', G = 9.80665;
  const quote = value => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
  function boundaries(laps) {
    let previous = -Infinity;
    for (const lap of laps) {
      if (!Number.isFinite(lap.start) || !Number.isFinite(lap.end) || lap.start < previous || lap.end <= lap.start)
        throw new Error('Recorded intervals overlap or have invalid timestamps; the recording is retained.');
      previous = lap.end;
    }
    return Array.from(new Set(laps.flatMap(l => [l.start, l.end]))).sort((a, b) => a - b);
  }
  function motionCsv(meta, data, laps) {
    laps = laps || [];
    const nc = data.nc, rec = data.rec, n = rec.length / nc;
    if (![13, 15].includes(nc) || !Number.isInteger(n) || n < 2)
      throw new Error('At least two recorded motion events are needed for export.');
    const marks = boundaries(laps), out = [], row = a => out.push(a.map(quote).join(','));
    const legacy = !meta.demo && !(meta.sensorSchema >= 3), motion = [];
    let last = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * nc, t = rec[o];
      if (!Number.isFinite(t) || t < 0 || t <= last) throw new Error('Recorded event timestamps are invalid; no clock was repaired.');
      last = t;
      motion.push(legacy ? [rec[o + 8], rec[o + 9], rec[o + 7]] : [rec[o + 7], rec[o + 8], rec[o + 9]]);
    }
    const mount = K.mountAxis(motion, (n - 1) / (last - rec[0]));
    let axis = mount ? mount.axis : null;
    if (axis) { const angle = Math.acos(Math.min(1, axis[2])) * 180 / Math.PI; if (angle > 35 || angle < 2) axis = null; }
    row(['Format', 'Apex Trace Phone CSV']); row(['Export schema', SCHEMA]); row(['Minimum Apex Trace version', MIN_ENGINE]);
    row(['Device', 'Apex Trace Kart 2.5.0 (phone)']); row(['Venue', meta.track || 'Unnamed track']); row(['Vehicle', 'Kart']);
    row(['Log date', new Date(meta.started).toISOString()]); row(['Measurement mode', 'indoor']);
    row(['Original measurement mode', meta.measurementMode || 'indoor']); row(['Selected timing source', meta.source || 'auto']);
    row(['Timing basis', meta.source === 'auto' ? 'virtual motion-pattern point' : meta.gps ? 'recorded GPS or manual line marks' : 'recorded manual line marks']);
    row(['Accuracy validated', 'false']); row(['Clock basis', 'original monotonic motion-event timestamps in session seconds']);
    row(['Recording start s', 0]);
    row(['Recording end s', Math.max(last, Number(meta.duration) || last, marks.length ? marks[marks.length-1] : last)]);
    row(['Raw sensor recording', 'true']); row(['Sensor schema', meta.sensorSchema || 2]);
    row(['Mount axis', JSON.stringify(axis)]); row(['Recording health', JSON.stringify(meta.recordingHealth || {})]);
    row(['Detector diagnostics', JSON.stringify(meta.detector || {})]); row(['Interval evidence', JSON.stringify(laps)]);
    row(['Beacon Markers', marks.map(t => t.toFixed(9)).join(' ')]);
    row(['Comment', 'Time and motion recording. No measured speed, distance, racing line or pedal channels. Intervals are recorder evidence, not independently certified timing.']);
    row([]);
    row(['Time', 'G Force Lat', 'G Force Long', 'Chassis Yaw Rate', 'Gyro Valid', 'Linear Valid',
      'Raw Acc X', 'Raw Acc Y', 'Raw Acc Z', 'Raw AccG X', 'Raw AccG Y', 'Raw AccG Z', 'Raw Rot X', 'Raw Rot Y', 'Raw Rot Z']);
    row(['s', 'G', 'G', 'deg/s', '', '', 'm/s2', 'm/s2', 'm/s2', 'm/s2', 'm/s2', 'm/s2', 'deg/s', 'deg/s', 'deg/s']);
    for (let i = 0; i < n; i++) {
      const o = i * nc, lin = [rec[o+1], rec[o+2], rec[o+3]], grav = [rec[o+4]-lin[0], rec[o+5]-lin[1], rec[o+6]-lin[2]];
      const norm = Math.hypot(...grav), up = grav.map(v => v / norm);
      const gyro = (nc < 15 || rec[o+13] === 1) && motion[i].every(Number.isFinite) && norm > 1;
      const linear = (nc < 15 || rec[o+14] === 1) && lin.every(Number.isFinite) && norm > 1;
      const forces = linear ? K.kartForces(lin, up, axis) : null;
      const yaw = gyro ? K.turnRate(motion[i], up, axis) : NaN;
      const value = v => Number.isFinite(v) ? v.toFixed(9) : 'NaN';
      row([value(rec[o]), value(forces ? forces[1]/G : NaN), value(forces ? forces[0]/G : NaN), value(yaw),
        gyro ? 1 : 0, linear ? 1 : 0, ...Array.from(rec.slice(o+1,o+7)).map(value), ...motion[i].map(value)]);
    }
    return out.join('\n') + '\n';
  }
  const api = { SCHEMA, MIN_ENGINE, boundaries, motionCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.KartExport = api;
})(typeof self !== 'undefined' ? self : this);
