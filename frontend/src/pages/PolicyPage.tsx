import { useEffect, useState } from 'react';
import {
  Card, List, Tag, Select, Input, Space, Empty, Badge, Row, Col,
  Statistic, Button, message, Alert, theme, Modal, Switch, Tooltip, Divider,
} from 'antd';
import {
  SearchOutlined, SoundOutlined, AlertOutlined, WarningOutlined,
  InfoCircleOutlined, RobotOutlined, SettingOutlined,
  GlobalOutlined, HomeOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import api from '../utils/api';

const categoryColors: Record<string, string> = {
  customs: 'blue', tariff: 'orange', rcep: 'green',
  cbam: 'red', origin: 'purple', export: 'magenta',
};

const categoryLabels: Record<string, string> = {
  customs: '海关政策', tariff: '关税调整', rcep: 'RCEP规则',
  cbam: '碳关税', origin: '原产地', export: '出口管制',
};

const impactConfig: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  HIGH: { color: '#ff4d4f', icon: <AlertOutlined />, label: '高影响' },
  MEDIUM: { color: '#faad14', icon: <WarningOutlined />, label: '中影响' },
  LOW: { color: '#52c41a', icon: <InfoCircleOutlined />, label: '低影响' },
};

const sourceTypeConfig: Record<string, { color: string; label: string }> = {
  NATIONAL: { color: 'purple', label: '全国性' },
  LOCAL: { color: 'cyan', label: '地方性' },
};

// 常用HS章节选项
const HS_CHAPTER_OPTIONS = [
  { value: '01-05', label: '01-05 动物产品' },
  { value: '06-14', label: '06-14 植物产品' },
  { value: '15', label: '15 动/植物油' },
  { value: '16-24', label: '16-24 食品饮料' },
  { value: '25-27', label: '25-27 矿产品' },
  { value: '28-38', label: '28-38 化工产品' },
  { value: '39-40', label: '39-40 塑料/橡胶' },
  { value: '41-43', label: '41-43 皮革制品' },
  { value: '44-46', label: '44-46 木制品' },
  { value: '47-49', label: '47-49 纸浆/纸制品' },
  { value: '50-63', label: '50-63 纺织/服装' },
  { value: '64-67', label: '64-67 鞋帽伞杖' },
  { value: '68-70', label: '68-70 石/水泥/玻璃' },
  { value: '71', label: '71 珠宝/贵金属' },
  { value: '72-83', label: '72-83 贱金属制品' },
  { value: '84-85', label: '84-85 机电设备' },
  { value: '86-89', label: '86-89 车辆/航空/船舶' },
  { value: '90-92', label: '90-92 光学/医疗/钟表' },
  { value: '93', label: '93 武器弹药' },
  { value: '94-96', label: '94-96 杂项制品' },
  { value: '97', label: '97 艺术品/收藏品' },
];

export default function PolicyPage() {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [categories, setCategories] = useState<{ value: string; label: string }[]>([]);
  const [ports, setPorts] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState<string | undefined>();
  const [portCode, setPortCode] = useState<string | undefined>();
  const [sourceType, setSourceType] = useState<string | undefined>();
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [summarizing, setSummarizing] = useState(false);
  const { token: themeToken } = theme.useToken();

  // 用户业务配置
  const [configOpen, setConfigOpen] = useState(false);
  const [myPorts, setMyPorts] = useState<string[]>([]);
  const [myHsCodes, setMyHsCodes] = useState<string[]>([]);
  const [savingConfig, setSavingConfig] = useState(false);
  const [onlyRelevant, setOnlyRelevant] = useState(true);

  const fetchAlerts = async () => {
    setLoading(true);
    try {
      const params: any = {};
      if (category) params.category = category;
      if (portCode) params.portCode = portCode;
      if (sourceType) params.sourceType = sourceType;
      if (keyword) params.keyword = keyword;
      if (onlyRelevant) {
        // 加载关联推送
        const res = await api.get('/api/policy/my-feed');
        setAlerts(res.data);
      } else {
        const res = await api.get('/api/policy/alerts', { params });
        setAlerts(res.data);
      }
      if (alerts.length === 0 && !selected) setSelected(null);
    } catch {
      message.error('加载失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchCategories = async () => {
    try { const res = await api.get('/api/policy/categories'); setCategories(res.data); } catch { }
  };

  const fetchPorts = async () => {
    try { const res = await api.get('/api/policy/ports'); setPorts(res.data); } catch { }
  };

  const fetchStats = async () => {
    try { const res = await api.get('/api/policy/stats'); setStats(res.data); } catch { }
  };

  const fetchMyConfig = async () => {
    try {
      const res = await api.get('/api/policy/my-config');
      setMyPorts(res.data.preferredPorts || []);
      setMyHsCodes(res.data.hsCodeRanges || []);
    } catch { }
  };

  const saveMyConfig = async () => {
    setSavingConfig(true);
    try {
      await api.put('/api/policy/my-config', {
        preferredPorts: myPorts,
        hsCodeRanges: myHsCodes,
      });
      message.success('业务配置已保存，系统将按此过滤政策推送');
      setConfigOpen(false);
      fetchAlerts();
    } catch (err: any) {
      message.error(err.response?.data?.error || '保存失败');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleSummarize = async () => {
    if (!selected) return;
    setSummarizing(true);
    try {
      const res = await api.post(`/api/policy/summarize/${selected.id}`);
      setSelected(res.data);
      setAlerts(prev => prev.map(a => a.id === res.data.id ? res.data : a));
      message.success('AI摘要生成成功');
    } catch (err: any) {
      message.error(err.response?.data?.error || 'AI摘要生成失败');
    } finally {
      setSummarizing(false);
    }
  };

  useEffect(() => {
    fetchCategories();
    fetchPorts();
    fetchStats();
    fetchMyConfig();
  }, []);
  useEffect(() => { fetchAlerts(); }, [category, portCode, sourceType, onlyRelevant]);

  // 判断是否与用户业务相关
  const isRelevant = (item: any): boolean => {
    if (myPorts.length === 0 && myHsCodes.length === 0) return false;
    if (item.sourceType === 'NATIONAL' && item.impactLevel === 'HIGH') return true;
    if (item.portCode && myPorts.includes(item.portCode)) return true;
    if (item.affectedHsCodes && myHsCodes.length > 0) {
      const policyHs = item.affectedHsCodes.split(',').map((h: string) => h.trim());
      return myHsCodes.some((u: string) => policyHs.some((p: string) => u.startsWith(p)));
    }
    return false;
  };

  return (
    <div>
      {/* 顶部标题 + 配置按钮 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}><SoundOutlined /> 法规变化追踪</h2>
        <Space>
          <Switch
            checkedChildren="关联推送" unCheckedChildren="全部政策"
            checked={onlyRelevant} onChange={setOnlyRelevant}
          />
          <Button icon={<SettingOutlined />} onClick={() => setConfigOpen(true)}>
            我的业务配置
          </Button>
        </Space>
      </div>

      {/* 统计卡片 */}
      {stats && (
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic title="政策总量" value={stats.total} prefix={<span style={{ fontSize: 16 }}>📋</span>} />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic title="高影响" value={stats.highImpact} valueStyle={{ color: '#ff4d4f' }}
                prefix={<AlertOutlined />} />
            </Card>
          </Col>
          <Col xs={24} sm={6}>
            <Card size="small">
              <Statistic title={<>全国性 <GlobalOutlined /></>}
                value={stats.bySourceType?.find((s: any) => s.sourceType === 'NATIONAL')?.count || 0}
                valueStyle={{ color: '#722ed1' }} />
            </Card>
          </Col>
          <Col xs={24} sm={6}>
            <Card size="small">
              <Statistic title={<>地方性 <HomeOutlined /></>}
                value={stats.bySourceType?.find((s: any) => s.sourceType === 'LOCAL')?.count || 0}
                valueStyle={{ color: '#13c2c2' }} />
            </Card>
          </Col>
        </Row>
      )}

      {/* 筛选栏 */}
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="全部分类" allowClear style={{ width: 140 }}
          value={category} onChange={(v) => { setCategory(v); setSelected(null); }}
          options={categories}
        />
        <Select
          placeholder="全部口岸" allowClear style={{ width: 160 }}
          value={portCode} onChange={(v) => { setPortCode(v); setSelected(null); }}
          options={[
            { value: 'NATIONAL', label: '仅全国性政策', type: 'type' },
            ...ports.map(p => ({ value: p.value, label: p.label })),
          ]}
        />
        <Select
          placeholder="政策类型" allowClear style={{ width: 130 }}
          value={sourceType} onChange={(v) => { setSourceType(v); setSelected(null); }}
          options={[
            { value: 'NATIONAL', label: '全国性' },
            { value: 'LOCAL', label: '地方性' },
          ]}
        />
        <Input.Search
          placeholder="搜索法规标题或内容" allowClear style={{ width: 320 }}
          value={keyword} onChange={(e) => setKeyword(e.target.value)}
          onSearch={fetchAlerts} enterButton={<SearchOutlined />}
        />
      </Space>

      {/* 主体：列表 + 详情 */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <Card style={{ flex: 1, maxWidth: 420, minWidth: 280 }}
          styles={{ body: { padding: 0 } }}>
          <List
            loading={loading}
            dataSource={alerts}
            locale={{ emptyText: <Empty description={onlyRelevant ? '暂无关联推送，请先设置业务配置' : '暂无法规预警'} /> }}
            renderItem={(item: any) => {
              const relevant = isRelevant(item);
              return (
                <List.Item
                  onClick={() => setSelected(item)}
                  style={{
                    padding: '12px 16px', cursor: 'pointer',
                    background: selected?.id === item.id ? themeToken.colorPrimaryBg : undefined,
                    borderLeft: selected?.id === item.id ? `3px solid ${themeToken.colorPrimary}` : '3px solid transparent',
                  }}
                >
                  <List.Item.Meta
                    title={
                      <Space size={4} wrap>
                        <Tag color={categoryColors[item.category]} style={{ fontSize: 11, lineHeight: '18px' }}>
                          {categoryLabels[item.category] || item.category}
                        </Tag>
                        <Tag color={sourceTypeConfig[item.sourceType]?.color} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                          {sourceTypeConfig[item.sourceType]?.label || item.sourceType}
                        </Tag>
                        {item.impactLevel && (
                          <Badge color={impactConfig[item.impactLevel]?.color} title={impactConfig[item.impactLevel]?.label} />
                        )}
                        {relevant && (
                          <Tag color="green" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                            <CheckCircleOutlined /> 与我相关
                          </Tag>
                        )}
                        <span style={{ fontSize: 13 }}>{item.title}</span>
                      </Space>
                    }
                    description={
                      <span style={{ fontSize: 12, color: themeToken.colorTextSecondary }}>
                        {item.portCode && `${PORT_LABELS[item.portCode] || item.portCode} · `}
                        {item.source} · {new Date(item.publishDate).toLocaleDateString('zh-CN')}
                        {item.hsCode && <Tag style={{ marginLeft: 6 }}>HS: {item.hsCode}</Tag>}
                      </span>
                    }
                  />
                </List.Item>
              );
            }}
          />
        </Card>

        {/* 详情面板 */}
        <Card style={{ flex: 1.6, minWidth: 360 }} styles={{ body: { minHeight: 360 } }}>
          {selected ? (
            <div>
              <Space style={{ marginBottom: 12 }} wrap>
                <Tag color={categoryColors[selected.category]}>
                  {categoryLabels[selected.category] || selected.category}
                </Tag>
                <Tag color={sourceTypeConfig[selected.sourceType]?.color}>
                  {sourceTypeConfig[selected.sourceType]?.label || selected.sourceType}
                </Tag>
                {selected.portCode && (
                  <Tag color="cyan">{PORT_LABELS[selected.portCode] || selected.portCode}</Tag>
                )}
                {selected.impactLevel && (
                  <Tag color={impactConfig[selected.impactLevel]?.color}>
                    {impactConfig[selected.impactLevel]?.icon} {impactConfig[selected.impactLevel]?.label}
                  </Tag>
                )}
                {selected.affectedHsCodes && (
                  <Tag color="geekblue">受影响HS: {selected.affectedHsCodes}</Tag>
                )}
                <span style={{ color: themeToken.colorTextSecondary, fontSize: 12 }}>
                  {selected.source} · {new Date(selected.publishDate).toLocaleDateString('zh-CN')}
                </span>
              </Space>

              <h3>{selected.title}</h3>

              {!selected.summary && !selected.impactLevel && (
                <Button
                  type="dashed" icon={<RobotOutlined />} loading={summarizing}
                  onClick={handleSummarize} style={{ marginBottom: 12 }}
                >
                  AI 生成摘要 & 影响评级
                </Button>
              )}
              {selected.summary && (
                <Button
                  type="link" size="small" icon={<RobotOutlined />} loading={summarizing}
                  onClick={handleSummarize} style={{ marginBottom: 8, padding: 0 }}
                >
                  重新生成AI摘要
                </Button>
              )}

              {selected.summary && (
                <Alert type="warning" message="AI摘要" description={selected.summary}
                  style={{ marginBottom: 16 }} />
              )}

              {selected.actionRequired && (
                <Alert type="success" message="建议行动" description={selected.actionRequired}
                  style={{ marginBottom: 16 }} />
              )}

              <div style={{
                background: themeToken.colorFillAlter, padding: 16, borderRadius: 8,
                whiteSpace: 'pre-wrap', lineHeight: 1.8, fontSize: 14,
                maxHeight: 400, overflow: 'auto',
              }}>
                {selected.content || '暂无正文内容'}
              </div>
            </div>
          ) : (
            <Empty description="选择左侧法规查看详情" />
          )}
        </Card>
      </div>

      {/* ─── 业务配置弹窗 ─── */}
      <Modal
        title={<><SettingOutlined /> 我的业务配置</>}
        open={configOpen}
        onCancel={() => setConfigOpen(false)}
        onOk={saveMyConfig}
        confirmLoading={savingConfig}
        okText="保存配置"
        width={640}
      >
        <Alert
          type="info"
          message="设置你常用的通关口岸和主营商品HS编码后，系统会自动过滤与你业务相关的政策变更推送给你。"
          style={{ marginBottom: 16 }}
          showIcon
        />

        <Divider orientation="left" plain>常用通关口岸</Divider>
        <p style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
          选择你经常报关的口岸，该口岸的海关本地执行口径变化会优先推送
        </p>
        <Select
          mode="multiple"
          placeholder="选择常用口岸"
          style={{ width: '100%' }}
          value={myPorts}
          onChange={setMyPorts}
          options={ports}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>
          已选 {myPorts.length} 个口岸
        </div>

        <Divider orientation="left" plain style={{ marginTop: 24 }}>主营商品HS编码章节</Divider>
        <p style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
          选择你主要的HS编码章节，涉及这些章节的关税调整/监管变化会优先推送
        </p>
        <Select
          mode="multiple"
          placeholder="选择HS章节"
          style={{ width: '100%' }}
          value={myHsCodes}
          onChange={setMyHsCodes}
          options={HS_CHAPTER_OPTIONS}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>
          已选 {myHsCodes.length} 个HS章节范围
        </div>

        {myPorts.length === 0 && myHsCodes.length === 0 && (
          <Alert
            type="warning"
            message="尚未配置任何业务偏好，系统将仅推送全国性高影响政策"
            style={{ marginTop: 16 }}
            showIcon
          />
        )}
      </Modal>
    </div>
  );
}

const PORT_LABELS: Record<string, string> = {
  shanghai: '上海海关', shenzhen: '深圳海关', ningbo: '宁波海关',
  guangzhou: '广州海关', qingdao: '青岛海关', tianjin: '天津海关',
  huangpu: '黄埔海关', xiamen: '厦门海关', dalian: '大连海关', beijing: '北京海关',
};
