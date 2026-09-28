import { useState, useEffect } from 'react';
import {
  Card, Table, Button, Modal, Input, Tag, message, Space, Popconfirm, Checkbox,
  Drawer, Descriptions, Switch, Typography, Tooltip, Badge, Form, Divider,
} from 'antd';
import {
  ApiOutlined, PlusOutlined, ReloadOutlined, SendOutlined,
  CopyOutlined, DeleteOutlined, EditOutlined, EyeOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined,
} from '@ant-design/icons';
import api from '../utils/api';

const { Text } = Typography;

interface WebhookSubscription {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventType: string;
  payload: string;
  statusCode: number | null;
  responseBody: string | null;
  durationMs: number;
  success: boolean;
  error: string | null;
  attempt: number;
  createdAt: string;
}

interface EventType {
  type: string;
  label: string;
  description: string;
}

const STATUS_COLORS: Record<string, string> = {
  success: 'green',
  pending: 'orange',
  failed: 'red',
};

export default function WebhookPage() {
  const [subscriptions, setSubscriptions] = useState<WebhookSubscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSub, setEditingSub] = useState<WebhookSubscription | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  // 投递日志
  const [deliveriesDrawerOpen, setDeliveriesDrawerOpen] = useState(false);
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [expandedRowKeys, setExpandedRowKeys] = useState<string[]>([]);

  const fetchSubscriptions = async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/webhooks');
      setSubscriptions(res.data);
    } catch {
      message.error('获取订阅列表失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchEventTypes = async () => {
    try {
      const res = await api.get('/api/webhooks/event-types');
      setEventTypes(res.data);
    } catch {
      // 静默
    }
  };

  useEffect(() => {
    fetchSubscriptions();
    fetchEventTypes();
  }, []);

  const handleCreate = () => {
    setEditingSub(null);
    form.resetFields();
    form.setFieldsValue({ events: [] });
    setModalOpen(true);
  };

  const handleEdit = (sub: WebhookSubscription) => {
    setEditingSub(sub);
    form.setFieldsValue({
      name: sub.name,
      url: sub.url,
      events: JSON.parse(sub.events),
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields().catch(() => {});
    if (!values) return;

    setSubmitting(true);
    try {
      if (editingSub) {
        await api.put(`/api/webhooks/${editingSub.id}`, values);
        message.success('订阅已更新');
      } else {
        const res = await api.post('/api/webhooks', values);
        message.success('订阅创建成功');
        Modal.info({
          title: '密钥（仅显示一次）',
          content: (
            <Input.Password value={res.data.secret} readOnly style={{ marginTop: 8 }}
              addonAfter={<Button size="small" icon={<CopyOutlined />}
                onClick={() => { navigator.clipboard.writeText(res.data.secret); message.success('已复制'); }} />}
            />
          ),
        });
      }
      setModalOpen(false);
      fetchSubscriptions();
    } catch (err: any) {
      message.error(err.response?.data?.error || '操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (id: string) => {
    try {
      await api.post(`/api/webhooks/${id}/toggle`);
      fetchSubscriptions();
      message.success('状态已更新');
    } catch {
      message.error('操作失败');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/api/webhooks/${id}`);
      fetchSubscriptions();
      message.success('已删除');
    } catch {
      message.error('删除失败');
    }
  };

  const handleTest = async (id: string) => {
    try {
      const res = await api.post(`/api/webhooks/${id}/test`);
      if (res.data.success) {
        message.success(`测试成功 — ${res.data.statusCode} ${res.data.durationMs}ms`);
      } else {
        message.error(`测试失败: ${res.data.error}`);
      }
    } catch {
      message.error('测试请求失败');
    }
  };

  const handleViewDeliveries = async (subId: string) => {
    setSelectedSubId(subId);
    setDeliveriesDrawerOpen(true);
    setExpandedRowKeys([]);
    setDeliveriesLoading(true);
    try {
      const res = await api.get(`/api/webhooks/${subId}/deliveries`, { params: { pageSize: 50 } });
      setDeliveries(res.data.data);
    } catch {
      message.error('获取投递日志失败');
    } finally {
      setDeliveriesLoading(false);
    }
  };

  const columns = [
    {
      title: '名称', dataIndex: 'name', key: 'name',
      render: (text: string) => <Text strong>{text}</Text>,
    },
    {
      title: '回调URL', dataIndex: 'url', key: 'url',
      render: (text: string) => (
        <Tooltip title={text}>
          <Text code style={{ maxWidth: 240, display: 'inline-block' }} ellipsis>{text}</Text>
        </Tooltip>
      ),
    },
    {
      title: '事件', dataIndex: 'events', key: 'events',
      render: (events: string) => {
        const parsed: string[] = JSON.parse(events);
        const labelMap = new Map(eventTypes.map(e => [e.type, e.label]));
        return (
          <Space size={4} wrap>
            {parsed.map(e => (
              <Tag key={e} color="blue">{labelMap.get(e) || e}</Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '状态', dataIndex: 'isActive', key: 'isActive', width: 80,
      render: (active: boolean) => (
        <Badge status={active ? 'success' : 'default'} text={active ? '启用' : '停用'} />
      ),
    },
    {
      title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 130,
      render: (d: string) => new Date(d).toLocaleDateString('zh-CN'),
    },
    {
      title: '操作', key: 'actions', width: 280,
      render: (_: any, record: WebhookSubscription) => (
        <Space size="small">
          <Switch checked={record.isActive} onChange={() => handleToggle(record.id)} size="small" />
          <Tooltip title="测试"><Button size="small" icon={<SendOutlined />} onClick={() => handleTest(record.id)} /></Tooltip>
          <Tooltip title="投递日志"><Button size="small" icon={<EyeOutlined />}
            onClick={() => handleViewDeliveries(record.id)} /></Tooltip>
          <Tooltip title="编辑"><Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} /></Tooltip>
          <Popconfirm title="确定删除此订阅？" onConfirm={() => handleDelete(record.id)}>
            <Tooltip title="删除"><Button size="small" danger icon={<DeleteOutlined />} /></Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const deliveryColumns = [
    {
      title: '事件', dataIndex: 'eventType', key: 'eventType', width: 130,
      render: (t: string) => <Tag>{t}</Tag>,
    },
    {
      title: '状态', dataIndex: 'success', key: 'success', width: 80,
      render: (s: boolean) => s
        ? <Tag icon={<CheckCircleOutlined />} color="success">成功</Tag>
        : <Tag icon={<CloseCircleOutlined />} color="error">失败</Tag>,
    },
    { title: 'HTTP', dataIndex: 'statusCode', key: 'statusCode', width: 70 },
    {
      title: '耗时', dataIndex: 'durationMs', key: 'durationMs', width: 80,
      render: (ms: number) => `${ms}ms`,
    },
    {
      title: '尝试', dataIndex: 'attempt', key: 'attempt', width: 60,
      render: (a: number) => <Tag>{a}</Tag>,
    },
    {
      title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 150,
      render: (d: string) => new Date(d).toLocaleString('zh-CN'),
    },
    { title: '错误', dataIndex: 'error', key: 'error', ellipsis: true, width: 150 },
  ];

  const expandRowRender = (record: WebhookDelivery) => (
    <div style={{ padding: '0 24px' }}>
      <Descriptions column={2} size="small" bordered>
        <Descriptions.Item label="Delivery ID" span={2}>{record.id}</Descriptions.Item>
        <Descriptions.Item label="请求体" span={2}>
          <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12, margin: 0 }}>
            {JSON.stringify(JSON.parse(record.payload || '{}'), null, 2)}
          </pre>
        </Descriptions.Item>
        <Descriptions.Item label="响应" span={2}>
          <Text code style={{ maxHeight: 100, overflow: 'auto', display: 'block', whiteSpace: 'pre-wrap' }}>
            {record.responseBody || '(空)'}
          </Text>
        </Descriptions.Item>
      </Descriptions>
    </div>
  );

  return (
    <>
      <Card
        title={<Space><ApiOutlined />Webhook 集成</Space>}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchSubscriptions}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>创建订阅</Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          dataSource={subscriptions}
          columns={columns}
          loading={loading}
          locale={{ emptyText: '暂无Webhook订阅，点击"创建订阅"添加' }}
        />
      </Card>

      <Modal
        title={editingSub ? '编辑订阅' : '创建订阅'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={submitting}
        width={560}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name" label="订阅名称"
            rules={[{ required: true, message: '请输入订阅名称' }]}
          >
            <Input placeholder="例如：ERP系统、物流平台" />
          </Form.Item>
          <Form.Item
            name="url" label="回调 URL"
            rules={[
              { required: true, message: '请输入回调URL' },
              { pattern: /^https?:\/\/.+/, message: '必须以 http:// 或 https:// 开头' },
            ]}
          >
            <Input placeholder="https://your-system.com/webhook/callback" />
          </Form.Item>
          <Form.Item
            name="events" label="订阅事件"
            rules={[{ required: true, message: '请选择至少一个事件', type: 'array', min: 1 }]}
          >
            <Checkbox.Group style={{ width: '100%' }}>
              <Space direction="vertical" style={{ width: '100%' }}>
                {eventTypes.map(et => (
                  <Checkbox key={et.type} value={et.type}>
                    <span style={{ fontWeight: 500 }}>{et.label}</span>
                    <Text type="secondary" style={{ marginLeft: 8 }}>({et.type})</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 12 }}>{et.description}</Text>
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title="投递日志"
        open={deliveriesDrawerOpen}
        onClose={() => setDeliveriesDrawerOpen(false)}
        width={720}
      >
        <Table
          rowKey="id"
          dataSource={deliveries}
          columns={deliveryColumns}
          loading={deliveriesLoading}
          size="small"
          expandable={{
            expandedRowRender: expandRowRender,
            expandedRowKeys,
            onExpandedRowsChange: (keys) => setExpandedRowKeys(keys as string[]),
          }}
          locale={{ emptyText: '暂无投递记录' }}
          pagination={{ pageSize: 15, size: 'small' }}
        />
      </Drawer>
    </>
  );
}
