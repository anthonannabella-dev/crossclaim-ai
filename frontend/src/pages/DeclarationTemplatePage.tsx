import { useState, useEffect, useCallback } from 'react';
import { Row, Col, Card, Table, Button, Form, Input, InputNumber, Select, Modal, message, Spin, Tag, Typography, Space, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, CopyOutlined, SaveOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;
const { TextArea } = Input;

interface DeclarationTemplate {
  id: string;
  name: string;
  description: string;
  customsMode: string;
  config: Record<string, any>;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

const MODES = [
  { value: 'normal', label: '一般贸易' },
  { value: '9610', label: '跨境电商零售出口' },
  { value: '9710', label: 'B2B直接出口' },
  { value: '9810', label: '出口海外仓' },
  { value: '1210', label: '保税备货进口' },
  { value: '1239', label: '保税备货进口A' },
  { value: '1039', label: '市场采购贸易' },
];

export default function DeclarationTemplatePage() {
  const [templates, setTemplates] = useState<DeclarationTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<DeclarationTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [applyModalOpen, setApplyModalOpen] = useState(false);
  const [applyTemplate, setApplyTemplate] = useState<DeclarationTemplate | null>(null);

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 加载模板列表 — 因为后端没有专门的模板表，用 localStorage 存储
  const loadTemplates = useCallback(() => {
    setLoading(true);
    try {
      const stored = localStorage.getItem('declaration_templates');
      const list: DeclarationTemplate[] = stored ? JSON.parse(stored) : [];
      setTemplates(list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
    } catch {
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const saveTemplates = (list: DeclarationTemplate[]) => {
    localStorage.setItem('declaration_templates', JSON.stringify(list));
    setTemplates(list);
  };

  // 新建/编辑
  const openModal = (tmpl?: DeclarationTemplate) => {
    if (tmpl) {
      setEditingTemplate(tmpl);
      form.setFieldsValue({ name: tmpl.name, description: tmpl.description, ...tmpl.config });
    } else {
      setEditingTemplate(null);
      form.resetFields();
    }
    setModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const config = {
        customsMode: values.customsMode || 'normal',
        importerExporter: values.importerExporter || '',
        portOfEntry: values.portOfEntry || '',
        transportMode: values.transportMode || '',
        tradeTerms: values.tradeTerms || 'CIF',
        currency: values.currency || 'USD',
        documents: values.documents || '',
      };

      const now = new Date().toISOString();
      if (editingTemplate) {
        const updated = templates.map(t =>
          t.id === editingTemplate.id
            ? { ...t, name: values.name, description: values.description, config, updatedAt: now }
            : t
        );
        saveTemplates(updated);
        message.success('模板已更新');
      } else {
        const newTmpl: DeclarationTemplate = {
          id: `tmpl_${Date.now()}`,
          name: values.name,
          description: values.description || '',
          customsMode: values.customsMode || 'normal',
          config,
          useCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        saveTemplates([newTmpl, ...templates]);
        message.success('模板已创建');
      }
      setModalOpen(false);
    } catch {
      // validation error
    } finally {
      setSaving(false);
    }
  };

  // 删除
  const handleDelete = (id: string) => {
    saveTemplates(templates.filter(t => t.id !== id));
    message.success('模板已删除');
  };

  // 套用（跳转到 DeclarationPage，用 url params 传递模板ID）
  const handleApply = (tmpl: DeclarationTemplate) => {
    setApplyTemplate(tmpl);
    setApplyModalOpen(true);
  };

  // 复制模板
  const handleDuplicate = (tmpl: DeclarationTemplate) => {
    const now = new Date().toISOString();
    const copy: DeclarationTemplate = {
      ...tmpl,
      id: `tmpl_${Date.now()}`,
      name: `${tmpl.name} (副本)`,
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    saveTemplates([copy, ...templates]);
    message.success('模板已复制');
  };

  const columns = [
    { title: '模板名称', dataIndex: 'name', key: 'name', ellipsis: true },
    { title: '申报模式', dataIndex: 'customsMode', key: 'customsMode', width: 100 },
    { title: '说明', dataIndex: 'description', key: 'description', ellipsis: true },
    { title: '使用次数', dataIndex: 'useCount', key: 'useCount', width: 90 },
    { title: '更新时间', dataIndex: 'updatedAt', key: 'updatedAt', width: 150, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
    {
      title: '操作', key: 'action', width: 180,
      render: (_: any, r: DeclarationTemplate) => (
        <Space size="small">
          <Button size="small" icon={<CopyOutlined />} onClick={() => handleApply(r)}>套用</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openModal(r)}>编辑</Button>
          <Button size="small" icon={<CopyOutlined />} onClick={() => handleDuplicate(r)}>复制</Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Title level={4}>报关单模板</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        保存常用的报关单配置，下次一键套用
      </Text>

      <Card size="small">
        <div style={{ marginBottom: 12 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>新建模板</Button>
        </div>
        <Spin spinning={loading}>
          <Table dataSource={templates} columns={columns} rowKey="id" pagination={false} size="small" />
          {templates.length === 0 && !loading && (
            <div style={{ textAlign: 'center', color: '#ccc', padding: 40 }}>
              暂无模板，点击「新建模板」创建
            </div>
          )}
        </Spin>
      </Card>

      {/* 新建/编辑弹窗 */}
      <Modal
        title={editingTemplate ? '编辑模板' : '新建模板'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        width={560}
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item label="模板名称" name="name" rules={[{ required: true, message: '请输入模板名称' }]}>
            <Input placeholder="如：一般贸易出口美国" />
          </Form.Item>
          <Form.Item label="说明" name="description">
            <Input placeholder="模板用途说明" />
          </Form.Item>
          <Form.Item label="申报模式" name="customsMode" initialValue="normal">
            <Select options={MODES.map(m => ({ value: m.value, label: m.label }))} />
          </Form.Item>
          <Form.Item label="进出口商" name="importerExporter">
            <Input placeholder="默认进出口企业名称" />
          </Form.Item>
          <Form.Item label="入境口岸" name="portOfEntry">
            <Input placeholder="如 上海外高桥" />
          </Form.Item>
          <Form.Item label="运输方式" name="transportMode">
            <Select allowClear options={[{ value: '海运', label: '海运' }, { value: '空运', label: '空运' }, { value: '陆运', label: '陆运' }]} />
          </Form.Item>
          <Form.Item label="贸易条款" name="tradeTerms">
            <Select allowClear options={[{ value: 'CIF', label: 'CIF' }, { value: 'FOB', label: 'FOB' }, { value: 'EXW', label: 'EXW' }]} />
          </Form.Item>
          <Form.Item label="币种" name="currency" initialValue="USD">
            <Select options={[{ value: 'USD', label: 'USD' }, { value: 'EUR', label: 'EUR' }, { value: 'CNY', label: 'CNY' }]} />
          </Form.Item>
          <Form.Item label="随附单证" name="documents">
            <Input placeholder="如 商业发票,装箱单,提单" />
          </Form.Item>

          {/* 跨境电商专有字段 */}
          <Form.Item label="电商平台" name="ecommercePlatform" noStyle>
            <Input style={{ display: 'none' }} />
          </Form.Item>
          <Form.Item label="物流方式" name="deliveryMethod" noStyle>
            <Input style={{ display: 'none' }} />
          </Form.Item>
          <Form.Item label="收货人证件类型" name="receiverIdType" noStyle>
            <Input style={{ display: 'none' }} />
          </Form.Item>
          <Form.Item label="B2B平台" name="b2bPlatform" noStyle>
            <Input style={{ display: 'none' }} />
          </Form.Item>
          <Form.Item label="B2B订单号" name="b2bOrderNo" noStyle>
            <Input style={{ display: 'none' }} />
          </Form.Item>
          <Form.Item label="海外仓地址" name="warehouseAddress" noStyle>
            <Input style={{ display: 'none' }} />
          </Form.Item>
          <Form.Item label="海外仓代码" name="warehouseCode" noStyle>
            <Input style={{ display: 'none' }} />
          </Form.Item>
          <Form.Item label="市场名称" name="marketName" noStyle>
            <Input style={{ display: 'none' }} />
          </Form.Item>
          <Form.Item label="市场代码" name="marketCode" noStyle>
            <Input style={{ display: 'none' }} />
          </Form.Item>
          <Form.Item label="供应商名称" name="supplierName" noStyle>
            <Input style={{ display: 'none' }} />
          </Form.Item>
          <Form.Item label="供应商代码" name="supplierCode" noStyle>
            <Input style={{ display: 'none' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 套用弹窗 */}
      <Modal
        title="套用模板"
        open={applyModalOpen}
        onCancel={() => setApplyModalOpen(false)}
        footer={[
          <Button key="close" onClick={() => setApplyModalOpen(false)}>关闭</Button>,
          <Button key="go" type="primary" onClick={() => {
            if (applyTemplate) {
              // 增加使用次数
              const updated = templates.map(t =>
                t.id === applyTemplate.id ? { ...t, useCount: (t.useCount || 0) + 1, updatedAt: new Date().toISOString() } : t
              );
              saveTemplates(updated);
              setApplyModalOpen(false);
              message.success('已套用模板「' + (applyTemplate?.name || '') + '」，前往报关单页面');
            }
          }}>
            确认套用
          </Button>,
        ]}
      >
        {applyTemplate && (
          <div>
            <p><strong>模板：</strong>{applyTemplate.name}</p>
            <p><strong>模式：</strong>{applyTemplate.customsMode}</p>
            <p><strong>配置内容：</strong></p>
            <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, fontSize: 12 }}>
              {JSON.stringify(applyTemplate.config, null, 2)}
            </pre>
            <p><Text type="secondary">套用后会自动填充到报关单表单</Text></p>
          </div>
        )}
      </Modal>
    </div>
  );
}
