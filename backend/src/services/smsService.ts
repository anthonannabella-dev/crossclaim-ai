// SMS Service — 短信验证码发送
// 支持阿里云短信 / 腾讯云短信 / 控制台调试模式

import { env } from '../config/env';

interface SmsProvider {
  send(phone: string, code: string): Promise<boolean>;
}

// 调试模式：只打日志
class DebugProvider implements SmsProvider {
  async send(phone: string, code: string): Promise<boolean> {
    console.log(`[SMS DEBUG] To: ${phone}, Code: ${code}`);
    return true;
  }
}

// 阿里云短信
class AliyunProvider implements SmsProvider {
  async send(phone: string, code: string): Promise<boolean> {
    try {
      const { default: Core } = await import('@alicloud/pop-core');
      const client = new Core({
        accessKeyId: process.env.ALIYUN_SMS_ACCESS_KEY || '',
        accessKeySecret: process.env.ALIYUN_SMS_ACCESS_SECRET || '',
        endpoint: 'https://dysmsapi.aliyuncs.com',
        apiVersion: '2017-05-25',
      });
      const params = {
        PhoneNumbers: phone,
        SignName: process.env.ALIYUN_SMS_SIGN || '报关SaaS',
        TemplateCode: process.env.ALIYUN_SMS_TEMPLATE || 'SMS_XXXXX',
        TemplateParam: JSON.stringify({ code }),
      };
      const result = await client.request('SendSms', params, { method: 'POST' });
      return result.Code === 'OK';
    } catch (err) {
      console.error('[SMS Aliyun] Failed:', err);
      return false;
    }
  }
}

// 腾讯云短信
class TencentProvider implements SmsProvider {
  async send(phone: string, code: string): Promise<boolean> {
    try {
      const tencentcloud = await import('tencentcloud-sdk-nodejs');
      const SmsClient = tencentcloud.sms.v20210111.Client;
      const client = new SmsClient({
        credential: {
          secretId: process.env.TENCENT_SMS_SECRET_ID || '',
          secretKey: process.env.TENCENT_SMS_SECRET_KEY || '',
        },
        region: 'ap-guangzhou',
      });
      const result = await client.SendSms({
        PhoneNumberSet: [`+86${phone}`],
        TemplateID: process.env.TENCENT_SMS_TEMPLATE || '',
        SignName: process.env.TENCENT_SMS_SIGN || '',
        TemplateParamSet: [code],
        SmsSdkAppId: process.env.TENCENT_SMS_APP_ID || '',
      });
      return result.SendStatusSet?.[0]?.Code === 'Ok';
    } catch (err) {
      console.error('[SMS Tencent] Failed:', err);
      return false;
    }
  }
}

let provider: SmsProvider;

function getProvider(): SmsProvider {
  if (!provider) {
    if (process.env.ALIYUN_SMS_ACCESS_KEY) {
      provider = new AliyunProvider();
    } else if (process.env.TENCENT_SMS_SECRET_ID) {
      provider = new TencentProvider();
    } else {
      provider = new DebugProvider();
    }
  }
  return provider;
}

export async function sendSmsCode(phone: string, code: string): Promise<boolean> {
  return getProvider().send(phone, code);
}
