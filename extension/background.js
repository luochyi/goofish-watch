'use strict';
importScripts('feishu.js', 'monitor.js', 'stability.js');

const local = chrome.storage.local;
const session = chrome.storage.session;
const alarmName = 'goofish-scan';
const searchUrl = keyword => 'https://www.goofish.com/search?q=' + encodeURIComponent(keyword);
const safeError = message => Object.assign(new Error(message), {display: true});
const versions = new Map();
const stopping = new Set();
let queue = Promise.resolve();

async function initialize() {
  await local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  const old = await local.get(['rules', 'config', 'ledger']);
  if (!old.rules) {
    // 单次写入迁移数据，旧版关键词、价格和去重记录均保留。
    await local.set({rules: [{id: 'default', config: old.config || Monitor.defaults,
      ledger: old.ledger || Monitor.emptyLedger()}]});
    await local.remove(['config', 'ledger']);
  }
  const {runtimes = {}} = await session.get('runtimes');
  if (Object.values(runtimes).some(r => r.running)) {
    if (!await chrome.alarms.get(alarmName)) await schedule();
  } else await chrome.alarms.clear(alarmName);
}
const ready = initialize();

async function schedule() {
  await chrome.alarms.create(alarmName, {periodInMinutes: 1, delayInMinutes: 1});
}
async function rules() {
  return (await local.get('rules')).rules;
}
async function runtime(id) {
  const {runtimes = {}} = await session.get('runtimes');
  return runtimes[id] || {running: false, status: '已暂停', nextAt: 0, lastAt: 0, matched: 0};
}
async function updateRuntime(id, patch) {
  const {runtimes = {}} = await session.get('runtimes');
  runtimes[id] = {...await runtime(id), ...patch};
  await session.set({runtimes});
}
async function pause(id, status) {
  await updateRuntime(id, {running: false, nextAt: 0, status});
  const {runtimes} = await session.get('runtimes');
  if (!Object.values(runtimes).some(r => r.running)) await chrome.alarms.clear(alarmName);
}
async function saveLedger(id, ledger) {
  const list = await rules();
  const rule = list.find(r => r.id === id);
  if (!rule) throw safeError('该监控条件已被删除。');
  rule.ledger = ledger;
  await local.set({rules: list});
}
function onSearch(raw, keyword) {
  try {
    const url = new URL(raw);
    return url.origin === 'https://www.goofish.com' && url.pathname === '/search' && url.searchParams.get('q') === keyword;
  } catch {
    return false;
  }
}

async function readTab(id, keyword, check, stable = true) {
  const probe = async () => {
    check();
    const tab = await chrome.tabs.get(id);
    if (tab.status !== 'complete' || tab.pendingUrl) return {status: 'unknown'};
    if (!onSearch(tab.url, keyword)) throw safeError('监控页地址已变化。请在该标签中检查登录或验证状态。');
    let timeout;
    try {
      const snapshot = await Promise.race([
        chrome.tabs.sendMessage(id, {type: 'scan'}).catch(() => null),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(safeError('监控标签未响应，请检查后重新开始。')), 4000);
        })
      ]);
      return snapshot || {status: 'unknown'};
    } finally { clearTimeout(timeout); }
  };
  // 稳定性检查在扩展后台计时，避免后台网页的定时器被浏览器限速。
  const result = stable ? await Stability.waitForScan(probe) : await probe();
  if (result.status !== 'ok' || result.keyword !== keyword || !Array.isArray(result.items)) {
    throw Object.assign(safeError(result.status === 'blocked' ? '网页提示登录、安全验证或访问受限，请在监控页手动处理。' : '搜索结果尚未就绪或页面结构已变化，请检查监控页。'), {blocked: result.status === 'blocked'});
  }
  return result.items;
}

async function reloadTab(id) {
  // 必须等待本次导航完成，避免把刷新前的旧页面当作新结果。
  let listener;
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      listener = (changedId, info) => {
        if (id === changedId && info.status === 'complete') resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
      timeout = setTimeout(() => reject(safeError('刷新搜索页超时，请检查页面。')), 20000);
      chrome.tabs.reload(id).catch(reject);
    });
  } finally {
    clearTimeout(timeout);
    chrome.tabs.onUpdated.removeListener(listener);
  }
}


async function readSearch(rule, refresh, check) {
  const {id, config} = rule;
  const current = await runtime(id);
  let tab = Number.isInteger(current.tabId) ? await chrome.tabs.get(current.tabId).catch(() => null) : null;
  check();
  if (!tab || current.tabKeyword !== config.keyword) {
    if (current.running && refresh) throw safeError('监控标签已关闭，请重新开始。');
    tab = await chrome.tabs.create({url: searchUrl(config.keyword), active: false});
    await updateRuntime(id, {tabId: tab.id, tabKeyword: config.keyword});
  } else if (refresh) {
    await readTab(tab.id, config.keyword, check, false);
    check();
    await reloadTab(tab.id);
  }
  const rows = await readTab(tab.id, config.keyword, check);
  check();
  return Monitor.selectItems(rows, config);
}
async function scan(rule, refresh, check) {
  const {webhook, secret = ''} = await local.get(['webhook','secret']);
  if (!webhook) throw safeError('请先保存飞书机器人的 Webhook。');
  const items = await readSearch(rule, refresh, check);
  const status = await Monitor.processScan(items, rule.ledger, {
    check, save: ledger => saveLedger(rule.id, ledger),
    send: async batch => {
      const lines = batch.map(item => '¥' + item.price + '  ' + item.title + '\nhttps://www.goofish.com/item?id=' + item.id);
      try { await Feishu.send(webhook, secret, ['闲鱼监控 · ' + rule.config.keyword, ...lines].join('\n\n')); }
      catch (error) { throw safeError(error.message); }
    }
  });
  check();
  await updateRuntime(rule.id, {lastAt: Date.now(), matched: items.length, status,
    nextAt: Date.now() + rule.config.minutes * 60000});
  return status;
}
async function state(id) {
  const {webhook, secret} = await local.get(['webhook','secret']);
  const list = await rules();
  const summaries = [];
  for (const rule of list) summaries.push({id: rule.id, config: rule.config, ...await runtime(rule.id)});
  const selected = summaries.find(r => r.id === id) || summaries[0];
  return {ok: true, ...selected, rules: summaries, hasWebhook: !!webhook, hasSecret: !!secret};
}
async function saveDelivery(message) {
  const list = await rules();
  for (const rule of list) {
    if ((await runtime(rule.id)).running) throw safeError('请先暂停所有监控，再修改飞书设置。');
  }
  const previous = await local.get({webhook: '', secret: ''});
  let webhook;
  try { webhook = message.clearWebhook ? '' : (message.webhook ? Feishu.validateWebhook(message.webhook.trim()) : previous.webhook); }
  catch (error) { throw safeError(error.message); }
  const reset = webhook !== previous.webhook;
  const secret = !webhook || message.clearSecret ? '' : (message.secret?.trim() || (reset ? '' : previous.secret));
  if (secret.length > 512) throw safeError('签名密钥过长，请检查。');
  const updated = {webhook, secret};
  if (reset) updated.rules = list.map(rule => ({...rule, ledger: Monitor.emptyLedger()}));
  await local.set(updated);
  return {ok: true, msg: '飞书设置已保存。'};
}
async function execute(message, requestedVersion) {
  if (message.type === 'state') return state(message.id);
  if (message.type === 'saveDelivery') return saveDelivery(message);
  if (message.type === 'test') {
    const {webhook, secret} = await local.get(['webhook','secret']);
    if (!webhook) throw safeError('请先保存机器人的 Webhook。');
    try { await Feishu.send(webhook, secret, '闲鱼监控 · 通知测试成功。'); }
    catch (error) { throw safeError(error.message); }
    return {ok: true, msg: '飞书已接收测试消息，请在群里核对。'};
  }
  const list = await rules();
  if (message.type === 'add') {
    const id = crypto.randomUUID();
    list.push({id, config: {...Monitor.defaults}, ledger: Monitor.emptyLedger()});
    await local.set({rules: list});
    return {ok: true, id, msg: '已新增监控条件，请修改关键词并保存。'};
  }
  if (message.type === 'tick') {
    // 每分钟最多处理一组到期条件，避免多个搜索页同时刷新。
    const due = [];
    for (const rule of list) {
      const current = await runtime(rule.id);
      if (current.running && current.nextAt <= Date.now()) due.push({rule, nextAt: current.nextAt});
    }
    due.sort((a,b) => a.nextAt - b.nextAt);
    if (!due.length) return {ok: true};
    return runRule(due[0].rule, true);
  }
  const rule = list.find(r => r.id === message.id);
  if (!rule) throw safeError('请选择有效的监控条件。');
  if (message.type === 'stop') {
    await pause(rule.id, '已手动暂停。');
    return {ok: true, msg: '这组监控已暂停。'};
  }
  if (message.type === 'save') {
    if ((await runtime(rule.id)).running) throw safeError('请先暂停这组监控再保存。');
    let config;
    try { config = Monitor.settings(message.config); }
    catch (error) { throw safeError(error.message); }
    if (['keyword','min','max'].some(key => config[key] !== rule.config[key])) {
      rule.ledger = Monitor.emptyLedger();
      await updateRuntime(rule.id, {lastAt: 0, matched: 0, status: '条件已更新，下次开始会建立新基线。'});
    }
    rule.config = config;
    await local.set({rules: list});
    return {ok: true, msg: '这组条件已保存。'};
  }
  if (message.type === 'remove') {
    if (list.length === 1) throw safeError('请至少保留一组监控条件。');
    if ((await runtime(rule.id)).running) throw safeError('请先暂停这组监控再删除。');
    await local.set({rules: list.filter(r => r.id !== rule.id)});
    const {runtimes = {}} = await session.get('runtimes');
    delete runtimes[rule.id];
    await session.set({runtimes});
    return {ok: true, msg: '条件及其去重记录已删除，原搜索标签可手动关闭。'};
  }
  if (message.type === 'start') {
    if (requestedVersion !== (versions.get(rule.id) || 0)) throw safeError('这组监控的启动已取消。');
    stopping.delete(rule.id);
  }
  if (message.type === 'start' || message.type === 'preview') return runRule(rule, false, message.type);
  throw safeError('未知操作。');
}
async function runRule(rule, refresh, type = 'tick') {
  const token = versions.get(rule.id) || 0;
  const check = () => {
    if (type !== 'preview' && stopping.has(rule.id)) throw safeError('已中止这组监控。');
    if (token !== (versions.get(rule.id) || 0)) throw safeError('已中止这组监控。');
  };
  try {
    try { Monitor.settings(rule.config); }
    catch (error) { throw safeError(error.message); }
    if (type === 'preview') {
      const items = await readSearch(rule, false, check);
      return {ok: true, items, msg: '当前条件匹配 ' + items.length + ' 件商品。'};
    }
    if (type === 'start' && (await runtime(rule.id)).running) return {ok: true, msg: '这组监控已在运行。'};
    const msg = await scan(rule, refresh, check);
    check();
    await updateRuntime(rule.id, {running: true});
    if (!await chrome.alarms.get(alarmName)) await schedule();
    return {ok: true, msg};
  } catch (error) {
    const msg = error.display ? error.message : '读取未完成，请检查这组条件的监控标签后重试。';
    if (error.blocked) {
      for (const other of await rules()) await pause(other.id, msg + ' 所有监控已暂停。');
    } else await pause(rule.id, msg);
    return {ok: false, msg};
  }
}
function dispatch(message) {
  if (message.type === 'stop') {
    stopping.add(message.id);
    versions.set(message.id, (versions.get(message.id) || 0) + 1);
  }
  const requestedVersion = versions.get(message.id) || 0;
  const job = queue.then(async () => {
    await ready;
    try { return await execute(message, requestedVersion); }
    catch (error) { return {ok: false, msg: error.display ? error.message : '操作未完成，请检查本地存储和扩展权限。'}; }
  });
  queue = job.catch(() => {});
  return job;
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('options.html')) return false;
  if (!['state','save','saveDelivery','start','stop','test','preview','add','remove'].includes(message?.type)) return false;
  dispatch(message).then(reply, () => reply({ok: false, msg: '本地存储不可用。'}));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === alarmName) void dispatch({type: 'tick'});
});
chrome.tabs.onRemoved.addListener(id => {
  const job = queue.then(async () => {
    await ready;
    for (const rule of await rules()) {
      if ((await runtime(rule.id)).tabId === id) {
        await updateRuntime(rule.id, {tabId: null, tabKeyword: null});
        await pause(rule.id, '这组监控标签已关闭。');
      }
    }
  });
  queue = job.catch(() => {});
  return job;
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
