'use strict';

(() => {
  async function waitForScan(read, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now) {
    const deadline = now() + 15000;
    let previous = '';
    let consecutive = 0;
    let result;
    while (now() <= deadline) {
      result = await read();
      if (result.status === 'blocked') return result;
      if (now() > deadline) break;
      const signature = result.status === 'ok' ? JSON.stringify(result) : '';
      consecutive = signature && signature === previous ? consecutive + 1 : 1;
      previous = signature;
      // 空结果等待更久，以免把列表首次渲染前的短暂占位当成基线。
      if (signature && consecutive >= (result.items.length ? 3 : 6)) return result;
      if (now() + 1000 > deadline) break;
      await sleep(1000);
    }
    return result?.status === 'unknown' ? result : {status: 'unknown', reason: '搜索结果在等待时间内未稳定。'};
  }

  const api = {waitForScan};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.Stability = api;
})();
