import { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Button, Grid, theme } from 'antd';
import {
  DashboardOutlined, TeamOutlined, DollarOutlined, ApiOutlined,
  ClockCircleOutlined, NotificationOutlined, SoundOutlined, LogoutOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined,
} from '@ant-design/icons';

const { Header, Sider, Content } = Layout;
const { useBreakpoint } = Grid;

const menuItems = [
  { key: '/admin', icon: <DashboardOutlined />, label: '数据大盘' },
  { key: 'tenants', icon: <TeamOutlined />, label: '客户档案' },
  { key: 'payments', icon: <DollarOutlined />, label: '收费台账' },
  { key: 'api-monitor', icon: <ApiOutlined />, label: 'API监控' },
  { key: 'time-grants', icon: <ClockCircleOutlined />, label: '赠时管理' },
  { key: 'announcements', icon: <NotificationOutlined />, label: '系统公告' },
  { key: 'policy-alerts', icon: <SoundOutlined />, label: '法规管理' },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const currentPath = location.pathname.split('/').pop() || '/admin';
  const { token } = theme.useToken();
  const screens = useBreakpoint();
  const [collapsed, setCollapsed] = useState(false);
  const isMobile = !screens.lg;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        breakpoint="lg"
        collapsible
        collapsedWidth={0}
        trigger={null}
        collapsed={collapsed}
        onCollapse={setCollapsed}
      >
        <div style={{ color: token.colorWhite, textAlign: 'center', padding: 16, fontWeight: 'bold' }}>
          运营管理后台
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[currentPath]}
          items={menuItems} onClick={({ key }) => {
            navigate(`/admin/${key === '/admin' ? '' : key}`);
            if (isMobile) setCollapsed(true);
          }} />
      </Sider>
      <Layout>
        <Header style={{
          background: token.colorBgContainer,
          padding: isMobile ? '0 12px' : '0 24px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          {isMobile && (
            <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)} />
          )}
          {isMobile && <span style={{ fontWeight: 600, fontSize: 15 }}>运营管理后台</span>}
          <div style={{ marginLeft: 'auto' }}>
            <Button icon={<LogoutOutlined />} onClick={() => { localStorage.removeItem('adminToken'); navigate('/login'); }}>
              {!isMobile && '退出'}
            </Button>
          </div>
        </Header>
        <Content style={{
          margin: isMobile ? 8 : 16,
          padding: isMobile ? 12 : 24,
          background: token.colorBgContainer,
          borderRadius: token.borderRadiusLG,
        }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
