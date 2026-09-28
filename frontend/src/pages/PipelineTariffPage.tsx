import { useState, useEffect } from 'react';
import {
  Card, Select, Table, Tag, Button, Space, Typography, message, Empty,
  Statistic, Row, Col, Modal, Descriptions, List, Alert, Spin,
} from 'antd';
import { ThunderboltOutlined, ReloadOutlined, BranchesOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Title, Text } = Typography;

interface CtxItem {
  lineNo: number | null; hsCode: string; description: string;
  quantity: number | null; totalPrice: number | null; originCountry: string;
  mfnRate: number | null; ftaRate: number | null; ftaName: string | null; saving: number | null;
}
interface Ctx {
  id: string; billOfLading: string; status: string;
  destinationCountry: string; destinationCode: string;
  tradeTerms: string; currency: string; itemCount: number; items: CtxItem[];
}

const STATUS_LABEL: Record<string, string> = {
  auto_filled: '已填制', pending_review: '待复核', checked: '已预检',
  declared: '已申报', released: '已放行', completed: '已结关',
};

export default function PipelineTariffPage() {
  const [groups, setGroups] = useState<any[]>([]);
  const [selId, setSelId] = useState<string | undefined>();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [compare, setCompare] = useState<any>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareItem, setCompareItem] = useState<CtxItem | null>(null);
  const [applying, setApplying] = useState(false);

  const token = localStorage.getItem('token');
  const api = axios.create({ baseURL: '/api', headers: { Authorization: 'Bearer ' + token } });

  const loadGroups = async () => {
    setListLoading(true);
    try {
      const res = await api.get('/batch-group', { params: { pageSize: '100' } });
      if (res.data.success) {
        // 只列已富化(有报关单)的票
        const usable = res.data.data.filter((g: any) =>
          ['auto_filled', 'pending_review', 'checked', 'declared', 'released', 'completed'].includes(g.status));
        setGroups(usable);
      }
    } catch (err: any) {
      message.error('加载流水线票据失败: ' + (err.response?.data?.error || err.message));
    } finally { setListLoading(false); }
  };
  useEffect(() => { loadGroups(); /* eslint-disable-next-line */ }, []);

  const loadCtx = async (id: string) => {
    setLoading(true); setCtx(null);
    try {
      const res = await api.get('/batch-group/' + id + '/tariff-context');
      if (res.data.success) setCtx(res.data.data);
    } catch (err: any) {
      message.error('带入失败: ' + (err.response?.data?.error || err.message));
    } finally { setLoading(false); }
  };

  const onPick = (id: string) => { setSelId(id); loadCtx(id); };

  const deepCompare = async (item: CtxItem) => {
    if (!ctx?.destinationCode) {
      message.warning('该票未识别目的国代码，无法做最优路径比对（可在「原产地判定」页手动比对）');
      return;
    }
    setCompareLoading(true); setCompare(null); setCompareItem(item);
    try {
      const res = await api.post('/origin/compare', {
        hsCode: item.hsCode,
        destinationCountry: ctx.destinationCode,
      });
      setCompare(res.data?.data || res.data);
    } catch (err: any) {
      message.error('比对失败: ' + (err.response?.data?.error || err.message));
    } finally { setCompareLoading(false); }
  };

  // 回写报关单:把选定路径写回对应商品项
  const applyRoute = async (route: any) => {
    if (!ctx || !compareItem) return;
    setApplying(true);
    try {
      const res = await api.post('/batch-group/' + ctx.id + '/apply-tariff-route', {
        lineNo: compareItem.lineNo,
        hsCode: compareItem.hsCode,
        ftaName: route.ftaShortName,
        ftaRate: route.tariffRate,
      });
      if (res.data.success) {
        const pc = res.data.data.preCheck;
        message.success('已将「' + route.ftaShortName + ' ' + fmtRate(route.tariffRate) + '」回写到报关单'
          + (pc ? ' · 回写后预检' + (pc.passed ? '通过' : '未通过') + '(' + pc.score + '分'
              + (pc.errorCount ? '，' + pc.errorCount + '处错误' : '') + ')' : ''));
        setCompare(null);
        loadCtx(ctx.id); // 刷新带入结果
      }
    } catch (err: any) {
      message.error('回写失败: ' + (err.response?.data?.error || err.message));
    } finally { setApplying(false); }
  };

  const fmtRate = (r: number | null) => r == null ? '—' : r + '%';
  const totalSaving = ctx?.items.reduce((s, it) =>
    s + ((it.saving != null && it.totalPrice != null) ? (it.saving / 100) * it.totalPrice : 0), 0) || 0;

  const columns = [
    { title: '项', dataIndex: 'lineNo', key: 'lineNo', width: 50, render: (v: number) => v ?? '-' },
    { title: 'HS编码', dataIndex: 'hsCode', key: 'hsCode', width: 130, render: (v: string) => v ? <Text strong>{v}</Text> : <Text type="secondary">未归类</Text> },
    { title: '品名', dataIndex: 'description', key: 'description', ellipsis: true },
    { title: 'MFN税率', dataIndex: 'mfnRate', key: 'mfnRate', width: 90, render: fmtRate },
    {
      title: '最优FTA', key: 'fta', width: 160,
      render: (_: any, r: CtxItem) => r.ftaName
        ? <Space size={4}><Tag color="green">{r.ftaName}</Tag><Text>{fmtRate(r.ftaRate)}</Text></Space>
        : <Text type="secondary">无适用/未富化</Text>,
    },
    {
      title: '省', key: 'saving', width: 90,
      render: (_: any, r: CtxItem) => r.saving != null && r.saving > 0
        ? <Tag color="red">省 {r.saving}个点</Tag>
        : <Text type="secondary">—</Text>,
    },
    {
      title: '操作', key: 'op', width: 110,
      render: (_: any, r: CtxItem) => (
        <Button size="small" icon={<BranchesOutlined />} disabled={!r.hsCode} onClick={() => deepCompare(r)}>深度比对</Button>
      ),
    },
  ];

  return (
    <div>
      <Title level={5} style={{ marginTop: 0 }}><ThunderboltOutlined /> 从流水线带入</Title>
      <Text type="secondary">选择一票已上传并自动填制的流水线票据，直接带出每个商品项的 MFN 与最优 FTA 税率，无需手输。</Text>

      <Card size="small" style={{ marginTop: 16, marginBottom: 16 }}>
        <Space wrap>
          <Select
            style={{ width: 360 }}
            placeholder="选择流水线票据（提运单号）"
            loading={listLoading}
            value={selId}
            onChange={onPick}
            showSearch
            optionFilterProp="label"
            options={groups.map((g) => ({
              value: g.id,
              label: (g.billOfLading || g.id.slice(0, 8)) + ' · ' + (STATUS_LABEL[g.status] || g.status),
            }))}
            notFoundContent={listLoading ? <Spin size="small" /> : '暂无可用票据'}
          />
          <Button icon={<ReloadOutlined />} onClick={loadGroups}>刷新列表</Button>
        </Space>
      </Card>

      {loading && <Card size="small"><Spin /> <Text type="secondary">正在带入…</Text></Card>}

      {ctx && !loading && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}><Statistic title="提运单号" value={ctx.billOfLading || '-'} /></Col>
            <Col span={6}><Statistic title="目的国" value={(ctx.destinationCountry || '-') + (ctx.destinationCode ? ' (' + ctx.destinationCode + ')' : '')} /></Col>
            <Col span={6}><Statistic title="商品项" value={ctx.itemCount} suffix="项" /></Col>
            <Col span={6}><Statistic title="走最优FTA预计可省" value={totalSaving.toFixed(0)} prefix="¥" valueStyle={{ color: '#cf1322' }} /></Col>
          </Row>
          {!ctx.destinationCode && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }}
              message="该票未识别出目的国代码，最优税率路径的「深度比对」不可用；MFN/已富化的最优 FTA 仍正常显示。" />
          )}
          <Table rowKey={(r) => String(r.lineNo) + r.hsCode} dataSource={ctx.items} columns={columns} pagination={false} size="small"
            locale={{ emptyText: <Empty description="该票暂无商品项（可能尚未完成自动填制）" /> }} />
        </>
      )}

      <Modal
        open={!!compare || compareLoading}
        title="最优税率路径 · 深度比对"
        onCancel={() => setCompare(null)}
        footer={[<Button key="c" onClick={() => setCompare(null)}>关闭</Button>]}
        confirmLoading={compareLoading}
        width={680}
      >
        {compare && (
          <>
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 12 }}>
              <Descriptions.Item label="HS编码">{compare.hsCode}</Descriptions.Item>
              <Descriptions.Item label="目的国">{compare.destinationName || compare.destinationCountry}</Descriptions.Item>
              <Descriptions.Item label="MFN税率">{fmtRate(compare.mfnRate)}</Descriptions.Item>
              <Descriptions.Item label="最优路径">
                {compare.bestRoute
                  ? <Tag color="green">{compare.bestRoute.ftaShortName} {fmtRate(compare.bestRoute.tariffRate)}</Tag>
                  : <Text type="secondary">无适用FTA</Text>}
              </Descriptions.Item>
            </Descriptions>
            <Text strong>各路径对比</Text>
            <Table
              size="small" rowKey="ftaShortName" pagination={false} style={{ marginTop: 8, marginBottom: 12 }}
              dataSource={compare.routes || []}
              columns={[
                { title: 'FTA', dataIndex: 'ftaShortName', key: 'fta' },
                { title: '协定税率', dataIndex: 'tariffRate', key: 'rate', render: (v: number) => fmtRate(v) },
                { title: '原产规则', dataIndex: 'ruleType', key: 'rule', render: (v: string, r: any) => v + (r.rvcThreshold ? ' (RVC≥' + r.rvcThreshold + '%)' : '') },
                {
                  title: '应用', key: 'apply', width: 90,
                  render: (_: any, r: any) => (
                    <Button size="small" type="link" loading={applying} onClick={() => applyRoute(r)}>回写报关单</Button>
                  ),
                },
              ]}
            />
            {compare.bestRoute?.certificates?.length > 0 && (
              <>
                <Text strong>最优路径所需单证</Text>
                <List size="small" dataSource={compare.bestRoute.certificates}
                  renderItem={(c: any) => (
                    <List.Item>
                      <Space><Tag color={c.required ? 'red' : 'default'}>{c.required ? '必备' : '建议'}</Tag>
                        <Text>{c.name}</Text><Text type="secondary">{c.description}</Text></Space>
                    </List.Item>
                  )} />
              </>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}