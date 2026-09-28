import { useEffect, useState } from 'react';
import { Input, Card, Descriptions, Select, Button, Alert, Tag, Tabs, Table, InputNumber } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import api from '../utils/api';

export default function RCEPPage() {
  const [hsCode, setHsCode] = useState('');
  const [country, setCountry] = useState('');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<any[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [ruleSearch, setRuleSearch] = useState('');

  const fetchRules = async () => {
    setRulesLoading(true);
    try {
      const res = await api.get('/api/rcep/rules');
      setRules(res.data);
    } finally {
      setRulesLoading(false);
    }
  };

  useEffect(() => { fetchRules(); }, []);

  const handleCalculate = async () => {
    if (!hsCode || !country) return;
    setLoading(true);
    try {
      const res = await api.post('/api/rcep/calculate', { hsCode, destinationCountry: country });
      setResult(res.data);
    } finally {
      setLoading(false);
    }
  };

  const filteredRules = rules.filter(r =>
    !ruleSearch || r.productCode.includes(ruleSearch) || r.originCriteria?.includes(ruleSearch)
  );

  const ruleColumns = [
    { title: 'HS编码', dataIndex: 'productCode', key: 'productCode', width: 120 },
    { title: '原产地规则', dataIndex: 'originCriteria', key: 'originCriteria', ellipsis: true },
    {
      title: '关税减免', dataIndex: 'tariffReduction', key: 'tariffReduction', width: 100,
      render: (v: number | null) => v != null ? <Tag color="green">{v}%</Tag> : '-',
    },
    {
      title: '生效日期', dataIndex: 'effectiveDate', key: 'effectiveDate', width: 120,
      render: (v: string | null) => v ? new Date(v).toLocaleDateString('zh-CN') : '-',
    },
    { title: '来源', dataIndex: 'source', key: 'source', width: 120, render: (v: string) => <Tag>{v}</Tag> },
  ];

  const countryCodeToName: Record<string, string> = {
    US: '美国', JP: '日本', KR: '韩国', VN: '越南', DE: '德国', RU: '俄罗斯', AU: '澳大利亚',
    MY: '马来西亚', BR: '巴西', IN: '印度', GB: '英国', TH: '泰国', SA: '沙特阿拉伯',
    FR: '法国', NL: '荷兰',
  };

  return (
    <div>
      <h2>RCEP原产地智能判定 & 最优关税核算</h2>

      <Tabs defaultActiveKey="calculate" items={[
        {
          key: 'calculate',
          label: '关税核算',
          children: (
            <>
              <Card style={{ marginBottom: 16 }}>
                <Input placeholder="HS编码 (必填)" value={hsCode} onChange={e => setHsCode(e.target.value)}
                  style={{ width: 180, marginRight: 8, marginBottom: 8 }} />
                <Select placeholder="搜索国家" value={country || undefined} onChange={setCountry}
                  style={{ width: 240, marginRight: 8, marginBottom: 8 }}
                  showSearch
                  optionFilterProp="label"
                  filterOption={(input, option) => (option?.label as string ?? '').includes(input)}
                  filterSort={(a, b) => 0}
                >
                  <Select.OptGroup label="★ 常用 · 主要贸易国">
                    <Select.Option value="US">美国</Select.Option>
                    <Select.Option value="JP">日本</Select.Option>
                    <Select.Option value="KR">韩国</Select.Option>
                    <Select.Option value="VN">越南</Select.Option>
                    <Select.Option value="DE">德国</Select.Option>
                    <Select.Option value="RU">俄罗斯</Select.Option>
                    <Select.Option value="AU">澳大利亚</Select.Option>
                    <Select.Option value="MY">马来西亚</Select.Option>
                    <Select.Option value="BR">巴西</Select.Option>
                    <Select.Option value="IN">印度</Select.Option>
                    <Select.Option value="GB">英国</Select.Option>
                    <Select.Option value="TH">泰国</Select.Option>
                    <Select.Option value="SA">沙特阿拉伯</Select.Option>
                    <Select.Option value="FR">法国</Select.Option>
                    <Select.Option value="NL">荷兰</Select.Option>
                  </Select.OptGroup>
                  <Select.OptGroup label="RCEP 亚太">
                    <Select.Option value="SG">新加坡</Select.Option>
                    <Select.Option value="ID">印度尼西亚</Select.Option>
                    <Select.Option value="PH">菲律宾</Select.Option>
                    <Select.Option value="NZ">新西兰</Select.Option>
                    <Select.Option value="KH">柬埔寨</Select.Option>
                    <Select.Option value="MM">缅甸</Select.Option>
                    <Select.Option value="LA">老挝</Select.Option>
                    <Select.Option value="BN">文莱</Select.Option>
                  </Select.OptGroup>
                  <Select.OptGroup label="北美">
                    <Select.Option value="CA">加拿大</Select.Option>
                    <Select.Option value="MX">墨西哥</Select.Option>
                    <Select.Option value="PA">巴拿马</Select.Option>
                    <Select.Option value="DO">多米尼加</Select.Option>
                    <Select.Option value="GT">危地马拉</Select.Option>
                    <Select.Option value="CR">哥斯达黎加</Select.Option>
                    <Select.Option value="HN">洪都拉斯</Select.Option>
                    <Select.Option value="CU">古巴</Select.Option>
                    <Select.Option value="SV">萨尔瓦多</Select.Option>
                    <Select.Option value="JM">牙买加</Select.Option>
                    <Select.Option value="NI">尼加拉瓜</Select.Option>
                    <Select.Option value="BS">巴哈马</Select.Option>
                  </Select.OptGroup>
                  <Select.OptGroup label="欧盟">
                    <Select.Option value="IT">意大利</Select.Option>
                    <Select.Option value="ES">西班牙</Select.Option>
                    <Select.Option value="BE">比利时</Select.Option>
                    <Select.Option value="PL">波兰</Select.Option>
                    <Select.Option value="IE">爱尔兰</Select.Option>
                    <Select.Option value="SE">瑞典</Select.Option>
                    <Select.Option value="AT">奥地利</Select.Option>
                    <Select.Option value="DK">丹麦</Select.Option>
                    <Select.Option value="FI">芬兰</Select.Option>
                    <Select.Option value="CZ">捷克</Select.Option>
                    <Select.Option value="HU">匈牙利</Select.Option>
                    <Select.Option value="GR">希腊</Select.Option>
                    <Select.Option value="RO">罗马尼亚</Select.Option>
                    <Select.Option value="PT">葡萄牙</Select.Option>
                    <Select.Option value="LU">卢森堡</Select.Option>
                    <Select.Option value="SK">斯洛伐克</Select.Option>
                    <Select.Option value="BG">保加利亚</Select.Option>
                    <Select.Option value="SI">斯洛文尼亚</Select.Option>
                    <Select.Option value="LT">立陶宛</Select.Option>
                    <Select.Option value="HR">克罗地亚</Select.Option>
                    <Select.Option value="LV">拉脱维亚</Select.Option>
                    <Select.Option value="EE">爱沙尼亚</Select.Option>
                    <Select.Option value="MT">马耳他</Select.Option>
                    <Select.Option value="CY">塞浦路斯</Select.Option>
                  </Select.OptGroup>
                  <Select.OptGroup label="欧洲其他">
                    <Select.Option value="CH">瑞士</Select.Option>
                    <Select.Option value="NO">挪威</Select.Option>
                    <Select.Option value="UA">乌克兰</Select.Option>
                    <Select.Option value="BY">白俄罗斯</Select.Option>
                    <Select.Option value="RS">塞尔维亚</Select.Option>
                    <Select.Option value="IS">冰岛</Select.Option>
                    <Select.Option value="GE">格鲁吉亚</Select.Option>
                    <Select.Option value="AZ">阿塞拜疆</Select.Option>
                    <Select.Option value="AM">亚美尼亚</Select.Option>
                    <Select.Option value="MD">摩尔多瓦</Select.Option>
                    <Select.Option value="BA">波黑</Select.Option>
                    <Select.Option value="AL">阿尔巴尼亚</Select.Option>
                    <Select.Option value="MK">北马其顿</Select.Option>
                    <Select.Option value="ME">黑山</Select.Option>
                  </Select.OptGroup>
                  <Select.OptGroup label="南美">
                    <Select.Option value="CL">智利</Select.Option>
                    <Select.Option value="AR">阿根廷</Select.Option>
                    <Select.Option value="PE">秘鲁</Select.Option>
                    <Select.Option value="CO">哥伦比亚</Select.Option>
                    <Select.Option value="EC">厄瓜多尔</Select.Option>
                    <Select.Option value="VE">委内瑞拉</Select.Option>
                    <Select.Option value="UY">乌拉圭</Select.Option>
                    <Select.Option value="PY">巴拉圭</Select.Option>
                    <Select.Option value="BO">玻利维亚</Select.Option>
                    <Select.Option value="SR">苏里南</Select.Option>
                    <Select.Option value="GY">圭亚那</Select.Option>
                  </Select.OptGroup>
                  <Select.OptGroup label="一带一路 · 中东">
                    <Select.Option value="AE">阿联酋</Select.Option>
                    <Select.Option value="IR">伊朗</Select.Option>
                    <Select.Option value="IQ">伊拉克</Select.Option>
                    <Select.Option value="TR">土耳其</Select.Option>
                    <Select.Option value="IL">以色列</Select.Option>
                    <Select.Option value="QA">卡塔尔</Select.Option>
                    <Select.Option value="KW">科威特</Select.Option>
                    <Select.Option value="OM">阿曼</Select.Option>
                    <Select.Option value="JO">约旦</Select.Option>
                    <Select.Option value="BH">巴林</Select.Option>
                    <Select.Option value="LB">黎巴嫩</Select.Option>
                    <Select.Option value="SY">叙利亚</Select.Option>
                    <Select.Option value="YE">也门</Select.Option>
                  </Select.OptGroup>
                  <Select.OptGroup label="南亚">
                    <Select.Option value="PK">巴基斯坦</Select.Option>
                    <Select.Option value="BD">孟加拉国</Select.Option>
                    <Select.Option value="LK">斯里兰卡</Select.Option>
                    <Select.Option value="NP">尼泊尔</Select.Option>
                    <Select.Option value="MV">马尔代夫</Select.Option>
                    <Select.Option value="AF">阿富汗</Select.Option>
                  </Select.OptGroup>
                  <Select.OptGroup label="一带一路 · 中亚">
                    <Select.Option value="KZ">哈萨克斯坦</Select.Option>
                    <Select.Option value="MN">蒙古</Select.Option>
                    <Select.Option value="UZ">乌兹别克斯坦</Select.Option>
                    <Select.Option value="TM">土库曼斯坦</Select.Option>
                    <Select.Option value="TJ">塔吉克斯坦</Select.Option>
                    <Select.Option value="KG">吉尔吉斯斯坦</Select.Option>
                  </Select.OptGroup>
                  <Select.OptGroup label="一带一路 · 非洲">
                    <Select.Option value="ZA">南非</Select.Option>
                    <Select.Option value="NG">尼日利亚</Select.Option>
                    <Select.Option value="EG">埃及</Select.Option>
                    <Select.Option value="AO">安哥拉</Select.Option>
                    <Select.Option value="DZ">阿尔及利亚</Select.Option>
                    <Select.Option value="MA">摩洛哥</Select.Option>
                    <Select.Option value="KE">肯尼亚</Select.Option>
                    <Select.Option value="ET">埃塞俄比亚</Select.Option>
                    <Select.Option value="GH">加纳</Select.Option>
                    <Select.Option value="TZ">坦桑尼亚</Select.Option>
                    <Select.Option value="MZ">莫桑比克</Select.Option>
                    <Select.Option value="TN">突尼斯</Select.Option>
                    <Select.Option value="LY">利比亚</Select.Option>
                    <Select.Option value="DJ">吉布提</Select.Option>
                    <Select.Option value="SD">苏丹</Select.Option>
                  </Select.OptGroup>
                </Select>
                <Button type="primary" onClick={handleCalculate} loading={loading} disabled={!hsCode || !country}>
                  开始核算
                </Button>
              </Card>

              {result && (
                <Card title={`核算结果 — ${countryCodeToName[result.destinationCountry] || result.destinationCountry}`}>
                  <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
                    <Descriptions.Item label="HS编码">{result.hsCode}</Descriptions.Item>
                    <Descriptions.Item label="适用税率">
                      <Tag color="green">{result.recommendedRate ?? result.appliedRate}%</Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="原产地规则">
                      {result.dbRule?.originCriteria || result.originCriteria || '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="关税节省">{result.savings}</Descriptions.Item>
                    <Descriptions.Item label="政策来源" span={2}>{result.source}</Descriptions.Item>
                    {result.dbRule && (
                      <Descriptions.Item label="数据库匹配" span={2}>
                        <Tag color="blue">已匹配本地规则库</Tag>
                        关税减免: {result.dbRule.tariffReduction}%
                      </Descriptions.Item>
                    )}
                    {(result.analysis || result.aiAnalysis?.analysis) && (
                      <Descriptions.Item label="AI分析建议" span={2}>
                        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>
                          {result.analysis || result.aiAnalysis?.analysis}
                        </div>
                      </Descriptions.Item>
                    )}
                  </Descriptions>
                </Card>
              )}
            </>
          ),
        },
        {
          key: 'rules',
          label: `规则库 (${filteredRules.length})`,
          children: (
            <Card>
              <Input placeholder="搜索HS编码或原产地规则" value={ruleSearch}
                onChange={e => setRuleSearch(e.target.value)}
                prefix={<SearchOutlined />} allowClear
                style={{ marginBottom: 16, width: '100%', maxWidth: 400 }} />
              <Table dataSource={filteredRules} columns={ruleColumns} rowKey="id"
                scroll={{ x: 600 }} loading={rulesLoading} pagination={{ pageSize: 20 }} size="small" />
            </Card>
          ),
        },
      ]} />
    </div>
  );
}
