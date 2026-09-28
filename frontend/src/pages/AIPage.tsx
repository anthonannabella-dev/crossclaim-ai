import { useState, useRef } from 'react';
import { Input, Card, Button, Tag, Divider, Alert, Tabs, Descriptions, Space, Select, Table, Statistic, Row, Col, message, Progress, Skeleton, Upload } from 'antd';
import { RobotOutlined, AlertOutlined, CheckCircleOutlined, FileTextOutlined, DollarOutlined, BulbOutlined, WarningOutlined, DownloadOutlined, CameraOutlined, SearchOutlined, TrophyOutlined, PercentageOutlined, FireOutlined } from '@ant-design/icons';
import api from '../utils/api';

const COMMON_REJECTIONS = [
  { code: 'HS001', reason: 'HS编码归类不准确', category: 'classification' },
  { code: 'HS002', reason: '申报价格异常', category: 'valuation' },
  { code: 'HS003', reason: '原产地证明不完整', category: 'origin' },
  { code: 'HS004', reason: '许可证件缺失', category: 'license' },
  { code: 'HS005', reason: '单证信息不一致', category: 'document' },
  { code: 'HS006', reason: '检验检疫未完成', category: 'inspection' },
  { code: 'CBAM001', reason: 'CBAM碳排放数据不完整', category: 'cbam' },
  { code: 'RCEP001', reason: 'RCEP原产地声明不符合要求', category: 'rcep' },
];

const ftaColorMap: Record<string, string> = {
  RCEP: '#52c41a', CAFTA: '#1677ff', CKFTA: '#722ed1',
  CHAFTA: '#fa8c16', CCFTA: '#eb2f96',
};

export default function AIPage() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('classify');
  const [rejectionCode, setRejectionCode] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [exporting, setExporting] = useState(false);
  const [imageBase64, setImageBase64] = useState<string | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClassify = async () => {
    if (!question.trim() && !imageBase64) { message.warning('请输入商品描述或上传商品图片'); return; }
    setLoading(true);
    setResult(null);
    try {
      const res = await api.post('/api/ai/smart-classify', { description: question, imageBase64 });
      setResult({ type: 'classify', data: res.data.data });
    } catch (err: any) {
      message.error(err.response?.data?.error || '智能归类失败');
    } finally {
      setLoading(false);
    }
  };

  const handleImageUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      setImageBase64(base64);
      message.success('图片已上传，点击"智能归类"开始识别');
    };
    reader.readAsDataURL(file);
    return false;
  };

  const handleDiagnose = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await api.post('/api/ai/diagnose', {
        rejectionCode: rejectionCode || 'CUSTOM',
        rejectionReason: rejectionReason || question,
      });
      setResult({ type: 'diagnose', data: res.data });
    } finally {
      setLoading(false);
    }
  };

  const handleAEOReport = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await api.post('/api/ai/aeo-report');
      setResult({ type: 'aeo', data: res.data });
    } finally {
      setLoading(false);
    }
  };

  const handleReconciliation = async () => {
    setLoading(true);
    setResult(null);
    try {
      const end = new Date().toISOString();
      const start = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const res = await api.post('/api/ai/financial-reconciliation', { startDate: start, endDate: end });
      setResult({ type: 'finance', data: res.data });
    } finally {
      setLoading(false);
    }
  };

  const handleExportTransactions = async () => {
    setExporting(true);
    try {
      const res = await api.get('/api/ai/export-transactions');
      const csv = [
        '订单号,金额,套餐,付费周期,支付方式,状态,时间',
        ...res.data.map((p: any) =>
          `${p.transactionId || ''},${p.amount || ''},${p.planTier || ''},${p.paymentCycle || ''},${p.paymentMethod || ''},${p.status || ''},${p.createdAt || ''}`
        ),
      ].join('\n');

      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `transactions_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
      message.success(`导出 ${res.data.length} 条交易记录`);
    } catch {
      message.error('导出失败');
    } finally {
      setExporting(false);
    }
  };

  const statusColor = (status: string) => {
    if (status === 'compliant') return 'green';
    if (status === 'needs_attention') return 'orange';
    return 'red';
  };

  const statusLabel = (status: string) => {
    if (status === 'compliant') return '合规';
    if (status === 'needs_attention') return '需关注';
    return '不合规';
  };

  const classifyResult = result?.type === 'classify' ? result.data : null;
  const diagnoseResult = result?.type === 'diagnose' ? result.data : null;
  const aeoResult = result?.type === 'aeo' ? result.data : null;
  const financeResult = result?.type === 'finance' ? result.data : null;

  const bestFta = classifyResult?.tariffs?.ftas?.[0];
  const mfnRate = classifyResult?.tariffs?.mfn?.rate;

  return (
    <div>
      <h2><RobotOutlined /> AI智能助手</h2>

      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        {
          key: 'classify',
          label: <span><SearchOutlined /> 智能归类+税率</span>,
          children: (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Space.Compact style={{ width: '100%' }}>
                  <Input size="large" value={question} onChange={e => setQuestion(e.target.value)}
                    onPressEnter={handleClassify}
                    placeholder="输入商品名称或描述，如：单晶硅光伏组件 峰值功率600W 或 棉制针织男式T恤"
                    prefix={<RobotOutlined style={{ color: '#1677ff' }} />}
                    suffix={
                      <Upload accept="image/*" showUploadList={false} beforeUpload={handleImageUpload}>
                        <Button size="small" icon={<CameraOutlined />} type="text" title="上传商品图片识别" />
                      </Upload>
                    }
                  />
                  <Button type="primary" size="large" onClick={handleClassify} loading={loading} icon={<SearchOutlined />}>
                    智能归类
                  </Button>
                </Space.Compact>
                {imageBase64 && <Tag color="blue" style={{ marginTop: 8 }} closable onClose={() => setImageBase64(undefined)}><CameraOutlined /> 已上传图片 (将OCR识别后归类)</Tag>}
              </Card>

              {loading && (
                <Card><Skeleton active paragraph={{ rows: 6 }} /></Card>
              )}

              {classifyResult && !loading && (
                <>
                  {/* HS Code Result */}
                  <Card style={{ marginBottom: 16 }}>
                    <Row gutter={24} align="middle">
                      <Col flex="auto">
                        <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>AI归类结果</div>
                        <Space align="baseline" size={12}>
                          <span style={{ fontSize: 36, fontWeight: 700, fontFamily: 'monospace', letterSpacing: 2 }}>
                            {classifyResult.hsCode || '—'}
                          </span>
                          <Tag color={classifyResult.confidence >= 0.8 ? 'success' : classifyResult.confidence >= 0.6 ? 'warning' : 'error'}
                            style={{ fontSize: 14, padding: '2px 12px' }}>
                            置信度 {Math.round(classifyResult.confidence * 100)}%
                          </Tag>
                        </Space>
                        <div style={{ marginTop: 8, color: '#666' }}>{classifyResult.classification}</div>
                        {classifyResult.ocrText && (
                          <Alert style={{ marginTop: 8 }} type="info" message={`OCR识别: ${classifyResult.ocrText.slice(0, 200)}`} />
                        )}
                      </Col>
                      <Col>
                        <Progress type="circle" percent={Math.round(classifyResult.confidence * 100)} size={80}
                          strokeColor={classifyResult.confidence >= 0.8 ? '#52c41a' : classifyResult.confidence >= 0.6 ? '#faad14' : '#ff4d4f'} />
                      </Col>
                    </Row>
                    <Divider style={{ margin: '12px 0' }} />
                    <Space size={4} wrap>
                      <span style={{ color: '#999', fontSize: 12 }}>依据: {classifyResult.source || '—'}</span>
                      <span style={{ color: '#999', fontSize: 12 }}>· {classifyResult.suggestion}</span>
                    </Space>
                    {classifyResult.alternatives?.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <span style={{ fontSize: 12, color: '#999' }}>备选编码: </span>
                        {classifyResult.alternatives.map((a: any, i: number) => (
                          <Tag key={i} style={{ marginTop: 4 }}>{a.code} {a.desc}</Tag>
                        ))}
                      </div>
                    )}
                  </Card>

                  {/* Tariff Comparison */}
                  {classifyResult.tariffs && (
                    <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
                      {/* MFN Rate Card */}
                      <Col xs={12} sm={6}>
                        <Card size="small" style={{ textAlign: 'center', height: '100%' }}>
                          <div style={{ fontSize: 12, color: '#999' }}>最惠国税率 (MFN)</div>
                          <div style={{ fontSize: 32, fontWeight: 700, color: '#8c8c8c' }}>
                            {mfnRate != null ? `${mfnRate}%` : '—'}
                          </div>
                          <div style={{ fontSize: 11, color: '#bbb' }}>基准税率</div>
                        </Card>
                      </Col>
                      {/* Best FTA Card */}
                      <Col xs={12} sm={6}>
                        <Card size="small" style={{
                          textAlign: 'center', height: '100%',
                          background: bestFta ? 'linear-gradient(135deg, #f6ffed 0%, #d9f7be 100%)' : undefined,
                          border: bestFta ? '1px solid #b7eb8f' : undefined,
                        }}>
                          <div style={{ fontSize: 12, color: '#999' }}>
                            <TrophyOutlined style={{ color: '#faad14' }} /> 最优FTA税率
                          </div>
                          <div style={{ fontSize: 32, fontWeight: 700, color: bestFta ? '#389e0d' : '#8c8c8c' }}>
                            {bestFta?.rate != null ? `${bestFta.rate}%` : '—'}
                          </div>
                          <div style={{ fontSize: 12, color: bestFta ? '#389e0d' : '#bbb' }}>
                            {bestFta ? `${bestFta.shortName} ${bestFta.ruleType}` : '暂无可用FTA'}
                          </div>
                        </Card>
                      </Col>
                      {/* Savings */}
                      <Col xs={12} sm={6}>
                        <Card size="small" style={{ textAlign: 'center', height: '100%' }}>
                          <div style={{ fontSize: 12, color: '#999' }}>
                            <PercentageOutlined /> 最高节税率
                          </div>
                          <div style={{ fontSize: 32, fontWeight: 700, color: mfnRate && bestFta?.rate ? '#cf1322' : '#8c8c8c' }}>
                            {mfnRate && bestFta?.rate ? `${(mfnRate - bestFta.rate).toFixed(1)}%` : '—'}
                          </div>
                          <div style={{ fontSize: 11, color: '#bbb' }}>MFN - 最优FTA</div>
                        </Card>
                      </Col>
                      {/* CBAM */}
                      <Col xs={12} sm={6}>
                        <Card size="small" style={{ textAlign: 'center', height: '100%',
                          background: classifyResult.cbam ? '#fff7e6' : undefined }}>
                          <div style={{ fontSize: 12, color: '#999' }}>
                            <FireOutlined style={{ color: '#fa541c' }} /> 碳关税风险
                          </div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: classifyResult.cbam?.riskLevel === 'high' ? '#cf1322' : '#8c8c8c' }}>
                            {classifyResult.cbam ? ({ low: '低风险', medium: '中风险', high: '高风险', unknown: '未知' } as Record<string, string>)[classifyResult.cbam.riskLevel] || '未知' : '暂无数据'}
                          </div>
                          <div style={{ fontSize: 11, color: '#bbb' }}>
                            {classifyResult.cbam?.estimatedCost ? `预估 €${classifyResult.cbam.estimatedCost}` : 'CBAM'}
                          </div>
                        </Card>
                      </Col>
                    </Row>
                  )}

                  {/* FTA Rate Table */}
                  {classifyResult.tariffs?.ftas?.length > 0 && (
                    <Card title={<span><TrophyOutlined /> FTA优惠税率对比</span>} size="small" style={{ marginBottom: 16 }}>
                      <Table size="small" pagination={false} dataSource={[
                        { key: 'mfn', type: 'MFN基准', shortName: 'MFN', rate: mfnRate, ruleType: '—', ruleDetail: '最惠国待遇' },
                        ...classifyResult.tariffs.ftas.map((f: any) => ({ key: f.shortName, type: f.name, ...f })),
                      ]} columns={[
                        { title: '税率来源', dataIndex: 'type', key: 'type', width: 200,
                          render: (v: string, r: any) => (
                            <Space>
                              <span style={{ fontWeight: r.key === 'mfn' ? 400 : 600 }}>{v}</span>
                              {r.key !== 'mfn' && <Tag color={ftaColorMap[r.shortName] || 'default'} style={{ fontSize: 10 }}>{r.shortName}</Tag>}
                            </Space>
                          ) },
                        { title: '税率', dataIndex: 'rate', key: 'rate', width: 80, align: 'center',
                          render: (v: number | null) => v != null ? <span style={{ fontWeight: 600, fontSize: 16, color: v === bestFta?.rate ? '#389e0d' : undefined }}>{v}%</span> : '—' },
                        { title: '规则类型', dataIndex: 'ruleType', key: 'ruleType', width: 90, align: 'center',
                          render: (v: string) => v ? <Tag>{v}</Tag> : '—' },
                        { title: '规则说明', dataIndex: 'ruleDetail', key: 'ruleDetail', ellipsis: true },
                      ]} />
                    </Card>
                  )}

                  {/* RCEP Analysis */}
                  {classifyResult.rcepAnalysis && (
                    <Card title="RCEP深度分析" size="small" style={{ marginBottom: 16 }}>
                      <Descriptions column={{ xs: 1, sm: 2 }} size="small">
                        <Descriptions.Item label="原产地标准">{classifyResult.rcepAnalysis.originCriteria || '—'}</Descriptions.Item>
                        <Descriptions.Item label="节省分析">{classifyResult.rcepAnalysis.savings || '—'}</Descriptions.Item>
                      </Descriptions>
                      {classifyResult.rcepAnalysis.analysis && (
                        <Alert style={{ marginTop: 8 }} type="info" message={classifyResult.rcepAnalysis.analysis} />
                      )}
                    </Card>
                  )}
                </>
              )}
            </>
          ),
        },
        {
          key: 'diagnose',
          label: <span><AlertOutlined /> 退单诊断</span>,
          children: (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Select
                    style={{ width: '100%' }}
                    placeholder="选择常见退单原因（可选）"
                    allowClear
                    onChange={(val) => {
                      setRejectionCode(val || '');
                      const found = COMMON_REJECTIONS.find(r => r.code === val);
                      if (found) setRejectionReason(found.reason);
                    }}
                    options={COMMON_REJECTIONS.map(r => ({ label: `${r.code}: ${r.reason}`, value: r.code }))}
                  />
                  <Input.TextArea rows={3} value={rejectionReason}
                    onChange={e => setRejectionReason(e.target.value)}
                    placeholder="或直接输入退单原因描述，AI将智能诊断并给出修复方案" />
                  <Button type="primary" onClick={handleDiagnose} loading={loading} icon={<BulbOutlined />}>智能诊断修复</Button>
                </Space>
              </Card>

              {diagnoseResult && (
                <Card title={`退单诊断: ${diagnoseResult.rejectionCode}`}>
                  <Alert type="warning" message={`原退单原因: ${diagnoseResult.originalReason}`} style={{ marginBottom: 16 }} />
                  <Descriptions column={1}>
                    <Descriptions.Item label="AI诊断根因">{diagnoseResult.aiDiagnosis}</Descriptions.Item>
                    <Descriptions.Item label="预计修复时间">{diagnoseResult.estimatedFixTime}</Descriptions.Item>
                    <Descriptions.Item label="相似历史案例">{diagnoseResult.similarCases} 条</Descriptions.Item>
                  </Descriptions>

                  <Divider>修复步骤</Divider>
                  {diagnoseResult.fixSteps?.map((step: string, i: number) => (
                    <p key={i}><CheckCircleOutlined style={{ color: 'green' }} /> {step}</p>
                  ))}

                  {diagnoseResult.docSuggestions?.length > 0 && (
                    <>
                      <Divider>关联单证建议</Divider>
                      {diagnoseResult.docSuggestions.map((s: string, i: number) => (
                        <p key={i}><WarningOutlined style={{ color: 'orange' }} /> {s}</p>
                      ))}
                    </>
                  )}

                  <Divider>预防建议</Divider>
                  {diagnoseResult.preventionTips?.map((tip: string, i: number) => (
                    <p key={i}><BulbOutlined style={{ color: 'blue' }} /> {tip}</p>
                  ))}
                </Card>
              )}
            </>
          ),
        },
        {
          key: 'aeo',
          label: <span><FileTextOutlined /> AEO报告</span>,
          children: (
            <>
              <Card style={{ marginBottom: 16 }}>
                <p>AEO年度自查报告将自动收集您的单证、归类、财务、审计数据，生成合规评估报告。</p>
                <Button type="primary" onClick={handleAEOReport} loading={loading} icon={<FileTextOutlined />}>生成AEO年度报告</Button>
              </Card>

              {aeoResult && (
                <Card title={`AEO年度自查报告 — ${aeoResult.reportYear}年度`}>
                  <Alert
                    type={aeoResult.overallStatus === 'compliant' ? 'success' : 'warning'}
                    message={`综合评估: ${aeoResult.overallStatus === 'compliant' ? '合规' : '需关注'}`}
                    style={{ marginBottom: 16 }}
                  />
                  <Descriptions column={{ xs: 1, sm: 2 }}>
                    <Descriptions.Item label="企业">{aeoResult.enterpriseName}</Descriptions.Item>
                    <Descriptions.Item label="套餐">{aeoResult.planTier}</Descriptions.Item>
                    <Descriptions.Item label="报告年份">{aeoResult.reportYear}年度</Descriptions.Item>
                    <Descriptions.Item label="生成时间">{new Date(aeoResult.generatedAt).toLocaleString()}</Descriptions.Item>
                  </Descriptions>

                  <Divider>各维度评估</Divider>
                  {aeoResult.sections?.map((section: any, i: number) => (
                    <Card key={i} size="small" style={{ marginBottom: 8 }}
                      title={<Space>{section.title} <Tag color={statusColor(section.status)}>{statusLabel(section.status)}</Tag></Space>}>
                      {Object.keys(section.details || {}).length > 0 && (
                        <Descriptions size="small" column={2}>
                          {Object.entries(section.details).map(([k, v]: [string, any]) => (
                            <Descriptions.Item key={k} label={k}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</Descriptions.Item>
                          ))}
                        </Descriptions>
                      )}
                      {section.recommendations?.length > 0 && (
                        <>
                          <Divider style={{ margin: '8px 0' }}>建议</Divider>
                          {section.recommendations.map((r: string, j: number) => <p key={j} style={{ margin: 0 }}>• {r}</p>)}
                        </>
                      )}
                    </Card>
                  ))}
                </Card>
              )}
            </>
          ),
        },
        {
          key: 'finance',
          label: <span><DollarOutlined /> 财务对账</span>,
          children: (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Space>
                  <Button type="primary" onClick={handleReconciliation} loading={loading}>生成对账报告</Button>
                  <Button icon={<DownloadOutlined />} onClick={handleExportTransactions} loading={exporting}>导出交易记录CSV</Button>
                </Space>
              </Card>

              {financeResult && (
                <>
                  <Card title="收入总览">
                    <Row gutter={[16, 16]}>
                      <Col xs={12} sm={6}><Statistic title="总收入" prefix="¥" value={financeResult.revenue?.total || 0} precision={2} /></Col>
                      <Col xs={12} sm={6}><Statistic title="微信支付" prefix="¥" value={financeResult.revenue?.byPaymentMethod?.wechat || 0} precision={2} /></Col>
                      <Col xs={12} sm={6}><Statistic title="支付宝" prefix="¥" value={financeResult.revenue?.byPaymentMethod?.alipay || 0} precision={2} /></Col>
                      <Col xs={12} sm={6}><Statistic title="交易笔数" value={
                        Object.values(financeResult.revenue?.byPaymentMethod || {}).reduce((s: number, v: any) => s + (typeof v === 'number' ? v : 0), 0)
                      } /></Col>
                    </Row>
                  </Card>

                  <Card title="收入分析" style={{ marginTop: 16 }}>
                    <Tabs items={[
                      {
                        key: 'byPlan',
                        label: '按套餐',
                        children: financeResult.revenue?.byPlanTier ? (
                          <Descriptions column={{ xs: 1, sm: 2, md: 3 }}>
                            {Object.entries(financeResult.revenue.byPlanTier).map(([k, v]: [string, any]) => (
                              <Descriptions.Item key={k} label={k}>¥{v}</Descriptions.Item>
                            ))}
                          </Descriptions>
                        ) : <p>暂无数据</p>,
                      },
                      {
                        key: 'byCycle',
                        label: '按周期',
                        children: financeResult.revenue?.byPaymentCycle ? (
                          <Descriptions column={{ xs: 1, sm: 2 }}>
                            {Object.entries(financeResult.revenue.byPaymentCycle).map(([k, v]: [string, any]) => (
                              <Descriptions.Item key={k} label={k === 'ANNUAL' ? '年付' : k === 'MONTHLY' ? '月付' : k}>¥{v}</Descriptions.Item>
                            ))}
                          </Descriptions>
                        ) : <p>暂无数据</p>,
                      },
                      {
                        key: 'monthly',
                        label: '月度趋势',
                        children: financeResult.revenue?.monthly ? (
                          <Table size="small" dataSource={financeResult.revenue.monthly.map((m: any, i: number) => ({ ...m, key: i }))}
                            columns={[
                              { title: '月份', dataIndex: 'month', key: 'month' },
                              { title: '金额', dataIndex: 'amount', key: 'amount', render: (v: number) => `¥${v.toFixed(2)}` },
                            ]}
                            pagination={false}
                          />
                        ) : <p>暂无数据</p>,
                      },
                    ]} />
                  </Card>

                  <Card title="订阅统计" style={{ marginTop: 16 }}>
                    <Row gutter={[16, 16]}>
                      <Col xs={12} sm={6}><Statistic title="活跃" value={financeResult.subscriptions?.active || 0} valueStyle={{ color: '#3f8600' }} /></Col>
                      <Col xs={12} sm={6}><Statistic title="试用中" value={financeResult.subscriptions?.trial || 0} valueStyle={{ color: '#1890ff' }} /></Col>
                      <Col xs={12} sm={6}><Statistic title="已冻结" value={financeResult.subscriptions?.frozen || 0} valueStyle={{ color: '#cf1322' }} /></Col>
                      <Col xs={12} sm={6}><Statistic title="流失率" value={financeResult.subscriptions?.churnRate || '0%'} /></Col>
                    </Row>
                  </Card>

                  <Card title="开票统计" style={{ marginTop: 16 }}>
                    <Row gutter={[16, 16]}>
                      <Col xs={24} sm={12}><Statistic title="已开票" value={financeResult.invoices?.requested || 0} /></Col>
                      <Col xs={24} sm={12}><Statistic title="待开票" value={financeResult.invoices?.pending || 0} /></Col>
                    </Row>
                  </Card>
                </>
              )}
            </>
          ),
        },
      ]} />
    </div>
  );
}
