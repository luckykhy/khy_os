const fs=require('fs');
let c=fs.readFileSync('D:/Portable/khy-os/services/backend/proxy.js','utf8');
const idx=c.indexOf('const cfg=');
const endIdx=c.indexOf('function sj');
const O=String.fromCharCode(124,124);
const N=String.fromCharCode(10);
const lines=[
'const cfg={',
'  enabled:(process.env.ANTHROPIC_PROXY_ENABLED'+O+'"false").toLowerCase()==="true",',
'  upstream:process.env.ANTHROPIC_PROXY_UPSTREAM'+O+'"https://api.commandcode.ai/provider/v1/chat/completions",',
'  apiKey:<!REDACTED> process.env.ANTHROPIC_PROXY_API_KEY'+O+'",',
'  model:process.env.ANTHROPIC_PROXY_MODEL'+O+'"meituan/LongCat-2.0:free",',
'  displayModel:process.env.ANTHROPIC_PROXY_DISPLAY_MODEL'+O+'"claude-opus-4-8"',
'};'
];
c=c.substring(0,idx)+lines.join(N)+N+c.substring(endIdx);
fs.writeFileSync('D:/Portable/khy-os/services/backend/proxy.js',c);
console.log('fixed',c.length,'bytes');
