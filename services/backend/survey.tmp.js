var fs=require('fs');var path=require('path');
var dir='D:\\Portable\\khy-os\\services\\backend\\src\\routes';
var files=fs.readdirSync(dir).filter(function(f){return f.endsWith('.js');});
var migrated=0;var remaining=[];
for(var i=0;i<files.length;i++){
  var f=files[i];
  var content=fs.readFileSync(path.join(dir,f),'utf8');
  var lines=content.split('\n');
  var calls=0;
  for(var j=0;j<lines.length;j++){
    if(lines[j].match(/res\.(json|status|send)\(/)){calls++;}
  }
  if(calls===0){migrated++;}
  else{remaining.push({file:f,calls:calls});}
}
console.log('Migrated files:', migrated+'/'+files.length);
console.log('Remaining:', remaining.length);
remaining.sort(function(a,b){return b.calls-a.calls;});
remaining.forEach(function(r){console.log('  '+r.file+': '+r.calls);});
