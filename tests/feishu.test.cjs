const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { webcrypto, createHmac } = require('node:crypto');
const vm = require('node:vm');

// 全部地址和密钥仅作测试；测试环境的 fetch 不会访问外网。
const id = '00000000-0000-4000-8000-000000000000';
const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/' + id;
const key = '仅限本地测试的密钥';
const source = join(__dirname, '../extension/feishu.js');

function setup(reply = () => Response.json({ code: 0 }), overrides = {}) {
  const requests = [];
  const context = vm.createContext({
    crypto: webcrypto, btoa, TextEncoder, AbortSignal, URL,
    fetch: async (target, options) => {
      requests.push(new Request(target, options));
      return reply();
    },
    ...overrides
  });
  vm.runInContext(readFileSync(source, 'utf8'), context);
  return { api: context.Feishu, requests };
}

test('只接受飞书官方 V2 机器人地址', () => {
  const { api } = setup();
  assert.equal(api.validateWebhook(' ' + url + '\n'), url);
  const invalid = [
    null, url.replace('https:', 'http:'), url.replace('.cn/', '.cn.example/'),
    url.replace('//open', '//private@open'), url.replace('.cn/', '.cn:8443/'),
    url.replace('/open-apis', '/other/../open-apis'), url.replace('/bot/', '/BOT/'),
    url.replace(id, 'hello'), url + '/', url + '#', url + '?', url + '?secret=x',
    url + '#private', url.replace('open.feishu', 'open.\nfeishu')
  ];
  const errors = invalid.map(value => {
    let message;
    assert.throws(() => api.validateWebhook(value), error => {
      message = error.message;
      return /[\u4e00-\u9fff]/u.test(message);
    });
    return message;
  });
  assert.equal(new Set(errors).size, 1);
});

test('发送单个纯文本请求并隔离凭据、来源及重定向', async () => {
  const { api, requests } = setup();
  await api.send(url, '', '现价 800 元\n<at user_id="all">所有人</at>');
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.url, url);
  assert.equal(request.method, 'POST');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.redirect, 'error');
  assert.equal(request.referrerPolicy, 'no-referrer');
  assert.equal(request.headers.has('Authorization'), false);
  assert.equal(request.headers.has('Cookie'), false);
  assert.match(request.headers.get('Content-Type'), /^application\/json\b/);
  const payload = await request.json();
  assert.deepEqual(Object.keys(payload).sort(), ['content', 'msg_type']);
  assert.equal(payload.msg_type, 'text');
  assert.match(payload.content.text, /^现价 800 元\n/);
  assert.doesNotMatch(payload.content.text, /<at\b/i);
});

test('使用秒时间戳和密钥为零字节消息签名，密钥不进入正文', async () => {
  const { api, requests } = setup();
  await api.send(url, key, '关键词\n商品');
  const body = await requests[0].text();
  assert.equal(body.includes(key), false);
  const { timestamp, sign } = JSON.parse(body);
  assert.match(timestamp, /^\d{10}$/);
  assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 10);
  assert.equal(sign, createHmac('sha256', timestamp + '\n' + key).digest('base64'));
});

test('按整个 JSON 的 UTF-8 大小检查上限，拒绝空白或超长消息', async () => {
  const { api, requests } = setup();
  await api.send(url, '', '甲'.repeat(6600));
  for (const invalid of ['  ', '甲'.repeat(6900), '\u0000'.repeat(4000)]) {
    await assert.rejects(api.send(url, '', invalid), /[\u4e00-\u9fff]/u);
  }
  assert.equal(requests.length, 1);
});

test('失败仅返回本地错误文案，忽略远端内容并且不重试', async () => {
  const privateText = key + ' ' + url;
  for (const reply of [
    () => Response.json({ code: 19021, msg: privateText }),
    () => Response.json({ code: 19024, msg: privateText }),
    () => Response.json({ StatusCode: 0, msg: privateText }),
    () => Response.json({ code: '0' }),
    () => Response.json({ code: 0 }, { status: 502 }),
    () => new Response(privateText),
    () => { throw new Error(privateText); }
  ]) {
    const { api, requests } = setup(reply);
    await assert.rejects(api.send(url, key, '消息'), error =>
      /[\u4e00-\u9fff]/u.test(error.message) &&
      !error.message.includes(key) && !error.message.includes(id) && !error.cause);
    assert.equal(requests.length, 1);
  }
});

test('请求有超时中止信号，超时只返回本地错误', async () => {
  const requests = [];
  const { api } = setup(undefined, {
    AbortSignal: { timeout(ms) {
      assert.ok(ms >= 1000 && ms <= 30000);
      return AbortSignal.abort(new Error(key));
    } },
    fetch: async (_url, options) => {
      requests.push(options);
      options.signal.throwIfAborted();
      return Response.json({ code: 0 });
    }
  });
  await assert.rejects(api.send(url, '', '消息'), error =>
    /[\u4e00-\u9fff]/u.test(error.message) && !error.message.includes(key));
  assert.equal(requests.length, 1);
});
