import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Card, Result, Spin, theme } from 'antd';
import api from '../utils/api';

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setErrorMsg] = useState('');
  const { token } = theme.useToken();

  useEffect(() => {
    const verifyToken = searchParams.get('token');
    if (!verifyToken) {
      setStatus('error');
      setErrorMsg('无效的验证链接');
      return;
    }
    api.get(`/api/auth/verify-email?token=${encodeURIComponent(verifyToken)}`)
      .then(() => setStatus('success'))
      .catch(err => {
        setStatus('error');
        setErrorMsg(err.response?.data?.error || '验证失败');
      });
  }, [searchParams]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: token.colorBgLayout, padding: '0 16px' }}>
      <Card style={{ width: '100%', maxWidth: 400 }}>
        {status === 'loading' && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin size="large" />
            <p style={{ marginTop: 16 }}>正在验证邮箱...</p>
          </div>
        )}
        {status === 'success' && (
          <Result
            status="success"
            title="邮箱验证成功"
            subTitle="您的企业邮箱已通过验证"
            extra={<Link to="/login">去登录</Link>}
          />
        )}
        {status === 'error' && (
          <Result
            status="error"
            title="验证失败"
            subTitle={message}
            extra={<Link to="/login">返回登录</Link>}
          />
        )}
      </Card>
    </div>
  );
}
