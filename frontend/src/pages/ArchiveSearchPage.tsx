import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card, Table, Input, DatePicker, Button, Space, Tag, message, Typography,
  Modal, Descriptions, Timeline, Tooltip, Empty, Divider,
} from 'antd';
import {
  SearchOutlined, DownloadOutlined, ReloadOutlined, EyeOutlined, InboxOutlined,
  FileTextOutlined, FilePdfOutlined, FileExcelOutlined, SafetyCertificateOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
} from '@ant-design/icons';
import axios from 'axios';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

interface ArchivedGroup {
  id: string;
  billOfLading: string;
  declarationId: string | null;
  declaredAt: string | null;
  archivedAt: string | null;
  status: string;
}

interface ManifestDoc {
  id: string; fileName: string; fileType: string; category: string | null;
  fileSize: number; auditPassed: boolean | null; createdAt: string | null;
}
interface Manifest {
  id: string; billOfLading: string; declarationId: string | null; status: string;
  declaredAt: string | null; archivedAt: string | null; snapshotAt: string | null;
  hasSnapshot: boolean; xmlFileName: string | null; errorMsg: string | null;
  docCount: number; documents: ManifestDoc[];
  auditTrail?: { action: string; detail: string; operatorId: string | null; ip: string | null; createdAt: string | null }[];
}

function docIcon(fileType: string) {
  const t = (fileType || '').toLowerCase();
  if (t.includes('pdf')) return <FilePdfOutlined style={{ color: '#cf1322' }} />;
  if (t.includes('xls') || t.includes('csv') || t.includes('sheet')) return <FileExcelOutlined style={{ color: '#389e0d' }} />;
  return <FileTextOutlined style={{ color: '#1677ff' }} />;
}
function fmtSize(n: number) {
  if (!n) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export default function ArchiveSearchPage() {
  const [rows, setRows] = useState<ArchivedGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get('q') || '');
  const [range, setRange] = useState<[any, any] | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [previewXml, setPreviewXml] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const navigate = useNavigate();

  const token = localStorage.getItem('token');
  const api = axios.create({ baseURL: '/api', headers: { Authorization: 'Bearer ' + token } });

  const fetchArchived = useCallback(async (toPage?: number) => {
    const p = toPage ?? page;
    setLoading(true);
    try {
      const params: any = { archivedOnly: 'true', lite: 'true', page: String(p), pageSize: String(PAGE_SIZE) };
      if (q.trim()) params.q = q.trim();
      if (range && range[0]) params.from = range[0].format('YYYY-MM-DD');
      if (range && range[1]) params.to = range[1].format('YYYY-MM-DD');
      const res = await api.get('/batch-group', { params });
      if (res.data.success) { setRows(res.data.data); setTotal(res.data.total); setPage(p); }
    } catch (err: any) {
      message.error('查询失败: ' + (err.response?.data?.error || err.message));
    } finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, range, page]);

  useEffect(() => { fetchArchived(); /* eslint-disable-next-line */ }, []);

  // 只读调档下载(走 archive-xml,不触发状态推进)
  const downloadXml = async (id: string, bl: string) => {
    try {
      const res = await api.get('/batch-group/' + id + '/archive-xml', { responseType: 'blob' });
      const snap = res.headers['x-snapshot'];
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = 'declaration_' + (bl || id.slice(0, 8)) + '.xml'; a.click();
      window.URL.revokeObjectURL(url);
      message.success(snap === 'stored' ? '已下载申报原始报文(快照)' : '已下载报文(按当前数据重新生成,非原始快照)');
    } catch { message.error('下载失败'); }
  };

  const downloadCsv = async (id: string, bl: string) => {
    try {
      const res = await api.get('/batch-group/' + id + '/export-csv', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = 'declaration_' + (bl || id.slice(0, 8)) + '.csv'; a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('导出失败'); }
  };

  // 整包 ZIP 下载(报文+CSV+调档单+全部随附单证)
  const downloadPackage = async (id: string, bl: string) => {
    const hide = message.loading('正在打包归档稽查包…', 0);
    try {
      const res = await api.get('/batch-group/' + id + '/archive-package', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'archive_' + (bl || id.slice(0, 8)) + '.zip'; a.click();
      window.URL.revokeObjectURL(url);
      message.success('归档整包已下载');
    } catch { message.error('打包失败'); }
    finally { hide(); }
  };

  const downloadDoc = async (docId: string, fileName: string) => {
    try {
      const res = await api.get('/documents/' + docId + '/download', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = fileName; a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('单证下载失败'); }
  };

  // 报文在线预览(不下载、不触发下载留痕)
  const formatXml = (xml: string) => {
    const reg = /(>)(<)(\/*)/g;
    const lines = xml.replace(reg, '$1\n$2$3').split('\n');
    let pad = 0; let out = '';
    for (const node of lines) {
      let indent = 0;
      if (/^<\/\w/.test(node)) { if (pad > 0) pad -= 1; }
      else if (/^<\w[^>]*[^/]>.*$/.test(node) && !/^<\w[^>]*\/>/.test(node) && !/<\/\w/.test(node)) indent = 1;
      out += '  '.repeat(pad) + node + '\n';
      pad += indent;
    }
    return out.trim();
  };
  const openPreview = async (id: string, bl: string) => {
    setPreviewLoading(true); setPreviewXml(null); setPreviewTitle('报文预览 · ' + (bl || id.slice(0, 8)));
    try {
      const res = await api.get('/batch-group/' + id + '/archive-xml', { params: { preview: '1' }, responseType: 'text', transformResponse: [(d) => d] });
      const snap = res.headers['x-snapshot'];
      const text = typeof res.data === 'string' ? res.data : String(res.data);
      setPreviewXml(formatXml(text) + (snap === 'regenerated' ? '\n\n<!-- 注:该票无快照,以上为按当前数据重新生成,非原始申报报文 -->' : ''));
    } catch {
      message.error('预览失败'); setPreviewXml(null);
    } finally { setPreviewLoading(false); }
  };

  const openManifest = async (id: string) => {
    setManifestLoading(true); setManifest(null);
    try {
      const res = await api.get('/batch-group/' + id + '/archive-manifest');
      if (res.data.success) setManifest(res.data.data);
    } catch (err: any) {
      message.error('调档详情加载失败: ' + (err.response?.data?.error || err.message));
    } finally { setManifestLoading(false); }
  };

  const reset = () => { setQ(''); setRange(null); setTimeout(() => fetchArchived(1), 0); };

  const columns = [
    { title: '提运单号', dataIndex: 'billOfLading', key: 'billOfLading', render: (v: string) => <Text strong>{v || '-'}</Text> },
    { title: '报关单号', dataIndex: 'declarationId', key: 'declarationId', render: (v: string) => v || <Text type="secondary">-</Text> },
    { title: '申报时间', dataIndex: 'declaredAt', key: 'declaredAt', width: 175, render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
    { title: '归档时间', dataIndex: 'archivedAt', key: 'archivedAt', width: 175, render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 130,
      render: (s: string) => <Tag color="success">{s === 'completed' ? '已结关·已归档' : s}</Tag>,
    },
    {
      title: '调档', key: 'actions', width: 230, fixed: 'right' as const,
      render: (_: any, r: ArchivedGroup) => (
        <Space size={4} wrap>
          <Tooltip title="调档详情(单证清单/回执/时间线)">
            <Button size="small" icon={<EyeOutlined />} onClick={() => openManifest(r.id)}>调档</Button>
          </Tooltip>
          <Tooltip title="在线预览报文(不下载)">
            <Button size="small" icon={<FileTextOutlined />} onClick={() => openPreview(r.id, r.billOfLading)} />
          </Tooltip>
          <Tooltip title="下载申报原始报文(只读,不改状态)">
            <Button size="small" type="primary" ghost icon={<DownloadOutlined />} onClick={() => downloadXml(r.id, r.billOfLading)}>报文</Button>
          </Tooltip>
          <Tooltip title="导出报关单 CSV">
            <Button size="small" icon={<FileExcelOutlined />} onClick={() => downloadCsv(r.id, r.billOfLading)} />
          </Tooltip>
          <Tooltip title="下载整包(报文+单证+调档单 ZIP)">
            <Button size="small" icon={<InboxOutlined />} onClick={() => downloadPackage(r.id, r.billOfLading)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={4} style={{ marginTop: 0 }}><InboxOutlined /> 归档调档</Title>
      <Text type="secondary">申报完成自动归档的报关票据，按提运单号或报关单号检索；调档取的是申报当时的原始报文快照，可应对海关稽查/复核。</Text>

      <Card size="small" style={{ marginTop: 16, marginBottom: 16 }}>
        <Space wrap>
          <Input
            placeholder="提运单号 / 报关单号"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onPressEnter={() => fetchArchived(1)}
            allowClear
            style={{ width: 240 }}
            prefix={<SearchOutlined />}
          />
          <RangePicker value={range as any} onChange={(v) => setRange(v as any)} placeholder={['归档起', '归档止']} />
          <Button type="primary" icon={<SearchOutlined />} onClick={() => fetchArchived(1)}>查询</Button>
          <Button icon={<ReloadOutlined />} onClick={reset}>重置</Button>
        </Space>
      </Card>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, showTotal: (t) => '共 ' + t + ' 票归档', onChange: (p) => fetchArchived(p) }}
        locale={{ emptyText: '暂无归档记录（结关后自动归档）' }}
        scroll={{ x: 1000 }}
      />

      <Modal
        open={!!manifest || manifestLoading}
        title={manifest ? ('调档单 · ' + (manifest.billOfLading || manifest.id.slice(0, 8))) : '调档详情'}
        onCancel={() => setManifest(null)}
        width={760}
        footer={manifest ? [
          <Button key="preview" icon={<FileTextOutlined />} onClick={() => openPreview(manifest.id, manifest.billOfLading)}>预览报文</Button>,
          <Button key="xml" type="primary" ghost icon={<DownloadOutlined />} onClick={() => downloadXml(manifest.id, manifest.billOfLading)}>下载报文</Button>,
          <Button key="csv" icon={<FileExcelOutlined />} onClick={() => downloadCsv(manifest.id, manifest.billOfLading)}>导出CSV</Button>,
          <Button key="zip" icon={<InboxOutlined />} onClick={() => downloadPackage(manifest.id, manifest.billOfLading)}>下载整包</Button>,
          <Button key="goto" icon={<EyeOutlined />} onClick={() => navigate('/dashboard/batch-archive?tab=bl-groups&bl=' + encodeURIComponent(manifest.billOfLading || ''))}>查看流水线</Button>,
          <Button key="close" onClick={() => setManifest(null)}>关闭</Button>,
        ] : null}
        confirmLoading={manifestLoading}
      >
        {manifest && (
          <>
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="提运单号">{manifest.billOfLading || '-'}</Descriptions.Item>
              <Descriptions.Item label="报关单号">{manifest.declarationId || '-'}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color="success">{manifest.status === 'completed' ? '已结关·已归档' : manifest.status}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="报文快照">
                {manifest.hasSnapshot
                  ? <Tag icon={<SafetyCertificateOutlined />} color="green">原始快照</Tag>
                  : <Tooltip title="该票归档时未留存快照,调档将按当前数据重新生成"><Tag color="orange">无快照·重新生成</Tag></Tooltip>}
              </Descriptions.Item>
              <Descriptions.Item label="随附单证">{manifest.docCount} 份</Descriptions.Item>
              <Descriptions.Item label="报文文件">{manifest.xmlFileName || '-'}</Descriptions.Item>
            </Descriptions>

            <Timeline
              style={{ marginBottom: 8 }}
              items={[
                manifest.declaredAt ? { color: 'blue', children: '申报登记 · ' + new Date(manifest.declaredAt).toLocaleString() } : null,
                manifest.snapshotAt ? { color: 'green', children: '报文快照 · ' + new Date(manifest.snapshotAt).toLocaleString() } : null,
                manifest.archivedAt ? { color: 'gray', children: '结关归档 · ' + new Date(manifest.archivedAt).toLocaleString() } : null,
              ].filter(Boolean) as any}
            />

            <Text strong>随附单证清单</Text>
            {manifest.documents.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无随附单证" />
            ) : (
              <Table
                size="small"
                rowKey="id"
                style={{ marginTop: 8 }}
                pagination={false}
                dataSource={manifest.documents}
                columns={[
                  { title: '单证', dataIndex: 'fileName', key: 'fileName', render: (v: string, d: ManifestDoc) => <Space>{docIcon(d.fileType)}<span>{v}</span></Space> },
                  { title: '类别', dataIndex: 'category', key: 'category', width: 110, render: (v: string) => v || '-' },
                  { title: '大小', dataIndex: 'fileSize', key: 'fileSize', width: 90, render: (v: number) => fmtSize(v) },
                  {
                    title: '校验', dataIndex: 'auditPassed', key: 'auditPassed', width: 70,
                    render: (v: boolean | null) => v == null ? '-' : (v
                      ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                      : <CloseCircleOutlined style={{ color: '#ff4d4f' }} />),
                  },
                  {
                    title: '操作', key: 'op', width: 80,
                    render: (_: any, d: ManifestDoc) => <Button size="small" type="link" icon={<DownloadOutlined />} onClick={() => downloadDoc(d.id, d.fileName)}>下载</Button>,
                  },
                ]}
              />
            )}

            {manifest.auditTrail && manifest.auditTrail.length > 0 && (
              <>
                <Divider style={{ margin: '12px 0' }} />
                <Text strong>操作留痕</Text>
                <Table
                  size="small"
                  rowKey={(_, i) => String(i)}
                  style={{ marginTop: 8 }}
                  pagination={false}
                  dataSource={manifest.auditTrail}
                  columns={[
                    { title: '时间', dataIndex: 'createdAt', key: 't', width: 160, render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
                    { title: '操作', dataIndex: 'action', key: 'a', width: 150, render: (v: string) => <Tag>{v}</Tag> },
                    { title: '详情', dataIndex: 'detail', key: 'd', ellipsis: true },
                    { title: '操作者', dataIndex: 'operatorId', key: 'o', width: 90, render: (v: string) => v ? v.slice(0, 8) : '主账号' },
                  ]}
                />
              </>
            )}
          </>
        )}
      </Modal>

      <Modal
        open={!!previewXml || previewLoading}
        title={previewTitle || '报文预览'}
        onCancel={() => setPreviewXml(null)}
        width={820}
        confirmLoading={previewLoading}
        footer={previewXml ? [
          <Button key="copy" icon={<DownloadOutlined />} onClick={() => {
            if (navigator.clipboard?.writeText) navigator.clipboard.writeText(previewXml).then(() => message.success('已复制报文')).catch(() => message.warning('复制失败'));
            else message.warning('当前环境不支持自动复制');
          }}>复制</Button>,
          <Button key="close" onClick={() => setPreviewXml(null)}>关闭</Button>,
        ] : null}
      >
        {previewXml && (
          <pre style={{
            maxHeight: '60vh', overflow: 'auto', background: '#0f172a', color: '#e2e8f0',
            padding: 16, borderRadius: 6, fontSize: 12, lineHeight: 1.5, margin: 0,
            fontFamily: 'Menlo, Consolas, monospace', whiteSpace: 'pre',
          }}>{previewXml}</pre>
        )}
      </Modal>
    </div>
  );
}
