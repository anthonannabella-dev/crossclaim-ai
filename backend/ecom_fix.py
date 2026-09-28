# -*- coding: utf-8 -*-
f = 'D:/customs-saas/backend/src/services/declarationBuilder.ts'
s = open(f, encoding='utf-8').read()
old = """documents: docs.map((d: any) => d.fileName),
totalValue: items.reduce((s, i) => s + num(i.totalPrice), 0),
};"""
new = """documents: docs.map((d: any) => d.fileName),
totalValue: items.reduce((s, i) => s + num(i.totalPrice), 0),
// 跨境电商三单/平台字段透传(探测到电商模式时由上游传入,带入报关单供三单对碰)
...(input.orderNo ? { orderNo: input.orderNo } : {}),
...(input.paymentNo ? { paymentNo: input.paymentNo } : {}),
...(input.logisticsNo ? { logisticsNo: input.logisticsNo } : {}),
...(input.ecommercePlatform ? { ecommercePlatform: input.ecommercePlatform } : {}),
...(input.b2bOrderNo ? { b2bOrderNo: input.b2bOrderNo } : {}),
};"""
assert s.count(old) == 1, 'declaration 构造块未唯一匹配'
s = s.replace(old, new)
open(f, 'w', encoding='utf-8').write(s)
print('OK: 电商字段透传已加入')
