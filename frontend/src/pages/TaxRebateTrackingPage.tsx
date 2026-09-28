import { useState, useEffect } from 'react';
import { Row, Col, Card, Table, Tag, Typography, Spin, message, Statistic, Timeline, Button, Space, Progress, Alert } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined, DollarOutlined, FileTextOutlined, CalculatorOutlined, InboxOutlined, SafetyCertificateOutlined, BankOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

const { Title, Text } = Typography;

interface RebateRecord {
  id: string;
  hsCode: string;
  description: string;
  quantity: number;
  unit: string;
  fobAmountUSD: number;
  fobAmountCNY: number;
  exportRate: number;
  vatRate: number;
  rebateAmount: number;
  nonRefundable: number;
  status: string;
  declarationId: string | null;
  supplierInvoiceId: string | null;
  exportInvoiceId: string | null;
  receiptId: string | null;
  archiveId: string | null;
  note: string | null;
  calculatedAt: string;
  submittedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_CONFIG: Record<string, { color: string; icon: any; label: string; order: number }> = {
  calculated: { color: 'blue', icon: <CalculatorOutlined />, label: '已计算', order: 0 },
  invoice_matched: { color: 'cyan', icon: <FileTextOutlined />, label: '发票已匹配', order: 1 },
  receipt_confirmed: { color: 'geekblue', icon: <BankOutlined />, label: '收汇已确认', order: 2 },
  documents_ready: { color: 'purple', icon: <SafetyCertificateOutlined />, label: '单证齐全', order: 3 },
  submitted: { color: 'orange', icon: <InboxOutlined />, label: '已申报', order: 4 },
  under_review: { color: 'gold', icon: <ClockCircleOutlined />, label: '核查中', order: 5 },
  refunded: { color: 'green', icon: <DollarOutlined />, label: '已退库', order: 6 },
  rejected: { color: 'red', icon: <CloseCircleOutlined />, label: '已驳回', order: 7 },
};

const STATUS_STEPS = ['calculated', 'invoice_matched', 'receipt_confirmed', 'documents_ready', 'submitted', 'under_review', 'refunded', 'rejected'];

export default function TaxRebateTrackingPage() {
  const [records, setRecords] = useState<RebateRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  const fetchRecords = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tax-rebate/record/list', { headers });
      const json = await res.json();
      setRecords(json.data || []);
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchRecords(); }, []);

  // 更新状态
  const handleProgress = async (id: string, nextStatus: string) => {
    try {
      const res = await fetch(`/api/tax-rebate/record/${id}/progress`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const json = await res.json();
      if (json.success) { message.success('状态已更新'); fetchRecords(); }
      else message.error(json.error);
    } catch { message.error('请求失败'); }
  };

  const stats = {
    total: records.length,
    totalRebate: records.reduce((s, r) => s + r.rebateAmount, 0),
    refunded: records.filter(r => r.status === 'refunded').reduce((s, r) => s + r.rebateAmount, 0),
    pending: records.filter(r => !['refunded', 'rejected'].includes(r.status)).length,
  };

  const columns = [
    { title: 'HS编码', dataIndex: 'hsCode', key: 'hsCode', width: 90 },
    { title: '商品', dataIndex: 'description', key: 'description', ellipsis: true },
    { title: 'FOB(USD)', dataIndex: 'fobAmountUSD', key: 'fobAmountUSD', width: 100, render: (v: number) => `$${(v || 0).toLocaleString()}` },
    { title: '退税额', dataIndex: 'rebateAmount', key: 'rebateAmount', width: 110,
      render: (v: number) => <Text strong style={{ color: '#3f8600' }}>¥{(v || 0).toLocaleString()}</Text> },
    {
      title: '进度', key: 'progress', width: 200,
      render: (_: any, r: RebateRecord) => {
        const current = STATUS_CONFIG[r.status];
        if (!current) return <Tag>{r.status}</Tag>;
        const total = Object.keys(STATUS_CONFIG).length - 1; // exclude rejected
        const done = STATUS_STEPS.filter(s => s !== 'rejected').indexOf(r.status) + 1;
        const pct = Math.round((done / total) * 100);
        return (
          <Space>
            <Progress type="circle" percent={pct} size={30} strokeColor={current.color} format={() => ''} />
            <Tag color={current.color} icon={current.icon}>{current.label}</Tag>
          </Space>
        );
      },
    },
    {
      title: '操作', key: 'action', width: 200,
      render: (_: any, r: RebateRecord) => {
        const order = STATUS_STEPS.indexOf(r.status);
        const nextSteps: string[] = [];
        if (order === 0) nextSteps.push('invoice_matched');
        if (order === 1) nextSteps.push('receipt_confirmed');
        if (order === 2) nextSteps.push('documents_ready');
        if (order === 3) nextSteps.push('submitted');
        if (order === 4) nextSteps.push('under_review');
        if (order === 5) nextSteps.push('refunded', 'rejected');
        if (['refunded', 'rejected'].includes(r.status)) return <Text type="secondary">已完成</Text>;
        return (
          <Space>
            {nextSteps.map(s => (
              <Button key={s} size="small" onClick={() => handleProgress(r.id, s)}>
                → {STATUS_CONFIG[s]?.label}
              </Button>
            ))}
          </Space>
        );
      },
    },
    { title: '计算时间', dataIndex: 'calculatedAt', key: 'calculatedAt', width: 150,
      render: (v: string) => v ? dayjs(v).format('MM-DD HH:mm') : '' },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} md={6}>
          <Card size="small"><Statistic title="退税记录" value={stats.total} prefix={<FileTextOutlined />} /></Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small"><Statistic title="应退总额" value={stats.totalRebate} precision={2} prefix="¥" valueStyle={{ color: '#3f8600' }} /></Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small"><Statistic title="已到账" value={stats.refunded} precision={2} prefix="¥" valueStyle={{ color: '#1890ff' }} /></Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small"><Statistic title="进行中" value={stats.pending} prefix={<ClockCircleOutlined />} valueStyle={{ color: '#fa8c16' }} /></Card>
        </Col>
      </Row>

      <Alert
        message="退税进度跟踪 — 点击按钮推进状态。从“已计算”到“已退库”共7步，走完即可到账。"
        type="info" showIcon style={{ marginBottom: 12, fontSize: 12 }}
      />

      <Card size="small">
        <Spin spinning={loading}>
          <Table dataSource={records} columns={columns} rowKey="id" pagination={{ pageSize: 10 }} size="small"
            expandable={{
              expandedRowRender: (r: RebateRecord) => (
                <div style={{ padding: '12px 24px', background: '#fafafa' }}>
                  <Row gutter={24}>
                    <Col span={12}>
                      <p><Text strong>计算详情：</Text>{r.description} × {r.quantity}{r.unit}</p>
                      <p><Text strong>退税率：</Text>{r.exportRate}%　<Text strong>增值税率：</Text>{r.vatRate}%</p>
                      <p><Text strong>FOB人民币：</Text>¥{r.fobAmountCNY.toLocaleString()}</p>
                    </Col>
                    <Col span={12}>
                      <p><Text strong>应退税额：</Text><Text style={{ color: '#3f8600', fontSize: 16 }}>¥{r.rebateAmount.toLocaleString()}</Text></p>
                      <p><Text strong>不退税额：</Text>¥{r.nonRefundable.toLocaleString()}</p>
                      <Timeline items={STATUS_STEPS.filter(s => s !== 'rejected').map(s => ({
                        color: STATUS_STEPS.indexOf(s) <= STATUS_STEPS.indexOf(r.status) ? 'green' : 'gray',
                        children: <Text type={STATUS_STEPS.indexOf(s) <= STATUS_STEPS.indexOf(r.status) ? undefined : 'secondary'}>
                          {STATUS_CONFIG[s]?.label}
                        </Text>,
                      }))} />
                    </Col>
                  </Row>
                </div>
              ),
            }}
          />
        </Spin>
      </Card>
    </div>
  );
}
