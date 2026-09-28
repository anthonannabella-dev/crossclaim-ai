import { useState, useEffect } from 'react';
import { Input, Card, Table, Tag, Modal, Descriptions, Select, Space, Typography, message, Tree, Row, Col, Button } from 'antd';
import { SearchOutlined, HistoryOutlined, ClearOutlined } from '@ant-design/icons';
import type { DataNode } from 'antd/es/tree';
import api from '../utils/api';

const { Text } = Typography;

const CATEGORY_COLORS: Record<string, string> = {
  '农产品': 'green', '水产品': 'cyan', '矿产品': 'orange',
  '化工品': 'purple', '塑料橡胶': 'geekblue', '纺织品': 'blue',
  '金属制品': 'red', '机电设备': 'volcano', '运输设备': 'magenta',
  '精密仪器': 'gold', '食品饮料': 'lime', '动植物油脂': 'green',
};

// HS 章节分类导航
const CHAPTER_GROUPS: { title: string; chapters: string }[] = [
  { title: '活动物；动物产品', chapters: '01,02,03,04,05' },
  { title: '植物产品', chapters: '06,07,08,09,10,11,12,13,14' },
  { title: '动、植物油、脂及其分解产品', chapters: '15' },
  { title: '食品；饮料、酒及醋', chapters: '16,17,18,19,20,21,22,23,24' },
  { title: '矿产品', chapters: '25,26,27' },
  { title: '化学工业及其相关工业的产品', chapters: '28,29,30,31,32,33,34,35,36,37,38' },
  { title: '塑料及其制品；橡胶及其制品', chapters: '39,40' },
  { title: '皮革及其制品', chapters: '41,42,43' },
  { title: '木及木制品', chapters: '44,45,46' },
  { title: '木浆及其他纤维状纤维素浆', chapters: '47,48,49' },
  { title: '纺织原料及纺织制品', chapters: '50,51,52,53,54,55,56,57,58,59,60,61,62,63' },
  { title: '鞋、帽、伞、杖、鞭及其零件', chapters: '64,65,66,67' },
  { title: '石料、石膏、水泥、石棉、云母', chapters: '68,69,70' },
  { title: '珍珠、宝石、贵金属、包贵金属', chapters: '71' },
  { title: '贱金属及其制品', chapters: '72,73,74,75,76,78,79,80,81,82,83' },
  { title: '机器、机械器具、电气设备', chapters: '84,85' },
  { title: '车辆、航空器、船舶及有关运输设备', chapters: '86,87,88,89' },
  { title: '光学、照相、医疗等设备', chapters: '90,91,92' },
  { title: '武器、弹药', chapters: '93' },
  { title: '杂项制品', chapters: '94,95,96' },
  { title: '艺术品、收藏品及古物', chapters: '97' },
];

interface HSCodeItem {
  id: string;
  code: string;
  description: string;
  unit: string | null;
  category: string | null;
  tariffRate: number | null;
  exportRate: number | null;
  vatRate: number | null;
  exciseRate: number | null;
  supervision: string | null;
}

export default function HSCodePage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HSCodeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<HSCodeItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | undefined>();
  const [supervisionFilter, setSupervisionFilter] = useState<string | undefined>();
  const [minTariff, setMinTariff] = useState<number | undefined>();
  const [maxTariff, setMaxTariff] = useState<number | undefined>();
  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('hs_search_history') || '[]'); }
    catch { return []; }
  });
  const [selectedChapter, setSelectedChapter] = useState<string | undefined>();

  // 最近查询记录
  useEffect(() => {
    localStorage.setItem('hs_search_history', JSON.stringify(searchHistory.slice(0, 20)));
  }, [searchHistory]);

  const addToHistory = (term: string) => {
    setSearchHistory(prev => [term, ...prev.filter(h => h !== term)].slice(0, 20));
  };

  const handleSearch = async (value: string) => {
    const searchVal = (value || '').trim();
    if (!searchVal) { message.info('请输入商品名称或HS编码'); return; }
    setQuery(searchVal);
    setLoading(true);
    setSelectedChapter(undefined);
    addToHistory(searchVal);
    try {
      const res = await api.get('/api/hscode/search', { params: { q: searchVal } });
      setResults(res.data);
    } finally {
      setLoading(false);
    }
  };

  // 按章节查询
  const handleChapterClick = async (chapters: string) => {
    setSelectedChapter(chapters);
    setLoading(true);
    setCategoryFilter(undefined);
    try {
      // 按章节前缀搜索
      const chap = chapters.split(',')[0].trim();
      const res = await api.get('/api/hscode/search', { params: { q: chap } });
      setResults(res.data);
      if (res.data.length > 0) {
        setQuery(`第${chap}章`);
        addToHistory(`第${chap}章`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleViewDetail = async (code: string) => {
    try {
      const res = await api.get(`/api/hscode/${code}`);
      setDetail(res.data);
      setDetailOpen(true);
    } catch { /* */ }
  };

  // 过滤
  const categories = [...new Set(results.map(r => r.category).filter(Boolean))] as string[];
  const supervisions = [...new Set(results.map(r => r.supervision).filter(Boolean))] as string[];

  let filtered = results;
  if (categoryFilter) filtered = filtered.filter(r => r.category === categoryFilter);
  if (supervisionFilter) filtered = filtered.filter(r => r.supervision === supervisionFilter);
  if (minTariff != null) filtered = filtered.filter(r => (r.tariffRate ?? 999) >= minTariff);
  if (maxTariff != null) filtered = filtered.filter(r => (r.tariffRate ?? 0) <= maxTariff);

  // 树形导航
  const treeData: DataNode[] = CHAPTER_GROUPS.map(g => ({
    title: g.title,
    key: g.chapters,
    children: g.chapters.split(',').map(ch => ({
      title: `第${ch}章`,
      key: ch,
      isLeaf: true,
    })),
  }));

  const columns = [
    { title: 'HS编码', dataIndex: 'code', key: 'code', width: 110,
      render: (v: string) => <a onClick={() => handleViewDetail(v)}>{v}</a> },
    { title: '描述', dataIndex: 'description', key: 'description', ellipsis: true },
    { title: '单位', dataIndex: 'unit', key: 'unit', width: 60 },
    { title: '品类', dataIndex: 'category', key: 'category', width: 100,
      render: (v: string) => v ? <Tag color={CATEGORY_COLORS[v] || 'default'}>{v}</Tag> : '-' },
    { title: '最惠国', dataIndex: 'tariffRate', key: 'tariffRate', width: 80,
      render: (v: number) => v != null ? <Tag color="blue">{v}%</Tag> : '-' },
    { title: '退税率', dataIndex: 'exportRate', key: 'exportRate', width: 80,
      render: (v: number) => v != null ? <Tag color="green">{v}%</Tag> : '-' },
    { title: '增值税', dataIndex: 'vatRate', key: 'vatRate', width: 70,
      render: (v: number) => v != null ? <Tag color="orange">{v}%</Tag> : '-' },
    { title: '消费税', dataIndex: 'exciseRate', key: 'exciseRate', width: 70,
      render: (v: number) => v != null ? <Tag color="red">{v}%</Tag> : '-' },
    { title: '监管条件', dataIndex: 'supervision', key: 'supervision', width: 100,
      render: (v: string) => v ? <Tag>{v}</Tag> : '-' },
  ];

  return (
    <div style={{ padding: 18 }}>
      <h2>HS编码查询</h2>

      <Row gutter={[16, 16]}>
        {/* 左侧：分类导航 */}
        <Col xs={24} md={6}>
          <Card title="HS分类导航" size="small" style={{ height: 'calc(100vh - 180px)', overflow: 'auto' }}>
            <Tree
              treeData={treeData}
              defaultExpandAll={false}
              onSelect={(keys) => {
                if (keys.length > 0) handleChapterClick(keys[0] as string);
              }}
              selectedKeys={selectedChapter ? [selectedChapter] : []}
            />
          </Card>
        </Col>

        {/* 右侧：搜索+结果 */}
        <Col xs={24} md={18}>
          {/* 搜索栏 */}
          <Card style={{ marginBottom: 12 }} size="small">
            <Space wrap>
              <Input.Search placeholder="输入商品名称或HS编码" onSearch={handleSearch}
                style={{ width: 320 }} loading={loading} allowClear
                onClear={() => { setResults([]); setCategoryFilter(undefined); setSupervisionFilter(undefined); setSelectedChapter(undefined); }} />
              {categories.length > 0 && (
                <Select placeholder="品类" value={categoryFilter} onChange={setCategoryFilter}
                  allowClear style={{ width: 130 }}>
                  {categories.map(c => <Select.Option key={c} value={c}>
                    <Tag color={CATEGORY_COLORS[c] || 'default'} style={{ marginRight: 0 }}>{c}</Tag>
                  </Select.Option>)}
                </Select>
              )}
              {supervisions.length > 0 && (
                <Select placeholder="监管条件" value={supervisionFilter} onChange={setSupervisionFilter}
                  allowClear style={{ width: 130 }}>
                  {supervisions.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
                </Select>
              )}
              <Input placeholder="最低税率" type="number" style={{ width: 100 }}
                value={minTariff} onChange={e => setMinTariff(e.target.value ? Number(e.target.value) : undefined)} />
              <Text type="secondary">~</Text>
              <Input placeholder="最高税率" type="number" style={{ width: 100 }}
                value={maxTariff} onChange={e => setMaxTariff(e.target.value ? Number(e.target.value) : undefined)} />
            </Space>

            {/* 最近查询 */}
            {searchHistory.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <Space size={[4, 4]} wrap>
                  <HistoryOutlined style={{ color: '#999' }} />
                  {searchHistory.slice(0, 8).map((h, i) => (
                    <Tag key={i} style={{ cursor: 'pointer' }} onClick={() => handleSearch(h)}>{h}</Tag>
                  ))}
                  <Button type="link" size="small" icon={<ClearOutlined />}
                    onClick={() => { setSearchHistory([]); localStorage.removeItem('hs_search_history'); }}>
                    清空
                  </Button>
                </Space>
              </div>
            )}

            {results.length > 0 && (
              <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                共 {results.length} 条结果{categoryFilter ? `，品类 "${categoryFilter}" 匹配 ${filtered.length} 条` : ''}
                {filtered.length !== results.length ? `，筛选后 ${filtered.length} 条` : ''}
              </Text>
            )}
          </Card>

          {/* 结果表格 */}
          <Table dataSource={filtered} columns={columns} rowKey="id" loading={loading}
            scroll={{ x: 800 }} pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }} size="small" />

          {/* 详情弹窗 */}
          <Modal title="HS编码详情" open={detailOpen} onCancel={() => setDetailOpen(false)} footer={null} width={560}>
            {detail && (
              <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
                <Descriptions.Item label="HS编码">{detail.code}</Descriptions.Item>
                <Descriptions.Item label="单位">{detail.unit || '-'}</Descriptions.Item>
                <Descriptions.Item label="品类">
                  {detail.category ? <Tag color={CATEGORY_COLORS[detail.category] || 'default'}>{detail.category}</Tag> : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="最惠国税率">
                  {detail.tariffRate != null ? <Tag color="blue">{detail.tariffRate}%</Tag> : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="出口退税率">
                  {detail.exportRate != null ? <Tag color="green">{detail.exportRate}%</Tag> : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="增值税率">
                  {detail.vatRate != null ? <Tag color="orange">{detail.vatRate}%</Tag> : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="消费税">
                  {detail.exciseRate != null ? <Tag color="red">{detail.exciseRate}%</Tag> : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="监管条件">{detail.supervision || '-'}</Descriptions.Item>
                <Descriptions.Item label="描述" span={2}>{detail.description}</Descriptions.Item>
                <Descriptions.Item label="章节">{detail.code?.split('.')[0]}</Descriptions.Item>
              </Descriptions>
            )}
          </Modal>
        </Col>
      </Row>
    </div>
  );
}
