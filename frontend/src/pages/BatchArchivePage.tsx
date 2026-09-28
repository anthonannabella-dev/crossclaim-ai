import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  Card, Table, Tag, Button, Space, Modal, Descriptions, Statistic, Row, Col,
  Badge, Typography, Divider, message, Tooltip, Upload, Progress, Steps,
  Input, Select, Alert, Tabs, Image, Popconfirm, Radio, Form, InputNumber,
} from 'antd';
import {
  ReloadOutlined, DownloadOutlined, InboxOutlined,
  EyeOutlined, CheckCircleOutlined, CloseCircleOutlined, SearchOutlined,
  LoadingOutlined, WarningOutlined, FileTextOutlined,
  UploadOutlined, LinkOutlined, ApiOutlined, SwapOutlined, MergeCellsOutlined, FileProtectOutlined, DeleteOutlined,
  PlayCircleOutlined, PauseCircleOutlined, AuditOutlined,
  DollarOutlined, ThunderboltOutlined, TeamOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import DocumentsPage from './DocumentsPage';
import DeclarationPage from './DeclarationPage';
import BatchImportPage from './BatchImportPage';
import DeclarationTemplatePage from './DeclarationTemplatePage';
import BatchPreCheckPage from './BatchPreCheckPage';
import DeclarationComparePage from './DeclarationComparePage';

const { Dragger } = Upload;
const { Title, Text, Paragraph } = Typography;


// ====== Types ======
interface BatchGroup {
  id: string;
  billOfLading: string;
  projectTag: string | null;
  status: string;
  docCount: number;
  ocrCount: number;
  ocrSuccess: number;
  validations: Validation[];
  aiSummary: any;
  archivedAt: string | null;
  xmlPath: string | null;
  errorMsg: string | null;
  declarationId: string | null;
  preCheckResult: any;
  preCheckPassed: boolean | null;
  declaredAt: string | null;
  taxRebateValue: number | null;
  taxRebateStatus: string | null;
  taxRebateEstimatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Validation {
  id: string;
  checkType: string;
  status: string;
  summary: string;
  score: number | null;
  completedAt: string | null;
}

interface GroupDetail extends BatchGroup {
  documents: any[];
}

// ====== Constants ======
const PIPELINE_STEPS = [
  { key: 'pending', title: '待处理', icon: <FileTextOutlined /> },
  { key: 'ocr_running', title: 'OCR识别', icon: <LoadingOutlined /> },
  { key: 'ai_checking', title: 'AI校验', icon: <AuditOutlined /> },
  { key: 'auto_filling', title: '自动填制', icon: <ThunderboltOutlined /> },
  { key: 'pending_review', title: '人工复核', icon: <TeamOutlined /> },
  { key: 'pre_checking', title: '合规预检', icon: <FileProtectOutlined /> },
  { key: 'declaring', title: '导出报关单', icon: <ApiOutlined /> },
  { key: 'customs_review', title: '海关回执', icon: <AuditOutlined /> },
  { key: 'released', title: '放行/结关', icon: <CheckCircleOutlined /> },
];

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  pending:        { color: 'default', icon: <FileTextOutlined />, label: '等待处理' },
  ocr_running:    { color: 'processing', icon: <LoadingOutlined />, label: 'OCR识别中' },
  ocr_done:       { color: 'success', icon: <CheckCircleOutlined />, label: 'OCR完成' },
  ai_checking:    { color: 'processing', icon: <LoadingOutlined />, label: 'AI校验中' },
  ai_done:        { color: 'success', icon: <CheckCircleOutlined />, label: '校验完成' },
  auto_filling:   { color: 'processing', icon: <LoadingOutlined />, label: '自动填制中' },
  auto_filled:    { color: 'success', icon: <CheckCircleOutlined />, label: '已填制' },
  pending_review: { color: 'warning', icon: <TeamOutlined />, label: '待人工复核' },
  pre_checking:   { color: 'processing', icon: <LoadingOutlined />, label: '预检中' },
  checked:        { color: 'success', icon: <CheckCircleOutlined />, label: '预检通过·待导出' },
  declaring:      { color: 'processing', icon: <LoadingOutlined />, label: '申报中' },
  declared:       { color: 'success', icon: <CheckCircleOutlined />, label: '已导出·待回执' },
  customs_review: { color: 'processing', icon: <AuditOutlined />, label: '已申报·待回执' },
  released:       { color: 'success', icon: <CheckCircleOutlined />, label: '已放行' },
  completed:      { color: 'success', icon: <CheckCircleOutlined />, label: '已结关' },
  rejected:       { color: 'error', icon: <CloseCircleOutlined />, label: '海关退单' },
  pre_check_failed: { color: 'warning', icon: <WarningOutlined />, label: '预检未通过' },
  error:          { color: 'error', icon: <CloseCircleOutlined />, label: '异常' },
};

const VALIDATION_LABELS: Record<string, string> = {
  classify: '智能归类',
  tariff: '税率校验',
  diagnose: '退单诊断',
};

// 状态 → Steps 进度映射
function statusToStepIndex(status: string): number {
  const map: Record<string, number> = {
    pending: 0,
    ocr_running: 1, ocr_done: 1,
    ai_checking: 2, ai_done: 2,
    auto_filling: 3, auto_filled: 3,
    pending_review: 4,
    pre_checking: 5, checked: 5,
    declaring: 6, declared: 6,
    customs_review: 7,
    released: 8, completed: 8,
    rejected: -1, pre_check_failed: -1, error: -1,
  };
  return map[status] ?? 0;
}

// ====== Component ======
const BatchArchivePage: React.FC = () => {
  const [groups, setGroups] = useState<BatchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [detailModal, setDetailModal] = useState(false);
  const [detailData, setDetailData] = useState<GroupDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 海关回执回填 Modal 状态
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptGroup, setReceiptGroup] = useState<BatchGroup | null>(null);
  const [receiptAction, setReceiptAction] = useState<'accepted' | 'released' | 'rejected'>('released');
  const [rejectCode, setRejectCode] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  // 复核补填 Modal 状态
  const [reviewModal, setReviewModal] = useState(false);
  const [reviewGroupId, setReviewGroupId] = useState<string>('');
  const [reviewForm] = Form.useForm();
  // 状态筛选以 URL 查询参数为准(?status=pending)。点卡片=改 URL=真跳转,
  // 浏览器前进/后退可用、链接可分享,数据仍留在同一张流水线表内。
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFilter = searchParams.get('status') || 'all';
  const setStatusFilter = (v: string) => {
    if (!v || v === 'all') setSearchParams({});
    else setSearchParams({ status: v });
  };

  // Upload state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadBillOfLading, setUploadBillOfLading] = useState('');
  const [uploadProjectTag, setUploadProjectTag] = useState('');
  const [uploading, setUploading] = useState(false);

  // Stats
  const [stats, setStats] = useState({
    total: 0, pending: 0, processing: 0, done: 0, error: 0,
  });

  const token = localStorage.getItem('token');
  const api = axios.create({
    baseURL: '/api',
    headers: { Authorization: 'Bearer ' + token },
  });

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/batch-group', { params: { status: statusFilter } });
      if (res.data.success) {
        setGroups(res.data.data);
        setTotal(res.data.total);
      }
    } catch (err: any) {
      console.error('获取分组列表失败:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await api.get('/batch-group/stats');
      if (res.data.success) {
        setStats(res.data.data);
      }
    } catch (err: any) {
      // Stats fetch failure is non-critical
    }
  }, []);

  useEffect(() => { fetchGroups(); fetchStats(); }, [fetchGroups, fetchStats]);

  const viewDetail = async (id: string) => {
    setDetailModal(true);
    setDetailLoading(true);
    try {
      const res = await api.get('/batch-group/' + id);
      if (res.data.success) {
        setDetailData(res.data.data);
      }
    } catch (err: any) {
      message.error('获取详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleStartAutoFill = async (id: string) => {
    try {
      const res = await api.post('/batch-group/' + id + '/start-auto-fill');
      if (res.data.success) {
        message.success('已启动自动填制，填制完成后请进行人工复核');
        fetchGroups(); fetchStats();
      } else {
        message.error(res.data.error || '启动失败');
      }
    } catch (err: any) {
      message.error('启动自动填制失败: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleApproveReview = async (id: string, patch?: any) => {
    try {
      const res = await api.post('/batch-group/' + id + '/approve-review', patch ? { declaration: patch } : {});
      if (res.data.success) {
        if (res.data.data?.passed) {
          message.success('复核通过·合规预检通过！请点「导出报关单XML」生成报文');
        } else {
          const errs = (res.data.data?.issues || []).filter((i: any) => i.severity === 'error').map((i: any) => i.message).slice(0, 3).join('；');
          message.warning('合规预检未通过: 得分 ' + res.data.data?.score + (errs ? '｜' + errs : '') + '，请补填后重新复核');
        }
        fetchGroups(); fetchStats();
      } else {
        message.error(res.data.error || '操作失败');
      }
    } catch (err: any) {
      message.error('复核失败: ' + (err.response?.data?.error || err.message));
    }
  };

  // 打开复核补填弹窗(预填已有要素)
  const openReviewModal = (group: any) => {
    setReviewGroupId(group.id);
    let d: any = {}; let it: any = {};
    try { d = JSON.parse(group.declaration?.declarationJson || group.declarationJson || '{}'); } catch { /* ignore */ }
    try { it = (JSON.parse(group.declaration?.itemsJson || group.itemsJson || '[]')[0]) || {}; } catch { /* ignore */ }
    reviewForm.setFieldsValue({
      consignee: d.consignee || '', consignor: d.consignor || '',
      portOfEntry: d.portOfEntry || '', tradeTerms: d.tradeTerms || 'FOB',
      freightRate: d.freightRate, insuranceRate: d.insuranceRate,
      model: it.model || '', legalQty: it.legalQty, legalUnit: it.legalUnit,
      legalQty2: it.legalQty2, legalUnit2: it.legalUnit2,
    });
    setReviewModal(true);
  };

  const submitReview = async () => {
    const v = reviewForm.getFieldsValue();
    const patch = {
      header: {
        consignee: v.consignee, consignor: v.consignor, portOfEntry: v.portOfEntry, tradeTerms: v.tradeTerms,
        freightRate: v.freightRate, freightMark: v.freightRate != null ? '3' : undefined,
        insuranceRate: v.insuranceRate, insuranceMark: v.insuranceRate != null ? '3' : undefined,
      },
      items: [{ model: v.model, legalQty: v.legalQty, legalUnit: v.legalUnit, legalQty2: v.legalQty2, legalUnit2: v.legalUnit2 }],
    };
    setReviewModal(false);
    await handleApproveReview(reviewGroupId, patch);
  };

  const handleRejectReview = async (id: string) => {
    const reason = prompt('请输入驳回原因:');
    if (!reason) return;
    try {
      const res = await api.post('/batch-group/' + id + '/reject-review', { reason });
      if (res.data.success) {
        message.success('已驳回，系统将重新自动填制');
        fetchGroups(); fetchStats();
      } else {
        message.error(res.data.error || '驳回失败');
      }
    } catch (err: any) {
      message.error('驳回失败: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleCustomsResponse = async (id: string, action: string, code?: string, reason?: string) => {
    try {
      const res = await api.post('/batch-group/' + id + '/customs-response', { action, code, reason });
      if (res.data.success) {
        const labels: Record<string, string> = { accepted: '海关已接受', rejected: '已标记退单', released: '已放行', completed: '已结关' };
        message.success(labels[action] || '操作成功');
        fetchGroups(); fetchStats();
      } else {
        message.error(res.data.error || '操作失败');
      }
    } catch (err: any) {
      message.error('操作失败: ' + (err.response?.data?.error || err.message));
    }
  };

  const openReceiptModal = (group: BatchGroup) => {
    setReceiptGroup(group);
    setReceiptAction('released');
    setRejectCode('');
    setRejectReason('');
    setReceiptOpen(true);
  };

  const submitReceipt = async () => {
    if (!receiptGroup) return;
    if (receiptAction === 'rejected' && (!rejectCode.trim() || !rejectReason.trim())) {
      message.warning('退单需填写退单代码和原因');
      return;
    }
    if (receiptAction === 'rejected') {
      await handleCustomsResponse(receiptGroup.id, 'rejected', rejectCode.trim(), rejectReason.trim());
    } else {
      await handleCustomsResponse(receiptGroup.id, receiptAction);
    }
    setReceiptOpen(false);
  };

  const handleDeleteGroup = async (id: string) => {
    try {
      const res = await api.delete('/batch-group/' + id);
      if (res.data.success) {
        message.success('已删除分组及关联文档');
        fetchGroups();
      } else {
        message.error(res.data.error || '删除失败');
      }
    } catch (err: any) {
      message.error('删除失败: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleExportXML = async (id: string) => {
    try {
      const res = await api.get('/batch-group/' + id + '/export-xml', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'declaration_' + id.slice(0, 8) + '.xml';
      a.click();
      window.URL.revokeObjectURL(url);
      message.success('报关单XML已导出，可导入贵司海关客户端申报');
      const warn = res.headers['x-item-count-warning'];
      const limit = res.headers['x-item-count-limit'];
      if (warn) message.warning('本票 ' + warn + ' 项商品，超过单票上限 ' + limit + ' 项，建议分单申报', 6);
      fetchGroups(); fetchStats();
    } catch (err: any) {
      message.error('导出XML失败');
    }
  };

  const handleExportCSV = async (id: string) => {
    try {
      const res = await api.get('/batch-group/' + id + '/export-csv', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'declaration_' + id.slice(0, 8) + '.csv';
      a.click();
      window.URL.revokeObjectURL(url);
      message.success('报关单CSV已导出（对账/退税/留档用）');
      const warn = res.headers['x-item-count-warning'];
      const limit = res.headers['x-item-count-limit'];
      if (warn) message.warning('本票 ' + warn + ' 项商品，超过单票上限 ' + limit + ' 项，建议分单申报', 6);
    } catch (err: any) {
      message.error('导出CSV失败');
    }
  };

  // Upload handlers
  const handleAddToUpload = (file: File) => {
    setUploadFiles(p => [...p, file]);
    return false;
  };
const removeUploadFile = (name: string) => {
    setUploadFiles(p => p.filter(f => f.name !== name));
  };

  const startUpload = async () => {
    if (uploadFiles.length === 0) {
      message.warning('请选择文件');
      return;
    }
    setUploading(true);
    let ok = 0, fail = 0;
    for (const file of uploadFiles) {
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('category', 'bill_of_lading');
        fd.append('projectTag', uploadProjectTag);
        fd.append('contractNo', '');
        fd.append('billOfLading', uploadBillOfLading.trim());
        const res = await api.post('/documents/upload', fd);
        if (res.data?.id) {
          ok++;
        } else {
          fail++;
        }
      } catch (err: any) {
        fail++;
      }
    }
    setUploading(false);
    if (ok > 0) {
      message.success('上传成功 ' + ok + ' 个文件，系统已自动创建提运单分组并触发 OCR + AI 校验，校验完成后请继续操作');
      setUploadOpen(false);
      setUploadFiles([]);
      setUploadBillOfLading('');
      setUploadProjectTag('');
      fetchGroups();
    }
    if (fail > 0) {
      message.warning(fail + ' 个文件上传失败');
    }
  };

  const renderStatus = (status: string) => {
    const cfg = STATUS_CONFIG[status] || { color: 'default', icon: null, label: status };
    return <Tag icon={cfg.icon} color={cfg.color}>{cfg.label}</Tag>;
  };

  const renderPipelineProgress = (status: string) => {
    const maxSteps = 8;
    if (status === 'error' || status === 'rejected' || status === 'pre_check_failed') {
      return <Progress percent={100} status="exception" strokeColor="#ff4d4f" size="small" />;
    }
    const stepIdx = statusToStepIndex(status);
    if (stepIdx >= maxSteps) {
      return <Progress percent={100} status="success" size="small" />;
    }
    if (stepIdx >= 0) {
      return <Progress percent={Math.round(((stepIdx + 0.5) / (maxSteps + 1)) * 100)} strokeColor="#1890ff" size="small" />;
    }
    return <Progress percent={0} size="small" />;
  };

  const renderValidationSummary = (validations: Validation[]) => {
    if (!validations || validations.length === 0) return '-';
    return (
      <Space size={4} wrap>
        {validations.map(v => (
          <Tooltip key={v.id} title={v.summary || ''}>
            <Badge
              status={v.status === 'passed' ? 'success' : v.status === 'warning' ? 'warning' : v.status === 'error' ? 'error' : 'processing'}
              text={
                <span style={{ fontSize: 12 }}>
                  {VALIDATION_LABELS[v.checkType] || v.checkType}
                  {v.score != null ? ' (' + v.score + ')' : ''}
                </span>
              }
            />
          </Tooltip>
        ))}
      </Space>
    );
  };

  // Active tab content: pipeline visualization
  const renderPipelineView = (group: BatchGroup) => {
    const stepIdx = statusToStepIndex(group.status);
    const isError = group.status === 'error';

    return (
      <div style={{ padding: '8px 0' }}>
        <Steps
          current={isError ? -1 : stepIdx}
          status={isError ? 'error' : stepIdx >= 8 ? 'finish' : 'process'}
          size="small"
          items={PIPELINE_STEPS.map((s, i) => ({
            title: s.title,
            icon: isError && i === Math.max(stepIdx, 0) ? <CloseCircleOutlined /> : s.icon,
            status: (isError && i === Math.max(stepIdx, 0)) ? 'error' :
                    i < stepIdx ? 'finish' :
                    i === stepIdx ? 'process' : 'wait',
          }))}
          style={{ marginBottom: 8 }}
        />
        {group.errorMsg && (
          <Alert type="error" message={group.errorMsg} style={{ marginTop: 8 }} showIcon />
        )}
      </div>
    );
  };

  const columns = [
    {
      title: '提运单号',
      dataIndex: 'billOfLading',
      key: 'billOfLading',
      width: 160,
      render: (v: string) => <Text strong>{v || '-'}</Text>,
    },
    {
      title: '流水线进度',
      key: 'pipeline',
      width: 260,
      render: (_: any, r: BatchGroup) => (
        <div style={{ minWidth: 200 }}>
          {renderPipelineProgress(r.status)}
          <div style={{ marginTop: 2 }}>{renderStatus(r.status)}</div>
        </div>
      ),
    },
    {
      title: '单证',
      key: 'docs',
      width: 80,
      render: (_: any, r: BatchGroup) => (
        <Tooltip title={`${r.ocrSuccess}/${r.ocrCount} OCR成功`}>
          <span>{r.docCount}份</span>
        </Tooltip>
      ),
    },
    {
      title: 'AI校验',
      key: 'validations',
      render: (_: any, r: BatchGroup) => renderValidationSummary(r.validations)
    },
    {
      title: '申报',
      key: 'declaration',
      width: 100,
      render: (_: any, r: BatchGroup) => {
        if (r.declarationId || r.status === 'declared' || r.status === 'rebate_done') return <Tag color="success">已生成</Tag>;
        if (['auto_filling','auto_filled','pre_checking','checked','declaring','tax_rebating'].includes(r.status)) return <Tag color="processing">自动处理中</Tag>;
        return '-';
      },
    },
    {
      title: '海关状态',
      key: 'customsStatus',
      width: 110,
      render: (_: any, r: BatchGroup) => {
        if (r.status === 'customs_review') return <Tag color="processing">已申报·待回执</Tag>;
        if (r.status === 'released') return <Tag color="success">已放行</Tag>;
        if (r.status === 'completed') return <Tag color="success">{r.archivedAt ? '已结关·已归档' : '已结关'}</Tag>;
        if (r.status === 'rejected') return <Tag color="error">海关退单</Tag>;
        if (r.status === 'declared') return <Tag color="success">已导出·待回执</Tag>;
        if (r.status === 'checked') return <Tag color="warning">待导出报关单</Tag>;
        return '-';
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 260,
      render: (_: any, r: BatchGroup) => (
        <Space wrap>
          <Button size="small" icon={<EyeOutlined />} onClick={() => viewDetail(r.id)}>
            详情
          </Button>
          {r.status === 'ai_done' && (
            <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={() => handleStartAutoFill(r.id)}>
              自动填制
            </Button>
          )}
          {r.status === 'pending_review' && (
            <>
              <Button size="small" type="primary" icon={<CheckCircleOutlined />} onClick={() => openReviewModal(r)}>
                通过复核
              </Button>
              <Button size="small" icon={<CloseCircleOutlined />} onClick={() => handleRejectReview(r.id)} danger>
                驳回
              </Button>
            </>
          )}
          {r.status === 'pre_check_failed' && (
            <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={() => handleRejectReview(r.id)}>
              修正重填
            </Button>
          )}
          {r.status === 'checked' && (
            <Button size="small" type="primary" icon={<DownloadOutlined />} onClick={() => handleExportXML(r.id)}>
              导出报关单XML
            </Button>
          )}
          {(r.status === 'declared' || r.status === 'customs_review') && (
            <Button size="small" type="primary" ghost icon={<ApiOutlined />} onClick={() => openReceiptModal(r)}>
              海关回执
            </Button>
          )}
          {r.status === 'released' && (
            <Button size="small" type="primary" icon={<CheckCircleOutlined />} onClick={() => handleCustomsResponse(r.id, 'completed')}>
              确认结关
            </Button>
          )}
          {['declared', 'customs_review', 'released', 'completed'].includes(r.status) && (
            <Button size="small" icon={<DownloadOutlined />} onClick={() => handleExportXML(r.id)}>
              {r.status === 'completed' ? '调档' : '下载XML'}
            </Button>
          )}
          {['checked', 'declared', 'customs_review', 'released', 'completed'].includes(r.status) && (
            <Button size="small" icon={<FileTextOutlined />} onClick={() => handleExportCSV(r.id)}>
              导出CSV
            </Button>
          )}
          <Popconfirm title="确定删除此分组？关联文档也将被删除" onConfirm={() => handleDeleteGroup(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      {/* Tabs: 流水线 + 提运单归集 */}
      <Tabs
        activeKey={searchParams.get('tab') || (searchParams.get('bl') ? 'bl-groups' : 'pipeline')}
        onChange={(k) => { const np = new URLSearchParams(searchParams); np.set('tab', k); setSearchParams(np); }}
        items={[
          {
            key: 'pipeline',
            label: <span><ThunderboltOutlined /> 自动化流水线</span>,
            children: (
              <>
                <Row gutter={16} style={{ marginBottom: 16 }}>
                  <Col span={4}>
                    <Card size="small" hoverable onClick={() => setStatusFilter('all')}
                      style={{ cursor: 'pointer', borderColor: statusFilter === 'all' ? '#1677ff' : undefined, borderWidth: statusFilter === 'all' ? 2 : 1 }}>
                      <Statistic title="全部" value={stats.total} suffix="组" />
                    </Card>
                  </Col>
                  <Col span={5}>
                    <Card size="small" hoverable onClick={() => setStatusFilter('pending')}
                      style={{ cursor: 'pointer', borderColor: statusFilter === 'pending' ? '#1677ff' : undefined, borderWidth: statusFilter === 'pending' ? 2 : 1 }}>
                      <Statistic title="待处理" value={stats.pending} valueStyle={{ color: '#999' }} />
                    </Card>
                  </Col>
                  <Col span={5}>
                    <Card size="small" hoverable onClick={() => setStatusFilter('processing')}
                      style={{ cursor: 'pointer', borderColor: statusFilter === 'processing' ? '#1677ff' : undefined, borderWidth: statusFilter === 'processing' ? 2 : 1 }}>
                      <Statistic title="处理中" value={stats.processing} valueStyle={{ color: '#1890ff' }} />
                    </Card>
                  </Col>
                  <Col span={5}>
                    <Card size="small" hoverable onClick={() => setStatusFilter('completed')}
                      style={{ cursor: 'pointer', borderColor: statusFilter === 'completed' ? '#1677ff' : undefined, borderWidth: statusFilter === 'completed' ? 2 : 1 }}>
                      <Statistic title="已结关" value={stats.done} valueStyle={{ color: '#52c41a' }} />
                    </Card>
                  </Col>
                  <Col span={5}>
                    <Card size="small" hoverable onClick={() => setStatusFilter('error')}
                      style={{ cursor: 'pointer', borderColor: statusFilter === 'error' ? '#1677ff' : undefined, borderWidth: statusFilter === 'error' ? 2 : 1 }}>
                      <Statistic title="异常/退单" value={stats.error} valueStyle={{ color: stats.error > 0 ? '#ff4d4f' : '#999' }} />
                    </Card>
                  </Col>
                </Row>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <Space>
            <Title level={4} style={{ margin: 0 }}>自动化流水线</Title>
            <Tag color="blue" icon={<ThunderboltOutlined />}>上传 → OCR → AI校验 → 自动填制 → 人工复核 → 预检 → 导出报关单XML → 线下申报 → 回执回填 → 放行结关</Tag>
          </Space>
          <Space>
            <Select value={statusFilter} onChange={setStatusFilter} style={{ width: 140 }}>
              <Select.Option value="all">全部状态</Select.Option>
              <Select.Option value="pending">待处理</Select.Option>
              <Select.Option value="processing">处理中</Select.Option>
              <Select.Option value="pending_review">待复核</Select.Option>
              <Select.Option value="completed">已结关</Select.Option>
              <Select.Option value="error">异常</Select.Option>
            </Select>
            <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
              上传单证
            </Button>
            <Button icon={<ReloadOutlined />} onClick={fetchGroups} loading={loading}>
              刷新
            </Button>
          </Space>
        </div>

        <Alert
          message="自动化报关流水线"
          description="上传单证时填写提运单号（选填），系统自动归组并依次执行：OCR识别 → AI智能校验(归类/税率/退单诊断) → 自动填制草稿 → ▣人工复核确认 → 合规预检。预检通过后点「导出报关单XML」生成标准报文，由报关员导入贵司对接海关的客户端完成线下申报；拿到海关回执后在系统内回填接单/放行/退单，全程留痕可追溯。"
          type="info"
          showIcon
          icon={<ThunderboltOutlined />}
          style={{ marginBottom: 16 }}
        />

        <Table
          dataSource={groups}
          columns={columns}
          rowKey="id"
          loading={loading}
          expandable={{
            expandedRowRender: (record) => renderPipelineView(record),
            rowExpandable: () => true,
          }}
          pagination={{ pageSize: 20, total, showTotal: t => '共 ' + t + ' 组' }}
          scroll={{ x: 1100 }}
          locale={{ emptyText: '暂无数据 - 点击"上传单证"启动自动化流水线' }}
        />
      </Card>

      {/* 上传弹窗 */}
      <Modal
        title="上传单证 - 启动自动化流水线"
        open={uploadOpen}
        onCancel={() => { setUploadOpen(false); setUploadFiles([]); }}
        width={600}
        footer={[
          <Button key="cancel" onClick={() => { setUploadOpen(false); setUploadFiles([]); }}>
            取消
          </Button>,
          <Button key="upload" type="primary" icon={<UploadOutlined />}
            loading={uploading} onClick={startUpload}
            disabled={uploadFiles.length === 0}>
            上传并启动流水线
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            message="上传后自动执行：OCR识别 → AI校验。校验完成后请点击「自动填制」→「人工复核」→ 系统自动预检申报"
            type="info"
            showIcon
            style={{ marginBottom: 8 }}
          />

          <div>
            <Text strong>提运单号 <Text type="secondary" style={{fontWeight:400}}>(选填)</Text></Text>
            <Input
              value={uploadBillOfLading}
              onChange={e => setUploadBillOfLading(e.target.value)}
              placeholder="例: MSCU1234567（不填也能上传）"
              style={{ marginTop: 4 }}
            />
          </div>

          <div>
            <Text strong>项目标签</Text>
            <Input
              value={uploadProjectTag}
              onChange={e => setUploadProjectTag(e.target.value)}
              placeholder="可选，如 出口美国/欧洲"
              style={{ marginTop: 4 }}
            />
          </div>

          <Divider style={{ margin: '12px 0' }} />

          <Dragger
            multiple
            showUploadList={false}
            accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp,.xlsx,.xls,.csv,.docx,.doc"
            beforeUpload={(file) => {
              const MAX_MB = 20;
              if (file.size > MAX_MB * 1024 * 1024) {
                message.error(`「${file.name}」超过 ${MAX_MB}MB，已跳过`);
                return Upload.LIST_IGNORE;
              }
              setUploadFiles(p => [...p, file]);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon"><UploadOutlined /></p>
            <p className="ant-upload-text">点击或拖拽单证文件到此区域</p>
            <p className="ant-upload-hint">支持 PDF、图片(PNG/JPG/TIFF)、Excel(XLSX/XLS/CSV)、Word(DOC/DOCX)，单文件 ≤20MB</p>
          </Dragger>

          {uploadFiles.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Text strong>已选文件 ({uploadFiles.length})</Text>
              {uploadFiles.map(f => (
                <Tag key={f.name} closable onClose={() => removeUploadFile(f.name)}
                  style={{ marginTop: 4 }}>
                  {f.name}
                </Tag>
              ))}
            </div>
          )}
        </Space>
      </Modal>

      {/* 海关回执回填弹窗 */}
      <Modal
        title={'海关回执回填 - ' + (receiptGroup?.billOfLading || '')}
        open={receiptOpen}
        onCancel={() => setReceiptOpen(false)}
        onOk={submitReceipt}
        okText="确认回填"
        cancelText="取消"
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="按贵司客户端拿到的海关回执选择对应结果回填，系统据此推进状态并留痕。"
        />
        <div style={{ marginBottom: 12, fontWeight: 500 }}>回执结果</div>
        <Radio.Group
          value={receiptAction}
          onChange={(e) => setReceiptAction(e.target.value)}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <Radio value="accepted">海关接单（已申报受理，待放行）</Radio>
          <Radio value="released">放行（结关条件具备）</Radio>
          <Radio value="rejected">退单（需修改后重报）</Radio>
        </Radio.Group>
        {receiptAction === 'rejected' && (
          <div style={{ marginTop: 16 }}>
            <Input
              placeholder="退单代码（如 0X9999）"
              value={rejectCode}
              onChange={(e) => setRejectCode(e.target.value)}
              style={{ marginBottom: 10 }}
            />
            <Input.TextArea
              placeholder="退单原因 / 海关提示"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
            />
          </div>
        )}
      </Modal>

      {/* 复核补填要素弹窗 */}
      <Modal
        title="复核 · 补填报关要素"
        open={reviewModal}
        onCancel={() => setReviewModal(false)}
        onOk={submitReview}
        okText="提交复核(预检并通过)"
        cancelText="取消"
        width={680}
      >
        <Alert type="info" showIcon message="境内收发货人、规格型号为海关必填项；CIF/CFR 成交需填运费。补填后提交将合并入库并执行合规预检。" style={{ marginBottom: 12 }} />
        <Form form={reviewForm} layout="vertical">
          <Row gutter={12}>
            <Col span={12}><Form.Item label="境内收发货人" name="consignee" rules={[{ required: true, message: '海关必填' }]}><Input placeholder="出口为发货人/进口为收货人" /></Form.Item></Col>
            <Col span={12}><Form.Item label="消费使用 / 生产销售单位" name="consignor"><Input placeholder="出口填生产销售单位" /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item label="进出境口岸" name="portOfEntry" rules={[{ required: true, message: '请填写口岸' }]}><Input placeholder="如深圳蛇口" /></Form.Item></Col>
            <Col span={12}><Form.Item label="成交方式" name="tradeTerms">
              <Select options={[{ value: 'CIF', label: 'CIF' }, { value: 'CFR', label: 'CFR' }, { value: 'FOB', label: 'FOB' }, { value: 'EXW', label: 'EXW' }]} />
            </Form.Item></Col>
          </Row>
          <Form.Item label="规格型号" name="model" rules={[{ required: true, message: '规格型号为海关必填项' }]}>
            <Input.TextArea rows={2} placeholder="品牌/型号/材质/成分等申报要素" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={6}><Form.Item label="法定第一数量" name="legalQty"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={6}><Form.Item label="法定第一单位" name="legalUnit"><Input placeholder="如 台" /></Form.Item></Col>
            <Col span={6}><Form.Item label="法定第二数量" name="legalQty2"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={6}><Form.Item label="法定第二单位" name="legalUnit2"><Input placeholder="如 千克" /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item label="运费(CIF/CFR必填)" name="freightRate"><InputNumber min={0} style={{ width: '100%' }} placeholder="总额" /></Form.Item></Col>
            <Col span={12}><Form.Item label="保费" name="insuranceRate"><InputNumber min={0} style={{ width: '100%' }} placeholder="总额" /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      {/* 详情弹窗 */}
      <Modal
        title={'流水线详情 - ' + (detailData?.billOfLading || '')}
        open={detailModal}
        onCancel={() => setDetailModal(false)}
        width={800}
        footer={detailData ? [
          detailData.status === 'ai_done' ? (
            <Button key="autoFill" type="primary" icon={<ThunderboltOutlined />}
              onClick={() => { handleStartAutoFill(detailData.id); setDetailModal(false); }}>
              自动填制草稿
            </Button>
          ) : null,
          detailData.status === 'pending_review' ? (
            <>
              <Button key="approve" type="primary" icon={<CheckCircleOutlined />}
                onClick={() => { setDetailModal(false); openReviewModal(detailData); }}>
                通过复核
              </Button>
              <Button key="reject" icon={<CloseCircleOutlined />} danger
                onClick={() => { handleRejectReview(detailData.id); setDetailModal(false); }}>
                驳回修改
              </Button>
            </>
          ) : null,
          detailData.status === 'pre_check_failed' ? (
            <Button key="fix" type="primary" icon={<ReloadOutlined />}
              onClick={() => { handleRejectReview(detailData.id); setDetailModal(false); }}>
              修正重填
            </Button>
          ) : null,
          (detailData.status === 'declared' || detailData.status === 'customs_review') ? (
            <Button key="customs" type="primary" ghost icon={<ApiOutlined />}
              onClick={() => { setDetailModal(false); openReceiptModal(detailData); }}>
              海关回执
            </Button>
          ) : null,
          detailData.status === 'released' ? (
            <Button key="complete" type="primary" icon={<CheckCircleOutlined />}
              onClick={() => { handleCustomsResponse(detailData.id, 'completed'); setDetailModal(false); }}>
              确认结关
            </Button>
          ) : null,
          <Button key="xml" icon={<DownloadOutlined />}
            onClick={() => handleExportXML(detailData.id)}>
            导出XML
          </Button>,
          <Popconfirm key="delete" title="确定删除此分组？" onConfirm={() => { handleDeleteGroup(detailData.id); setDetailModal(false); }}>
            <Button danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>,
          <Button key="close" onClick={() => setDetailModal(false)}>关闭</Button>,
        ].filter(Boolean) : null}
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><LoadingOutlined style={{ fontSize: 32 }} /></div>
        ) : detailData ? (
          <>
            {/* Pipeline steps visualization */}
            {renderPipelineView(detailData)}

            <Descriptions column={2} size="small" bordered style={{ marginTop: 16 }}>
              <Descriptions.Item label="提运单号">{detailData.billOfLading}</Descriptions.Item>
              <Descriptions.Item label="项目标签">{detailData.projectTag || '-'}</Descriptions.Item>
              <Descriptions.Item label="状态">{renderStatus(detailData.status)}</Descriptions.Item>
              <Descriptions.Item label="单证数">{detailData.docCount}</Descriptions.Item>
              <Descriptions.Item label="OCR">{detailData.ocrSuccess}/{detailData.ocrCount}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{new Date(detailData.createdAt).toLocaleString('zh-CN')}</Descriptions.Item>
              {detailData.declarationId && (
                <Descriptions.Item label="申报单ID">
                  <Text code>{detailData.declarationId.slice(0, 8)}...</Text>
                </Descriptions.Item>
              )}
              {detailData.preCheckPassed != null && (
                <Descriptions.Item label="预检结果">
                  {detailData.preCheckPassed ? <Tag color="success">通过</Tag> : <Tag color="error">未通过</Tag>}
                </Descriptions.Item>
              )}
              {detailData.declaredAt && (
                <Descriptions.Item label="申报时间">
                  {new Date(detailData.declaredAt).toLocaleString('zh-CN')}
                </Descriptions.Item>
              )}
              {detailData.errorMsg && (
                <Descriptions.Item label="错误信息" span={2}>
                  <Text type="danger">{detailData.errorMsg}</Text>
                </Descriptions.Item>
              )}
            </Descriptions>

            <Divider>AI 校验结果</Divider>
            {detailData.validations && detailData.validations.length > 0 ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                {detailData.validations.map(v => (
                  <Card key={v.id} size="small" type="inner"
                    title={
                      <Space>
                        <Badge status={
                          v.status === 'passed' ? 'success' :
                          v.status === 'warning' ? 'warning' : 'error'
                        } />
                        {VALIDATION_LABELS[v.checkType] || v.checkType}
                      </Space>
                    }
                    extra={v.score != null ? <Tag>评分: {v.score}</Tag> : null}
                  >
                    <Paragraph ellipsis={{ rows: 3, expandable: true }}>
                      {v.summary || '无详细结果'}
                    </Paragraph>
                    {v.completedAt && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        完成于: {new Date(v.completedAt).toLocaleString('zh-CN')}
                      </Text>
                    )}
                  </Card>
                ))}
              </Space>
            ) : (
              <Text type="secondary">尚未进行AI校验</Text>
            )}

            {detailData.documents && detailData.documents.length > 0 && (
              <>
                <Divider>关联单证</Divider>
                <Table
                  dataSource={detailData.documents}
                  columns={[
                    { title: '文件名', dataIndex: 'fileName', key: 'fileName' },
                    { title: '类型', dataIndex: 'category', key: 'category', width: 100 },
                    {
                      title: 'OCR状态', dataIndex: 'status', key: 'status', width: 100,
                      render: (v: string) => (
                        <Tag color={v === 'success' ? 'success' : 'error'}>
                          {v === 'success' ? '已识别' : '失败'}
                        </Tag>
                      ),
                    },
                    {
                      title: '审计', dataIndex: 'auditPassed', key: 'auditPassed', width: 80,
                      render: (v: boolean | null) =>
                        v === true ? <Tag color="success">通过</Tag> :
                        v === false ? <Tag color="error">未通过</Tag> : '-',
                    },
                    {
                      title: '上传时间', dataIndex: 'createdAt', key: 'createdAt', width: 170,
                      render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-',
                    },
                  ]}
                  rowKey="id"
                  size="small"
                  pagination={false}
                />
              </>
            )}
          </>
        ) : null}
      </Modal>
            </>
            )
          },
          {
            key: 'bl-groups',
            label: <span><MergeCellsOutlined /> 提运单归集</span>,
            children: <BillOfLadingGroupEmbedded />,
          },
          {
            key: 'documents',
            label: <span><FileTextOutlined /> 单证管理</span>,
            children: <DocumentsPageEmbedded />,
          },
          {
            key: 'declaration',
            label: <span><FileProtectOutlined /> 手动制单</span>,
            children: (
              <Tabs
                defaultActiveKey="build"
                items={[
                  { key: 'build', label: '填制报关单', children: <DeclarationPage /> },
                  { key: 'templates', label: '报关模板', children: <DeclarationTemplatePage /> },
                ]}
              />
            ),
          },
          {
            key: 'batch',
            label: <span><InboxOutlined /> 批量处理</span>,
            children: (
              <Tabs
                defaultActiveKey="import"
                items={[
                  { key: 'import', label: '批量申报', children: <BatchImportPage /> },
                  { key: 'precheck', label: '批量预检', children: <BatchPreCheckPage /> },
                ]}
              />
            ),
          },
          {
            key: 'compare',
            label: <span><SwapOutlined /> 报关核对</span>,
            children: <DeclarationComparePage />,
          },
        ]}
      />
    </div>
  );
};

export default BatchArchivePage;

// ====== 单据分类体系 ======
interface DocCategory {
  key: string;
  label: string;
  color: string;
  group: string;
  groupLabel: string;
}
const CATEGORIES: DocCategory[] = [
  { key: 'bill_of_lading', label: '提单', color: 'magenta', group: 'core', groupLabel: '核心基础单据' },
  { key: 'packing_list', label: '装箱单', color: 'cyan', group: 'core', groupLabel: '核心基础单据' },
  { key: 'invoice', label: '发票', color: 'orange', group: 'core', groupLabel: '核心基础单据' },
  { key: 'contract', label: '合同', color: 'purple', group: 'core', groupLabel: '核心基础单据' },
  { key: 'power_of_attorney', label: '电子代理报关委托书', color: 'geekblue', group: 'core', groupLabel: '核心基础单据' },
  { key: 'non_wood_declaration', label: '非木质包装声明', color: 'gold', group: 'core', groupLabel: '核心基础单据' },
  { key: 'certificate_of_origin', label: '原产地证', color: 'green', group: 'inspection', groupLabel: '检验与产地证' },
  { key: 'health_certificate', label: '卫生证书', color: 'green', group: 'inspection', groupLabel: '检验与产地证' },
  { key: 'quarantine_certificate', label: '检疫证书', color: 'green', group: 'inspection', groupLabel: '检验与产地证' },
  { key: 'fumigation_certificate', label: '熏蒸证书', color: 'green', group: 'inspection', groupLabel: '检验与产地证' },
  { key: 'shipping_order', label: '装货单', color: 'blue', group: 'logistics', groupLabel: '物流配套单据' },
  { key: 'delivery_order', label: '提货单', color: 'blue', group: 'logistics', groupLabel: '物流配套单据' },
  { key: 'cargo_manifest', label: '舱单', color: 'blue', group: 'logistics', groupLabel: '物流配套单据' },
  { key: 'license', label: '许可证', color: 'volcano', group: 'regulatory', groupLabel: '监管与特殊单据' },
  { key: 'processing_trade', label: '加工贸易', color: 'volcano', group: 'regulatory', groupLabel: '监管与特殊单据' },
  { key: 'customs_declaration', label: '报关单', color: 'blue', group: 'regulatory', groupLabel: '监管与特殊单据' },
  { key: 'general', label: '通用', color: 'default', group: 'custom', groupLabel: '自定义扩展' },
];
const categoryColors: Record<string, string> = {};
const categoryLabels: Record<string, string> = {};
const CATEGORY_GROUPS: Record<string, { groupLabel: string; categories: DocCategory[] }> = {};
CATEGORIES.forEach(c => { categoryColors[c.key] = c.color; categoryLabels[c.key] = c.label; });
CATEGORIES.forEach(c => {
  if (!CATEGORY_GROUPS[c.group]) CATEGORY_GROUPS[c.group] = { groupLabel: c.groupLabel, categories: [] };
  CATEGORY_GROUPS[c.group].categories.push(c);
});
// ====== 单据分类体系结束 ======

// ====== Embedded 单证管理 ======
const DocumentsPageEmbedded: React.FC = () => <DocumentsPage />;

// ====== Embedded 提运单归集 ======
const BillOfLadingGroupEmbedded: React.FC = () => {
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<any>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<any>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewText, setPreviewText] = useState('');
  const [recatDoc, setRecatDoc] = useState<any>(null);
  const [recatOpen, setRecatOpen] = useState(false);
  const [recatValue, setRecatValue] = useState('general');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  // item2/3: 启动流水线 + 一致性快检
  const [startingBL, setStartingBL] = useState<string | null>(null);
  const [crossOpen, setCrossOpen] = useState(false);
  const [crossData, setCrossData] = useState<any>(null);
  const [crossLoading, setCrossLoading] = useState(false);
  const blApi = axios.create({
    baseURL: '/api',
    headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
  });

  const DOC_STATUS_CONFIG: Record<string, {color: string; label: string}> = {
    uploaded: {color: 'blue', label: '已上传'},
    ocr_pending: {color: 'processing', label: '待OCR'},
    ocr_done: {color: 'cyan', label: 'OCR完成'},
    classified: {color: 'purple', label: '已归类'},
    archived: {color: 'green', label: '已归档'},
    error: {color: 'red', label: '异常'},
  };

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const res = await blApi.get('/documents/bill-of-lading/groups');
      setGroups(res.data?.data || []);
    } catch {
      message.error('加载提单分组失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchGroups(); }, []);

  const categoryGroupFilters = [
    { key: 'all', label: '全部' },
    { key: 'core', label: '核心单据', color: 'magenta' },
    { key: 'inspection', label: '检验产地证', color: 'green' },
    { key: 'logistics', label: '物流配套', color: 'blue' },
    { key: 'regulatory', label: '监管证件', color: 'volcano' },
    { key: 'custom', label: '扩展', color: 'default' },
  ];

  const statusGroupFilters = [
    { key: 'all', label: '全部状态' },
    { key: 'pending', label: '待处理' },
    { key: 'processing', label: '处理中' },
    { key: 'done', label: '已完成' },
    { key: 'error', label: '异常' },
  ];

  const groupCategoryKeys = (() => {
    const m: Record<string, string[]> = {};
    CATEGORIES.forEach(c => {
      if (!m[c.group]) m[c.group] = [];
      m[c.group].push(c.key);
    });
    return m;
  })();

  const filtered = groups.filter((g: any) => {
    if (search && !g.billOfLading.toLowerCase().includes(search.toLowerCase())) return false;
    if (categoryFilter !== 'all') {
      const wantedKeys = groupCategoryKeys[categoryFilter] || [];
      const groupKeys: string[] = (g.documents || []).map((d: any) => d.category).filter(Boolean);
      if (!groupKeys.some((k: string) => wantedKeys.includes(k))) return false;
    }
    if (statusFilter !== 'all') {
      if (statusFilter === 'error' && g.status !== 'error') return false;
      if (statusFilter === 'pending' && g.status !== 'pending') return false;
      if (statusFilter === 'processing' && ['pending','rebate_done','error'].includes(g.status)) return false;
      if (statusFilter === 'done' && g.status !== 'rebate_done') return false;
    }
    return true;
  });

  const exportGroupCSV = (group: any) => {
    const headers = ['文件名','类型','归类','客户','项目','合同号','提单号','单据状态','校验'];
    const rows = group.documents.map((d: any) => [
      d.fileName, d.fileType,
      d.category ? (categoryLabels[d.category] || d.category) : '-',
      d.clientName || '-', d.projectTag || '-', d.contractNo || '-',
      group.billOfLading,
      DOC_STATUS_CONFIG[d.status]?.label || d.status || '-',
      d.auditPassed === true ? '通过' : d.auditPassed === false ? '未通过' : '-',
    ]);
    const csv = '\uFEFF' + [headers.join(','), ...rows.map((r: string[]) => r.map(v => '"'+String(v).replace(/"/g,'""')+'"').join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '提单'+group.billOfLading+'_'+new Date().toISOString().slice(0,10)+'.csv';
    a.click();
    URL.revokeObjectURL(url);
    message.success('已导出 '+group.documentCount+' 条');
  };

  const exportGroupXML = (group: any) => {
    const esc = (s: string) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<BillOfLadingBatch>\n';
    xml += '  <BillOfLading>'+esc(group.billOfLading)+'</BillOfLading>\n';
    xml += '  <DocumentCount>'+group.documentCount+'</DocumentCount>\n';
    group.documents.forEach((d: any,i: number) => {
      xml += '  <Document seq="'+(i+1)+'">\n';
      xml += '    <FileName>'+esc(d.fileName)+'</FileName>\n';
      xml += '    <FileType>'+d.fileType+'</FileType>\n';
      xml += '    <Category>'+esc(d.category||'')+'</Category>\n';
      xml += '    <ClientName>'+esc(d.clientName||'')+'</ClientName>\n';
      xml += '    <ProjectTag>'+esc(d.projectTag||'')+'</ProjectTag>\n';
      xml += '    <ContractNo>'+esc(d.contractNo||'')+'</ContractNo>\n';
      xml += '    <Status>'+d.status+'</Status>\n';
      xml += '    <AuditPassed>'+ (d.auditPassed === true ? '通过' : d.auditPassed === false ? '未通过' : '-') +'</AuditPassed>\n';
      xml += '  </Document>\n';
    });
    xml += '</BillOfLadingBatch>';
    const blob = new Blob([xml], { type: 'application/xml;charset=utf-8;' });
    const xmlUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = xmlUrl;
    a.download = '提单'+group.billOfLading+'_'+new Date().toISOString().slice(0,10)+'.xml';
    a.click();
    URL.revokeObjectURL(xmlUrl);
    message.success('XML导出成功');
  };

  const handleViewDoc = async (doc: any) => {
    setPreviewDoc(doc);
    setPreviewText('');
    if (doc.fileType?.toLowerCase() === 'txt') {
      try {
        const res = await blApi.get('/documents/'+doc.id+'/download', { responseType: 'blob' });
        const text = await res.data.text();
        setPreviewText(text.slice(0, 50000));
      } catch {
        setPreviewText('（读取文件内容失败）');
      }
    }
    setPreviewOpen(true);
  };

  const handleRecategorize = (doc: any) => {
    setRecatDoc(doc);
    setRecatValue(doc.category || 'general');
    setRecatOpen(true);
  };

  const saveRecategorize = async () => {
    if (!recatDoc) return;
    try {
      await blApi.put('/documents/' + recatDoc.id, { category: recatValue });
      message.success('归类已更新');
      setRecatOpen(false);
      fetchGroups();
    } catch {
      message.error('更新失败');
    }
  };

  const handleStartByBL = async (record: any) => {
    setStartingBL(record.billOfLading);
    try {
      const res = await blApi.post('/batch-group/start-by-bl', {
        billOfLading: record.billOfLading,
        projectTag: (record.projectTags || [])[0] || '',
      });
      if (res.data.success) message.success('已启动自动化流水线，可切到「自动化流水线」Tab 查看进度');
      else message.error(res.data.error || '启动失败');
    } catch (e: any) {
      message.error('启动流水线失败: ' + (e.response?.data?.error || e.message));
    } finally {
      setStartingBL(null);
    }
  };

  const handleCrossCheck = async (record: any) => {
    setCrossOpen(true); setCrossLoading(true); setCrossData(null);
    try {
      const res = await blApi.get('/batch-group/cross-check/' + encodeURIComponent(record.billOfLading));
      if (res.data.success) setCrossData(res.data.data);
      else message.error(res.data.error || '校验失败');
    } catch (e: any) {
      message.error('一致性校验失败: ' + (e.response?.data?.error || e.message));
    } finally {
      setCrossLoading(false);
    }
  };

  const blColumns = [
    { title: '提运单号', dataIndex: 'billOfLading', key: 'billOfLading', width: 160,
      render: (v: string) => <Tag icon={<SwapOutlined/>} color="blue" style={{fontSize:14}}>{v}</Tag> },
    { title: '单据状态', dataIndex: 'status', key: 'status', width: 120,
      render: (v: string) => {
        const cfg = STATUS_CONFIG[v];
        return cfg ? <Tag icon={cfg.icon} color={cfg.color}>{cfg.label}</Tag> : <Tag>{v}</Tag>;
      }},
    { title: '单据数', dataIndex: 'documentCount', key: 'documentCount', width: 70,
      render: (v: number) => <Text strong>{v}</Text> },
    { title: '单证类型', dataIndex: 'categories', key: 'categories', width: 220,
      render: (v: string[]) => {
        const tags = (v || []).filter(Boolean);
        return tags.length > 0
          ? tags.map((c: string) => <Tag key={c} color={categoryColors[c] || 'default'}>{categoryLabels[c] || c}</Tag>)
          : <Text type="secondary">-</Text>;
      }},
    { title: '齐全度', key: 'completeness', width: 150,
      render: (_: any, record: any) => {
        const REQUIRED: [string, string][] = [['invoice', '发票'], ['packing_list', '装箱单'], ['bill_of_lading', '提单']];
        const have = new Set(record.categories || []);
        const missing = REQUIRED.filter(([k]) => !have.has(k)).map(([, l]) => l);
        return missing.length === 0
          ? <Tag color="success" icon={<CheckCircleOutlined />}>核心齐全</Tag>
          : <Tooltip title={'缺核心单证：' + missing.join('、')}><Tag color="error" icon={<WarningOutlined />}>缺 {missing.join('、')}</Tag></Tooltip>;
      }},
    { title: '客户/项目', dataIndex: 'projectTags', key: 'projectTags', width: 160,
      render: (v: string[]) => {
        const tags = v || [];
        if (tags.length === 0) return <Text type="secondary">-</Text>;
        const client = tags[0];
        const projects = tags.slice(1);
        return (
          <Space size={4} wrap>
            <Tag color="gold">{client}</Tag>
            {projects.map((t: string) => <Tag key={t} color="purple">{t}</Tag>)}
          </Space>
        );
      }},
    { title: '最近更新', dataIndex: 'lastUpdated', key: 'lastUpdated', width: 155,
      render: (v: string) => <Text type="secondary">{v ? new Date(v).toLocaleString('zh-CN') : '-'}</Text> },
    { title: '操作', key: 'action', width: 360,
      render: (_: any, record: any) => (
        <Space>
          <Button size="small" type="primary" ghost onClick={()=>{setSelectedGroup(record);setDetailOpen(true);}}>详情</Button>
          <Button size="small" type="primary" loading={startingBL===record.billOfLading} icon={<ThunderboltOutlined/>} onClick={()=>handleStartByBL(record)}>启动流水线</Button>
          <Button size="small" icon={<FileProtectOutlined/>} onClick={()=>handleCrossCheck(record)}>一致性</Button>
          <Button size="small" icon={<FileTextOutlined/>} onClick={()=>exportGroupCSV(record)}>CSV</Button>
          <Button size="small" icon={<FileTextOutlined/>} onClick={()=>exportGroupXML(record)}>XML</Button>
        </Space>
      )},
  ];

  return (
    <Card>

      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Input placeholder="搜索提运单号" value={search} onChange={e=>setSearch(e.target.value)}
            prefix={<SearchOutlined/>} allowClear/>
        </Col>
        <Col><Button onClick={fetchGroups} loading={loading}>刷新</Button></Col>
        <Col><Text type="secondary">共 {filtered.length} 个提单分组</Text></Col>
      </Row>
      <Table dataSource={filtered} columns={blColumns} rowKey="billOfLading" loading={loading}
        pagination={{pageSize:20, showTotal:t=>'共 '+t+' 个提单'}} size="small"
        locale={{emptyText: '暂无提运单分组，上传单证时填写提运单号即可自动归集'}}
      />
      <Modal title={selectedGroup?'提运单: '+selectedGroup.billOfLading+' ('+(selectedGroup.documents?.length||0)+'份单据)':''}
        open={detailOpen}
        onCancel={()=>setDetailOpen(false)} width={900}
        footer={selectedGroup?(
          <Space>
            <Button icon={<FileTextOutlined/>} onClick={()=>exportGroupCSV(selectedGroup)}>导出整组CSV</Button>
            <Button icon={<FileTextOutlined/>} onClick={()=>exportGroupXML(selectedGroup)}>导出整组XML</Button>
          </Space>
        ):null}
      >
        {selectedGroup && (
          <div>
            <Row gutter={[16,16]} style={{marginBottom:16}}>
              <Col span={4}><Statistic title="单据数" value={selectedGroup.documentCount}/></Col>
              <Col span={5}>
                <Statistic title="单据状态" valueRender={() => {
                  const cfg = STATUS_CONFIG[selectedGroup.status];
                  return cfg ? <Tag icon={cfg.icon} color={cfg.color} style={{fontSize:13}}>{cfg.label}</Tag> : <Tag>{selectedGroup.status}</Tag>;
                }}/>
              </Col>
              <Col span={5}><Statistic title="单证类型" value={selectedGroup.categories?.filter(Boolean).length || 0}/></Col>
              <Col span={5}>
                <Statistic title="客户/项目" valueRender={() => {
                  const tags = selectedGroup.projectTags || [];
                  if (tags.length === 0) return <Text type="secondary">-</Text>;
                  return (
                    <Space size={4}>
                      <Tag color="gold">{tags[0]}</Tag>
                      {tags.slice(1).map((t: string) => <Tag key={t} color="purple">{t}</Tag>)}
                    </Space>
                  );
                }}/>
              </Col>
              <Col span={5}><Statistic title="首张上传" value={selectedGroup.createdAt ? new Date(selectedGroup.createdAt).toLocaleDateString('zh-CN') : '-'}/></Col>
            </Row>
            <Table dataSource={selectedGroup.documents} rowKey="id" size="small" pagination={false}
              columns={[
                {title:'文件名',dataIndex:'fileName',ellipsis:true},
                {title:'类型',dataIndex:'fileType',width:50,render:(v:string)=><Tag>{v}</Tag>},
                {title:'归类',dataIndex:'category',width:130,
                  render:(v:string|null)=>
                    v ? <Tag color={categoryColors[v]||'default'} style={{fontSize:12}}>{categoryLabels[v]||v}</Tag>
                       : <Text type="secondary">-</Text>,
                  onCell: (r:any) => ({onDoubleClick: () => handleRecategorize(r)})
                },
                {title:'客户',dataIndex:'clientName',width:90,
                  render:(v:string|null)=>v?<Tag color="gold">{v}</Tag>:<Text type="secondary">-</Text>},
                {title:'项目',dataIndex:'projectTag',width:90,
                  render:(v:string|null)=>v?<Tag color="purple">{v}</Tag>:<Text type="secondary">-</Text>},
                {title:'合同号',dataIndex:'contractNo',width:110,
                  render:(v:string|null)=>v?<Tag color="cyan">{v}</Tag>:<Text type="secondary">-</Text>},
                {title:'单据状态',dataIndex:'status',width:80,
                  render:(v:string|null)=>{
                    const dc = DOC_STATUS_CONFIG[v || ''];
                    return dc ? <Tag color={dc.color} style={{fontSize:11}}>{dc.label}</Tag> : <Text type="secondary">-</Text>;
                  }},
                {title:'校验',dataIndex:'auditPassed',width:60,
                  render:(v:boolean|null)=>v===true?'✅':v===false?'❌':<Text type="secondary">-</Text>},
                {title:'操作',key:'action',width:160,
                  render:(_:any,r:any)=>(
                    <Space>
                      <Button size="small" type="link" icon={<EyeOutlined/>} onClick={()=>handleViewDoc(r)}>查看</Button>
                      <Button size="small" type="link" onClick={()=>handleRecategorize(r)}>改归类</Button>
                    </Space>
                  )},
                {title:'上传时间',dataIndex:'createdAt',width:150,
                  render:(v:string)=>v ? new Date(v).toLocaleString('zh-CN') : <Text type="secondary">-</Text>},
              ]}
            />
          </div>
        )}
      </Modal>

      <Modal title={previewDoc?.fileName || '文件预览'} open={previewOpen}
        onCancel={() => setPreviewOpen(false)} footer={null} width={800} destroyOnClose>
        {previewDoc && (
          <div style={{textAlign:'center'}}>
            {['png','jpg','jpeg','gif','bmp','webp','tiff'].includes(previewDoc.fileType?.toLowerCase()) ? (
              <Image src={'/api/documents/'+previewDoc.id+'/download'} style={{maxWidth:'100%',maxHeight:'70vh'}} fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="/>
            ) : previewDoc.fileType?.toLowerCase() === 'pdf' ? (
              <iframe src={'/api/documents/'+previewDoc.id+'/download'} style={{width:'100%',height:'70vh',border:'none'}} title="PDF预览"/>
            ) : previewText ? (
              <pre style={{
                maxHeight:'65vh', overflow:'auto', textAlign:'left',
                background:'#f5f5f5', padding:16, borderRadius:8,
                fontSize:13, lineHeight:1.6, whiteSpace:'pre-wrap', wordBreak:'break-all'
              }}>{previewText}</pre>
            ) : (
              <div style={{padding:40}}>
                <FileTextOutlined style={{fontSize:64,color:'#1677ff'}}/>
                <p style={{marginTop:16}}>暂不支持在线预览，请下载查看</p>
              </div>
            )}
            <div style={{marginTop:12, display:'flex', justifyContent:'center', gap:8, flexWrap:'wrap'}}>
              <Button type="primary" icon={<DownloadOutlined/>} onClick={async () => {
                try {
                  const res = await blApi.get('/documents/'+previewDoc.id+'/download', {responseType:'blob'});
                  const url = URL.createObjectURL(new Blob([res.data]));
                  const a = document.createElement('a');
                  a.href = url; a.download = previewDoc.fileName; a.click();
                  URL.revokeObjectURL(url);
                } catch { message.error('下载失败'); }
              }}>下载</Button>
              {previewDoc.category && <Tag color={categoryColors[previewDoc.category]}>{categoryLabels[previewDoc.category] || previewDoc.category}</Tag>}
              {previewDoc.contractNo && <Tag color="cyan">合同:{previewDoc.contractNo}</Tag>}
              {previewDoc.projectTag && <Tag color="purple">项目:{previewDoc.projectTag}</Tag>}
              {previewDoc.clientName && <Tag color="gold">客户:{previewDoc.clientName}</Tag>}
            </div>
          </div>
        )}
      </Modal>

      <Modal title="修改单据归类" open={recatOpen}
        onOk={saveRecategorize} onCancel={() => setRecatOpen(false)} okText="保存" cancelText="取消" destroyOnClose>
        <p>文件：{recatDoc?.fileName}</p>
        <Select value={recatValue} onChange={setRecatValue} style={{width:'100%',marginTop:8}}>
          {Object.entries(CATEGORY_GROUPS).map(([gk, g]) => (
            <Select.OptGroup key={gk} label={g.groupLabel}>
              {g.categories.map((c:any) => <Select.Option key={c.key} value={c.key}>{c.label}</Select.Option>)}
            </Select.OptGroup>
          ))}
        </Select>
      </Modal>

      {/* 一致性快检结果(item3) */}
      <Modal
        title={'单证一致性快检 - ' + (crossData?.blNo || '')}
        open={crossOpen}
        onCancel={() => setCrossOpen(false)}
        footer={null}
        width={760}
        destroyOnClose
      >
        {crossLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>正在比对单证…</div>
        ) : crossData ? (
          <>
            <Alert
              type={crossData.overallPassed ? 'success' : 'warning'}
              showIcon
              style={{ marginBottom: 12 }}
              message={crossData.overallPassed ? '单证一致性校验通过' : '存在不一致项，请核对下方标红处'}
              description={'共比对 ' + (crossData.summary?.total ?? 0) + ' 项 · 通过 ' + (crossData.summary?.passed ?? 0) + ' · 差异 ' + (crossData.summary?.warnings ?? 0)}
            />
            <Table
              size="small"
              rowKey={(_: any, i?: number) => String(i)}
              pagination={false}
              dataSource={(crossData.crossChecks || []).flatMap((cc: any) => cc.checks || [])}
              locale={{ emptyText: '无可比对项（需至少两类含金额/重量/件数的单证）' }}
              columns={[
                { title: '比对项', dataIndex: 'name', width: 150 },
                { title: '单证A', dataIndex: 'doc1Value', render: (v: string) => v || '-' },
                { title: '单证B', dataIndex: 'doc2Value', render: (v: string) => v || '-' },
                { title: '结果', dataIndex: 'passed', width: 80, render: (v: boolean) => v ? <Tag color="success">一致</Tag> : <Tag color="error">差异</Tag> },
              ]}
            />
          </>
        ) : (
          <Text type="secondary">暂无数据</Text>
        )}
      </Modal>
    </Card>
  );
};
