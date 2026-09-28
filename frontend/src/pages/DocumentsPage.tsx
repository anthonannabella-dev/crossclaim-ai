import { useEffect, useState } from 'react';
import {
  Table, Upload, Button, Card, message, Tag, Select, Space, Input, Popconfirm,
  Modal, Tabs, Alert, Progress, Descriptions, Drawer, Skeleton, Empty, Badge, Typography,
  Image, Form, Tooltip, Row, Col, Checkbox, Divider,
} from 'antd';
import {
  UploadOutlined, DownloadOutlined, DeleteOutlined, SearchOutlined,
  AuditOutlined, SwapOutlined, InboxOutlined, CheckCircleOutlined,
  CloseCircleOutlined, WarningOutlined, InfoCircleOutlined,
  FileTextOutlined, ExportOutlined, SaveOutlined, TagsOutlined,
  LinkOutlined, ProjectOutlined,
} from '@ant-design/icons';
import api from '../utils/api';

const { Dragger } = Upload;

interface DocCategory {
  key: string;
  label: string;
  color: string;
  group: string;  // 分组：core | inspection | logistics | regulatory | custom
  groupLabel: string;
}

const CATEGORIES: DocCategory[] = [
  // ===== 1. 核心基础单据 =====
  { key: 'bill_of_lading',    label: '提单',          color: 'magenta',  group: 'core',        groupLabel: '核心基础单据' },
  { key: 'packing_list',      label: '装箱单',        color: 'cyan',     group: 'core',        groupLabel: '核心基础单据' },
  { key: 'invoice',           label: '发票',          color: 'orange',   group: 'core',        groupLabel: '核心基础单据' },
  { key: 'contract',          label: '合同',          color: 'purple',   group: 'core',        groupLabel: '核心基础单据' },
  { key: 'power_of_attorney', label: '电子代理报关委托书', color: 'geekblue', group: 'core', groupLabel: '核心基础单据' },
  { key: 'non_wood_declaration', label: '非木质包装声明', color: 'gold',       group: 'core', groupLabel: '核心基础单据' },

  // ===== 2. 检验与产地证 =====
  { key: 'certificate_of_origin',  label: '原产地证',       color: 'green',    group: 'inspection', groupLabel: '检验与产地证' },
  { key: 'health_certificate',     label: '卫生证书',       color: 'green',    group: 'inspection', groupLabel: '检验与产地证' },
  { key: 'quarantine_certificate', label: '检疫证书',       color: 'green',    group: 'inspection', groupLabel: '检验与产地证' },
  { key: 'fumigation_certificate', label: '熏蒸证书',       color: 'green',    group: 'inspection', groupLabel: '检验与产地证' },

  // ===== 3. 物流配套单据 =====
  { key: 'shipping_order',  label: '装货单',   color: 'blue',     group: 'logistics', groupLabel: '物流配套单据' },
  { key: 'delivery_order',  label: '提货单',   color: 'blue',     group: 'logistics', groupLabel: '物流配套单据' },
  { key: 'cargo_manifest',  label: '舱单',     color: 'blue',     group: 'logistics', groupLabel: '物流配套单据' },

  // ===== 4. 监管与特殊单据(预留) =====
  { key: 'license',         label: '许可证',     color: 'volcano', group: 'regulatory', groupLabel: '监管与特殊单据' },
  { key: 'processing_trade', label: '加工贸易',   color: 'volcano', group: 'regulatory', groupLabel: '监管与特殊单据' },
  { key: 'customs_declaration', label: '报关单', color: 'blue',     group: 'regulatory', groupLabel: '监管与特殊单据' },

  // ===== 5. 自定义扩展 =====
  { key: 'general',         label: '通用',       color: 'default', group: 'custom', groupLabel: '自定义扩展' },
];

// 从分类列表生成 colors/labels 字典
const categoryColors: Record<string, string> = {};
const categoryLabels: Record<string, string> = {};
CATEGORIES.forEach(c => { categoryColors[c.key] = c.color; categoryLabels[c.key] = c.label; });

// 按分组归类
const CATEGORY_GROUPS = CATEGORIES.reduce((acc, c) => {
  if (!acc[c.group]) acc[c.group] = { groupLabel: c.groupLabel, categories: [] };
  acc[c.group].categories.push(c);
  return acc;
}, {} as Record<string, { groupLabel: string; categories: DocCategory[] }>);

// 总列表(带全部分类)
const ALL_CATEGORY_OPTIONS = CATEGORIES.map(c => ({ label: c.label, value: c.key }));

// ========== 导出工具 ==========
function exportToCSV(data: any[], fileName: string) {
  const headers = ['文件名','类型','归类','项目标签','合同号','提运单号','状态','校验','大小(KB)','上传时间'];
  const rows = data.map(d => [
    d.fileName, d.fileType,
    categoryLabels[d.category] || d.category || '-',
    d.projectTag || '-', d.contractNo || '-', d.billOfLading || '-',
    d.status, d.auditPassed === true ? '通过' : d.auditPassed === false ? '未通过' : '-',
    d.fileSize ? (d.fileSize / 1024).toFixed(1) : '-',
    d.createdAt ? new Date(d.createdAt).toLocaleString('zh-CN') : '-',
  ]);
  const csv = '\uFEFF' + [headers.join(','), ...rows.map(r => r.map(v => '"'+String(v).replace(/"/g,'""')+'"').join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName+'.csv';
  a.click();
}
function exportToXML(data: any[]) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<DeclarationBatch>\n';
  data.forEach((d,i) => {
    xml += `  <Document seq="${i+1}">\n`;
    xml += `    <FileName>${esc(d.fileName||'')}</FileName>\n`;
    xml += `    <Category>${d.category||''}</Category>\n`;
    xml += `    <ProjectTag>${esc(d.projectTag||'')}</ProjectTag>\n`;
    xml += `    <ContractNo>${esc(d.contractNo||'')}</ContractNo>\n`;
    xml += `    <BillOfLading>${esc(d.billOfLading||'')}</BillOfLading>\n`;
    xml += `    <Status>${d.status||''}</Status>\n`;
    xml += `    <OcrResult><![CDATA[${d.ocrResult||''}]]></OcrResult>\n`;
    xml += `  </Document>\n`;
  });
  xml += '</DeclarationBatch>';
  const blob = new Blob([xml], {type:'application/xml;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'declaration_export_'+new Date().toISOString().slice(0,10)+'.xml';
  a.click();
}
function esc(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// 模拟AI校验
function simulateAudit(file: any) {
  const ext = (file.fileType||'').toLowerCase();
  const name = (file.fileName||'').toLowerCase();
  let score = 80;
  const issues: string[] = [];
  if (!name.match(/^(合同|发票|装箱单|提单|报关单|证明)/)) { score -= 10; issues.push('文件名建议以单证类型开头'); }
  if (!['pdf','png','jpg','jpeg','tiff','bmp'].includes(ext)) { score -= 20; issues.push('格式不符合海关要求'); }
  if (file.fileSize > 10*1024*1024) { score -= 15; issues.push('文件超过10MB可能被拒收'); }
  if (file.fileSize < 1024) { score -= 5; issues.push('文件过小可能为空'); }
  if (!file.category || file.category === 'general') { score -= 5; issues.push('建议指定单证归类'); }
  const passed = score >= 60;
  return { passed, score, summary: passed ? `校验通过 (${score}分)` : `校验未通过 (${score}分): ${issues.join(';')}` };
}

export default function DocumentsPage() {
  const [docs, setDocs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string|undefined>();
  const [projectFilter, setProjectFilter] = useState<string|undefined>();
  const [contractFilter, setContractFilter] = useState<string|undefined>();

  const [uploadOpen, setUploadOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [uploadCategory, setUploadCategory] = useState('general');
  const [uploadProjectTag, setUploadProjectTag] = useState('');
  const [uploadContractNo, setUploadContractNo] = useState('');
const [uploadBillOfLading, setUploadBillOfLading] = useState('');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [autoAudit, setAutoAudit] = useState(true);

  const [previewDoc, setPreviewDoc] = useState<any>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [editDoc, setEditDoc] = useState<any>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editCategory, setEditCategory] = useState('general');
  const [editProjectTag, setEditProjectTag] = useState('');
  const [editContractNo, setEditContractNo] = useState('');
const [editBillOfLading, setEditBillOfLading] = useState('');

  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [batchBLOpen, setBatchBLOpen] = useState(false);
  const [batchBLValue, setBatchBLValue] = useState('');
  const [batchCatOpen, setBatchCatOpen] = useState(false);
  const [batchCatValue, setBatchCatValue] = useState('');

  const [crossCheckOpen, setCrossCheckOpen] = useState(false);
  const [crossCheckResult, setCrossCheckResult] = useState<any>(null);
  const [crossCheckLoading, setCrossCheckLoading] = useState(false);
  const [checkDims, setCheckDims] = useState<string[]>(["contractNo","billOfLading","category"]);

  // 可选核验维度定义
  const checkDimensions = [
    { key: "contractNo", label: "合同号", desc: "同项目合同号是否统一" },
    { key: "billOfLading", label: "提单号", desc: "同项目提单号是否统一" },
    { key: "category", label: "单据类型覆盖", desc: "发票/装箱单/提单是否齐全" },
    { key: "quantity", label: "件数", desc: "同项目单据件数是否一致（OCR提取）" },
    { key: "amount", label: "金额", desc: "发票金额与申报金额是否一致" },
  ];

  const fetchDocs = async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/documents');
      setDocs(res.data || []);
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };
  useEffect(() => { fetchDocs(); }, []);

  // 上传
  const handleAddToUpload = (file: File) => { setUploadFiles(p=>[...p,file]); return false; };
  const removeUploadFile = (name: string) => { setUploadFiles(p=>p.filter(f=>f.name!==name)); };

  const startUpload = async () => {
    if (uploadFiles.length===0) { message.warning('请选择文件'); return; }
    setUploading(true);
    let ok=0, fail=0;
    for (const file of uploadFiles) {
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('category', uploadCategory);
        fd.append('projectTag', uploadProjectTag);
        fd.append('contractNo', uploadContractNo);
      fd.append('billOfLading', uploadBillOfLading);
        if (autoAudit) {
          const audit = simulateAudit({ fileName: file.name, fileType: file.name.split('.').pop(), fileSize: file.size, category: uploadCategory });
          const res = await api.post('/api/documents/upload', fd);
          if (res.data?.id && !audit.passed) {
            await api.put(`/api/documents/${res.data.id}`, { auditPassed: false, auditScore: audit.score, auditSummary: audit.summary });
            fail++;
            message.warning(`${file.name}: ${audit.summary}`);
          } else { ok++; }
        } else {
          await api.post('/api/documents/upload', fd);
          ok++;
        }
      } catch { fail++; }
    }
    setUploading(false);
    setUploadOpen(false);
    setUploadFiles([]);
    message.success(`上传完成: ${ok}成功${fail>0?','+fail+'个需关注':''}`);
    fetchDocs();
  };

  // 下载
  const handleDownload = async (doc: any) => {
    try {
      const res = await api.get('/api/documents/'+doc.id+'/download', { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = doc.fileName; a.click();
    } catch(e:any) { const msg=e?.response?.data?.error||e?.message||'未知错误'; message.error('下载失败: '+msg); }
  };

  // 删除
  const handleDelete = async (id: string) => {
    try { await api.delete('/api/documents/'+id); message.success('已删除'); fetchDocs(); }
    catch { message.error('删除失败'); }
  };

  // 行内编辑：补提单号 / 改归类（静默保存）
  const saveInline = async (id: string, patch: any) => {
    try { await api.put('/api/documents/'+id, patch); message.success('已更新'); fetchDocs(); }
    catch { message.error('更新失败'); }
  };

  // 批量补提单号
  const handleBatchBL = async () => {
    if (!batchBLValue.trim()) { message.warning('请输入提运单号'); return; }
    try {
      await Promise.all(selectedRowKeys.map(id => api.put('/api/documents/'+id, { billOfLading: batchBLValue.trim() })));
      message.success('已为 '+selectedRowKeys.length+' 份单证补填提运单号');
      setBatchBLOpen(false); setBatchBLValue(''); setSelectedRowKeys([]); fetchDocs();
    } catch { message.error('批量补填失败'); }
  };

  // 批量改归类
  const handleBatchCategory = async () => {
    if (!batchCatValue) { message.warning('请选择归类'); return; }
    try {
      await Promise.all(selectedRowKeys.map(id => api.put('/api/documents/'+id, { category: batchCatValue })));
      message.success('已为 '+selectedRowKeys.length+' 份单证更新归类');
      setBatchCatOpen(false); setBatchCatValue(''); setSelectedRowKeys([]); fetchDocs();
    } catch { message.error('批量改归类失败'); }
  };

  // 批量删除
  const handleBatchDelete = async () => {
    try {
      await Promise.all(selectedRowKeys.map(id => api.delete('/api/documents/'+id)));
      message.success('已删除 '+selectedRowKeys.length+' 份单证');
      setSelectedRowKeys([]); fetchDocs();
    } catch { message.error('批量删除失败'); }
  };

  // 预览
  const handleView = (doc: any) => { setPreviewDoc(doc); setPreviewOpen(true); };

  // 编辑
  const handleEdit = (doc: any) => {
    setEditDoc(doc);
    setEditCategory(doc.category||'general');
    setEditProjectTag(doc.projectTag||'');
    setEditContractNo(doc.contractNo||'');
    setEditBillOfLading(doc.billOfLading||'');
    setEditOpen(true);
  };
  const handleSaveEdit = async () => {
    if (!editDoc) return;
    try {
      await api.put('/api/documents/'+editDoc.id, { category: editCategory, projectTag: editProjectTag, contractNo: editContractNo, billOfLading: editBillOfLading });
      message.success('保存成功'); setEditOpen(false); fetchDocs();
    } catch { message.error('保存失败'); }
  };

  // 导出
  const handleExportCSV = (items?: any[]) => {
    const data = items||selectedRowKeys.map(k=>docs.find(d=>d.id===k)).filter(Boolean);
    if (!data.length) { message.warning('请选择单证'); return; }
    exportToCSV(data, '单证导出_'+new Date().toISOString().slice(0,10));
    message.success('已导出 '+data.length+' 条');
  };
  const handleExportXML = (items?: any[]) => {
    const data = items||selectedRowKeys.map(k=>docs.find(d=>d.id===k)).filter(Boolean);
    if (!data.length) { message.warning('请选择单证'); return; }
    exportToXML(data);
    message.success('已导出 '+data.length+' 条XML');
  };
  const handleExportAll = () => {
    if (!filtered.length) { message.warning('无可导出数据'); return; }
    exportToCSV(filtered, '全部单证_'+new Date().toISOString().slice(0,10));
    message.success('已导出全部 '+filtered.length+' 条');
  };

  // 过滤
  const allProjectTags = [...new Set(docs.map(d=>d.projectTag).filter(Boolean))] as string[];
  const allContractNos = [...new Set(docs.map(d=>d.contractNo).filter(Boolean))] as string[];
  const allCategories = [...new Set(docs.map(d=>d.category).filter(Boolean))] as string[];

  const filtered = docs.filter(d => {
    if (search && !d.fileName?.includes(search) && !d.contractNo?.includes(search) && !d.projectTag?.includes(search)) return false;
    if (categoryFilter && d.category !== categoryFilter) return false;
    if (projectFilter && d.projectTag !== projectFilter) return false;
    if (contractFilter && d.contractNo !== contractFilter) return false;
    return true;
  });

  // 交叉核验 - 基于勾选单据的多维度比对
  const runAutoCrossCheck = async () => {
    setCrossCheckOpen(true); setCrossCheckLoading(true);
    try {
      const selectedDocs = selectedRowKeys.map(k => docs.find(d => d.id === k)).filter(Boolean) as any[];
      if (selectedDocs.length < 2) {
        message.warning('请至少选择2份单据进行交叉核验');
        setCrossCheckLoading(false);
        return;
      }
      const inc: string[] = [];
      const warns: string[] = [];
      const dimResults: {key:string,label:string,status:string,msg:string}[] = [];

      // 维度1: 合同号一致性
      if (checkDims.includes('contractNo')) {
        const contracts = [...new Set(selectedDocs.map(d=>d.contractNo).filter(Boolean))];
        if (contracts.length > 1) {
          inc.push('⚠ 合同号不一致: '+contracts.join(', '));
          dimResults.push({key:'contractNo',label:'合同号',status:'fail',msg:'不一致: '+contracts.join(', ')});
        } else if (contracts.length === 1) {
          warns.push('✓ 合同号统一: '+contracts[0]);
          dimResults.push({key:'contractNo',label:'合同号',status:'pass',msg:'统一: '+contracts[0]});
        } else {
          dimResults.push({key:'contractNo',label:'合同号',status:'skip',msg:'未填写'});
        }
      }

      // 维度2: 提单号一致性
      if (checkDims.includes('billOfLading')) {
        const bls = [...new Set(selectedDocs.map(d=>d.billOfLading).filter(Boolean))];
        if (bls.length > 1) {
          inc.push('⚠ 提单号不一致: '+bls.join(', '));
          dimResults.push({key:'billOfLading',label:'提单号',status:'fail',msg:'不一致: '+bls.join(', ')});
        } else if (bls.length === 1) {
          warns.push('✓ 提单号统一: '+bls[0]);
          dimResults.push({key:'billOfLading',label:'提单号',status:'pass',msg:'统一: '+bls[0]});
        } else {
          dimResults.push({key:'billOfLading',label:'提单号',status:'skip',msg:'未填写'});
        }
      }

      // 维度3: 单据类型覆盖
      if (checkDims.includes('category')) {
        const cats = [...new Set(selectedDocs.map(d=>d.category).filter(Boolean))];
        const hasInvoice = cats.some(c=>['invoice','发票','商业发票'].includes(c));
        const hasPacking = cats.some(c=>['packing','装箱单','packing_list'].includes(c));
        const hasBL = cats.some(c=>['bl','提单','bill_of_lading'].includes(c));
        const missing: string[] = [];
        if (!hasInvoice) missing.push('发票/商业发票');
        if (!hasPacking) missing.push('装箱单');
        if (!hasBL) missing.push('提单');
        if (missing.length > 0 && missing.length < 3) {
          warns.push('📄 缺少单据类型: '+missing.join(', '));
          dimResults.push({key:'category',label:'单据覆盖',status:'warn',msg:'缺少: '+missing.join(', ')});
        } else if (missing.length >= 3) {
          inc.push('❌ 严重缺少核心单据: '+missing.join(', '));
          dimResults.push({key:'category',label:'单据覆盖',status:'fail',msg:'严重缺少: '+missing.join(', ')});
        } else {
          warns.push('✓ 单据类型齐全');
          dimResults.push({key:'category',label:'单据覆盖',status:'pass',msg:'齐全（发票+装箱单+提单）'});
        }
      }

      // 维度4: 件数校验
      if (checkDims.includes('quantity')) {
        try {
          const quantities = selectedDocs.map(d => {
            if (!d.ocrResult) return null;
            const m = d.ocrResult.match(/(?:件数|数量|quantity|packages?)[：:\s]*(\d+)/i);
            return m ? parseInt(m[1]) : null;
          }).filter((v:number|null) => v !== null) as number[];
          if (quantities.length >= 2 && new Set(quantities).size > 1) {
            warns.push('📦 件数不一致: '+quantities.join(' vs '));
            dimResults.push({key:'quantity',label:'件数',status:'warn',msg:'不一致: '+quantities.join(' vs ')});
          } else if (quantities.length >= 2) {
            warns.push('📦 件数统一: '+quantities[0]);
            dimResults.push({key:'quantity',label:'件数',status:'pass',msg:'统一: '+quantities[0]});
          } else {
            dimResults.push({key:'quantity',label:'件数',status:'skip',msg:'OCR无数据'});
          }
        } catch {
          dimResults.push({key:'quantity',label:'件数',status:'skip',msg:'解析失败'});
        }
      }

      // 维度5: 金额校验
      if (checkDims.includes('amount')) {
        try {
          const amounts = selectedDocs.map(d => {
            if (!d.ocrResult) return null;
            const m = d.ocrResult.match(/(?:金额|总金额|total|amount|invoice value)[：:\s]*([\d,.]+)/i);
            return m ? parseFloat(m[1].replace(/,/g,'')) : null;
          }).filter((v:number|null) => v !== null) as number[];
          if (amounts.length >= 2 && new Set(amounts.map(a=>Math.round(a))).size > 1) {
            warns.push('💰 金额不一致: '+amounts.map(a=>'$'+a).join(' vs '));
            dimResults.push({key:'amount',label:'金额',status:'warn',msg:'不一致: '+amounts.join(' vs ')});
          } else if (amounts.length >= 2) {
            warns.push('💰 金额一致: $'+amounts[0]);
            dimResults.push({key:'amount',label:'金额',status:'pass',msg:'一致: $'+amounts[0]});
          } else {
            dimResults.push({key:'amount',label:'金额',status:'skip',msg:'OCR无数据'});
          }
        } catch {
          dimResults.push({key:'amount',label:'金额',status:'skip',msg:'解析失败'});
        }
      }

      const status = inc.length === 0 ? (dimResults.some(d=>d.status==='warn')?'warn':'pass') : 'fail';
      setCrossCheckResult([{
        documents: selectedDocs,
        total: selectedDocs.length,
        inconsistencies: inc, warnings: warns,
        dimResults, status
      }]);
    } catch { message.error('核验失败'); }
    finally { setCrossCheckLoading(false); }
  };

  const columns = [
    { title: '文件名', dataIndex: 'fileName', key: 'fileName', ellipsis: true, width: 200,
      render: (v: string) => v?.length>40 ? <Tooltip title={v}>{v.slice(0,38)}..</Tooltip> : v },
    { title: '类型', dataIndex: 'fileType', key: 'fileType', width: 60, render: (v:string)=> <Tag>{v}</Tag> },
    { title: '归类', dataIndex: 'category', key: 'category', width: 165,
      render: (v:string, r:any)=> (
        <Space size={2}>
          {(!v || v==='general') && <Tooltip title="自动归类未确定，请人工确认"><Tag color="warning" style={{marginRight:0}}>待确认</Tag></Tooltip>}
          <Select size="small" bordered={false} value={v||undefined} placeholder="选择归类"
            style={{minWidth:92}} onChange={(val)=>saveInline(r.id,{category:val})} showSearch optionFilterProp="children">
            {Object.entries(CATEGORY_GROUPS).map(([gk, g]) => (
              <Select.OptGroup key={gk} label={g.groupLabel}>
                {g.categories.map(c => <Select.Option key={c.key} value={c.key}>{c.label}</Select.Option>)}
              </Select.OptGroup>
            ))}
          </Select>
        </Space>
      ) },
    { title: '项目标签', dataIndex: 'projectTag', key: 'projectTag', width: 110,
      render: (v:string)=> v ? <Tag icon={<ProjectOutlined/>} color="purple">{v}</Tag> : '-' },
    { title: '合同号', dataIndex: 'contractNo', key: 'contractNo', width: 130,
      render: (v:string)=> v ? <Tag icon={<LinkOutlined/>} color="cyan">{v}</Tag> : '-' },
    { title: '提运单号', dataIndex: 'billOfLading', key: 'billOfLading', width: 150,
      render: (v:string, r:any)=> (
        <Typography.Text
          editable={{ text: v||'', tooltip:'点击补填', onChange:(val)=>{ const t=(val||'').trim(); if(t!==(v||'')) saveInline(r.id,{billOfLading:t}); } }}
          type={v?undefined:'secondary'}>
          {v || '点击补填'}
        </Typography.Text>
      ) },
    { title: '状态', dataIndex: 'status', key: 'status', width: 70,
      render: (v:string)=> <Tag color={v==='success'?'success':'error'}>{v}</Tag> },
    { title: '自动校验', dataIndex: 'auditPassed', key: 'auditPassed', width: 80,
      render: (v:boolean|null,r:any)=> {
        if (v===true) return <Tag icon={<CheckCircleOutlined/>} color="success">通过</Tag>;
        if (v===false) return <Tooltip title={r.auditSummary}><Tag icon={<CloseCircleOutlined/>} color="error">{r.auditScore||'未通过'}</Tag></Tooltip>;
        return <Tag>-</Tag>;
      }},
    { title: '大小', dataIndex: 'fileSize', key: 'fileSize', width: 70,
      render: (v:number)=> v ? (v/1024).toFixed(1)+'KB' : '-' },
    { title: '上传时间', dataIndex: 'createdAt', key: 'createdAt', width: 150,
      render: (v:string)=> new Date(v).toLocaleString('zh-CN') },
    { title: '操作', key: 'actions', width: 180, fixed: 'right' as const,
      render: (_:any,r:any)=> (
        <Space size="small">
          <Button type="link" size="small" icon={<SearchOutlined/>} onClick={()=>handleView(r)}>查看</Button>
          <Button type="link" size="small" onClick={()=>handleEdit(r)}>修改</Button>
          <Button type="link" size="small" icon={<DownloadOutlined/>} onClick={()=>handleDownload(r)}>下载</Button>
          <Popconfirm title="确定删除？" onConfirm={()=>handleDelete(r.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined/>} />
          </Popconfirm>
        </Space>
      )},
  ];

  const isImg = (d:any) => ['png','jpg','jpeg','gif','bmp','webp','tiff'].includes(d.fileType?.toLowerCase());

  return (
    <div>
      <h2>单证档案管理</h2>

      <Card style={{marginBottom:16}} bodyStyle={{padding:'12px 16px'}}>
        <Row gutter={[12,12]} align="middle">
          <Col><Button type="primary" icon={<UploadOutlined/>} onClick={()=>setUploadOpen(true)}>上传单证</Button></Col>
          <Col><Button onClick={()=>setExportOpen(true)} icon={<ExportOutlined/>}>导出</Button></Col>
          <Col><Button onClick={runAutoCrossCheck} icon={<SwapOutlined/>}>交叉核验</Button></Col>
          <Col><Button onClick={handleExportAll} icon={<SaveOutlined/>}>全部备份</Button></Col>
          <Col flex="auto">
            <Input placeholder="搜索文件名/合同号/项目标签/提运单号" value={search} onChange={e=>setSearch(e.target.value)}
              prefix={<SearchOutlined/>} allowClear style={{width:'100%'}}/>
          </Col>
          {allCategories.length>1 && (
            <Col><Select placeholder="归类" value={categoryFilter} onChange={setCategoryFilter}
              allowClear style={{width:160}} showSearch>
              {Object.entries(CATEGORY_GROUPS).map(([gk, g]) => (
                <Select.OptGroup key={gk} label={g.groupLabel}>
                  {g.categories.map(c => <Select.Option key={c.key} value={c.key}>{c.label}</Select.Option>)}
                </Select.OptGroup>
              ))}
            </Select></Col>
          )}
          {allProjectTags.length>0 && (
            <Col><Select placeholder="项目标签" value={projectFilter} onChange={setProjectFilter}
              allowClear style={{width:130}}>
              {allProjectTags.map(t=><Select.Option key={t} value={t}>{t}</Select.Option>)}
            </Select></Col>
          )}
          {allContractNos.length>0 && (
            <Col><Select placeholder="合同号" value={contractFilter} onChange={setContractFilter}
              allowClear style={{width:150}}>
              {allContractNos.map(c=><Select.Option key={c} value={c}>{c}</Select.Option>)}
            </Select></Col>
          )}
        </Row>
        {filtered.length!==docs.length && (
          <div style={{marginTop:4,fontSize:12,color:'#999'}}>筛选 {filtered.length}/{docs.length} 条</div>
        )}
      </Card>

      {selectedRowKeys.length > 0 && (
        <Card size="small" style={{marginBottom:12, background:'#f0f7ff', borderColor:'#91caff'}} bodyStyle={{padding:'8px 16px'}}>
          <Space wrap>
            <span style={{fontWeight:500}}>已选 {selectedRowKeys.length} 份：</span>
            <Button size="small" type="primary" onClick={()=>{setBatchBLValue('');setBatchBLOpen(true);}}>批量补提单号</Button>
            <Button size="small" onClick={()=>{setBatchCatValue('');setBatchCatOpen(true);}}>批量改归类</Button>
            <Button size="small" icon={<ExportOutlined/>} onClick={()=>handleExportCSV()}>批量导出CSV</Button>
            <Popconfirm title={'确定删除选中的 '+selectedRowKeys.length+' 份单证？'} onConfirm={handleBatchDelete}>
              <Button size="small" danger icon={<DeleteOutlined/>}>批量删除</Button>
            </Popconfirm>
            <Button size="small" type="link" onClick={()=>setSelectedRowKeys([])}>取消选择</Button>
          </Space>
        </Card>
      )}

      <Table dataSource={filtered} columns={columns} rowKey="id" loading={loading}
        scroll={{x:1200}} pagination={{pageSize:20, showTotal:t=>'共 '+t+' 条'}} size="small"
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys,
          selections: [
            {key:'all',text:'全选', onSelect:()=>setSelectedRowKeys(filtered.map(d=>d.id))},
            {key:'clear',text:'清空', onSelect:()=>setSelectedRowKeys([])},
          ]
        }}
      />

      {/* 上传弹窗 */}
      <Modal title="上传单证" open={uploadOpen} onCancel={()=>{setUploadOpen(false);setUploadFiles([]);}}
        footer={null} width={600} destroyOnClose>
        <Space direction="vertical" style={{width:'100%'}} size="middle">
          <Row gutter={12}>
            <Col span={8}>
              <div style={{marginBottom:4,fontSize:12,color:'#666'}}>归类</div>
              <Select value={uploadCategory} onChange={setUploadCategory} style={{width:'100%'}}
                dropdownRender={menu => <>{menu}<Divider style={{margin:'4px 0'}}/><Button type="link" size="small" icon={<TagsOutlined/>} onClick={()=>{const n=prompt('请输入新分类名称'); if(n){const k='custom_'+Date.now(); setUploadCategory(k); message.success('已添加自定义分类: '+n+'，可在后续编辑中修改')}}}>新增自定义分类</Button></>}>
                {Object.entries(CATEGORY_GROUPS).map(([gk, g]) => (
                  <Select.OptGroup key={gk} label={g.groupLabel}>
                    {g.categories.map(c => <Select.Option key={c.key} value={c.key}>{c.label}</Select.Option>)}
                  </Select.OptGroup>
                ))}
              </Select>
            </Col>
            <Col span={8}>
              <div style={{marginBottom:4,fontSize:12,color:'#666'}}>项目标签</div>
              <Input value={uploadProjectTag} onChange={e=>setUploadProjectTag(e.target.value)} placeholder="例: 王一博/物料报关"/>
            </Col>
            <Col span={8}>
              <div style={{marginBottom:4,fontSize:12,color:'#666'}}>合同号</div>
              <Input value={uploadContractNo} onChange={e=>setUploadContractNo(e.target.value)} placeholder="例: HW-2026-001"/>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <div style={{marginBottom:4,fontSize:12,color:'#666'}}>提运单号 <span style={{color:'#999',fontWeight:400}}>(选填)</span></div>
              <Input value={uploadBillOfLading} onChange={e=>setUploadBillOfLading(e.target.value)} placeholder="例: MSCU1234567（不填也能上传）"/>
            </Col>
            <Col span={12}>
              <div style={{marginBottom:4,fontSize:12,color:'#666'}}>自动校验</div>
              <Checkbox checked={autoAudit} onChange={e=>setAutoAudit(e.target.checked)}>上传时自动检验文件合规性</Checkbox>
            </Col>
          </Row>
          <Dragger multiple beforeUpload={handleAddToUpload} showUploadList={false} accept="image/*,.pdf">
            <p className="ant-upload-drag-icon"><UploadOutlined/></p>
            <p>点击或拖拽文件上传</p>
          </Dragger>
          {uploadFiles.length>0 && (
            <Card size="small" title={'待上传 '+uploadFiles.length+' 个文件'}>
              {uploadFiles.map(f=><Tag key={f.name} closable onClose={()=>removeUploadFile(f.name)}>{f.name} ({(f.size/1024).toFixed(1)}KB)</Tag>)}
            </Card>
          )}
          <Button type="primary" block size="large" loading={uploading}
            onClick={startUpload} disabled={uploadFiles.length===0}>
            开始上传 ({uploadFiles.length} 个文件)
          </Button>
        </Space>
      </Modal>
      {/* 导出弹窗 */}
      <Modal title="导出单证" open={exportOpen} onCancel={()=>setExportOpen(false)} footer={null} destroyOnClose>
        <Space direction="vertical" style={{width:'100%'}} size="middle">
          <p>已选 <b>{selectedRowKeys.length}</b> 条，共 <b>{filtered.length}</b> 条</p>
          <Row gutter={12}>
            <Col span={12}>
              <Button block size="large" icon={<ExportOutlined/>}
                onClick={()=>handleExportCSV()}>导出选中为 CSV</Button>
              <div style={{fontSize:11,color:'#999',marginTop:4}}>可用 Excel 打开</div>
            </Col>
            <Col span={12}>
              <Button block size="large" icon={<FileTextOutlined/>}
                onClick={()=>handleExportXML()}>导出选中为 XML</Button>
              <div style={{fontSize:11,color:'#999',marginTop:4}}>报关系统兼容格式</div>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Button block icon={<ExportOutlined/>} onClick={()=>{handleExportCSV(filtered);setExportOpen(false);}}>导出全部为 CSV</Button></Col>
            <Col span={12}><Button block icon={<FileTextOutlined/>} onClick={()=>{handleExportXML(filtered);setExportOpen(false);}}>导出全部为 XML</Button></Col>
          </Row>
        </Space>
      </Modal>


      {/* 预览弹窗 */}
      <Modal title={previewDoc?.fileName||'预览'} open={previewOpen}
        onCancel={()=>setPreviewOpen(false)} footer={null} width={800} destroyOnClose>
        {previewDoc && isImg(previewDoc) ? (
          <div style={{textAlign:'center'}}>
            <Image src={'/api/documents/'+previewDoc.id+'/download'}
              style={{maxWidth:'100%',maxHeight:'70vh'}} preview={{mask:'点击放大'}}
              fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="/>
            <div style={{marginTop:12}}>
              <Space>
                <Button type="primary" icon={<DownloadOutlined/>} onClick={()=>handleDownload(previewDoc)}>下载原图</Button>
                {previewDoc.projectTag && <Tag icon={<ProjectOutlined/>} color="purple">{previewDoc.projectTag}</Tag>}
                {previewDoc.contractNo && <Tag icon={<LinkOutlined/>} color="cyan">{previewDoc.contractNo}</Tag>}
                <Tag color="blue">{previewDoc.fileType?.toUpperCase()}</Tag>
              </Space>
            </div>
            {previewDoc.auditSummary && (
              <Alert style={{marginTop:12,textAlign:'left'}}
                type={previewDoc.auditPassed?'success':'warning'} message={previewDoc.auditSummary} showIcon/>
            )}
          </div>
        ) : (
          <div style={{textAlign:'center',padding:40}}>
            <FileTextOutlined style={{fontSize:64,color:'#1677ff'}}/>
            <p style={{marginTop:16}}>{'暂不支持在线预览，请下载后查看'}</p>
            <Button type="primary" icon={<DownloadOutlined/>} onClick={()=>handleDownload(previewDoc)}>下载文件</Button>
          </div>
        )}
        {previewDoc?.ocrResult && (
          <Card size="small" title="OCR 识别内容" style={{marginTop:12}}>
            <pre style={{whiteSpace:'pre-wrap',fontSize:12,maxHeight:200,overflow:'auto',margin:0}}>{previewDoc.ocrResult}</pre>
          </Card>
        )}
      </Modal>

      {/* 修改弹窗 */}
      <Modal title="修改单证信息" open={editOpen}
        onOk={handleSaveEdit} onCancel={()=>setEditOpen(false)} okText="保存" cancelText="取消" destroyOnClose>
        <Form layout="vertical">
          <Form.Item label="文件名"><Input value={editDoc?.fileName||''} disabled/></Form.Item>
          <Form.Item label="归类">
            <Select value={editCategory} onChange={setEditCategory} style={{width:'100%'}}
                dropdownRender={menu => <>{menu}<Divider style={{margin:'4px 0'}}/><Button type="link" size="small" icon={<TagsOutlined/>} onClick={()=>{const n=prompt('请输入新分类名称'); if(n){const k='custom_'+Date.now(); setEditCategory(k); message.success('已添加自定义分类: '+n)}}}>新增自定义分类</Button></>}>
              {Object.entries(CATEGORY_GROUPS).map(([gk, g]) => (
                <Select.OptGroup key={gk} label={g.groupLabel}>
                  {g.categories.map(c => <Select.Option key={c.key} value={c.key}>{c.label}</Select.Option>)}
                </Select.OptGroup>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="项目标签">
            <Input value={editProjectTag} onChange={e=>setEditProjectTag(e.target.value)} placeholder="例: 王一博/物料报关"/>
          </Form.Item>
          <Form.Item label="合同号">
            <Input value={editContractNo} onChange={e=>setEditContractNo(e.target.value)} placeholder="例: HW-2026-001"/>
          </Form.Item>
          <Form.Item label="提运单号">
            <Input value={editBillOfLading} onChange={e=>setEditBillOfLading(e.target.value)} placeholder="例: MSCU1234567（选填）"/>
          </Form.Item>
          {editDoc?.auditSummary && (
            <Form.Item label="校验结果">
              <Alert type={editDoc.auditPassed?'success':'warning'} message={editDoc.auditSummary} showIcon/>
            </Form.Item>
          )}
        </Form>
      </Modal>

     
      {/* 交叉核验弹窗 */}
      <Modal title="交叉核验" open={crossCheckOpen}
        onCancel={()=>setCrossCheckOpen(false)} footer={null} width={750} destroyOnClose>
        {/* 维度选择器 - 不在加载状态且无结果或结果空时显示 */}
        {!crossCheckLoading && !crossCheckResult && (
          <Space direction="vertical" style={{width:'100%'}}>
            <span style={{fontWeight:600,fontSize:15}}>选择要核验的维度：</span>
            <Checkbox.Group value={checkDims} onChange={setCheckDims}
              style={{display:'flex',flexWrap:'wrap',gap:12,marginBottom:16}}>
              {checkDimensions.map(dim => (
                <Checkbox key={dim.key} value={dim.key} style={{marginRight:0}}>
                  <div>
                    <div style={{fontWeight:600}}>{dim.label}</div>
                    <div style={{fontSize:12,color:'#888'}}>{dim.desc}</div>
                  </div>
                </Checkbox>
              ))}
            </Checkbox.Group>
            <Button type="primary" block size="large" onClick={runAutoCrossCheck}>
              开始核验
            </Button>
          </Space>
        )}
        {/* 加载状态 */}
        {crossCheckLoading && <Skeleton active paragraph={{rows:6}}/>}
        {/* 核验结果 */}
        {!crossCheckLoading && crossCheckResult?.length>0 && (
          <Space direction="vertical" style={{width:'100%'}} size="middle">
            {/* 重新核验按钮 */}
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{color:"#888",fontSize:13}}>核验完成，共 {crossCheckResult.length} 个项目分组</span>
              <Button size="small" onClick={()=>setCrossCheckResult(null)}>重新选择维度</Button>
            </div>
            {crossCheckResult.map((g:any,i:number)=>(
              <Card key={i} size="small"
                title={<Space>
                  <ProjectOutlined/>
                  <span>{g.projectTag}</span>
                  <Tag>{g.total}份</Tag>
                  {g.status==='pass' && <Tag color="success">全部通过</Tag>}
                  {g.status==='warn' && <Tag color="warning">有建议</Tag>}
                  {g.status==='fail' && <Tag color="error">有不一致</Tag>}
                </Space>}>
                {/* 各维度结果详情 */}
                <Descriptions size="small" column={1} style={{marginBottom:8}}>
                  {g.dimResults?.map((d:any) => (
                    <Descriptions.Item key={d.key} label={d.label}>
                      {d.status==='pass' && <Tag color="success" icon={<CheckCircleOutlined/>}>{d.msg}</Tag>}
                      {d.status==='warn' && <Tag color="warning" icon={<WarningOutlined/>}>{d.msg}</Tag>}
                      {d.status==='fail' && <Tag color="error" icon={<CloseCircleOutlined/>}>{d.msg}</Tag>}
                      {d.status==='skip' && <span style={{color:"#888",fontStyle:"italic"}}>{d.msg}</span>}
                    </Descriptions.Item>
                  ))}
                </Descriptions>
                {/* 文档列表 */}
                <span style={{color:"#888",fontSize:12}}>涉及单据：</span>
                <Space wrap style={{marginTop:4}}>
                  {g.documents.map((d:any)=>(
                    <Tag key={d.id} color={
                      d.auditPassed===false?'error':
                      d.auditPassed===true?'success':
                      'default'
                    }>
                      {d.fileName}
                      {d.category ? ' ['+(categoryLabels[d.category]||d.category)+']' : ''}
                    </Tag>
                  ))}
                </Space>
              </Card>
            ))}
          </Space>
        )}
        {/* 空状态 */}
        {!crossCheckLoading && crossCheckResult?.length === 0 && (
          <Empty description="没有足够同项目单据做交叉核验（需同项目至少2份）">
            <Button onClick={()=>setCrossCheckResult(null)}>修改核验维度</Button>
          </Empty>
        )}
      </Modal>

      {/* 批量补提单号 */}
      <Modal title={'批量补提运单号（'+selectedRowKeys.length+' 份）'} open={batchBLOpen}
        onCancel={()=>setBatchBLOpen(false)} onOk={handleBatchBL} okText="确认补填" cancelText="取消" destroyOnClose>
        <Alert type="info" showIcon style={{marginBottom:12}}
          message="同一票货的单证填同一个提运单号，系统会据此自动归集到「提运单归集」。" />
        <Input placeholder="提运单号，例：MEDUXXX123" value={batchBLValue}
          onChange={e=>setBatchBLValue(e.target.value)} onPressEnter={handleBatchBL} allowClear />
      </Modal>

      {/* 批量改归类 */}
      <Modal title={'批量改归类（'+selectedRowKeys.length+' 份）'} open={batchCatOpen}
        onCancel={()=>setBatchCatOpen(false)} onOk={handleBatchCategory} okText="确认更新" cancelText="取消" destroyOnClose>
        <Select placeholder="选择归类" value={batchCatValue||undefined} onChange={setBatchCatValue}
          style={{width:'100%'}} showSearch optionFilterProp="children">
          {Object.entries(CATEGORY_GROUPS).map(([gk, g]) => (
            <Select.OptGroup key={gk} label={g.groupLabel}>
              {g.categories.map(c => <Select.Option key={c.key} value={c.key}>{c.label}</Select.Option>)}
            </Select.OptGroup>
          ))}
        </Select>
      </Modal>
    </div>
  );
}
