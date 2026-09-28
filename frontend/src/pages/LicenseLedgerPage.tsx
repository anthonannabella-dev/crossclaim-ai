import { useEffect, useState, useCallback } from 'react';
import {
  Card, Table, Tag, Button, Space, Input, Modal, Form, DatePicker, message,
  Typography, Row, Col, Statistic, Popconfirm, Tooltip, Alert,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, ReloadOutlined, SafetyCertificateOutlined,
  WarningOutlined, EditOutlined, DeleteOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import api from '../utils/api';

const { Title, Text } = Typography;

interface License {
  id: string;
  licenseType: string;
  licenseCode: string | null;
  licenseNo: string;
  holder: string | null;
  relatedHsCodes: string | null;
  issuingAuthority: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  status: string;
  notes: string | null;
  daysToExpiry: number | null;
}

// 常见监管证件代码（参考海关监管证件代码表，可据实增改）
const COMMON_TYPES = [
  '进口许可证', '出口许可证', '两用物项和技术进口许可证', '两用物项和技术出口许可证',
  '入境货物通关单', '出境货物通关单', '3C认证(强制性产品认证)', '进口药品通关单',
  '濒危物种允许进出口证明书', '原产地证书', '自动进口许可证', '关税配额证明',
];

function expiryTag(d: number | null) {
  if (d == null) return <Tag>长期/未设</Tag>;
  if (d < 0) return <Tag color="error">已过期 {Math.abs(d)} 天</Tag>;
  if (d <= 30) return <Tag color="warning">{d} 天后到期</Tag>;
  if (d <= 90) return <Tag color="gold">{d} 天后到期</Tag>;
  return <Tag color="success">{d} 天</Tag>;
}

export default function LicenseLedgerPage() {
  const [rows, setRows] = useState<License[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<License | null>(null);
  const [alerts, setAlerts] = useState<{ expiredCount: number; expiringCount: number } | null>(null);
  const [form] = Form.useForm();

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, alertRes] = await Promise.all([
        api.get('/api/license', { params: q.trim() ? { q: q.trim() } : {} }),
        api.get('/api/license/alerts', { params: { days: 30 } }),
      ]);
      if (listRes.data.success) setRows(listRes.data.data);
      if (alertRes.data.success) setAlerts(alertRes.data.data);
    } catch (e: any) {
      message.error('加载证件台账失败：' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => { fetchData(); /* eslint-disable-next-line */ }, []);

  const openAdd = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (r: License) => {
    setEditing(r);
    form.setFieldsValue({
      ...r,
      issueDate: r.issueDate ? dayjs(r.issueDate) : null,
      expiryDate: r.expiryDate ? dayjs(r.expiryDate) : null,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const v = await form.validateFields();
    const payload = {
      ...v,
      issueDate: v.issueDate ? v.issueDate.format('YYYY-MM-DD') : null,
      expiryDate: v.expiryDate ? v.expiryDate.format('YYYY-MM-DD') : null,
    };
    try {
      if (editing) await api.patch(`/api/license/${editing.id}`, payload);
      else await api.post('/api/license', payload);
      message.success(editing ? '已更新' : '已新增');
      setModalOpen(false);
      fetchData();
    } catch (e: any) {
      message.error(e.response?.data?.error || '保存失败');
    }
  };

  const del = async (id: string) => {
    try { await api.delete(`/api/license/${id}`); message.success('已删除'); fetchData(); }
    catch { message.error('删除失败'); }
  };

  const columns = [
    { title: '证件类型', dataIndex: 'licenseType', key: 'licenseType',
      render: (v: string, r: License) => <Space direction="vertical" size={0}><Text strong>{v}</Text>{r.licenseCode && <Text type="secondary" style={{ fontSize: 12 }}>代码 {r.licenseCode}</Text>}</Space> },
    { title: '证件编号', dataIndex: 'licenseNo', key: 'licenseNo' },
    { title: '持证方', dataIndex: 'holder', key: 'holder', render: (v: string) => v || '-' },
    { title: '适用HS', dataIndex: 'relatedHsCodes', key: 'relatedHsCodes', ellipsis: true, render: (v: string) => v || '-' },
    { title: '有效期至', dataIndex: 'expiryDate', key: 'expiryDate', width: 120,
      render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD') : '长期' },
    { title: '到期', dataIndex: 'daysToExpiry', key: 'daysToExpiry', width: 130,
      sorter: (a: License, b: License) => (a.daysToExpiry ?? 1e9) - (b.daysToExpiry ?? 1e9),
      defaultSortOrder: 'ascend' as const,
      render: (d: number | null) => expiryTag(d) },
    { title: '状态', dataIndex: 'status', key: 'status', width: 90,
      render: (s: string) => <Tag color={s === 'expired' ? 'error' : s === 'revoked' ? 'default' : 'success'}>
        {s === 'expired' ? '已过期' : s === 'revoked' ? '已吊销' : '有效'}</Tag> },
    { title: '操作', key: 'actions', width: 130,
      render: (_: any, r: License) => (
        <Space>
          <Tooltip title="编辑"><Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} /></Tooltip>
          <Popconfirm title="确定删除该证件？" onConfirm={() => del(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ) },
  ];

  return (
    <div>
      <Title level={4} style={{ marginTop: 0 }}><SafetyCertificateOutlined /> 证件台账</Title>
      <Text type="secondary">登记监管证件/许可证及有效期，系统自动到期预警，并向风控看板输出证件类风险。</Text>

      <Row gutter={12} style={{ marginTop: 16, marginBottom: 12 }}>
        <Col span={8}><Card size="small"><Statistic title="证件总数" value={rows.length} suffix="项" /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="已过期" value={alerts?.expiredCount ?? 0}
          valueStyle={{ color: (alerts?.expiredCount ?? 0) > 0 ? '#cf1322' : undefined }} prefix={<WarningOutlined />} /></Card></Col>
        <Col span={8}><Card size="small"><Statistic title="30天内到期" value={alerts?.expiringCount ?? 0}
          valueStyle={{ color: (alerts?.expiringCount ?? 0) > 0 ? '#d48806' : undefined }} /></Card></Col>
      </Row>

      {(alerts && (alerts.expiredCount > 0 || alerts.expiringCount > 0)) && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={`有 ${alerts.expiredCount} 项证件已过期、${alerts.expiringCount} 项将在 30 天内到期，过期证件继续申报将被退单/处罚，请及时补办。`} />
      )}

      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Input placeholder="证件号/类型/持证方" value={q} onChange={e => setQ(e.target.value)}
            onPressEnter={fetchData} allowClear style={{ width: 240 }} prefix={<SearchOutlined />} />
          <Button type="primary" icon={<SearchOutlined />} onClick={fetchData}>查询</Button>
          <Button icon={<ReloadOutlined />} onClick={() => { setQ(''); setTimeout(fetchData, 0); }}>重置</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>登记证件</Button>
        </Space>
      </Card>

      <Table rowKey="id" loading={loading} dataSource={rows} columns={columns}
        pagination={{ pageSize: 15 }} scroll={{ x: 1000 }}
        locale={{ emptyText: '暂无证件，点击「登记证件」录入' }} />

      <Modal title={editing ? '编辑证件' : '登记证件'} open={modalOpen}
        onCancel={() => setModalOpen(false)} onOk={submit} destroyOnClose width={640}>
        <Form form={form} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="证件类型" name="licenseType" rules={[{ required: true, message: '请填写证件类型' }]}>
                <Input list="license-types" placeholder="如 进口许可证 / 3C认证" />
              </Form.Item>
              <datalist id="license-types">{COMMON_TYPES.map(t => <option key={t} value={t} />)}</datalist>
            </Col>
            <Col span={12}><Form.Item label="监管证件代码" name="licenseCode"><Input placeholder="如 1 / 4 / A（可选）" /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item label="证件编号" name="licenseNo" rules={[{ required: true, message: '请填写证件编号' }]}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item label="持证单位/相关方" name="holder"><Input /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item label="签发日期" name="issueDate"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item label="有效期至" name="expiryDate"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item label="发证机关" name="issuingAuthority"><Input /></Form.Item></Col>
            <Col span={12}><Form.Item label="适用HS(逗号分隔)" name="relatedHsCodes"><Input placeholder="如 8471300000,8517120000" /></Form.Item></Col>
          </Row>
          <Form.Item label="备注" name="notes"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
