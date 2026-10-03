import { getServerMessages } from '../../i18n/server';
import SignupForm from './signup-form';

/**
 * TRACK A / PC-01A —— 自助注册入口（feature-gated）。
 * MSG-20261002-81 ⑥：可以实现 /signup 与对应 API，但必须遵守 feature gate；
 * gate 关闭时只显示「暂不可用」；成功路径必须明确提示需要邮箱验证，不得假装已完成。
 */
export default async function SignupPage() {
  const t = await getServerMessages();
  const enabled = process.env.PUBLIC_SIGNUP_ENABLED === 'true';
  return (
    <div className="mx-auto max-w-sm">
      <SignupForm enabled={enabled} t={t} />
    </div>
  );
}
