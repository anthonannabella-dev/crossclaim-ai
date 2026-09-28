import { useState } from 'react';
import { Card, Descriptions, Tag, Button, Form, Input, Modal, message, Segmented } from 'antd';
import { EditOutlined, LockOutlined, BulbOutlined } from '@ant-design/icons';
import { useAuthStore } from '../stores/authStore';
import api from '../utils/api';

export default function SettingsPage() {
  const tenant = useAuthStore(s => s.tenant);
  const setTenant = useAuthStore(s => s.setTenant);
  const [editModal, setEditModal] = useState(false);
  const [pwdModal, setPwdModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [themeValue, setThemeValue] = useState(() => localStorage.getItem('theme') === 'dark' ? 'dark' : 'light');

  if (!tenant) return null;

  const handleProfileUpdate = async (values: any) => {
    setSaving(true);
    try {
      const res = await api.patch('/api/tenant/profile', values);
      setTenant(res.data);
      message.success('企业信息已更新');
      setEditModal(false);
    } catch (err: any) {
      message.error(err.response?.data?.error || '更新失败');
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordChange = async (values: any) => {
    setSaving(true);
    try {
      await api.patch('/api/tenant/change-password', values);
      message.success('密码已修改，请重新登录');
      setPwdModal(false);
    } catch (err: any) {
      message.error(err.response?.data?.error || '修改失败');
    } finally {
      setSaving(false);
    }
  };

  const statusMap: Record<string, { color: string; text: string }> = {
    TRIAL: { color: 'blue', text: '试用中' },
    ACTIVE: { color: 'green', text: '已激活' },
    FROZEN: { color: 'red', text: '已冻结' },
    DISABLED: { color: 'default', text: '已停用' },
  };

  const planMap: Record<string, string> = {
    BASIC: '基础版', PROFESSIONAL: '专业版', ENTERPRISE: '企业版',
  };

  return (
    <div>
      <h2>企业设置</h2>

      <Card title="企业信息" extra={<Button icon={<EditOutlined />} onClick={() => setEditModal(true)}>编辑</Button>}
        style={{ marginBottom: 16 }}>
        <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
          <Descriptions.Item label="企业名称">{tenant.companyName}</Descriptions.Item>
          <Descriptions.Item label="联系人">{tenant.contactName}</Descriptions.Item>
          <Descriptions.Item label="联系电话">{tenant.contactPhone}</Descriptions.Item>
          <Descriptions.Item label="联系邮箱">{tenant.contactEmail}</Descriptions.Item>
          <Descriptions.Item label="当前套餐">
            <Tag color="blue">{planMap[tenant.planTier] || tenant.planTier}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="付费方式">{tenant.paymentCycle === 'ANNUAL' ? '年付' : tenant.paymentCycle === 'MONTHLY' ? '月付' : '-'}</Descriptions.Item>
          <Descriptions.Item label="账号状态">
            <Tag color={statusMap[tenant.status]?.color}>{statusMap[tenant.status]?.text || tenant.status}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="注册时间">{new Date(tenant.createdAt).toLocaleDateString('zh-CN')}</Descriptions.Item>
          <Descriptions.Item label="试用到期">{new Date(tenant.trialEndAt).toLocaleDateString('zh-CN')}</Descriptions.Item>
          <Descriptions.Item label="付费到期">{tenant.expiresAt ? new Date(tenant.expiresAt).toLocaleDateString('zh-CN') : '未付费'}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title={<span><BulbOutlined /> 界面设置</span>} style={{ marginBottom: 16 }}>
        <Segmented
          value={themeValue}
          onChange={(value) => {
            const v = value as string;
            setThemeValue(v);
            localStorage.setItem('theme', v);
            window.dispatchEvent(new CustomEvent('theme-change', { detail: v }));
          }}
          options={[
            { label: '浅色模式', value: 'light' },
            { label: '深色模式', value: 'dark' },
          ]}
        />
      </Card>

      <Card title="安全设置">
        <Button icon={<LockOutlined />} onClick={() => setPwdModal(true)}>修改登录密码</Button>
      </Card>

      {/* 编辑企业信息 */}
      <Modal title="编辑企业信息" open={editModal} onCancel={() => setEditModal(false)} footer={null} destroyOnClose>
        <Form layout="vertical" initialValues={tenant} onFinish={handleProfileUpdate}>
          <Form.Item label="企业名称" name="companyName" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="联系人" name="contactName" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="联系电话" name="contactPhone" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="联系邮箱" name="contactEmail" rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={saving} block>保存</Button>
        </Form>
      </Modal>

      {/* 修改密码 */}
      <Modal title="修改密码" open={pwdModal} onCancel={() => setPwdModal(false)} footer={null} destroyOnClose>
        <Form layout="vertical" onFinish={handlePasswordChange}>
          <Form.Item label="当前密码" name="currentPassword" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item label="新密码" name="newPassword" rules={[{ required: true, min: 6, message: '至少6位' }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item label="确认新密码" name="confirmPassword"
            dependencies={['newPassword']}
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                  return Promise.reject(new Error('两次输入的密码不一致'));
                },
              }),
            ]}>
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={saving} block>修改密码</Button>
        </Form>
      </Modal>

    </div>
  );
}
