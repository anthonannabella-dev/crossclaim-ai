import { Tabs } from 'antd';
import HSCodePage from './HSCodePage';
import OriginPage from './OriginPage';
import RCEPPage from './RCEPPage';
import CBAMPage from './CBAMPage';
import DutyCalculatorPage from './DutyCalculatorPage';
import PipelineTariffPage from './PipelineTariffPage';

export default function TariffWorkbench() {
  return (
    <div>
      <Tabs
        defaultActiveKey="pipeline"
        items={[
          {
            key: 'pipeline',
            label: '流水线带入',
            children: <PipelineTariffPage />,
          },
          {
            key: 'hscode',
            label: 'HS编码查询',
            children: <HSCodePage />,
          },
          {
            key: 'origin',
            label: '原产地判定',
            children: <OriginPage />,
          },
          {
            key: 'tariff',
            label: '关税核算',
            children: (
              <Tabs
                defaultActiveKey="duty"
                items={[
                  {
                    key: 'duty',
                    label: '税费试算',
                    children: <DutyCalculatorPage />,
                  },
                  {
                    key: 'rcep',
                    label: 'RCEP核算',
                    children: <RCEPPage />,
                  },
                  {
                    key: 'cbam',
                    label: 'CBAM碳关税',
                    children: <CBAMPage />,
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
