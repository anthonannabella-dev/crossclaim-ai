import { useEffect, useState } from 'react';
import { Table, Button, Card, message, Tag, Modal, Input, Space, Popconfirm, Select, DatePicker } from 'antd';
import { PlusOutlined, EditOutlined } from '@ant-design/icons';
import api from '../../utils/adminApi';

const categoryOptions = [
  { value: 'customs', label: '海关政策' },
  { value: 'tariff', label: '关税调整' },
  { value: 'rcep', label: 'RCEP规则' },
  { value: 'cbam', label: '碳关税' },
  { value: 'origin', label: '原产地' },
  { value: 'export', label: '出口管制' },
];

const categoryColors: Record<string, string> = {
  customs: 'blue', tariff: 'orange', rcep: 'green',
  cbam: 'red', origin: 'purple', export: 'magenta',
};

export default function AdminPolicyAlerts() {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [summary, setSummary] = useState('');
  const [source, setSource] = useState('海关总署');
  const [publishDate, setPublishDate] = useState('');
  const [category, setCategory] = useState('customs');
  const [hsCode, setHsCode] = useState('');

  const fetchAll = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/policy-alerts');
      setAlerts(res.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  const resetForm = () => {
    setEditing(null);
    setTitle('');
    setContent('');
    setSummary('');
    setSource('海关总署');
    setPublishDate('');
    setCategory('customs');
    setHsCode('');
  };

  const handleSubmit = async () => {
    if (!title || !content) { message.error('标题和内容不能为空'); return; }
    try {
      const body: any = { title, content, summary, source, category, hsCode: hsCode || null };
      if (publishDate) body.publishDate = publishDate;
      if (editing) {
        await api.put(`/admin/policy-alerts/${editing.id}`, body);
        message.success('已更新');
      } else {
        await api.post('/admin/policy-alerts', body);
        message.success('已创建');
      }
      setModalOpen(false);
      resetForm();
      fetchAll();
    } catch {
      message.error('操作失败');
    }
  };

  const handleDeactivate = async (id: string) => {
    try {
      await api.delete(`/admin/policy-alerts/${id}`);
      message.success('已停用');
      fetchAll();
    } catch {
      message.error('操作失败');
    }
  };

  const handleEdit = (record: any) => {
    setEditing(record);
    setTitle(record.title);
    setContent(record.content || '');
    setSummary(record.summary || '');
    setSource(record.source);
    setPublishDate(record.publishDate ? record.publishDate.slice(0, 10) : '');
    setCategory(record.category);
    setHsCode(record.hsCode || '');
    setModalOpen(true);
  };

  const columns = [
    { title: '标题', dataIndex: 'title', key: 'title', ellipsis: true, width: 220 },
    { title: '分类', dataIndex: 'category', key: 'category', width: 90,
      render: (v: string) => <Tag color={categoryColors[v]}>{categoryOptions.find(c => c.value === v)?.label || v}</Tag> },
    { title: 'HS编码', dataIndex: 'hsCode', key: 'hsCode', width: 100,
      render: (v: string) => v ? <Tag>{v}</Tag> : '-' },
    { title: '来源', dataIndex: 'source', key: 'source', width: 80 },
    { title: '发布日期', dataIndex: 'publishDate', key: 'publishDate', width: 120,
      render: (v: string) => new Date(v).toLocaleDateString('zh-CN') },
    { title: '状态', dataIndex: 'isActive', key: 'isActive', width: 70,
      render: (v: boolean) => v ? <Tag color="green">启用</Tag> : <Tag color="default">停用</Tag> },
    { title: '操作', key: 'actions', width: 120, render: (_: any, r: any) => (
      <Space size="small">
        <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)}>编辑</Button>
        {r.isActive && (
          <Popconfirm title="确定停用此法规？" onConfirm={() => handleDeactivate(r.id)}>
            <Button type="link" size="small" danger>停用</Button>
          </Popconfirm>
        )}
      </Space>
    )},
  ];

  return (
    <>
      <h2>法规预警管理</h2>
      <Card style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { resetForm(); setModalOpen(true); }}>
          新增法规预警
        </Button>
      </Card>
      <Table dataSource={alerts} columns={columns} rowKey="id" loading={loading}
        scroll={{ x: 700 }} pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }} size="small" />
      <Modal
        title={editing ? '编辑法规预警' : '新增法规预警'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        destroyOnClose
        width="min(640px, 95vw)"
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Input placeholder="法规标题" value={title} onChange={e => setTitle(e.target.value)} />
          <Space>
            <Select
              style={{ width: 140 }}
              value={category}
              onChange={setCategory}
              options={categoryOptions}
            />
            <Input
              style={{ width: 140 }}
              placeholder="HS编码(可选)"
              value={hsCode}
              onChange={e => setHsCode(e.target.value)}
            />
            <Input
              style={{ width: 160 }}
              placeholder="来源"
              value={source}
              onChange={e => setSource(e.target.value)}
            />
            <Input
              style={{ width: 160 }}
              placeholder="发布日期"
              type="date"
              value={publishDate}
              onChange={e => setPublishDate(e.target.value)}
            />
          </Space>
          <Input placeholder="摘要(可选)" value={summary} onChange={e => setSummary(e.target.value)} />
          <Input.TextArea rows={6} placeholder="法规正文内容" value={content} onChange={e => setContent(e.target.value)} />
        </Space>
      </Modal>
    </>
  );
}
