import React, { useState, useEffect, useCallback } from 'react';
import { Timeline, Tag, Spin, Empty, Button, Space, Descriptions, Alert, Tooltip } from 'antd';
import {
  FileTextOutlined, FormOutlined, InboxOutlined, AuditOutlined,
  FileProtectOutlined, SendOutlined, ReloadOutlined, FolderOpenOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
});

interface TimelineEvent {
  time: string;
  source: 'document' | 'declaration' | 'batch_group' | 'audit';
  type: string;
  title: string;
  status?: string | null;
  refId?: string;
  meta?: any;
}

interface TimelineSummary {
  currentStatus: string;
  documentCount: number;
  declarationCount: number;
  batchGroupCount: number;
  hasXmlSnapshot: boolean;
  archived: boolean;
  operationCount: number;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
}

interface TimelineData {
  billOfLading: string;
  summary: TimelineSummary;
  timeline: TimelineEvent[];
}

const sourceMeta: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  document: { color: 'blue', icon: <FileTextOutlined />, label: '单证' },
  declaration: { color: 'purple', icon: <FormOutlined />, label: '申报' },
  batch_group: { color: 'cyan', icon: <InboxOutlined />, label: '流水线' },
  audit: { color: 'gray', icon: <AuditOutlined />, label: '操作' },
};

// 按事件类型细化图标 / 颜色
function dotFor(ev: TimelineEvent): { color: string; icon: React.ReactNode } {
  switch (ev.type) {
    case 'xml_snapshot': return { color: 'geekblue', icon: <FileProtectOutlined /> };
    case 'declared': return { color: 'green', icon: <SendOutlined /> };
    case 'archived': case 'batch_group_archived': return { color: 'green', icon: <FolderOpenOutlined /> };
    case 'declaration_status': return { color: 'orange', icon: <ReloadOutlined /> };
    default: {
      const m = sourceMeta[ev.source] || sourceMeta.audit;
      return { color: m.color, icon: m.icon };
    }
  }
}

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString('zh-CN') : '-');

export default function BillOfLadingTimeline({ blNo, active = true }: { blNo: string; active?: boolean }) {
  const [data, setData] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    if (!blNo) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/declaration/bill-of-lading/' + encodeURIComponent(blNo) + '/timeline');
      if (res.data?.success) setData(res.data.data);
      else setError(res.data?.error || '获取时间线失败');
    } catch (e: any) {
      setError(e?.response?.data?.error || '获取时间线失败');
    } finally {
      setLoading(false);
    }
  }, [blNo]);

  useEffect(() => { if (active && blNo) load(); }, [active, blNo, load]);

  // 节点上的「一键跳转」——把分散的功能串起来
  const actionFor = (ev: TimelineEvent): React.ReactNode => {
    const bl = encodeURIComponent(blNo);
    if (ev.source === 'batch_group' && (ev.type === 'xml_snapshot' || ev.type === 'declared' || ev.type === 'archived')) {
      return <Button type="link" size="small" icon={<FolderOpenOutlined />}
        onClick={() => navigate('/dashboard/archive-search?q=' + bl)}>调档 / 报文</Button>;
    }
    if (ev.source === 'audit') {
      return <Button type="link" size="small" icon={<AuditOutlined />}
        onClick={() => navigate('/dashboard/audit-logs?q=' + bl)}>查看操作日志</Button>;
    }
    if (ev.source === 'document') {
      return <Button type="link" size="small" icon={<FileTextOutlined />}
        onClick={() => navigate('/dashboard/bl-check?bl=' + bl)}>单证核对</Button>;
    }
    return null;
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px 0' }}><Spin tip="加载全流程轨迹…" /></div>;
  }
  if (error) {
    return <Alert type="warning" showIcon message={error}
      action={<Button size="small" onClick={load}>重试</Button>} />;
  }
  if (!data || data.timeline.length === 0) {
    return <Empty description="该提单号暂无流程记录" />;
  }

  const s = data.summary;

  const items = data.timeline.map((ev) => {
    const { color, icon } = dotFor(ev);
    const sm = sourceMeta[ev.source] || sourceMeta.audit;
    return {
      color,
      dot: icon,
      children: (
        <div>
          <Space size={8} align="center" wrap>
            <span style={{ color: 'rgba(0,0,0,.45)', fontSize: 12 }}>{fmt(ev.time)}</span>
            <Tag color={sm.color} style={{ marginInlineEnd: 0 }}>{sm.label}</Tag>
            <span style={{ fontWeight: 500 }}>{ev.title}</span>
            {ev.status && <Tag bordered={false}>{ev.status}</Tag>}
            {actionFor(ev)}
          </Space>
          {ev.meta?.operatorId && (
            <div style={{ color: 'rgba(0,0,0,.45)', fontSize: 12, marginTop: 2 }}>
              操作人 {ev.meta.operatorId}{ev.meta.ip ? ' · ' + ev.meta.ip : ''}
            </div>
          )}
        </div>
      ),
    };
  });

  return (
    <div>
      <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="当前状态">
          <Tag color="processing">{s.currentStatus}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="单证">{s.documentCount} 份</Descriptions.Item>
        <Descriptions.Item label="报关单">{s.declarationCount} 票</Descriptions.Item>
        <Descriptions.Item label="批次">{s.batchGroupCount} 个</Descriptions.Item>
        <Descriptions.Item label="报文快照">
          {s.hasXmlSnapshot
            ? <Tooltip title="已生成申报报文快照，可在调档检索"><Tag color="green">已留痕</Tag></Tooltip>
            : <Tag>无</Tag>}
        </Descriptions.Item>
        <Descriptions.Item label="归档">
          {s.archived ? <Tag color="green">已归档</Tag> : <Tag>未归档</Tag>}
        </Descriptions.Item>
        <Descriptions.Item label="操作记录">{s.operationCount} 条</Descriptions.Item>
        <Descriptions.Item label="首次活动">{fmt(s.firstActivityAt)}</Descriptions.Item>
        <Descriptions.Item label="最近活动">{fmt(s.lastActivityAt)}</Descriptions.Item>
      </Descriptions>

      <Space style={{ marginBottom: 12 }}>
        <Button size="small" icon={<FolderOpenOutlined />}
          onClick={() => navigate('/dashboard/archive-search?q=' + encodeURIComponent(blNo))}>
          调档检索本票
        </Button>
        <Button size="small" icon={<AuditOutlined />}
          onClick={() => navigate('/dashboard/audit-logs?q=' + encodeURIComponent(blNo))}>
          本票操作日志
        </Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </Space>

      <Timeline mode="left" items={items} />
    </div>
  );
}
