import axios from 'axios';

const adminApi = axios.create({
  baseURL: '/',
  timeout: 30000,
});

adminApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('adminToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

adminApi.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('adminToken');
      // 让路由守卫做 SPA 跳转，避免硬刷新状态丢失
    }
    return Promise.reject(err);
  }
);

export default adminApi;
