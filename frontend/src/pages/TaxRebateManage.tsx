import { Tabs } from 'antd';
import TaxRebatePage from './TaxRebatePage';
import TaxRebateTrackingPage from './TaxRebateTrackingPage';
import SupplierInvoicePage from './SupplierInvoicePage';
import RebateArchivePage from './RebateArchivePage';

export default function TaxRebateManage() {
  return (
    <div>
      <Tabs
        defaultActiveKey="calculate"
        items={[
          {
            key: 'calculate',
            label: '退税计算',
            children: <TaxRebatePage />,
          },
          {
            key: 'invoices',
            label: '供应商发票',
            children: <SupplierInvoicePage />,
          },
          {
            key: 'tracking',
            label: '退税跟踪',
            children: <TaxRebateTrackingPage />,
          },
          {
            key: 'archive',
            label: '备案归档',
            children: <RebateArchivePage />,
          },
        ]}
      />
    </div>
  );
}
