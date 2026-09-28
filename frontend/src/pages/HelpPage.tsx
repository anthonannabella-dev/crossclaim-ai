import { Card, Collapse, Typography, theme, Button, Modal } from 'antd';
import { useState } from 'react';
import { QuestionCircleOutlined, CompassOutlined, ExportOutlined } from '@ant-design/icons';

const { Title, Paragraph, Text } = Typography;

const faqSections = [
  {
    key: 'getting-started',
    label: '快速入门',
    children: [
      {
        q: '如何开始使用本平台？',
        a: '注册企业账号后，您将获得7天全功能试用。从「HS编码查询」搜索您的商品编码开始，然后上传报关文件进行AI审核。',
      },
      {
        q: '支持哪些报关业务类型？',
        a: '支持一般贸易出口报关、加工贸易、跨境电商等多种业务类型的合规审查，覆盖HS编码归类、原产地判定、CBAM碳关税计算、出口退税等。',
      },
      {
        q: '如何切换套餐？',
        a: '在「账单与支付 > 当前套餐」中查看当前套餐，试用结束后可选择升级为企业版年付或月付套餐。',
      },
    ],
  },
  {
    key: 'hs-code',
    label: 'HS编码查询',
    children: [
      {
        q: 'AI分类的准确率如何？',
        a: '基于DeepSeek大模型和海量历史报关数据训练，大类准确率>95%。建议将AI推荐结果与商品实际情况核对后使用。',
      },
      {
        q: '支持哪些国家的HS编码？',
        a: '目前主要支持中国海关HS编码（10位），同时支持RCEP成员国的HS编码查询和转换。',
      },
    ],
  },
  {
    key: 'documents',
    label: '文件管理与OCR',
    children: [
      {
        q: '支持哪些文件格式？',
        a: '支持PDF、JPG、PNG、XLSX、DOCX等常见格式，单文件最大50MB。PDF支持多页识别。',
      },
      {
        q: '文件存储安全吗？',
        a: '所有文件AES-256加密存储，每个企业有独立的MinIO存储空间，文件隔离。传输过程使用TLS加密。',
      },
      {
        q: 'OCR识别不准确怎么办？',
        a: 'OCR结果可手动修正。对于复杂表格或手写内容，建议补充清晰扫描件。系统持续优化识别模型。',
      },
    ],
  },
  {
    key: 'ai-audit',
    label: 'AI合规审查',
    children: [
      {
        q: 'AI审查包含哪些检查项？',
        a: '包括：HS编码正确性、申报要素完整性、税率适用、原产地规则合规性、监管条件匹配、许可证要求、CBAM碳排放等。',
      },
      {
        q: '风险等级如何定义？',
        a: '高风险：存在退单或罚款风险；中风险：申报不完整或需补充材料；低风险：基本合规，建议确认。',
      },
    ],
  },
  {
    key: 'api',
    label: 'API集成',
    children: [
      {
        q: '如何获取API密钥？',
        a: '在「API密钥」页面创建AppKey，将Key配置到您的ERP或报关系统中。每个Key有独立的调用频率限制。',
      },
      {
        q: 'API调用限制是多少？',
        a: '试用版：20次/分钟；基础版：50次/分钟；专业版：100次/分钟；企业版：200次/分钟。',
      },
    ],
  },
  {
    key: 'billing',
    label: '计费与订阅',
    children: [
      {
        q: '如何支付？',
        a: '支持微信支付和支付宝。年付享9折优惠。发票可在支付完成后在线申请。',
      },
      {
        q: '试用到期后数据会丢失吗？',
        a: '试用到期后账号冻结，数据保留90天。升级套餐后自动恢复访问。逾期未续费数据将被清除。',
      },
    ],
  },
  {
    key: 'troubleshooting',
    label: '常见问题排查',
    children: [
      {
        q: '忘记密码怎么办？',
        a: '在登录页面点击「忘记密码」，输入注册邮箱即可收到重置链接。如未收到邮件，请检查垃圾邮件箱。',
      },
      {
        q: '页面加载慢怎么办？',
        a: 'AI分析和OCR处理需要一定时间，请耐心等待。如持续卡顿，请检查网络连接或联系技术支持。',
      },
      {
        q: '联系技术支持？',
        a: '企业版用户享有专属技术支持通道。试用用户可通过站内消息或邮箱联系我们：support@customs-saas.com。',
      },
    ],
  },
];

export default function HelpPage() {
  const { token } = theme.useToken();
  const [guideOpen, setGuideOpen] = useState(false);

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <div style={{ marginBottom: 24, textAlign: 'center' }}>
        <QuestionCircleOutlined style={{ fontSize: 48, color: token.colorPrimary }} />
        <Title level={2} style={{ marginTop: 12 }}>帮助中心</Title>
        <Paragraph type="secondary">常见问题与使用指南</Paragraph>
      </div>

      <Card
        title={<span><CompassOutlined style={{ color: '#6366F1' }} /> 报关引导助手</span>}
        style={{ marginBottom: 16 }}
        extra={<Button type="link" icon={<ExportOutlined />} onClick={() => setGuideOpen(true)}>打开引导</Button>}
      >
        <Collapse ghost items={[
          {
            key: 'guide-intro',
            label: <Text strong>跟着 4 步走，小白也能轻松报关</Text>,
            children: (
              <div>
                <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
                  {[
                    { step: 1, title: '填商品信息', desc: '输入商品名称、HS编码、运输方式', color: '#6366F1' },
                    { step: 2, title: 'AI智能归类', desc: 'AI推荐HS编码，对比最优FTA税率', color: '#7C3AED' },
                    { step: 3, title: '合规预检', desc: '自动检查申报要素、监管条件', color: '#10B981' },
                    { step: 4, title: '导出报关单', desc: '生成XML并推送单一窗口', color: '#F59E0B' },
                  ].map(g => (
                    <div key={g.step} style={{
                      flex: 1, textAlign: 'center', padding: 12,
                      background: '#FAFAFA', borderRadius: 10,
                      border: '1px solid #F0F0F0',
                    }}>
                      <div style={{
                        width: 32, height: 32, borderRadius: '50%',
                        background: g.color, color: 'white',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        margin: '0 auto 6px', fontWeight: 700, fontSize: 16,
                      }}>{g.step}</div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{g.title}</div>
                      <div style={{ fontSize: 11, color: '#999' }}>{g.desc}</div>
                    </div>
                  ))}
                </div>
                <div style={{ textAlign: 'center', marginTop: 8 }}>
                  <Button type="primary" icon={<CompassOutlined />}
                    onClick={() => setGuideOpen(true)}>
                    开始引导
                  </Button>
                </div>
              </div>
            ),
          },
          {
            key: 'guide-what',
            label: <Text>报关引导助手是什么？</Text>,
            children: <Paragraph style={{ margin: 0 }}>报关引导助手是一个交互式新手指南，帮助你不漏填、不错填地完成一次报关流程。从商品信息录入到最终的XML导出，每一步都有详细的提示和业务解释。</Paragraph>,
          },
        ]} />
      </Card>

      {faqSections.map(section => (
        <Card key={section.key} title={section.label} style={{ marginBottom: 16 }}>
          <Collapse
            ghost
            items={section.children.map((item, i) => ({
              key: `${section.key}-${i}`,
              label: <Text strong>{item.q}</Text>,
              children: <Paragraph style={{ margin: 0 }}>{item.a}</Paragraph>,
            }))}
          />
        </Card>
      ))}

      <Card style={{ textAlign: 'center', marginTop: 32 }}>
        <Paragraph style={{ margin: 0 }}>
          未找到您的问题？请联系技术支持：<Text code>support@customs-saas.com</Text>
        </Paragraph>
      </Card>

      <Modal
        title={<span><CompassOutlined /> 报关引导助手</span>}
        open={guideOpen}
        onCancel={() => setGuideOpen(false)}
        footer={null}
        width={760}
        style={{ top: 40 }}
        bodyStyle={{ padding: 0 }}
        destroyOnClose
      >
        <iframe
          src="/onboarding-guide.html"
          style={{ width: '100%', height: '80vh', border: 'none', borderRadius: 8 }}
          title="报关引导助手"
        />
      </Modal>
    </div>
  );
}
