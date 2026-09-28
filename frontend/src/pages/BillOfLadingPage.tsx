import React, { useState, useEffect } from 'react';
import { Table, Card, Tag, Statistic, Row, Col, Space, Input, Modal, Descriptions, Empty, message, Button, Tooltip, Tabs } from 'antd';
import { SearchOutlined, AuditOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { ColumnsType } from 'antd/es/table';
import axios from 'axios';
import BillOfLadingTimeline from '../components/BillOfLadingTimeline';

interface BlGroupSummary {
  billOfLading: string;
  declarationCount: number;
  totalValue: number;
  currency: string;
  statuses: string[];
  customsModes: string[];
  firstCreated: string;
  lastUpdated: string;
  declarations: Array<{
    id: string;
    declarationNo: string | null;
    status: string;
    customsMode: string;
    totalValue: number;
    currency: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

const statusColorMap: Record<string, string> = {
  draft: 'default', submitted: 'processing', rejected: 'error',
  resubmitted: 'warning', completed: 'success',
};

const statusLabelMap: Record<string, string> = {
  draft: '草稿', submitted: '已提交', rejected: '已退单',
  resubmitted: '已重报', completed: '已完成',
};

const modeLabelMap: Record<string, string> = {
  normal: '一般贸易', '9610': '跨境电商直邮', '9710': '跨境电商B2B',
  '9810': '跨境电商海外仓', '1039': '市场采购贸易', '1210': '保税电商', '1239': '保税电商A',
};

const api = axios.create({
  baseURL: '/api',
  headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
});

export default function BillOfLadingPage() {
  const [groups, setGroups] = useState<BlGroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [detailVisible, setDetailVisible] = useState(false);
  const [selected, setSelected] = useState<BlGroupSummary | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get('/declaration/bill-of-lading/list');
      if (res.data.success) setGroups(Array.isArray(res.data.data) ? res.data.data : []);
    } catch { message.error('获取提运单列表失败'); }
    setLoading(false);
  };

  const filtered = search
    ? groups.filter(g => (g.billOfLading || '').toLowerCase().includes(search.toLowerCase()))
    : groups;

  const totalBL = groups.length;
  const totalDeclarations = groups.reduce((s, g) => s + (g.declarationCount || 0), 0);
  // 按币种分别汇总，避免不同币种被错误相加并误标 USD
  const valueByCurrency = groups.reduce<Record<string, number>>((acc, g) => {
    const cur = g.currency || 'USD';
    acc[cur] = (acc[cur] || 0) + (g.totalValue || 0);
    return acc;
  }, {});
  const currencyEntries = Object.entries(valueByCurrency);
  const singleCurrency = currencyEntries.length <= 1;
  const totalValueText = currencyEntries.length === 0
    ? '0.00'
    : currencyEntries.map(([c, v]) => Number(v || 0).toFixed(2) + ' ' + c).join(' · ');

  const columns: ColumnsType<BlGroupSummary> = [
    {
      title: '提运单号', dataIndex: 'billOfLading', key: 'billOfLading',
      render: (bl: string) => (
        <a onClick={() => { setSelected(groups.find(g => g.billOfLading === bl) || null); setDetailVisible(true); }}>
          {bl}
        </a>
      ),
    },
    { title: '报关单数', dataIndex: 'declarationCount', key: 'declarationCount', width: 100,
      sorter: (a, b) => (a.declarationCount || 0) - (b.declarationCount || 0) },
    { title: '总金额', dataIndex: 'totalValue', key: 'totalValue', width: 120,
      render: (v: number, r: BlGroupSummary) => Number(v || 0).toFixed(2) + ' ' + (r.currency || ''),
      sorter: (a, b) => (a.totalValue || 0) - (b.totalValue || 0) },
    { title: '申报模式', dataIndex: 'customsModes', key: 'customsModes', width: 160,
      render: (modes: string[]) => (
        <Space size={4} wrap>{modes.map(m => <Tag key={m}>{modeLabelMap[m] || m}</Tag>)}</Space>
      ),
    },
    { title: '状态', dataIndex: 'statuses', key: 'statuses', width: 160,
      render: (sts: string[]) => (
        <Space size={4} wrap>{sts.map(s => (
          <Tag key={s} color={statusColorMap[s] || 'default'}>{statusLabelMap[s] || s}</Tag>
        ))}</Space>
      ),
    },
    { title: '最近更新', dataIndex: 'lastUpdated', key: 'lastUpdated', width: 160,
      render: (d: string) => d ? new Date(d).toLocaleString('zh-CN') : '-',
      sorter: (a, b) => (a.lastUpdated || '').localeCompare(b.lastUpdated || ''),
      defaultSortOrder: 'descend' },
    { title: '操作', key: 'actions', width: 110, fixed: 'right' as const,
      render: (_: any, r: BlGroupSummary) => (
        <Tooltip title="跳转到该提单的单证一致性核对">
          <Button size="small" icon={<AuditOutlined />}
            onClick={() => navigate('/dashboard/bl-check?bl=' + encodeURIComponent(r.billOfLading))}>
            核对
          </Button>
        </Tooltip>
      ),
    },
  ];

  return (
    <div>
      <Card>
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}><Statistic title="提运单数" value={totalBL} suffix="个" /></Col>
          <Col span={6}><Statistic title="关联报关单" value={totalDeclarations} suffix="票" /></Col>
          <Col span={6}>
            {singleCurrency ? (
              <Statistic title="总货值" value={currencyEntries[0]?.[1] ?? 0} precision={2} suffix={currencyEntries[0]?.[0] || ''} />
            ) : (
              <Tooltip title={'各币种合计：' + totalValueText}>
                <div>
                  <div style={{ color: 'rgba(0,0,0,.45)', fontSize: 14 }}>总货值（多币种）</div>
                  <div style={{ fontSize: 18, fontWeight: 500 }}>{totalValueText}</div>
                </div>
              </Tooltip>
            )}
          </Col>
          <Col span={6}>
            <Input prefix={<SearchOutlined />} placeholder="搜索提运单号"
              value={search} onChange={e => setSearch(e.target.value)} allowClear />
          </Col>
        </Row>
        <Table columns={columns} dataSource={filtered} rowKey="billOfLading"
          loading={loading} pagination={{ pageSize: 20, showTotal: (t) => '共 ' + t + ' 个提运单' }}
          locale={{ emptyText: <Empty description="暂无提运单数据" /> }} />
      </Card>

      <Modal title={'提运单 - ' + (selected?.billOfLading || '')}
        open={detailVisible} onCancel={() => setDetailVisible(false)} footer={null} width={860}>
        {selected && (
          <Tabs
            defaultActiveKey="overview"
            items={[
              {
                key: 'overview',
                label: '概览',
                children: (
                  <>
                    <Descriptions column={2} bordered size="small" style={{ marginBottom: 16 }}>
                      <Descriptions.Item label="提运单号">{selected.billOfLading}</Descriptions.Item>
                      <Descriptions.Item label="报关单数">{selected.declarationCount} 票</Descriptions.Item>
                      <Descriptions.Item label="总货值">{Number(selected.totalValue || 0).toFixed(2)} {selected.currency || ''}</Descriptions.Item>
                      <Descriptions.Item label="申报模式">
                        <Space size={4} wrap>{selected.customsModes.map(m => <Tag key={m}>{modeLabelMap[m] || m}</Tag>)}</Space>
                      </Descriptions.Item>
                      <Descriptions.Item label="状态" span={2}>
                        <Space size={4} wrap>{selected.statuses.map(s => (
                          <Tag key={s} color={statusColorMap[s] || 'default'}>{statusLabelMap[s] || s}</Tag>
                        ))}</Space>
                      </Descriptions.Item>
                      <Descriptions.Item label="最早创建">{selected.firstCreated ? new Date(selected.firstCreated).toLocaleString('zh-CN') : '-'}</Descriptions.Item>
                      <Descriptions.Item label="最近更新">{selected.lastUpdated ? new Date(selected.lastUpdated).toLocaleString('zh-CN') : '-'}</Descriptions.Item>
                    </Descriptions>
                    <h4 style={{ marginBottom: 12 }}>关联报关单</h4>
                    <Table dataSource={selected.declarations} rowKey="id" pagination={false} size="small"
                      columns={[
                        { title: '报关单号', dataIndex: 'declarationNo', key: 'declarationNo', render: (v: string | null) => v || '-' },
                        { title: '模式', dataIndex: 'customsMode', key: 'customsMode', width: 100, render: (m: string) => <Tag>{modeLabelMap[m] || m}</Tag> },
                        { title: '状态', dataIndex: 'status', key: 'status', width: 80, render: (s: string) => <Tag color={statusColorMap[s] || 'default'}>{statusLabelMap[s] || s}</Tag> },
                        { title: '金额', dataIndex: 'totalValue', key: 'totalValue', width: 100, render: (v: number, r: any) => Number(v || 0).toFixed(2) + ' ' + (r.currency || '') },
                        { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 150, render: (d: string) => d ? new Date(d).toLocaleString('zh-CN') : '-' },
                      ]} />
                  </>
                ),
              },
              {
                key: 'timeline',
                label: '全流程轨迹',
                children: <BillOfLadingTimeline blNo={selected.billOfLading} active={detailVisible} />,
              },
            ]}
          />
        )}
      </Modal>
    </div>
  );
}
