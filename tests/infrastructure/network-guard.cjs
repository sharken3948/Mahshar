const net=require('node:net');
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 let value=args[0]; if(Array.isArray(value))value=value[0];
 const options=value&&typeof value==='object'?value:{};
 const host=options.host||options.hostname||(typeof value==='number'&&typeof args[1]==='string'?args[1]:'localhost');
 if(!options.path&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('RELEASE_REVIEW_EXTERNAL_NETWORK_FORBIDDEN');
 return connect.apply(this,args);
};
const fetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));if(['127.0.0.1','localhost','[::1]'].includes(url.hostname))return fetch(input,init);throw Error('RELEASE_REVIEW_EXTERNAL_NETWORK_FORBIDDEN')};
