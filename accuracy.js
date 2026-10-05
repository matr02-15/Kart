/* Offline evidence tools, shared by browser and Node. No uploads; no fitted clock offsets. */
(function(root) {
  'use strict';
  const K = typeof module !== 'undefined' && module.exports ? require('./core.js') : root.KartCore;
  const I = typeof module !== 'undefined' && module.exports ? require('./indoor.js') : root.KartIndoor;
  function percentile(a,q) { if (!a.length) return null; const b=a.slice().sort((x,y)=>x-y); return b[Math.min(b.length-1,Math.ceil(q*b.length)-1)]; }
  function parseRecording(text) {
    if (typeof text !== 'string' || text.length > 40e6) throw Error('Recording missing or larger than 40 MB.');
    const lines=text.split(/\r?\n/), rows=[], marks=[], loc=[]; let version=null, schema=null, header=null;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith('#')) {
        if (/^# Apex Trace Kart /.test(line)) version=line.slice(18).trim();
        if (/^# Sensor schema,/.test(line)) schema=Number(line.split(',')[1]);
        if (/^# (Taps|Passes of the line by GPS and taps) \(s\),/.test(line)) {
          for(const x of line.slice(line.indexOf(',')+1).trim().split(/\s+/)) if(x && Number.isFinite(Number(x))) marks.push(Number(x));
        }
        if(line.startsWith('# Loc,')) loc.push(line.slice(6).split(',').map(v=>v.trim()===''?null:Number(v)));
        continue;
      }
      const cells=line.split(',');
      if(!header) { header=cells.map(x=>x.trim()); continue; }
      if(cells.length!==header.length || cells.some(x=>x.trim()==='' || !Number.isFinite(Number(x)))) throw Error('A sensor row contains missing or invalid values.');
      rows.push(cells.map(Number));
    }
    const columns=['time','acc_x','acc_y','acc_z','accg_x','accg_y','accg_z','rot_x','rot_y','rot_z'];
    if(!header || !columns.every(c=>header.includes(c)) || rows.length<2) throw Error('Use the app\'s raw Save data file CSV, not the desktop-analysis export.');
    const rec=[], t=[], yaw=[], gaps=[];
    let prev=-1, rejected=0; const legacy=!(schema>=3),gv=header.indexOf('gyro_valid'),lv=header.indexOf('linear_valid'),nc=gv>=0||lv>=0?15:10;
    for(const row of rows) {
      const v=columns.map(c=>row[header.indexOf(c)]), time=v[0];
      if(time<0 || time<=prev) { rejected++; continue; }
      if(prev>=0 && time-prev>0.5) gaps.push([prev,time]); prev=time;
      // Before schema 3 the browser stored alpha,beta,gamma in columns labelled x,y,z.
      if(legacy) { const z=v[7],x=v[8],y=v[9]; v[7]=x;v[8]=y;v[9]=z; }
      rec.push(...v); if(nc===15)rec.push(0,0,0,gv>=0?row[gv]:1,lv>=0?row[lv]:1);t.push(time);
    }
    if(!rec.length || t[t.length-1]>5400) throw Error('Recording duration invalid or exceeds 90 minutes.');
    const mo=K.motion(rec,nc), det=new I.IndoorDetector();
    // Replay the acquisition transform at original event times. Do not claim that a
    // regular analysis grid measures the phone's received-event frequency.
    let lastUpdate=-1;
    for(let o=0;o<rec.length;o+=nc) {
      const time=rec[o],lin=rec.slice(o+1,o+4),w=rec.slice(o+7,o+10),g=rec.slice(o+4,o+7),
        grav=g.map((x,j)=>x-lin[j]),gn=Math.hypot(...grav)||1,up=grav.map(x=>x/gn),
        gyro=nc<15||rec[o+13]===1,linear=nc<15||rec[o+14]===1,forces=gyro&&linear?K.kartForces(lin,up):null;
      det.push(time,gyro?K.turnRate(w,up):NaN,forces?forces[1]/9.80665:NaN,forces?forces[0]/9.80665:NaN);
      if(time-lastUpdate>=0.5){det.update();lastUpdate=time;}
    }
    det.update(true);
    return { version, schema, legacyAxesRepaired:legacy, rejectedRows:rejected, motion:mo, detector:det,
      gaps, marks, location:loc, laps:det.laps(), duration:t[t.length-1], samples:t.length,
      recordingHealth:I.recordingHealth(rec,nc),diagnostics:det.diagnostics() };
  }
  function parseCrossings(text) {
    const lines=text.trim().split(/\r?\n/).filter(x=>x.trim() && !x.trim().startsWith('#'));
    if(lines[0] && /^crossing_s\s*$/i.test(lines[0])) lines.shift();
    const out=lines.map(x=>Number(x.trim()));
    if(out.length<3 || out.some((x,i)=>!Number.isFinite(x)||x<0||(i && x<=out[i-1]))) throw Error('Reference needs at least three increasing crossing times in seconds, one per line (optional header crossing_s).');
    return out;
  }
  function compareCrossings(observed,reference,opts) {
    opts=opts||{};
    if(opts.sameLine!==true) throw Error('Comparison requires the same physical timing line. A virtual motion point cannot be compared to another line.');
    const offset=opts.offset===undefined?0:Number(opts.offset), window=opts.window===undefined?2:Number(opts.window), target=opts.target===undefined?0.1:Number(opts.target);
    if(!Number.isFinite(offset)||!Number.isFinite(window)||window<=0||!Number.isFinite(target)||target<=0) throw Error('Invalid comparison settings.');
    for(const a of [observed,reference]) if(!Array.isArray(a)||a.length<2||a.some((x,i)=>!Number.isFinite(x)||(i&&x<=a[i-1]))) throw Error('Crossings must be increasing finite timestamps.');
    const pairs=[],missing=[],extra=[]; let i=0,j=0;
    // Ordered one-to-one associations. No nearest-neighbour reuse, no fitted time shift.
    while(i<observed.length && j<reference.length) {
      const error=observed[i]+offset-reference[j];
      if(Math.abs(error)<=window) { pairs.push({ observedIndex:i,referenceIndex:j,crossingError:error });i++;j++; }
      else if(error<0) extra.push(i++); else missing.push(j++);
    }
    while(i<observed.length)extra.push(i++);while(j<reference.length)missing.push(j++);
    const lapErrors=[];
    for(let k=1;k<pairs.length;k++) {
      const a=pairs[k-1],b=pairs[k];
      if(b.observedIndex===a.observedIndex+1 && b.referenceIndex===a.referenceIndex+1) {
        lapErrors.push((observed[b.observedIndex]-observed[a.observedIndex])-(reference[b.referenceIndex]-reference[a.referenceIndex]));
      }
    }
    const abs=lapErrors.map(Math.abs), p95=percentile(abs,0.95);
    return { matchedCrossings:pairs.length,missingCrossings:missing.length,extraCrossings:extra.length,
      completeComparedLaps:lapErrors.length,lapTimeBias:lapErrors.length?lapErrors.reduce((a,b)=>a+b,0)/lapErrors.length:null,
      lapTimeMedianAbsolute:percentile(abs,0.5),lapTimeP95Absolute:p95,lapTimeMaxAbsolute:abs.length?Math.max(...abs):null,
      targetSeconds:target,meetsSessionTarget:missing.length===0&&extra.length===0&&lapErrors.length>=2&&p95<=target,
      accuracyScope:'this recording and reference only; not a general device guarantee',pairs,lapErrors };
  }
  const api={parseRecording,parseCrossings,compareCrossings};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.KartAccuracy=api;
})(typeof self!=='undefined'?self:this);
