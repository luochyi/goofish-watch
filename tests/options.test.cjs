const fs = require('node:fs');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const dir = require('node:path').join(__dirname, '../extension/');
assert.ok(fs.existsSync(dir + 'options.html'), '需要独立设置页');
const html = fs.readFileSync(dir + 'options.html','utf8');
assert.doesNotMatch(html, /value="理光 GR2"/);
assert.match(html, /闲鱼商品监控/);
const els = new Map();
class Element {
 constructor(id) { this.id=id; this.value=''; this.checked=false; this.disabled=false; this.handlers={}; this.dataset={}; this.children=[]; }
 addEventListener(name, fn){ this.handlers[name]=fn; }
 trigger(name){ return this.handlers[name]?.({preventDefault(){},target:this}); }
 replaceChildren(...children){this.children=children;}
 append(...children){this.children.push(...children);}
 setCustomValidity(message){this.error=message;}
 closest(){return this;}
 focus(){}
 reportValidity(){return true;}
}
for (const [,id] of html.matchAll(/id="([^"]+)"/g)) els.set(id,new Element(id));
for (const id of ['webhook','secret']) assert.match(html, new RegExp('<input[^>]*id="'+id+'"[^>]*type="password"'));
const calls=[];

const defaults={keyword:'',min:null,max:null,minutes:10};
const rules=[{id:'default',config:{...defaults,keyword:'理光 GR2'},running:false,status:'已暂停',lastAt:0,nextAt:0,matched:0}];
let hasWebhook=false,hasSecret=false;
const document={getElementById:id=>els.get(id),createElement:()=>new Element(),hidden:false,addEventListener(){}};
const sendMessage=async message=>{
 calls.push(message);
 const rule=rules.find(r=>r.id===message.id)||rules[0];
 if(message.type==='state')return {ok:true,...structuredClone(rule),rules:structuredClone(rules),hasWebhook,hasSecret};
 if(message.type==='add'){rules.push({...structuredClone(rules[0]),id:'second',config:{...defaults},running:false});return {ok:true,id:'second'};}
 if(message.type==='save')Object.assign(rule.config,message.config);
 if(message.type==='saveDelivery'){
   if(message.webhook)hasWebhook=true;if(message.secret)hasSecret=true;
   if(message.clearWebhook)hasWebhook=false;if(message.clearSecret)hasSecret=false;
 }
 if(message.type==='remove')rules.splice(rules.indexOf(rule),1);
 if(message.type==='start')rule.running=true;
 if(message.type==='stop')rule.running=false;
 if(message.type==='preview')return {ok:true,items:[{id:'123',title:'<img src=x>',price:25.99}]};
 return {ok:true};
};
const ctx=vm.createContext({chrome:{runtime:{sendMessage}},document,setInterval(){},Intl,Date,confirm:()=>true});
vm.runInContext(fs.readFileSync(dir+'options.js','utf8'),ctx);
const next=()=>new Promise(resolve=>setImmediate(resolve));
const el=id=>els.get(id);
async function click(id){await el(id).trigger('click');await next();}
async function run(){
 await next();
 assert.equal(el('keyword').value,'理光 GR2');
 assert.equal(el('preview').disabled,false);
 el('webhook').value='fake-test-address';el('secret').value='test-only';
 el('settings').trigger('input');
 assert.equal(el('saveDelivery').disabled,false);
 assert.equal(el('filters').disabled,true);
 await click('saveDelivery');
 assert.equal(el('webhook').value,'');
 assert.equal(el('secret').value,'');
 assert.equal(el('start').disabled,false);
 await click('start');
 await click('add');
 assert.equal(el('rule-select').value,'second');
 assert.equal(el('keyword').value,'');
 assert.equal(el('preview').disabled,true);
 assert.equal(el('delivery').disabled,true);
 el('keyword').value='ZVE1';
 el('settings').trigger('input');
 assert.equal(el('rule-select').disabled,true);
 assert.equal(el('start').disabled,true);
 assert.equal(el('save').disabled,false);
 el('settings').trigger('submit');await next();
 assert.equal(rules[0].config.keyword,'理光 GR2');
 assert.equal(rules[1].config.keyword,'ZVE1');
 await click('start');
 assert.equal(rules.every(r=>r.running),true);
 await click('stop');
 assert.equal(rules[0].running,true);
 assert.equal(rules[1].running,false);
 el('rule-select').value='default';
 el('rule-select').trigger('change');await next();
 assert.equal(el('keyword').value,'理光 GR2');
 assert.equal(el('filters').disabled,true);
 await click('stop');
 assert.equal(el('delivery').disabled,false);
 el('rule-select').value='second';
 el('rule-select').trigger('change');await next();
 await click('remove');
 assert.equal(rules.length,1);
 assert.equal(el('rule-select').value,'default');
 await click('preview');
 assert.equal(el('preview-list').children[0].children[0].textContent,'<img src=x>');
 assert.equal(calls.some(c=>c.type==='test'),false);
 console.log('设置页模拟交互通过，覆盖新增、保存、切换、多组运行、单独暂停、删除和凭据保护');
}run().catch(error=>{console.error(error);process.exitCode=1;});
