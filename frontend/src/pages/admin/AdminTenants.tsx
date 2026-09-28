import { useEffect, useState } from 'react';
import { Table, Tag, Button, Select, message, Space, Input, Modal, Descriptions } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import api from '../../utils/adminApi';

const statusOptions = [
  { label: '全部', value: 'all' },
  { label: '试用中', value: 'TRIAL' },
  { label: '正常', value: 'ACTIVE' },
  { label: '已冻结', value: 'FROZEN' },
  { label: '已禁用', value: 'DISABLED' },
];

const planLabels: Record<string, string> = { BASIC: '基础版', PROFESSIONAL: '专业版', ENTERPRISE: '企业版' };
const statusLabels: Record<string, string> = { TRIAL: '试用', ACTIVE: '正常', FROZEN: '冻结', DISABLED: '封禁' };
const statusColors: Record<string, string> = { TRIAL: 'blue', ACTIVE: 'green', FROZEN: 'orange', DISABLED: 'red' };

export default function AdminTenants() {
  const [tenants, setTenants] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState<any>(null);

  const fetchTenants = async () => {
    setLoading(true);
    try {
      const params = statusFilter !== 'all' ? `?status=${statusFilter}` : '';
      const res = await api.get(`/admin/tenants${params}`);
      setTenants(res.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTenants(); }, [statusFilter]);

  const handleExport = async () => {
    try {
      const res = await api.get('/admin/export/tenants', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `客户档案_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
      message.success('导出成功');
    } catch {
      message.error('导出失败');
    }
  };

  const handleFreeze = async (id: string) => {
    await api.post(`/admin/tenants/${id}/freeze`);
    message.success('已冻结');
    fetchTenants();
  };

  const handleUnfreeze = async (id: string) => {
    await api.post(`/admin/tenants/${id}/unfreeze`);
    message.success('已解封');
    fetchTenants();
  };

  const filtered = tenants.filter(t => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (t.companyName || '').toLowerCase().includes(s)
      || (t.contactEmail || '').toLowerCase().includes(s)
      || (t.contactName || '').toLowerCase().includes(s);
  });

  const columns = [
    { title: '企业名称', dataIndex: 'companyName', key: 'companyName' },
    { title: '联系人', dataIndex: 'contactName', key: 'contactName' },
    { title: '邮箱', dataIndex: 'contactEmail', key: 'contactEmail' },
    {
      title: '套餐', dataIndex: 'planTier', key: 'planTier',
      render: (v: string) => <Tag>{planLabels[v] || v}</Tag>,
    },
    {
      title: '付费', dataIndex: 'paymentCycle', key: 'paymentCycle',
      render: (v: string) => v === 'ANNUAL' ? '年付' : v === 'MONTHLY' ? '月付' : '-',
    },
    {
      title: '状态', dataIndex: 'status', key: 'status',
      render: (v: string) => <Tag color={statusColors[v]}>{statusLabels[v] || v}</Tag>,
    },
    {
      title: '到期时间', dataIndex: 'expiresAt', key: 'expiresAt',
      render: (v: string | null) => v ? new Date(v).toLocaleDateString('zh-CN') : '-',
    },
    {
      title: '注册时间', dataIndex: 'createdAt', key: 'createdAt',
      render: (v: string) => new Date(v).toLocaleDateString('zh-CN'),
    },
    {
      title: '操作', key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          <Button size="small" onClick={() => { setSelectedTenant(record); setDetailOpen(true); }}>详情</Button>
          {record.status !== 'FROZEN' && record.status !== 'DISABLED' && (
            <Button size="small" danger onClick={() => handleFreeze(record.id)}>冻结</Button>
          )}
          {(record.status === 'FROZEN' || record.status === 'DISABLED') && (
            <Button size="small" type="primary" onClick={() => handleUnfreeze(record.id)}>解封</Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>客户档案管理</h2>
        <Button icon={<DownloadOutlined />} onClick={handleExport}>导出Excel</Button>
      </div>

      <Space style={{ marginBottom: 16 }}>
        <Select value={statusFilter} onChange={setStatusFilter} options={statusOptions} style={{ width: 120 }} />
        <Input.Search placeholder="搜索企业名称/邮箱/联系人" value={search} onChange={e => setSearch(e.target.value)} style={{ width: '100%', maxWidth: 300 }} allowClear />
      </Space>

      <Table dataSource={filtered.map(t => ({ ...t, key: t.id }))} columns={columns} loading={loading} scroll={{ x: 900 }} />

      <Modal title="企业详情" open={detailOpen} onCancel={() => setDetailOpen(false)} footer={null} width="min(600px, 95vw)">
        {selectedTenant && (
          <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
            <Descriptions.Item label="企业名称">{selectedTenant.companyName}</Descriptions.Item>
            <Descriptions.Item label="统一社会信用代码">{selectedTenant.uscc || '-'}</Descriptions.Item>
            <Descriptions.Item label="联系人">{selectedTenant.contactName || '-'}</Descriptions.Item>
            <Descriptions.Item label="联系电话">{selectedTenant.contactPhone || '-'}</Descriptions.Item>
            <Descriptions.Item label="邮箱">{selectedTenant.contactEmail}</Descriptions.Item>
            <Descriptions.Item label="套餐">{planLabels[selectedTenant.planTier]}</Descriptions.Item>
            <Descriptions.Item label="付费周期">{selectedTenant.paymentCycle === 'ANNUAL' ? '年付' : '月付'}</Descriptions.Item>
            <Descriptions.Item label="状态"><Tag color={statusColors[selectedTenant.status]}>{statusLabels[selectedTenant.status]}</Tag></Descriptions.Item>
            <Descriptions.Item label="注册时间">{new Date(selectedTenant.createdAt).toLocaleString('zh-CN')}</Descriptions.Item>
            <Descriptions.Item label="到期时间" span={2}>{selectedTenant.expiresAt ? new Date(selectedTenant.expiresAt).toLocaleString('zh-CN') : '-'}</Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </div>
  );
}
