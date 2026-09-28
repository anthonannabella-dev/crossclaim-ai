import { useEffect, useState } from 'react';
import { Table, Card, Tag, Button, Modal, Space, Statistic, Row, Col } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import api from '../../utils/adminApi';

export default function AdminAPIMonitor() {
  const [tokens, setTokens] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<any[]>([]);
  const [selectedToken, setSelectedToken] = useState<any>(null);

  useEffect(() => {
    setLoading(true);
    api.get('/admin/api-tokens').then(res => setTokens(res.data)).finally(() => setLoading(false));
  }, []);

  const viewLogs = async (token: any) => {
    setSelectedToken(token);
    setLogsOpen(true);
    try {
      const res = await api.get(`/admin/api-tokens/${token.id}/logs`);
      setLogs(res.data);
    } catch {
      setLogs([]);
    }
  };

  const totalCalls = tokens.reduce((s, t) => s + t.totalCalls, 0);
  const monthlyCalls = tokens.reduce((s, t) => s + t.monthlyCalls, 0);
  const activeTokens = tokens.filter(t => t.isActive).length;

  const tokenColumns = [
    { title: '企业', dataIndex: ['tenant', 'companyName'], key: 'company' },
    { title: 'AppKey', dataIndex: 'appKey', key: 'appKey', render: (v: string) => <code>{v}</code> },
    { title: 'Token名称', dataIndex: 'name', key: 'name' },
    { title: '频率限制', dataIndex: 'rateLimit', key: 'rateLimit', render: (v: number) => `${v}/min` },
    { title: '累计调用', dataIndex: 'totalCalls', key: 'totalCalls', sorter: (a: any, b: any) => a.totalCalls - b.totalCalls },
    { title: '本月调用', dataIndex: 'monthlyCalls', key: 'monthlyCalls', sorter: (a: any, b: any) => a.monthlyCalls - b.monthlyCalls },
    {
      title: '状态', dataIndex: 'isActive', key: 'isActive',
      render: (v: boolean) => <Tag color={v ? 'green' : 'red'}>{v ? '启用' : '禁用'}</Tag>,
    },
    {
      title: '最后调用', dataIndex: 'lastUsedAt', key: 'lastUsedAt',
      render: (v: string | null) => v ? new Date(v).toLocaleString('zh-CN') : '从未使用',
    },
    {
      title: '操作', key: 'actions',
      render: (_: any, record: any) => (
        <Button size="small" icon={<EyeOutlined />} onClick={() => viewLogs(record)}>查看日志</Button>
      ),
    },
  ];

  const logColumns = [
    { title: '端点', dataIndex: 'endpoint', key: 'endpoint' },
    { title: '方法', dataIndex: 'method', key: 'method', render: (v: string) => <Tag>{v}</Tag> },
    { title: '状态码', dataIndex: 'statusCode', key: 'statusCode', render: (v: number) => <Tag color={v < 400 ? 'green' : 'red'}>{v}</Tag> },
    { title: '耗时', dataIndex: 'durationMs', key: 'durationMs', render: (v: number) => `${v}ms` },
    { title: 'IP', dataIndex: 'ip', key: 'ip', render: (v: string) => <code>{v}</code> },
    { title: '时间', dataIndex: 'createdAt', key: 'createdAt', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
  ];

  return (
    <div>
      <h2>API调用监控</h2>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}><Card><Statistic title="活跃Token" value={activeTokens} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="本月总调用" value={monthlyCalls} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="累计总调用" value={totalCalls} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="Token总数" value={tokens.length} /></Card></Col>
      </Row>

      <Table dataSource={tokens.map(t => ({ ...t, key: t.id }))} columns={tokenColumns} loading={loading} scroll={{ x: 900 }} />

      <Modal
        title={`调用日志: ${selectedToken?.appKey || ''}`}
        open={logsOpen}
        onCancel={() => setLogsOpen(false)}
        footer={null}
        width="min(900px, 95vw)"
      >
        <Table dataSource={logs.map((l: any, i: number) => ({ ...l, key: i }))} columns={logColumns} size="small" pagination={{ pageSize: 20 }} scroll={{ x: 600 }} />
      </Modal>
    </div>
  );
}
