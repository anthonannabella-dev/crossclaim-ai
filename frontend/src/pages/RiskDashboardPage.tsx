import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Row, Col, Card, Table, Tag, Typography, Spin, message, Select, Statistic, Alert, Tooltip, Button, Space } from 'antd';
import {
  WarningOutlined, CheckCircleOutlined, CloseCircleOutlined,
  SafetyCertificateOutlined, InfoCircleOutlined, DownloadOutlined,
} from '@ant-design/icons';

const { Title, Text } = Typography;

interface Validation { checkType: string; status: string; summary: string | null; score: number | null; }
interface RiskGroup {
  id: string;
  billOfLading: string;
  status: string;
  declarationId: string | null;
  preCheckPassed: boolean | null;
  declaredAt: string | null;
  errorMsg: string | null;
  validations: Validation[];
}

// 退单/校验代码 → 含义 + 修改建议（已与预检引擎规则码对齐；E0xx 为常见海关回执码兜底示例）
const REJECT_INFO: Record<string, { label: string; fix: string }> = {
  // —— 海关回执常见码（示例，实际以口岸回执为准）——
  E001:  { label: 'HS编码归类错误', fix: '核对商品成分/用途，参照归类总规则与税则注释重新归类' },
  E002:  { label: '单证不齐全', fix: '补齐发票/箱单/合同/证件，确认签章与有效期' },
  // —— 与预检引擎规则码一一对应 ——
  HS001: { label: '商品描述/品名不完整', fix: '按申报要素补全品名、材质、用途等（至少4字符）' },
  HS002: { label: 'HS编码位数不符', fix: '出口HS编码应为10位，核对税则与申报要素' },
  VAL001:{ label: '申报单价异常偏低', fix: '复核单价是否偏离历史/市场，准备价格佐证防审价' },
  VAL002:{ label: '总金额与明细合计不一致', fix: '核对总价是否等于各项单价×数量之和（金额勾稽）' },
  WGT001:{ label: '毛重小于净重', fix: '毛重应≥净重，核对毛/净重申报值（含包装重量）' },
  FEE001:{ label: '成交方式与运费不匹配', fix: 'CIF/CFR成交价含运费，须在表头申报运费（标记+金额+币制）' },
  CUR001:{ label: '同一报关单多币种', fix: '同一报关单各项币制应一致，统一为成交币制' },
  ORI001:{ label: '缺少原产国', fix: '每项注明原产国（两位国家代码），并与实物MADE IN一致' },
  SPEC001:{ label: '缺少规格型号(申报要素)', fix: '规格型号为必填要素，按品牌/型号/材质/成分填写，缺失将退单' },
  CODE001:{ label: '国别/币制/计量单位无法映射海关代码', fix: '改用海关标准代码或规范名称（国别、币制、法定单位）' },
  ECM001:{ label: '跨境电商缺订单号', fix: '9610/1210/1239 须申报订单号（三单对碰）' },
  ECM002:{ label: '跨境电商缺支付单号', fix: '补充支付企业的支付单号' },
  ECM003:{ label: '跨境电商缺物流单号', fix: '补充物流企业的运单号' },
  ECM004:{ label: '三单对碰异常', fix: '订单/支付/物流单号应不同但指向同一笔交易' },
  ECM005:{ label: '缺电商平台名称', fix: '填写电商平台（Amazon/速卖通/Temu等）' },
  ECM006:{ label: '缺电商平台代码', fix: '填写海关电商平台备案编号（境外无法提供可填“无”）' },
  ECM011:{ label: '9710缺B2B出口单号', fix: '补充跨境电商B2B出口单号' },
  ECM021:{ label: '9810缺海外仓地址', fix: '补充海外仓地址/编码与目的国' },
  // —— 退单原因兜底 ——
  HS003: { label: '原产地证明不完整', fix: '补充原产地证或更正原产国，核对FTA适用' },
  HS004: { label: '许可证件缺失/过期', fix: '补办对应监管证件，确认有效期覆盖申报日（见证件台账）' },
  HS005: { label: '单证信息不一致', fix: '统一发票/箱单/提单/报关单的金额、毛净重、件数、品名' },
};

const CHECK_LABEL: Record<string, string> = { classify: '归类', tariff: '价格/税率', diagnose: '退单诊断' };

// 风险等级红黄绿(item 1)
function riskLevel(g: RiskGroup): 'red' | 'yellow' | 'green' | 'gray' {
  if (['rejected', 'error', 'pre_check_failed'].includes(g.status) || g.preCheckPassed === false) return 'red';
  const risky = (g.validations || []).some(v => v.score != null && v.score < 70);
  if (g.status === 'pending_review' || risky) return 'yellow';
  if (['checked', 'declared', 'customs_review', 'released', 'completed'].includes(g.status)) return 'green';
  return 'gray';
}

// 风险分类标签(item 2)
function riskCats(g: RiskGroup): string[] {
  const cats = new Set<string>();
  (g.validations || []).forEach(v => { if (v.score != null && v.score < 70) cats.add(CHECK_LABEL[v.checkType] || v.checkType); });
  if (g.preCheckPassed === false) cats.add('合规预检');
  const em = g.errorMsg || '';
  if (/证|许可|原产地/.test(em)) cats.add('证件');
  if (/单证|不一致|不齐/.test(em)) cats.add('单证');
  if (/价|金额/.test(em)) cats.add('价格');
  if (/归类|HS|编码/.test(em)) cats.add('归类');
  return [...cats];
}

function parseRejectCode(errorMsg: string | null): string | null {
  if (!errorMsg) return null;
  const m = errorMsg.match(/\[([A-Z0-9]+)\]/);
  return m ? m[1] : null;
}

const LEVEL_META: Record<string, { color: string; label: string }> = {
  red:    { color: '#cf1322', label: '高危' },
  yellow: { color: '#d48806', label: '关注' },
  green:  { color: '#389e0d', label: '正常' },
  gray:   { color: '#999',    label: '处理中' },
};

export default function RiskDashboardPage() {
  const [groups, setGroups] = useState<RiskGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [catFilter, setCatFilter] = useState<string>('all');
  const [certNoticeOpen, setCertNoticeOpen] = useState(true);
  const [licenseAlerts, setLicenseAlerts] = useState<{ expiredCount: number; expiringCount: number; expired: any[]; expiring: any[] } | null>(null);
  const navigate = useNavigate();

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/batch-group?pageSize=100', { headers });
      const json = await res.json();
      setGroups(json.data || []);
      try {
        const lr = await fetch('/api/license/alerts?days=30', { headers });
        const lj = await lr.json();
        if (lj.success) setLicenseAlerts(lj.data);
      } catch { /* 证件台账未启用时忽略 */ }
    } catch {
      message.error('加载风险数据失败，请稍后重试');
      setGroups([]);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const exportRisk = (rows: any[], scope: string) => {
    if (!rows.length) { message.info('当前无可导出的记录'); return; }
    const head = ['提运单号', '风险等级', '风险类型', '合规预检', '状态', '退单代码', '退单含义/修改建议'];
    const lines = rows.map(g => {
      const code = parseRejectCode(g.errorMsg);
      const info = code ? REJECT_INFO[code] : null;
      const rejectText = (g.status === 'rejected' || g.status === 'error')
        ? (info ? `${info.label}｜建议:${info.fix}` : (g.errorMsg || '已退单'))
        : '';
      return [g.billOfLading || '', LEVEL_META[g._level]?.label || '', (g._cats || []).join('/'),
        g.preCheckPassed === true ? '通过' : g.preCheckPassed === false ? '未过' : '-',
        g.status || '', code || '', rejectText];
    });
    const csv = '\uFEFF' + [head, ...lines].map(r => r.map((v: any) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `风控清单_${scope}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    message.success('风控清单已导出');
  };

  const enriched = groups.map(g => ({ ...g, _level: riskLevel(g), _cats: riskCats(g) }));
  let filtered = enriched;
  if (levelFilter !== 'all') filtered = filtered.filter(g => g._level === levelFilter);
  if (catFilter !== 'all') filtered = filtered.filter(g => g._cats.includes(catFilter));

  const red = enriched.filter(g => g._level === 'red').length;
  const yellow = enriched.filter(g => g._level === 'yellow').length;
  const green = enriched.filter(g => g._level === 'green').length;
  const rejected = enriched.filter(g => g.status === 'rejected').length;

  const columns = [
    { title: '提运单号', dataIndex: 'billOfLading', key: 'billOfLading', render: (v: string) => <Text strong>{v || '-'}</Text> },
    {
      title: '风险等级', key: 'level', width: 110,
      render: (_: any, g: any) => {
        const m = LEVEL_META[g._level];
        return <Tag color={g._level === 'red' ? 'error' : g._level === 'yellow' ? 'warning' : g._level === 'green' ? 'success' : 'default'}
          style={{ fontWeight: 500 }}>● {m.label}</Tag>;
      },
    },
    {
      title: '风险类型', key: 'cats', width: 220,
      render: (_: any, g: any) => g._cats.length
        ? <Space size={[4, 4]} wrap>{g._cats.map((c: string) => <Tag key={c} color={c === '证件' ? 'volcano' : c === '价格' ? 'gold' : c === '归类' ? 'geekblue' : 'default'}>{c}</Tag>)}</Space>
        : <Text type="secondary">—</Text>,
    },
    {
      title: '合规预检', dataIndex: 'preCheckPassed', key: 'preCheckPassed', width: 90,
      render: (v: boolean | null) => v === true ? <Tag color="green">通过</Tag> : v === false ? <Tag color="red">未过</Tag> : '-',
    },
    {
      title: '退单与修改建议', key: 'reject',
      render: (_: any, g: RiskGroup) => {
        if (g.status !== 'rejected' && g.status !== 'error') return <Text type="secondary">—</Text>;
        const code = parseRejectCode(g.errorMsg);
        const info = code ? REJECT_INFO[code] : null;
        return (
          <div>
            {code && <Tag color="red">{code}</Tag>}
            <Text>{info?.label || g.errorMsg || '已退单'}</Text>
            {info && <div style={{ marginTop: 4 }}><Text type="success" style={{ fontSize: 12 }}><InfoCircleOutlined /> 建议：{info.fix}</Text></div>}
          </div>
        );
      },
    },
    {
      title: '操作', key: 'actions', width: 90,
      render: (_: any, g: RiskGroup) => <Button size="small" onClick={() => navigate('/dashboard/batch-archive?bl=' + encodeURIComponent(g.billOfLading || ''))}>去处理</Button>,
    },
  ];

  return (
    <div>
      <Title level={4} style={{ marginTop: 0 }}><SafetyCertificateOutlined /> 风控看板</Title>
      <Text type="secondary">红/黄/绿三级风险一眼判：高危必须复核拦截，关注需留意，正常可放行。</Text>

      <Row gutter={12} style={{ marginTop: 16, marginBottom: 12 }}>
        <Col span={6}><Card size="small" hoverable onClick={() => setLevelFilter('red')} style={{ cursor: 'pointer', borderColor: levelFilter === 'red' ? '#cf1322' : undefined }}>
          <Statistic title="高危(红)" value={red} valueStyle={{ color: '#cf1322', fontWeight: 'bold' }} prefix={<WarningOutlined />} /></Card></Col>
        <Col span={6}><Card size="small" hoverable onClick={() => setLevelFilter('yellow')} style={{ cursor: 'pointer', borderColor: levelFilter === 'yellow' ? '#d48806' : undefined }}>
          <Statistic title="关注(黄)" value={yellow} valueStyle={{ color: '#d48806' }} prefix={<InfoCircleOutlined />} /></Card></Col>
        <Col span={6}><Card size="small" hoverable onClick={() => setLevelFilter('green')} style={{ cursor: 'pointer', borderColor: levelFilter === 'green' ? '#389e0d' : undefined }}>
          <Statistic title="正常(绿)" value={green} valueStyle={{ color: '#389e0d' }} prefix={<CheckCircleOutlined />} /></Card></Col>
        <Col span={6}><Card size="small" hoverable onClick={() => setLevelFilter('all')} style={{ cursor: 'pointer' }}>
          <Statistic title="退单" value={rejected} valueStyle={{ color: '#fa8c16' }} prefix={<CloseCircleOutlined />} /></Card></Col>
      </Row>

      {licenseAlerts && (licenseAlerts.expiredCount > 0 || licenseAlerts.expiringCount > 0) ? (
        <Alert
          type={licenseAlerts.expiredCount > 0 ? 'error' : 'warning'} showIcon banner
          style={{ marginBottom: 12, borderRadius: 6 }}
          message={
            <Space wrap size={4}>
              <Text strong style={{ fontSize: 13 }}>证件到期预警：</Text>
              <Text style={{ fontSize: 13 }}>{licenseAlerts.expiredCount} 项已过期 · {licenseAlerts.expiringCount} 项30天内到期。</Text>
              {[...(licenseAlerts.expired || []), ...(licenseAlerts.expiring || [])].slice(0, 4).map((l: any) => (
                <Tag key={l.id} color={l.daysToExpiry < 0 ? 'error' : 'warning'}>
                  {l.licenseType}{l.licenseNo ? `(${l.licenseNo})` : ''}：{l.daysToExpiry < 0 ? `已过期${Math.abs(l.daysToExpiry)}天` : `${l.daysToExpiry}天`}
                </Tag>
              ))}
              <Button size="small" type="link" onClick={() => navigate('/dashboard/license-ledger')}>去台账处理</Button>
            </Space>
          }
        />
      ) : certNoticeOpen && (
        <Alert
          type="info" showIcon closable banner
          onClose={() => setCertNoticeOpen(false)}
          style={{ marginBottom: 12, borderRadius: 6 }}
          message={
            <Space wrap size={4}>
              <Text style={{ fontSize: 13 }}>
                未发现到期证件。证件到期倒计时由「证件台账」驱动，建议在台账登记证件号+有效期。
              </Text>
              <Button size="small" type="link" onClick={() => navigate('/dashboard/license-ledger')}>前往证件台账</Button>
            </Space>
          }
        />
      )}

      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <span>风险等级：</span>
          <Select value={levelFilter} onChange={setLevelFilter} style={{ width: 140 }} options={[
            { value: 'all', label: '全部' }, { value: 'red', label: '🔴 高危' },
            { value: 'yellow', label: '🟡 关注' }, { value: 'green', label: '🟢 正常' },
          ]} />
          <span>风险类型：</span>
          <Select value={catFilter} onChange={setCatFilter} style={{ width: 160 }} options={[
            { value: 'all', label: '全部类型' }, { value: '归类', label: '归类' }, { value: '价格', label: '价格/税率' },
            { value: '单证', label: '单证一致' }, { value: '证件', label: '证件合规' }, { value: '合规预检', label: '合规预检' },
          ]} />
          <Button icon={<DownloadOutlined />} onClick={() => exportRisk(filtered, '当前筛选')}>导出当前清单</Button>
          <Button danger icon={<DownloadOutlined />} onClick={() => exportRisk(enriched.filter(g => g._level === 'red'), '高危')}>导出高危清单</Button>
        </Space>
      </Card>

      <Spin spinning={loading}>
        <Table
          rowKey="id"
          dataSource={filtered}
          columns={columns}
          pagination={{ pageSize: 15 }}
          locale={{ emptyText: loading ? '加载中…' : '暂无风险数据 —— 风险会在「自动化报关」跑完 AI 校验 / 合规预检后自动汇入这里' }}
          scroll={{ x: 900 }}
        />
      </Spin>
    </div>
  );
}
