import { useState, useEffect, useCallback } from 'react';
import { Row, Col, Card, Statistic, Select, DatePicker, Button, Table, Spin, message } from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
// @ant-design/charts removed due to compatibility
import dayjs, { Dayjs } from 'dayjs';

const { RangePicker } = DatePicker;
type ReportType = 'summary' | 'compliance' | 'cbam' | 'declaration';

interface AnalyticsData {
  hsDistribution?: { chapter: string; count: number }[];
  monthlyUploads?: { month: string; count: number }[];
  monthlyDeclarations?: { month: string; total: number; submitted: number; rejected: number; completed: number }[];
  categoryDistribution?: { category: string; count: number }[];
  cbamRiskDistribution?: { level: string; count: number }[];
  dailyActivity?: { date: string; count: number }[];
  summary?: { totalDocuments: number; totalHS: number; totalAuditLogs: number; cbamHighRisk: number };
}

const REPORT_OPTIONS: { value: ReportType; label: string; icon: string }[] = [
  { value: 'summary', label: '经营总览', icon: '📊' },
  { value: 'compliance', label: '合规统计', icon: '✓' },
  { value: 'cbam', label: 'CBAM 碳成本', icon: '🌍' },
  { value: 'declaration', label: '报关单记录', icon: '📄' },
];

export default function ReportsPage() {
  const [reportType, setReportType] = useState<ReportType>('summary');
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null]>([dayjs().subtract(30, 'day'), dayjs()]);
  const [loading, setLoading] = useState(false);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [downloading, setDownloading] = useState(false);

  const fetchAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/reports/analytics', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setAnalytics(json.data || json);
    } catch (err: any) {
      message.error(`获取分析数据失败: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAnalytics(); }, [fetchAnalytics]);

  const handleDownload = async (format: 'xlsx' | 'csv') => {
    if (!dateRange[0] || !dateRange[1]) { message.warning('请选择日期范围'); return; }
    setDownloading(true);
    try {
      const token = localStorage.getItem('token');
      const params = new URLSearchParams({
        type: reportType,
        format,
        dateFrom: dateRange[0].format('YYYY-MM-DD'),
        dateTo: dateRange[1].format('YYYY-MM-DD'),
      });
      const res = await fetch(`/api/reports/download?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('下载失败');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${reportType}-${Date.now()}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('下载成功');
    } catch {
      message.error('下载失败');
    } finally {
      setDownloading(false);
    }
  };

  const s = analytics?.summary;
  const daily = analytics?.dailyActivity ?? [];
  const cbam = analytics?.cbamRiskDistribution ?? [];

  return (
    <div style={{ padding: 24 }}>
      {/* 操作栏 */}
      <Row gutter={[12, 12]} align="middle" style={{ marginBottom: 24 }}>
        <Col>
          <Select value={reportType} onChange={(v: ReportType) => setReportType(v)}
            options={REPORT_OPTIONS.map(o => ({ value: o.value, label: `${o.icon} ${o.label}` }))}
            style={{ width: 180 }} />
        </Col>
        <Col><RangePicker value={dateRange as any} onChange={(d) => setDateRange(d as [Dayjs | null, Dayjs | null])} allowClear={false} /></Col>
        <Col>
          <Button type="primary" icon={<DownloadOutlined />} loading={downloading} onClick={() => handleDownload('xlsx')}>下载 XLSX</Button>
        </Col>
        <Col>
          <Button icon={<DownloadOutlined />} loading={downloading} onClick={() => handleDownload('csv')}>下载 CSV</Button>
        </Col>
        <Col><Button icon={<ReloadOutlined />} onClick={fetchAnalytics}>刷新</Button></Col>
      </Row>

      {/* 内容 */}
      <Spin spinning={loading}>
        {reportType === 'summary' && (
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}><Card><Statistic title="总单证" value={s?.totalDocuments ?? 0} /></Card></Col>
            <Col xs={12} md={6}><Card><Statistic title="HS编码" value={s?.totalHS ?? 0} /></Card></Col>
            <Col xs={12} md={6}><Card><Statistic title="审计日志" value={s?.totalAuditLogs ?? 0} /></Card></Col>
            <Col xs={12} md={6}>
              <Card>
                <Statistic title="CBAM高风险" value={s?.cbamHighRisk ?? 0}
                  valueStyle={{ color: (s?.cbamHighRisk ?? 0) > 0 ? '#cf1322' : '#3f8600' }} />
              </Card>
            </Col>
          </Row>
        )}

        {reportType === 'compliance' && (
          <>
            <Card title="每日活动（近30天）" style={{ marginBottom: 16 }}>
              <Table dataSource={daily} columns={[
                { title: '日期', dataIndex: 'date', key: 'date' },
                { title: '操作数', dataIndex: 'count', key: 'count' },
              ]} rowKey="date" pagination={{ pageSize: 10 }} size="small" />
            </Card>
            {daily.length > 0 && (
              <Card title="合规趋势">
                <div style={{height:280, padding:16}}>
                  <div style={{display:'flex', alignItems:'flex-end', gap:2, height:220, padding:'4px 0', borderBottom:'1px solid #f0f0f0'}}>
                    {daily.map((d: any, i: number) => {
                      const max = Math.max(...daily.map((x: any) => x.count), 1);
                      return (
                        <div key={i} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:4}}>
                          <span style={{fontSize:10, color:'#999', whiteSpace:'nowrap'}}>{d.count}</span>
                          <div style={{width:'100%', height:`${(d.count/max)*180}px`, background:'#1677ff', borderRadius:'2px 2px 0 0', opacity:0.6 + (i/daily.length)*0.4, minHeight:d.count>0?4:0, transition:'height 0.3s'}} />
                          <span style={{fontSize:10, color:'#999'}}>{d.date?.slice(5) || ''}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </Card>
            )}
          </>
        )}

        {reportType === 'cbam' && (
          <Card title="CBAM 风险分布">
            <Table dataSource={cbam} columns={[
              { title: '风险等级', dataIndex: 'level', key: 'level' },
              { title: '数量', dataIndex: 'count', key: 'count' },
            ]} rowKey="level" pagination={false} />
          </Card>
        )}

        {reportType === 'declaration' && (
          <Card title="报关单月度分布" style={{ marginBottom: 16 }}>
            {analytics?.monthlyDeclarations && analytics.monthlyDeclarations.length > 0 ? (
              <div style={{padding:16}}>
                <div style={{display:'flex', alignItems:'flex-end', gap:10, height:240, padding:'8px 0', borderBottom:'1px solid #f0f0f0'}}>
                  {(() => {
                    const ds = analytics!.monthlyDeclarations!;
                    const mx = Math.max(...ds.map((d:any) => d.count), 1);
                    return ds.map((d:any, i:number) => {
                      const h = Math.max((d.count / mx) * 180, 4);
                      return (
                        <div key={i} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:4, minWidth:36}}>
                          <span style={{fontSize:11, color:'#666', fontWeight:500}}>{d.count}</span>
                          <div style={{width:'85%', height:h + 'px', background:'linear-gradient(180deg,#95de64 0%,#52c41a 100%)', borderRadius:'4px 4px 0 0', transition:'height 0.3s', boxShadow:'0 2px 4px rgba(82,196,26,0.2)'}} />
                          <span style={{fontSize:10, color:'#999', whiteSpace:'nowrap'}}>{d.month?.slice(-7) || ''}</span>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            ) : <div style={{ textAlign: 'center', color: '#999', padding: 40 }}>暂无报关单数据</div>}
          </Card>
        )}
      </Spin>
    </div>
  );
}
