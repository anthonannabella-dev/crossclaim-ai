import { useEffect, useState } from 'react';
import { Table, Card, Button, Modal, Form, Input, Select, Tag, message, Popconfirm } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import api from '../utils/api';
import { useAuthStore } from '../stores/authStore';

export default function SubAccountsPage() {
  const [subAccounts, setSubAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const tenant = useAuthStore(s => s.tenant);

  const fetchSubAccounts = async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/tenant/sub-accounts');
      setSubAccounts(res.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchSubAccounts(); }, []);

  const handleCreate = async (values: any) => {
    try {
      await api.post('/api/tenant/sub-accounts', values);
      message.success('子账号创建成功');
      setModalOpen(false);
      form.resetFields();
      fetchSubAccounts();
    } catch (err: any) {
      message.error(err.response?.data?.error || '创建失败');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/api/tenant/sub-accounts/${id}`);
      message.success('子账号已删除');
      fetchSubAccounts();
    } catch {
      message.error('删除失败');
    }
  };

  const handleToggleActive = async (id: string, currentActive: boolean) => {
    await api.patch(`/api/tenant/sub-accounts/${id}`, { isActive: !currentActive });
    fetchSubAccounts();
  };

  if (tenant?.planTier !== 'ENTERPRISE') {
    return (
      <Card title="子账号管理">
        <p>子账号管理为<strong>企业版专属</strong>功能。如需使用，请升级至企业版套餐。</p>
        <Button type="primary" onClick={() => window.location.href = '/dashboard/payments'}>升级企业版</Button>
      </Card>
    );
  }

  const columns = [
    { title: '用户名', dataIndex: 'username', key: 'username' },
    { title: '角色', dataIndex: 'role', key: 'role', render: (v: string) => (
      <Tag color={v === 'admin' ? 'red' : v === 'operator' ? 'blue' : 'default'}>
        {{ admin: '管理员', operator: '操作员', viewer: '查看者' }[v] || v}
      </Tag>
    )},
    { title: '状态', dataIndex: 'isActive', key: 'isActive', render: (v: boolean, record: any) => (
      <Button size="small" type={v ? 'default' : 'dashed'} onClick={() => handleToggleActive(record.id, v)}>
        {v ? '启用中' : '已禁用'}
      </Button>
    )},
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
    { title: '操作', key: 'actions', render: (_: any, record: any) => (
      <Popconfirm title="确定删除此子账号？" onConfirm={() => handleDelete(record.id)}>
        <Button icon={<DeleteOutlined />} danger size="small">删除</Button>
      </Popconfirm>
    )},
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>子账号管理</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>新建子账号</Button>
      </div>
      <Table dataSource={subAccounts} columns={columns} rowKey="id" loading={loading} scroll={{ x: 650 }} />

      <Modal title="创建子账号" open={modalOpen} onCancel={() => { setModalOpen(false); form.resetFields(); }}
        onOk={() => form.submit()} destroyOnClose>
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, min: 8, message: '密码至少8位' }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="role" label="角色" initialValue="operator" rules={[{ required: true }]}>
            <Select options={[
              { label: '管理员 (全部权限)', value: 'admin' },
              { label: '操作员 (业务操作)', value: 'operator' },
              { label: '查看者 (只读)', value: 'viewer' },
            ]} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
