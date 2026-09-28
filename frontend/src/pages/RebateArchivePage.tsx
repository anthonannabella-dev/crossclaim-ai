import { useState, useEffect } from 'react';
import { Row, Col, Card, Table, Button, Tag, Typography, message, Spin, Space, Modal, Descriptions, Divider, Input, DatePicker, Form, InputNumber, Select, Progress, Empty, Alert, Statistic } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, WarningOutlined, FolderOutlined, DownloadOutlined, PlusOutlined, SafetyCertificateOutlined, BankOutlined, DollarOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

const { Title, Text, Paragraph } = Typography;

interface RecordArchive {
  id: string;
  name: string;
  status: 'incomplete' | 'complete' | 'archived';
  hasContract: boolean;
  hasTransport: boolean;
  hasDeclaration: boolean;
  hasInvoice: boolean;
  hasPackingList: boolean;
  hasReceipt: boolean;
  archiveDate: string | null;
  expiryDate: string | null;
  declarationId: string | null;
  createdAt: string;
}

const DOCS_CONFIG = [
  { key: 'hasContract', label: '购销合同', icon: '📄' },
  { key: 'hasTransport', label: '运输单据', icon: '🚢' },
  { key: 'hasDeclaration', label: '报关单', icon: '📋' },
  { key: 'hasInvoice', label: '发票', icon: '🧾' },
  { key: 'hasPackingList', label: '装箱单', icon: '📦' },
  { key: 'hasReceipt', label: '收汇凭证', icon: '💰' },
];

export default function RebateArchivePage() {
  const [archives, setArchives] = useState<RecordArchive[]>([]);
  const [loading, setLoading] = useState(false);
  const [addModal, setAddModal] = useState(false);
  const [editModal, setEditModal] = useState<{ visible: boolean; archive: RecordArchive | null }>({ visible: false, archive: null });

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  const fetchArchives = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tax-rebate/archive/list', { headers });
      const json = await res.json();
      setArchives(json.data || []);
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchArchives(); }, []);

  const handleToggleDoc = async (archiveId: string, field: string, value: boolean) => {
    const update: any = {};
    update[field] = value;
    try {
      const res = await fetch(`/api/tax-rebate/archive/${archiveId}/update-docs`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });
      const json = await res.json();
      if (json.success) {
        message.success('已更新');
        fetchArchives();
      } else message.error('更新失败');
    } catch { message.error('请求失败'); }
  };

  const statusConfig: Record<string, { color: string; label: string }> = {
    incomplete: { color: 'orange', label: '未齐全' },
    complete: { color: 'green', label: '已齐全' },
    archived: { color: 'blue', label: '已归档' },
  };

  const columns = [
    { title: '单证组名称', dataIndex: 'name', key: 'name', width: 160 },
    {
      title: '单证清单', key: 'docs', width: 320,
      render: (_: any, r: RecordArchive) => (
        <Space size={4} wrap>
          {DOCS_CONFIG.map(doc => (
            <Tag
              key={doc.key}
              color={(r as any)[doc.key] ? 'green' : 'default'}
              style={{ cursor: 'pointer' }}
              onClick={() => handleToggleDoc(r.id, doc.key, !(r as any)[doc.key])}
            >
              {doc.icon} {doc.label} {(r as any)[doc.key] ? '✅' : '❌'}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '完整度', key: 'progress', width: 120,
      render: (_: any, r: RecordArchive) => {
        const done = DOCS_CONFIG.filter(d => (r as any)[d.key]).length;
        const total = DOCS_CONFIG.length;
        return <Progress percent={Math.round(done / total * 100)} size="small" />;
      },
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 80,
      render: (s: string) => <Tag color={statusConfig[s]?.color}>{statusConfig[s]?.label}</Tag>,
    },
    {
      title: '保存期限', key: 'expiry', width: 160,
      render: (_: any, r: RecordArchive) => {
        if (!r.expiryDate) return <Text type="secondary">未归档</Text>;
        const daysLeft = Math.floor((new Date(r.expiryDate).getTime() - Date.now()) / 86400000);
        return <Text type={daysLeft < 365 ? 'danger' : 'secondary'}>{dayjs(r.expiryDate).format('YYYY-MM-DD')} ({daysLeft}天)</Text>;
      },
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>备案单证归档</Title>
        <Space>
          <Alert type="info" showIcon message="点击标签切换单证状态" style={{ fontSize: 12, padding: '4px 12px' }} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModal(true)}>新建单证组</Button>
        </Space>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} md={8}>
          <Card size="small">
            <Statistic title="总单证组" value={archives.length} prefix={<FolderOutlined />} />
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card size="small">
            <Statistic title="已齐全" value={archives.filter(a => a.status === 'complete' || a.status === 'archived').length}
              prefix={<SafetyCertificateOutlined />} valueStyle={{ color: '#3f8600' }} />
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card size="small">
            <Statistic title="待补充" value={archives.filter(a => a.status === 'incomplete').length}
              prefix={<WarningOutlined />} valueStyle={{ color: '#fa8c16' }} />
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Spin spinning={loading}>
          <Table dataSource={archives} columns={columns} rowKey="id" pagination={{ pageSize: 10 }} size="small" />
        </Spin>
      </Card>

      {/* 新建弹窗 */}
      <Modal title="新建备案单证组" open={addModal} onCancel={() => setAddModal(false)}
        onOk={async () => {
          try {
            const res = await fetch('/api/tax-rebate/archive/create', {
              method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: `退税单证组-${dayjs().format('YYYYMMDD')}` }),
            });
            const json = await res.json();
            if (json.success) { message.success('创建成功'); setAddModal(false); fetchArchives(); }
            else message.error(json.error);
          } catch { message.error('请求失败'); }
        }}>
        <p>系统将创建一个新的备案单证组，点击标签切换各单证是否齐全。</p>
        <Text type="secondary">要求：购销合同、运输单据、报关单、发票、装箱单、收汇凭证，缺一不可。</Text>
      </Modal>
    </div>
  );
}
