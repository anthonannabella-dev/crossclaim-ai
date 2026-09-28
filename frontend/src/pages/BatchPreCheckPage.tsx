import { useState } from 'react';
import { Row, Col, Card, Table, Button, Select, Tag, Progress, message, Spin, Typography, Space, Alert } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

interface PreCheckItem {
  id: string;
  declarationNo: string | null;
  status: string;
  customsMode: string;
  totalValue: number;
  score: number | null;
  preCheckPassed: boolean | null;
}

export default function BatchPreCheckPage() {
  const [declarations, setDeclarations] = useState<PreCheckItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [prechecking, setPrechecking] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, any>>({});
  const [filterMode, setFilterMode] = useState('all');

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  const fetchList = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/declaration/list?pageSize=100', { headers });
      if (!res.ok) throw new Error('加载失败 (' + res.status + ')');
      const json = await res.json();
      const list = json.data?.items || json.data || [];
      setDeclarations(list);
      if (list.length === 0) message.info('暂无可预检的报关单，请先在「手动制单」或「批量申报」中生成草稿');
    } catch (e: any) {
      setDeclarations([]);
      message.error('加载报关单失败: ' + (e.message || '请稍后重试'));
    } finally {
      setLoading(false);
    }
  };

  const handleBatchPreCheck = async () => {
    if (selectedIds.length === 0) { message.warning('请至少选择一条报关单'); return; }
    setPrechecking(true);
    const newResults: Record<string, any> = {};
    for (const id of selectedIds) {
      try {
        const res = await fetch('/api/declaration/pre-check', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        const json = await res.json();
        newResults[id] = json.data || json;
      } catch {
        newResults[id] = { passed: false, score: 0, issues: [{ severity: 'error', code: 'FETCH_ERR', message: '预检请求失败' }] };
      }
    }
    setResults(newResults);
    const passed = Object.values(newResults).filter((r: any) => r.passed).length;
    message.success(`批量预检完成，通过 ${passed}/${selectedIds.length}`);
    setPrechecking(false);
  };

  let filtered = declarations;
  if (filterMode !== 'all') filtered = filtered.filter(d => d.customsMode === filterMode);

  const columns = [
    { title: '报关单号', dataIndex: 'declarationNo', key: 'declarationNo', ellipsis: true },
    { title: '模式', dataIndex: 'customsMode', key: 'customsMode', width: 70 },
    { title: '金额', dataIndex: 'totalValue', key: 'totalValue', width: 110, render: (v: number) => `$${v?.toLocaleString() ?? 0}` },
    {
      title: '当前评分', dataIndex: 'score', key: 'score', width: 100,
      render: (v: number | null, r: PreCheckItem) => {
        const result = results[r.id];
        const score = result ? result.score : v;
        return score != null ? (
          <Progress percent={score} size="small" format={() => `${score}分`}
            strokeColor={score >= 60 ? '#52c41a' : score >= 40 ? '#faad14' : '#cf1322'} />
        ) : '-';
      },
    },
    {
      title: '预检结果', key: 'preCheck', width: 100,
      render: (_: any, r: PreCheckItem) => {
        const result = results[r.id];
        if (!result) return '-';
        return result.passed
          ? <Tag color="green" icon={<CheckCircleOutlined />}>通过</Tag>
          : <Tag color="red" icon={<CloseCircleOutlined />}>未通过</Tag>;
      },
    },
    {
      title: '问题数', key: 'issues', width: 70,
      render: (_: any, r: PreCheckItem) => {
        const issues = results[r.id]?.issues;
        if (!issues) return '-';
        const errors = issues.filter((i: any) => i.severity === 'error').length;
        const warnings = issues.filter((i: any) => i.severity === 'warning').length;
        return (
          <Space size={4}>
            {errors > 0 && <Tag color="red">{errors}错误</Tag>}
            {warnings > 0 && <Tag color="orange">{warnings}警告</Tag>}
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Title level={4}>批量合规预检</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        选中多个报关单，一次跑合规检查
      </Text>

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col><Button onClick={fetchList} loading={loading}>加载报关单</Button></Col>
        <Col>
          <Button type="primary" onClick={handleBatchPreCheck} loading={prechecking}
            disabled={selectedIds.length === 0}
            icon={<CheckCircleOutlined />}>
            预检选中项（{selectedIds.length}条）
          </Button>
        </Col>
        <Col flex="auto" />
        <Col><Select value={filterMode} onChange={setFilterMode} style={{ width: 150 }}
          options={[
            { value: 'all', label: '全部模式' },
            { value: 'normal', label: '一般贸易' },
            { value: '9610', label: '跨境电商零售' },
            { value: '9710', label: 'B2B出口' },
            { value: '9810', label: '出口海外仓' },
            { value: '1210', label: '保税电商出口' },
            { value: '1239', label: '保税电商出口A' },
          ]} /></Col>
      </Row>

      <Card size="small">
        <Spin spinning={loading || prechecking}>
          <Table dataSource={filtered} columns={columns} rowKey="id"
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys: React.Key[]) => setSelectedIds(keys.map(String)),
            }}
            expandable={{
              expandedRowRender: (record: PreCheckItem) => {
                const result = results[record.id];
                if (!result || !result.issues || result.issues.length === 0) {
                  return <Text type="secondary">暂无结果，请先执行预检</Text>;
                }
                return (
                  <div style={{ padding: '8px 0' }}>
                    <div style={{ marginBottom: 8 }}>
                      <Space>
                        <Text strong>得分：</Text>
                        <Tag color={result.score >= 60 ? 'green' : result.score >= 40 ? 'orange' : 'red'}>{result.score}分</Tag>
                        <Text strong>建议：</Text>
                        <Text>{result.recommendation || '-'}</Text>
                      </Space>
                    </div>
                    {result.issues.map((issue: any, i: number) => (
                      <div key={i} style={{
                        padding: '4px 8px', marginBottom: 4, borderRadius: 4,
                        background: issue.severity === 'error' ? '#ffccc7' : issue.severity === 'warning' ? '#fff1b8' : '#d9f7be',
                        border: '1px solid ' + (issue.severity === 'error' ? '#ff4d4f' : issue.severity === 'warning' ? '#ffc53d' : '#52c41a'),
                      }}>
                        <Space>
                          <Tag color={issue.severity === 'error' ? '#ff4d4f' : issue.severity === 'warning' ? '#faad14' : '#1890ff'}>
                            {issue.code}
                          </Tag>
                          {issue.field && <Tag color="geekblue">{issue.field}</Tag>}
                          <Text>{issue.message}</Text>
                        </Space>
                        {issue.suggestion && (
                          <div style={{ marginTop: 2, color: '#666', fontSize: 12 }}>{issue.suggestion}</div>
                        )}
                        {issue.legalBasis && (
                          <div style={{ marginTop: 2, color: '#8c8c8c', fontSize: 12 }}>📖 法规依据：{issue.legalBasis}</div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              },
              rowExpandable: (record: PreCheckItem) => !!results[record.id],
            }}
            pagination={{ pageSize: 20 }} size="small" scroll={{ x: 600 }} />
        </Spin>
      </Card>

      {Object.keys(results).length > 0 && (
        <Card size="small" style={{ marginTop: 16 }}>
          <Alert
            type={Object.values(results).some((r: any) => !r.passed) ? 'warning' : 'success'}
            message={`已预检 ${Object.keys(results).length} 条，通过 ${Object.values(results).filter((r: any) => r.passed).length} 条，未通过 ${Object.values(results).filter((r: any) => !r.passed).length} 条`}
            showIcon
          />
        </Card>
      )}
    </div>
  );
}
