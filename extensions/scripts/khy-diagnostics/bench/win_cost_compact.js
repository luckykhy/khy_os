'use strict';
// khy startup-spawn cost probe (standalone, self-contained). Times the exact
// process spawns the khy startup caches remove, on THIS OS. No repo/npm/network.
const os=require('os'), cp=require('child_process');
const isWin=os.platform()==='win32';
const ri=process.argv.indexOf('--runs');
const RUNS=ri>=0&&parseInt(process.argv[ri+1],10)>0?parseInt(process.argv[ri+1],10):11;
const med=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.floor((s.length-1)/2)];};
function timeOnce(fn){const t=process.hrtime.bigint();try{fn();}catch{}return Number(process.hrtime.bigint()-t)/1e6;}
function measure(fn){const s=[];let c=null;for(let k=0;k<RUNS;k++){const ms=timeOnce(fn);if(k===0)c=ms;s.push(ms);}return{m:med(s),c};}
const O={stdio:['ignore','ignore','ignore'],timeout:15000,windowsHide:true};
const gitShell=()=>cp.execSync('git rev-parse --abbrev-ref HEAD',O);
const gitDirect=()=>{const r=cp.spawnSync('git',['rev-parse','--abbrev-ref','HEAD'],O);if(r.error)throw r.error;};
const nodeV=()=>cp.execSync('node --version',O);
const swap=()=>{if(isWin)cp.execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_PageFileUsage | Measure-Object -Property AllocatedBaseSize -Sum).Sum"',O);else if(os.platform()==='darwin')cp.execSync('sysctl -n vm.swapusage',O);else cp.execSync('free -m',O);};
const nvidia=()=>cp.execSync(`nvidia-smi --query-gpu=name --format=csv,noheader 2>${isWin?'NUL':'/dev/null'}`,O);
const have=c=>{try{cp.execSync(isWin?`where ${c}`:`command -v ${c}`,O);return true;}catch{return false;}};
const hasGit=have('git'), hasNv=have('nvidia-smi');
console.log(`platform=${os.platform()} arch=${os.arch()} cpus=${os.cpus().length} node=${process.version} runs=${RUNS}`);
const sh=hasGit?measure(gitShell):null, di=hasGit?measure(gitDirect):null, nv=measure(nodeV), sw=measure(swap), gp=hasNv?measure(nvidia):null;
const row=(l,r)=>console.log('  '+l.padEnd(44)+' : '+(r?`median ${r.m.toFixed(2)} ms (cold ${r.c.toFixed(2)})`:'(skipped)'));
console.log('-- shell-free git fix (removes shell intermediary) --');
row('git rev-parse VIA SHELL (old: cmd.exe->git)',sh);
row('git rev-parse DIRECT (new: spawnSync)',di);
let tax=null; if(sh&&di){tax=sh.m-di.m; console.log(`  -> shell tax/call ~${tax.toFixed(2)} ms  (x2 startup calls ~${(tax*2).toFixed(2)} ms)`);}
console.log('-- hw-probe cache (removes these warm) --');
row('swap probe (PowerShell CIM on Windows)',sw);
row('nvidia-smi',gp);
console.log('-- check_node cache --');
row('node --version',nv);
const total=(tax!=null?tax*2:0)+(sw?sw.m:0)+(gp?gp.m:0)+(nv?nv.m:0);
console.log('  '+'-'.repeat(60));
console.log(`  TOTAL spawn cost the 4 fixes remove on this OS: ~${total.toFixed(2)} ms/launch`);
const j={platform:os.platform(),arch:os.arch(),node:process.version,runs:RUNS,gitViaShellMs:sh?+sh.m.toFixed(2):null,gitDirectMs:di?+di.m.toFixed(2):null,shellTaxPerCallMs:tax!=null?+tax.toFixed(2):null,swapProbeMs:sw?+sw.m.toFixed(2):null,nvidiaSmiMs:gp?+gp.m.toFixed(2):null,nodeVersionMs:nv?+nv.m.toFixed(2):null,totalRemovedMs:+total.toFixed(2)};
console.log('\nRESULT_JSON '+JSON.stringify(j));
