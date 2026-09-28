import { useState, useEffect } from 'react';
import { Row, Col, Card, Table, Button, Tag, Typography, message, Spin, Space, Modal, Descriptions, Divider, Upload, Input, DatePicker, Form, InputNumber, Select } from 'antd';
import { UploadOutlined, CheckCircleOutlined, CloseCircleOutlined, WarningOutlined, SearchOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

const { Title, Text } = Typography;

interface SupplierInvoice {
  id: string;
  invoiceNo: string;
  invoiceDate: string | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  matchStatus: 'pending' | 'matched' | 'mismatch';
  matchScore: number | null;
  matchDetail: string | null;
  declarationId: string | null;
  createdAt: string;
}

interface MatchResult {
  matchStatus: string;
  matchScore: number;
  issues: string[];
  details: Array<{
    declarationItem: { name: string; quantity: number; unit: string };
    invoiceItem: { name: string; quantity: number; unit: string } | null;
    score: number;
    passed: boolean;
  }>;
}

export default function SupplierInvoicePage() {
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [matchModal, setMatchModal] = useState<{ visible: boolean; result: MatchResult | null; invoiceId: string }>({
    visible: false, result: null, invoiceId: '',
  });
  const [addModal, setAddModal] = useState(false);
  const [form] = Form.useForm();

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  const fetchInvoices = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tax-rebate/supplier-invoice/list', { headers });
      const json = await res.json();
      setInvoices(json.data || []);
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchInvoices(); }, []);

  // 三要素比对
  const handleMatch = async (id: string) => {
    try {
      const res = await fetch(`/api/tax-rebate/supplier-invoice/${id}/match`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (json.success) {
        setMatchModal({ visible: true, result: json.data, invoiceId: id });
        fetchInvoices();
      } else {
        message.error(json.error || '比对失败');
      }
    } catch { message.error('比对请求失败'); }
  };

  const statusConfig: Record<string, { color: string; icon: any; label: string }> = {
    pending: { color: 'default', icon: <SearchOutlined />, label: '待比对' },
    matched: { color: 'green', icon: <CheckCircleOutlined />, label: '一致' },
    mismatch: { color: 'red', icon: <CloseCircleOutlined />, label: '不一致' },
  };

  const columns = [
    { title: '发票号码', dataIndex: 'invoiceNo', key: 'invoiceNo', width: 150 },
    { title: '供应商', dataIndex: 'supplierName', key: 'supplierName', width: 150, ellipsis: true },
    { title: '关联报关单', dataIndex: 'declarationId', key: 'declarationId', width: 120,
      render: (v: string) => v ? <Text code>{v.slice(0, 8)}...</Text> : <Text type="secondary">未关联</Text> },
    {
      title: '比对状态', dataIndex: 'matchStatus', key: 'matchStatus', width: 100,
      render: (s: string, r: SupplierInvoice) => {
        const cfg = statusConfig[s] || statusConfig.pending;
        return <Tag color={cfg.color} icon={cfg.icon}>{cfg.label}{r.matchScore != null ? ` (${r.matchScore}分)` : ''}</Tag>;
      },
    },
    {
      title: '操作', key: 'action', width: 160,
      render: (_: any, r: SupplierInvoice) => (
        <Space>
          <Button size="small" type="primary" onClick={() => handleMatch(r.id)}
            disabled={r.matchStatus === 'matched'}>
            三要素比对
          </Button>
          {r.matchDetail && <Button size="small" onClick={() => {
            try { setMatchModal({ visible: true, result: JSON.parse(r.matchDetail || '{}'), invoiceId: r.id }); }
            catch { message.warning('无法解析比对详情'); }
          }}>详情</Button>}
        </Space>
      ),
    },
    { title: '上传时间', dataIndex: 'createdAt', key: 'createdAt', width: 160,
      render: (v: string) => v ? (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '') : '' },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>供应商发票核验</Title>
        <Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            三要素比对：品名 / 数量 / 单位必须与报关单一致
          </Text>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModal(true)}>录入发票</Button>
        </Space>
      </Row>

      <Card size="small">
        <Spin spinning={loading}>
          <Table dataSource={invoices} columns={columns} rowKey="id" pagination={{ pageSize: 10 }} size="small" />
        </Spin>
      </Card>

      {/* 比对结果弹窗 */}
      <Modal
        title="三要素比对结果"
        open={matchModal.visible}
        onCancel={() => setMatchModal({ ...matchModal, visible: false })}
        footer={null}
        width={600}
      >
        {matchModal.result && (
          <>
            <div style={{ marginBottom: 16 }}>
              <Tag color={matchModal.result.matchStatus === 'matched' ? 'green' : 'red'} style={{ fontSize: 14, padding: '4px 12px' }}>
                {matchModal.result.matchStatus === 'matched' ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                {' '}匹配评分：{matchModal.result.matchScore}分
              </Tag>
              {matchModal.result.matchStatus === 'matched' ?
                <Text type="success"> ✅ 三要素一致</Text> :
                <Text type="danger"> ⚠️ 存在差异项</Text>
              }
            </div>
            {matchModal.result.issues.length > 0 && (
              <div style={{ background: '#fff2f0', padding: 12, borderRadius: 6, marginBottom: 12 }}>
                <Text type="danger">⚠️ 以下品名不匹配：</Text>
                {matchModal.result.issues.map((issue, i) => <div key={i} style={{ color: '#cf1322', fontSize: 13 }}>· {issue}</div>)}
              </div>
            )}
            <Divider>逐项比对明细</Divider>
            {matchModal.result.details.map((d, i) => (
              <div key={i} style={{ padding: 8, marginBottom: 8, background: d.passed ? '#f6ffed' : '#fff2f0', borderRadius: 4 }}>
                <Row gutter={8}>
                  <Col span={6}><Text strong>报关单：</Text></Col>
                  <Col span={18}><Text>{d.declarationItem.name} × {d.declarationItem.quantity}{d.declarationItem.unit}</Text></Col>
                </Row>
                <Row gutter={8}>
                  <Col span={6}><Text strong>发票：</Text></Col>
                  <Col span={18}>
                    {d.invoiceItem ?
                      <Text>{d.invoiceItem.name} × {d.invoiceItem.quantity}{d.invoiceItem.unit}</Text> :
                      <Text type="warning">未匹配到对应行</Text>
                    }
                  </Col>
                </Row>
                <Row gutter={8}>
                  <Col span={6}><Text strong>评分：</Text></Col>
                  <Col span={18}>
                    <Tag color={d.passed ? 'green' : 'red'}>{d.score}分</Tag>
                    {d.passed ? <Text type="success">通过</Text> : <Text type="danger">不通过</Text>}
                  </Col>
                </Row>
              </div>
            ))}
          </>
        )}
      </Modal>

      {/* 录入发票弹窗 */}
      <Modal title="录入供应商发票" open={addModal} onCancel={() => setAddModal(false)} onOk={() => {
        form.validateFields().then(async values => {
          try {
            const res = await fetch('/api/tax-rebate/supplier-invoice/upload', {
              method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify(values),
            });
            const json = await res.json();
            if (json.success) {
              message.success('录入成功');
              setAddModal(false);
              form.resetFields();
              fetchInvoices();
            } else message.error(json.error || '录入失败');
          } catch { message.error('请求失败'); }
        });
      }}>
        <Form form={form} layout="vertical">
          <Form.Item label="发票号码" name="invoiceNo" rules={[{ required: true }]}>
            <Input placeholder="如 INV-2024-001" />
          </Form.Item>
          <Form.Item label="供应商名称" name="supplierName">
            <Input placeholder="如 深圳科技公司" />
          </Form.Item>
          <Form.Item label="开票日期" name="invoiceDate">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="关联报关单ID" name="declarationId">
            <Input placeholder="可选，关联后自动比对" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
