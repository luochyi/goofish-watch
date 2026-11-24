(() => {
  'use strict';

  const webhookPrefix = 'https://open.feishu.cn/open-apis/bot/v2/hook/';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const maxBodyBytes = 20 * 1024;
  const encoder = new TextEncoder();

  function validateWebhook(value) {
    const url = typeof value === 'string' ? value.trim() : '';
    if (!url.startsWith(webhookPrefix) || !uuid.test(url.slice(webhookPrefix.length))) {
      throw new Error('请输入完整的飞书群自定义机器人 V2 Webhook 地址。');
    }
    return url;
  }

  async function signPayload(payload, secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      // 飞书以“时间戳 + 换行 + 密钥”为 HMAC 密钥，对空字节串签名。
      const key = await crypto.subtle.importKey('raw', encoder.encode(timestamp + '\n' + secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = await crypto.subtle.sign('HMAC', key, new Uint8Array());
      payload.timestamp = timestamp;
      payload.sign = btoa(String.fromCharCode(...new Uint8Array(signature)));
    } catch {
      throw new Error('无法生成飞书签名，请检查本机扩展环境。');
    }
  }

  async function send(webhook, secret, text) {
    const url = validateWebhook(webhook);
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('飞书消息不能为空。');
    }
    if (text.length > maxBodyBytes) {
      throw new Error('飞书消息超过 20 KB，请缩短后再发送。');
    }
    // 全角尖括号使来自商品的文本无法触发飞书的成员或全员提醒标签。
    const content = { text: text.replaceAll('<', '＜').replaceAll('>', '＞') };
    const payload = { msg_type: 'text', content };
    if (secret) {
      await signPayload(payload, secret);
    }
    const body = JSON.stringify(payload);
    if (encoder.encode(body).byteLength > maxBodyBytes) {
      throw new Error('飞书消息超过 20 KB，请缩短后再发送。');
    }

    // 超时涵盖响应正文读取；请求结果未知时也不自动重发。
    const signal = AbortSignal.timeout(10000);
    let response, result;
    try {
      response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        cache: 'no-store', signal
      });
      if (response.ok) {
        result = await response.json();
      }
    } catch {
      if (signal.aborted) throw new Error('飞书请求超时，送达状态未知。');
      throw new Error('无法确认飞书是否接收消息，请检查网络和机器人设置。');
    }
    if (response.ok && result?.code === 0) return;
    // 仅展示本地固定文案，服务端错误可能带有请求中的敏感信息。
    switch (result?.code) {
      case 19021: throw new Error('飞书签名校验失败，请检查签名密钥和系统时间。');
      case 19022: throw new Error('飞书拒绝了当前出口 IP，请检查机器人的 IP 白名单。');
      case 19024: throw new Error('飞书关键词校验失败，请检查机器人的关键词设置。');
      case 11232: throw new Error('飞书机器人已达到发送频率限制。');
      default: throw new Error('飞书未确认接收消息，请检查群机器人设置。');
    }
  }

  globalThis.Feishu = Object.freeze({ validateWebhook, send });
})();
