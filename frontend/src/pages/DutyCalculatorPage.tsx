import { useState } from 'react';
import {
  Card, Row, Col, Input, InputNumber, Button, Space, Typography, Statistic,
  Divider, Tag, message, Alert, Tooltip, Select,
} from 'antd';
import { CalculatorOutlined, SearchOutlined, InfoCircleOutlined, FileTextOutlined, CopyOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Title, Text, Paragraph } = Typography;

// 进口环节税费试算（从价计征）
//   关税  = 完税价格(CIF) × 关税率
//   消费税 = (完税价格 + 关税) / (1 − 消费税率) × 消费税率
//   增值税 = (完税价格 + 关税 + 消费税) × 增值税率
//   合计  = 关税 + 消费税 + 增值税
function calc(cif: number, dutyR: number, exciseR: number, vatR: number) {
  const d = dutyR / 100, e = exciseR / 100, v = vatR / 100;
  const duty = cif * d;
  const excise = e > 0 && e < 1 ? ((cif + duty) / (1 - e)) * e : 0;
  const vat = (cif + duty + excise) * v;
  return { duty, excise, vat, total: duty + excise + vat };
}

export default function DutyCalculatorPage() {
  const [hs, setHs] = useState('');
  const [hsInfo, setHsInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const [cif, setCif] = useState<number>(0);
  const [dutyR, setDutyR] = useState<number>(0);
  const [exciseR, setExciseR] = useState<number>(0);
  const [vatR, setVatR] = useState<number>(13);
  const [rateBasis, setRateBasis] = useState<'mfn' | 'fta'>('mfn');
  const [ftaR, setFtaR] = useState<number>(0);

  // 申报要素 / 规格型号助手
  const [elements, setElements] = useState<string[]>([]);
  const [matchedCode, setMatchedCode] = useState<string | null>(null);
  const [elemVals, setElemVals] = useState<Record<number, string>>({});
  const [elemNote, setElemNote] = useState<string>('');

  const token = localStorage.getItem('token');
  const api = axios.create({ baseURL: '/api', headers: { Authorization: 'Bearer ' + token } });

  const pullRates = async () => {
    const code = hs.trim();
    if (!code) { message.warning('请先输入 HS 编码'); return; }
    setLoading(true);
    try {
      const res = await api.get('/hscode/public/search', { params: { q: code } });
      const list = res.data?.data || [];
      // 优先精确匹配，否则取第一条
      const hit = list.find((x: any) => (x.code || '').replace(/\D/g, '').startsWith(code.replace(/\D/g, ''))) || list[0];
      if (!hit) { message.warning('未查到该 HS 编码，请手动填写税率'); setHsInfo(null); return; }
      setHsInfo(hit);
      setDutyR(Number(hit.mfn_rate) || 0);
      setVatR(Number(hit.vat_rate) || 13);
      setExciseR(Number(hit.excise_rate) || 0);
      message.success('已带入 ' + (hit.code || code) + ' 的税率');
      // 同步拉申报要素
      try {
        const er = await api.get('/hscode/' + encodeURIComponent(hit.code || code) + '/elements');
        const ed = er.data?.data;
        setElements(ed?.elements || []);
        setMatchedCode(ed?.matchedCode || null);
        setElemNote(ed?.note || '');
        setElemVals({});
      } catch { setElements([]); setMatchedCode(null); setElemNote(''); }
    } catch (err: any) {
      message.error('查询失败: ' + (err.response?.data?.error || err.message));
    } finally { setLoading(false); }
  };

  const effDuty = rateBasis === 'fta' ? ftaR : dutyR;
  const r = calc(cif || 0, effDuty || 0, exciseR || 0, vatR || 0);
  const taxBurden = cif > 0 ? (r.total / cif) * 100 : 0;
  const fmt = (n: number) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div>
      <Alert
        type="info" showIcon style={{ marginBottom: 16 }}
        message="进口环节税费试算（从价计征 · 仅供报关员快速测算与客户报价参考）"
        description="出口退税额测算请用「退税管理」模块；从量/复合计征、特殊监管区域、暂定/反倾销税等需按具体批文单独核算。"
      />
      <Row gutter={16}>
        <Col xs={24} md={11}>
          <Card size="small" title={<Space><CalculatorOutlined />计税要素</Space>}>
            <Text type="secondary">HS 编码（可按编码带入官方税率）</Text>
            <Space.Compact style={{ width: '100%', marginTop: 4, marginBottom: 12 }}>
              <Input
                placeholder="如 8471.30.00"
                value={hs}
                onChange={(e) => setHs(e.target.value)}
                onPressEnter={pullRates}
                allowClear
              />
              <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={pullRates}>带入税率</Button>
            </Space.Compact>

            {hsInfo && (
              <div style={{ marginBottom: 12 }}>
                <Tag color="blue">{hsInfo.code}</Tag>
                <Text>{hsInfo.name}</Text>
                <div style={{ marginTop: 4 }}>
                  <Space size={4} wrap>
                    {hsInfo.unit && <Tag>法定单位：{hsInfo.unit}</Tag>}
                    {hsInfo.supervision
                      ? <Tag color="orange">监管条件：{hsInfo.supervision}</Tag>
                      : <Tag color="default">监管条件：无</Tag>}
                  </Space>
                </div>
                {Array.isArray(hsInfo.supervision_certs) && hsInfo.supervision_certs.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>需随附监管证件：</Text>
                    <div style={{ marginTop: 4 }}>
                      <Space size={4} wrap>
                        {hsInfo.supervision_certs.map((c: any, i: number) => (
                          <Tag key={i} color={c.known ? 'red' : 'default'}>
                            {c.code} · {c.name}
                          </Tag>
                        ))}
                      </Space>
                    </div>
                  </div>
                )}
              </div>
            )}

            <Row gutter={12}>
              <Col span={24} style={{ marginBottom: 12 }}>
                <Text type="secondary">完税价格 CIF（人民币元）</Text>
                <InputNumber style={{ width: '100%' }} min={0} value={cif} onChange={(v) => setCif(Number(v) || 0)} placeholder="到岸价" />
              </Col>
              <Col span={24} style={{ marginBottom: 12 }}>
                <Text type="secondary">
                  关税率（%）
                  <Tooltip title="MFN=最惠国税率；协定税率请在下方切换并填入对应优惠税率">
                    <InfoCircleOutlined style={{ marginLeft: 4, color: '#999' }} />
                  </Tooltip>
                </Text>
                <Space style={{ width: '100%' }}>
                  <Select
                    value={rateBasis}
                    style={{ width: 120 }}
                    onChange={setRateBasis}
                    options={[{ value: 'mfn', label: '最惠国' }, { value: 'fta', label: '协定税率' }]}
                  />
                  {rateBasis === 'mfn'
                    ? <InputNumber style={{ flex: 1, width: 160 }} min={0} max={100} value={dutyR} onChange={(v) => setDutyR(Number(v) || 0)} addonAfter="%" />
                    : <InputNumber style={{ flex: 1, width: 160 }} min={0} max={100} value={ftaR} onChange={(v) => setFtaR(Number(v) || 0)} addonAfter="%" />}
                </Space>
              </Col>
              <Col span={12} style={{ marginBottom: 12 }}>
                <Text type="secondary">消费税率（%）</Text>
                <InputNumber style={{ width: '100%' }} min={0} max={100} value={exciseR} onChange={(v) => setExciseR(Number(v) || 0)} addonAfter="%" />
              </Col>
              <Col span={12} style={{ marginBottom: 12 }}>
                <Text type="secondary">增值税率（%）</Text>
                <InputNumber style={{ width: '100%' }} min={0} max={100} value={vatR} onChange={(v) => setVatR(Number(v) || 0)} addonAfter="%" />
              </Col>
            </Row>
          </Card>
        </Col>

        <Col xs={24} md={13}>
          <Card size="small" title="试算结果">
            <Row gutter={16}>
              <Col span={8}><Statistic title="关税" value={fmt(r.duty)} prefix="¥" /></Col>
              <Col span={8}><Statistic title="消费税" value={fmt(r.excise)} prefix="¥" /></Col>
              <Col span={8}><Statistic title="增值税" value={fmt(r.vat)} prefix="¥" /></Col>
            </Row>
            <Divider style={{ margin: '16px 0' }} />
            <Row gutter={16} align="middle">
              <Col span={12}>
                <Statistic title="税费合计" value={fmt(r.total)} prefix="¥" valueStyle={{ color: '#cf1322', fontSize: 28 }} />
              </Col>
              <Col span={12}>
                <Statistic title="综合税负率" value={taxBurden.toFixed(2)} suffix="%" valueStyle={{ color: '#1677ff' }} />
              </Col>
            </Row>
            <Divider style={{ margin: '16px 0' }} />
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              计征口径（从价）：<br />
              关税 = 完税价格 × {effDuty || 0}%<br />
              消费税 = (完税价格 + 关税) ÷ (1 − {exciseR || 0}%) × {exciseR || 0}%<br />
              增值税 = (完税价格 + 关税 + 消费税) × {vatR || 0}%<br />
              进口环节增值税计税基数已含关税与消费税，与海关计征一致。
            </Paragraph>
          </Card>
        </Col>
      </Row>

      {elements.length > 0 && (
        <Card
          size="small"
          style={{ marginTop: 16 }}
          title={<Space><FileTextOutlined />申报要素 · 规格型号助手{matchedCode && <Tag color="blue">匹配 {matchedCode}</Tag>}</Space>}
        >
          <Alert
            type="warning" showIcon style={{ marginBottom: 12 }}
            message={elemNote || "逐项填写后自动拼成报关单「规格型号(GModel)」串。要素顺序与必填性以单一窗口为准；CAS/GTIN 为通用要素，无则留空。"}
          />
          <Row gutter={[12, 8]}>
            {elements.map((el, i) => (
              <Col xs={24} sm={12} md={8} key={i}>
                <Text type="secondary" style={{ fontSize: 12 }}>{i + 1}. {el}</Text>
                <Input
                  size="small"
                  value={elemVals[i] || ''}
                  onChange={(e) => setElemVals({ ...elemVals, [i]: e.target.value })}
                  placeholder={el}
                />
              </Col>
            ))}
          </Row>
          <Divider style={{ margin: '12px 0' }} />
          <Text type="secondary">规格型号串（GModel）</Text>
          <Space.Compact style={{ width: '100%', marginTop: 4 }}>
            <Input
              readOnly
              value={elements.map((_, i) => (elemVals[i] || '').trim()).join('|')}
              placeholder="按上方要素顺序，以 | 分隔"
            />
            <Button
              type="primary"
              icon={<CopyOutlined />}
              onClick={() => {
                const s = elements.map((_, i) => (elemVals[i] || '').trim()).join('|');
                if (navigator.clipboard?.writeText) navigator.clipboard.writeText(s).then(() => message.success('已复制规格型号串')).catch(() => message.warning('复制失败，请手动选择'));
                else message.warning('当前环境不支持自动复制，请手动选择');
              }}
            >复制</Button>
          </Space.Compact>
        </Card>
      )}
    </div>
  );
}