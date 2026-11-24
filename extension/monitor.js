'use strict';

const Monitor = (() => {
  const defaults = {keyword: '', min: null, max: null, minutes: 10};
  const normalize = value => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');

  function amount(input) {
    if (input === null || input === '' || input === undefined) return null;
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(String(input))) throw Error('价格须为非负金额，最多两位小数。');
    return Number(input);
  }
  function settings(raw) {
    const keyword = String(raw.keyword ?? '').trim().replace(/\s+/gu, ' ');
    const minutes = Number(raw.minutes);
    if (!keyword || keyword.length > 80) throw Error('关键词须为 1 至 80 个字符。');
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw Error('检测间隔须为 5 至 1440 的整数分钟。');
    const min = amount(raw.min);
    const max = amount(raw.max);
    if (min !== null && max !== null && min > max) throw Error('最低价不能高于最高价。');
    return {keyword, min, max, minutes};
  }
  function selectItems(rows, config) {
    const words = normalize(config.keyword).split(' ');
    const unique = new Map();
    for (const row of rows) {
      if (!/^\d{1,32}$/.test(row.id) || typeof row.title !== 'string' || !Number.isFinite(row.price) || row.price < 0) continue;
      if ((config.min !== null && row.price < config.min) || (config.max !== null && row.price > config.max)) continue;
      const title = normalize(row.title);
      if (!words.every(word => title.includes(word))) continue;
      unique.set(row.id, {id: row.id, title: row.title.replace(/\s+/gu, ' ').slice(0,100), price: row.price});
    }
    return [...unique.values()];
  }
  const emptyLedger = () => ({initialized: false, seen: [], pending: []});

  async function processScan(items, ledger, io) {
    const seen = new Set(ledger.seen);
    if (!ledger.initialized) {
      io.check();
      await io.save({initialized: true, seen: items.map(item => item.id), pending: []});
      return '已记录首次匹配的 ' + items.length + ' 件商品，后续发现新品时通知。';
    }
    const pending = new Map(ledger.pending.map(item => [item.id, item]));
    for (const item of items) {
      if (!seen.has(item.id)) pending.set(item.id, item);
    }
    ledger.pending = [...pending.values()];
    io.check();
    await io.save(ledger);
    let sent = 0;
    while (ledger.pending.length) {
      io.check();
      const batch = ledger.pending.slice(0, 10);
      await io.send(batch);
      for (const item of batch) seen.add(item.id);
      ledger.pending.splice(0, batch.length);
      ledger.seen = [...seen].slice(-20000);
      await io.save(ledger);
      sent += batch.length;
    }
    return '本轮匹配 ' + items.length + ' 件，新增通知 ' + sent + ' 件。';
  }
  return {defaults, settings, selectItems, processScan, emptyLedger};
})();
if (typeof module !== 'undefined') module.exports = Monitor;
