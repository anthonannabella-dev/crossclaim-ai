import { useState, useEffect } from 'react';
import { Card, Row, Col, Progress, Table, Tag, Space, Typography, Statistic, Spin } from 'antd';
import {
  RobotOutlined, FileTextOutlined, ExportOutlined, ScanOutlined,
  AlertOutlined, GlobalOutlined, CloudOutlined, CrownOutlined, DollarOutlined,
} from '@ant-design/icons';
import api from '../utils/api';

const { Text, Title } = Typography;

interface QuotaItem {
  current: number;
  limit: number;
  remaining: number;
  label: string;
  period: string;
}

interface UsageData {
  plan: string;
  quotas: Record<string, number>;
  usage: Record<string, QuotaItem>;
  storage: { usedMB: number; limitMB: number; remainingMB: number };
}

interface AllPlan {
  tier: string;
  aiClassifyDaily: number;
  documentsMonthly: number;
  declarationsMonthly: number;
  ocrMonthly: number;
  cbamMonthly: number;
  rcepMonthly: number;
  apiCallsDaily: number;
  storageMB: number;
  subAccounts: number;
  apiRateLimit: number;
}

const RESOURCE_ICONS: Record<string, React.ReactNode> = {
  ai_classify: <RobotOutlined />,
  document_upload: <FileTextOutlined />,
  declaration_build: <ExportOutlined />,
  ocr: <ScanOutlined />,
  cbam: <AlertOutlined />,
  rcep: <GlobalOutlined />,
  tax_rebate: <DollarOutlined />,
  api_call: <CloudOutlined />,
};

const PLAN_LABELS: Record<string, string> = {
  TRIAL: '试用版',
  BASIC: '基础版',
  PROFESSIONAL: '专业版',
  ENTERPRISE: '企业版',
};

const PERIOD_LABELS: Record<string, string> = {
  daily: '今日',
  monthly: '本月',
};

function planLevel(tier: string): number {
  const order = ['TRIAL', 'BASIC', 'PROFESSIONAL', 'ENTERPRISE'];
  return order.indexOf(tier);
}

export default function UsagePage() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [allPlans, setAllPlans] = useState<AllPlan[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchUsage = async () => {
    setLoading(true);
    try {
      const [usageRes, limitsRes] = await Promise.all([
        api.get('/api/usage'),
        api.get('/api/usage/limits'),
      ]);
      setUsage(usageRes.data);
      setAllPlans(limitsRes.data.allPlans);
    } catch {
      // 静默
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchUsage(); }, []);

  const getPercent = (current: number, limit: number) => {
    if (limit === 0) return 0;
    return Math.round((current / limit) * 100);
  };

  const getColor = (percent: number) => {
    if (percent >= 100) return '#ff4d4f';
    if (percent >= 80) return '#faad14';
    return '#52c41a';
  };

  const planCompareColumns = [
    {
      title: '套餐', dataIndex: 'tier', key: 'tier', width: 100,
      render: (t: string) => <Tag color={planLevel(t) >= planLevel(usage?.plan || 'TRIAL') ? 'gold' : 'default'}>{PLAN_LABELS[t]}</Tag>,
    },
    { title: 'AI归类/日', dataIndex: 'aiClassifyDaily', key: 'aiClassifyDaily', width: 90 },
    { title: '单证/月', dataIndex: 'documentsMonthly', key: 'documentsMonthly', width: 80 },
    { title: '报关单/月', dataIndex: 'declarationsMonthly', key: 'declarationsMonthly', width: 90 },
    { title: 'OCR/月', dataIndex: 'ocrMonthly', key: 'ocrMonthly', width: 80 },
    { title: 'CBAM/月', dataIndex: 'cbamMonthly', key: 'cbamMonthly', width: 90 },
    { title: 'RCEP/月', dataIndex: 'rcepMonthly', key: 'rcepMonthly', width: 90 },
    { title: 'API调用/日', dataIndex: 'apiCallsDaily', key: 'apiCallsDaily', width: 100 },
    { title: '存储(MB)', dataIndex: 'storageMB', key: 'storageMB', width: 90 },
    { title: '子账号', dataIndex: 'subAccounts', key: 'subAccounts', width: 70 },
  ];

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* 当前套餐 */}
        <Card size="small">
          <Space>
            <CrownOutlined style={{ color: '#faad14', fontSize: 18 }} />
            <Text strong>当前套餐: {PLAN_LABELS[usage?.plan || 'TRIAL']}</Text>
            {usage && planLevel(usage.plan) < 3 && (
              <Tag color="blue" style={{ cursor: 'pointer' }} onClick={() => window.location.href = '/dashboard/payments'}>
                升级套餐
              </Tag>
            )}
          </Space>
        </Card>

        {/* 用量卡片 */}
        <Row gutter={[16, 16]}>
          {usage && Object.entries(usage.usage).map(([key, item]) => {
            const percent = getPercent(item.current, item.limit);
            const color = getColor(percent);
            return (
              <Col xs={24} sm={12} lg={8} key={key}>
                <Card size="small" hoverable>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Space>
                      {RESOURCE_ICONS[key]}
                      <Text>{item.label}</Text>
                      <Tag>{PERIOD_LABELS[item.period]}</Tag>
                    </Space>
                    <Text strong style={{ color }}>{percent}%</Text>
                  </Space>
                  <Progress
                    percent={percent}
                    strokeColor={color}
                    size="small"
                    style={{ marginTop: 8, marginBottom: 4 }}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {item.current} / {item.limit === 0 ? '∞' : item.limit}
                    {item.limit > 0 && item.remaining <= 5 && item.remaining > 0 && (
                      <Text type="warning" style={{ fontSize: 12 }}> · 剩余 {item.remaining}</Text>
                    )}
                  </Text>
                </Card>
              </Col>
            );
          })}

          {/* 存储用量 */}
          {usage && (
            <Col xs={24} sm={12} lg={8}>
              <Card size="small" hoverable>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Space>
                    <CloudOutlined />
                    <Text>存储空间</Text>
                  </Space>
                  <Text strong style={{ color: getColor(getPercent(usage.storage.usedMB, usage.storage.limitMB)) }}>
                    {getPercent(usage.storage.usedMB, usage.storage.limitMB)}%
                  </Text>
                </Space>
                <Progress
                  percent={getPercent(usage.storage.usedMB, usage.storage.limitMB)}
                  strokeColor={getColor(getPercent(usage.storage.usedMB, usage.storage.limitMB))}
                  size="small"
                  style={{ marginTop: 8, marginBottom: 4 }}
                />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {usage.storage.usedMB} MB / {usage.storage.limitMB} MB
                </Text>
              </Card>
            </Col>
          )}
        </Row>

        {/* 套餐对比 */}
        <Card title="套餐对比" size="small">
          <Table
            rowKey="tier"
            dataSource={allPlans}
            columns={planCompareColumns}
            pagination={false}
            size="small"
            scroll={{ x: 900 }}
            rowClassName={(record) => record.tier === usage?.plan ? 'ant-table-row-selected' : ''}
          />
        </Card>
      </Space>
    </Spin>
  );
}
