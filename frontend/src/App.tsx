import { Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import HelpPage from './pages/HelpPage';
import DashboardLayout from './layouts/DashboardLayout';
import AdminLayout from './layouts/AdminLayout';
import PolicyPage from './pages/PolicyPage';
import AIPage from './pages/AIPage';
import DashboardPage from './pages/DashboardPage';
import ReportsPage from './pages/ReportsPage';
import PaymentsPage from './pages/PaymentsPage';
import SettingsPage from './pages/SettingsPage';
import SubAccountsPage from './pages/SubAccountsPage';
import ApiKeysPage from './pages/ApiKeysPage';
import WebhookPage from './pages/WebhookPage';
import UsagePage from './pages/UsagePage';
import TariffWorkbench from './pages/TariffWorkbench';
import TaxRebateManage from './pages/TaxRebateManage';
import DeclarationComparePage from './pages/DeclarationComparePage';
import RiskDashboardPage from './pages/RiskDashboardPage';
import ArchiveSearchPage from './pages/ArchiveSearchPage';
import AuditLogPage from './pages/AuditLogPage';
import LicenseLedgerPage from './pages/LicenseLedgerPage';
import BillOfLadingPage from './pages/BillOfLadingPage';
import BillOfLadingCheckPage from './pages/BillOfLadingCheckPage';
import BatchArchivePage from './pages/BatchArchivePage';

import AdminDashboard from './pages/admin/AdminDashboard';
import AdminTenants from './pages/admin/AdminTenants';
import AdminPayments from './pages/admin/AdminPayments';
import AdminAPIMonitor from './pages/admin/AdminAPIMonitor';
import AdminTimeGrants from './pages/admin/AdminTimeGrants';
import AdminAnnouncements from './pages/admin/AdminAnnouncements';
import AdminPolicyAlerts from './pages/admin/AdminPolicyAlerts';
import ProtectedRoute from './components/ProtectedRoute';
  import SupplierInvoicePage from './pages/SupplierInvoicePage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/dashboard" element={<ProtectedRoute children={<DashboardLayout />} />}>
        <Route index element={<DashboardPage />} />
        <Route path="risk-dashboard" element={<RiskDashboardPage />} />
        <Route path="bill-of-lading" element={<BillOfLadingPage />} />
            <Route path="batch-archive" element={<BatchArchivePage />} />
        
        <Route path="bl-check" element={<BillOfLadingCheckPage />} />
        <Route path="declaration-compare" element={<DeclarationComparePage />} />
        <Route path="tariff-workbench" element={<TariffWorkbench />} />
        <Route path="archive-search" element={<ArchiveSearchPage />} />
        <Route path="audit-logs" element={<AuditLogPage />} />
          <Route path="supplier-invoice" element={<SupplierInvoicePage />} />
        <Route path="tax-rebate-manage" element={<TaxRebateManage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="policy" element={<PolicyPage />} />
        <Route path="license-ledger" element={<LicenseLedgerPage />} />
        <Route path="ai" element={<AIPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="webhooks" element={<WebhookPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="sub-accounts" element={<SubAccountsPage />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="help" element={<HelpPage />} />
      </Route>
      <Route path="/admin" element={<ProtectedRoute children={<AdminLayout />} />}>
        <Route index element={<AdminDashboard />} />
        <Route path="tenants" element={<AdminTenants />} />
        <Route path="payments" element={<AdminPayments />} />
        <Route path="api-monitor" element={<AdminAPIMonitor />} />
        <Route path="time-grants" element={<AdminTimeGrants />} />
        <Route path="announcements" element={<AdminAnnouncements />} />
        <Route path="policy-alerts" element={<AdminPolicyAlerts />} />
      </Route>
      <Route path="/" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}