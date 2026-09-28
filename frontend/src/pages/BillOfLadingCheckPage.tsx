import React, { useState, useEffect } from 'react';
import { Card, Input, Button, Table, Tag, Descriptions, Statistic, Row, Col, Space, Alert, Collapse, Modal, Tabs, Empty, message, Spin, Select } from 'antd';
import { SearchOutlined, CheckCircleOutlined, CloseCircleOutlined, WarningOutlined, HistoryOutlined, AuditOutlined, DownloadOutlined } from '@ant-design/icons';
import axios from 'axios';

const token = localStorage.getItem('token');
const api = axios.create({
  baseURL: '/api',
  headers: { Authorization: 'Bearer ' + token },
});

const statusColor: Record<string, string> = {
  passed: 'success', failed: 'error', warning: 'warning',
};

const docTypeLabels: Record<string, string> = {
  commercial_invoice: '商业发票', packing_list: '装箱单',
  bill_of_lading: '提单', certificate_of_origin: '原产地证书',
  customs_declaration: '报关单',
  order_document: '订单单', payment_document: '支付单',
  logistics_document: '物流单', customs_power_of_attorney: '报关委托书',
};

export default function BillOfLadingCheckPage() {
  const [blNo, setBlNo] = useState('');
  const [searchBL, setSearchBL] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyBL, setHistoryBL] = useState('');
  const [recentBLs, setRecentBLs] = useState<{ value: string; label: string; count: number }[]>([]);

  useEffect(() => {
    api.get('/documents/bill-of-lading/groups')
      .then(res => {
        if (res.data?.success && Array.isArray(res.data.data)) {
          setRecentBLs(res.data.data.slice(0, 50).map((g: any) => ({
            value: g.billOfLading,
            label: g.billOfLading + '（' + (g.documentCount || 0) + '份单证）',
            count: g.documentCount || 0,
          })));
        }
      })
      .catch(() => { /* 无历史提单时静默 */ });
    // 支持从「提单管理」等页携带 ?bl= 直达并自动比对
    try {
      const blParam = new URLSearchParams(window.location.search).get('bl');
      if (blParam) { setBlNo(blParam); setTimeout(() => { void runCrossCheck(blParam); }, 0); }
    } catch { /* ignore */ }
  }, []);

  const doCrossCheckFor = (bl: string) => {
    setBlNo(bl);
    setTimeout(() => { void runCrossCheck(bl); }, 0);
  };

  const runCrossCheck = async (bl: string) => {
    if (!bl.trim()) { message.warning('请输入提运单号'); return; }
    setLoading(true);
    setResult(null);
    try {
      const res = await api.post('/documents/cross-check/by-bl', { blNo: bl.trim() });
      if (res.data.success) {
        setResult(res.data.data);
        setSearchBL(bl.trim());
      } else {
        message.error(res.data.error || '交叉比对失败');
      }
    } catch { message.error('请求失败'); }
    setLoading(false);
  };

  const exportReport = () => {
    if (!result) return;
    const lines: string[] = [];
    lines.push('提运单号,' + (result.blNo || ''));
    lines.push('单证数,' + (result.summary?.total ?? 0) + ',通过,' + (result.summary?.passed ?? 0) + ',总体结论,' + (result.overallPassed ? '全部通过' : '存在不一致'));
    lines.push('');
    lines.push('单证对,检查项,结果,明细');
    (result.crossChecks || []).forEach((cc: any) => {
      const d1 = result.documents.find((d: any) => d.documentId === cc.documentPair?.[0]);
      const d2 = result.documents.find((d: any) => d.documentId === cc.documentPair?.[1]);
      const pair = (d1?.docTypeLabel || '?') + ' vs ' + (d2?.docTypeLabel || '?');
      (cc.checks || []).forEach((c: any) => {
        lines.push([pair, c.name, c.passed ? '一致' : '不一致', c.detail || ''].map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(','));
      });
    });
    const csv = '\uFEFF' + lines.join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = '提单核对报告_' + (result.blNo || 'bl') + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    message.success('核对报告已导出');
  };

  const doCrossCheck = async () => {
    if (!blNo.trim()) { message.warning('请输入提运单号'); return; }
    setLoading(true);
    setResult(null);
    try {
      const res = await api.post('/documents/cross-check/by-bl', { blNo: blNo.trim() });
      if (res.data.success) {
        setResult(res.data.data);
        setSearchBL(blNo.trim());
      } else {
        message.error(res.data.error || '交叉比对失败');
      }
    } catch { message.error('请求失败'); }
    setLoading(false);
  };

  const fetchHistory = async (bl: string) => {
    if (!bl) return;
    setHistoryLoading(true);
    setShowHistory(true);
    setHistoryBL(bl);
    try {
      const res = await api.get('/documents/history/by-bl/' + encodeURIComponent(bl));
      if (res.data.success) setHistory(res.data.data);
      else setHistory([]);
    } catch { setHistory([]); }
    setHistoryLoading(false);
  };

  return (
    <div>
      <Card title={<span><AuditOutlined /> 提单同组交叉比对</span>}>
        <Row gutter={[16, 12]} align="middle">
          <Col flex="auto">
            <Input.Search
              prefix={<SearchOutlined />}
              placeholder="输入提运单号（如 COSU1234567）"
              value={blNo}
              onChange={e => setBlNo(e.target.value)}
              onSearch={doCrossCheck}
              enterButton="开始比对"
              size="large"
              allowClear
            />
          </Col>
          <Col>
            <Button icon={<HistoryOutlined />} onClick={() => fetchHistory(blNo.trim() || searchBL)} disabled={!blNo.trim() && !searchBL}>
              历史复核
            </Button>
          </Col>
          {recentBLs.length > 0 && (
            <Col span={24}>
              <Space wrap size={4} align="center">
                <span style={{ color: '#888', fontSize: 13 }}>最近提单：</span>
                <Select
                  showSearch
                  size="small"
                  style={{ minWidth: 280 }}
                  placeholder="从已归集提单中选择，自动比对"
                  options={recentBLs}
                  value={undefined}
                  optionFilterProp="label"
                  onChange={(v?: string) => { if (v) doCrossCheckFor(v); }}
                />
              </Space>
            </Col>
          )}
        </Row>
      </Card>

      <Spin spinning={loading}>
        {result && (
          <>
            <Card style={{ marginTop: 16 }}>
              <Row gutter={16}>
                <Col span={6}><Statistic title="提运单号" value={result.blNo} valueStyle={{ fontSize: 18 }} /></Col>
                <Col span={6}>
                  <Statistic title="单证数" value={result.summary.total} suffix="份"
                    valueStyle={{ color: result.summary.total > 0 ? '#1890ff' : '#999' }} />
                </Col>
                <Col span={6}>
                  <Statistic title="通过" value={result.summary.passed} suffix={'/' + result.summary.total}
                    valueStyle={{ color: result.summary.passed === result.summary.total ? '#52c41a' : '#faad14' }} />
                </Col>
                <Col span={6}>
                  {result.overallPassed
                    ? <Tag color="success" style={{ padding: '4px 16px', fontSize: 14 }}><CheckCircleOutlined /> 全部通过</Tag>
                    : <Tag color="error" style={{ padding: '4px 16px', fontSize: 14 }}><CloseCircleOutlined /> 存在不一致</Tag>
                  }
                  <Button size="small" icon={<DownloadOutlined />} style={{ marginLeft: 12 }} onClick={exportReport}>
                    下载核对报告
                  </Button>
                </Col>
              </Row>
            </Card>

            {result.crossChecks.length > 0 && (
              <Card title="交叉比对结果" style={{ marginTop: 16 }}>
                <Table dataSource={result.crossChecks} rowKey={(r: any) => r.documentPair.join('-')}
                  pagination={false} size="small"
                  columns={[
                    { title: '单证对', dataIndex: 'documentPair', key: 'pair', width: 200,
                      render: (_: any, r: any) => {
                        const d1 = result.documents.find((d: any) => d.documentId === r.documentPair[0]);
                        const d2 = result.documents.find((d: any) => d.documentId === r.documentPair[1]);
                        return (d1?.docTypeLabel || '?') + ' vs ' + (d2?.docTypeLabel || '?');
                      }
                    },
                    { title: '检查项', dataIndex: 'checks', key: 'checks',
                      render: (checks: any[]) => (
                        <Space direction="vertical" size={4} style={{ width: '100%' }}>
                          {checks.map((c: any, i: number) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <Tag color={c.passed ? 'success' : 'error'}>{c.passed ? '一致' : '不一致'}</Tag>
                              <strong>{c.name}</strong>
                              <span style={{ color: '#888' }}>{c.detail}</span>
                            </div>
                          ))}
                        </Space>
                      ),
                    },
                    { title: '结果', dataIndex: 'passed', key: 'passed', width: 80,
                      render: (p: boolean) => <Tag color={p ? 'success' : 'error'}>{p ? '通过' : '不通过'}</Tag>
                    },
                  ]} />
              </Card>
            )}

            {result.documents.length > 0 && (
              <Card title="单证列表" style={{ marginTop: 16 }}>
                <Table dataSource={result.documents} rowKey="documentId" pagination={false} size="small"
                  columns={[
                    { title: '文件名', dataIndex: 'fileName', key: 'fileName', ellipsis: true },
                    { title: '类型', dataIndex: 'docType', key: 'docType', width: 100,
                      render: (t: string) => <Tag>{docTypeLabels[t] || t}</Tag>
                    },
                    { title: '完整性', dataIndex: 'completeness', key: 'completeness', width: 80,
                      render: (v: number) => <Tag color={v >= 80 ? 'success' : v >= 60 ? 'warning' : 'error'}>{v}%</Tag>
                    },
                    { title: '结果', dataIndex: 'passed', key: 'passed', width: 60,
                      render: (p: boolean) => p ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
                    },
                    {
                      title: '关键字段', dataIndex: 'fields', key: 'fields',
                      render: (fields: any[]) => (
                        <Collapse ghost size="small" items={[{
                          key: 'fields', label: fields.length + ' 个字段',
                          children: <Table dataSource={fields.filter((f: any) => f.value)} rowKey="field" size="small" pagination={false}
                            columns={[
                              { title: '字段', dataIndex: 'label', key: 'label', width: 80 },
                              { title: '值', dataIndex: 'value', key: 'value', width: 120, ellipsis: true },
                              { title: '置信度', dataIndex: 'confidence', key: 'confidence', width: 60,
                                render: (v: number) => (v * 100).toFixed(0) + '%'
                              },
                            ]} />
                        }]} />
                      ),
                    },
                  ]} />
              </Card>
            )}
          </>
        )}
      </Spin>

      <Modal title={<>联动历史复核 - {historyBL}</>}
        open={showHistory} onCancel={() => setShowHistory(false)} footer={null} width={900}>
        <Spin spinning={historyLoading}>
          {history.length === 0 ? (
            <Empty description="该提运单下暂无历史审核记录" />
          ) : (
            <Table dataSource={history} rowKey="documentId" pagination={{ pageSize: 10 }}
              columns={[
                { title: '文件名', dataIndex: 'fileName', key: 'fileName', ellipsis: true },
                { title: '类型', dataIndex: 'docType', key: 'docType', width: 80,
                  render: (t: string) => <Tag>{docTypeLabels[t] || t}</Tag>
                },
                { title: '审核日期', dataIndex: 'auditDate', key: 'auditDate', width: 150,
                  render: (d: string) => new Date(d).toLocaleString('zh-CN')
                },
                { title: '审核人', dataIndex: 'auditedBy', key: 'auditedBy', width: 100 },
                { title: '结果', dataIndex: 'passed', key: 'passed', width: 60,
                  render: (p: boolean) => p
                    ? <Tag icon={<CheckCircleOutlined />} color="success">通过</Tag>
                    : <Tag icon={<CloseCircleOutlined />} color="error">未通过</Tag>
                },
                { title: '完整度', dataIndex: 'completeness', key: 'completeness', width: 60,
                  render: (v: number) => v + '%'
                },
                {
                  title: '字段', dataIndex: 'fields', key: 'fields',
                  render: (fields: any[]) => (
                    <Collapse ghost size="small" items={[{
                      key: 'f', label: fields?.length + ' 个字段',
                      children: <div style={{ fontSize: 12, color: '#666' }}>
                        {fields?.filter((f: any) => f.value).slice(0, 5).map((f: any) => (
                          <div key={f.field}>{f.label}: {String(f.value).slice(0, 30)}</div>
                        ))}
                        {fields?.filter((f: any) => f.value).length > 5 && <div>...</div>}
                      </div>
                    }]} />
                  ),
                },
              ]} />
          )}
        </Spin>
      </Modal>
    </div>
  );
}
