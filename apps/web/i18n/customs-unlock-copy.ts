/**
 * V2-06 — CUSTOMS UNLOCK PAGE COPY（五语言同步文案）
 * ---------------------------------------------------------------
 * 授权：HOST DIRECTIVE 2026-10-09「CUSTOMS OPPORTUNITY UNLOCK & AUTO-COMMISSION V2」PHASE B / PHASE G。
 *
 * 约定：
 *  1. `Record<Locale, ...>` 强制五种语言（zh-CN / en-US / de / ja / es）**全部**提供，
 *     新增语言或漏翻译会直接编译失败。
 *  2. 文案中**不出现任何具体价格数字**：价格与币种一律以服务端签发的报价为准。
 *  3. 必须明确披露：15% 成功费、前置服务费与成功费是两笔独立收费、
 *     第三方费用、退款/取消条件、以及"不承诺海关必然退款"。
 */

import type { Locale } from './locales';

export interface CustomsUnlockCopy {
  pageTitle: string;
  backToCustoms: string;
  notFoundTitle: string;
  notFoundBody: string;
  estimateHeading: string;
  estimateBasis: string;
  noEstimateYet: string;
  eligibilityHeading: string;
  evidenceCompleteness: string;
  startCta: string;
  startHint: string;
  planHeading: string;
  planSingleBenefit: string;
  planMonthlyBenefit: string;
  priceNote: string;
  successFeeHeading: string;
  successFeeBody: string;
  thirdPartyAndRefund: string;
  paymentStatusHeading: string;
  paymentEnabled: string;
  paymentHold: string;
  purchaseDisabled: string;
  alreadyCovered: string;
  basisHeading: string;
}

export const CUSTOMS_UNLOCK_COPY: Record<Locale, CustomsUnlockCopy> = {
  'zh-CN': {
    pageTitle: '启动关税追回',
    backToCustoms: '返回关税页面',
    notFoundTitle: '未找到该机会',
    notFoundBody: '该关税机会不存在，或不属于当前账户。我们不会展示任何未经核实的信息。',
    estimateHeading: '预计可追回',
    estimateBasis: '预估依据与时间',
    noEstimateYet: '目前没有可展示的可追回金额：资料不足或尚未形成可信预估。',
    eligibilityHeading: '初步资格状态',
    evidenceCompleteness: '证据完整度',
    startCta: '启动关税追回',
    startHint: '点击后才会显示服务方案与费用说明，我们不会自动为你下单。',
    planHeading: '服务方案与权益',
    planSingleBenefit: '单次深度核验：一次完整核验，用于判断是否值得正式提起追回。',
    planMonthlyBenefit: '按月订阅：每月包含多次核验额度，适合持续有进口记录的业务。',
    priceNote: '具体价格与币种以服务端签发的报价单为准；报价单有有效期。',
    successFeeHeading: '成功追回后另收 15%',
    successFeeBody:
      '只有当关税实际追回到账、并完成核验与对账后，才对已核实的新增回款收取 15% 成功费。未追回、未到账、仅预计或申请中，成功费均为 0。',
    thirdPartyAndRefund: '第三方费用与退款：报关行、代理或官方可能另收费用，均由你直接承担；退款与取消条件按已披露条款执行。我们不承诺海关必然退款。',
    paymentStatusHeading: '支付与授权状态',
    paymentEnabled: '支付通道已启用（仍需完成授权确认）。',
    paymentHold: '支付通道当前未启用，暂不可购买。',
    purchaseDisabled: '暂不可购买',
    alreadyCovered: '你已有可用权益，无需重复购买同一服务。',
    basisHeading: '计算依据',
  },
  'en-US': {
    pageTitle: 'Start customs recovery',
    backToCustoms: 'Back to customs',
    notFoundTitle: 'Opportunity not found',
    notFoundBody:
      'This customs opportunity does not exist, or does not belong to the current account. We never show unverified information.',
    estimateHeading: 'Estimated recoverable',
    estimateBasis: 'Estimate basis and time',
    noEstimateYet:
      'No recoverable amount can be shown yet: evidence is incomplete or no trustworthy estimate exists.',
    eligibilityHeading: 'Preliminary eligibility',
    evidenceCompleteness: 'Evidence completeness',
    startCta: 'Start customs recovery',
    startHint:
      'Service options and fees appear only after you click. We never place an order for you automatically.',
    planHeading: 'Service options and benefits',
    planSingleBenefit: 'Single deep review: one full review to decide whether filing a recovery is worthwhile.',
    planMonthlyBenefit: 'Monthly plan: several review credits each month, for importers with ongoing entries.',
    priceNote: 'Exact price and currency come from the server-issued quote; the quote expires.',
    successFeeHeading: 'A 15% success fee applies only after recovery',
    successFeeBody:
      'Only after duty is actually recovered, verified and reconciled do we charge 15% of the verified new funds received. If nothing is recovered, nothing arrives, or the amount is merely estimated or pending, the success fee is 0.',
    thirdPartyAndRefund:
      'Third-party costs and refunds: brokers, agents or authorities may charge separately and you pay them directly; refund and cancellation terms follow the disclosed policy. We do not guarantee that customs will refund.',
    paymentStatusHeading: 'Payment and authorization status',
    paymentEnabled: 'Payment channel is enabled (authorization still required).',
    paymentHold: 'Payment channel is currently disabled; purchase is unavailable.',
    purchaseDisabled: 'Not purchasable yet',
    alreadyCovered: 'You already have usable credits; no need to buy the same service again.',
    basisHeading: 'Calculation basis',
  },
  de: {
    pageTitle: 'Zollrückforderung starten',
    backToCustoms: 'Zurück zum Zollbereich',
    notFoundTitle: 'Chance nicht gefunden',
    notFoundBody:
      'Diese Zollchance existiert nicht oder gehört nicht zum aktuellen Konto. Ungeprüfte Informationen zeigen wir nie.',
    estimateHeading: 'Geschätzt rückforderbar',
    estimateBasis: 'Grundlage und Zeitpunkt der Schätzung',
    noEstimateYet:
      'Noch kein rückforderbarer Betrag darstellbar: Nachweise unvollständig oder keine belastbare Schätzung.',
    eligibilityHeading: 'Vorläufige Anspruchsprüfung',
    evidenceCompleteness: 'Vollständigkeit der Nachweise',
    startCta: 'Zollrückforderung starten',
    startHint:
      'Serviceoptionen und Gebühren erscheinen erst nach Ihrem Klick. Wir bestellen nie automatisch für Sie.',
    planHeading: 'Serviceoptionen und Leistungen',
    planSingleBenefit: 'Einzelprüfung: eine vollständige Prüfung, ob sich ein Antrag lohnt.',
    planMonthlyBenefit: 'Monatsplan: mehrere Prüfguthaben pro Monat für laufende Importe.',
    priceNote: 'Preis und Währung ergeben sich aus dem serverseitigen Angebot; das Angebot läuft ab.',
    successFeeHeading: '15 % Erfolgsgebühr erst nach tatsächlicher Rückforderung',
    successFeeBody:
      'Erst wenn Zoll tatsächlich zurückgezahlt, geprüft und abgeglichen ist, berechnen wir 15 % der bestätigten neuen Zahlungseingänge. Ohne Rückzahlung, ohne Eingang, bei bloßer Schätzung oder laufendem Antrag beträgt die Erfolgsgebühr 0.',
    thirdPartyAndRefund:
      'Drittkosten und Erstattungen: Makler, Vertreter oder Behörden können separat abrechnen; Sie zahlen diese direkt. Erstattungs- und Stornobedingungen folgen den offengelegten Regeln. Eine Rückzahlung durch den Zoll wird nicht garantiert.',
    paymentStatusHeading: 'Zahlungs- und Autorisierungsstatus',
    paymentEnabled: 'Zahlungskanal aktiviert (Autorisierung weiterhin erforderlich).',
    paymentHold: 'Zahlungskanal derzeit deaktiviert; Kauf nicht möglich.',
    purchaseDisabled: 'Noch nicht käuflich',
    alreadyCovered: 'Sie haben bereits nutzbare Guthaben; kein erneuter Kauf nötig.',
    basisHeading: 'Berechnungsgrundlage',
  },
  ja: {
    pageTitle: '関税の回収を開始',
    backToCustoms: '関税ページに戻る',
    notFoundTitle: '該当する機会が見つかりません',
    notFoundBody:
      'この関税機会は存在しないか、現在のアカウントに属していません。未検証の情報は表示しません。',
    estimateHeading: '回収見込み額',
    estimateBasis: '見積りの根拠と時点',
    noEstimateYet: '表示できる回収見込み額はまだありません。資料不足、または信頼できる見積りが未成立です。',
    eligibilityHeading: '暫定の適格性',
    evidenceCompleteness: '証拠の充足度',
    startCta: '関税の回収を開始',
    startHint: 'クリック後にのみサービス内容と費用を表示します。自動で注文することはありません。',
    planHeading: 'サービス内容と権益',
    planSingleBenefit: '単回の詳細審査：申請に値するかを判断するための1回の完全審査。',
    planMonthlyBenefit: '月額プラン：輸入実績が継続する事業者向けに、毎月複数回の審査枠。',
    priceNote: '価格と通貨はサーバー発行の見積りに従います。見積りには有効期限があります。',
    successFeeHeading: '実際に回収できた場合のみ 15% の成功報酬',
    successFeeBody:
      '関税が実際に入金され、検証と照合が完了した後にのみ、確認済みの新規入金額に対して 15% を申し受けます。回収不能・未入金・見積り段階・申請中の場合は成功報酬は 0 です。',
    thirdPartyAndRefund:
      '第三者費用と返金：通関業者・代理人・当局が別途請求する場合があり、お客様が直接負担します。返金・解約条件は開示済みの規定に従います。税関による返金を保証するものではありません。',
    paymentStatusHeading: '支払いと認証の状態',
    paymentEnabled: '決済チャネルは有効です（別途の認証が必要です）。',
    paymentHold: '決済チャネルは現在無効のため、購入できません。',
    purchaseDisabled: '現在購入できません',
    alreadyCovered: '利用可能な権益が既にあります。同一サービスの再購入は不要です。',
    basisHeading: '算定根拠',
  },
  es: {
    pageTitle: 'Iniciar la recuperación de aranceles',
    backToCustoms: 'Volver a aranceles',
    notFoundTitle: 'Oportunidad no encontrada',
    notFoundBody:
      'Esta oportunidad aduanera no existe o no pertenece a la cuenta actual. Nunca mostramos información sin verificar.',
    estimateHeading: 'Recuperable estimado',
    estimateBasis: 'Base y momento de la estimación',
    noEstimateYet:
      'Aún no se puede mostrar un importe recuperable: falta documentación o no existe una estimación fiable.',
    eligibilityHeading: 'Elegibilidad preliminar',
    evidenceCompleteness: 'Completitud de la evidencia',
    startCta: 'Iniciar la recuperación de aranceles',
    startHint:
      'Las opciones y tarifas aparecen solo después de hacer clic. Nunca realizamos un pedido automáticamente.',
    planHeading: 'Opciones de servicio y beneficios',
    planSingleBenefit: 'Revisión única: una revisión completa para decidir si conviene presentar la reclamación.',
    planMonthlyBenefit: 'Plan mensual: varios créditos de revisión al mes para importadores con actividad continua.',
    priceNote: 'El precio y la moneda provienen de la cotización emitida por el servidor; la cotización caduca.',
    successFeeHeading: 'Comisión del 15 % solo tras la recuperación real',
    successFeeBody:
      'Solo cuando el arancel se recupera realmente y se verifica y concilia, cobramos el 15 % de los nuevos fondos confirmados. Si no hay recuperación, no hay ingreso, o el importe es solo estimado o está pendiente, la comisión es 0.',
    thirdPartyAndRefund:
      'Costos de terceros y reembolsos: agentes aduaneros, representantes o autoridades pueden facturar por separado y usted los paga directamente; las condiciones de reembolso y cancelación siguen la política divulgada. No garantizamos que la aduana reembolse.',
    paymentStatusHeading: 'Estado de pago y autorización',
    paymentEnabled: 'Canal de pago habilitado (aún se requiere autorización).',
    paymentHold: 'El canal de pago está deshabilitado; la compra no está disponible.',
    purchaseDisabled: 'Aún no comprable',
    alreadyCovered: 'Ya tiene créditos disponibles; no necesita comprar el mismo servicio otra vez.',
    basisHeading: 'Base de cálculo',
  },
};

export function getCustomsUnlockCopy(locale: Locale): CustomsUnlockCopy {
  return CUSTOMS_UNLOCK_COPY[locale];
}
