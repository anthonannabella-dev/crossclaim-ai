import { useState } from 'react';
import { Row, Col, Card, Select, Button, Table, Tag, Typography, message, Spin, Space, Divider, Tooltip, Modal } from 'antd';
import { SwapOutlined, CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, ExportOutlined, FileExcelOutlined, FileTextOutlined } from '@ant-design/icons';
import api from '../utils/api';

const { Title, Text } = Typography;

interface DeclarationSummary {
  id: string;
  declarationNo: string | null;
  status: string;
  customsMode: string;
  totalValue: number;
  score: number | null;
  createdAt: string;
}

export default function DeclarationComparePage() {
  const [list, setList] = useState<DeclarationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [leftId, setLeftId] = useState<string | undefined>();
  const [rightId, setRightId] = useState<string | undefined>();
  const [diffResult, setDiffResult] = useState<any>(null);
  const [audit, setAudit] = useState<{ left: any; right: any } | null>(null);

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  const fetchList = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/declaration/list', { headers });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const data = (json.data?.items || json.data || []).slice(0, 50);
      setList(data);
      if (data.length >= 2) { setLeftId(data[0].id); setRightId(data[1].id); }
      else if (data.length === 0) message.info('暂无报关单记录，请先在「自动化报关」生成报关单');
    } catch (e: any) {
      setList([]);
      message.error('加载报关单失败：' + (e?.message || '网络错误'));
    } finally { setLoading(false); }
  };

  const handleCompare = async () => {
    if (!leftId || !rightId) { message.warning('请选择两个报关单'); return; }
    if (leftId === rightId) { message.warning('请选择不同的报关单'); return; }
    setLoading(true);
    setAudit(null);
    try {
      const [lRes, rRes] = await Promise.all([
        fetch('/api/declaration/'+leftId+'/detail', { headers }),
        fetch('/api/declaration/'+rightId+'/detail', { headers }),
      ]);
      const lJson = await lRes.json(); const rJson = await rRes.json();
      const left = lJson.data || lJson; const right = rJson.data || rJson;
      setDiffResult(computeDiff(left, right));
      // 以报关员视角，对左右两单各自跑一遍权威合规规则(勾稽/成交方式↔运保费/申报要素/法规依据)
      runRuleAudit(leftId, rightId);
    } catch {
      const left = list.find(d=>d.id===leftId); const right = list.find(d=>d.id===rightId);
      if (left && right) {
        message.warning('无法获取报关单明细，仅按列表概要字段对比');
        setDiffResult(computeDiff(left, right));
      } else {
        message.error('对比失败：未能获取报关单数据');
      }
    } finally { setLoading(false); }
  };

  // 报关员核对规则：复用后端权威预检(runPreCheck)，左右各跑一遍
  const runRuleAudit = async (lId?: string, rId?: string) => {
    if (!lId || !rId) return;
    setAudit(null);
    const one = async (id: string) => {
      try {
        const res = await fetch('/api/declaration/pre-check', {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        const j = await res.json();
        return j.success ? j.data : null;
      } catch { return null; }
    };
    const [left, right] = await Promise.all([one(lId), one(rId)]);
    setAudit({ left, right });
  };

  const handleSync = (direction: 'left-to-right' | 'right-to-left') => {
    if (!diffResult) { message.warning('请先进行对比'); return; }
    message.info('已在本页对齐差异字段（仅预览，不会写回报关单；请据此到「自动化报关」手工订正）');
    const newFields = diffResult.fields.map((f: any) => {
      if (!f.diff) return f;
      if (direction === 'left-to-right') {
        return { ...f, right: f.left, diff: false };
      } else {
        return { ...f, left: f.right, diff: false };
      }
    });
    setDiffResult({ ...diffResult, fields: newFields, synced: true });
  };

  // CSV 导出
  const exportCSV = () => {
    if (!diffResult) { message.warning('请先进行对比'); return; }
    const head = ['字段名', '左侧值(' + diffResult.leftName + ')', '右侧值(' + diffResult.rightName + ')', '是否一致'];
    const rows = diffResult.fields.map((f: any) => [f.label, f.left, f.right, f.diff ? '不一致' : '一致']);
    const csv = '\uFEFF' + [head.join(','), ...rows.map((r: any) => r.map((v: any) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(','))].join('\n');
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), '报关单对比_' + diffResult.leftName + '_vs_' + diffResult.rightName + '.csv');
    message.success('CSV 已导出');
  };

  // XLSX 导出（SpreadsheetML 2003，Excel 原生可打开，无需额外依赖）
  const exportXLSX = () => {
    if (!diffResult) { message.warning('请先进行对比'); return; }
    const esc = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const headCells = ['字段名', '左侧值(' + diffResult.leftName + ')', '右侧值(' + diffResult.rightName + ')', '是否一致']
      .map(h => '<Cell ss:StyleID="hdr"><Data ss:Type="String">' + esc(h) + '</Data></Cell>').join('');
    const bodyRows = diffResult.fields.map((f: any) => {
      const sid = f.diff ? ' ss:StyleID="diff"' : '';
      const cells = [f.label, f.left, f.right, f.diff ? '不一致' : '一致']
        .map(c => '<Cell' + sid + '><Data ss:Type="String">' + esc(c) + '</Data></Cell>').join('');
      return '<Row>' + cells + '</Row>';
    }).join('');
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<?mso-application progid="Excel.Sheet"?>\n' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
      '<Styles>' +
      '<Style ss:ID="hdr"><Font ss:Bold="1"/><Interior ss:Color="#D9E1F2" ss:Pattern="Solid"/></Style>' +
      '<Style ss:ID="diff"><Interior ss:Color="#FFF2CC" ss:Pattern="Solid"/></Style>' +
      '</Styles>\n' +
      '<Worksheet ss:Name="报关单对比"><Table>' +
      '<Row>' + headCells + '</Row>' + bodyRows +
      '</Table></Worksheet></Workbook>';
    downloadBlob(new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8;' }), '报关单对比_' + diffResult.leftName + '_vs_' + diffResult.rightName + '.xls');
    message.success('Excel 已导出');
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div style={{ padding: 24 }}>
      <Row gutter={[16, 16]} align="middle" style={{ marginBottom: 16 }}>
        <Col flex="auto"><Title level={4} style={{ margin: 0 }}>报关单对比</Title></Col>
        <Col>
          <Button onClick={fetchList} loading={loading}>加载报关单</Button>
        </Col>
        <Col>
          <Button type="primary" icon={<SwapOutlined />} onClick={handleCompare} loading={loading}>开始对比</Button>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={11}>
          <Select value={leftId} onChange={setLeftId} style={{ width: '100%' }}
            placeholder="选择左侧报关单"
            options={list.map((d:any)=>({value:d.id,label:(d.declarationNo||d.id)+' ['+d.status+']'}))} />
        </Col>
        <Col span={2} style={{ textAlign:'center', paddingTop:4 }}><SwapOutlined style={{ fontSize:20, color:'#1890ff' }} /></Col>
        <Col span={11}>
          <Select value={rightId} onChange={setRightId} style={{ width: '100%' }}
            placeholder="选择右侧报关单"
            options={list.map((d:any)=>({value:d.id,label:(d.declarationNo||d.id)+' ['+d.status+']'}))} />
        </Col>
      </Row>

      <Spin spinning={loading}>
        {diffResult ? (
          <>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={24}>
                <Space wrap>
                  <Text strong>差异预览对齐：</Text>
                  <Tooltip title="仅在本页对齐差异以便人工核对，不会写回报关单">
                    <Button icon={<SyncOutlined />} onClick={()=>handleSync('left-to-right')}>
                      以左侧为准
                    </Button>
                  </Tooltip>
                  <Tooltip title="仅在本页对齐差异以便人工核对，不会写回报关单">
                    <Button icon={<SyncOutlined />} onClick={()=>handleSync('right-to-left')}>
                      以右侧为准
                    </Button>
                  </Tooltip>
                  <Divider type="vertical" />
                  <Text strong>导出：</Text>
                  <Button icon={<FileExcelOutlined />} onClick={exportXLSX}>导出 Excel</Button>
                  <Button icon={<FileTextOutlined />} onClick={exportCSV}>导出 CSV</Button>
                  {diffResult.synced && <Tag color="blue" icon={<CheckCircleOutlined />}>已对齐预览</Tag>}
                </Space>
              </Col>
            </Row>
            {audit && (
              <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={11}><RuleAuditPanel title={diffResult.leftName} data={audit.left} /></Col>
                <Col span={2} />
                <Col span={11}><RuleAuditPanel title={diffResult.rightName} data={audit.right} /></Col>
              </Row>
            )}
            <Row gutter={16}>
              <Col span={11}>
                <Card title={diffResult.leftName} size="small"
                  extra={<Text type="secondary">{diffResult.fields.filter((f:any)=>f.diff).length} 处差异</Text>}>
                  <CompareFields data={diffResult.fields} side="left" />
                </Card>
              </Col>
              <Col span={2} style={{ textAlign:'center', paddingTop:20 }}>
                <Text type="secondary">vs</Text>
              </Col>
              <Col span={11}>
                <Card title={diffResult.rightName} size="small"
                  extra={<Text type="secondary">{diffResult.fields.filter((f:any)=>f.diff).length} 处差异</Text>}>
                  <CompareFields data={diffResult.fields} side="right" />
                </Card>
              </Col>
            </Row>
          </>
        ) : (
          <Card><div style={{ textAlign:'center', color:'#ccc', padding:40 }}>选择两个报关单后点击「开始对比」</div></Card>
        )}
      </Spin>
    </div>
  );
}

// 把后端 detail 结构铺平：顶层(declarationNo/status/...) + declaration(报关单表头) 合并
function flattenHeader(d: any): any {
  return { ...(d || {}), ...((d && d.declaration) || {}) };
}
// 商品行字段取值（兼容多种命名）
function itemVal(it: any, keys: string[]): string {
  if (!it) return '-';
  for (const k of keys) {
    if (it[k] !== undefined && it[k] !== null && it[k] !== '') return String(it[k]);
  }
  return '-';
}

function ComputeDiff(a: any, b: any) {
  const fields: { key:string; label:string; left:string; right:string; diff:boolean }[] = [];
  const ha = flattenHeader(a); const hb = flattenHeader(b);

  // ── 表头字段 ──
  const headerKeys: [string,string][] = [
    ['declarationNo','报关单号'],['status','状态'],['customsMode','申报模式'],
    ['supervisionCode','监管方式'],['taxMethod','计税方式'],
    ['totalValue','总价'],['currency','币种'],['score','合规评分'],
    ['transportMode','运输方式'],['portOfEntry','进出境关别'],['tradeTerms','成交方式'],
    ['consignee','收货人'],['consignor','发货人'],['declarant','申报单位'],
    ['contractNo','合同协议号'],['vesselFlight','船名/航次'],['billOfLading','提运单号'],
    ['grossWeight','毛重'],['netWeight','净重'],
    // 跨境电商可选维度（存在才有意义，否则两侧均为 - 视为一致）
    ['ecommercePlatform','电商平台'],['orderNo','订单号'],['paymentNo','支付单号'],
    ['logisticsNo','物流单号'],['warehouseAddress','海外仓地址'],
  ];
  for (const [k,label] of headerKeys) {
    const ls = (ha?.[k] ?? '-') === '' ? '-' : String(ha?.[k] ?? '-');
    const rs = (hb?.[k] ?? '-') === '' ? '-' : String(hb?.[k] ?? '-');
    fields.push({ key:'h_'+k, label, left:ls, right:rs, diff:ls!==rs });
  }

  // ── 逐项商品对比（按行展开，报关员最关心的口径）──
  const ia: any[] = Array.isArray(a?.items) ? a.items : [];
  const ib: any[] = Array.isArray(b?.items) ? b.items : [];
  const n = Math.max(ia.length, ib.length);
  const itemCols: [string,string[]][] = [
    ['HS编码', ['hsCode','codeTS','hscode']],
    ['品名', ['productName','gName','gname','name']],
    ['数量', ['quantity','qty','gQty']],
    ['单位', ['unit','gUnit']],
    ['单价', ['unitPrice','declPrice','price']],
    ['原产国', ['originCountry','origin','originCountryCode']],
  ];
  for (let i = 0; i < n; i++) {
    for (const [label, keys] of itemCols) {
      const ls = itemVal(ia[i], keys);
      const rs = itemVal(ib[i], keys);
      fields.push({ key:`it_${i}_${label}`, label:`商品${i+1}·${label}`, left:ls, right:rs, diff:ls!==rs });
    }
  }

  return {
    leftName: ha?.declarationNo || a?.id || '左侧',
    rightName: hb?.declarationNo || b?.id || '右侧',
    fields, synced: false,
  };
}
const computeDiff = ComputeDiff;

function RuleAuditPanel({ title, data }: { title: string; data: any }) {
  if (!data) {
    return <Card size="small" title={<span>报关员核对规则 · {title}</span>}>
      <Text type="secondary">未获取到规则校验结果</Text>
    </Card>;
  }
  const issues: any[] = data.issues || [];
  const errs = issues.filter(i => i.severity === 'error');
  const warns = issues.filter(i => i.severity === 'warning');
  const sevColor = (s: string) => s === 'error' ? '#cf1322' : s === 'warning' ? '#fa8c16' : '#1890ff';
  const sevBg = (s: string) => s === 'error' ? '#fff2f0' : s === 'warning' ? '#fffbe6' : '#e6f4ff';
  return (
    <Card size="small"
      title={<span>报关员核对规则 · {title}</span>}
      extra={
        <Space size={4}>
          <Tag color={data.passed ? 'success' : 'error'}>{data.passed ? '规则通过' : '存在问题'}</Tag>
          <Tag>{data.score} 分</Tag>
        </Space>
      }>
      {issues.length === 0 ? (
        <Text type="success"><CheckCircleOutlined /> 未发现违规（勾稽/成交方式/申报要素等规则均通过）</Text>
      ) : (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>{errs.length} 错误 · {warns.length} 警告</Text>
          <div style={{ marginTop: 6, maxHeight: 240, overflowY: 'auto' }}>
            {issues.filter(i => i.code !== 'AI001').map((i, idx) => (
              <div key={idx} style={{ padding: '6px 8px', marginBottom: 4, borderRadius: 4, background: sevBg(i.severity) }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Tag color={sevColor(i.severity)} style={{ marginRight: 0 }}>{i.code}</Tag>
                  {i.field && <Tag color="geekblue">{i.field}</Tag>}
                  <Text style={{ fontSize: 13 }}>{i.message}</Text>
                </div>
                {i.suggestion && <div style={{ color: '#666', fontSize: 12, marginTop: 2 }}>{i.suggestion}</div>}
                {i.legalBasis && <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 2 }}>📖 {i.legalBasis}</div>}
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

function CompareFields({ data, side }: { data: any[]; side:'left'|'right' }) {
  return (
    <div>
      {data.map((f:any)=>(
        <div key={f.key} style={{
          display:'flex', justifyContent:'space-between', padding:'6px 0',
          borderBottom:'1px solid #f0f0f0',
          background: f.diff ? (side==='left'?'#fff2f0':'#fffbe6') : 'transparent',
        }}>
          <Tooltip title={f.key}>
            <Text type="secondary" style={{fontSize:12}}>{f.label}</Text>
          </Tooltip>
          <Text strong style={{
            fontSize:12,
            color: f.diff ? (side==='left'?'#cf1322':'#fa8c16') : 'inherit',
          }}>{f[side]}</Text>
        </div>
      ))}
    </div>
  );
}
