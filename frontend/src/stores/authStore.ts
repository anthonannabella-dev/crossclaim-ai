import { create } from 'zustand';
import api from '../utils/api';

interface Tenant {
  id: string;
  companyName: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  status: string;
  planTier: string;
  paymentCycle: string;
  trialEndAt: string;
  trialStartAt?: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt?: string;
  frozenAt?: string | null;
  subscribedAt?: string | null;
}

interface AuthState {
  tenant: Tenant | null;
  loading: boolean;
  fetchTenant: () => Promise<void>;
  setTenant: (t: Tenant) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  tenant: null,
  loading: false,
  fetchTenant: async () => {
    try {
      set({ loading: true });
      const res = await api.get('/api/tenant/profile');
      set({ tenant: res.data });
    } catch (e) {
      console.error('fetchTenant failed:', e);
      set({ tenant: null });
    } finally {
      set({ loading: false });
    }
  },
  setTenant: (t) => set({ tenant: t }),
  logout: () => {
    localStorage.removeItem('token');
    set({ tenant: null });
  },
}));
