import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Alert } from 'antd';
import { TeamOutlined, UserOutlined, DollarOutlined, StopOutlined, CrownOutlined, ClockCircleOutlined, ApiOutlined, FileTextOutlined, WifiOutlined } from '@ant-design/icons';
import api from '../../utils/adminApi';

export default function AdminDashboard() {
  const [stats, setStats] = useState<any>({});

  useEffect(() => {
    api.get('/admin/stats').then(res => setStats(res.data)).catch(() => {});
  }, []);

  return (
    <div>
      <h2>运营数据大盘</h2>

      {stats.expiringCount > 0 && (
        <Alert
          type="warning"
          message={`${stats.expiringCount} 家企业将在7天内到期，请关注续费提醒`}
          style={{ marginBottom: 16 }}
          showIcon
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}><Card><Statistic title="总注册企业" value={stats.totalTenants || 0} prefix={<TeamOutlined />} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="试用中" value={stats.trialCount || 0} prefix={<UserOutlined />} valueStyle={{ color: '#1890ff' }} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="付费客户" value={stats.paidCount || 0} prefix={<DollarOutlined />} valueStyle={{ color: '#3f8600' }} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="企业版" value={stats.enterpriseCount || 0} prefix={<CrownOutlined />} valueStyle={{ color: '#722ed1' }} /></Card></Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={12} sm={6}><Card><Statistic title="冻结/停用" value={stats.frozenCount || 0} prefix={<StopOutlined />} valueStyle={{ color: '#cf1322' }} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="7天内到期" value={stats.expiringCount || 0} prefix={<ClockCircleOutlined />} valueStyle={{ color: '#fa8c16' }} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="单证总量" value={stats.documentCount || 0} prefix={<FileTextOutlined />} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="在线用户" value={stats.onlineUsers || 0} prefix={<WifiOutlined />} valueStyle={{ color: '#52c41a' }} /></Card></Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={12} sm={6}><Card><Statistic title="审计日志" value={stats.auditCount || 0} prefix={<FileTextOutlined />} /></Card></Col>
        <Col xs={12} sm={6}>
          <Card><Statistic title="累计营收" value={stats.revenueTotal || 0} prefix="¥" precision={2} valueStyle={{ color: '#3f8600' }} /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card><Statistic title="本月营收" value={stats.revenueMonth || 0} prefix="¥" precision={2} valueStyle={{ color: '#3f8600' }} /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card><Statistic title="本月API调用" value={stats.apiCallMonth || 0} prefix={<ApiOutlined />} /></Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={12} sm={6}>
          <Card><Statistic title="累计API调用" value={stats.apiCallTotal || 0} prefix={<ApiOutlined />} /></Card>
        </Col>
      </Row>
    </div>
  );
}
