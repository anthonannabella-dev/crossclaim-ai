import { useState, useEffect, useCallback } from 'react';
import { Card, Table, Input, Select, DatePicker, Button, Space, Tag, Typography, message } from 'antd';
import { SearchOutlined, ReloadOutlined, SafetyOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

interface Log {
  id: string; action: string; detail: string;
  operatorId: string | null; ip: string | null; createdAt: string | null;
}

// 动作代码 → 可读标签 + 颜色
const ACTION_META: Record<string, { label: string; color: string }> = {
  apply_tariff_route: { label: '回写税率路径', color: 'geekblue' },
  archive_download_xml: { label: '调档下载报文', color: 'blue' },
  archive_preview_xml: { label: '调档预览报文', color: 'cyan' },
  archive_export_package: { label: '导出归档整包', color: 'purple' },
  batch_group_archived: { label: '结关归档', color: 'green' },
  sub_account_created: { label: '新建子账号', color: 'gold' },
  sub_account_deleted: { label: '删除子账号', color: 'red' },
  tenant_profile_updated: { label: '修改企业资料', color: 'default' },
};
const meta = (a: string) => ACTION_META[a] || { label: a, color: 'default' };

export default function AuditLogPage() {
  const [rows, setRows] = useState<Log[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [actions, setActions] = useState<string[]>([]);
  const [action, setAction] = useState<string | undefined>();
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get('q') || '');
  const [range, setRange] = useState<[any, any] | null>(null);
  const PAGE_SIZE = 20;

  const token = localStorage.getItem('token');
  const api = axios.create({ baseURL: '/api', headers: { Authorization: 'Bearer ' + token } });

  const fetchLogs = useCallback(async (toPage?: number) => {
    const p = toPage ?? page;
    setLoading(true);
    try {
      const params: any = { page: String(p), pageSize: String(PAGE_SIZE) };
      if (action) params.action = action;
      if (q.trim()) params.q = q.trim();
      if (range && range[0]) params.from = range[0].format('YYYY-MM-DD');
      if (range && range[1]) params.to = range[1].format('YYYY-MM-DD');
      const res = await api.get('/tenant/audit-logs', { params });
      if (res.data.success) {
        setRows(res.data.data); setTotal(res.data.total); setPage(p);
        if (res.data.actions) setActions(res.data.actions);
      }
    } catch (err: any) {
      message.error('查询失败: ' + (err.response?.data?.error || err.message));
    } finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, q, range, page]);

  useEffect(() => { fetchLogs(1); /* eslint-disable-next-line */ }, []);

  const reset = () => { setAction(undefined); setQ(''); setRange(null); setTimeout(() => fetchLogs(1), 0); };

  const columns = [
    { title: '时间', dataIndex: 'createdAt', key: 't', width: 170, render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
    { title: '操作', dataIndex: 'action', key: 'a', width: 140, render: (v: string) => { const m = meta(v); return <Tag color={m.color}>{m.label}</Tag>; } },
    { title: '详情', dataIndex: 'detail', key: 'd', ellipsis: true, render: (v: string) => <Text style={{ fontSize: 13 }}>{v}</Text> },
    { title: '操作者', dataIndex: 'operatorId', key: 'o', width: 100, render: (v: string) => v ? <Text code>{v.slice(0, 8)}</Text> : <Text type="secondary">主账号</Text> },
    { title: 'IP', dataIndex: 'ip', key: 'ip', width: 130, render: (v: string) => v || '-' },
  ];

  return (
    <div>
      <Title level={4} style={{ marginTop: 0 }}><SafetyOutlined /> 操作日志</Title>
      <Text type="secondary">记录回写税率、调档下载/预览、整包导出、归档、账号变更等敏感操作，供管理与海关稽查追溯。</Text>

      <Card size="small" style={{ marginTop: 16, marginBottom: 16 }}>
        <Space wrap>
          <Select
            allowClear placeholder="操作类型" style={{ width: 170 }}
            value={action} onChange={(v) => setAction(v)}
            options={actions.map((a) => ({ value: a, label: meta(a).label }))}
          />
          <Input
            placeholder="关键词(提单号/报关单号…)" value={q}
            onChange={(e) => setQ(e.target.value)} onPressEnter={() => fetchLogs(1)}
            allowClear style={{ width: 240 }} prefix={<SearchOutlined />}
          />
          <RangePicker value={range as any} onChange={(v) => setRange(v as any)} placeholder={['起', '止']} />
          <Button type="primary" icon={<SearchOutlined />} onClick={() => fetchLogs(1)}>查询</Button>
          <Button icon={<ReloadOutlined />} onClick={reset}>重置</Button>
        </Space>
      </Card>

      <Table
        rowKey="id" loading={loading} dataSource={rows} columns={columns}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, showTotal: (t) => '共 ' + t + ' 条', onChange: (p) => fetchLogs(p) }}
        locale={{ emptyText: '暂无操作日志' }}
        scroll={{ x: 900 }}
      />
    </div>
  );
}