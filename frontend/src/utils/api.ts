import axios from 'axios';
import { message } from 'antd';

const api = axios.create({
  baseURL: '/',
  timeout: 30000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      // 只删 token，让 ProtectedRoute 的路由守卫做 SPA 跳转
      localStorage.removeItem('token');
    }
    return Promise.reject(err);
  }
);

export default api;
