'use strict';

(() => {
  const origin = 'https://www.goofish.com';
  const unknown = reason => ({status: 'unknown', reason});
  const blocked = () => ({status: 'blocked', reason: '页面要求登录或安全验证，或访问受到限制。'});

  function visible(node) {
    return node.getClientRects().length > 0 &&
      node.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
  }

  function visibleNodes(root, selector) {
    return [...root.querySelectorAll(selector)].filter(visible);
  }

  function byClassPrefix(root, prefix) {
    return visibleNodes(root, '[class*="' + prefix + '"]').filter(node =>
      node.getAttribute('class').split(/\s+/u).some(name => name.startsWith(prefix))
    );
  }

  function needsAttention(doc) {
    const panels = '[role="dialog"], dialog, [aria-modal="true"], [class*="login-modal" i], [class*="login-dialog" i], [class*="login-panel" i], [class*="login-box" i]';
    if (visibleNodes(doc, panels).some(node => /登录|验证码|安全验证|滑块|人机验证/u.test(node.innerText))) return true;
    const challenges = '[id="nc_1_wrapper"], [id="baxia-dialog-content"], [id*="captcha" i], [class*="captcha" i], input[type="password"]';
    if (visibleNodes(doc, challenges).length) return true;
    if (visibleNodes(doc, 'iframe[src]').some(node => /captcha|\/login\b|\/punish\b|\/verify\b|\/passport\.|\/login\./iu.test(node.getAttribute('src')))) return true;
    // 排除导航上的普通登录入口，同时识别替换整页或叠加在结果上的提示。
    const prompt = /^(?:(?:请(?:先)?(?:完成|进行|通过)?|需要)?(?:安全验证|人机验证|滑块验证|身份验证)|请(?:按住|拖动)滑块|访问(?:过于频繁|受限|被限制)|操作(?:过于|太)频繁|系统检测到(?:您的?)?(?:访问|操作)异常|请先登录|登录后(?:才可|可|即可|才能)(?:查看|继续|浏览|搜索)|扫码登录|密码登录|短信登录|请登录后(?:再试|查看|继续))/u;
    return (doc.body?.innerText ?? '').split('\n').some(line => prompt.test(line.trim()));
  }

  function readPrice(text) {
    // 只读取挂牌价节点，避免把旁边的原价、运费和想要人数拼进金额。
    const match = /^[¥￥]\s*((?:\d{1,3}(?:,\d{3})+|\d{1,9}))(?:\.(\d{1,2}))?\s*(万)?$/u.exec(text.trim());
    if (!match) return null;
    const whole = Number(match[1].replaceAll(',', ''));
    const fraction = Number((match[2] ?? '').padEnd(2, '0'));
    const cents = (whole * 100 + fraction) * (match[3] ? 10000 : 1);
    return Number.isSafeInteger(cents) ? cents / 100 : null;
  }

  function itemUrl(anchor, page) {
    try {
      return new URL(anchor.getAttribute('href'), page);
    } catch {
      return null;
    }
  }

  function readItem(card, page) {
    if (card.tagName !== 'A' || !card.getAttribute('href')) return null;
    const link = itemUrl(card, page);
    if (!link || link.origin !== origin || link.username || link.password || link.pathname !== '/item') return null;
    const ids = link.searchParams.getAll('id');
    if (ids.length !== 1 || !/^\d{1,32}$/u.test(ids[0])) return null;
    const titles = byClassPrefix(card, 'main-title--');
    const prices = byClassPrefix(card, 'price-wrap--');
    if (titles.length !== 1 || prices.length !== 1) return null;
    const title = titles[0].innerText.replace(/\s+/gu, ' ').trim();
    if (!title || title.length > 4096) return null;
    const price = readPrice(prices[0].textContent);
    return price === null ? null : {id: ids[0], title, price};
  }

  function snapshot(doc, href) {
    if (needsAttention(doc)) return blocked();
    const page = new URL(href);
    const keywords = page.searchParams.getAll('q');
    if (page.origin !== origin || page.username || page.password || page.pathname !== '/search' ||
        keywords.length !== 1 || !keywords[0].trim()) return unknown('当前页不是有效的闲鱼关键词搜索页。');
    const keyword = keywords[0].trim();
    if (!doc.body || doc.readyState === 'loading') return unknown('搜索页正在加载。');
    const lists = byClassPrefix(doc, 'feeds-list-container--');
    if (lists.length !== 1) return unknown('未能确认搜索结果列表。');
    const list = lists[0];
    if (list.getAttribute('aria-busy') === 'true' ||
        visibleNodes(list, '[aria-busy="true"], [class*="skeleton" i]').length) return unknown('搜索结果正在加载。');

    const cards = byClassPrefix(list, 'feeds-item-wrap--');
    const knownCards = new Set(cards);
    const unmatched = visibleNodes(list, 'a[href]').some(anchor =>
      !knownCards.has(anchor) && itemUrl(anchor, page)?.pathname === '/item'
    );
    if (unmatched) return unknown('部分商品卡片的结构未能识别。');
    const emptyText = /^(?:没有找到相关(?:宝贝|商品)|未找到相关(?:宝贝|商品)|暂无相关(?:宝贝|商品)|没有搜索结果)[。！!]?$/u;
    const empty = visibleNodes(list, '[class*="empty" i], [class*="no-result" i]').some(node => emptyText.test(node.innerText.trim()));
    if (!cards.length && !empty) return unknown('未能确认商品列表是否已加载。');
    if (cards.length && empty) return unknown('结果列表仍在变化。');

    const items = new Map();
    for (const card of cards) {
      const item = readItem(card, page);
      if (!item) return unknown('部分商品的编号、标题或价格未能识别。');
      const previous = items.get(item.id);
      if (previous && (previous.title !== item.title || previous.price !== item.price)) return unknown('同一商品的信息仍在变化。');
      items.set(item.id, item);
    }
    return {status: 'ok', items: [...items.values()], keyword};
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = {snapshot};
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, reply) => {
      if (message?.type !== 'scan') return;
      let result;
      try { result = snapshot(document, location.href); }
      catch { result = unknown('读取搜索页时出现异常。'); }
      reply(result);
    });
  }
})();
