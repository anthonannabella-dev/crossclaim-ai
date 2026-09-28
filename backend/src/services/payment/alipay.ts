import crypto from 'crypto';
import axios from 'axios';
import { env } from '../../config/env';

const ALIPAY_GATEWAY = 'https://openapi.alipay.com/gateway.do';
const ALIPAY_SANDBOX = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';

interface AlipayOrderParams {
  orderNo: string;
  amount: number;
  subject: string;
  paymentCycle: 'ANNUAL' | 'MONTHLY';
}

function isSandbox(): boolean {
  const config = env();
  return !config.ALIPAY_APP_ID || !config.ALIPAY_PRIVATE_KEY || !config.ALIPAY_PUBLIC_KEY;
}

function getGateway(): string {
  return isSandbox() ? ALIPAY_SANDBOX : ALIPAY_GATEWAY;
}

function generateSign(params: Record<string, string>, privateKey: string): string {
  const sorted = Object.keys(params)
    .filter(function(k) { return params[k] !== '' && params[k] !== undefined && params[k] !== null; })
    .sort();

  const content = sorted.map(function(k) { return k + '=' + params[k]; }).join('&');
  const sign = crypto.createSign('RSA-SHA256').update(content, 'utf8').sign(privateKey, 'base64');
  return sign;
}

export function verifyAlipaySign(params: Record<string, string>): boolean {
  const config = env();
  if (isSandbox()) {
    console.log('[Alipay] Sandbox mode - accepting all callbacks');
    return true;
  }
  const sign = params.sign;
  const signParams = Object.assign({}, params);
  delete signParams.sign;
  delete signParams.sign_type;

  const sorted = Object.keys(signParams)
    .filter(function(k) { return signParams[k] !== '' && signParams[k] !== undefined; })
    .sort();
  const content = sorted.map(function(k) { return k + '=' + signParams[k]; }).join('&');

  const verify = crypto.createVerify('RSA-SHA256');
  verify.update(content, 'utf8');
  return verify.verify(config.ALIPAY_PUBLIC_KEY || '', sign, 'base64');
}

export async function createAlipayOrder(params: AlipayOrderParams) {
  const config = env();

  if (isSandbox()) {
    console.log('[Alipay] Sandbox mode - returning mock payment URL');
    return {
      paymentUrl: 'https://sandbox.alipay.com/mock?orderNo=' + params.orderNo + '&amount=' + params.amount.toFixed(2),
      orderNo: params.orderNo,
    };
  }

  const bizContent = {
    out_trade_no: params.orderNo,
    product_code: 'FAST_INSTANT_TRADE_PAY',
    subject: params.subject,
    total_amount: params.amount.toFixed(2),
  };

  const requestParams: Record<string, string> = {
    app_id: config.ALIPAY_APP_ID || '',
    method: 'alipay.trade.page.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '+08:00'),
    version: '1.0',
    notify_url: (process.env.BASE_URL || 'http://localhost:3000') + '/api/payments/callback/alipay',
    return_url: (process.env.BASE_URL || 'http://localhost:3000') + '/dashboard/payments',
    biz_content: JSON.stringify(bizContent),
  };

  requestParams.sign = generateSign(requestParams, config.ALIPAY_PRIVATE_KEY || '');

  const query = Object.entries(requestParams)
    .map(function(e) { return e[0] + '=' + encodeURIComponent(e[1]); })
    .join('&');

  return {
    paymentUrl: getGateway() + '?' + query,
    orderNo: params.orderNo,
  };
}

export async function createAlipayQrCode(params: AlipayOrderParams) {
  const config = env();

  if (isSandbox()) {
    console.log('[Alipay QR] Sandbox mode - returning mock QR code');
    return {
      qrCode: 'https://sandbox.alipay.com/mock/qrcode?orderNo=' + params.orderNo,
      orderNo: params.orderNo,
    };
  }

  const bizContent = {
    out_trade_no: params.orderNo,
    subject: params.subject,
    total_amount: params.amount.toFixed(2),
  };

  const requestParams: Record<string, string> = {
    app_id: config.ALIPAY_APP_ID || '',
    method: 'alipay.trade.precreate',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '+08:00'),
    version: '1.0',
    notify_url: (process.env.BASE_URL || 'http://localhost:3000') + '/api/payments/callback/alipay',
    biz_content: JSON.stringify(bizContent),
  };

  requestParams.sign = generateSign(requestParams, config.ALIPAY_PRIVATE_KEY || '');

  const response = await axios.post(getGateway(), new URLSearchParams(requestParams).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });

  const result = parseAlipayResponse(response.data);
  return {
    qrCode: result.qr_code,
    orderNo: params.orderNo,
  };
}

function parseAlipayResponse(data: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const json = JSON.parse(data);
    const response = json.alipay_trade_precreate_response;
    if (response && response.code === '10000') {
      result.qr_code = response.qr_code;
    }
  } catch (e) {
    // XML fallback
  }
  return result;
}
