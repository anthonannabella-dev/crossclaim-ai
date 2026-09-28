export interface WebhookEventType {
  type: string;
  label: string;
  description: string;
}

export const WEBHOOK_EVENT_TYPES: WebhookEventType[] = [
  {
    type: 'declaration.build',
    label: '报关单构建完成',
    description: '报关单构建并完成合规预检时触发',
  },
  {
    type: 'declaration.xml_exported',
    label: '报关单XML导出',
    description: '报关单XML导出完成时触发',
  },
  {
    type: 'cbam.high_risk',
    label: 'CBAM高风险检测',
    description: 'CBAM碳关税测算结果为高风险时触发',
  },
  {
    type: 'ai.classify',
    label: 'AI归类完成',
    description: 'AI智能归类双校验完成后触发',
  },
  {
    type: 'rcep.calculated',
    label: 'RCEP关税核算',
    description: 'RCEP最优关税核算完成时触发',
  },
  {
    type: 'origin.determined',
    label: '原产地判定',
    description: '原产地资格判定完成后触发',
  },
  {
    type: 'origin.route_compared',
    label: '原产地路径比对',
    description: '跨FTA最优税率路径比对完成时触发',
  },
  {
    type: 'policy.updated',
    label: '政策法规更新',
    description: '管理员创建或更新法规预警时触发',
  },
  {
    type: 'payment.completed',
    label: '支付完成',
    description: '支付成功后触发（含续费）',
  },
  {
    type: 'document.audited',
    label: '单证AI审核',
    description: '单证AI审核完成时触发',
  },
  // === 自动化流水线事件 ===
  {
    type: 'document.uploaded',
    label: '单证上传完成',
    description: '用户上传单证成功后触发，携带 documentId / billOfLading 信息',
  },
  {
    type: 'batch.archive_done',
    label: '批量归档完成',
    description: '批量识别自动归档全部完成后触发，携带 groupId / billOfLading',
  },
  {
    type: 'declaration.submitted',
    label: '报关单已提交',
    description: '报关单成功提交到海关后触发，携带 declarationId / declarationNo',
  },
];

export const EVENT_TYPE_MAP = new Map(WEBHOOK_EVENT_TYPES.map(e => [e.type, e]));
