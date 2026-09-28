import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Form, Input, Button, Card, Checkbox, message, Modal, Divider, Steps, theme } from 'antd';
import { LEGAL_AGREEMENTS, AGREEMENT_SUMMARIES } from '../utils/legalAgreements';
import api from '../utils/api';

export default function RegisterPage() {
  const [loading, setLoading] = useState(false);
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [agreedPrivacy, setAgreedPrivacy] = useState(false);
  const [agreedIP, setAgreedIP] = useState(false);
  const [modalContent, setModalContent] = useState<{ title: string; content: string } | null>(null);
  const navigate = useNavigate();
  const { token } = theme.useToken();

  const allAgreed = agreedTerms && agreedPrivacy && agreedIP;

  const onFinish = async (values: any) => {
    if (!allAgreed) {
      message.warning('请勾选同意全部三份法务协议后方可注册');
      return;
    }
    setLoading(true);
    try {
      const res = await api.post('/api/auth/register', {
        ...values,
        legalConsents: ['terms_of_service', 'privacy_policy', 'ip_protection'],
      });
      message.success('注册成功！7天全功能企业版试用已自动开通');
      localStorage.setItem('token', res.data.token);
      navigate('/dashboard');
    } catch (err: any) {
      message.error(err.response?.data?.error || '注册失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: token.colorBgLayout, padding: '0 16px' }}>
      <Card title="企业注册 - 开通7天全功能试用" style={{ width: '100%', maxWidth: 560 }}>
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item name="companyName" label="企业全称" rules={[{ required: true, message: '请输入企业营业执照上的全称' }]}>
            <Input placeholder="与营业执照一致" size="large" />
          </Form.Item>

          <Form.Item name="contactName" label="联系人姓名" rules={[{ required: true, message: '请输入联系人姓名' }]}>
            <Input placeholder="企业报关业务负责人" size="large" />
          </Form.Item>

          <Form.Item name="contactPhone" label="联系电话" rules={[{ required: true, message: '请输入联系电话' }]}>
            <Input placeholder="11位手机号码" size="large" />
          </Form.Item>

          <Form.Item name="contactEmail" label="企业邮箱" rules={[
            { required: true, message: '请输入企业邮箱' },
            { type: 'email', message: '请输入有效邮箱地址' },
          ]}>
            <Input placeholder="用于登录和接收通知" size="large" />
          </Form.Item>

          <Form.Item name="password" label="登录密码" rules={[
            { required: true, message: '请设置登录密码' },
            { min: 8, message: '密码至少8位' },
          ]}>
            <Input.Password placeholder="至少8位，含字母和数字" size="large" />
          </Form.Item>

          <Divider plain>法务协议（全部必选）</Divider>
          <p style={{ color: '#999', fontSize: 12, marginBottom: 12 }}>
            请逐项阅读并勾选同意以下全部协议。未全部勾选将无法完成注册。
          </p>

          <div style={{ marginBottom: 8 }}>
            <Checkbox checked={agreedTerms} onChange={e => setAgreedTerms(e.target.checked)}>
              <strong>《用户服务协议》</strong>
              <span style={{ color: '#666', fontSize: 12, marginLeft: 4 }}>
                {AGREEMENT_SUMMARIES.terms_of_service}
              </span>
              <a style={{ marginLeft: 4 }} onClick={() => setModalContent(LEGAL_AGREEMENTS.terms_of_service)}>
                查看详情
              </a>
            </Checkbox>
          </div>

          <div style={{ marginBottom: 8 }}>
            <Checkbox checked={agreedPrivacy} onChange={e => setAgreedPrivacy(e.target.checked)}>
              <strong>《隐私政策》</strong>
              <span style={{ color: '#666', fontSize: 12, marginLeft: 4 }}>
                {AGREEMENT_SUMMARIES.privacy_policy}
              </span>
              <a style={{ marginLeft: 4 }} onClick={() => setModalContent(LEGAL_AGREEMENTS.privacy_policy)}>
                查看详情
              </a>
            </Checkbox>
          </div>

          <div style={{ marginBottom: 16 }}>
            <Checkbox checked={agreedIP} onChange={e => setAgreedIP(e.target.checked)}>
              <strong>《平台知识产权保护协议》</strong>
              <span style={{ color: '#666', fontSize: 12, marginLeft: 4 }}>
                {AGREEMENT_SUMMARIES.ip_protection}
              </span>
              <a style={{ marginLeft: 4 }} onClick={() => setModalContent(LEGAL_AGREEMENTS.ip_protection)}>
                查看详情
              </a>
            </Checkbox>
          </div>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block size="large"
              disabled={!allAgreed}>
              {allAgreed ? '同意协议并注册，开通7天全功能试用' : '请先勾选同意全部法务协议'}
            </Button>
          </Form.Item>

          <div style={{ textAlign: 'center' }}>
            已有账号？<Link to="/login">立即登录</Link>
          </div>
        </Form>

        <Modal
          title={modalContent?.title}
          open={!!modalContent}
          onCancel={() => setModalContent(null)}
          footer={<Button onClick={() => setModalContent(null)}>已阅读</Button>}
          width="min(700px, 95vw)"
        >
          <div style={{ maxHeight: 500, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.8 }}>
            {modalContent?.content}
          </div>
        </Modal>
      </Card>
    </div>
  );
}
