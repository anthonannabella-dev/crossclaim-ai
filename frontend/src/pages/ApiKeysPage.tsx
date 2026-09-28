import { useState, useEffect } from 'react';
import { Card, Table, Button, Modal, Input, Tag, message, Space, Popconfirm, Typography, Alert } from 'antd';
import { KeyOutlined, PlusOutlined, ReloadOutlined, CopyOutlined } from '@ant-design/icons';
import api from '../utils/api';

const { Text, Paragraph } = Typography;

interface ApiToken {
  id: string;
  appKey: string;
  name: string;
  isActive: boolean;
  rateLimit: number;
  totalCalls: number;
  monthlyCalls: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export default function ApiKeysPage() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [newToken, setNewToken] = useState<any>(null);
  const [regeneratedToken, setRegeneratedToken] = useState<string | null>(null);

  const fetchTokens = async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/api-tokens');
      setTokens(res.data);
    } catch {
      // 非企业版静默处理
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTokens(); }, []);

  const handleCreate = async () => {
    try {
      const res = await api.post('/api/api-tokens', { name: newTokenName || undefined });
      setNewToken(res.data);
      setCreateModalOpen(false);
      setNewTokenName('');
      fetchTokens();
    } catch (err: any) {
      message.error(err.response?.data?.error || '创建失败');
    }
  };

  const handleRegenerate = async (id: string) => {
    try {
      const res = await api.post(`/api/api-tokens/${id}/regenerate`);
      setRegeneratedToken(res.data.token);
      message.success('Token已重新生成');
    } catch {
      message.error('操作失败');
    }
  };

  const handleToggle = async (id: string) => {
    try {
      await api.post(`/api/api-tokens/${id}/toggle`);
      fetchTokens();
      message.success('状态已更新');
    } catch {
      message.error('操作失败');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    message.success('已复制到剪贴板');
  };

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: 'AppKey', dataIndex: 'appKey', key: 'appKey',
      render: (v: string) => <Text copyable style={{ fontFamily: 'monospace' }}>{v}</Text>,
    },
    {
      title: '状态', dataIndex: 'isActive', key: 'isActive',
      render: (v: boolean) => v ? <Tag color="green">启用</Tag> : <Tag color="red">禁用</Tag>,
    },
    { title: '频率限制', dataIndex: 'rateLimit', key: 'rateLimit', render: (v: number) => `${v}次/分钟` },
    { title: '总调用', dataIndex: 'totalCalls', key: 'totalCalls' },
    { title: '本月调用', dataIndex: 'monthlyCalls', key: 'monthlyCalls' },
    {
      title: '最近使用', dataIndex: 'lastUsedAt', key: 'lastUsedAt',
      render: (v: string | null) => v ? new Date(v).toLocaleString() : '从未使用',
    },
    {
      title: '操作', key: 'actions',
      render: (_: any, record: ApiToken) => (
        <Space>
          <Popconfirm title="重新生成后旧Token将立即失效" onConfirm={() => handleRegenerate(record.id)}>
            <Button size="small" icon={<ReloadOutlined />}>重新生成</Button>
          </Popconfirm>
          <Button size="small" onClick={() => handleToggle(record.id)}>
            {record.isActive ? '禁用' : '启用'}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <h2><KeyOutlined /> API密钥管理</h2>

      <Alert
        type="info"
        message="企业版API接入说明"
        description={
          <div>
            <p>调用外部API时，需要在HTTP Header中携带以下两个参数：</p>
            <p><Text code>X-App-Key: 您的AppKey</Text></p>
            <p><Text code>X-API-Token: 您的API Token</Text></p>
            <p>API基础路径: <Text code>/external</Text> | 接口文档: <Text code>/external/docs</Text></p>
          </div>
        }
        style={{ marginBottom: 16 }}
      />

      <Card
        title="API Tokens"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>创建Token</Button>}
      >
        <Table dataSource={tokens.map(t => ({ ...t, key: t.id }))} columns={columns} loading={loading} scroll={{ x: 800 }} />
      </Card>

      <Modal
        title="创建API Token"
        open={createModalOpen}
        onCancel={() => { setCreateModalOpen(false); setNewTokenName(''); }}
        footer={[
          <Button key="cancel" onClick={() => { setCreateModalOpen(false); setNewTokenName(''); }}>取消</Button>,
          <Button key="create" type="primary" onClick={handleCreate}>创建</Button>,
        ]}
      >
        <Input placeholder="Token名称（可选）" value={newTokenName} onChange={e => setNewTokenName(e.target.value)} style={{ marginBottom: 8 }} />
        <p style={{ color: '#999' }}>最多创建5个有效Token，频率限制默认100次/分钟</p>
      </Modal>

      {/* 新创建的Token展示 */}
      <Modal
        title="Token创建成功"
        open={!!newToken}
        onCancel={() => setNewToken(null)}
        footer={[<Button key="close" type="primary" onClick={() => setNewToken(null)}>我已保存</Button>]}
      >
        <Alert type="warning" message="请立即保存Token，关闭后将无法再次查看" style={{ marginBottom: 16 }} />
        <Paragraph>
          <Text strong>AppKey: </Text>
          <Text code copyable>{newToken?.appKey}</Text>
        </Paragraph>
        <Paragraph>
          <Text strong>API Token: </Text>
          <Text code copyable style={{ wordBreak: 'break-all' }}>{newToken?.token}</Text>
        </Paragraph>
        <Button icon={<CopyOutlined />} onClick={() => copyToClipboard(`X-App-Key: ${newToken?.appKey}\nX-API-Token: ${newToken?.token}`)}>
          复制完整Header
        </Button>
      </Modal>

      {/* 重新生成的Token展示 */}
      <Modal
        title="Token已重新生成"
        open={!!regeneratedToken}
        onCancel={() => setRegeneratedToken(null)}
        footer={[<Button key="close" type="primary" onClick={() => setRegeneratedToken(null)}>我已保存</Button>]}
      >
        <Alert type="warning" message="请立即保存新Token，旧Token已失效" style={{ marginBottom: 16 }} />
        <Paragraph>
          <Text strong>新Token: </Text>
          <Text code copyable style={{ wordBreak: 'break-all' }}>{regeneratedToken}</Text>
        </Paragraph>
      </Modal>
    </div>
  );
}
