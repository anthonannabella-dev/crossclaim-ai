import { useState, useEffect } from 'react';
import { Modal, Steps, Typography, Button, Space, Tag, theme, Alert } from 'antd';
import {
  SearchOutlined, FileTextOutlined, AuditOutlined,
  ApiOutlined, SettingOutlined, RocketOutlined,
  DownloadOutlined, LinkOutlined, CheckCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

const { Title, Paragraph, Text } = Typography;

interface OnboardingGuideProps {
  open: boolean;
  onClose: () => void;
}

const steps = [
  {
    title: '第1步：填商品信息',
    icon: <FileTextOutlined />,
    desc: '1分钟',
    content: (
      <div>
        <p style={{ marginBottom: 12 }}>在「构建报关单」页面，把提单/发票上的信息填进去：</p>
        <div style={{ background: '#F9FAFB', padding: '12px 16px', borderRadius: 8, marginBottom: 12 }}>
          • <Text strong>HS编码</Text> — 如果不知道，AI可以帮你归类<br />
          • <Text strong>运输方式</Text> — 下拉选择：海运/空运/陆运/铁路<br />
          • <Text strong>入境口岸</Text> — 比如"上海外高桥"<br />
          • <Text strong>贸易条款</Text> — 选 FOB / CIF / EXW 等
        </div>
        <img src="/images/step1-fill-info.png" alt="填商品信息"
          style={{ width: '100%', borderRadius: 8, marginBottom: 8 }} />
        <Alert type="info" message="💡 不记得HS编码？下一步AI会自动帮你归类"
          style={{ fontSize: 12, padding: '8px 12px' }} showIcon />
      </div>
    ),
  },
  {
    title: '第2步：AI智能归类 + 税率对比',
    icon: <SearchOutlined />,
    desc: '5-10秒',
    content: (
      <div>
        <p style={{ marginBottom: 12 }}>系统自动执行：</p>
        <div style={{ background: '#F0FFF4', padding: '12px 16px', borderRadius: 8, marginBottom: 12 }}>
          ✅ 根据商品描述推荐最合适的 <Text strong>HS编码</Text>（含置信度）<br />
          ✅ 自动查询 <Text strong>MFN税率</Text>（最惠国）<br />
          ✅ 自动对比 <Text strong>RCEP / 中韩 / 中澳</Text> 等自贸区优惠税率<br />
          ✅ 如果出口欧盟，自动评估 <Text strong>CBAM碳关税</Text> 成本
        </div>
        <img src="/images/step2-ai-classify.png" alt="AI智能归类"
          style={{ width: '100%', borderRadius: 8, marginBottom: 8 }} />
        <Alert type="success" message="💡 系统会帮你选最优路线，自动算出能省多少关税"
          style={{ fontSize: 12, padding: '8px 12px' }} showIcon />
      </div>
    ),
  },
  {
    title: '第3步：合规预检',
    icon: <AuditOutlined />,
    desc: '几秒钟',
    content: (
      <div>
        <p style={{ marginBottom: 12 }}>系统自动运行 <Text strong>17项合规检查</Text>：</p>
        <div style={{ background: '#FFF7E6', padding: '12px 16px', borderRadius: 8, marginBottom: 12 }}>
          🔴 <Text type="danger">错误</Text> — 必须修改（如HS编码格式错误）<br />
          🟡 <Text style={{ color: '#F59E0B' }}>警告</Text> — 建议修正（如缺少原产地证书）<br />
          🔵 <Text style={{ color: '#1677ff' }}>提示</Text> — 仅供参考（如适用RCEP税率）
        </div>
        <img src="/images/step3-compliance.png" alt="合规预检"
          style={{ width: '100%', borderRadius: 8, marginBottom: 8 }} />
        <p>
          <Text strong style={{ color: '#10B981' }}>评分 ≥ 90</Text> → 绿色通过，可以出口<br />
          <Text strong style={{ color: '#EF4444' }}>评分 &lt; 60</Text> → 红色不通过，系统告诉你每个问题怎么改
        </p>
        <Alert type="info" message="💡 相当于有个专业报关员帮你审了一遍"
          style={{ fontSize: 12, padding: '8px 12px', marginTop: 8 }} showIcon />
      </div>
    ),
  },
  {
    title: '第4步：导出XML → 上传单一窗口',
    icon: <RocketOutlined />,
    desc: '1分钟',
    content: (
      <div>
        <Text strong style={{ fontSize: 14 }}>在系统内：</Text>
        <div style={{ background: '#F0F5FF', padding: '8px 12px', borderRadius: 6, margin: '8px 0 16px' }}>
          🖱 点击「导出XML」→ 浏览器自动下载 .xml 文件
        </div>

        <Text strong style={{ fontSize: 14 }}>在海关单一窗口：</Text>
        <div style={{ background: '#F9FAFB', padding: '12px 16px', borderRadius: 8, marginTop: 8 }}>
          ① 打开 <a href="https://www.singlewindow.cn" target="_blank">中国国际贸易单一窗口 →</a><br />
          ② 登录企业账号（需要 <Text strong>电子口岸卡 + U盾</Text>）<br />
          ③ 找到菜单：<Text code>报关申报 → 导入XML</Text><br />
          ④ 选择刚才下载的 .xml 文件 → 点击上传<br />
          ⑤ 检查字段 → 确认无误 → 点击申报
        </div>

        <img src="/images/step4-xml-export.png" alt="导出XML上传单一窗口"
          style={{ width: '100%', borderRadius: 8, marginTop: 8, marginBottom: 8 }} />

        <Alert type="warning" message="⚠️ 第一次使用需注册单一窗口账号、办理电子口岸卡。如果还没有，可以让货代帮你操作"
          style={{ fontSize: 12, padding: '8px 12px', marginTop: 12 }} showIcon />
      </div>
    ),
  },
];

export default function OnboardingGuide({ open, onClose }: OnboardingGuideProps) {
  const [current, setCurrent] = useState(0);
  const [finished, setFinished] = useState(false);
  const { token } = theme.useToken();
  const navigate = useNavigate();

  useEffect(() => {
    if (open) { setCurrent(0); setFinished(false); }
  }, [open]);

  const handleFinish = () => {
    setFinished(true);
    onClose();
  };

  const handleGoToDeclaration = () => {
    onClose();
    navigate('/declaration');
  };

  if (finished) {
    return (
      <Modal open={open} onCancel={onClose} footer={null} width={500} closable={false}>
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <div style={{ fontSize: 64, marginBottom: 12 }}>🎉</div>
          <Title level={3}>全部掌握！</Title>
          <Paragraph style={{ color: '#6B7280', fontSize: 14 }}>
            你已经在系统里完成了商品信息填写、AI归类、合规预检、XML导出。<br />
            剩下的就是把 XML 上传到海关单一窗口，点击申报。
          </Paragraph>
          <Paragraph style={{ color: '#10B981', fontWeight: 600, fontSize: 15 }}>
            全程不到 5 分钟，而且不会因为填错被退单。
          </Paragraph>
          <Space style={{ marginTop: 16 }}>
            <Button type="primary" size="large" onClick={handleGoToDeclaration}
              icon={<ThunderboltOutlined />}>
              开始第一次报关
            </Button>
            <Button onClick={onClose}>关闭</Button>
          </Space>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={<><RocketOutlined style={{ color: token.colorPrimary }} /> 报关引导 — 跟着我，4步搞定</>}
      open={open}
      onCancel={onClose}
      footer={null}
      width={680}
    >
      <Steps
        current={current}
        onChange={setCurrent}
        direction="vertical"
        size="small"
        style={{ marginTop: 16 }}
        items={steps.map((step, i) => ({
          title: (
            <Space>
              {step.title}
              <Tag color="default" style={{ fontSize: 10, lineHeight: '16px', fontWeight: 400 }}>
                {step.desc}
              </Tag>
            </Space>
          ),
          description: i === current && (
            <div style={{
              background: token.colorFillAlter,
              padding: '16px 20px',
              borderRadius: 8,
              marginTop: 8,
            }}>
              {step.content}
            </div>
          ),
          icon: step.icon,
          status: i < current ? 'finish' : (i === current ? 'process' : 'wait'),
        }))}
      />
      <div style={{
        marginTop: 20, paddingTop: 16, borderTop: '1px solid ' + token.colorBorderSecondary,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ color: token.colorTextSecondary, fontSize: 13 }}>
          第 {current + 1} / {steps.length} 步
        </span>
        <Space>
          {current > 0 && (
            <Button onClick={() => setCurrent(c => c - 1)}>上一步</Button>
          )}
          {current < steps.length - 1 ? (
            <Button type="primary" onClick={() => setCurrent(c => c + 1)}>
              下一步 →
            </Button>
          ) : (
            <Button type="primary" size="large" onClick={handleFinish}
              icon={<CheckCircleOutlined />}>
              完成，开始使用！
            </Button>
          )}
        </Space>
      </div>
    </Modal>
  );
}
