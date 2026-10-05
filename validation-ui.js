(function(){
'use strict';const $=s=>document.querySelector(s);let recording=null,evidence=null;
function invalidate(){evidence=null;$('#save').hidden=true;$('#result').textContent='';}
for(const s of ['#reference','#offset','#target','#same'])$(s).addEventListener('change',invalidate);
$('#recording').addEventListener('change',async()=>{
  invalidate();recording=null;$('#replay').textContent='Replaying…';
  try{const f=$('#recording').files[0];if(!f)throw Error('Select a recording.');recording=KartAccuracy.parseRecording(await f.text());
    const r=recording,good=r.laps.filter(l=>!l.interrupted);
    $('#replay').textContent=`${r.samples} samples, ${r.duration.toFixed(1)} s. ${r.gaps.length} sensor gaps; ${r.rejectedRows} invalid-time rows excluded. ${r.legacyAxesRepaired?'Legacy gyro axes repaired from the raw columns.':'Corrected sensor schema.'} ${good.length} candidate complete motion intervals; ${r.laps.length-good.length} interrupted intervals. Method: ${r.detector.method||'not recognised'}. Pattern match: ${r.detector.quality.toFixed(2)} (not timing accuracy). Candidate durations: ${good.map(l=>l.time.toFixed(3)).join(', ')} s. No independent accuracy established.`;
  }catch(e){$('#replay').textContent=e.message;}
});
$('#compare').addEventListener('click',async()=>{
  invalidate();try{
    if(!recording)throw Error('Load a recording first.');const f=$('#reference').files[0];if(!f)throw Error('Select reference crossings.');
    const reference=KartAccuracy.parseCrossings(await f.text());
    evidence=KartAccuracy.compareCrossings(recording.marks,reference,{sameLine:$('#same').checked,offset:Number($('#offset').value),target:Number($('#target').value)});
    $('#result').textContent=JSON.stringify(evidence,null,2);$('#save').hidden=false;
  }catch(e){$('#result').textContent=e.message;}
});
$('#save').addEventListener('click',()=>{if(!evidence)return;const a=document.createElement('a'),u=URL.createObjectURL(new Blob([JSON.stringify(evidence,null,2)],{type:'application/json'}));a.href=u;a.download='ApexTrace_timing_evidence.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);});
})();
