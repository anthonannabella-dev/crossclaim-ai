import { useState, useEffect, useCallback } from 'react';
import { Row, Col, Card, Table, Button, Input, Form, InputNumber, Select, message, Spin, Tag, Typography } from 'antd';
import { SearchOutlined, DownOutlined, UpOutlined } from '@ant-design/icons';
// @ant-design/charts removed due to compatibility

const { Title } = Typography;

// ---- Types ----
interface RebateItem {
  id: string;
  hsCode: string;
  description: string;
  quantity: number;
  unit: string;
  fobAmount: number;
  taxRate: number;       // 退税率 %
  rebateAmount: number;  // 应退税额
  nonRebateAmount: number; // 不退税额
  createdAt: string;
}

interface RebateHistory {
  month: string;
  totalRebate: number;
  count: number;
}

interface HsRateInfo {
  hsCode: string;
  description: string;
  exportRate: number | null;  // 退税率 %
  vatRate: number | null;     // 征税率（增值税）
  supervision: string | null;
}

export default function TaxRebatePage() {
  const [form] = Form.useForm();
  const [history, setHistory] = useState<RebateItem[]>([]);
  const [historyTrend, setHistoryTrend] = useState<RebateHistory[]>([]);
  const [hsSearch, setHsSearch] = useState('');
  const [hsResult, setHsResult] = useState<HsRateInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [expandedRows, setExpandedRows] = useState<string[]>([]);

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  // 加载历史
  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tax-rebate/history', { headers });
      const json = await res.json();
      const list: RebateItem[] = json.data || json || [];
      setHistory(list);

      // 生成趋势数据
      const trendMap: Record<string, { totalRebate: number; count: number }> = {};
      list.forEach(item => {
        const month = item.createdAt?.slice(0, 7) || '未知';
        if (!trendMap[month]) trendMap[month] = { totalRebate: 0, count: 0 };
        trendMap[month].totalRebate += item.rebateAmount || 0;
        trendMap[month].count += 1;
      });
      setHistoryTrend(
        Object.entries(trendMap)
          .map(([month, d]) => ({ month, totalRebate: d.totalRebate, count: d.count }))
          .sort((a, b) => a.month.localeCompare(b.month))
      );
    } catch {
      message.error('加载退税历史失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  // HS退税率速查
  const handleHsSearch = async () => {
    if (!hsSearch.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/hscode/search?q=${encodeURIComponent(hsSearch)}`, { headers });
      const json = await res.json();
      const list = json.data || json || [];
      const found = list.find((h: any) => h.hsCode === hsSearch || h.code === hsSearch) || list[0];
      if (found) {
        setHsResult({
          hsCode: found.hsCode || found.code || '',
          description: found.description || found.name || '',
          exportRate: found.exportRate ?? found.exportRebateRate ?? null,
          vatRate: found.vatRate ?? null,
          supervision: found.supervision ?? null,
        });
      } else {
        message.warning('未找到该HS编码');
        setHsResult(null);
      }
    } catch {
      message.error('查询失败');
    } finally {
      setSearching(false);
    }
  };

  // 退税计算
  const handleCalculate = async (values: any) => {
    setCalculating(true);
    try {
      const res = await fetch('/api/tax-rebate/calculate', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (json.success || json.data) {
        message.success('计算完成');
        fetchHistory();
      } else {
        message.error(json.error || '计算失败');
      }
    } catch {
      message.error('计算请求失败');
    } finally {
      setCalculating(false);
    }
  };

  // 展开/收起详情
  const toggleExpand = (id: string) => {
    setExpandedRows(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  // 异常判断
  const isAbnormal = (item: RebateItem) => !item.rebateAmount || item.rebateAmount <= 0;

  const columns = [
    { title: 'HS编码', dataIndex: 'hsCode', key: 'hsCode', width: 100 },
    { title: '商品描述', dataIndex: 'description', key: 'description', ellipsis: true },
    { title: '数量', dataIndex: 'quantity', key: 'quantity', width: 80 },
    { title: 'FOB总额', dataIndex: 'fobAmount', key: 'fobAmount', width: 120, render: (v: number) => `$${v?.toLocaleString() ?? 0}` },
    { title: '退税率', dataIndex: 'taxRate', key: 'taxRate', width: 80, render: (v: number) => `${v ?? 0}%` },
    {
      title: '应退税额', dataIndex: 'rebateAmount', key: 'rebateAmount', width: 130,
      render: (v: number, r: RebateItem) => (
        <span style={{ color: isAbnormal(r) ? '#cf1322' : '#3f8600', fontWeight: 600 }}>
          ¥{v?.toLocaleString() ?? 0}
        </span>
      ),
    },
    { title: '不退税额', dataIndex: 'nonRebateAmount', key: 'nonRebateAmount', width: 130, render: (v: number) => `¥${v?.toLocaleString() ?? 0}` },
    {
      title: '操作', key: 'action', width: 80,
      render: (_: any, r: RebateItem) => (
        <Button type="link" size="small" icon={expandedRows.includes(r.id) ? <UpOutlined /> : <DownOutlined />}
          onClick={() => toggleExpand(r.id)}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Title level={4} style={{ marginBottom: 16 }}>出口退税管理</Title>

      <Row gutter={[16, 16]}>
        {/* 左侧：退税计算表单 */}
        <Col xs={24} md={12}>
          <Card title="退税计算" size="small" style={{ marginBottom: 16 }}>
            <Form form={form} layout="vertical" onFinish={handleCalculate}>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="HS编码" name="hsCode" rules={[{ required: true, message: '请输入HS编码' }]}>
                    <Input placeholder="如 8471.30" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="商品描述" name="description" rules={[{ required: true }]}>
                    <Input placeholder="商品名称" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={8}><Form.Item label="数量" name="quantity" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
                <Col span={8}><Form.Item label="单位" name="unit" rules={[{ required: true }]}><Input placeholder="台/件/个" /></Form.Item></Col>
                <Col span={8}><Form.Item label="FOB总价(USD)" name="fobAmount" rules={[{ required: true }]}><InputNumber min={0.01} step={0.01} style={{ width: '100%' }} /></Form.Item></Col>
              </Row>
              <Form.Item>
                <Button type="primary" htmlType="submit" loading={calculating} style={{ width: '100%' }}>
                  计算出口退税
                </Button>
              </Form.Item>
            </Form>
          </Card>

          {/* HS退税率速查 */}
          <Card title="退税率速查" size="small">
            <Row gutter={8}>
              <Col flex="auto">
                <Input placeholder="输入HS编码查询退税率和监管条件" value={hsSearch} onChange={e => setHsSearch(e.target.value)}
                  onPressEnter={handleHsSearch} />
              </Col>
              <Col><Button icon={<SearchOutlined />} onClick={handleHsSearch} loading={searching}>查询</Button></Col>
            </Row>
            {hsResult && (
              <div style={{ marginTop: 12, padding: 12, background: '#fafafa', borderRadius: 6 }}>
                <p><strong>HS编码：</strong>{hsResult.hsCode}</p>
                <p><strong>商品描述：</strong>{hsResult.description}</p>
                <p><strong>出口退税率：</strong>
                  <Tag color={hsResult.exportRate ? 'green' : 'red'}>{hsResult.exportRate != null ? `${hsResult.exportRate}%` : '无退税'}</Tag>
                </p>
                <p><strong>增值税率：</strong>{hsResult.vatRate != null ? `${hsResult.vatRate}%` : '未知'}</p>
                <p><strong>监管条件：</strong>{hsResult.supervision || '无'}</p>
              </div>
            )}
          </Card>
        </Col>

        {/* 右侧：历史趋势图 */}
        <Col xs={24} md={12}>
          <Card title="退税趋势" size="small" style={{ marginBottom: 16, height: 300 }}>
            {historyTrend.length > 0 ? (
              <div style={{height:220, padding:16}}>
                <div style={{display:'flex', alignItems:'flex-end', gap:2, height:180, padding:'4px 0', borderBottom:'1px solid #f0f0f0'}}>
                  {historyTrend.map((d: RebateHistory, i: number) => {
                    const max = Math.max(...historyTrend.map((x: RebateHistory) => x.totalRebate), 1);
                    return (
                      <div key={i} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:4}}>
                        <span style={{fontSize:9, color:'#d48806', fontWeight:500}}>¥{(d.totalRebate/10000).toFixed(1)}万</span>
                        <div style={{width:'100%', height:`${(d.totalRebate/max)*140}px`, background:'linear-gradient(180deg,#ffa940,#d48806)', borderRadius:'2px 2px 0 0', opacity:0.7 + (i/historyTrend.length)*0.3, minHeight:d.totalRebate>0?4:0, transition:'height 0.3s'}} />
                        <span style={{fontSize:9, color:'#999'}}>{d.month?.slice(5) || d.month || ''}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : <div style={{ textAlign: 'center', color: '#ccc', paddingTop: 80 }}>暂无趋势数据</div>}
          </Card>
        </Col>
      </Row>

      {/* 退税历史表格 */}
      <Card title="退税历史" size="small" style={{ marginTop: 8 }}>
        <Spin spinning={loading}>
          <Table
            dataSource={history}
            columns={columns}
            rowKey="id"
            pagination={{ pageSize: 10 }}
            size="small"
            expandable={{
              expandedRowKeys: expandedRows,
              onExpandedRowsChange: (keys: any) => setExpandedRows(keys as string[]),
              expandedRowRender: (r: RebateItem) => (
                <div style={{ padding: '8px 16px', background: '#fafafa' }}>
                  <p><strong>HS编码：</strong>{r.hsCode} — {r.description}</p>
                  <p><strong>计算方式：</strong>FOB总额 ${r.fobAmount?.toLocaleString()} × 退税率 {r.taxRate}% =
                    <span style={{ color: '#1890ff', fontWeight: 600 }}> ¥{r.rebateAmount?.toLocaleString()}</span>
                  </p>
                  <p><strong>不退税额：</strong>FOB总额 ${r.fobAmount?.toLocaleString()} × (征税率 - 退税率) =
                    <span style={{ color: '#999' }}> ¥{r.nonRebateAmount?.toLocaleString()}</span>
                  </p>
                  {isAbnormal(r) && <p style={{ color: '#cf1322' }}>⚠️ 该记录应退税额为0或异常，请核实</p>}
                </div>
              ),
            }}
          />
        </Spin>
      </Card>
    </div>
  );
}
