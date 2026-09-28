import { useEffect, useState } from 'react';
import { Table, Button, Card, message, Tag, Modal, Input, Space, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons';
import api from '../../utils/adminApi';

export default function AdminAnnouncements() {
  const [announcements, setAnnouncements] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const fetchAll = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/announcements', { params: { all: 'true' } });
      setAnnouncements(res.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  const handleSubmit = async () => {
    if (!title || !content) { message.error('标题和内容不能为空'); return; }
    try {
      if (editing) {
        await api.put(`/admin/announcements/${editing.id}`, { title, content });
        message.success('已更新');
      } else {
        await api.post('/admin/announcements', { title, content });
        message.success('已创建');
      }
      setModalOpen(false);
      setEditing(null);
      setTitle('');
      setContent('');
      fetchAll();
    } catch {
      message.error('操作失败');
    }
  };

  const handleDeactivate = async (id: string) => {
    try {
      await api.delete(`/admin/announcements/${id}`);
      message.success('已停用');
      fetchAll();
    } catch {
      message.error('操作失败');
    }
  };

  const handleEdit = (record: any) => {
    setEditing(record);
    setTitle(record.title);
    setContent(record.content);
    setModalOpen(true);
  };

  const columns = [
    { title: '标题', dataIndex: 'title', key: 'title', ellipsis: true },
    { title: '内容', dataIndex: 'content', key: 'content', ellipsis: true, width: 300,
      render: (v: string) => v?.length > 60 ? v.slice(0, 58) + '..' : v },
    { title: '状态', dataIndex: 'isActive', key: 'isActive', width: 80,
      render: (v: boolean) => v ? <Tag color="green">启用</Tag> : <Tag color="default">停用</Tag> },
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 170,
      render: (v: string) => new Date(v).toLocaleString('zh-CN') },
    { title: '操作', key: 'actions', width: 140, render: (_: any, r: any) => (
      <Space size="small">
        <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)}>编辑</Button>
        {r.isActive && (
          <Popconfirm title="确定停用此公告？" onConfirm={() => handleDeactivate(r.id)}>
            <Button type="link" size="small" danger>停用</Button>
          </Popconfirm>
        )}
      </Space>
    )},
  ];

  return (
    <>
      <h2>系统公告管理</h2>
      <Card style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setTitle(''); setContent(''); setModalOpen(true); }}>新建公告</Button>
      </Card>
      <Table dataSource={announcements} columns={columns} rowKey="id" loading={loading}
        scroll={{ x: 600 }} pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }} size="small" />
      <Modal title={editing ? '编辑公告' : '新建公告'} open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit} destroyOnClose>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Input placeholder="公告标题" value={title} onChange={e => setTitle(e.target.value)} />
          <Input.TextArea rows={4} placeholder="公告内容" value={content} onChange={e => setContent(e.target.value)} />
        </Space>
      </Modal>
    </>
  );
}
