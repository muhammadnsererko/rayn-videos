import axios from 'axios';
import { apiErrorMessage } from './errors.js';

export { apiErrorMessage };

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('rayn_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default api;