import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Spin, Button, Result } from 'antd';
import { useAuthStore } from '../stores/authStore';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const token = localStorage.getItem('token');
  const adminToken = localStorage.getItem('adminToken');
  const { tenant, loading, fetchTenant } = useAuthStore();
  const location = useLocation();
  const attemptedRef = useRef(false);
  const [error, setError] = useState(false);

  const isAdminRoute = location.pathname.startsWith('/admin');

  if (!token && !adminToken) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (isAdminRoute && !adminToken) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  useEffect(() => {
    if (!tenant && !loading && !attemptedRef.current) {
      attemptedRef.current = true;
      fetchTenant().catch(() => setError(true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant, loading]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Spin size="large" tip="加载中..." />
      </div>
    );
  }

  if (error) {
    const handleLogout = () => {
      localStorage.removeItem('token');
      window.location.href = '/login';
    };

    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Result
          status="error"
          title="加载失败"
          subTitle="无法获取账户信息，请检查网络后重试"
          extra={[
            <Button key="retry" type="primary" onClick={() => { setError(false); fetchTenant().catch(() => setError(true)); }}>
              重试
            </Button>,
            <Button key="logout" onClick={handleLogout}>重新登录</Button>,
          ]}
        />
      </div>
    );
  }

  return <>{children}</>;
}
