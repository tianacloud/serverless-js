import { readFile, writeFile } from "node:fs/promises";
const original = await readFile(
  new URL("../vendor/jweixin-1.6.0.js", import.meta.url),
  "utf8",
);
// Keep the official source intact inside a private factory. No wx/jWeixin global
// replacement, and all SDK document listeners are owned by the returned handle.
const prefix = `Object.defineProperty(window,'__tianaLocationCreateWechatSDK',{configurable:true,writable:true,value:function(){
 const listeners=[];
 const doc=new Proxy(window.document,{get(target,key){
  if(key==='addEventListener')return (type,listener,options)=>{listeners.push([type,listener,options]);target.addEventListener(type,listener,options)};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const scope={document:doc,get WeixinJSBridge(){return window.WeixinJSBridge},get __wxjs_environment(){return window.__wxjs_environment}};
 let wx;
 (function(){
`;
const suffix = `
}).call(scope);
 wx=scope.wx;
 return {api:wx,dispose(){for(const [type,listener,options] of listeners.splice(0))window.document.removeEventListener(type,listener,options)}};
}});
`;
await writeFile(
  new URL("../dist/jweixin.js", import.meta.url),
  prefix + original + suffix,
);
