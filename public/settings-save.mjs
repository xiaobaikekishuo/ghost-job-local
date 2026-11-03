export function createSettingsSaver({save, onSaved=()=>{}, onError=()=>{}, setTimer=setTimeout, clearTimer=clearTimeout, delay=500}) {
  let pending={}, timer, inFlight=null;
  async function flush() {
    clearTimer(timer);
    if (inFlight) return inFlight;
    if (!Object.keys(pending).length) return;
    inFlight=(async()=>{
      do {
        while (Object.keys(pending).length) {
          const patch=pending; pending={};
          try { await save(patch); }
          catch(error) { pending={...patch,...pending}; throw error; }
        }
        await onSaved();
      }
      while (Object.keys(pending).length);
    })();
    try { await inFlight; } finally { inFlight=null; }
  }
  function enqueue(patch) {
    pending={...pending,...patch};
    clearTimer(timer);
    timer=setTimer(()=>flush().catch(onError),delay);
  }
  return {enqueue,flush,get dirty(){return !!inFlight||Object.keys(pending).length>0;}};
}
