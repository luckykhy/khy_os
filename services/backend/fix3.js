const fs=require("fs");
let c=fs.readFileSync("D:/Portable/khy-os/services/backend/proxy.js","utf8");
const idx=c.indexOf("const cfg=");
const endIdx=c.indexOf("function sj");
const O=String.fromCharCode(124,124);
const N=String.fromCharCode(10);
