import { Alert, Button } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

export default function TrialBanner() {
  const tenant = useAuthStore(s => s.tenant);
  const navigate = useNavigate();

  if (!tenant || tenant.status !== 'TRIAL') return null;

  const now = Date.now();
  const trialEnd = new Date(tenant.trialEndAt).getTime();
  const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));

  if (daysLeft <= 0) {
    return (
      <Alert type="error" message="试用已过期" description="您的7天试用期已经结束，请选择套餐并付费以继续使用。"
        action={<Button type="primary" size="small" onClick={() => navigate('/dashboard/payments')}>立即付费</Button>}
        banner style={{ marginBottom: 16 }} />
    );
  }

  if (daysLeft <= 3) {
    return (
      <Alert type="warning"
        message={`试用期还剩 ${daysLeft} 天`}
        description={`您的企业版全功能试用即将于 ${new Date(tenant.trialEndAt).toLocaleDateString('zh-CN')} 到期，请及时购买套餐。`}
        action={<Button type="primary" size="small" onClick={() => navigate('/dashboard/payments')}>立即购买</Button>}
        banner style={{ marginBottom: 16 }} />
    );
  }

  return (
    <Alert type="info"
      message={`试用期还剩 ${daysLeft} 天`}
      description={`享受企业版全功能试用中，到期时间: ${new Date(tenant.trialEndAt).toLocaleDateString('zh-CN')}`}
      banner closable style={{ marginBottom: 16 }} />
  );
}
