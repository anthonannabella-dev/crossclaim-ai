import { useState, useRef } from 'react';
import {
  Row, Col, Card, Upload, Button, Table, Tag, Select, Input, message, Spin,
  Modal, Tabs, Space, Alert, Typography, Tooltip, Divider, Checkbox, Radio,
} from 'antd';
import {
  UploadOutlined, DownloadOutlined, EyeOutlined, FileTextOutlined,
  CheckCircleOutlined, CloseCircleOutlined, WarningOutlined,
  ExportOutlined, GroupOutlined, EditOutlined, SaveOutlined,
  FileExcelOutlined, FilePdfOutlined,
} from '@ant-design/icons';
import api from '../utils/api';

const { Text, Title } = Typography;
const { Dragger } = Upload;

// ========== 导出工具 ==========
function exportSingleWindowCSV(data: any[], fileName: string) {
  const headers = [
    '报关单号','申报单位','申报日期','进出口标志','海关编号','备案号',
    '合同协议号','提运单号','运输方式','运输工具名称','航次号',
    '起运国/目的国','装货港/指运港','成交方式','运费','保费','杂费',
    '经营单位','发货单位','收货单位','申报单位代码',
    '商品序号','商品编号(HS)','商品名称','规格型号','数量及单位',
    '原产国/目的国','单价','总价','币制','征免方式',
  ];
  const rows = data.map((d: any) => {
    let p: any = {};
    try { if (d.ocrResult) p = JSON.parse(d.ocrResult); } catch {}
    const f: string[] = [];
    f.push(d.declarationNo || d.fileName?.replace(/\.[^.]+$/, '') || '');
    f.push(p.declarant || ''); f.push(d.createdAt?.slice(0,10)||'');
    f.push(p.importExport||''); f.push(p.customsCode||''); f.push(p.recordNo||'');
    f.push(d.contractNo||p.contractNo||''); f.push(p.billOfLading||p.vesselFlight||'');
    f.push(p.transportMode||''); f.push(p.vesselFlight||''); f.push(p.voyageNo||'');
    f.push(p.country||''); f.push(p.port||''); f.push(p.tradeTerms||'');
    f.push(p.freight||''); f.push(p.insurance||''); f.push('');
    f.push(p.declarant||''); f.push(p.consignor||''); f.push(p.consignee||''); f.push(p.declarantCode||'');
    f.push('1'); f.push(p.hsCode||p.hsCodes?.[0]||''); f.push(p.productName||p.itemName||'');
    f.push(p.specification||''); f.push(p.quantity ? p.quantity+(p.unit||'') : '');
    f.push(p.originCountry||p.destinationCountry||''); f.push(p.unitPrice||'');
    f.push(p.totalValue||p.totalAmount||''); f.push(p.currency||'USD'); f.push(p.taxMethod||'照章征税');
    return f;
  });
  const csv = '\uFEFF' + [headers.join(','), ...rows.map(r=>r.map(v=>'"'+String(v||'').replace(/"/g,'""')+'"').join(','))].join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName+'_单一窗口模板.csv'; a.click();
}

function exportNormalCSV(data: any[], fileName: string) {
  const headers = ['文件名','类型','归类','项目标签','合同号','状态','校验','OCR摘要','大小(KB)','上传时间'];
  const rows = data.map(d => [
    d.fileName, d.fileType, categoryLabels[d.category]||d.category||'-',
    d.projectTag||'-', d.contractNo||'-', d.status,
    d.auditPassed===true?'通过':d.auditPassed===false?'未通过':'',
    d.ocrResult?.slice(0,100)?.replace(/\s+/g,' ')||'',
    d.fileSize?(d.fileSize/1024).toFixed(1):'-',
    d.createdAt?new Date(d.createdAt).toLocaleString('zh-CN'):'',
  ]);
  const csv = '\uFEFF' + [headers.join(','), ...rows.map(r=>r.map(v=>'"'+String(v||'').replace(/"/g,'""')+'"').join(','))].join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName+'_存档.csv'; a.click();
}

function exportToPDF(items: any[]) {
  const w = window.open('','_blank');
  if (!w) { message.error('请允许弹窗'); return; }
  let h = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>随附单据</title>';
  h += '<style>body{font-family:sans-serif;padding:20px}';
  h += 'table{width:100%;border-collapse:collapse;margin-bottom:20px}';
  h += 'th,td{border:1px solid #ccc;padding:6px;font-size:12px;text-align:left}';
  h += 'th{background:#f5f5f5}img{max-width:100%;max-height:400px;margin:10px 0}';
  h += '@media print{@page{size:A4;margin:15mm}}';
  h += '</style></head><body>';
  h += '<h2>随附单据报表</h2><p>生成时间: '+new Date().toLocaleString('zh-CN')+'</p>';
  items.forEach((d,i)=>{
    h += '<h3>#'+(i+1)+'. '+escHtml(d.fileName)+'</h3>';
    h += '<p>类型: '+(d.fileType||'')+' | 归类: '+(categoryLabels[d.category]||d.category||'-');
    if (d.projectTag) h+=' | 项目: '+escHtml(d.projectTag);
    if (d.contractNo) h+=' | 合同: '+escHtml(d.contractNo);
    h+=' | 大小: '+(d.fileSize?(d.fileSize/1024).toFixed(1)+'KB':'-')+'</p><hr/>';
    if (['png','jpg','jpeg','gif','bmp','webp','tiff'].includes(d.fileType?.toLowerCase())) {
      h += '<img src="/api/documents/'+d.id+'/download" style="max-width:100%" onerror="this.style.display=\'none\'" />';
    }
    if (d.ocrResult) {
      h += '<h4>OCR识别内容</h4><pre style="font-size:11px;background:#f9f9f9;padding:8px">'+escHtml(d.ocrResult.slice(0,3000))+'</pre>';
    }
    h += '<div style="page-break-after:always"></div>';
  });
  h += '</body></html>';
  w.document.write(h); w.document.close();
  setTimeout(()=>{ w.print(); }, 500);
}
function escHtml(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

const categoryLabels: Record<string, string> = {
  customs_declaration: '报关单', certificate: '证明', contract: '合同',
  invoice: '发票', packing_list: '装箱单', bill_of_lading: '提单',
  // 跨境电商单据（OCR可识别）
  ecommerce_order: '平台订单', logistics_label: '物流面单',
  payment_voucher: '支付凭证', fba_inbound: 'FBA入仓单',
  general: '通用',
};

function simulateAudit(file: any) {
  const ext = (file.fileType||'').toLowerCase();
  const name = (file.fileName||'').toLowerCase();
  let score = 80; const issues: string[] = [];
  if (!name.match(/^(合同|发票|装箱单|提单|报关单|证明|平台订单|物流面单|支付凭证|FBA入仓单)/)) { score-=10; issues.push('文件名建议以单证类型开头'); }
  if (!['pdf','png','jpg','jpeg','tiff','bmp'].includes(ext)) { score-=20; issues.push('格式不符合海关要求'); }
  if (file.fileSize > 10*1024*1024) { score-=15; issues.push('文件超过10MB'); }
  return { passed: score>=60, score, summary: score>=60?'校验通过('+score+'分)':'校验未通过('+score+'分): '+issues.join(';') };
}

export default function OCRPage() {
  const [activeTab, setActiveTab] = useState('single');

  // ---- 单文件识别 ----
  const [singleFile, setSingleFile] = useState<File|null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [singleResult, setSingleResult] = useState<any>(null);
  const [parsedData, setParsedData] = useState<any>(null);
  const [parsedEdit, setParsedEdit] = useState<any>(null);
  const [editing, setEditing] = useState(false);

  const handleSingleUpload = (file: File) => { setSingleFile(file); setSingleResult(null); setParsedData(null); return false; };
  const startSingleOCR = async () => {
    if (!singleFile) { message.warning('请选择文件'); return; }
    setRecognizing(true);
    try {
      const fd = new FormData(); fd.append('file', singleFile);
      const res = await api.post('/api/ocr/recognize', fd);
      setSingleResult(res.data);
      const audit = simulateAudit({ fileName: singleFile.name, fileType: singleFile.name.split('.').pop() });
      try {
        const parseRes = await api.post('/api/ocr/parse-to-declaration', fd);
        const parsed = parseRes.data?.parsed || {};
        setParsedData({ ...parsed, _audit: audit }); setParsedEdit({ ...parsed, _audit: audit });
      } catch {
        setParsedData({ _audit: audit }); setParsedEdit({ _audit: audit });
      }
      message.success('识别完成');
    } catch (err: any) { message.error(err.response?.data?.error || '识别失败'); }
    finally { setRecognizing(false); }
  };

  const handleEditField = (field: string, value: string) => setParsedEdit((p: any) => ({...p, [field]: value}));
  const saveEdits = () => { setParsedData({...parsedEdit}); setEditing(false); message.success('已保存'); };

  const exportSingle = (fmt: string) => {
    const items = [singleResult || { fileName: singleFile?.name, ocrResult: JSON.stringify(parsedEdit||{}) }];
    const name = singleFile?.name?.replace(/\.[^.]+$/,'')||'单据';
    if (fmt==='single-window') exportSingleWindowCSV(items, name);
    else if (fmt==='normal') exportNormalCSV(items, name);
    else if (fmt==='csv') {
      const csv = '\uFEFF文件名,识别摘要\n'+items.map(d=>'"'+(d.fileName||'')+'","'+((d.ocrResult||d.recognizedText||'')?.slice(0,500)||'').replace(/"/g,'""')+'"').join('\n');
      const blob = new Blob([csv],{type:'text/csv;charset=utf-8;'}); const a=document.createElement('a');
      a.href=URL.createObjectURL(blob); a.download=name+'_识别结果.csv'; a.click();
    } else if (fmt==='pdf') exportToPDF(items);
    message.success('导出成功');
  };

  // ---- 批量识别 ----
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchCategory, setBatchCategory] = useState('general');
  const [batchProjectTag, setBatchProjectTag] = useState('');
  const [batchContractNo, setBatchContractNo] = useState('');
  const [batchBillOfLading, setBatchBillOfLading] = useState('');
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchResults, setBatchResults] = useState<any[]>([]);
  const [autoAuditBatch, setAutoAuditBatch] = useState(true);
  const [vesselGroups, setVesselGroups] = useState<any[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<React.Key[]>([]);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState('single-window');

  const addBatchFile = (f: File) => { setBatchFiles(p=>[...p,f]); return false; };
  const removeBatchFile = (n: string) => setBatchFiles(p=>p.filter(f=>f.name!==n));

  const startBatchOCR = async () => {
    if (!batchFiles.length) { message.warning('请选择文件'); return; }
    setBatchProcessing(true);
    const results: any[] = [];
    for (const file of batchFiles) {
      try {
        const fd = new FormData();
        fd.append('file', file); fd.append('category', batchCategory);
        fd.append('projectTag', batchProjectTag); fd.append('contractNo', batchContractNo);
        const res = await api.post('/api/ocr/recognize', fd);
        results.push({ fileName: file.name, ...res.data, success: true });
        // 自动归档
        try {
          const ufd = new FormData();
          ufd.append('file', file); ufd.append('category', batchCategory);
          ufd.append('projectTag', batchProjectTag); ufd.append('contractNo', batchContractNo);
          ufd.append('billOfLading', batchBillOfLading);
          ufd.append('billOfLading', batchBillOfLading);
          const ur = await api.post('/api/documents/upload', ufd);
          if (autoAuditBatch && ur.data?.id) {
            const a = simulateAudit({ fileName: file.name, fileType: file.name.split('.').pop() });
            if (!a.passed) await api.put('/api/documents/'+ur.data.id, { auditPassed: false, auditScore: a.score, auditSummary: a.summary });
          }
        } catch {}
      } catch (err: any) {
        results.push({ fileName: file.name, success: false, error: err.response?.data?.error||'识别失败' });
      }
    }
    setBatchResults(results); setBatchProcessing(false);
    message.success('完成: '+results.filter(r=>r.success).length+'成功, '+results.filter(r=>!r.success).length+'失败');
    // 自动提运单分组
    const ok = results.filter(r=>r.success);
    if (ok.length) {
      const groups: Record<string, any[]> = {};
      ok.forEach(d => {
        const text = d.recognizedText||d.text||d.ocrResult||'';
        let key = '未分组';
        const m = text.match(/(?:提单号|提运单号|VESSEL|FLIGHT|航次|BL\s*No)[：:.\s]*([A-Za-z0-9\-]+)/i);
        // 电商单据：尝试提取订单号/物流单号
        const orderM = !m && text.match(/(?:订单号|Order\s*No|Order\s*ID)[：:.\s]*([A-Za-z0-9\-]+)/i);
        const logisticM = !m && text.match(/(?:物流单号|跟踪号|Tracking|运单号)[：:.\s]*([A-Za-z0-9\-]+)/i);
        if (orderM) key = '订单_' + orderM[1];
        if (logisticM) key = '物流_' + logisticM[1];
        if (m) key = m[1];
        if (!groups[key]) groups[key] = [];
        groups[key].push(d);
      });
      setVesselGroups(Object.entries(groups).map(([k,v])=>({ vesselNo: k, count: v.length, documents: v })));
    }
  };

  const handleBatchExport = () => {
    const items = selectedBatch.length ? selectedBatch.map(k=>batchResults.find(r=>r.key===k||r.documentId===k)).filter(Boolean) : batchResults.filter(r=>r.success);
    if (!items.length) { message.warning('无可导出数据'); return; }
    const name = '批量识别_'+new Date().toISOString().slice(0,10);
    if (exportFormat==='single-window') exportSingleWindowCSV(items, name);
    else if (exportFormat==='normal') exportNormalCSV(items, name);
    else if (exportFormat==='csv') {
      const csv = '\uFEFF文件名,状态,摘要\n'+items.map(d=>'"'+(d.fileName||'')+'","'+(d.success?'成功':'失败')+'","'+((d.recognizedText||d.ocrResult||'')?.slice(0,300)||'').replace(/"/g,'""')+'"').join('\n');
      const blob = new Blob([csv],{type:'text/csv;charset=utf-8;'}); const a=document.createElement('a');
      a.href=URL.createObjectURL(blob); a.download=name+'_批量结果.csv'; a.click();
    } else if (exportFormat==='pdf') exportToPDF(items);
    setExportModalOpen(false); message.success('导出完成 ('+items.length+'条)');
  };

  const parsedFields = [
    {key:'declarant',label:'申报单位'},{key:'declarantCode',label:'申报单位代码'},{key:'importerExporter',label:'进出口商'},
    {key:'transportMode',label:'运输方式'},{key:'vesselFlight',label:'船名/航次'},{key:'portOfLoading',label:'起运港'},
    {key:'portOfDischarge',label:'目的港'},{key:'tradeTerms',label:'贸易条款'},{key:'currency',label:'币制'},
    {key:'contractNo',label:'合同号'},{key:'billOfLading',label:'提运单号'},{key:'containerNo',label:'集装箱号'},
    {key:'packageType',label:'包装种类'},{key:'grossWeight',label:'毛重'},{key:'netWeight',label:'净重'},
    {key:'packageCount',label:'件数'},{key:'dutyMode',label:'征免方式'},{key:'hsCode',label:'HS编码'},
    {key:'productName',label:'商品名称'},{key:'specification',label:'规格型号'},{key:'quantity',label:'数量'},
    {key:'unitPrice',label:'单价'},{key:'totalValue',label:'总价'},{key:'originCountry',label:'原产国'},
  ];

  const singleTab = (
    <div>
      <Card style={{marginBottom:16}}>
        <Dragger beforeUpload={handleSingleUpload} showUploadList={false} accept="image/*,.pdf">
          <p className="ant-upload-drag-icon"><UploadOutlined/></p>
          <p>{singleFile?'已选择: '+singleFile.name:'点击或拖拽单证文件'}</p>
        </Dragger>
        {singleFile && (
          <div style={{marginTop:12,textAlign:'center'}}>
            <Button type="primary" size="large" icon={<FileTextOutlined/>}
              onClick={startSingleOCR} loading={recognizing}>{recognizing?'识别中...':'开始识别 & 解析'}</Button>
            <Button style={{marginLeft:8}} onClick={()=>{setSingleFile(null);setSingleResult(null);setParsedData(null);}}>重新选择</Button>
          </div>
        )}
      </Card>

      {parsedData && (
        <Card title={<Space>识别结果<Alert style={{display:'inline-block',margin:0}} type={parsedData._audit?.passed?'success':'warning'} message={parsedData._audit?.summary||''} showIcon/></Space>} style={{marginBottom:16}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
            <Text strong>解析字段 (在线核对)</Text>
            {editing?(
              <Space><Button type="primary" size="small" icon={<SaveOutlined/>} onClick={saveEdits}>保存</Button><Button size="small" onClick={()=>{setEditing(false);setParsedEdit({...parsedData});}}>取消</Button></Space>
            ):(
              <Button size="small" icon={<EditOutlined/>} onClick={()=>setEditing(true)}>在线核对</Button>
            )}
          </div>
          <Table dataSource={parsedFields.filter(f=>parsedEdit?.[f.key]||editing)}
            columns={[{title:'字段',dataIndex:'label',width:120},{title:'值',dataIndex:'key',render:(k:string)=>editing?<Input size="small" value={parsedEdit?.[k]||''} onChange={e=>handleEditField(k,e.target.value)}/>:<Text>{parsedEdit?.[k]||<Text type="secondary">未识别</Text>}</Text>}]}
            rowKey="key" pagination={false} size="small" showHeader={false} style={{marginBottom:12}}/>
        </Card>
      )}

      {singleResult && (
        <Card title="导出">
          <Space direction="vertical" style={{width:'100%'}} size="small">
            <Alert type="info" showIcon message="操作提示" description={<ul style={{margin:0,paddingLeft:16}}>
              <li>导入海关单一窗口 → <Tag color="green">单一窗口模板 XLSX</Tag>（字段名称、顺序严格匹配海关官方标准）</li>
              <li>导入自有平台、二次编辑 → <Tag color="orange">CSV 格式</Tag>（UTF-8 BOM编码，避免中文乱码）</li>
              <li>本地留存、内部对账 → <Tag color="blue">普通存档 XLSX</Tag></li>
              <li>发票、箱单等随附单据 → <Tag color="red">PDF 格式</Tag></li>
            </ul>} style={{marginBottom:12}}/>
            <Row gutter={[12,12]}>
              <Col span={12}><Button block icon={<FileExcelOutlined/>} onClick={()=>exportSingle('single-window')}>单一窗口模板 XLSX</Button></Col>
              <Col span={12}><Button block icon={<FileExcelOutlined/>} onClick={()=>exportSingle('normal')}>普通存档 XLSX</Button></Col>
              <Col span={12}><Button block icon={<FileTextOutlined/>} onClick={()=>exportSingle('csv')}>CSV (UTF-8 BOM)</Button></Col>
              <Col span={12}><Button block icon={<FilePdfOutlined/>} onClick={()=>exportSingle('pdf')}>PDF 随附单据</Button></Col>
            </Row>
          </Space>
        </Card>
      )}
    </div>
  );

  const batchTab = (
    <div>
      <Card style={{marginBottom:16}}>
        <Space direction="vertical" style={{width:'100%'}} size="middle">
          <Row gutter={12}>
            <Col span={6}><div style={{fontSize:12,color:'#666',marginBottom:4}}>归类</div>
              <Select value={batchCategory} onChange={setBatchCategory} style={{width:'100%'}}>
                {Object.entries(categoryLabels).map(([k,v])=><Select.Option key={k} value={k}>{v}</Select.Option>)}</Select></Col>
            <Col span={6}><div style={{fontSize:12,color:'#666',marginBottom:4}}>项目标签</div>
              <Input value={batchProjectTag} onChange={e=>setBatchProjectTag(e.target.value)} placeholder="例: 王一博物料"/></Col>
            <Col span={6}><div style={{fontSize:12,color:'#666',marginBottom:4}}>合同号</div>
              <Input value={batchContractNo} onChange={e=>setBatchContractNo(e.target.value)} placeholder="例: HW-2026-001"/></Col>
            <Col span={6}><div style={{fontSize:12,color:'#666',marginBottom:4}}>提运单号 <span style={{color:'#999',fontWeight:400}}>(可选)</span></div>
              <Input value={batchBillOfLading} onChange={e=>setBatchBillOfLading(e.target.value)} placeholder="例: MSCU1234567"/></Col>
          </Row>
          <Dragger multiple beforeUpload={addBatchFile} showUploadList={false} accept="image/*,.pdf">
            <p className="ant-upload-drag-icon"><UploadOutlined/></p>
            <p>点击或拖拽文件（支持批量上传，不限数量）</p>
          </Dragger>
          {batchFiles.length>0 && (
            <Card size="small" title={'待处理 '+batchFiles.length+' 个文件'}>
              {batchFiles.map(f=><Tag key={f.name} closable onClose={()=>removeBatchFile(f.name)}>{f.name} ({(f.size/1024).toFixed(1)}KB)</Tag>)}
            </Card>
          )}
          <Checkbox checked={autoAuditBatch} onChange={e=>setAutoAuditBatch(e.target.checked)}>识别后自动校验并归档</Checkbox>
          <Button type="primary" block size="large" loading={batchProcessing}
            onClick={startBatchOCR} disabled={!batchFiles.length}>
            {batchProcessing?'处理中...':'批量识别 & 自动归档 ('+batchFiles.length+' 个文件)'}
          </Button>
        </Space>
      </Card>

      {vesselGroups.length>0 && (
        <Card title={<Space><GroupOutlined/><span>提运单分组</span></Space>} style={{marginBottom:16}}>
          {vesselGroups.map((g,i)=>(
            <Card key={i} size="small" style={{marginBottom:8}}
              title={<Space><Tag color="blue">{g.vesselNo}</Tag><span>{g.count} 份单据</span></Space>}>
              <Space wrap>{g.documents.map((d:any)=><Tag key={d.fileName||d.id}>{d.fileName||d.documentId}</Tag>)}</Space>
            </Card>
          ))}
        </Card>
      )}

      {batchResults.length>0 && (
        <Card title={<Space><span>批量识别结果 ({batchResults.length})</span>
          <Button size="small" icon={<ExportOutlined/>} onClick={()=>setExportModalOpen(true)}>导出</Button>
          <Button size="small" icon={<GroupOutlined/>} onClick={()=>{
            const ok = batchResults.filter(r=>r.success);
            const groups: Record<string,any[]> = {};
            ok.forEach(d=>{
              const text = d.recognizedText||d.text||d.ocrResult||'';
              let key = '未分组'; const m = text.match(/(?:提单号|提运单号|VESSEL|FLIGHT|航次|BL\s*No)[：:.\s]*([A-Za-z0-9\-]+)/i);
              const orderM = !m && text.match(/(?:订单号|Order\s*No|Order\s*ID)[：:.\s]*([A-Za-z0-9\-]+)/i);
              const logisticM = !m && text.match(/(?:物流单号|跟踪号|Tracking|运单号)[：:.\s]*([A-Za-z0-9\-]+)/i);
              if (orderM) key = '订单_' + orderM[1];
              if (logisticM) key = '物流_' + logisticM[1];
              if (m) key = m[1]; if (!groups[key]) groups[key] = []; groups[key].push(d);
            });
            setVesselGroups(Object.entries(groups).map(([k,v])=>({vesselNo:k,count:v.length,documents:v})));
          }}>按提运单分组</Button>
        </Space>}>
          <Table dataSource={batchResults.map((r,i)=>({...r,key:r.documentId||i}))}
            columns={[
              {title:'文件名',dataIndex:'fileName',key:'fileName',ellipsis:true},
              {title:'状态',dataIndex:'success',key:'success',width:80,render:(v:boolean)=>v?<Tag color="success">成功</Tag>:<Tag color="error">失败</Tag>},
              {title:'提运单分组',key:'group',width:120,render:(_,r:any)=>{
                for(const g of vesselGroups){if(g.documents.find((d:any)=>d.fileName===r.fileName))return<Tag color="blue">{g.vesselNo}</Tag>}
                return '-';
              }},
              {title:'识别摘要',key:'summary',ellipsis:true,render:(_:any,r:any)=>(r.recognizedText||r.ocrResult||'')?.slice(0,80)||'-'},
            ]}
            rowKey="key" size="small" pagination={{pageSize:20}}
            rowSelection={{selectedRowKeys:selectedBatch,onChange:setSelectedBatch}}/>
        </Card>
      )}
    </div>
  );

  return (
    <div>
      <Title level={4}>OCR 识别 & 批量处理</Title>
      <Alert type="info" showIcon message="操作提示："
        description={<ul style={{margin:0,paddingLeft:16}}>
          <li>导入海关单一窗口，请选择 <Tag color="green">单一窗口模板 XLSX</Tag>（字段名称、顺序严格匹配海关官方标准）</li>
          <li>导入自有平台、二次编辑可使用 <Tag color="orange">CSV 格式</Tag>（UTF-8 BOM编码，避免中文乱码）</li>
          <li>本地留存、内部对账选择 <Tag color="blue">普通存档 XLSX</Tag></li>
          <li>发票、箱单等随附单据，请导出 <Tag color="red">PDF 格式</Tag>后单独上传</li>
        </ul>}
        style={{marginBottom:16}}/>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        {key:'single',label:'单图识别 & 智能解析',children:singleTab},
        {key:'batch',label:'批量识别录入 (分组)',children:batchTab},
      ]}/>
      <Modal title="批量导出" open={exportModalOpen} onCancel={()=>setExportModalOpen(false)} footer={null} destroyOnClose>
        <Space direction="vertical" style={{width:'100%'}} size="middle">
          <Text>已选 <b>{selectedBatch.length||batchResults.filter(r=>r.success).length}</b> 条识别结果</Text>
          <div style={{background:'#f5f5f5',padding:12,borderRadius:6}}>
            <Text strong style={{display:'block',marginBottom:8}}>选择导出格式：</Text>
            <Radio.Group value={exportFormat} onChange={e=>setExportFormat(e.target.value)}>
              <Space direction="vertical">
                <Radio value="single-window"><Tag color="green">单一窗口模板 XLSX</Tag><Text type="secondary" style={{fontSize:12}}> — 导入海关单一窗口</Text></Radio>
                <Radio value="normal"><Tag color="blue">普通存档 XLSX</Tag><Text type="secondary" style={{fontSize:12}}> — 本地留存、对账</Text></Radio>
                <Radio value="csv"><Tag color="orange">CSV (UTF-8 BOM)</Tag><Text type="secondary" style={{fontSize:12}}> — 自有平台导入、二次编辑</Text></Radio>
                <Radio value="pdf"><Tag color="red">PDF 随附单据</Tag><Text type="secondary" style={{fontSize:12}}> — 发票、箱单等</Text></Radio>
              </Space>
            </Radio.Group>
          </div>
          <Button type="primary" block size="large" onClick={handleBatchExport}>
            导出 ({exportFormat==='single-window'?'单一窗口模板':exportFormat==='normal'?'普通存档':exportFormat==='csv'?'CSV':'PDF'})
          </Button>
        </Space>
      </Modal>
    </div>
  );
}