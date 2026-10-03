const copy=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const invalid=()=>new Error('REPLAY_INCOMPLETE');

/** Lossless at the existing recording cadence. No quantization or dropped rendering events. */
export function createFrameEncoder({keyframeTicks=150}={}) {
  let previous=null,lastKey=-Infinity;
  return {encode(tick,snapshot,events) {
    const next=copy(snapshot),frame={tick,events:copy(events)};
    if(!previous || tick-lastKey>=keyframeTicks){frame.snapshot=next;lastKey=tick;}
    else {
      const delta={},set={},unset=[];
      for(const [key,value] of Object.entries(next))if(key!=='units' && !same(value,previous[key]))set[key]=value;
      for(const key of Object.keys(previous))if(key!=='units' && !Object.hasOwn(next,key))unset.push(key);
      if(Object.keys(set).length)delta.set=set;if(unset.length)delta.unset=unset;
      const old=new Map(previous.units.map(u=>[u[0],u])),current=new Map(next.units.map(u=>[u[0],u]));
      const add=[],remove=[],change=[];
      for(const [id] of old)if(!current.has(id))remove.push(id);
      for(const unit of next.units) {
        const prior=old.get(unit[0]);
        if(!prior || prior.length!==unit.length || unit.length>30){if(prior)remove.push(unit[0]);add.push(unit);continue;}
        let mask=0;const values=[];
        for(let i=1;i<unit.length;i++)if(!same(unit[i],prior[i])){mask|=1<<i;values.push(unit[i]);}
        if(mask)change.push([unit[0],mask,...values]);
      }
      if(add.length)delta.add=add;if(remove.length)delta.remove=remove;if(change.length)delta.change=change;
      const defaultOrder=previous.units.filter(u=>!remove.includes(u[0])).map(u=>u[0]).concat(add.map(u=>u[0]));
      const order=next.units.map(u=>u[0]);if(!same(order,defaultOrder))delta.order=order;
      frame.delta=delta;
    }
    previous=next;return frame;
  }};
}

/** Returns a new snapshot so renderer consumers cannot mutate the decoder's previous frame. */
export function decodeReplayFrame(previous,frame) {
  if(frame.snapshot)return copy(frame.snapshot); // legacy full frames are also keyframes
  if(!previous || !frame.delta)throw invalid();
  const next=copy(previous),d=frame.delta;
  for(const key of d.unset || [])delete next[key];
  for(const [key,value] of Object.entries(d.set || {})) {
    if(['__proto__','constructor','prototype','units'].includes(key))throw invalid();
    next[key]=copy(value);
  }
  const units=new Map(next.units.map(u=>[u[0],u]));
  for(const id of d.remove || []){if(!units.delete(id))throw invalid();}
  for(const tuple of d.add || []){if(units.has(tuple[0]))throw invalid();units.set(tuple[0],copy(tuple));}
  for(const [id,mask,...values] of d.change || []) {
    const unit=units.get(id);if(!unit || !Number.isSafeInteger(mask) || mask<=0 || mask&1 || mask>>unit.length)throw invalid();
    let n=0;for(let i=1;i<unit.length;i++)if(mask&(1<<i)){if(n>=values.length)throw invalid();unit[i]=copy(values[n++]);}
    if(n!==values.length)throw invalid();
  }
  const order=d.order || [...units.keys()];
  if(order.length!==units.size || new Set(order).size!==units.size || order.some(id=>!units.has(id)))throw invalid();
  next.units=order.map(id=>units.get(id));return next;
}
