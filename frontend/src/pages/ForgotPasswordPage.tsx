import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Form, Input, Button, Card, message, theme } from 'antd';
import { MailOutlined } from '@ant-design/icons';
import api from '../utils/api';

export default function ForgotPasswordPage() {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const { token } = theme.useToken();

  const onFinish = async (values: { email: string }) => {
    setLoading(true);
    try {
      await api.post('/api/auth/forgot-password', values);
      setSent(true);
      message.success('重置链接已发送');
    } catch (err: any) {
      message.error(err.response?.data?.error || '发送失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: token.colorBgLayout, padding: '0 16px' }}>
      <Card title="忘记密码" style={{ width: '100%', maxWidth: 400 }}>
        {sent ? (
          <div style={{ textAlign: 'center' }}>
            <p>重置链接已发送到您的企业邮箱，请查收邮件并点击链接重置密码。</p>
            <p style={{ color: '#999' }}>链接30分钟内有效</p>
            <Link to="/login">返回登录</Link>
          </div>
        ) : (
          <Form onFinish={onFinish}>
            <Form.Item name="email" rules={[
              { required: true, message: '请输入企业邮箱' },
              { type: 'email', message: '请输入有效邮箱' },
            ]}>
              <Input prefix={<MailOutlined />} placeholder="企业邮箱" size="large" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block size="large">
                发送重置链接
              </Button>
            </Form.Item>
            <div style={{ textAlign: 'center' }}>
              <Link to="/login">返回登录</Link>
            </div>
          </Form>
        )}
      </Card>
    </div>
  );
}
