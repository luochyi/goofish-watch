const test = require('node:test');
const assert = require('node:assert/strict');
const { settings, selectItems, processScan, emptyLedger } = require('../extension/monitor.js');

const config = settings({keyword: '理光 GR2', min: 2000, max: 4000, minutes: 10});
const product = (id, price = 3999, title = '理光 gr2 成色良好') => ({id: String(id), title, price});
test('关键词逐词匹配，价格范围包含两端，商品链接按数字 ID 去重', () => {
  const rows = [product(1, 2000), product(1), product(2, 4000, 'ＧＲ２ 理光'),
    product(3, 1000), product(4, 3000, '理光 GR3'), product('fake')];
  assert.deepEqual(selectItems(rows, config).map(x => x.id), ['1','2']);
});
test('间隔和价格输入校验，空价格表示不限', () => {
  for (const values of [{minutes:4}, {minutes:5.1}, {min:-1}, {max:100}, {min:'2e3'}, {min:'1.999'}, {keyword:'  '}]) {
    assert.throws(() => settings({...config,...values}));
  }
  assert.equal(settings({...config,min:'',max:null}).min,null);
});
test('初次静默，重启保持去重，失败通知持久保留，新一轮即使商品离开页面仍可补发', async () => {
  let state = emptyLedger();
  let deliveries = [];
  const run = (items, fail=false) => processScan(items, structuredClone(state), {
    save: async value => {state = structuredClone(value)}, check: () => {},
    send: async batch => {if(fail) throw Error('模拟断网'); deliveries.push(batch.map(x=>x.id))}
  });
  await run([product(1)]);
  await run([product(1),product(2)]);
  await run([product(2)]);
  await assert.rejects(run([product(3)],true));
  assert.deepEqual(state.pending.map(x=>x.id), ['3']);
  await run([]);
  assert.deepEqual(deliveries,[['2'],['3']]);
  assert.equal(state.pending.length,0);
});
