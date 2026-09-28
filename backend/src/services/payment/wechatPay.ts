import crypto from 'crypto';
import axios from 'axios';
import { env } from '../../config/env';

const WECHAT_API_BASE = 'https://api.mch.weixin.qq.com';

interface WechatOrderParams {
  orderNo: string;
  amount: number;
  description: string;
  openid?: string;
  paymentCycle: 'ANNUAL' | 'MONTHLY';
}

function isSandbox(): boolean {
  const config = env();
  return !config.WECHAT_APP_ID || !config.WECHAT_MCH_ID || !config.WECHAT_API_KEY;
}

function generateSign(params: Record<string, string>, apiKey: string): string {
  const sorted = Object.keys(params).sort();
  const str = sorted.map(k => k + '=' + params[k]).join('&') + '&key=' + apiKey;
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
}

function nonceStr(): string {
  return crypto.randomBytes(16).toString('hex');
}

export async function createWechatOrder(params: WechatOrderParams) {
  const config = env();

  if (isSandbox()) {
    console.log('[WechatPay] Sandbox mode - returning mock order');
    return {
      prepayId: 'wx' + crypto.randomBytes(16).toString('hex'),
      codeUrl: 'weixin://wxpay/bizpayurl?pr=mock_sandbox',
      orderNo: params.orderNo,
    };
  }

  const body: Record<string, string> = {
    appid: config.WECHAT_APP_ID || '',
    mch_id: config.WECHAT_MCH_ID || '',
    nonce_str: nonceStr(),
    body: params.description,
    out_trade_no: params.orderNo,
    total_fee: String(params.amount),
    spbill_create_ip: '127.0.0.1',
    notify_url: process.env.BASE_URL || 'http://localhost:3000' + '/api/payments/callback/wechat',
    trade_type: 'NATIVE',
  };

  body.sign = generateSign(body, config.WECHAT_API_KEY || '');

  const xmlBody = '<xml>' +
    Object.entries(body).map(function(e) { return '<' + e[0] + '><![CDATA[' + e[1] + ']]></' + e[0] + '>'; }).join('') +
    '</xml>';

  const response = await axios.post(WECHAT_API_BASE + '/pay/unifiedorder', xmlBody, {
    headers: { 'Content-Type': 'application/xml' },
    timeout: 10000,
  });

  const result = parseWechatXml(response.data);
  return {
    prepayId: result.prepay_id,
    codeUrl: result.code_url,
    orderNo: params.orderNo,
  };
}

export function verifyWechatCallback(body: Record<string, string>): boolean {
  const config = env();
  if (isSandbox()) {
    console.log('[WechatPay] Sandbox mode - accepting all callbacks');
    return true;
  }
  const sign = body.sign;
  const params = Object.assign({}, body);
  delete params.sign;
  const expectedSign = generateSign(params, config.WECHAT_API_KEY || '');
  return sign === expectedSign;
}

function parseWechatXml(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    result[m[1]] = m[2];
  }
  return result;
}

export async function createWechatOrderV3(params: WechatOrderParams) {
  const config = env();

  if (isSandbox()) {
    console.log('[WechatPay V3] Sandbox mode - returning mock order');
    return {
      prepay_id: 'wx' + crypto.randomBytes(16).toString('hex'),
      code_url: 'weixin://wxpay/bizpayurl?pr=mock_sandbox',
    };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = nonceStr();
  const body = {
    appid: config.WECHAT_APP_ID,
    mchid: config.WECHAT_MCH_ID,
    description: params.description,
    out_trade_no: params.orderNo,
    notify_url: (process.env.BASE_URL || 'http://localhost:3000') + '/api/payments/callback/wechat',
    amount: { total: params.amount, currency: 'CNY' },
  };

  const message = 'POST\n/v3/pay/transactions/native\n' + timestamp + '\n' + nonce + '\n' + JSON.stringify(body) + '\n';
  const sign = crypto.createSign('RSA-SHA256').update(message).sign(config.WECHAT_API_V3_KEY || '', 'base64');

  const response = await axios.post('https://api.mch.weixin.qq.com/v3/pay/transactions/native', body, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'WECHATPAY2-SHA256-RSA2048 mchid="' + (config.WECHAT_MCH_ID || '') + '",nonce_str="' + nonce + '",timestamp="' + timestamp + '",serial_no="",signature="' + sign + '"',
    },
    timeout: 10000,
  });

  return response.data;
}
