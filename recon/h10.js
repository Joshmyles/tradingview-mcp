(async function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var rp = window.TradingViewApi._replayApi;
  var uc = rp._replayUIController;
  var out = {};
  try { out.cursorBefore = u(rp.currentDate()); } catch(e){}
  try { out.started = u(rp.isReplayStarted()); } catch(e){}
  try { out.ready = u(rp.isReadyToPlay()); } catch(e){}
  try { var rm = uc._replayManager;
        out.rm = { ctor: rm && rm.constructor ? rm.constructor.name : null };
        try { out.rm.isReplayStarted = u(rm.isReplayStarted()); } catch(e){ out.rm.startedErr = String(e && e.message || e); }
        try { out.rm.isReplayFinished = u(rm.isReplayFinished()); } catch(e){ out.rm.finishedErr = String(e && e.message || e); }
        try { out.rm.models = rm.models().length; } catch(e){ out.rm.modelsErr = String(e && e.message || e); }
        try { out.rm.doReplayStepSrc = String(rm.doReplayStep).replace(/\s+/g,' ').slice(0, 1200); } catch(e){}
        try { out.rm.methods = (function(){ var n={}, o=rm, d=0; while(o&&d<4){ Object.getOwnPropertyNames(o).forEach(function(k){ try{ if(typeof rm[k]==='function') n[k]=1; }catch(e){} }); o=Object.getPrototypeOf(o); d++; } return Object.keys(n).sort(); })(); } catch(e){}
  } catch(e){ out.rmErr = String(e && e.message || e); }

  // actually settle the promise and report which way it went
  var res = await new Promise(function(resolve){
    var done = false;
    try {
      var p = rp.doStep();
      if (p && typeof p.then === 'function') {
        p.then(function(v){ if(!done){done=true;resolve({ outcome:'resolved', value: (v===undefined?'undefined':String(v)) });} },
               function(e){ if(!done){done=true;resolve({ outcome:'rejected', reason: String(e && e.message || e) });} });
      } else { done = true; resolve({ outcome: 'not-a-promise', value: String(p) }); }
    } catch(e){ done = true; resolve({ outcome: 'threw', reason: String(e && e.message || e) }); }
    setTimeout(function(){ if(!done){ done=true; resolve({ outcome: 'PENDING after 20000ms' }); } }, 20000);
  });
  out.doStepResult = res;
  try { out.cursorAfter = u(rp.currentDate()); } catch(e){}
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
