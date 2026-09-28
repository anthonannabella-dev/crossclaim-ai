import { useEffect, useState } from 'react';
import { Table, Card, Statistic, Row, Col, Tag, Button, message } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import api from '../../utils/adminApi';

const statusLabels: Record<string, string> = { success: '成功', pending: '待付', failed: '失败', refunded: '已退' };
const statusColors: Record<string, string> = { success: 'green', pending: 'orange', failed: 'red', refunded: 'default' };

export default function AdminPayments() {
  const [payments, setPayments] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get('/admin/payments'),
      api.get('/admin/payments/summary'),
    ]).then(([payRes, sumRes]) => {
      setPayments(payRes.data);
      setSummary(sumRes.data);
    }).finally(() => setLoading(false));
  }, []);

  const handleExport = async () => {
    try {
      const res = await api.get('/admin/export/payments', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `收费台账_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
      message.success('导出成功');
    } catch {
      message.error('导出失败');
    }
  };

  const columns = [
    { title: '企业', dataIndex: ['tenant', 'companyName'], key: 'company' },
    { title: '金额', dataIndex: 'amount', key: 'amount', render: (v: number) => `¥${v}` },
    { title: '套餐', dataIndex: 'planTier', key: 'planTier' },
    { title: '付费类型', dataIndex: 'paymentCycle', key: 'paymentCycle', render: (v: string) => v === 'ANNUAL' ? '年付' : '月付' },
    { title: '支付方式', dataIndex: 'paymentMethod', key: 'paymentMethod', render: (v: string) => v === 'wechat' ? '微信' : '支付宝' },
    { title: '状态', dataIndex: 'status', key: 'status',
      render: (v: string) => <Tag color={statusColors[v] || 'default'}>{statusLabels[v] || v}</Tag> },
    { title: '时间', dataIndex: 'createdAt', key: 'createdAt', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>收费台账</h2>
        <Button icon={<DownloadOutlined />} onClick={handleExport}>导出Excel</Button>
      </div>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={8}><Card><Statistic title="实收总额" value={summary.totalCollected || 0} prefix="¥" /></Card></Col>
        <Col xs={24} sm={8}><Card><Statistic title="应收总额" value={summary.totalReceivable || 0} prefix="¥" /></Card></Col>
        <Col xs={24} sm={8}><Card><Statistic title="总交易数" value={summary.totalTransactions || 0} /></Card></Col>
      </Row>
      <Table dataSource={payments} columns={columns} rowKey="id" loading={loading} scroll={{ x: 700 }} />
    </div>
  );
}
