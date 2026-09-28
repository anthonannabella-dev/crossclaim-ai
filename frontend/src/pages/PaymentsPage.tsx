import { useEffect, useState } from 'react';
import { Card, Table, Button, Tag, Tabs, Row, Col, Descriptions, message, Badge } from 'antd';
import { CheckCircleOutlined, CrownOutlined } from '@ant-design/icons';
import api from '../utils/api';

const PLAN_META: Record<string, { name: string; color: string }> = {
  BASIC: { name: '基础版', color: 'blue' },
  PROFESSIONAL: { name: '专业版', color: 'purple' },
  ENTERPRISE: { name: '企业版', color: 'gold' },
};

export default function PaymentsPage() {
  const [payments, setPayments] = useState<any[]>([]);
  const [subscription, setSubscription] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get('/api/payments'),
      api.get('/api/payments/subscription'),
    ]).then(([payRes, subRes]) => {
      setPayments(payRes.data);
      setSubscription(subRes.data);
    }).finally(() => setLoading(false));
  }, []);

  const handleCreateOrder = async (planTier: string, paymentCycle: string, paymentMethod: string) => {
    setCreatingOrder(true);
    try {
      const res = await api.post('/api/payments/create-order', { planTier, paymentCycle, paymentMethod });
      if (res.data.paymentUrl) {
        window.open(res.data.paymentUrl, '_blank');
      }
      if (res.data.qrCode) {
        message.info('请使用微信扫描二维码支付');
      }
      message.success('订单已创建');
    } catch (err: any) {
      message.error(err.response?.data?.error || '创建订单失败');
    } finally {
      setCreatingOrder(false);
    }
  };

  const paymentColumns = [
    { title: '订单号', dataIndex: 'transactionId', key: 'transactionId', width: 180, render: (v: string) => v?.slice(0, 16) + '...' },
    { title: '金额', dataIndex: 'amount', key: 'amount', render: (v: number) => `¥${v}` },
    { title: '套餐', dataIndex: 'planTier', key: 'planTier', render: (v: string) => <Tag color={PLAN_META[v]?.color}>{PLAN_META[v]?.name || v}</Tag> },
    { title: '付费类型', dataIndex: 'paymentCycle', key: 'paymentCycle', render: (v: string) => v === 'ANNUAL' ? '年付' : '月付' },
    { title: '支付方式', dataIndex: 'paymentMethod', key: 'paymentMethod', render: (v: string) => v === 'wechat' ? '微信' : '支付宝' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (v: string) => (
      <Tag color={v === 'success' ? 'green' : v === 'pending' ? 'orange' : 'red'}>
        {{ success: '已支付', pending: '待支付', failed: '失败', refunded: '已退款' }[v] || v}
      </Tag>
    )},
    { title: '时间', dataIndex: 'createdAt', key: 'createdAt', render: (v: string) => new Date(v).toLocaleString('zh-CN') },
  ];

  return (
    <div>
      <h2>账单与支付</h2>
      <Tabs items={[
        {
          key: 'subscription',
          label: '当前套餐',
          children: (
            <Card>
              {subscription && (
                <>
                  <Descriptions column={{ xs: 1, sm: 2, md: 3 }}>
                    <Descriptions.Item label="当前套餐">
                      <Tag color={PLAN_META[subscription.planTier]?.color} icon={<CrownOutlined />}>
                        {PLAN_META[subscription.planTier]?.name || subscription.planTier}
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="付费方式">
                      {subscription.paymentCycle === 'ANNUAL' ? '年付' : subscription.paymentCycle === 'MONTHLY' ? '月付' : '未付费'}
                    </Descriptions.Item>
                    <Descriptions.Item label="账号状态">
                      <Badge status={subscription.status === 'ACTIVE' ? 'success' : subscription.status === 'TRIAL' ? 'processing' : 'error'}
                        text={({ TRIAL: '试用中', ACTIVE: '正常', FROZEN: '已冻结', DISABLED: '已禁用' } as Record<string, string>)[subscription.status]} />
                    </Descriptions.Item>
                    <Descriptions.Item label="到期时间">
                      {subscription.expiresAt ? new Date(subscription.expiresAt).toLocaleDateString('zh-CN') : '试用中'}
                    </Descriptions.Item>
                    <Descriptions.Item label="首次订阅">
                      {subscription.subscribedAt ? new Date(subscription.subscribedAt).toLocaleDateString('zh-CN') : '-'}
                    </Descriptions.Item>
                  </Descriptions>

                  <div style={{ marginTop: 24 }}>
                    <h3>选购套餐</h3>
                    <Row gutter={[16, 16]}>
                      {['BASIC', 'PROFESSIONAL', 'ENTERPRISE'].map(tier => (
                        <Col xs={24} sm={12} lg={8} key={tier}>
                          <Card title={<span><CrownOutlined style={{ color: PLAN_META[tier]?.color }} /> {PLAN_META[tier]?.name}</span>}
                            style={{ borderColor: subscription?.planTier === tier ? PLAN_META[tier]?.color : undefined }}>
                            <p><strong>年付:</strong> ¥{({ BASIC: 1999, PROFESSIONAL: 4999, ENTERPRISE: 9999 } as any)[tier]}/年</p>
                            <p><strong>月付:</strong> ¥{({ BASIC: 199, PROFESSIONAL: 499, ENTERPRISE: 999 } as any)[tier]}/月</p>
                            <Button type="primary" block style={{ marginBottom: 8 }}
                              onClick={() => handleCreateOrder(tier, 'ANNUAL', 'wechat')} loading={creatingOrder}>
                              微信年付
                            </Button>
                            <Button block style={{ marginBottom: 8 }}
                              onClick={() => handleCreateOrder(tier, 'MONTHLY', 'wechat')} loading={creatingOrder}>
                              微信月付
                            </Button>
                            <Button block style={{ marginBottom: 8 }}
                              onClick={() => handleCreateOrder(tier, 'ANNUAL', 'alipay')} loading={creatingOrder}>
                              支付宝年付
                            </Button>
                            <Button block onClick={() => handleCreateOrder(tier, 'MONTHLY', 'alipay')} loading={creatingOrder}>
                              支付宝月付
                            </Button>
                          </Card>
                        </Col>
                      ))}
                    </Row>
                  </div>
                </>
              )}
            </Card>
          ),
        },
        {
          key: 'history',
          label: '缴费记录',
          children: <Table dataSource={payments} columns={paymentColumns} rowKey="id" loading={loading} scroll={{ x: 800 }} />,
        },
      ]} />
    </div>
  );
}
