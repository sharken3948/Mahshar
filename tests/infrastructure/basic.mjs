import Module from 'node:module';const load=Module._load;Module._load=function(id,parent,main){if(id==='server-only')return {};return load.call(this,id,parent,main)};
