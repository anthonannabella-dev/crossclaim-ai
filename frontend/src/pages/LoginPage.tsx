import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Form, Input, Button, Card, message, theme, Divider } from 'antd';
import { UserOutlined, LockOutlined, MobileOutlined } from '@ant-design/icons';
import api from '../utils/api';
import { LEGAL_AGREEMENTS } from '../utils/legalAgreements';

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [loginMode, setLoginMode] = useState<'email' | 'phone'>('email');
  const [modalContent, setModalContent] = useState<{ title: string; content: string } | null>(null);
  const [sendingSms, setSendingSms] = useState(false);
  const [smsCountdown, setSmsCountdown] = useState(0);
  const navigate = useNavigate();
  const { token } = theme.useToken();

  const onEmailLogin = async (values: { email: string; password: string }) => {
    setLoading(true);
    try {
      const res = await api.post('/api/auth/login', values);
      localStorage.setItem('token', res.data.token);
      message.success('登录成功');
      navigate('/dashboard');
    } catch (err: any) {
      message.error(err.response?.data?.error || '登录失败');
    } finally { setLoading(false); }
  };

  const sendSmsCode = async (phone: string) => {
    setSendingSms(true);
    try {
      await api.post('/api/auth/sms/send', { phone });
      message.success('验证码已发送');
      let count = 60;
      setSmsCountdown(count);
      const timer = setInterval(() => {
        count--;
        setSmsCountdown(count);
        if (count <= 0) { clearInterval(timer); }
      }, 1000);
    } catch (err: any) {
      message.error(err.response?.data?.error || '发送失败');
    } finally { setSendingSms(false); }
  };

  const onPhoneLogin = async (values: { phone: string; code: string }) => {
    setLoading(true);
    try {
      const res = await api.post('/api/auth/sms/login', values);
      localStorage.setItem('token', res.data.token);
      message.success(res.data.isNewUser ? '注册并登录成功' : '登录成功');
      navigate('/dashboard');
    } catch (err: any) {
      message.error(err.response?.data?.error || '登录失败');
    } finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: token.colorBgLayout, padding: '0 16px' }}>
      <Card
        title="出口报关合规AI SaaS"
        style={{ width: '100%', maxWidth: 400 }}
        tabList={[
          { key: 'email', tab: <span><UserOutlined /> 邮箱登录</span> },
          { key: 'phone', tab: <span><MobileOutlined /> 手机登录</span> },
        ]}
        activeTabKey={loginMode}
        onTabChange={(key) => setLoginMode(key as 'email' | 'phone')}
      >
        {/* 邮箱密码登录 */}
        {loginMode === 'email' && (
          <Form onFinish={onEmailLogin}>
            <Form.Item name="email" rules={[{ required: true, message: '请输入企业邮箱' }]}>
              <Input prefix={<UserOutlined />} placeholder="企业邮箱" size="large" />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" />
            </Form.Item>
            <div style={{ textAlign: 'right', marginBottom: 16 }}>
              <Link to="/forgot-password">忘记密码?</Link>
            </div>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block size="large">登录</Button>
            </Form.Item>
          </Form>
        )}

        {/* 手机验证码登录 */}
        {loginMode === 'phone' && (
          <Form onFinish={onPhoneLogin}>
            <Form.Item name="phone" rules={[
              { required: true, message: '请输入手机号' },
              { pattern: /^1\d{10}$/, message: '请输入11位手机号码' },
            ]}>
              <Input prefix={<MobileOutlined />} placeholder="手机号码" size="large" />
            </Form.Item>
            <Form.Item>
              <div style={{ display: 'flex', gap: 8 }}>
                <Form.Item name="code" noStyle rules={[{ required: true, message: '请输入验证码' }]}>
                  <Input placeholder="验证码" size="large" style={{ flex: 1 }} />
                </Form.Item>
                <Button size="large" onClick={() => {
                  const phone = (document.querySelector('[name="phone"]') as HTMLInputElement)?.value;
                  if (phone && /^1\d{10}$/.test(phone)) sendSmsCode(phone);
                  else message.warning('请先输入正确的手机号');
                }} loading={sendingSms} disabled={smsCountdown > 0}>
                  {smsCountdown > 0 ? `${smsCountdown}s` : '获取验证码'}
                </Button>
              </div>
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block size="large">登录</Button>
            </Form.Item>
          </Form>
        )}

        <Divider plain style={{ fontSize: 12, color: '#999', margin: '8px 0' }}>
          <Link to="/register">还没有账号? 注册企业</Link>
        </Divider>

        <div style={{ textAlign: 'center', color: '#999', fontSize: 12, lineHeight: 1.6 }}>
          登录即表示同意
          <a onClick={() => setModalContent(LEGAL_AGREEMENTS.terms_of_service)} style={{ margin: '0 2px', cursor: 'pointer' }}>《用户服务协议》</a>
          <span>和</span>
          <a onClick={() => setModalContent(LEGAL_AGREEMENTS.privacy_policy)} style={{ margin: '0 2px', cursor: 'pointer' }}>《隐私政策》</a>
        </div>
      </Card>

      {modalContent && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)' }} onClick={() => setModalContent(null)}>
          <div style={{ background: '#fff', borderRadius: 8, padding: 24, width: 'min(700px, 95vw)', maxHeight: '80vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px' }}>{modalContent.title}</h3>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.8 }}>{modalContent.content}</div>
            <div style={{ textAlign: 'right', marginTop: 16 }}>
              <Button onClick={() => setModalContent(null)}>关闭</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
