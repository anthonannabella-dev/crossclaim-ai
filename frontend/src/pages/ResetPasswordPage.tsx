import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Form, Input, Button, Card, message, theme } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import api from '../utils/api';

export default function ResetPasswordPage() {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { token } = theme.useToken();

  const resetToken = searchParams.get('token');

  const onFinish = async (values: { newPassword: string; confirmPassword: string }) => {
    if (values.newPassword !== values.confirmPassword) {
      message.error('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    try {
      await api.post('/api/auth/reset-password', {
        token: resetToken,
        newPassword: values.newPassword,
      });
      setDone(true);
      message.success('密码重置成功');
      setTimeout(() => navigate('/login'), 2000);
    } catch (err: any) {
      message.error(err.response?.data?.error || '重置失败');
    } finally {
      setLoading(false);
    }
  };

  if (!resetToken) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: token.colorBgLayout, padding: '0 16px' }}>
        <Card title="无效的重置链接" style={{ width: '100%', maxWidth: 400 }}>
          <p>此重置链接无效或已过期。</p>
          <Link to="/forgot-password">重新申请重置</Link>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: token.colorBgLayout, padding: '0 16px' }}>
      <Card title="重置密码" style={{ width: '100%', maxWidth: 400 }}>
        {done ? (
          <div style={{ textAlign: 'center' }}>
            <p>密码重置成功！即将跳转到登录页...</p>
            <Link to="/login">立即登录</Link>
          </div>
        ) : (
          <Form onFinish={onFinish}>
            <Form.Item name="newPassword" rules={[
              { required: true, message: '请输入新密码' },
              { min: 8, message: '密码至少8位' },
            ]}>
              <Input.Password prefix={<LockOutlined />} placeholder="新密码（至少8位）" size="large" />
            </Form.Item>
            <Form.Item name="confirmPassword" rules={[
              { required: true, message: '请确认新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('两次输入的密码不一致'));
                },
              }),
            ]}>
              <Input.Password prefix={<LockOutlined />} placeholder="确认新密码" size="large" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block size="large">
                重置密码
              </Button>
            </Form.Item>
          </Form>
        )}
      </Card>
    </div>
  );
}
