import { useState } from 'react';
import { Row, Col, Card, Table, Button, Upload, Input, Form, Select, message, Spin, Typography, Tag, Alert } from 'antd';
import { UploadOutlined, DownloadOutlined, FileExcelOutlined, CheckCircleOutlined, CloseCircleOutlined, ShoppingCartOutlined, GlobalOutlined, DatabaseOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd/es/upload/interface';

const { Title, Text } = Typography;

// 海关单票商品项数上限
const MAX_ITEMS_PER_DECLARATION = 50;

interface BatchItem {
  row: number;
  hsCode: string;
  description: string;
  model?: string;
  quantity: number;
  unit: string;
  unitPrice?: number;
  fobAmount: number;
  originCountry?: string;
  legalQty?: number; legalUnit?: string; legalQty2?: number; legalUnit2?: string;
  importerExporter?: string;
  consignee?: string;
  consignor?: string;
  contractNo?: string;
  transportMode?: string;
  portOfEntry?: string;
  tradeTerms?: string;
  currency?: string;
  destinationCountry?: string;
  grossWeight?: number;
  netWeight?: number;
  packageCount?: number;
  packageType?: string;
  freightRate?: number;
  insuranceRate?: number;
  // 跨境电商字段
  orderNo?: string;
  paymentNo?: string;
  logisticsNo?: string;
  ecommercePlatform?: string;
  b2bOrderNo?: string;
  b2bPlatform?: string;
  warehouseAddress?: string;
  fnSku?: string;
  errors?: string[];
}

interface BatchResult {
  row: number;
  status: 'success' | 'error';
  declarationNo?: string;
  message?: string;
  score?: number;
  xml?: string;
  itemCount?: number;
}

export default function BatchImportPage() {
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [parsedData, setParsedData] = useState<BatchItem[]>([]);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [customsMode, setCustomsMode] = useState('normal');
  const [defaultExporter, setDefaultExporter] = useState('');

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const handleParse = async (file: File) => {
    setLoading(true);
    try {
      // 用 readAsDataURL 直接拿 base64，避免大文件 String.fromCharCode(...spread) 爆栈
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.includes(',') ? result.split(',')[1] : result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const res = await fetch('/api/declaration/import-excel', {
        method: 'POST',
        headers: { ...headers },
        body: JSON.stringify({ buffer: base64 }),
      });
      const json = await res.json();
      if (json.success && json.data?.items) {
        // 后端返回的是「报关单数组」, 每个含 items 子数组与表头字段; 取首项明细 + 表头平铺为预览行
        setParsedData(json.data.items.map((d: any, i: number) => {
          const it = (d.items && d.items[0]) || {};
          return {
            row: i + 1,
            hsCode: it.hsCode || '',
            description: it.description || '',
            model: it.model || '',
            quantity: it.quantity ?? 1,
            unit: it.unit || '件',
            unitPrice: it.unitPrice ?? 0,
            fobAmount: it.totalPrice ?? d.totalValue ?? 0,
            originCountry: it.originCountry || '',
            legalQty: it.legalQty, legalUnit: it.legalUnit, legalQty2: it.legalQty2, legalUnit2: it.legalUnit2,
            consignee: d.consignee || d.importerExporter || defaultExporter,
            consignor: d.consignor || '',
            importerExporter: d.importerExporter || d.consignee || defaultExporter,
            contractNo: d.contractNo || '',
            transportMode: d.transportMode || '',
            portOfEntry: d.portOfEntry || '',
            tradeTerms: d.tradeTerms || '',
            currency: d.currency || 'USD',
            destinationCountry: d.destinationCountry || '',
            grossWeight: d.grossWeight, netWeight: d.netWeight,
            packageCount: d.numberOfPackages, packageType: d.packageType,
            freightRate: d.freightRate, insuranceRate: d.insuranceRate,
            // 跨境电商字段
            orderNo: d.orderNo || '', paymentNo: d.paymentNo || '', logisticsNo: d.logisticsNo || '',
            ecommercePlatform: d.ecommercePlatform || '',
            b2bOrderNo: d.b2bOrderNo || '', b2bPlatform: d.b2bPlatform || '',
            warehouseAddress: d.warehouseAddress || '', fnSku: d.fnSku || '',
          };
        }));
        message.success(`解析成功，共 ${json.data.count} 条记录`);
      } else {
        message.error(json.error || '解析失败');
      }
    } catch (err: any) {
      message.error(`解析失败: ${err.message}`);
    } finally {
      setLoading(false);
    }
    return false;
  };

  const downloadXml = (r: BatchResult) => {
    if (!r.xml) { message.warning('该条无可导出的XML'); return; }
    const blob = new Blob([r.xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${r.declarationNo || 'declaration'}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAllXml = async () => {
    const withXml = results.filter(r => r.xml);
    if (withXml.length === 0) { message.warning('暂无可导出的XML，请先批量构建'); return; }
    try {
      const res = await fetch('/api/declaration/zip-xml', {
        method: 'POST',
        headers: { ...headers },
        body: JSON.stringify({ files: withXml.map(r => ({ name: r.declarationNo, content: r.xml })) }),
      });
      if (!res.ok) throw new Error('打包失败 (' + res.status + ')');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `declarations_${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      message.success(`已打包导出 ${withXml.length} 个报关单XML(ZIP)`);
    } catch (e: any) {
      message.error('批量导出失败: ' + (e.message || '请稍后重试'));
    }
  };

  const handleDownloadTemplate = async () => {
    try {
      const res = await fetch('/api/declaration/import-template', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('下载失败 (' + res.status + ')');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'batch_import_template.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      message.error('模板下载失败: ' + (e.message || '请稍后重试'));
    }
  };

  const handleBatchBuild = async () => {
    if (parsedData.length === 0) {
      message.warning('请先导入数据');
      return;
    }
    setLoading(true);
    try {
      const batches = allData.map(item => ({
        hsCodes: [item.hsCode],
        importerExporter: item.importerExporter || defaultExporter || undefined,
        consignee: item.consignee || item.importerExporter || defaultExporter || undefined,
        consignor: item.consignor || undefined,
        customsMode,
        currency: item.currency || 'USD',
        contractNo: item.contractNo || undefined,
        transportMode: item.transportMode || undefined,
        portOfEntry: item.portOfEntry || undefined,
        tradeTerms: item.tradeTerms || undefined,
        destinationCountry: item.destinationCountry || undefined,
        grossWeight: item.grossWeight, netWeight: item.netWeight,
        numberOfPackages: item.packageCount, packageType: item.packageType || undefined,
        freightRate: item.freightRate, freightMark: item.freightRate != null ? '3' : undefined, freightCurrency: item.currency || 'USD',
        insuranceRate: item.insuranceRate, insuranceMark: item.insuranceRate != null ? '3' : undefined, insuranceCurrency: item.currency || 'USD',
        // buildDeclaration 读取的是 itemDetails(而非 items); 用它承载明细, 避免数量/单价/描述被丢弃
        itemDetails: [{
          hsCode: item.hsCode,
          description: item.description,
          model: item.model,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: item.unitPrice != null ? item.unitPrice : (item.quantity ? (item.fobAmount / item.quantity) : item.fobAmount),
          originCountry: item.originCountry || '中国',
          legalQty: item.legalQty, legalUnit: item.legalUnit, legalQty2: item.legalQty2, legalUnit2: item.legalUnit2,
        }],
        // 根据模式传电商字段
        ...(customsMode === '9610' ? { orderNo: item.orderNo, paymentNo: item.paymentNo, logisticsNo: item.logisticsNo, ecommercePlatform: item.ecommercePlatform } : {}),
        ...(customsMode === '9710' ? { b2bOrderNo: item.b2bOrderNo, b2bPlatform: item.b2bPlatform } : {}),
        ...(customsMode === '9810' ? { warehouseAddress: item.warehouseAddress, fnSku: item.fnSku } : {}),
      }));

      const res = await fetch('/api/declaration/batch-export', {
        method: 'POST',
        headers: { ...headers },
        body: JSON.stringify({ batches }),
      });
      const json = await res.json();
      if (json.success && json.data?.declarations) {
        const rs: BatchResult[] = json.data.declarations.map((d: any, i: number) => ({
          row: i + 1,
          status: d.preCheck?.passed ? 'success' : 'error',
          declarationNo: d.declarationNo || `BATCH-${Date.now()}-${i + 1}`,
          score: d.preCheck?.score ?? 0,
          itemCount: d.itemCount ?? 1,
          xml: d.xml || '',
          message: d.preCheck?.passed ? '合规通过，已保存到草稿箱' : `评分 ${d.preCheck?.score ?? 0}，已保存到草稿箱`,
        }));
        setResults(rs);
        const saved = json.data.savedCount || 0;
        message.success(`批量构建完成，成功 ${rs.filter(r => r.status === 'success').length}/${rs.length}，已保存 ${saved} 条`);
        // #9 单票项数上限提示(海关单票上限 50 项)
        const over = rs.filter(r => (r.itemCount ?? 0) > MAX_ITEMS_PER_DECLARATION);
        if (over.length > 0) {
          message.warning(`有 ${over.length} 条报关单商品项数超过 ${MAX_ITEMS_PER_DECLARATION} 项上限，需拆分为多票申报`);
        }
      } else {
        message.error(json.error || '批量构建失败');
      }
    } catch (err: any) {
      message.error(`批量构建失败: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const [manualRows, setManualRows] = useState<BatchItem[]>([]);
  const addManualRow = () => {
    const prefix: any = {};
    if (customsMode === '9610') {
      prefix.orderNo = ''; prefix.paymentNo = ''; prefix.logisticsNo = ''; prefix.ecommercePlatform = '';
    } else if (customsMode === '9710') {
      prefix.b2bOrderNo = ''; prefix.b2bPlatform = '';
    } else if (customsMode === '9810') {
      prefix.warehouseAddress = ''; prefix.fnSku = '';
    }
    setManualRows([...manualRows, { row: manualRows.length + 1, hsCode: '', description: '', quantity: 1, unit: '件', fobAmount: 0, ...prefix }]);
  };

  const allData = [...parsedData, ...manualRows];

  // 根据模式动态显示列
  const ecommerceColumns = customsMode === '9610'
    ? [
        { title: '订单号', dataIndex: 'orderNo', key: 'orderNo', width: 120 },
        { title: '支付单号', dataIndex: 'paymentNo', key: 'paymentNo', width: 120 },
        { title: '物流单号', dataIndex: 'logisticsNo', key: 'logisticsNo', width: 120 },
      ]
    : customsMode === '9710'
    ? [
        { title: 'B2B订单号', dataIndex: 'b2bOrderNo', key: 'b2bOrderNo', width: 120 },
        { title: 'B2B平台', dataIndex: 'b2bPlatform', key: 'b2bPlatform', width: 100 },
      ]
    : customsMode === '9810'
    ? [
        { title: '海外仓地址', dataIndex: 'warehouseAddress', key: 'warehouseAddress', width: 160, ellipsis: true },
        { title: 'FNSKU', dataIndex: 'fnSku', key: 'fnSku', width: 120 },
      ]
    : [];

  const columns = [
    { title: '#', dataIndex: 'row', key: 'row', width: 40 },
    { title: 'HS编码', dataIndex: 'hsCode', key: 'hsCode', width: 100 },
    { title: '商品描述', dataIndex: 'description', key: 'description', ellipsis: true },
    { title: '规格型号', dataIndex: 'model', key: 'model', width: 140, ellipsis: true,
      render: (v: string) => v ? v : <Tag color="red">缺</Tag> },
    { title: '数量', dataIndex: 'quantity', key: 'quantity', width: 70 },
    { title: '单位', dataIndex: 'unit', key: 'unit', width: 60 },
    { title: 'FOB金额', dataIndex: 'fobAmount', key: 'fobAmount', width: 110, render: (v: number) => `$${v?.toLocaleString() ?? 0}` },
    { title: '原产国', dataIndex: 'originCountry', key: 'originCountry', width: 80,
      render: (v: string) => v ? v : <Tag color="red">缺</Tag> },
    { title: '境内收发货人', dataIndex: 'consignee', key: 'consignee', width: 140, ellipsis: true,
      render: (v: string) => v ? v : <Tag color="red">缺</Tag> },
    ...ecommerceColumns,
  ];

  const resultColumns = [
    { title: '#', dataIndex: 'row', key: 'row', width: 40 },
    { title: '结果', dataIndex: 'status', key: 'status', width: 80,
      render: (s: string) => s === 'success' ? <Tag color="green" icon={<CheckCircleOutlined />}>通过</Tag> : <Tag color="red" icon={<CloseCircleOutlined />}>失败</Tag> },
    { title: '报关单号', dataIndex: 'declarationNo', key: 'declarationNo', ellipsis: true },
    { title: '项数', dataIndex: 'itemCount', key: 'itemCount', width: 70,
      render: (v: number) => v > MAX_ITEMS_PER_DECLARATION ? <Tag color="red">{v}·超限</Tag> : (v ?? '-') },
    { title: '评分', dataIndex: 'score', key: 'score', width: 70, render: (v: number) => <Tag color={v >= 60 ? 'green' : 'red'}>{v}</Tag> },
    { title: '说明', dataIndex: 'message', key: 'message' },
    { title: '导出', key: 'export', width: 90,
      render: (_: any, r: BatchResult) => <Button size="small" icon={<DownloadOutlined />} disabled={!r.xml} onClick={() => downloadXml(r)}>XML</Button> },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Title level={4}>批量申报</Title>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card title="1. 导入Excel" size="small">
            <Upload
              accept=".xlsx,.xls,.csv"
              fileList={fileList}
              beforeUpload={handleParse}
              onRemove={() => { setFileList([]); setParsedData([]); }}
              maxCount={1}
            >
              <Button icon={<UploadOutlined />}>选择Excel文件</Button>
            </Upload>
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">
                支持 .xlsx / .xls / .csv
              </Text>
            </div>
            <div style={{ marginTop: 8 }}>
              <Button size="small" icon={<DownloadOutlined />} onClick={handleDownloadTemplate}>
                下载导入模板
              </Button>
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                含海关必填列(收发货人/规格型号/法定计量单位/运保杂费等)与填表说明
              </Text>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="2. 批量配置" size="small">
            <Form layout="inline" size="small">
              <Form.Item label="监管方式(贸易方式)">
                <Select value={customsMode} onChange={setCustomsMode} style={{ width: 180 }}
                  options={[
                    { value: 'normal', label: '一般贸易(0110)' },
                    { value: '9610', label: <span><ShoppingCartOutlined /> 跨境电商零售出口</span> },
                    { value: '9710', label: <span><GlobalOutlined /> B2B直接出口</span> },
                    { value: '9810', label: <span><DatabaseOutlined /> 出口海外仓</span> },
                    { value: '1210', label: '保税电商出口(1210)' },
                    { value: '1239', label: '保税电商出口A(1239)' },
                  ]} />
              </Form.Item>
              <Form.Item label="默认进出口商">
                <Input value={defaultExporter} onChange={e => setDefaultExporter(e.target.value)} placeholder="企业名称（可选）" style={{ width: 200 }} />
              </Form.Item>
            </Form>
            {customsMode !== 'normal' && (
              <Alert
                message={`${(customsMode === '9610' || customsMode === '1210' || customsMode === '1239') ? 'Excel需包含: 订单号/支付单号/物流单号/电商平台' : customsMode === '9710' ? 'Excel需包含: B2B订单号/B2B平台' : 'Excel需包含: 海外仓地址/FNSKU'}`}
                type="info" showIcon style={{ marginBottom: 8, fontSize: 12 }}
              />
            )}
            <div style={{ marginTop: 8 }}>
              <Button type="primary" onClick={handleBatchBuild} loading={loading}
                icon={<DownloadOutlined />} disabled={allData.length === 0}
                style={{ marginRight: 8 }}>
                批量构建（{allData.length}条）
              </Button>
              <Button onClick={addManualRow} icon={<FileExcelOutlined />}>手工添加一行</Button>
            </div>
          </Card>
        </Col>
      </Row>

      {allData.length > 0 && (
        <Card title="数据预览" size="small" style={{ marginTop: 16 }}>
          <Table dataSource={allData} columns={columns} rowKey="row" pagination={false} size="small" scroll={{ x: 'max-content' }} />
        </Card>
      )}

      {results.length > 0 && (
        <Card title="批量构建结果" size="small" style={{ marginTop: 16 }}
          extra={<Button type="primary" size="small" icon={<DownloadOutlined />} onClick={downloadAllXml} disabled={!results.some(r => r.xml)}>全部导出XML(ZIP)</Button>}>
          <Alert
            type={results.some(r => r.status === 'error') ? 'warning' : 'success'}
            message={`成功 ${results.filter(r => r.status === 'success').length}/${results.length}`}
            showIcon style={{ marginBottom: 12 }}
          />
          <Table dataSource={results} columns={resultColumns} rowKey="row" pagination={false} size="small" />
        </Card>
      )}
    </div>
  );
}
