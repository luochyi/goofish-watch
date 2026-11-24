const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');

function event() {
  const listeners = new Set();
  return {
    addListener: callback => listeners.add(callback),
    removeListener: callback => listeners.delete(callback),
    fire: (...args) => Promise.all([...listeners].map(fn => fn(...args)))
  };
}
function store(seed = {}) {
  const values = structuredClone(seed);
  return {
    async get(query) {
      if (typeof query === 'string') return {[query]: values[query]};
      if (Array.isArray(query)) return Object.fromEntries(query.map(key => [key,values[key]]));
      return structuredClone({...query,...values});
    },
    async set(entries) {Object.assign(values, structuredClone(entries));},
    async remove(keys) {for (const key of keys) delete values[key];},
    async setAccessLevel({accessLevel}) {assert.equal(accessLevel,'TRUSTED_CONTEXTS');}
  };
}
function harness(seed = {}) {
  let now = 100000;
  class Clock extends Date { static now() {return now;} }
  const options = 'chrome-extension://test/options.html';
  const notifications = [];
  const fixture = {status: 'ok', keyword: '理光 GR2', items: []};
  const fixtures = new Map();
  const alarm = new Map();
  const tabs = new Map();
  const onUpdated = event();
  const onMessage = event();
  let refreshes = 0;
  const chrome = {
    storage: {local:store(seed), session:store()},
    tabs: {onUpdated, onRemoved: event(),
      create: async ({url}) => {const tab = {id:tabs.size+1,url,status:'complete'}; tabs.set(tab.id,tab);return tab;},
      get: async id => tabs.get(id),
      sendMessage: async id => structuredClone(fixtures.get(new URL(tabs.get(id).url).searchParams.get('q')) || fixture),
      reload: async id => {refreshes++;await onUpdated.fire(id,{status:'complete'});}
    },
    action: {onClicked:event()}, runtime: {onMessage,id:'test',getURL:() => options},
    alarms: {onAlarm:event(),create:async k=>alarm.set(k,{scheduledTime:1000}), get:async k=>alarm.get(k), clear:async k=>alarm.delete(k)}
  };
  const context = vm.createContext({chrome, btoa, Date: Clock, crypto: require('node:crypto').webcrypto, URL, TextEncoder, AbortSignal, setTimeout: (callback, ms) => setTimeout(callback, ms === 1000 ? 1 : ms), clearTimeout,
    fetch: async (url, opts) => {
      notifications.push(JSON.parse(opts.body).content.text);
      return {ok:true,json:async()=>({code:0})};
    }});
  const load = file => vm.runInContext(readFileSync(join(__dirname,'../extension',file),'utf8'),context,{filename:file});
  context.importScripts = (...files) => files.forEach(load);
  load('background.js');
  const message = (type, extra = {}) => new Promise(resolve => onMessage.fire({type,...extra},{id:'test',url:options},resolve));
  const tick = () => vm.runInContext('dispatch({type:"tick"})',context);
  return {message,tick,fixture,fixtures,tabs,notifications,chrome,advance: minutes => {now += minutes * 60000;},refreshes:()=>refreshes};
}
const config = {keyword:'理光 GR2',minutes:10,min:3000,max:5000};
const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/' + ['00000000','0000','0000','0000','000000000000'].join('-');
const product = id => ({id, title:'理光 GR2',price:3999});


test('旧版配置和去重迁移后保留，公共凭据仅返回是否存在', async () => {
  const ledger = {initialized:true,seen:['123'],pending:[]};
  const h = harness({config,ledger,webhook,secret:'test-only'});
  const response = await h.message('state');
  assert.equal(response.id,'default');
  assert.equal(response.config.keyword,config.keyword);
  assert.equal(response.hasWebhook,true);
  assert.equal(response.hasSecret,true);
  assert.equal(JSON.stringify(response).includes('test-only'),false);
  assert.equal(JSON.stringify(response).includes('hook/'),false);
  const stored = await h.chrome.storage.local.get(['rules','config','ledger']);
  assert.deepEqual(stored.rules[0].ledger,ledger);
  assert.equal(stored.config,undefined);
  const ignored = await h.chrome.runtime.onMessage.fire({type:'state'},{id:'test',url:'https://www.goofish.com/search'},()=>assert.fail());
  assert.deepEqual(ignored,[false]);
  h.fixture.items = [product('123'),product('124')];
  await h.message('start',{id:'default'});
  assert.equal(h.notifications.length,1);
  assert.doesNotMatch(h.notifications[0],/item\?id=123/);
});

test('多组条件各自基线、去重、间隔及暂停，顺序处理到期条件', async () => {
  const h = harness({config,webhook});
  const first = 'default';
  const second = (await h.message('add')).id;
  await h.message('save',{id:second,config:{...config,minutes:20,min:3500}});
  h.fixture.items = [product('123')];
  assert.equal((await h.message('preview',{id:first})).items.length,1);
  assert.equal((await h.message('start',{id:first})).ok,true);
  assert.equal((await h.message('start',{id:second})).ok,true);
  assert.equal(h.tabs.size,2);
  assert.equal((await h.message('state')).rules.filter(r=>r.running).length,2);
  assert.equal((await h.message('saveDelivery',{clearWebhook:true})).ok,false);
  h.fixture.items.push(product('124'));
  h.advance(10);
  await h.tick();
  assert.equal(h.notifications.length,1);
  assert.match(h.notifications[0],/item\?id=124/);
  assert.equal(h.refreshes(),1);
  h.advance(10);
  await h.tick();await h.tick();
  assert.equal(h.notifications.length,2);
  assert.equal(h.refreshes(),3);
  await h.message('stop',{id:first});
  assert.equal((await h.message('state',{id:second})).running,true);
  await h.message('save',{id:first,config:{...config,keyword:'ZVE1'}});
  const data = await h.chrome.storage.local.get('rules');
  assert.equal(data.rules.find(r=>r.id===second).ledger.seen.includes('124'),true);
  assert.equal(data.rules.find(r=>r.id===first).ledger.initialized,false);
  assert.equal((await h.message('remove',{id:first})).ok,true);
  assert.equal((await h.message('state')).id,second);
});

test('共享登录遇到验证码时全部暂停，关闭单一标签仅暂停对应条件', async () => {
  const h = harness({config,webhook});
  const second = (await h.message('add')).id;
  await h.message('start',{id:'default'});
  await h.message('save',{id:second,config});
  await h.message('start',{id:second});
  await h.chrome.tabs.onRemoved.fire(1);
  assert.equal((await h.message('state',{id:'default'})).running,false);
  assert.equal((await h.message('state',{id:second})).running,true);
  await h.message('start',{id:'default'});
  h.fixture.status='blocked';
  assert.equal((await h.message('preview',{id:second})).ok,false);
  assert.equal((await h.message('state')).rules.some(r=>r.running),false);
  await h.message('saveDelivery',{clearWebhook:true});
  assert.equal((await h.message('state')).hasSecret,false);
});

test('两个不同型号从各自搜索页读取并生成独立通知', async () => {
  const h = harness({config,webhook});
  const second = (await h.message('add')).id;
  await h.message('save',{id:second,config:{keyword:'ZVE1',min:6000,max:9000,minutes:5}});
  h.fixtures.set('ZVE1',{status:'ok',keyword:'ZVE1',items:[{id:'900',title:'Sony ZVE1',price:7500}]});
  h.fixture.items=[product('123')];
  await h.message('start',{id:'default'});
  await h.message('start',{id:second});
  h.fixtures.get('ZVE1').items.push({id:'901',title:'Sony ZVE1',price:7200});
  h.fixture.items.push(product('124'));
  h.advance(5);
  await h.tick();
  assert.match(h.notifications[0],/ZVE1/);
  assert.match(h.notifications[0],/item\?id=901/);
  h.advance(5);
  await h.tick();await h.tick();
  assert.equal(h.notifications.length,2);
  assert.match(h.notifications[1],/理光 GR2/);
  assert.match(h.notifications[1],/item\?id=124/);
});

test('新安装和新增条件均为空白，未填写时不能打开网页或开始通知', async () => {
  const h = harness({webhook});
  const initial = await h.message('state');
  assert.equal(initial.config.keyword,'');
  assert.equal((await h.message('preview',{id:initial.id})).ok,false);
  assert.equal((await h.message('start',{id:initial.id})).ok,false);
  const added = await h.message('add');
  assert.equal((await h.message('state',{id:added.id})).config.keyword,'');
  assert.equal((await h.message('start',{id:added.id})).ok,false);
  assert.equal(h.tabs.size,0);
  assert.equal(h.notifications.length,0);
});
