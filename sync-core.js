(function(root){
 'use strict';
 const copy=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
 const canonical=x=>x===undefined?'undefined':JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
 const equal=(a,b)=>canonical(a)===canonical(b);
 function merge(base,local,remote){
  const conflicts=[];const out=copy(remote||local);
  const choose=(b,l,r,key)=>{if(equal(l,b))return copy(r);if(equal(r,b)||equal(l,r))return copy(l);conflicts.push({key,local:copy(l),remote:copy(r)});return copy(l)};
  out.profile=choose(base?.profile,local?.profile,remote?.profile,'profile');
  out.logs={};const dates=new Set([...Object.keys(base?.logs||{}),...Object.keys(local?.logs||{}),...Object.keys(remote?.logs||{})]);
  for(const date of dates){const v=choose(base?.logs?.[date],local?.logs?.[date],remote?.logs?.[date],date);if(v!==undefined)out.logs[date]=v}
  out.version=1;out.programRevision=Math.max(local?.programRevision||1,remote?.programRevision||1);
  return {document:out,conflicts};
 }
 const api={copy,equal,merge};if(typeof module==='object'&&module.exports)module.exports=api;else root.JournalSyncCore=api;
})(typeof globalThis!=='undefined'?globalThis:this);
