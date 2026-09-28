import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // 创建管理员
  const adminHash = await bcrypt.hash('admin123', 12);
  await prisma.admin.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      passwordHash: adminHash,
      role: 'superadmin',
    },
  });
  console.log('Admin user created: admin / admin123');

  // 种子HS编码数据
  await prisma.hSCode.deleteMany();
  const hsCodes = [
    { code: '8471.30', description: '便携式自动数据处理设备', unit: '台', tariffRate: 0, category: '电子产品' },
    { code: '8471.41', description: '其他自动数据处理设备', unit: '台', tariffRate: 0, category: '电子产品' },
    { code: '8471.49', description: '以系统形式报验的其他数据处理设备', unit: '台', tariffRate: 0, category: '电子产品' },
    { code: '8528.52', description: '可直接连接且设计用于品目84.71自动数据处理设备的监视器', unit: '台', tariffRate: 0, category: '电子产品' },
    { code: '9403.10', description: '办公室用金属家具', unit: '件', tariffRate: 5, category: '家具' },
    { code: '8541.43', description: '光伏组件（太阳能电池组件）', unit: '个', tariffRate: 6.5, category: '新能源' },
    { code: '6109.10', description: '棉制针织或钩编的T恤衫、汗衫、背心', unit: '件', tariffRate: 14, category: '纺织品' },
    { code: '7208.39', description: '其他仅经热轧的卷材，厚度<3mm', unit: '吨', tariffRate: 6, category: '钢铁' },
    { code: '8507.60', description: '锂离子蓄电池', unit: '个', tariffRate: 12, category: '新能源' },
    { code: '8703.80', description: '仅装有驱动电动机的其他载人车辆（电动汽车）', unit: '辆', tariffRate: 15, category: '汽车' },
    { code: '6403.99', description: '其他橡/塑/革外底及皮革鞋面的鞋靴', unit: '双', tariffRate: 10, category: '鞋靴' },
    { code: '6204.62', description: '棉制女式长裤、护胸背带工装裤、马裤及短裤', unit: '条', tariffRate: 14, category: '纺织品' },
    { code: '7326.90', description: '其他钢铁制品', unit: '千克', tariffRate: 8, category: '钢铁' },
    { code: '8418.69', description: '其他制冷设备（热泵除外）', unit: '台', tariffRate: 10, category: '机械' },
    { code: '9401.79', description: '其他金属框架坐具', unit: '件', tariffRate: 5, category: '家具' },
    { code: '7601.10', description: '未锻轧的非合金铝', unit: '吨', tariffRate: 5, category: '有色金属' },
    { code: '8517.12', description: '用于蜂窝网络或其他无线网络的智能手机', unit: '台', tariffRate: 0, category: '电子产品' },
    { code: '0304.89', description: '其他冻鱼片', unit: '千克', tariffRate: 10, category: '农产品' },
  ];

  for (const code of hsCodes) {
    await prisma.hSCode.upsert({
      where: { code: code.code },
      update: {},
      create: code,
    });
  }
  console.log(`Seeded ${hsCodes.length} HS codes`);

  // 种子RCEP规则
  const rcepRules = [
    { productCode: '8471.30', originCriteria: '完全获得(WO)', tariffReduction: 5, effectiveDate: new Date('2024-01-01'), source: 'RCEP协定附件3-A' },
    { productCode: '8471.41', originCriteria: '税则归类改变(CC)', tariffReduction: 3, effectiveDate: new Date('2024-01-01'), source: 'RCEP协定附件3-A' },
  ];

  for (const rule of rcepRules) {
    await prisma.rCEPRule.create({
      data: rule,
    });
  }
  console.log(`Seeded ${rcepRules.length} RCEP rules`);

  // 种子FTA协定
  const ftaAgreements = [
    { name: '区域全面经济伙伴关系协定', shortName: 'RCEP', description: '中国、日本、韩国、澳大利亚、新西兰与东盟10国', memberCountries: JSON.stringify(['CN','JP','KR','AU','NZ','BN','KH','ID','LA','MY','MM','PH','SG','TH','VN']), effectiveDate: new Date('2022-01-01'), isActive: true },
    { name: '中国-东盟自由贸易区', shortName: 'CAFTA', description: '中国与东盟10国', memberCountries: JSON.stringify(['CN','BN','KH','ID','LA','MY','MM','PH','SG','TH','VN']), effectiveDate: new Date('2010-01-01'), isActive: true },
    { name: '中韩自由贸易协定', shortName: 'CKFTA', description: '中国与韩国', memberCountries: JSON.stringify(['CN','KR']), effectiveDate: new Date('2015-12-20'), isActive: true },
    { name: '中澳自由贸易协定', shortName: 'CHAFTA', description: '中国与澳大利亚', memberCountries: JSON.stringify(['CN','AU']), effectiveDate: new Date('2015-12-20'), isActive: true },
    { name: '中智自由贸易协定', shortName: 'CCFTA', description: '中国与智利', memberCountries: JSON.stringify(['CN','CL']), effectiveDate: new Date('2006-10-01'), isActive: true },
  ];

  for (const fta of ftaAgreements) {
    await prisma.ftaAgreement.upsert({
      where: { shortName: fta.shortName },
      update: {},
      create: fta,
    });
  }
  console.log(`Seeded ${ftaAgreements.length} FTA agreements`);

  // 种子原产地规则 (各FTA下8条代表性规则)
  const rcep = await prisma.ftaAgreement.findUnique({ where: { shortName: 'RCEP' } });
  const cafta = await prisma.ftaAgreement.findUnique({ where: { shortName: 'CAFTA' } });
  const ckfta = await prisma.ftaAgreement.findUnique({ where: { shortName: 'CKFTA' } });
  const chafta = await prisma.ftaAgreement.findUnique({ where: { shortName: 'CHAFTA' } });
  const ccfta = await prisma.ftaAgreement.findUnique({ where: { shortName: 'CCFTA' } });

  const originRules = [
    // RCEP (8条)
    { ftaAgreementId: rcep!.id, hsCode: '8471.30', ruleType: 'WO', ruleDetail: '完全获得或生产', tariffReduction: 5, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    { ftaAgreementId: rcep!.id, hsCode: '8471.41', ruleType: 'CC', ruleDetail: '品目级税则归类改变', tariffReduction: 5, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    { ftaAgreementId: rcep!.id, hsCode: '8471.49', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 3, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    { ftaAgreementId: rcep!.id, hsCode: '8528.52', ruleType: 'CTH', ruleDetail: '章级税则归类改变', tariffReduction: 4, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    { ftaAgreementId: rcep!.id, hsCode: '9403.10', ruleType: 'PE', ruleDetail: '特定制造工序要求', tariffReduction: 6, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    { ftaAgreementId: rcep!.id, hsCode: '6204.62', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%或章级税则改变', rvcThreshold: 40, tariffReduction: 8, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    { ftaAgreementId: rcep!.id, hsCode: '2710.12', ruleType: 'SP', ruleDetail: '特定化学反应工序', tariffReduction: 2, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    { ftaAgreementId: rcep!.id, hsCode: '9018.11', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 4.5, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    // RCEP 新增产品
    { ftaAgreementId: rcep!.id, hsCode: '8541.43', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 6.0, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    { ftaAgreementId: rcep!.id, hsCode: '8507.60', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 10, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    { ftaAgreementId: rcep!.id, hsCode: '6109.10', ruleType: 'CC', ruleDetail: '品目级税则归类改变', tariffReduction: 12, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    { ftaAgreementId: rcep!.id, hsCode: '7208.39', ruleType: 'SP', ruleDetail: '特定热轧工序', tariffReduction: 4, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    { ftaAgreementId: rcep!.id, hsCode: '8703.80', ruleType: 'RVC', ruleDetail: '区域价值成分≥45%', rvcThreshold: 45, tariffReduction: 12, source: 'RCEP附件3-A', effectiveDate: new Date('2022-01-01') },
    // CAFTA
    { ftaAgreementId: cafta!.id, hsCode: '8471.30', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 5, source: 'CAFTA原产地规则', effectiveDate: new Date('2010-01-01') },
    { ftaAgreementId: cafta!.id, hsCode: '6204.62', ruleType: 'CC', ruleDetail: '品目级税则归类改变', tariffReduction: 7, source: 'CAFTA原产地规则', effectiveDate: new Date('2010-01-01') },
    { ftaAgreementId: cafta!.id, hsCode: '9403.10', ruleType: 'WO', ruleDetail: '完全获得', tariffReduction: 5, source: 'CAFTA原产地规则', effectiveDate: new Date('2010-01-01') },
    { ftaAgreementId: cafta!.id, hsCode: '8528.52', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 3, source: 'CAFTA原产地规则', effectiveDate: new Date('2010-01-01') },
    { ftaAgreementId: cafta!.id, hsCode: '2710.12', ruleType: 'CTH', ruleDetail: '章级税则归类改变', tariffReduction: 2, source: 'CAFTA原产地规则', effectiveDate: new Date('2010-01-01') },
    { ftaAgreementId: cafta!.id, hsCode: '9018.11', ruleType: 'RVC', ruleDetail: '区域价值成分≥35%', rvcThreshold: 35, tariffReduction: 4, source: 'CAFTA原产地规则', effectiveDate: new Date('2010-01-01') },
    // CAFTA 新增产品
    { ftaAgreementId: cafta!.id, hsCode: '8541.43', ruleType: 'RVC', ruleDetail: '区域价值成分≥35%', rvcThreshold: 35, tariffReduction: 5.0, source: 'CAFTA原产地规则', effectiveDate: new Date('2010-01-01') },
    { ftaAgreementId: cafta!.id, hsCode: '6109.10', ruleType: 'CC', ruleDetail: '品目级税则归类改变', tariffReduction: 10, source: 'CAFTA原产地规则', effectiveDate: new Date('2010-01-01') },
    { ftaAgreementId: cafta!.id, hsCode: '7208.39', ruleType: 'WO', ruleDetail: '完全获得(矿产)', tariffReduction: 3, source: 'CAFTA原产地规则', effectiveDate: new Date('2010-01-01') },
    { ftaAgreementId: cafta!.id, hsCode: '8703.80', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 10, source: 'CAFTA原产地规则', effectiveDate: new Date('2010-01-01') },
    // CKFTA
    { ftaAgreementId: ckfta!.id, hsCode: '8471.30', ruleType: 'RVC', ruleDetail: '区域价值成分≥50%', rvcThreshold: 50, tariffReduction: 8, source: '中韩FTA附件', effectiveDate: new Date('2015-12-20') },
    { ftaAgreementId: ckfta!.id, hsCode: '6204.62', ruleType: 'SP', ruleDetail: '特定纺织工序', tariffReduction: 10, source: '中韩FTA附件', effectiveDate: new Date('2015-12-20') },
    { ftaAgreementId: ckfta!.id, hsCode: '9018.11', ruleType: 'RVC', ruleDetail: '区域价值成分≥45%', rvcThreshold: 45, tariffReduction: 6, source: '中韩FTA附件', effectiveDate: new Date('2015-12-20') },
    { ftaAgreementId: ckfta!.id, hsCode: '8528.52', ruleType: 'CC', ruleDetail: '品目级税则归类改变', tariffReduction: 7, source: '中韩FTA附件', effectiveDate: new Date('2015-12-20') },
    { ftaAgreementId: ckfta!.id, hsCode: '9403.10', ruleType: 'CTH', ruleDetail: '章级税则归类改变', tariffReduction: 5, source: '中韩FTA附件', effectiveDate: new Date('2015-12-20') },
    { ftaAgreementId: ckfta!.id, hsCode: '2710.12', ruleType: 'SP', ruleDetail: '特定化工工序', tariffReduction: 3, source: '中韩FTA附件', effectiveDate: new Date('2015-12-20') },
    // CKFTA 新增产品
    { ftaAgreementId: ckfta!.id, hsCode: '8541.43', ruleType: 'RVC', ruleDetail: '区域价值成分≥45%', rvcThreshold: 45, tariffReduction: 5.5, source: '中韩FTA附件', effectiveDate: new Date('2015-12-20') },
    { ftaAgreementId: ckfta!.id, hsCode: '8507.60', ruleType: 'RVC', ruleDetail: '区域价值成分≥50%', rvcThreshold: 50, tariffReduction: 8, source: '中韩FTA附件', effectiveDate: new Date('2015-12-20') },
    // CHAFTA
    { ftaAgreementId: chafta!.id, hsCode: '8471.30', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 5, source: '中澳FTA附件', effectiveDate: new Date('2015-12-20') },
    { ftaAgreementId: chafta!.id, hsCode: '6204.62', ruleType: 'CC', ruleDetail: '品目级税则归类改变', tariffReduction: 10, source: '中澳FTA附件', effectiveDate: new Date('2015-12-20') },
    { ftaAgreementId: chafta!.id, hsCode: '2710.12', ruleType: 'WO', ruleDetail: '完全获得(矿产)', tariffReduction: 5, source: '中澳FTA附件', effectiveDate: new Date('2015-12-20') },
    { ftaAgreementId: chafta!.id, hsCode: '9018.11', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 7, source: '中澳FTA附件', effectiveDate: new Date('2015-12-20') },
    { ftaAgreementId: chafta!.id, hsCode: '9403.10', ruleType: 'CTH', ruleDetail: '章级税则归类改变', tariffReduction: 5, source: '中澳FTA附件', effectiveDate: new Date('2015-12-20') },
    { ftaAgreementId: chafta!.id, hsCode: '8528.52', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 3, source: '中澳FTA附件', effectiveDate: new Date('2015-12-20') },
    // CHAFTA 新增产品
    { ftaAgreementId: chafta!.id, hsCode: '8541.43', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 4, source: '中澳FTA附件', effectiveDate: new Date('2015-12-20') },
    { ftaAgreementId: chafta!.id, hsCode: '7208.39', ruleType: 'WO', ruleDetail: '完全获得(矿产)', tariffReduction: 3, source: '中澳FTA附件', effectiveDate: new Date('2015-12-20') },
    // CCFTA
    { ftaAgreementId: ccfta!.id, hsCode: '8471.30', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 6, source: '中智FTA附件', effectiveDate: new Date('2006-10-01') },
    { ftaAgreementId: ccfta!.id, hsCode: '6204.62', ruleType: 'CC', ruleDetail: '品目级税则归类改变', tariffReduction: 10, source: '中智FTA附件', effectiveDate: new Date('2006-10-01') },
    { ftaAgreementId: ccfta!.id, hsCode: '2710.12', ruleType: 'WO', ruleDetail: '完全获得(矿产)', tariffReduction: 6, source: '中智FTA附件', effectiveDate: new Date('2006-10-01') },
    { ftaAgreementId: ccfta!.id, hsCode: '9403.10', ruleType: 'WO', ruleDetail: '完全获得(林产品)', tariffReduction: 6, source: '中智FTA附件', effectiveDate: new Date('2006-10-01') },
    { ftaAgreementId: ccfta!.id, hsCode: '9018.11', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 5, source: '中智FTA附件', effectiveDate: new Date('2006-10-01') },
    { ftaAgreementId: ccfta!.id, hsCode: '8528.52', ruleType: 'RVC', ruleDetail: '区域价值成分≥35%', rvcThreshold: 35, tariffReduction: 3, source: '中智FTA附件', effectiveDate: new Date('2006-10-01') },
    // CCFTA 新增产品
    { ftaAgreementId: ccfta!.id, hsCode: '8541.43', ruleType: 'RVC', ruleDetail: '区域价值成分≥40%', rvcThreshold: 40, tariffReduction: 5, source: '中智FTA附件', effectiveDate: new Date('2006-10-01') },
    { ftaAgreementId: ccfta!.id, hsCode: '6109.10', ruleType: 'CC', ruleDetail: '品目级税则归类改变', tariffReduction: 8, source: '中智FTA附件', effectiveDate: new Date('2006-10-01') },
  ];

  for (const rule of originRules) {
    await prisma.originRule.upsert({
      where: { ftaAgreementId_hsCode: { ftaAgreementId: rule.ftaAgreementId, hsCode: rule.hsCode } },
      update: {},
      create: rule,
    });
  }
  console.log(`Seeded ${originRules.length} origin rules`);

  // 种子政策预警
  await prisma.policyAlert.deleteMany();
  const alerts = [
    { title: '海关总署公告2024年第87号——关于调整部分进出口商品HS编码及监管条件的公告', summary: '对8471、8523等章节HS编码进行增删，部分商品监管条件由A调整为AB', content: '根据《中华人民共和国海关进出口税则》修订需要，海关总署决定对部分进出口商品HS编码及监管条件作出调整。本次调整涉及第84章核反应堆、锅炉、机器、机械器具，第85章电机、电气设备及其零件等共127个HS编码增删。新增8541.40.10项下光伏组件编码，删除8471.30.01项下旧式便携计算机编码。部分商品监管条件由A（进口许可证）调整为AB（进出口许可证），相关企业应及时更新申报信息。公告自2024年7月1日起施行。', source: '海关总署', publishDate: new Date('2024-06-15'), category: 'customs', hsCode: '8471.30' },
    { title: '商务部公告——RCEP项下部分产品特定原产地规则修订', summary: '修订第61-63章纺织品区域价值成分计算规则，RVC阈值由40%调整为35%', content: '根据RCEP联合委员会第三次会议决议，对协定附件3-A中特定产品原产地规则进行修订。主要修订内容：一、第61章（针织服装）、第62章（非针织服装）、第63章（其他纺织制成品）项下产品，区域价值成分（RVC）阈值由原40%调整为35%；二、新增对HS编码6403（鞋靴）的"章改变"（CC）规则为替代规则；三、明确累积规则适用于所有RCEP缔约方。修订自2024年8月1日起生效，过渡期至2024年12月31日。', source: '商务部', publishDate: new Date('2024-06-10'), category: 'rcep', hsCode: '6101' },
    { title: '欧盟CBAM实施条例(EU) 2024/1789——过渡期报告标准与核算方法', summary: '明确CBAM过渡期(2023-2025)碳排放报告格式、默认值使用条件及核查要求', content: '欧盟委员会发布CBAM实施条例(EU) 2024/1789号，对碳边境调节机制过渡期(2023年10月1日至2025年12月31日)的具体执行标准作出规定。主要内容包括：一、明确季度报告提交格式和截止日期（每季度结束后一个月内）；二、规定直接排放和间接排放的核算方法学；三、设定过渡期内可使用默认值的条件（当实际数据无法获得时，默认值基于出口国同行业最差10%企业的排放强度）；四、要求2025年起提交的报告须附带经认可的第三方核查声明。对中国钢铁、铝、化肥、水泥、氢、电力六大行业出口企业影响显著。', source: '欧盟委员会', publishDate: new Date('2024-05-28'), category: 'cbam', hsCode: '7208' },
    { title: '海关总署公告2024年第52号——中国-东盟自贸区(CAFTA)3.0版升级议定书项下原产地管理办法', summary: 'CAFTA升级版新增电子原产地证书(e-Form E)、经核准出口商(AEO)自主声明制度', content: '为实施中国-东盟自由贸易区3.0版升级议定书，海关总署发布《中国-东盟自贸区项下原产地管理办法（2024年修订）》。主要修订：一、新增电子原产地证书（e-Form E）制度，企业可通过国际贸易"单一窗口"申领；二、引入经核准出口商（AEO）原产地自主声明制度，高级认证企业可自行出具原产地声明享受关税优惠；三、优化"完全获得"（WO）标准判定流程；四、明确第三方发票和非缔约方中转不影响原产地资格的条件。新办法自2024年9月1日起施行，原办法同时废止。', source: '海关总署', publishDate: new Date('2024-05-20'), category: 'origin', hsCode: '8471.30' },
    { title: '国务院关税税则委员会关于2024年关税调整方案的通知', summary: '对1010项商品实施低于最惠国税率的进口暂定税率，新增62项出口管制商品', content: '国务院关税税则委员会发布《2024年关税调整方案》（税委会〔2024〕1号），自2024年1月1日起实施。调整要点：一、对1010项商品（不含关税配额商品）实施低于最惠国税率的进口暂定税率，主要涉及资源类产品、关键零部件和原材料、国内短缺的药品原料、先进技术设备和消费品；二、对62项涉及国家安全和技术优势的产品调整出口关税税率或新增出口管制；三、根据RCEP等自贸协定进一步下调协定税率；四、对原产于尼加拉瓜、洪都拉斯等新建交国家适用协定税率。', source: '国务院关税税则委员会', publishDate: new Date('2024-01-05'), category: 'tariff', hsCode: null },
    { title: '商务部、海关总署公告2024年第33号——关于对无人机相关物项实施出口管制的联合公告', summary: '新增对高性能无人机、相关零部件及技术的出口管制，列入《中国禁止出口限制出口技术目录》', content: '商务部、海关总署联合发布2024年第33号公告，决定对无人机相关物项实施出口管制。管制范围包括：一、最大持续功率超过16kW的航空发动机；二、满足特定技术指标的惯性导航系统、卫星导航接收设备；三、可用于无人机的红外成像设备、合成孔径雷达、激光目标指示器；四、无人机机载通信系统及相关软件技术。出口经营者须向商务部申请《两用物项和技术出口许可证》，海关凭许可证验放。公告自2024年8月1日起施行。', source: '商务部', publishDate: new Date('2024-04-15'), category: 'export', hsCode: '8526.10' },
    { title: '海关总署公告2024年第38号——关于全面推广原产地证书自助打印和智能审核的通知', summary: '原产地证书自助打印覆盖范围扩大至全部23种证书，智能审核比例提升至80%', content: '海关总署发布2024年第38号公告，自2024年6月1日起在全国海关全面推广原产地证书自助打印和智能审核改革。主要内容：一、将自助打印证书种类由16种扩大至全部23种，新增RCEP、中国-柬埔寨自贸协定等项下原产地证书；二、智能审核比例由60%提升至80%，审核时间由0.5个工作日缩短至"秒级"；三、企业可通过"单一窗口"实时查询审核进度和证单状态；四、特殊情况下仍保留人工审核通道。此举预计每年为企业节约时间成本约320万小时。', source: '海关总署', publishDate: new Date('2024-04-20'), category: 'customs', hsCode: null },
    { title: '中国-韩国自贸协定第二阶段谈判达成——服务贸易和投资领域取得突破', summary: '中韩FTA第二阶段谈判完成，新增数字贸易章节，部分工业品关税进一步削减', content: '商务部宣布中国-韩国自由贸易协定第二阶段谈判已实质性完成。谈判成果包括：一、新增数字贸易章节，涵盖跨境数据流动、电子认证、个人信息保护等规则；二、韩国承诺对我方20种农产品新增零关税安排；三、双方在汽车及零部件领域达成额外关税减让，韩国对华产电动汽车电池模组关税将在3年内由8%降为零；四、服务贸易负面清单管理模式正式确立。协议预计2025年第一季度签署，届时CKFTA覆盖率将提升至90%以上。', source: '商务部', publishDate: new Date('2024-03-08'), category: 'tariff', hsCode: '8507.60' },
    { title: '欧盟包装与包装废弃物法规(PPWR)——出口欧盟产品包装合规新要求', summary: '欧盟PPWR法规正式生效，2026年起出口欧盟产品包装须满足可回收性和最低回收含量要求', content: '欧洲议会和理事会正式通过《包装与包装废弃物法规》(PPWR, Regulation (EU) 2024/1245)，替代原指令94/62/EC。新法规要点：一、2030年起所有投放欧盟市场的包装应为可回收设计（按设计回收标准DfR）；二、2030年起塑料包装含再生料比例：PET接触敏感包装达30%，其他接触敏感包装达10%，非接触敏感包装达35%；三、2030年起包装标签须标注材料和回收指引的二维码；四、禁止特定一次性包装形式，如酒店微型洗漱用品包装（2030年）、餐饮堂食一次性餐具包装（2028年）。对中国输欧消费品出口商影响广泛。', source: '欧盟委员会', publishDate: new Date('2024-02-20'), category: 'export', hsCode: null },
    { title: '海关总署公告2024年第18号——关于2024年《商品名称及编码协调制度》转版申报指引', summary: '发布HS2022向HS2027过渡期申报指引，涉及114组编码转换对照表', content: '为配合世界海关组织(WCO)《商品名称及编码协调制度》2027年版（HS2027）转版工作，海关总署发布2024年第18号公告，提供HS2022与HS2027编码转换对照指引。重点调整领域：一、电子烟、新型烟草制品新增独立编码2404系列；二、3D打印设备及材料新增独立编码8485系列；三、无人机（民用）新增独立编码8806系列；四、增材制造材料从第39章拆分为新增39.08系列。企业应在2025年12月31日前完成内部编码体系转换，2026年1月1日起正式启用HS2027。', source: '海关总署', publishDate: new Date('2024-03-15'), category: 'customs', hsCode: '2404.12' },
    { title: '商务部关于印发《RCEP项下进出口货物原产地管理办法实施指南（2024年修订版）》的通知', summary: '更新RCEP原产地管理操作细则，明确累积规则、微小含量、直接运输条款的企业适用指南', content: '商务部发布《RCEP项下进出口货物原产地管理办法实施指南（2024年修订版）》，主要更新内容：一、细化累积规则操作——企业在计算RVC时可将所有RCEP缔约方的原产材料计入"原产成分"，提供累积计算实例和ERP系统对接指引；二、明确微小含量（De Minimis）规则——非原产材料占比不超过FOB价格10%时可忽略不计；三、直接运输条款——明确经非缔约方中转24个月内不改变原产地资格的判定条件；四、新增"经核准出口商"与原产地自主声明制度衔接说明。', source: '商务部', publishDate: new Date('2024-02-28'), category: 'rcep', hsCode: null },
    { title: '生态环境部办公厅关于做好全国碳排放权交易市场扩围工作的通知', summary: '电解铝、水泥行业纳入全国碳市场，2024年启动第一个履约周期，核算方法参照CBAM口径', content: '生态环境部发布《关于做好全国碳排放权交易市场扩围工作的通知》（环办气候函〔2024〕11号），决定自2024年起将电解铝和水泥两大行业纳入全国碳排放权交易市场。要点：一、2024年为第一个履约周期，约230家电厂和新增85家电解铝、水泥企业需完成碳排放报告与核查；二、核算方法参考欧盟CBAM口径，涵盖直接排放和电力间接排放；三、配额分配采用基准法，初期以免费分配为主；四、纳入企业可用国家核证自愿减排量(CCER)抵销不超过5%的应清缴配额。此扩围将有助于我国碳定价机制与CBAM互认谈判。', source: '生态环境部', publishDate: new Date('2024-03-01'), category: 'cbam', hsCode: '7601.10' },
  ];

  for (const alert of alerts) {
    await prisma.policyAlert.create({ data: alert });
  }
  console.log(`Seeded ${alerts.length} policy alerts`);

  // ---------- 创建测试租户 (已知密码，用于 API 测试) ----------
  const tenantHash = await bcrypt.hash('Test1234!', 12);
  const trialEnd = new Date();
  trialEnd.setFullYear(trialEnd.getFullYear() + 1);

  await prisma.tenant.upsert({
    where: { contactEmail: 'test@test.com' },
    update: {},
    create: {
      companyName: '测试报关行',
      contactName: '张三',
      contactPhone: '13800138000',
      contactEmail: 'test@test.com',
      passwordHash: tenantHash,
      emailVerified: true,
      status: 'ACTIVE',
      planTier: 'ENTERPRISE',
      paymentCycle: 'ANNUAL',
      trialStartAt: new Date(),
      trialEndAt: trialEnd,
      subscribedAt: new Date(),
      expiresAt: trialEnd,
    },
  });
  console.log('Test tenant created: test@test.com / Test1234!');

  // ---------- 创建测试子账号 ----------
  const testTenant = await prisma.tenant.findUnique({ where: { contactEmail: 'test@test.com' } });
  if (testTenant) {
    const subHash = await bcrypt.hash('Test1234!', 12);
    await prisma.subAccount.upsert({
      where: { id: `${testTenant.id}-operator` },
      update: {},
      create: {
        id: `${testTenant.id}-operator`,
        tenantId: testTenant.id,
        username: 'operator',
        passwordHash: subHash,
        role: 'operator',
        isActive: true,
      },
    });
    console.log('Test sub-account created: operator / Test1234!');
  }

  console.log('Seed completed!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
