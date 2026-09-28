import { useEffect, useState } from 'react';
import {
  Input, Card, Button, Tag, Tabs, Table, Statistic, Row, Col,
  InputNumber, Select, Space, Divider, Alert, Progress, Skeleton,
  Descriptions, List, Typography, Tooltip, message, Result,
} from 'antd';
import {
  WarningOutlined, ThunderboltOutlined, SearchOutlined, ExperimentOutlined,
  InfoCircleOutlined, ClockCircleOutlined, EuroOutlined, FireOutlined,
  CheckCircleOutlined, CloseCircleOutlined, TrophyOutlined,
} from '@ant-design/icons';
import api from '../utils/api';

const SECTOR_COLORS: Record<string, string> = {
  steel: '#595959', aluminum: '#8c8c8c', cement: '#bfbfbf',
  fertilizer: '#7cb305', electricity: '#faad14', hydrogen: '#13c2c2',
};

const SECTOR_ICONS: Record<string, React.ReactNode> = {
  steel: <ThunderboltOutlined />, aluminum: <ExperimentOutlined />,
  cement: <FireOutlined />, fertilizer: <ExperimentOutlined />,
  electricity: <ThunderboltOutlined />, hydrogen: <ExperimentOutlined />,
};

const RISK_CONFIG: Record<string, { color: string; label: string; icon: React.ReactNode }> = {
  high: { color: '#cf1322', label: '高风险', icon: <WarningOutlined /> },
  medium: { color: '#fa8c16', label: '中风险', icon: <InfoCircleOutlined /> },
  low: { color: '#389e0d', label: '低风险', icon: <CheckCircleOutlined /> },
};

export default function CBAMPage() {
  // Input state
  const [hsCode, setHsCode] = useState('');
  const [productDesc, setProductDesc] = useState('');
  const [quantity, setQuantity] = useState<number>(100);
  const [unit, setUnit] = useState<string>('吨');
  const [productionMethod, setProductionMethod] = useState<string | undefined>();
  const [directOverride, setDirectOverride] = useState<number | null>(null);
  const [indirectOverride, setIndirectOverride] = useState<number | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Results
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // History & info
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [riskSummary, setRiskSummary] = useState<any>(null);
  const [sectors, setSectors] = useState<any[]>([]);
  const [pricing, setPricing] = useState<any>(null);

  // Batch mode
  const [batchItems, setBatchItems] = useState<string>('');
  const [batchResult, setBatchResult] = useState<any>(null);
  const [batchLoading, setBatchLoading] = useState(false);

  const fetchHistory = async () => {
    setHistoryLoading(true);
    try { const res = await api.get('/api/cbam/history'); setHistory(res.data); } catch {}
    finally { setHistoryLoading(false); }
  };

  const fetchRiskSummary = async () => {
    try { const res = await api.get('/api/cbam/risk-summary'); setRiskSummary(res.data); } catch {}
  };

  const fetchSectors = async () => {
    try { const res = await api.get('/api/cbam/sectors'); setSectors(res.data.sectors); setPricing(res.data.pricing); } catch {}
  };

  useEffect(() => { fetchHistory(); fetchRiskSummary(); fetchSectors(); }, []);

  const handleCalculate = async () => {
    if (!hsCode.trim()) { setError('请提供HS编码'); return; }
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await api.post('/api/cbam/calculate', {
        hsCode: hsCode.trim(),
        productDesc: productDesc || undefined,
        quantity,
        unit: unit || undefined,
        productionMethod: productionMethod || undefined,
        directEmissionsOverride: directOverride ?? undefined,
        indirectEmissionsOverride: indirectOverride ?? undefined,
      });
      setResult(res.data.data);
      fetchHistory();
      fetchRiskSummary();
    } catch (err: any) {
      setError(err.response?.data?.error || '测算失败');
    } finally {
      setLoading(false);
    }
  };

  const handleBatchCalculate = async () => {
    if (!batchItems.trim()) return;
    setBatchLoading(true);
    setBatchResult(null);
    try {
      const codes = batchItems.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
      const items = codes.map(c => ({ hsCode: c, quantity: 100 }));
      const res = await api.post('/api/cbam/batch-calculate', { items });
      setBatchResult(res.data.data);
    } catch (err: any) {
      message.error(err.response?.data?.error || '批量测算失败');
    } finally {
      setBatchLoading(false);
    }
  };

  // Auto-detect HS code sector
  const detectedSector = sectors?.find((s: any) =>
    s.hsPrefixes.some((p: string) => hsCode.replace(/[^0-9]/g, '').startsWith(p))
  );

  const historyColumns = [
    { title: 'HS编码', dataIndex: 'hsCode', key: 'hsCode', width: 110 },
    { title: '产品', dataIndex: 'productDesc', key: 'productDesc', ellipsis: true, width: 160 },
    { title: '隐含排放', dataIndex: 'embeddedEmissions', key: 'embeddedEmissions', width: 100,
      render: (v: number | null) => v != null ? `${v.toFixed(2)} tCO₂` : '—' },
    { title: '碳成本', dataIndex: 'carbonCost', key: 'carbonCost', width: 110,
      render: (v: number | null) => v != null ? <span style={{ fontWeight: 600, color: '#cf1322' }}>€{v.toFixed(2)}</span> : '—' },
    { title: '风险', dataIndex: 'riskLevel', key: 'riskLevel', width: 80,
      render: (v: string) => <Tag color={RISK_CONFIG[v]?.color}>{RISK_CONFIG[v]?.label || v}</Tag> },
    { title: '时间', dataIndex: 'calculatedAt', key: 'calculatedAt', width: 140,
      render: (v: string) => new Date(v).toLocaleDateString('zh-CN') },
  ];

  const isResultHighRisk = result?.riskLevel === 'high';
  const isResultMediumRisk = result?.riskLevel === 'medium';

  return (
    <div>
      <h2><FireOutlined style={{ color: '#cf1322' }} /> CBAM碳关税计算器</h2>
      <Alert
        message="CBAM已进入正式征收阶段（2026年1月1日起）。本计算器基于EU Regulation 2023/956方法学，使用EU JRC行业基准数据及中国生态环境部电网排放因子。"
        type="info" showIcon style={{ marginBottom: 16 }}
      />

      <Tabs defaultActiveKey="calculator" items={[
        // ==================== Tab 1: 计算器 ====================
        {
          key: 'calculator',
          label: <span><EuroOutlined /> 碳关税测算</span>,
          children: (
            <>
              {/* Input Card */}
              <Card style={{ marginBottom: 16 }}>
                <Row gutter={[16, 8]} align="middle">
                  <Col xs={24} sm={12} lg={6}>
                    <label>HS编码 <span style={{ color: 'red' }}>*</span></label>
                    <Input
                      placeholder="如 7208.39 或 7601.10"
                      value={hsCode}
                      onChange={e => setHsCode(e.target.value)}
                      onPressEnter={handleCalculate}
                      prefix={<SearchOutlined />}
                      suffix={detectedSector
                        ? <Tag color={SECTOR_COLORS[detectedSector.sector]} style={{ margin: 0 }}>{detectedSector.cnName}</Tag>
                        : hsCode ? <Tag color="default">未识别</Tag> : null}
                    />
                  </Col>
                  <Col xs={24} sm={12} lg={6}>
                    <label>产品描述</label>
                    <Input placeholder="如 热轧卷材" value={productDesc}
                      onChange={e => setProductDesc(e.target.value)} />
                  </Col>
                  <Col xs={12} sm={8} lg={4}>
                    <label>数量</label>
                    <InputNumber min={1} value={quantity} onChange={v => setQuantity(v || 0)}
                      style={{ width: '100%' }} addonAfter={unit} />
                  </Col>
                  <Col xs={12} sm={8} lg={4}>
                    <label>生产工艺</label>
                    <Select
                      style={{ width: '100%' }}
                      placeholder={detectedSector ? '默认工艺' : '先输入HS编码'}
                      value={productionMethod}
                      onChange={setProductionMethod}
                      options={detectedSector?.methods?.map((m: any) => ({
                        label: m.cnName,
                        value: m.name,
                      })) || []}
                    />
                  </Col>
                  <Col xs={24} sm={8} lg={4}>
                    <Button type="primary" size="large" onClick={handleCalculate} loading={loading}
                      icon={<EuroOutlined />} block style={{ marginTop: 22 }}>
                      开始测算
                    </Button>
                  </Col>
                </Row>

                {/* Advanced Options Toggle */}
                <Divider style={{ margin: '12px 0' }} />
                <Button type="link" size="small" onClick={() => setShowAdvanced(!showAdvanced)}>
                  {showAdvanced ? '收起' : '展开'}高级选项 (自定义排放因子)
                </Button>
                {showAdvanced && (
                  <Row gutter={[16, 8]} style={{ marginTop: 8 }}>
                    <Col xs={24} sm={12} md={8}>
                      <label>自定义直接排放 (tCO₂/单位)</label>
                      <InputNumber min={0} step={0.01} value={directOverride} onChange={v => setDirectOverride(v)}
                        style={{ width: '100%' }} placeholder="留空使用行业默认值" />
                    </Col>
                    <Col xs={24} sm={12} md={8}>
                      <label>自定义间接排放 (tCO₂/单位)</label>
                      <InputNumber min={0} step={0.01} value={indirectOverride} onChange={v => setIndirectOverride(v)}
                        style={{ width: '100%' }} placeholder="留空使用行业默认值" />
                    </Col>
                    <Col xs={24} sm={12} md={8}>
                      <label>自定义单位</label>
                      <Select value={unit} onChange={setUnit} style={{ width: '100%' }}
                        options={[{ label: '吨', value: '吨' }, { label: '千克', value: '千克' }, { label: 'MWh', value: 'MWh' }]} />
                    </Col>
                  </Row>
                )}
                {error && <Alert type="error" message={error} closable onClose={() => setError('')} style={{ marginTop: 8 }} />}
              </Card>

              {/* Loading */}
              {loading && <Card><Skeleton active paragraph={{ rows: 10 }} /></Card>}

              {/* Results */}
              {result && !loading && (
                <>
                  {/* Sector + Risk Banner */}
                  <Card style={{
                    marginBottom: 16,
                    borderLeft: `4px solid ${isResultHighRisk ? RISK_CONFIG.high.color : isResultMediumRisk ? RISK_CONFIG.medium.color : RISK_CONFIG.low.color}`,
                  }}>
                    <Row justify="space-between" align="middle">
                      <Col>
                        <Space size={12}>
                          <Tag color={SECTOR_COLORS[result.sector.sector]} style={{ fontSize: 14, padding: '4px 12px' }}>
                            {SECTOR_ICONS[result.sector.sector]} {result.sector.cnName}
                          </Tag>
                          <span style={{ fontSize: 20, fontFamily: 'monospace', fontWeight: 700 }}>{result.hsCode}</span>
                          <span style={{ fontSize: 16, color: '#666' }}>{result.productDesc}</span>
                        </Space>
                        <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>
                          生产工艺: {result.productionMethod.cnName} | 数量: {result.quantity} {result.unit}
                        </div>
                      </Col>
                      <Col>
                        <Tag color={RISK_CONFIG[result.riskLevel]?.color}
                          icon={RISK_CONFIG[result.riskLevel]?.icon}
                          style={{ fontSize: 16, padding: '8px 20px' }}>
                          {RISK_CONFIG[result.riskLevel]?.label}
                        </Tag>
                      </Col>
                    </Row>
                  </Card>

                  {/* Emissions + Cost Cards */}
                  <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
                    {/* Emissions Breakdown */}
                    <Col xs={24} md={12}>
                      <Card title={<span><FireOutlined /> 隐含排放量</span>} size="small">
                        <Row gutter={[16, 8]}>
                          <Col xs={24} sm={8} style={{ textAlign: 'center' }}>
                            <Statistic title="直接排放 (Scope 1)" value={result.emissions.directEmissions}
                              suffix={`tCO₂/${result.unit}`} precision={3}
                              valueStyle={{ color: '#cf1322', fontSize: 22 }} />
                            <div style={{ fontSize: 11, color: '#999' }}>生产过程直接排放</div>
                          </Col>
                          <Col xs={24} sm={8} style={{ textAlign: 'center' }}>
                            <Statistic title="间接排放 (Scope 2)" value={result.emissions.indirectEmissions}
                              suffix={`tCO₂/${result.unit}`} precision={3}
                              valueStyle={{ color: '#fa8c16', fontSize: 22 }} />
                            <div style={{ fontSize: 11, color: '#999' }}>外购电力/热力</div>
                          </Col>
                          <Col xs={24} sm={8} style={{ textAlign: 'center' }}>
                            <Statistic title="总隐含排放" value={result.emissions.totalEmbeddedEmissions}
                              suffix={`tCO₂/${result.unit}`} precision={3}
                              valueStyle={{ color: '#cf1322', fontSize: 28, fontWeight: 700 }} />
                          </Col>
                        </Row>
                        {result.euBenchmark != null && (
                          <Alert
                            style={{ marginTop: 12 }}
                            type={result.exceedsBenchmark ? 'warning' : 'success'}
                            message={result.exceedsBenchmark
                              ? `超过EU免费配额基准 (${result.euBenchmark} tCO₂/${result.unit}) — 无免费配额`
                              : `低于EU免费配额基准 (${result.euBenchmark} tCO₂/${result.unit}) — 可能获得部分免费配额`}
                          />
                        )}
                      </Card>
                    </Col>

                    {/* Cost Breakdown */}
                    <Col xs={24} md={12}>
                      <Card title={<span><EuroOutlined /> 碳成本明细</span>} size="small">
                        <Row gutter={[16, 8]}>
                          <Col xs={12} sm={6} style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: 11, color: '#999' }}>EU ETS碳价</div>
                            <div style={{ fontSize: 20, fontWeight: 600, color: '#1677ff' }}>
                              €{result.costs.euCarbonPrice}
                            </div>
                            <div style={{ fontSize: 10, color: '#bbb' }}>/tCO₂</div>
                          </Col>
                          <Col xs={12} sm={6} style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: 11, color: '#999' }}>中国碳价</div>
                            <div style={{ fontSize: 20, fontWeight: 600, color: '#52c41a' }}>
                              €{result.costs.chinaCarbonPrice}
                            </div>
                            <div style={{ fontSize: 10, color: '#bbb' }}>/tCO₂ (可抵减)</div>
                          </Col>
                          <Col xs={12} sm={6} style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: 11, color: '#999' }}>有效碳价差</div>
                            <div style={{ fontSize: 20, fontWeight: 600, color: '#fa8c16' }}>
                              €{result.costs.effectivePrice}
                            </div>
                            <div style={{ fontSize: 10, color: '#bbb' }}>/tCO₂</div>
                          </Col>
                          <Col xs={12} sm={6} style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: 11, color: '#999' }}>总排放量</div>
                            <div style={{ fontSize: 20, fontWeight: 600 }}>
                              {result.costs.totalEmissions}
                            </div>
                            <div style={{ fontSize: 10, color: '#bbb' }}>tCO₂</div>
                          </Col>
                        </Row>
                        <Divider style={{ margin: '12px 0' }} />
                        <Row gutter={[16, 8]}>
                          <Col xs={24} sm={12} style={{ textAlign: 'center' }}>
                            <Statistic title="毛碳成本 (EU碳价)" value={result.costs.grossCBAMCost}
                              prefix="€" precision={2} valueStyle={{ color: '#8c8c8c' }} />
                          </Col>
                          <Col xs={24} sm={12} style={{ textAlign: 'center' }}>
                            <Statistic
                              title={<span style={{ fontWeight: 700, fontSize: 14 }}>净CBAM应缴费用</span>}
                              value={result.costs.netCBAMCost}
                              prefix="€" precision={2}
                              valueStyle={{ color: '#cf1322', fontSize: 32, fontWeight: 700 }}
                            />
                            <div style={{ fontSize: 11, color: '#999' }}>
                              已抵减中国碳成本 €{result.costs.chinaCarbonCostPaid.toFixed(2)}
                            </div>
                          </Col>
                        </Row>
                      </Card>
                    </Col>
                  </Row>

                  {/* Risk Factors + Cost Per Unit */}
                  <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
                    <Col xs={24} md={14}>
                      <Card title={<span><WarningOutlined /> 风险因素分析</span>} size="small">
                        {result.riskFactors?.length > 0 ? (
                          <List size="small"
                            dataSource={result.riskFactors}
                            renderItem={(item: string) => (
                              <List.Item>
                                <Space>
                                  <WarningOutlined style={{ color: RISK_CONFIG[result.riskLevel]?.color }} />
                                  <Typography.Text>{item}</Typography.Text>
                                </Space>
                              </List.Item>
                            )}
                          />
                        ) : (
                          <Alert type="success" message="未发现显著CBAM风险因素" />
                        )}
                      </Card>
                    </Col>
                    <Col xs={24} md={10}>
                      <Card title={<span><ClockCircleOutlined /> 季度报告截止</span>} size="small">
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: 12, color: '#999' }}>{result.reportDeadline.label} 报告</div>
                          <div style={{ fontSize: 36, fontWeight: 700, color: result.reportDeadline.daysRemaining < 30 ? '#cf1322' : '#1677ff' }}>
                            {result.reportDeadline.daysRemaining}
                          </div>
                          <div style={{ fontSize: 13, color: '#999' }}>天剩余</div>
                          <div style={{ fontSize: 13, marginTop: 4 }}>
                            截止日期: <Tag>{result.reportDeadline.deadline}</Tag>
                          </div>
                          <Alert style={{ marginTop: 8 }} type="info"
                            message="过渡期内(至2025.12.31)按季度报告，2026年起需购买CBAM证书" />
                        </div>
                      </Card>
                    </Col>
                  </Row>

                  {/* Methodology Note */}
                  <Card size="small" style={{ background: '#fafafa' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      <InfoCircleOutlined /> 计算方法学: {result.methodology}
                    </Typography.Text>
                  </Card>
                </>
              )}
            </>
          ),
        },

        // ==================== Tab 2: 行业基准 ====================
        {
          key: 'sectors',
          label: '行业基准',
          children: (
            <>
              {pricing && (
                <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
                  <Col xs={12} sm={6}>
                    <Card size="small" style={{ textAlign: 'center', background: '#f0f5ff' }}>
                      <Statistic title="EU ETS碳价" value={pricing.euEtsPrice} prefix="€" suffix="/tCO₂" precision={1}
                        valueStyle={{ color: '#1677ff' }} />
                      <div style={{ fontSize: 10, color: '#999' }}>2026年6月参考</div>
                    </Card>
                  </Col>
                  <Col xs={12} sm={6}>
                    <Card size="small" style={{ textAlign: 'center', background: '#f6ffed' }}>
                      <Statistic title="中国碳市场" value={pricing.chinaEtsPrice} prefix="€" suffix="/tCO₂" precision={1}
                        valueStyle={{ color: '#52c41a' }} />
                      <div style={{ fontSize: 10, color: '#999' }}>全国碳市场均价 (¥62)</div>
                    </Card>
                  </Col>
                  <Col xs={12} sm={6}>
                    <Card size="small" style={{ textAlign: 'center', background: '#fff7e6' }}>
                      <Statistic title="有效碳价差" value={pricing.effectiveCarbonPrice} prefix="€" suffix="/tCO₂" precision={1}
                        valueStyle={{ color: '#fa8c16' }} />
                      <div style={{ fontSize: 10, color: '#999' }}>EU ETS - 中国碳价</div>
                    </Card>
                  </Col>
                  <Col xs={12} sm={6}>
                    <Card size="small" style={{ textAlign: 'center' }}>
                      <Statistic title="汇率" value={pricing.exchangeRate} suffix="CNY/EUR" precision={2} />
                      <div style={{ fontSize: 10, color: '#999' }}>{pricing.updatedAt}</div>
                    </Card>
                  </Col>
                </Row>
              )}

              {sectors?.map((s: any) => (
                <Card key={s.sector} size="small" style={{ marginBottom: 12 }}
                  title={
                    <Space>
                      <Tag color={SECTOR_COLORS[s.sector]} style={{ fontSize: 13 }}>{SECTOR_ICONS[s.sector]} {s.cnName}</Tag>
                      <span style={{ fontSize: 14 }}>{s.name}</span>
                      {s.euBenchmark > 0 && <Tag color="gold">EU基准: {s.euBenchmark} tCO₂/吨</Tag>}
                    </Space>
                  }>
                  <Row gutter={[16, 16]}>
                    <Col xs={24} md={8}>
                      <div style={{ fontSize: 12, color: '#999' }}>基准排放因子</div>
                      <Descriptions size="small" column={1}>
                        <Descriptions.Item label="直接排放">{s.baseEmissions.directEmissions} tCO₂/{s.baseEmissions.unit}</Descriptions.Item>
                        <Descriptions.Item label="间接排放">{s.baseEmissions.indirectEmissions} tCO₂/{s.baseEmissions.unit}</Descriptions.Item>
                        <Descriptions.Item label="总隐含排放">
                          <strong>{(s.baseEmissions.directEmissions + s.baseEmissions.indirectEmissions).toFixed(3)} tCO₂/{s.baseEmissions.unit}</strong>
                        </Descriptions.Item>
                      </Descriptions>
                      <div style={{ fontSize: 11, color: '#bbb', marginTop: 4 }}>{s.baseEmissions.description}</div>
                    </Col>
                    <Col xs={24} md={16}>
                      <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>生产工艺对比</div>
                      <Table size="small" pagination={false} scroll={{ x: 500 }} dataSource={s.methods.map((m: any, i: number) => ({ ...m, key: i }))}
                        columns={[
                          { title: '工艺', dataIndex: 'cnName', key: 'cnName', width: 140,
                            render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
                          { title: '直接排放倍率', dataIndex: 'directMultiplier', key: 'directMultiplier', width: 100, align: 'center',
                            render: (v: number) => <Tag color={v > 0.5 ? 'red' : v > 0.1 ? 'orange' : 'green'}>{v}x</Tag> },
                          { title: '间接排放倍率', dataIndex: 'indirectMultiplier', key: 'indirectMultiplier', width: 100, align: 'center',
                            render: (v: number) => <Tag color={v > 1 ? 'orange' : 'default'}>{v}x</Tag> },
                          { title: '说明', dataIndex: 'description', key: 'description', ellipsis: true },
                        ]}
                      />
                    </Col>
                  </Row>
                </Card>
              ))}
            </>
          ),
        },

        // ==================== Tab 3: 批量测算 ====================
        {
          key: 'batch',
          label: <span><ExperimentOutlined /> 批量测算</span>,
          children: (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Typography.Text>输入多个HS编码 (每行一个，或用逗号分隔):</Typography.Text>
                <Input.TextArea rows={4} value={batchItems} onChange={e => setBatchItems(e.target.value)}
                  placeholder={'7208.39\n7601.10\n2523.10\n3102.10'}
                  style={{ marginTop: 8 }} />
                <Button type="primary" onClick={handleBatchCalculate} loading={batchLoading}
                  icon={<ExperimentOutlined />} style={{ marginTop: 8 }}>
                  批量测算
                </Button>
              </Card>

              {batchResult && (
                <>
                  {/* Summary */}
                  <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
                    <Col xs={12} sm={6}>
                      <Card size="small" style={{ textAlign: 'center' }}>
                        <Statistic title="总数" value={batchResult.summary.total} />
                      </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                      <Card size="small" style={{ textAlign: 'center' }}>
                        <Statistic title="成功" value={batchResult.summary.success} valueStyle={{ color: '#389e0d' }} />
                      </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                      <Card size="small" style={{ textAlign: 'center' }}>
                        <Statistic title="高风险" value={batchResult.summary.highRisk} valueStyle={{ color: '#cf1322' }} />
                      </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                      <Card size="small" style={{ textAlign: 'center' }}>
                        <Statistic title="总计CBAM成本" value={batchResult.summary.totalCBAMCost.toFixed(0)}
                          prefix="€" valueStyle={{ color: '#cf1322' }} />
                      </Card>
                    </Col>
                  </Row>

                  {/* Results Table */}
                  <Card title="详细结果" size="small">
                    <Table size="small" pagination={false} scroll={{ x: 700 }}
                      dataSource={batchResult.results.map((r: any, i: number) => ({ ...r, key: i }))}
                      columns={[
                        { title: 'HS编码', dataIndex: 'hsCode', key: 'hsCode', width: 110 },
                        { title: '行业', dataIndex: ['sector', 'cnName'], key: 'sector', width: 70,
                          render: (v: string, r: any) => r.success
                            ? <Tag color={SECTOR_COLORS[r.sector?.sector]}>{v}</Tag>
                            : <Tag color="default">—</Tag> },
                        { title: '排放量', key: 'emissions', width: 140,
                          render: (_: any, r: any) => r.success
                            ? `${r.emissions.totalEmbeddedEmissions.toFixed(3)} tCO₂/${r.unit}`
                            : <span style={{ color: '#ccc' }}>—</span> },
                        { title: '净CBAM成本', key: 'cost', width: 130,
                          render: (_: any, r: any) => r.success
                            ? <span style={{ fontWeight: 600, color: '#cf1322' }}>€{r.costs.netCBAMCost.toFixed(2)}</span>
                            : <span style={{ color: '#ccc' }}>—</span> },
                        { title: '风险', dataIndex: 'riskLevel', key: 'risk', width: 80,
                          render: (v: string, r: any) => r.success
                            ? <Tag color={RISK_CONFIG[v]?.color}>{RISK_CONFIG[v]?.label}</Tag>
                            : <Tag color="default">错误</Tag> },
                        { title: '备注', dataIndex: 'error', key: 'error',
                          render: (v: string, r: any) => r.success ? '—' : <span style={{ color: '#cf1322' }}>{v}</span> },
                      ]}
                    />
                  </Card>
                </>
              )}
            </>
          ),
        },

        // ==================== Tab 4: 历史记录 ====================
        {
          key: 'history',
          label: '历史记录',
          children: (
            <>
              {riskSummary && (
                <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
                  <Col xs={12} sm={6}>
                    <Card size="small" style={{ textAlign: 'center', borderTop: '3px solid #cf1322' }}>
                      <Statistic title="高风险" value={riskSummary.high}
                        valueStyle={{ color: '#cf1322' }} suffix={<WarningOutlined />} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={6}>
                    <Card size="small" style={{ textAlign: 'center', borderTop: '3px solid #fa8c16' }}>
                      <Statistic title="中风险" value={riskSummary.medium}
                        valueStyle={{ color: '#fa8c16' }} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={6}>
                    <Card size="small" style={{ textAlign: 'center', borderTop: '3px solid #389e0d' }}>
                      <Statistic title="低风险" value={riskSummary.low}
                        valueStyle={{ color: '#389e0d' }} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={6}>
                    <Card size="small" style={{ textAlign: 'center', borderTop: '3px solid #1677ff' }}>
                      <Statistic title="累计碳成本" value={`€${(riskSummary.totalEstimatedCost || 0).toFixed(0)}`}
                        valueStyle={{ color: '#cf1322', fontSize: 20 }} />
                    </Card>
                  </Col>
                </Row>
              )}
              <Table dataSource={history} columns={historyColumns} rowKey="id" loading={historyLoading}
                scroll={{ x: 700 }} pagination={{ pageSize: 20, showTotal: t => `共 ${t} 条` }} size="small" />
            </>
          ),
        },
      ]} />
    </div>
  );
}
