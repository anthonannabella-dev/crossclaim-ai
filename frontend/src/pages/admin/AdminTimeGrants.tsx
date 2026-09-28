import { useEffect, useState } from 'react';
import { Table, Card, Button, Modal, InputNumber, Input, Select, Space, message } from 'antd';
import { ClockCircleOutlined, DownloadOutlined } from '@ant-design/icons';
import api from '../../utils/adminApi';

export default function AdminTimeGrants() {
  const [grants, setGrants] = useState<any[]>([]);
  const [tenants, setTenants] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedTenants, setSelectedTenants] = useState<string[]>([]);
  const [days, setDays] = useState(0);
  const [months, setMonths] = useState(0);
  const [reason, setReason] = useState('');

  const fetchGrants = async () => {
    setLoading(true);
    try {
      const [grantsRes, tenantsRes] = await Promise.all([
        api.get('/admin/time-grants'),
        api.get('/admin/tenants?status=all'),
      ]);
      setGrants(grantsRes.data);
      setTenants(tenantsRes.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchGrants(); }, []);

  const handleExport = async () => {
    try {
      const res = await api.get('/admin/export/time-grants', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `赠时台账_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
      message.success('导出成功');
    } catch {
      message.error('导出失败');
    }
  };

  const handleGrant = async () => {
    if (selectedTenants.length === 0) { message.warning('请选择客户'); return; }
    if (days === 0 && months === 0) { message.warning('请输入赠送天数或月数'); return; }
    try {
      await api.post('/admin/time-grants', {
        tenantIds: selectedTenants,
        daysGranted: days,
        monthsGranted: months,
        reason,
      });
      message.success('赠时成功，即时生效');
      setModalOpen(false);
      setSelectedTenants([]);
      setDays(0);
      setMonths(0);
      setReason('');
      fetchGrants();
    } catch {
      message.error('赠时操作失败');
    }
  };

  const columns = [
    { title: '客户名称', dataIndex: ['tenant', 'companyName'], key: 'company' },
    { title: '赠送天数', dataIndex: 'daysGranted', key: 'days' },
    { title: '赠送月数', dataIndex: 'monthsGranted', key: 'months' },
    { title: '操作人', dataIndex: ['admin', 'username'], key: 'admin' },
    { title: '备注', dataIndex: 'reason', key: 'reason' },
    { title: '操作时间', dataIndex: 'createdAt', key: 'createdAt', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2><ClockCircleOutlined /> 赠时台账</h2>
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>导出Excel</Button>
          <Button type="primary" onClick={() => setModalOpen(true)}>新增赠时</Button>
        </Space>
      </div>
      <Table dataSource={grants} columns={columns} rowKey="id" loading={loading} scroll={{ x: 650 }} />

      <Modal title="手动赠送会员时长" open={modalOpen} onOk={handleGrant} onCancel={() => setModalOpen(false)}>
        <div style={{ marginBottom: 16 }}>
          <label>选择客户 (可多选):</label>
          <Select mode="multiple" style={{ width: '100%' }} placeholder="搜索并选择客户" value={selectedTenants}
            onChange={setSelectedTenants} options={tenants.map((t: any) => ({ label: t.companyName, value: t.id }))} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label>赠送天数:</label>
          <InputNumber min={0} value={days} onChange={v => setDays(v || 0)} style={{ width: '100%' }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label>赠送月数:</label>
          <InputNumber min={0} value={months} onChange={v => setMonths(v || 0)} style={{ width: '100%' }} />
        </div>
        <div>
          <label>备注:</label>
          <Input.TextArea value={reason} onChange={e => setReason(e.target.value)} />
        </div>
      </Modal>
    </div>
  );
}
