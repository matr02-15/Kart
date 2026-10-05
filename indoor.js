/* Indoor evidence: competing yaw and lateral-motion detectors. No GPS, fitted metres or tap-fed learning. */
(function(root){
  'use strict';
  const K=typeof module!=='undefined'&&module.exports?require('./core.js'):root.KartCore;
  class IndoorDetector {
    constructor(opts){
      this.fs=K.FS;this.yaw=new K.LapDetector(opts);this.lateral=new K.LapDetector(opts);
      // Lateral G carries a cycle shape, not an angle. Never apply the 360-degree rule to it.
      this.lateral._headingPeriod=()=>null;
      this.active=null;this.channel=null;this.lastTime=null;this.firstTime=null;this.samples=0;this.gyroSamples=0;this.lateralSamples=0;
      this.lastLateralTime=null;this.deadline=(opts&&opts.learningSeconds)||180;this.final=false;
      this.recentTimes=[];this.rateBlocked=false;this.minEventRate=15;
      this.qualityGaps=[];this.openQualityGap=null;
      this.lastReason='Collecting several complete motion cycles';
    }
    push(t,yaw,lat,lon){
      if(!Number.isFinite(t)||t<0||(this.lastTime!==null&&t<=this.lastTime))return false;
      if(this.firstTime===null)this.firstTime=t;
      this.lastTime=t;this.samples++;if(Number.isFinite(yaw))this.gyroSamples++;
      this.recentTimes.push(t);if(this.recentTimes.length>256)this.recentTimes.shift();
      this.yaw.push(t,yaw);
      if(Number.isFinite(lat)){this.lateral.push(t,lat*50);this.lateralSamples++;this.lastLateralTime=t;}
      return true;
    }
    update(final){
      this.final=!!final;
      const recent=this.recentTimes,rate=recent.length>1?(recent.length-1)/(recent[recent.length-1]-recent[0]):null;
      this.rateBlocked=recent.length>=20&&rate<this.minEventRate;
      if(this.rateBlocked){if(!this.openQualityGap){this.openQualityGap=[recent[0],this.lastTime];this.qualityGaps.push(this.openQualityGap);}else this.openQualityGap[1]=this.lastTime;this.lastReason='Received motion rate below the 15 Hz recognition gate; raw recording continues';return false;}
      if(this.openQualityGap){this.openQualityGap[1]=this.lastTime;this.openQualityGap=null;}
      if(this.active)return this.active.update(final);
      this.yaw.update(final);
      if(this.yaw.period!==null){this.active=this.yaw;this.channel='yaw';return true;}
      // Require sustained lateral variation, not stationary noise. The same full-cycle,
      // uniqueness and repeated-evaluation checks used for yaw remain in force.
      const sm=this.lateral._smooth(),tail=Array.from(sm.subarray(Math.max(0,sm.length-180*K.FS)));
      const mean=tail.length?tail.reduce((a,b)=>a+b,0)/tail.length:0;
      const rms=tail.length?Math.sqrt(tail.reduce((a,b)=>a+(b-mean)**2,0)/tail.length)/50:0;
      if(rms>=0.15&&this.lateralSamples>=0.8*this.samples){
        this.lateral.update(final);
        if(this.lateral.period!==null){this.active=this.lateral;this.channel='lateral';return true;}
      }
      this.lastReason=this.samples<20?'No usable motion samples':this.yaw.gaps.length||this.lateral.gaps.length?
        'Sensor interruptions may prevent complete-cycle recognition':rms<0.15?
        'Insufficient distinctive lateral motion':'Whole-lap repetition or timing-point uniqueness not established';
      return false;
    }
    state(){return this.rateBlocked?'unavailable':this.active?this.active.state():(this.final||(this.lastTime||0)>=this.deadline?'unavailable':'learning');}
    diagnostics(){const dt=this.samples>1?(this.lastTime-this.firstTime)/(this.samples-1):null;return {
      state:this.state(),channel:this.channel,reason:this.active&&!this.rateBlocked?'Repeated motion point recognised; accuracy requires independent timing':this.lastReason,
      eventRate:dt?1/dt:null,gyroCoverage:this.samples?this.gyroSamples/this.samples:0,lateralCoverage:this.samples?this.lateralSamples/this.samples:0,
      learningBudgetSeconds:this.deadline,minimumEventRateHz:this.minEventRate,recentEventRateHz:this.recentTimes.length>1?(this.recentTimes.length-1)/(this.lastTime-this.recentTimes[0]):null,gaps:this.yaw.gaps.length,lateralGaps:this.lateral.gaps.length,
      quality:this.quality,qualityMeaning:'pattern correlation, not a probability or timing-error bound'};}
    get base(){return this.active||this.yaw;}
    get y(){return this.base.y;}get period(){return this.base.period;}get passes(){return this.base.passes;}
    get scores(){return this.base.scores;}get quality(){return this.base.quality;}get relearned(){return this.base.relearned||0;}
    get method(){return this.active?this.channel+'-'+this.active.method:null;}
    duration(){return this.lastTime||0;}_smooth(){return this.base._smooth();}
    lastPass(){return this.active?this.active.lastPass():null;}
    hasGap(a,b){return this.yaw.hasGap(a,b)||(this.channel==='lateral'&&this.lateral.hasGap(a,b))||this.qualityGaps.some(g=>g[0]<b&&g[1]>a);}
    laps(){return this.active?this.active.laps().map(l=>Object.assign({},l,{interrupted:l.interrupted||this.hasGap(l.start,l.end),reason:l.reason||(this.hasGap(l.start,l.end)?'insufficient received motion quality':null),signal:this.channel,timingBasis:'virtual motion-pattern point',accuracyValidated:false})):[];}
  }
  function recordingHealth(rec,nc){
    const n=Math.floor(rec.length/nc),delta=[],gaps=[];let bad=0,gyro=0,linear=0;
    for(let i=0;i<n;i++){const o=i*nc,t=rec[o];if(!Number.isFinite(t)){bad++;continue;}
      if(nc>=15){gyro+=rec[o+13]===1;linear+=rec[o+14]===1;}
      if(i){const a=rec[(i-1)*nc],d=t-a;if(d<=0||!Number.isFinite(d))bad++;else{delta.push(d);if(d>0.5)gaps.push([a,t]);}}
    }
    delta.sort((a,b)=>a-b);const q=p=>delta.length?delta[Math.min(delta.length-1,Math.floor(p*(delta.length-1)))]:null;
    const median=q(0.5),p95=q(0.95);
    return {samples:n,medianIntervalSeconds:median,p95IntervalSeconds:p95,medianRateHz:median?1/median:null,
      maxIntervalSeconds:delta.length?delta[delta.length-1]:null,gaps,invalidTimestamps:bad,
      gyroValidFraction:nc>=15&&n?gyro/n:null,linearValidFraction:nc>=15&&n?linear/n:null,
      accuracyValidated:false};
  }
  const api={IndoorDetector,recordingHealth};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.KartIndoor=api;
})(typeof self!=='undefined'?self:this);
