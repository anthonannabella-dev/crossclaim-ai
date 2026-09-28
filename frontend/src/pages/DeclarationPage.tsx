import { useState, useMemo } from 'react';
import { Row, Col, Card, Form, Input, InputNumber, Select, Button, Table, Tag, Progress, message, Spin, Typography, Divider, Collapse, Alert } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, WarningOutlined, InfoCircleOutlined, ShoppingCartOutlined, GlobalOutlined, DatabaseOutlined, BankOutlined, GiftOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;
const { TextArea } = Input;
const { Panel } = Collapse;

// ---- Types ----
interface ComplianceIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  category: string;
  field?: string;
  message: string;
  suggestion: string;
}

interface PreCheckResult {
  passed: boolean;
  score: number;
  issues: ComplianceIssue[];
  checkedRules: number;
  recommendation: string;
}

interface DeclarationHistoryItem {
  id: string;
  declarationNo: string | null;
  status: string;
  customsMode: string;
  totalValue: number;
  createdAt: string;
}

const MODES = [
  { value: 'normal', label: '一般贸易', icon: <BankOutlined /> },
  { value: '9610', label: '跨境电商零售出口', icon: <ShoppingCartOutlined /> },
  { value: '9710', label: '跨境电商B2B直接出口', icon: <GlobalOutlined /> },
  { value: '9810', label: '出口海外仓', icon: <DatabaseOutlined /> },
  { value: '1210', label: '保税备货进口', icon: <GiftOutlined /> },
  { value: '1239', label: '保税备货进口A', icon: <GiftOutlined /> },
  { value: '1039', label: '市场采购贸易', icon: <ShoppingCartOutlined /> },
];

const MODE_HELP: Record<string, string> = {
  '9610': '适用于跨境电商零售出口（B2C），需三单对碰（订单号+支付单号+物流单号）',
  '9710': '适用于跨境电商B2B直接出口，需B2B平台信息和订单号',
  '9810': '适用于出口海外仓，需海外仓地址和入库信息',
  '1210': '适用于保税备货进口（跨境直购），需保税仓信息',
  '1239': '适用于保税备货进口A模式',
  '1039': '适用于市场采购贸易方式，需市场名称和供应商信息',
  'normal': '适用于一般贸易方式',
};

const SEVERITY_CONFIG: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  error: { color: '#cf1322', icon: <CloseCircleOutlined />, label: '错误' },
  warning: { color: '#fa8c16', icon: <WarningOutlined />, label: '警告' },
  info: { color: '#1890ff', icon: <InfoCircleOutlined />, label: '提示' },
};

const CATEGORY_LABELS: Record<string, string> = {
  classification: '归类', valuation: '估价', origin: '原产地',
  document: '单证', transport: '运输', currency: '币种', rcep: 'RCEP',
  ecommerce: '跨境电商', triple_check: '三单对碰',
};

export default function DeclarationPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [preCheckResult, setPreCheckResult] = useState<PreCheckResult | null>(null);
  const [xmlContent, setXmlContent] = useState('');
  const [history, setHistory] = useState<DeclarationHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [buildLoading, setBuildLoading] = useState(false);
  const [customsMode, setCustomsMode] = useState('normal');

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  // Watch for mode changes
  const handleModeChange = (value: string) => {
    setCustomsMode(value);
    form.setFieldsValue({ customsMode: value });
  };

  // Define dynamic fields per mode
  const modeFields = useMemo(() => {
    const common = (
      <>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="HS编码(商品编号)" name="hsCode"><Input placeholder="10位连写, 如 8517120000" /></Form.Item></Col>
          <Col span={12}><Form.Item label="监管方式(贸易方式)" name="customsMode" initialValue="normal">
            <Select onChange={handleModeChange} options={MODES.map(m => ({ value: m.value, label: m.label }))} />
          </Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="境内收发货人" name="consignee"><Input placeholder="出口为发货人/进口为收货人" /></Form.Item></Col>
          <Col span={12}><Form.Item label="消费使用单位 / 生产销售单位" name="consignor"><Input placeholder="进口填消费使用单位, 出口填生产销售单位" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="进出境口岸" name="portOfEntry"><Input placeholder="如深圳蛇口 / 上海外高桥" /></Form.Item></Col>
          <Col span={12}><Form.Item label="合同协议号" name="contractNo"><Input placeholder="如 PO-2024-0617" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}><Form.Item label="运输方式" name="transportMode">
            <Select options={[{ value: '海运', label: '海运' }, { value: '空运', label: '空运' }, { value: '陆运', label: '陆运' }, { value: '铁路', label: '铁路' }, { value: '邮政', label: '邮政' }, { value: '快递', label: '快递' }]} />
          </Form.Item></Col>
          <Col span={8}><Form.Item label="成交方式(贸易条款)" name="tradeTerms">
            <Select options={[{ value: 'CIF', label: 'CIF' }, { value: 'CFR', label: 'CFR' }, { value: 'FOB', label: 'FOB' }, { value: 'EXW', label: 'EXW' }, { value: 'DDP', label: 'DDP' }, { value: 'DAP', label: 'DAP' }]} />
          </Form.Item></Col>
          <Col span={8}><Form.Item label="币制" name="currency" initialValue="USD">
            <Select options={[{ value: 'USD', label: 'USD' }, { value: 'EUR', label: 'EUR' }, { value: 'CNY', label: 'CNY' }, { value: 'JPY', label: 'JPY' }, { value: 'HKD', label: 'HKD' }]} />
          </Form.Item></Col>
        </Row>
        <Form.Item label="商品描述(品名)" name="description"><TextArea rows={2} placeholder="品名" /></Form.Item>
        <Form.Item label="规格型号" name="model" rules={[{ required: true, message: '规格型号为海关必填项' }]}>
          <TextArea rows={2} placeholder="品牌/型号/材质/成分等申报要素, 缺失将被退单" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={6}><Form.Item label="成交数量" name="quantity"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={6}><Form.Item label="成交计量单位" name="unit"><Input placeholder="如 台/个" /></Form.Item></Col>
          <Col span={6}><Form.Item label="单价" name="unitPrice"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={6}><Form.Item label="原产国(地区)" name="originCountry" initialValue="中国"><Input placeholder="如 中国" /></Form.Item></Col>
        </Row>
        <Divider orientation="left" style={{ fontSize: 12, color: '#888' }}>法定计量单位</Divider>
        <Row gutter={12}>
          <Col span={6}><Form.Item label="法定第一数量" name="legalQty"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={6}><Form.Item label="法定第一单位" name="legalUnit"><Input placeholder="如 台" /></Form.Item></Col>
          <Col span={6}><Form.Item label="法定第二数量" name="legalQty2"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={6}><Form.Item label="法定第二单位" name="legalUnit2"><Input placeholder="如 千克(无则留空)" /></Form.Item></Col>
        </Row>
        <Collapse ghost>
          <Panel header="运费 / 保费 / 杂费 (CIF·CFR 必填运费)" key="fees">
            <Row gutter={12}>
              <Col span={8}><Form.Item label="运费" name="freightRate"><InputNumber min={0} style={{ width: '100%' }} placeholder="总额" /></Form.Item></Col>
              <Col span={8}><Form.Item label="保费" name="insuranceRate"><InputNumber min={0} style={{ width: '100%' }} placeholder="总额" /></Form.Item></Col>
              <Col span={8}><Form.Item label="杂费" name="otherRate"><InputNumber min={0} style={{ width: '100%' }} placeholder="总额" /></Form.Item></Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 12 }}>币制默认与上方一致, 如需不同可在导出后调整。</Text>
          </Panel>
        </Collapse>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="总金额" name="totalValue"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={12}><Form.Item label="随附单证" name="documents"><Input placeholder="如 商业发票,装箱单,提单" /></Form.Item></Col>
        </Row>
      </>
    );

    // === 9610: 跨境电商零售出口（三单对碰）===
    const mode9610 = (
      <>
        <Divider orientation="left" style={{ fontSize: 13, color: '#1890ff' }}>
          <ShoppingCartOutlined /> 跨境电商零售出口（9610）
        </Divider>
        <Row gutter={12}>
          <Col span={8}><Form.Item label="电商平台" name="ecommercePlatform" rules={[{ required: true, message: '9610需填电商平台名称' }]}><Input placeholder="如 Amazon（三单对碰必填）" /></Form.Item></Col>
          <Col span={8}><Form.Item label="电商平台代码" name="ecommercePlatformCode" rules={[{ required: true, message: '9610需填电商平台代码' }]}><Input placeholder="如 AMZ（三单对碰必填）" /></Form.Item></Col>
          <Col span={8}><Form.Item label="物流方式" name="deliveryMethod">
            <Select options={[{ value: '邮政', label: '邮政' }, { value: '快递', label: '快递' }, { value: '海运', label: '海运' }, { value: '空运', label: '空运' }, { value: '中欧班列', label: '中欧班列' }]} />
          </Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}><Form.Item label="物流单号" name="logisticsNo" rules={[{ required: true, message: '9610需填物流单号' }]}><Input placeholder="物流单号（三单对碰必填）" /></Form.Item></Col>
          <Col span={8}><Form.Item label="订单号" name="orderNo" rules={[{ required: true, message: '9610需填订单号' }]}><Input placeholder="订单号（三单对碰必填）" /></Form.Item></Col>
          <Col span={8}><Form.Item label="支付单号" name="paymentNo" rules={[{ required: true, message: '9610需填支付单号' }]}><Input placeholder="支付单号（三单对碰必填）" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}><Form.Item label="收货人证件类型" name="receiverIdType"><Select options={[{ value: '身份证', label: '身份证' }, { value: '护照', label: '护照' }, { value: '其他', label: '其他' }]} /></Form.Item></Col>
          <Col span={8}><Form.Item label="收货人证件号" name="receiverIdNumber"><Input placeholder="证件号" /></Form.Item></Col>
          <Col span={8}><Form.Item label="收货人姓名" name="consumerName"><Input placeholder="收货人姓名" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="收货人电话" name="consumerPhone"><Input placeholder="手机号" /></Form.Item></Col>
          <Col span={12}><Form.Item label="收货人地址" name="consumerAddress"><Input placeholder="收货地址" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}><Form.Item label="合同号" name="contractNo"><Input placeholder="可选" /></Form.Item></Col>
          <Col span={8}><Form.Item label="发货方式" name="deliveryMethod"><Input placeholder="如 直邮/集货（已填物流方式可留空）" /></Form.Item></Col>
        </Row>
      </>
    );

    // === 9710: B2B直接出口 ===
    const mode9710 = (
      <>
        <Divider orientation="left" style={{ fontSize: 13, color: '#52c41a' }}>
          <GlobalOutlined /> 跨境电商B2B直接出口（9710）
        </Divider>
        <Row gutter={12}>
          <Col span={8}><Form.Item label="B2B平台" name="b2bPlatform" rules={[{ required: true, message: '9710需填B2B平台' }]}><Input placeholder="如 Alibaba.com（必填）" /></Form.Item></Col>
          <Col span={8}><Form.Item label="B2B订单号" name="b2bOrderNo" rules={[{ required: true, message: '9710需填B2B订单号' }]}><Input placeholder="B2B订单号" /></Form.Item></Col>
          <Col span={8}><Form.Item label="B2B订单金额" name="b2bOrderAmount"><InputNumber min={0} style={{ width: '100%' }} placeholder="订单金额" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="产品链接" name="b2bProductUrl"><Input placeholder="产品页面URL" /></Form.Item></Col>
          <Col span={12}><Form.Item label="电商平台" name="ecommercePlatform"><Input placeholder="平台名称" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}><Form.Item label="物流单号" name="logisticsNo"><Input placeholder="物流单号" /></Form.Item></Col>
          <Col span={8}><Form.Item label="物流方式" name="deliveryMethod">
            <Select options={[{ value: '海运', label: '海运' }, { value: '空运', label: '空运' }, { value: '快递', label: '快递' }, { value: '铁路', label: '铁路' }]} />
          </Form.Item></Col>
          <Col span={8}><Form.Item label="合同号" name="contractNo"><Input placeholder="合同号" /></Form.Item></Col>
        </Row>
      </>
    );

    // === 9810: 出口海外仓 ===
    const mode9810 = (
      <>
        <Divider orientation="left" style={{ fontSize: 13, color: '#722ed1' }}>
          <DatabaseOutlined /> 出口海外仓（9810）
        </Divider>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="海外仓地址" name="warehouseAddress" rules={[{ required: true, message: '9810需填海外仓地址' }]}><Input placeholder="海外仓完整地址" /></Form.Item></Col>
          <Col span={12}><Form.Item label="海外仓代码" name="warehouseCode" rules={[{ required: true, message: '9810需填海外仓代码' }]}><Input placeholder="如 USLAX1（必填）" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}><Form.Item label="目的国" name="destinationCountry" rules={[{ required: true, message: '9810需填目的国' }]}><Input placeholder="如 US（必填）" /></Form.Item></Col>
          <Col span={8}><Form.Item label="FNSKU" name="fnSku"><Input placeholder="亚马逊FBA FNSKU" /></Form.Item></Col>
          <Col span={8}><Form.Item label="入仓单号" name="inboundOrderNo"><Input placeholder="FBA Inbound ID（建议填写）" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="退货地址" name="returnAddress"><Input placeholder="退货地址（可选）" /></Form.Item></Col>
          <Col span={12}><Form.Item label="预计销售渠道" name="estimatedSalesChannel"><Input placeholder="如 Amazon/独立站/eBay" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}><Form.Item label="物流单号" name="logisticsNo"><Input placeholder="物流单号" /></Form.Item></Col>
          <Col span={8}><Form.Item label="物流方式" name="deliveryMethod">
            <Select options={[{ value: '海运', label: '海运' }, { value: '空运', label: '空运' }, { value: '快递', label: '快递' }, { value: '铁路', label: '铁路' }]} />
          </Form.Item></Col>
          <Col span={8}><Form.Item label="电商平台代码" name="ecommercePlatformCode"><Input placeholder="平台代码" /></Form.Item></Col>
        </Row>
      </>
    );

    // === 1210/1239: 保税备货进口 ===
    const modeBonded = (
      <>
        <Divider orientation="left" style={{ fontSize: 13, color: '#eb2f96' }}>
          <GiftOutlined /> 保税备货进口（{customsMode}）
        </Divider>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="保税仓ID" name="bondedWarehouseId"><Input placeholder="保税仓编号" /></Form.Item></Col>
          <Col span={12}><Form.Item label="保税仓名称" name="bondedWarehouseName"><Input placeholder="如 上海外高桥保税区" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}><Form.Item label="适用税率" name="tariffRateApplied"><InputNumber min={0} max={100} style={{ width: '100%' }} placeholder="税率%" /></Form.Item></Col>
          <Col span={8}><Form.Item label="减税类型" name="taxReductionType">
            <Select options={[{ value: '无', label: '无' }, { value: '跨境电商零售进口优惠', label: '跨境电商零售进口优惠' }, { value: '其他', label: '其他' }]} />
          </Form.Item></Col>
          <Col span={8}><Form.Item label="物流单号" name="logisticsNo"><Input placeholder="物流单号" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}><Form.Item label="消费者证件类型" name="consumerIdType"><Select options={[{ value: '身份证', label: '身份证' }, { value: '护照', label: '护照' }]} /></Form.Item></Col>
          <Col span={8}><Form.Item label="消费者证件号" name="consumerIdNumber"><Input placeholder="身份证号" /></Form.Item></Col>
          <Col span={8}><Form.Item label="消费者姓名" name="consumerName"><Input placeholder="姓名" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="消费者电话" name="consumerPhone"><Input placeholder="手机号" /></Form.Item></Col>
          <Col span={12}><Form.Item label="电商平台" name="ecommercePlatform"><Input placeholder="如 Tmall Global" /></Form.Item></Col>
        </Row>
      </>
    );

    // === 1039: 市场采购贸易 ===
    const mode1039 = (
      <>
        <Divider orientation="left" style={{ fontSize: 13, color: '#fa8c16' }}>
          <ShoppingCartOutlined /> 市场采购贸易（1039）
        </Divider>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="市场名称" name="marketName"><Input placeholder="如 义乌小商品城" /></Form.Item></Col>
          <Col span={12}><Form.Item label="市场代码" name="marketCode"><Input placeholder="市场海关代码" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="供应商名称" name="supplierName"><Input placeholder="供应商名称" /></Form.Item></Col>
          <Col span={12}><Form.Item label="供应商代码" name="supplierCode"><Input placeholder="供应商海关代码" /></Form.Item></Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}><Form.Item label="合同号" name="contractNo"><Input placeholder="合同号" /></Form.Item></Col>
          <Col span={8}><Form.Item label="提单号" name="billOfLading"><Input placeholder="提单号（选填）" /></Form.Item></Col>
        </Row>
      </>
    );

    return { common, mode9610, mode9710, mode9810, modeBonded, mode1039 };
  }, [customsMode]);

  // === Handlers (unchanged) ===
  // 把扁平表单值组装成后端期望的形状(hsCodes 数组 + itemDetails + 主体/运保杂费)
  const assembleBody = () => {
    const v = form.getFieldsValue();
    const docs = typeof v.documents === 'string'
      ? v.documents.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean)
      : (v.documents || []);
    return {
      ...v,
      hsCodes: v.hsCode ? [v.hsCode] : [],
      itemDetails: v.hsCode ? [{
        hsCode: v.hsCode, description: v.description, model: v.model,
        quantity: v.quantity ?? 1, unitPrice: v.unitPrice ?? 0, unit: v.unit,
        originCountry: v.originCountry || 'CN',
        legalQty: v.legalQty, legalUnit: v.legalUnit,
        legalQty2: v.legalQty2, legalUnit2: v.legalUnit2,
      }] : [],
      documents: docs,
      consignee: v.consignee, consignor: v.consignor,
      importerExporter: v.consignee || v.importerExporter,
      freightMark: v.freightRate != null ? '3' : undefined,
      freightCurrency: v.freightCurrency || v.currency,
      insuranceMark: v.insuranceRate != null ? '3' : undefined,
      insuranceCurrency: v.insuranceCurrency || v.currency,
      otherMark: v.otherRate != null ? '3' : undefined,
      otherCurrency: v.otherCurrency || v.currency,
    };
  };

  // 组装成 runPreCheck 期望的 DeclarationData(含 items 数组)
  const assembleDeclaration = () => {
    const b: any = assembleBody();
    const qty = b.quantity ?? 1;
    const price = b.unitPrice ?? 0;
    return {
      ...b,
      items: b.hsCodes.length ? [{
        lineNo: 1, hsCode: b.hsCode, description: b.description, model: b.model,
        quantity: qty, unit: b.unit || '件', unitPrice: price,
        totalPrice: b.totalValue ?? price * qty, currency: b.currency || 'USD',
        originCountry: b.originCountry || 'CN', tradeTerms: b.tradeTerms,
        legalQty: b.legalQty, legalUnit: b.legalUnit, legalQty2: b.legalQty2, legalUnit2: b.legalUnit2,
        tariffRate: null,
      }] : [],
      totalValue: b.totalValue ?? price * qty,
    };
  };

  const handleBuild = async (_values: any) => {
    setBuildLoading(true);
    try {
      const body = assembleBody();
      if (!body.hsCodes.length) { message.warning('请先填写 HS 编码'); setBuildLoading(false); return; }
      const res = await fetch('/api/declaration/build', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success || json.data) {
        message.success('报关单构建成功');
        setXmlContent(json.data?.xmlContent || json.data?.xml || json.xml || '');
        if (json.data?.preCheck) setPreCheckResult(json.data.preCheck);
      } else {
        message.error(json.error || '构建失败');
      }
    } catch {
      message.error('请求失败');
    } finally {
      setBuildLoading(false);
    }
  };

  const handlePreCheck = async () => {
    setLoading(true);
    try {
      const values = assembleDeclaration();
      const res = await fetch('/api/declaration/pre-check', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ declaration: values }),
      });
      const json = await res.json();
      const result = json.data || json;
      setPreCheckResult(result);
      if (result.passed) {
        message.success(`合规检查通过！评分 ${result.score}/100`);
      } else {
        message.warning(`合规检查未通过，评分 ${result.score}/100`);
      }
    } catch {
      message.error('预检请求失败');
    } finally {
      setLoading(false);
    }
  };

  const handleExportXml = () => {
    if (!xmlContent) { message.warning('请先构建报关单'); return; }
    const blob = new Blob([xmlContent], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `declaration-${Date.now()}.xml`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('XML导出成功');
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/declaration/history', { headers });
      const json = await res.json();
      setHistory((json.data || json || []).slice(0, 10));
    } catch {
      message.error('加载历史失败');
    } finally {
      setHistoryLoading(false);
    }
  };

  const issueColumns = [
    { title: '', dataIndex: 'severity', key: '_icon', width: 40, render: (s: string) => SEVERITY_CONFIG[s]?.icon },
    { title: '代码', dataIndex: 'code', key: 'code', width: 80 },
    { title: '类别', dataIndex: 'category', key: 'category', width: 100, render: (c: string) => CATEGORY_LABELS[c] || c },
    { title: '问题描述', dataIndex: 'message', key: 'message' },
    { title: '修改建议', dataIndex: 'suggestion', key: 'suggestion', render: (v: string) => <Text type="secondary">{v}</Text> },
    { title: '严重度', dataIndex: 'severity', key: 'severity_tag', width: 80, render: (s: string) => <Tag color={SEVERITY_CONFIG[s]?.color}>{SEVERITY_CONFIG[s]?.label}</Tag> },
  ];

  const historyColumns = [
    { title: '报关单号', dataIndex: 'declarationNo', key: 'declarationNo', ellipsis: true },
    { title: '模式', dataIndex: 'customsMode', key: 'customsMode', width: 80 },
    { title: '状态', dataIndex: 'status', key: 'status', width: 100, render: (s: string) => <Tag>{s}</Tag> },
    { title: '金额', dataIndex: 'totalValue', key: 'totalValue', width: 120, render: (v: number) => `$${v?.toLocaleString() ?? 0}` },
    { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 160, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '' },
  ];

  return (
    <div style={{ padding: 0 }}>
      <Row gutter={[16, 16]}>
        {/* 左侧：报关单表单 */}
        <Col xs={24} md={12}>
          <Card title="报关单信息" size="small">
            <Alert
              message={MODE_HELP[customsMode] || '请填写报关单信息'}
              type={customsMode === 'normal' ? 'info' : 'warning'}
              showIcon
              style={{ marginBottom: 12, fontSize: 12 }}
            />
            <Form form={form} layout="vertical" onFinish={handleBuild} initialValues={{ customsMode: 'normal' }}>
              {modeFields.common}

              {/* 根据模式显示专属字段 */}
              {customsMode === '9610' && modeFields.mode9610}
              {customsMode === '9710' && modeFields.mode9710}
              {customsMode === '9810' && modeFields.mode9810}
              {(customsMode === '1210' || customsMode === '1239') && modeFields.modeBonded}
              {customsMode === '1039' && modeFields.mode1039}

              <Divider />
              <Row gutter={8}>
                <Col span={8}>
                  <Button type="primary" htmlType="submit" loading={buildLoading} block>构建报关单</Button>
                </Col>
                <Col span={8}>
                  <Button onClick={handlePreCheck} loading={loading} block icon={<CheckCircleOutlined />}>合规预检</Button>
                </Col>
                <Col span={8}>
                  <Button onClick={handleExportXml} disabled={!xmlContent} block>导出XML</Button>
                </Col>
              </Row>
            </Form>
          </Card>

          {/* XML预览 */}
          {xmlContent && (
            <Card title="XML报文预览" size="small" style={{ marginTop: 16 }}>
              <TextArea rows={8} value={xmlContent} readOnly style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </Card>
          )}
        </Col>

        {/* 右侧：合规预检结果 */}
        <Col xs={24} md={12}>
          <Card title="合规预检" size="small">
            {preCheckResult ? (
              <>
                <div style={{ textAlign: 'center', marginBottom: 16 }}>
                  <Progress
                    type="dashboard"
                    percent={preCheckResult.score}
                    strokeColor={preCheckResult.passed ? '#52c41a' : '#cf1322'}
                    format={p => `${p}分`}
                    size={140}
                  />
                  <div style={{ marginTop: 8 }}>
                    <Tag
                      color={preCheckResult.passed ? 'green' : 'red'}
                      style={{ fontSize: 14, padding: '4px 12px' }}
                      icon={preCheckResult.passed ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                    >
                      {preCheckResult.passed ? '通过' : '未通过'}
                    </Tag>
                    <Text type="secondary" style={{ marginLeft: 8 }}>已检查 {preCheckResult.checkedRules} 条规则</Text>
                  </div>
                </div>
                <Divider>问题列表</Divider>
                <Table
                  dataSource={preCheckResult.issues}
                  columns={issueColumns}
                  rowKey="code"
                  pagination={false}
                  size="small"
                />
                {preCheckResult.recommendation && (
                  <>
                    <Divider>综合建议</Divider>
                    <Card size="small" style={{ background: '#f6ffed', borderColor: '#b7eb8f' }}>
                      <Text>{preCheckResult.recommendation}</Text>
                    </Card>
                  </>
                )}
              </>
            ) : (
              <div style={{ textAlign: 'center', color: '#ccc', padding: '60px 0' }}>
                <InfoCircleOutlined style={{ fontSize: 32, marginBottom: 8 }} />
                <p>选择申报模式并填写信息，点击「构建报关单」生成XML或「合规预检」检查数据</p>
              </div>
            )}
          </Card>

          {/* 最近报关单 */}
          <Card title="最近报关单" size="small" style={{ marginTop: 16 }}
            extra={<Button size="small" onClick={loadHistory}>加载</Button>}>
            <Spin spinning={historyLoading}>
              <Table
                dataSource={history}
                columns={historyColumns}
                rowKey="id"
                pagination={false}
                size="small"
              />
            </Spin>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
