const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
function setup(allowed=true){
  const calls=[];
  const ctx={hasButtonPerm:async(...args)=>{calls.push(args);return allowed;}};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('async function canUsePriplatkyInternalNote('),source.indexOf('async function hasButtonPerm(')),ctx);
  return {...ctx,calls};
}
test('internal bonus notes are restricted to Admin and VR, even when another role has a legacy override',async()=>{
  const ctx=setup();
  for(const role of ['admin','vedoucí','VR'])assert.equal(await ctx.canUsePriplatkyInternalNote({role}),true,role);
  assert.equal(ctx.calls.length,3);
  for(const role of ['recepční','bagazista','pb6','hotely','',null])assert.equal(await ctx.canUsePriplatkyInternalNote({role}),false,String(role));
  assert.equal(await ctx.canUsePriplatkyInternalNote(null),false);
  assert.equal(ctx.calls.length,3,'non-manager roles never reach their permission override');
});
test('VR internal-note permission can still be disabled without exposing existing notes',async()=>{
  const ctx=setup(false);
  assert.equal(await ctx.canUsePriplatkyInternalNote({role:'vedoucí'}),false);
  assert.deepEqual(Array.from(ctx.calls[0]).slice(1),['priplatky','internalNote',false]);
});
