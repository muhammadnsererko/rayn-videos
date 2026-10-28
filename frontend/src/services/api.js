import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('rayn_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export function apiErrorMessage(error) {
  return error.response?.data?.error || error.message || 'Something went wrong.';
}

export default api;