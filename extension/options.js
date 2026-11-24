'use strict';

const byId = id => document.getElementById(id);
const settings = byId('settings');
const configKeys = ['keyword', 'min', 'max', 'minutes'];
const actionLabels = {
  save: '正在保存当前条件…',
  saveDelivery: '正在保存飞书设置…',
  add: '正在新增监控条件…',
  remove: '正在删除所选条件…',
  start: '正在读取监控页，准备开始…',
  stop: '正在暂停监控…',
  preview: '正在读取闲鱼搜索页…',
  test: '正在向已保存的机器人发送测试消息…'
};
const priceFormat = new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'CNY', minimumFractionDigits: 0, maximumFractionDigits: 2
});
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
});
let selectedId;
let current = null;
let connected = false;
let busy = false;
let revision = 0;

function configEdited() {
  return current && configKeys.some(key => String(current.config[key] ?? '') !== byId(key).value);
}
function deliveryEdited() {
  return Boolean(byId('webhook').value || byId('secret').value
    || byId('clear-webhook').checked || byId('clear-secret').checked);
}
function edited() { return configEdited() || deliveryEdited(); }

function refreshControls() {
  const locked = !connected || busy;
  const dirty = edited();
  const running = Boolean(current?.running);
  const anyRunning = current?.rules.some(rule => rule.running);
  const hasWebhook = Boolean(current?.hasWebhook);
  const clearWebhook = byId('clear-webhook').checked;
  byId('filters').disabled = locked || running || deliveryEdited();
  byId('delivery').disabled = locked || anyRunning || configEdited();
  byId('webhook').disabled = clearWebhook;
  byId('secret').disabled = clearWebhook || byId('clear-secret').checked;
  byId('clear-webhook').disabled = !hasWebhook;
  byId('clear-secret').disabled = clearWebhook || !current?.hasSecret;
  byId('save').disabled = locked || running || !configEdited() || deliveryEdited();
  byId('saveDelivery').disabled = locked || anyRunning || !deliveryEdited() || configEdited();
  byId('start').disabled = locked || dirty || running || !hasWebhook || !current?.config.keyword.trim();
  byId('stop').disabled = locked || !running;
  byId('preview').disabled = locked || dirty || !current?.config.keyword.trim();
  byId('test').disabled = locked || dirty || !hasWebhook;
  byId('add').disabled = locked || dirty;
  byId('remove').disabled = locked || dirty || running || current?.rules.length < 2;
  byId('rule-select').disabled = locked || dirty;
  byId('edit-state').textContent = running ? '暂停所选条件后可修改。修改飞书设置需暂停所有监控。'
    : configEdited() && deliveryEdited() ? '请先保留一处更改，分别保存监控条件和飞书设置。'
    : dirty ? '有未保存的更改，请点击对应的保存按钮。' : '';
}

function notice(message, error = false) {
  byId('feedback').textContent = message;
  byId('feedback').dataset.error = String(error);
}

function clearCredentials() {
  for (const key of ['secret', 'webhook']) {
    byId(key).value = '';
    byId('clear-' + key).checked = false;
  }
}

function applyState(state, replaceDraft) {
  const dirty = edited();
  const configChanged = current && (current.id !== state.id || configKeys.some(key => current.config[key] !== state.config[key]));
  current = state;
  selectedId = state.id;
  const picker = byId('rule-select');
  picker.replaceChildren();
  for (const rule of state.rules) {
    const option = document.createElement('option');
    option.value = rule.id;
    const low = rule.config.min ?? '不限';
    const high = rule.config.max ?? '不限';
    option.textContent = (rule.config.keyword || '未设置关键词') + ' · ' + low + '–' + high + ' 元 · ' + rule.config.minutes + ' 分钟 · ' + (rule.running ? '运行中' : '已暂停');
    picker.append(option);
  }
  picker.value = selectedId;
  byId('rule-summary').textContent = '共 ' + state.rules.length + ' 组条件，' + state.rules.filter(rule => rule.running).length + ' 组运行中。每组分别去重，通知共用已保存的飞书机器人。';
  connected = true;
  if (replaceDraft || !dirty) {
    for (const key of configKeys) byId(key).value = String(state.config[key] ?? '');
    clearCredentials();
  }
  if (configChanged) byId('results').hidden = true;
  const running = byId('running');
  running.textContent = state.running ? '运行中' : '已暂停';
  running.dataset.active = String(state.running);
  byId('status').textContent = state.status;
  byId('last-at').textContent = state.lastAt ? timeFormat.format(state.lastAt) : '尚无记录';
  byId('next-at').textContent = state.nextAt ? timeFormat.format(state.nextAt) : '尚未安排';
  byId('matched').textContent = state.lastAt ? state.matched + ' 件' : '—';
  byId('webhook-state').textContent = state.hasWebhook ? '已保存' : '未配置';
  byId('secret-state').textContent = state.hasSecret ? '已保存' : '未配置';
  refreshControls();
}

async function readState(replaceDraft = false) {
  const requestRevision = ++revision;
  let result;
  try { result = await chrome.runtime.sendMessage({type: 'state', id: selectedId}); } catch {}
  if (requestRevision !== revision) return;
  if (result?.ok) {
    applyState(result, replaceDraft);
  } else {
    connected = false;
    byId('running').textContent = '状态未知';
    byId('running').dataset.active = 'false';
    byId('status').textContent = result?.msg || '暂时无法读取扩展状态。请重新加载此页。';
    for (const id of ['last-at', 'next-at', 'matched']) byId(id).textContent = '—';
    refreshControls();
  }
}

function saveMessage(type) {
  const config = Object.fromEntries(configKeys.map(key => [key, byId(key).value.trim()]));
  if (type === 'save') {
    if (!config.keyword) byId('keyword').setCustomValidity('请输入商品关键词。');
    else if (config.min && config.max && Number(config.min) > Number(config.max)) {
      byId('max').setCustomValidity('最高价必须大于或等于最低价。');
    }
    if (!settings.reportValidity()) return null;
    return {type, id: selectedId, config};
  }
  const clearWebhook = byId('clear-webhook').checked;
  const clearSecret = clearWebhook || byId('clear-secret').checked;
  return {type, webhook: clearWebhook ? '' : byId('webhook').value.trim(),
    secret: clearSecret ? '' : byId('secret').value.trim(), clearWebhook, clearSecret};
}

function displayItems(items) {
  const list = byId('preview-list');
  list.replaceChildren();
  for (const item of items) {
    if (!/^\d{1,32}$/.test(item.id) || typeof item.title !== 'string' || !Number.isFinite(item.price)) continue;
    const row = document.createElement('li');
    const link = document.createElement('a');
    link.href = 'https://www.goofish.com/item?id=' + item.id;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = item.title;
    const price = document.createElement('span');
    price.textContent = priceFormat.format(item.price);
    row.append(link, price);
    list.append(row);
  }
  byId('preview-count').textContent = list.children.length ? '当前页面匹配 ' + list.children.length + ' 件商品。' : '当前页面没有符合条件的商品。';
  byId('results').hidden = false;
}

async function perform(type) {
  if (!connected || busy || byId(type).disabled || (edited() && !['save', 'saveDelivery', 'stop'].includes(type))) return;
  if (type === 'remove' && !confirm('删除这组监控条件及其去重记录？')) return;
  const message = ['save', 'saveDelivery'].includes(type) ? saveMessage(type) : {type, id: selectedId};
  if (!message) return;
  revision++;
  busy = true;
  refreshControls();
  if (type === 'preview') byId('results').hidden = true;
  const feedbackParent = type === 'save' ? settings : byId(type).closest('section');
  feedbackParent.append(byId('feedback'));
  notice(actionLabels[type]);
  let saved = false;
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (response?.ok) {
      saved = ['save', 'saveDelivery'].includes(type);
      if (type === 'add') { selectedId = response.id; saved = true; }
      if (type === 'remove') { selectedId = undefined; saved = true; }
      if (saved) clearCredentials();
      if (type === 'preview') displayItems(response.items ?? []);
      notice(response.msg || '操作已完成。');
    } else {
      notice(response?.msg || '扩展未确认操作结果，请检查监控状态。', true);
    }
  } catch {
    notice('与扩展的连接中断，请检查状态后再操作。', true);
  } finally {
    await readState(saved);
    busy = false;
    refreshControls();
  }
}

function onEdit() {
  for (const key of ['keyword', 'max', 'webhook']) byId(key).setCustomValidity('');
  refreshControls();
}
settings.addEventListener('input', onEdit);
settings.addEventListener('change', onEdit);
settings.addEventListener('submit', event => {
  event.preventDefault();
  void perform('save');
});
for (const type of ['start', 'stop', 'test', 'preview', 'saveDelivery', 'add', 'remove']) {
  byId(type).addEventListener('click', () => void perform(type));
}

byId('rule-select').addEventListener('change', () => {
  selectedId = byId('rule-select').value;
  byId('results').hidden = true;
  void readState(true);
});

function syncVisible() {
  if (!document.hidden && !busy) void readState();
}
document.addEventListener('visibilitychange', syncVisible);
setInterval(syncVisible, 15000);
void readState(true);
