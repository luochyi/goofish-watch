'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const readerPath = path.join(__dirname, '../extension/reader.js');
const api = require(readerPath);
const stabilityPath = path.join(__dirname, '../extension/stability.js');
const stability = require(stabilityPath);
const search = 'https://www.goofish.com/search?q=%E7%90%86%E5%85%89+GR2';

// 只模拟本组件读取的 DOM 属性和标准“标签 + 属性”选择器。
function element(tag, attrs = {}, value = '', children = []) {
  const node = {
    tagName: tag.toUpperCase(),
    getAttribute: key => attrs[key] ?? null,
    get textContent() { return [value, ...children.map(n => n.textContent)].join(''); },
    get innerText() { return [value, ...children.filter(n => n.checkVisibility()).map(n => n.innerText)].join('\n').trim(); },
    checkVisibility() { return !('hidden' in attrs) && (node.parentElement?.checkVisibility() ?? true); },
    getClientRects() { return node.checkVisibility() ? [{}] : []; },
    querySelectorAll(selector) {
      const alternatives = selector.split(',').map(s => s.trim());
      const matches = child => alternatives.some(s => {
        const match = /^([\w-]+)?(?:\[([\w-]+)(?:([*=^$]+)"([^"]*)"( i)?)?\])?$/i.exec(s);
        assert.ok(match, '测试夹具不支持该选择器：' + s);
        const [,tagName, key, operator, expected, insensitive] = match;
        if (tagName && child.tagName.toLowerCase() !== tagName.toLowerCase()) return false;
        if (!key) return true;
        let actual = child.getAttribute(key);
        if (actual === null) return false;
        if (!operator) return true;
        let pattern = expected;
        if (insensitive) {
          actual = actual.toLowerCase();
          pattern = expected.toLowerCase();
        }
        if (operator === '*=') return actual.includes(pattern);
        if (operator === '^=') return actual.startsWith(pattern);
        return actual === pattern;
      });
      return children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
  };
  for (const child of children) child.parentElement = node;
  return node;
}
const named = (prefix, text = '', children = []) => element('div', {class: 'test ' + prefix + '--abc'}, text, children);
const card = (id, title, price, attrs = {}) => element('a', {class: 'test feeds-item-wrap--xyz', href: '/item?id=' + id + '&categoryId=88', ...attrs}, '', [
  named('main-title', title), named('price-wrap', price), named('price-desc', '129人想要，旧价9999')
]);
function page(cards, extra = []) {
  const body = element('body', {}, '', [named('feeds-list-container', '', cards), ...extra]);
  return {body, querySelectorAll: selector => body.querySelectorAll(selector)};
}

test('只提取结果卡片中的商品编号、标题和挂牌价，保留末尾关键词', () => {
  const title = '配件'.repeat(90) + ' 理光 GR2';
  const doc = page([card('123', title, '¥3999'), card('456', '整机', '￥1.19万'), card('456', '整机', '￥1.19万'), card('bad', '隐藏', '¥?', {hidden:''})], [card('789', '推荐', '¥1')]);
  assert.deepEqual(api.snapshot(doc, search), {status:'ok', keyword:'理光 GR2', items:[
    {id:'123', title, price:3999}, {id:'456', title:'整机', price:11900}
  ]});
});

test('价格须为独立金额，无法解析和部分解析都返回未知', () => {
  for (const bad of ['¥3-999', '¥3.5起', '¥3.5 ¥5', '3件', '¥1 99', '¥1.234', '面议']) {
    assert.equal(api.snapshot(page([card('1','相机','¥1'),card('2','相机',bad)]), search).status, 'unknown', bad);
  }
  assert.equal(api.snapshot(page([card('2','','¥5')]), search).status, 'unknown');
});

test('搜索页和商品链接必须来自指定站点和路径', () => {
  for (const href of ['/item?id=1&id=2','/item?id=x','https://other.example/item?id=2','/other?id=2','//www.goofish.com:8080/item?id=2']) {
    assert.equal(api.snapshot(page([card('1','相机','¥8',{href})]),search).status,'unknown',href);
  }
  for (const addr of ['https://other.example/search?q=x','https://www.goofish.com/items?q=x','https://www.goofish.com/search?q=']) {
    assert.equal(api.snapshot(page([card('1','相机','¥8')]),addr).status,'unknown',addr);
  }
});

test('可见的登录框或验证提示优先于已有结果，普通登录入口可与结果共存', () => {
  const result = [card('1','相机','¥8')];
  for (const extra of [element('div',{role:'dialog'},'请登录'),element('div',{},'请完成安全验证'),element('iframe',{src:'https://passport.example/login'})]) {
    assert.equal(api.snapshot(page(result,[extra]),search).status,'blocked');
  }
  assert.equal(api.snapshot(page(result,[element('button',{},'登录'),element('div',{role:'dialog',hidden:''},'请登录')]),search).status,'ok');
});

test('空白、加载中、异常结构与确认无结果分开处理', () => {
  assert.equal(api.snapshot(page([]),search).status,'unknown');
  assert.equal(api.snapshot(page([card('1','相机','¥8'),named('skeleton')]),search).status,'unknown');
  assert.equal(api.snapshot(page([card('1','相机','¥8'),element('a',{href:'/item?id=2'},'新结构')]),search).status,'unknown');
  assert.equal(api.snapshot(page([card('1','相机','¥8'),card('1','相机','¥9')]),search).status,'unknown');
  assert.equal(api.snapshot(page([],[element('div',{},'没有找到相关宝贝')]),search).status,'unknown');
  assert.deepEqual(api.snapshot(page([named('empty','没有找到相关宝贝')]),search),{status:'ok',keyword:'理光 GR2',items:[]});
});

test('稳定读取会等待分批渲染，阻断时立刻返回，超时返回未知', async () => {
  const one = api.snapshot(page([card('1','相机','¥5')]),search);
  const two = api.snapshot(page([card('1','相机','¥5'),card('2','相机','¥8')]),search);
  const states = [{status:'unknown', reason:'加载中'},one,two,two,two];
  let elapsed = 0;
  const sleep = async ms => { assert.equal(ms,1000); elapsed += ms; };
  assert.deepEqual(await stability.waitForScan(async () => states.shift() ?? two, sleep, () => elapsed),two);
  assert.ok(elapsed >= 4000);
  const blocked = {status:'blocked',reason:'请验证'};
  assert.deepEqual(await stability.waitForScan(async () => blocked, () => assert.fail(), () => 0),blocked);
  elapsed = 0;
  const unknown = await stability.waitForScan(async () => ({status:'unknown',reason:'加载中'}),sleep,() => elapsed);
  assert.equal(unknown.status,'unknown');
  assert.equal(elapsed,15000);
});

test('等待逻辑可作为经典脚本在扩展后台加载', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(stabilityPath,'utf8'),context);
  assert.equal(typeof context.Stability.waitForScan,'function');
});

test('内容脚本只响应 scan，并在同一次调用内回复单次页面快照', () => {
  let listener;
  const doc = page([card('1','相机','¥8')]);
  const context = {chrome:{runtime:{onMessage:{addListener:fn=>{listener=fn;}}}},document:doc,location:new URL(search),URL};
  vm.runInNewContext(fs.readFileSync(readerPath,'utf8'),context);
  assert.equal(listener({type:'other'}, {}, () => assert.fail()),undefined);
  let response;
  listener({type:'scan'},{},result => {response = result;});
  assert.equal(response?.status,'ok');
  assert.equal(response.items[0].id,'1');
});
