import { useEffect, useState } from 'react';
import {
  Input, Card, Select, Button, Tag, Tabs, Table, InputNumber,
  Row, Col, Statistic, Steps, Result, Space, Divider, Alert,
  Descriptions, Skeleton, List, Typography,
} from 'antd';
import { SearchOutlined, CheckCircleOutlined, CloseCircleOutlined, TrophyOutlined, GlobalOutlined, FileProtectOutlined } from '@ant-design/icons';
import api from '../utils/api';

const ruleTypeColorMap: Record<string, string> = {
  WO: 'blue', PE: 'purple', CC: 'geekblue', CTH: 'cyan', SP: 'orange', RVC: 'green',
};
const ruleTypeLabelMap: Record<string, string> = {
  WO: '完全获得', PE: '特定产品', CC: '税则改变(品目)', CTH: '税则改变(章级)', SP: '特定工序', RVC: '区域价值成分',
};

const countryOptions = [
  { label: '主要贸易国', options: [
    { value: 'CN', label: '中国' }, { value: 'US', label: '美国' }, { value: 'JP', label: '日本' },
    { value: 'KR', label: '韩国' }, { value: 'VN', label: '越南' }, { value: 'DE', label: '德国' },
    { value: 'RU', label: '俄罗斯' }, { value: 'AU', label: '澳大利亚' }, { value: 'MY', label: '马来西亚' },
    { value: 'BR', label: '巴西' }, { value: 'IN', label: '印度' }, { value: 'GB', label: '英国' },
    { value: 'TH', label: '泰国' }, { value: 'SA', label: '沙特' }, { value: 'FR', label: '法国' },
    { value: 'NL', label: '荷兰' },
  ]},
  { label: 'RCEP 亚太', options: [
    { value: 'JP', label: '日本' }, { value: 'KR', label: '韩国' }, { value: 'AU', label: '澳大利亚' },
    { value: 'NZ', label: '新西兰' }, { value: 'BN', label: '文莱' }, { value: 'KH', label: '柬埔寨' },
    { value: 'ID', label: '印度尼西亚' }, { value: 'LA', label: '老挝' }, { value: 'MY', label: '马来西亚' },
    { value: 'MM', label: '缅甸' }, { value: 'PH', label: '菲律宾' }, { value: 'SG', label: '新加坡' },
    { value: 'TH', label: '泰国' }, { value: 'VN', label: '越南' },
  ]},
  { label: '北美', options: [{ value: 'US', label: '美国' }, { value: 'CA', label: '加拿大' }, { value: 'MX', label: '墨西哥' }]},
  { label: '欧盟', options: [
    { value: 'DE', label: '德国' }, { value: 'FR', label: '法国' }, { value: 'NL', label: '荷兰' },
    { value: 'IT', label: '意大利' }, { value: 'ES', label: '西班牙' }, { value: 'BE', label: '比利时' },
    { value: 'PL', label: '波兰' },
  ]},
  { label: '南美', options: [{ value: 'BR', label: '巴西' }, { value: 'CL', label: '智利' }, { value: 'AR', label: '阿根廷' }, { value: 'PE', label: '秘鲁' }]},
];

const countryCodeToName: Record<string, string> = {
  CN: '中国', US: '美国', JP: '日本', KR: '韩国', VN: '越南', DE: '德国',
  RU: '俄罗斯', AU: '澳大利亚', MY: '马来西亚', BR: '巴西', IN: '印度', GB: '英国',
  TH: '泰国', SA: '沙特', FR: '法国', NL: '荷兰', NZ: '新西兰', BN: '文莱',
  KH: '柬埔寨', ID: '印度尼西亚', LA: '老挝', MM: '缅甸', PH: '菲律宾',
  SG: '新加坡', CA: '加拿大', MX: '墨西哥', IT: '意大利', ES: '西班牙',
  BE: '比利时', PL: '波兰', CL: '智利', AR: '阿根廷', PE: '秘鲁',
};

interface MaterialRow {
  key: string;
  hsCode: string;
  originCountry: string;
  value: number;
}

export default function OriginPage() {
  // Tab 1: 规则查询
  const [ftaList, setFtaList] = useState<any[]>([]);
  const [selectedFta, setSelectedFta] = useState<string | undefined>();
  const [searchHsCode, setSearchHsCode] = useState('');
  const [searchRuleType, setSearchRuleType] = useState<string | undefined>();
  const [rules, setRules] = useState<any[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);

  // Tab 2: RVC计算器
  const [fob, setFob] = useState<number | null>(null);
  const [vnm, setVnm] = useState<number | null>(null);
  const [rvcThreshold, setRvcThreshold] = useState<number | null>(40);
  const [rvcResult, setRvcResult] = useState<any>(null);
  const [rvcLoading, setRvcLoading] = useState(false);

  // Tab 3: 智能判定
  const [step, setStep] = useState(0);
  const [detFta, setDetFta] = useState<string | undefined>();
  const [detHsCode, setDetHsCode] = useState('');
  const [materials, setMaterials] = useState<MaterialRow[]>([]);
  const [detFob, setDetFob] = useState<number | null>(null);
  const [detResult, setDetResult] = useState<any>(null);
  const [detLoading, setDetLoading] = useState(false);
  const [detError, setDetError] = useState('');

  // Tab 4: 最优税率路径
  const [compareDesc, setCompareDesc] = useState('');
  const [compareHsCode, setCompareHsCode] = useState('');
  const [compareDest, setCompareDest] = useState<string | undefined>();
  const [compareResult, setCompareResult] = useState<any>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState('');

  useEffect(() => {
    api.get('/api/origin/fta-agreements').then(res => setFtaList(res.data)).catch(() => {});
  }, []);

  // Tab 1: 搜索规则
  const handleSearchRules = async () => {
    setRulesLoading(true);
    try {
      const params: any = {};
      if (selectedFta) params.ftaId = selectedFta;
      if (searchHsCode) params.hsCode = searchHsCode;
      if (searchRuleType) params.ruleType = searchRuleType;
      const res = await api.get('/api/origin/rules', { params });
      setRules(res.data);
    } finally {
      setRulesLoading(false);
    }
  };

  // Tab 2: RVC计算
  const handleRvcCalc = async () => {
    if (fob == null || vnm == null || rvcThreshold == null) return;
    setRvcLoading(true);
    try {
      const res = await api.post('/api/origin/rvc-calculate', {
        fobValue: fob,
        nonOriginatingValue: vnm,
        threshold: rvcThreshold,
      });
      setRvcResult(res.data);
    } finally {
      setRvcLoading(false);
    }
  };

  // Tab 3: 智能判定
  const handleDetermine = async () => {
    if (!detFta || !detHsCode || materials.length === 0 || detFob == null) return;
    setDetLoading(true);
    setDetError('');
    try {
      const res = await api.post('/api/origin/determine', {
        ftaId: detFta,
        hsCode: detHsCode,
        materials: materials.map(m => ({ hsCode: m.hsCode, originCountry: m.originCountry, value: m.value })),
        fobValue: detFob,
      });
      setDetResult(res.data);
      setStep(2);
    } catch (err: any) {
      setDetError(err?.response?.data?.error || '判定失败');
    } finally {
      setDetLoading(false);
    }
  };

  const addMaterial = () => {
    setMaterials([...materials, { key: Date.now().toString(), hsCode: '', originCountry: '', value: 0 }]);
  };

  const removeMaterial = (key: string) => {
    setMaterials(materials.filter(m => m.key !== key));
  };

  const updateMaterial = (key: string, field: string, value: any) => {
    setMaterials(materials.map(m => m.key === key ? { ...m, [field]: value } : m));
  };

  const resetDetermine = () => {
    setStep(0); setDetFta(undefined); setDetHsCode(''); setMaterials([]);
    setDetFob(null); setDetResult(null); setDetError('');
  };

  const selectedFtaInfo = ftaList.find(f => f.id === detFta);

  // Tab 4: 最优税率路径比对
  const handleCompare = async () => {
    if (!compareDest) { setCompareError('请选择目的国'); return; }
    if (!compareDesc.trim() && !compareHsCode.trim()) { setCompareError('请输入商品描述或HS编码'); return; }
    setCompareLoading(true);
    setCompareResult(null);
    setCompareError('');
    try {
      const res = await api.post('/api/origin/compare', {
        description: compareDesc || undefined,
        hsCode: compareHsCode || undefined,
        destinationCountry: compareDest,
      });
      setCompareResult(res.data.data);
    } catch (err: any) {
      setCompareError(err?.response?.data?.error || '比对失败');
    } finally {
      setCompareLoading(false);
    }
  };

  // 规则查询列
  const ruleColumns = [
    { title: 'FTA', dataIndex: ['ftaAgreement', 'shortName'], key: 'fta', width: 80,
      render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: 'HS编码', dataIndex: 'hsCode', key: 'hsCode', width: 100 },
    { title: '规则类型', dataIndex: 'ruleType', key: 'ruleType', width: 130,
      render: (v: string) => <Tag color={ruleTypeColorMap[v] || 'default'}>{ruleTypeLabelMap[v] || v}</Tag> },
    { title: '规则描述', dataIndex: 'ruleDetail', key: 'ruleDetail', ellipsis: true },
    { title: 'RVC阈值', dataIndex: 'rvcThreshold', key: 'rvcThreshold', width: 90,
      render: (v: number | null) => v != null ? <Tag color="green">≥{v}%</Tag> : '-' },
    { title: '优惠税率', dataIndex: 'tariffReduction', key: 'tariffReduction', width: 90,
      render: (v: number | null) => v != null ? <Tag color="orange">{v}%</Tag> : '-' },
    { title: '来源', dataIndex: 'source', key: 'source', width: 140, render: (v: string) => v || '-' },
    { title: '生效日期', dataIndex: 'effectiveDate', key: 'effectiveDate', width: 110,
      render: (v: string | null) => v ? new Date(v).toLocaleDateString('zh-CN') : '-' },
  ];

  return (
    <div>
      <h2>原产地规则判定</h2>

      <Tabs defaultActiveKey="rules" items={[
        {
          key: 'rules',
          label: '规则查询',
          children: (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Space wrap>
                  <Select placeholder="选择FTA协定" value={selectedFta} onChange={setSelectedFta}
                    allowClear style={{ width: 240 }}
                    options={ftaList.map(f => ({ label: `${f.shortName} - ${f.name}`, value: f.id }))}
                  />
                  <Input placeholder="HS编码" value={searchHsCode} onChange={e => setSearchHsCode(e.target.value)}
                    prefix={<SearchOutlined />} style={{ width: 160 }} allowClear />
                  <Select placeholder="规则类型" value={searchRuleType} onChange={setSearchRuleType}
                    allowClear style={{ width: 150 }}
                    options={Object.entries(ruleTypeLabelMap).map(([k, v]) => ({ label: v, value: k }))}
                  />
                  <Button type="primary" onClick={handleSearchRules} loading={rulesLoading}>搜索</Button>
                </Space>
              </Card>
              <Table dataSource={rules} columns={ruleColumns} rowKey="id" loading={rulesLoading}
                scroll={{ x: 800 }} pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }} size="small"
                locale={{ emptyText: '请选择FTA协定并输入HS编码搜索' }}
              />
            </>
          ),
        },
        {
          key: 'rvc',
          label: 'RVC计算器',
          children: (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <Row gutter={[16, 8]}>
                    <Col xs={24} md={8}>
                      <label>FOB价值 (美元)</label>
                      <InputNumber min={0} value={fob} onChange={v => setFob(v)}
                        style={{ width: '100%' }} placeholder="最终产品FOB价值" />
                    </Col>
                    <Col xs={24} md={8}>
                      <label>非原产材料价值 VNM (美元)</label>
                      <InputNumber min={0} value={vnm} onChange={v => setVnm(v)}
                        style={{ width: '100%' }} placeholder="非成员国原材料价值" />
                    </Col>
                    <Col xs={24} md={8}>
                      <label>RVC阈值 (%)</label>
                      <InputNumber min={0} max={100} value={rvcThreshold} onChange={v => setRvcThreshold(v)}
                        style={{ width: '100%' }} placeholder="协定要求的最低RVC" />
                    </Col>
                  </Row>
                  <Button type="primary" onClick={handleRvcCalc} loading={rvcLoading}
                    disabled={fob == null || vnm == null || rvcThreshold == null}>开始计算</Button>
                </Space>
              </Card>

              {rvcResult && (
                <Card>
                  {rvcResult.passed ? (
                    <Result status="success" title="RVC计算通过"
                      subTitle={
                        <span>区域价值成分 <strong>{rvcResult.percentage}%</strong> ≥ 阈值 {rvcResult.threshold}%，符合原产资格</span>
                      }
                      icon={<CheckCircleOutlined />}
                    />
                  ) : (
                    <Result status="error" title="RVC计算未通过"
                      subTitle={
                        <span>区域价值成分 <strong>{rvcResult.percentage}%</strong> &lt; 阈值 {rvcResult.threshold}%，不符合原产资格</span>
                      }
                      icon={<CloseCircleOutlined />}
                    />
                  )}
                  <Divider>计算公式</Divider>
                  <Row gutter={[16, 16]}>
                    <Col xs={24} sm={12}>
                      <Statistic title="公式" value="RVC = (FOB - VNM) / FOB × 100%" />
                    </Col>
                    <Col xs={24} sm={12}>
                      <Statistic title="计算过程"
                        value={`(${fob?.toFixed(2)} - ${vnm?.toFixed(2)}) / ${fob?.toFixed(2)} × 100% = ${rvcResult.percentage}%`} />
                    </Col>
                  </Row>
                </Card>
              )}
            </>
          ),
        },
        {
          key: 'determine',
          label: '智能判定',
          children: (
            <>
              <Steps current={step} style={{ marginBottom: 24 }}>
                <Steps.Step title="选择FTA协定" />
                <Steps.Step title="输入HS编码和原材料" />
                <Steps.Step title="判定结果" />
              </Steps>

              {step === 0 && (
                <Card title="选择自贸协定">
                  <Space direction="vertical" style={{ width: '100%' }} size="middle">
                    <Select placeholder="选择FTA协定" value={detFta} onChange={setDetFta}
                      style={{ width: '100%' }}
                      options={ftaList.map(f => ({
                        label: `${f.shortName} - ${f.name}`,
                        value: f.id,
                      }))}
                    />
                    {selectedFtaInfo && (
                      <Card size="small" title="成员国">
                        <Space wrap>
                          {selectedFtaInfo.memberCountries?.map((c: string) => (
                            <Tag key={c} color="blue">{countryCodeToName[c] || c}</Tag>
                          ))}
                        </Space>
                      </Card>
                    )}
                    <Button type="primary" disabled={!detFta} onClick={() => setStep(1)}>下一步</Button>
                  </Space>
                </Card>
              )}

              {step === 1 && (
                <Card title="输入产品信息">
                  <Space direction="vertical" style={{ width: '100%' }} size="middle">
                    <Row gutter={[16, 8]}>
                      <Col xs={24} sm={12}>
                        <label>HS编码</label>
                        <Input value={detHsCode} onChange={e => setDetHsCode(e.target.value)}
                          placeholder="如 8471.30" />
                      </Col>
                      <Col xs={24} sm={12}>
                        <label>FOB价值 (美元)</label>
                        <InputNumber min={0} value={detFob} onChange={v => setDetFob(v)}
                          style={{ width: '100%' }} placeholder="最终产品FOB价值" />
                      </Col>
                    </Row>

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <strong>原材料清单</strong>
                        <Button size="small" onClick={addMaterial}>添加原材料</Button>
                      </div>
                      {materials.map((m, i) => (
                        <Row key={m.key} gutter={[8, 8]} style={{ marginBottom: 8 }}>
                          <Col xs={12} sm={6}>
                            <Input size="small" placeholder="HS编码" value={m.hsCode}
                              onChange={e => updateMaterial(m.key, 'hsCode', e.target.value)} />
                          </Col>
                          <Col xs={12} sm={8}>
                            <Select size="small" style={{ width: '100%' }} placeholder="原产国"
                              value={m.originCountry || undefined}
                              onChange={v => updateMaterial(m.key, 'originCountry', v)}
                              showSearch options={countryOptions}
                              optionFilterProp="label"
                            />
                          </Col>
                          <Col xs={12} sm={5}>
                            <InputNumber size="small" style={{ width: '100%' }} placeholder="金额"
                              min={0} value={m.value || 0}
                              onChange={v => updateMaterial(m.key, 'value', v || 0)} />
                          </Col>
                          <Col xs={12} sm={5}>
                            <Button size="small" danger onClick={() => removeMaterial(m.key)}>删除</Button>
                          </Col>
                        </Row>
                      ))}
                      {materials.length === 0 && (
                        <Alert type="info" message="请添加至少一种原材料" style={{ marginBottom: 8 }} />
                      )}
                    </div>

                    {detError && <Alert type="error" message={detError} closable onClose={() => setDetError('')} />}

                    <Space>
                      <Button onClick={() => setStep(0)}>上一步</Button>
                      <Button type="primary" onClick={handleDetermine} loading={detLoading}
                        disabled={!detHsCode || materials.length === 0 || detFob == null}>
                        开始判定
                      </Button>
                    </Space>
                  </Space>
                </Card>
              )}

              {step === 2 && detResult && (
                <>
                  <Card>
                    {detResult.qualifies ? (
                      <Result status="success" title="符合原产资格"
                        subTitle={
                          <span>{detResult.fta.shortName} 协定下，HS编码 {detResult.hsCode} 满足原产地规则要求，可享受优惠关税</span>
                        }
                        icon={<CheckCircleOutlined />}
                      />
                    ) : (
                      <Result status="error" title="不符合原产资格"
                        subTitle="当前原材料组合不满足原产地规则要求，无法享受优惠关税"
                        icon={<CloseCircleOutlined />}
                      />
                    )}
                  </Card>

                  <Card title="判定详情" style={{ marginTop: 16 }}>
                    <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
                      <Descriptions.Item label="FTA协定">{detResult.fta.name}</Descriptions.Item>
                      <Descriptions.Item label="HS编码">{detResult.hsCode}</Descriptions.Item>
                      <Descriptions.Item label="规则类型">
                        <Tag color={ruleTypeColorMap[detResult.rule.ruleType] || 'default'}>
                          {ruleTypeLabelMap[detResult.rule.ruleType] || detResult.rule.ruleType}
                        </Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label="规则描述">{detResult.rule.ruleDetail || '-'}</Descriptions.Item>
                      <Descriptions.Item label="优惠税率" span={2}>
                        {detResult.rule.tariffReduction != null
                          ? <Tag color="orange">{detResult.rule.tariffReduction}%</Tag> : '-'}
                      </Descriptions.Item>
                    </Descriptions>

                    {detResult.rvcResult && (
                      <>
                        <Divider>RVC计算详情</Divider>
                        <Row gutter={[16, 16]}>
                          <Col xs={12} sm={6}><Statistic title="RVC值" value={`${detResult.rvcResult.percentage}%`}
                            valueStyle={{ color: detResult.rvcResult.passed ? '#3f8600' : '#cf1322' }} /></Col>
                          <Col xs={12} sm={6}><Statistic title="阈值" value={`≥${detResult.rvcResult.threshold}%`} /></Col>
                          <Col xs={12} sm={6}><Statistic title="非原产材料总值" value={`$${detResult.nonOriginatingTotal.toFixed(2)}`} /></Col>
                          <Col xs={12} sm={6}><Statistic title="FOB总值" value={`$${detFob?.toFixed(2)}`} /></Col>
                        </Row>
                      </>
                    )}

                    <Divider>判定理由</Divider>
                    <ul style={{ paddingLeft: 20 }}>
                      {detResult.reasons.map((r: string, i: number) => (
                        <li key={i} style={{ marginBottom: 4 }}>{r}</li>
                      ))}
                    </ul>
                  </Card>

                  <Space style={{ marginTop: 16 }}>
                    <Button type="primary" onClick={resetDetermine}>重新判定</Button>
                  </Space>
                </>
              )}
            </>
          ),
        },
        {
          key: 'compare',
          label: <span><GlobalOutlined /> 最优税率路径</span>,
          children: (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  <Row gutter={[16, 8]}>
                    <Col xs={24} md={12}>
                      <label>商品描述</label>
                      <Input
                        placeholder="输入商品名称，如：单晶硅光伏组件、锂离子蓄电池"
                        value={compareDesc}
                        onChange={e => { setCompareDesc(e.target.value); setCompareHsCode(''); }}
                        prefix={<SearchOutlined />}
                        allowClear
                      />
                    </Col>
                    <Col xs={24} sm={12} md={6}>
                      <label>HS编码 (或由描述自动识别)</label>
                      <Input
                        placeholder="如 8541.43"
                        value={compareHsCode}
                        onChange={e => { setCompareHsCode(e.target.value); setCompareDesc(''); }}
                        allowClear
                      />
                    </Col>
                    <Col xs={24} sm={12} md={6}>
                      <label>目的国 (出口至)</label>
                      <Select
                        style={{ width: '100%' }}
                        placeholder="选择目的国"
                        value={compareDest}
                        onChange={v => { setCompareDest(v); setCompareResult(null); }}
                        showSearch
                        options={countryOptions}
                        optionFilterProp="label"
                      />
                    </Col>
                  </Row>
                  {compareError && <Alert type="error" message={compareError} closable onClose={() => setCompareError('')} />}
                  <Button type="primary" size="large" onClick={handleCompare} loading={compareLoading}
                    icon={<TrophyOutlined />} block>
                    查找最优税率路径
                  </Button>
                </Space>
              </Card>

              {compareLoading && (
                <Card><Skeleton active paragraph={{ rows: 8 }} /></Card>
              )}

              {compareResult && !compareLoading && (
                <>
                  {/* Summary Header */}
                  <Card style={{ marginBottom: 16 }}>
                    <Row gutter={24} align="middle">
                      <Col flex="auto">
                        <div style={{ fontSize: 12, color: '#999' }}>出口至 {compareResult.destinationName} ({compareResult.destinationCountry})</div>
                        <Space align="baseline" size={12}>
                          <span style={{ fontSize: 28, fontWeight: 700, fontFamily: 'monospace' }}>
                            {compareResult.hsCode}
                          </span>
                          <Tag color="blue">{compareResult.classification}</Tag>
                        </Space>
                      </Col>
                      <Col>
                        {compareResult.bestRoute ? (
                          <Result
                            style={{ padding: 0 }}
                            icon={<TrophyOutlined style={{ color: '#faad14', fontSize: 48 }} />}
                            title={<span style={{ fontSize: 16 }}>最优路径</span>}
                            subTitle={
                              <span style={{ fontSize: 24, fontWeight: 700, color: '#389e0d' }}>
                                {compareResult.bestRoute.ftaShortName} {compareResult.bestRoute.tariffRate}%
                              </span>
                            }
                          />
                        ) : (
                          <Result style={{ padding: 0 }} icon={<CloseCircleOutlined style={{ color: '#999', fontSize: 48 }} />}
                            title="无FTA覆盖" subTitle="该目的国暂无适用的自贸协定" />
                        )}
                      </Col>
                    </Row>
                  </Card>

                  {/* Rate Comparison Stats */}
                  <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
                    <Col xs={12} sm={6}>
                      <Card size="small" style={{ textAlign: 'center' }}>
                        <Statistic title="MFN基准税率" value={compareResult.mfnRate != null ? `${compareResult.mfnRate}%` : '—'}
                          valueStyle={{ color: '#8c8c8c', fontSize: 24 }} />
                      </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                      <Card size="small" style={{ textAlign: 'center', background: compareResult.bestRoute ? 'linear-gradient(135deg, #f6ffed, #d9f7be)' : undefined }}>
                        <Statistic title="最优FTA税率" value={compareResult.bestRoute ? `${compareResult.bestRoute.tariffRate}%` : '—'}
                          valueStyle={{ color: '#389e0d', fontSize: 24 }} />
                        <div style={{ fontSize: 11, color: '#389e0d' }}>{compareResult.bestRoute?.ftaShortName || ''}</div>
                      </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                      <Card size="small" style={{ textAlign: 'center' }}>
                        <Statistic title="最高节省" value={
                          compareResult.mfnRate != null && compareResult.bestRoute?.tariffRate != null
                            ? `${(compareResult.mfnRate - compareResult.bestRoute.tariffRate).toFixed(1)}%`
                            : '—'
                        } valueStyle={{ color: '#cf1322', fontSize: 24 }} />
                        <div style={{ fontSize: 11, color: '#bbb' }}>MFN - 最优FTA</div>
                      </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                      <Card size="small" style={{ textAlign: 'center' }}>
                        <Statistic title="适用FTA数" value={compareResult.routes.length}
                          valueStyle={{ color: '#1677ff', fontSize: 24 }} />
                        <div style={{ fontSize: 11, color: '#bbb' }}>共 {compareResult.applicableFtas?.length || 0} 个协定覆盖</div>
                      </Card>
                    </Col>
                  </Row>

                  {/* FTA Route Table */}
                  {compareResult.routes.length > 0 && (
                    <Card title={<span><TrophyOutlined /> FTA路径比对 — 出口至{compareResult.destinationName}</span>} size="small" style={{ marginBottom: 16 }}>
                      <Table size="small" pagination={false} scroll={{ x: 700 }}
                        dataSource={[
                          { key: 'mfn', ftaShortName: 'MFN', ftaName: '最惠国待遇', tariffRate: compareResult.mfnRate, ruleType: '—', ruleDetail: '基准税率（无优惠）', source: 'WTO', certificates: [] },
                          ...compareResult.routes.map((r: any) => ({ key: r.ftaShortName, ...r })),
                        ]}
                        columns={[
                          { title: '税率来源', dataIndex: 'ftaName', key: 'ftaName', width: 220,
                            render: (v: string, r: any) => (
                              <Space>
                                <span style={{ fontWeight: r.key === 'mfn' ? 400 : 600 }}>{v}</span>
                                {r.key !== 'mfn' && <Tag color={({ RCEP: '#52c41a', CAFTA: '#1677ff', CKFTA: '#722ed1', CHAFTA: '#fa8c16', CCFTA: '#eb2f96' } as Record<string, string>)[r.ftaShortName] || 'default'}>{r.ftaShortName}</Tag>}
                              </Space>
                            ),
                          },
                          { title: '优惠税率', dataIndex: 'tariffRate', key: 'tariffRate', width: 90, align: 'center',
                            render: (v: number | null, r: any) => v != null
                              ? <span style={{ fontWeight: 700, fontSize: 16, color: r.key === compareResult.bestRoute?.ftaShortName ? '#389e0d' : undefined }}>{v}%</span>
                              : <span style={{ color: '#ccc' }}>—</span> },
                          { title: '规则类型', dataIndex: 'ruleType', key: 'ruleType', width: 100, align: 'center',
                            render: (v: string) => v && v !== '—' ? <Tag color={ruleTypeColorMap[v] || 'default'}>{ruleTypeLabelMap[v] || v}</Tag> : <span style={{ color: '#ccc' }}>—</span> },
                          { title: '规则说明', dataIndex: 'ruleDetail', key: 'ruleDetail', ellipsis: true },
                          { title: '依据', dataIndex: 'source', key: 'source', width: 140, render: (v: string) => v || '—' },
                        ]}
                      />
                    </Card>
                  )}

                  {/* No FTA coverage warning */}
                  {compareResult.routes.length === 0 && (
                    <Alert type="warning" style={{ marginBottom: 16 }}
                      message="暂无可用的FTA优惠"
                      description={`中国与${compareResult.destinationName}之间暂无生效的自由贸易协定。建议使用MFN税率(${compareResult.mfnRate != null ? compareResult.mfnRate + '%' : '未知'})，或关注正在谈判中的贸易协定。`}
                    />
                  )}

                  {/* Certificate requirements for best route */}
                  {compareResult.bestRoute && (
                    <Card title={<span><FileProtectOutlined /> 所需单证 — {compareResult.bestRoute.ftaShortName} 最优路径</span>} size="small" style={{ marginBottom: 16 }}>
                      <List size="small"
                        dataSource={compareResult.bestRoute.certificates || []}
                        renderItem={(item: any) => (
                          <List.Item>
                            <Space>
                              {item.required
                                ? <Tag color="red">必需</Tag>
                                : <Tag color="default">建议</Tag>}
                              <Typography.Text strong>{item.name}</Typography.Text>
                              <Typography.Text type="secondary">{item.description}</Typography.Text>
                            </Space>
                          </List.Item>
                        )}
                      />
                    </Card>
                  )}

                  {/* Other FTA certificates (collapsible info) */}
                  {compareResult.routes.length > 1 && (
                    <Card title="其他FTA路径单证要求" size="small">
                      {compareResult.routes.filter((r: any) => r.ftaShortName !== compareResult.bestRoute?.ftaShortName).map((route: any) => (
                        <Card key={route.ftaShortName} size="small" style={{ marginBottom: 8 }}
                          title={<Space><Tag color={({ RCEP: '#52c41a', CAFTA: '#1677ff', CKFTA: '#722ed1', CHAFTA: '#fa8c16', CCFTA: '#eb2f96' } as Record<string, string>)[route.ftaShortName] || 'default'}>{route.ftaShortName}</Tag> {route.tariffRate}%</Space>}>
                          <List size="small"
                            dataSource={route.certificates || []}
                            renderItem={(item: any) => (
                              <List.Item>
                                <Space>
                                  {item.required ? <Tag color="red">必需</Tag> : <Tag color="default">建议</Tag>}
                                  <Typography.Text>{item.name}</Typography.Text>
                                </Space>
                              </List.Item>
                            )}
                          />
                        </Card>
                      ))}
                    </Card>
                  )}
                </>
              )}
            </>
          ),
        },
      ]} />
    </div>
  );
}
