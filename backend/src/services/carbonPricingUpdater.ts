// ============================================================
// CBAM 碳关税参数自动更新服务
// 从公开源抓取 EU ETS 碳价、中国碳市场碳价、欧元汇率
// 数据源: tradingeconomics.com, sandbag.org, 上清所
// ============================================================
import { logger } from '../config/logger';
import axios from 'axios';

export interface CarbonPricing {
  euEtsPrice: number;         // EU ETS 碳价 (€/tCO₂)
  chinaEtsPrice: number;      // 中国碳市场碳价 (€/tCO₂)
  exchangeRate: number;       // EUR/CNY 汇率
  effectiveCarbonPrice: number; // 有效碳价差额
  updatedAt: string;          // 更新时间
}

// 欧盟碳市场(EU ETS) — 公开 API
async function fetchEuEtsPrice(): Promise<number | null> {
  // 数据源1: sandbag.org (免费API — 显示EUA期货价格)
  try {
    const resp = await axios.get('https://api.sandbag.org/api/v2/price/eua', {
      timeout: 15000,
      headers: { 'Accept': 'application/json' },
    });
    if (resp.status === 200 && resp.data?.price) {
      return Number(resp.data.price);
    }
  } catch {}
  
  // 数据源2: tradingeconomics.com (EU Carbon Permits)
  try {
    const resp = await axios.get('https://dashboards-api.tradingeconomics.com/v1/category/commodities', {
      timeout: 15000,
      params: { c: 'eu-carbon-permits', format: 'json' },
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (resp.status === 200 && resp.data?.datasets?.[0]?.data?.[0]) {
      const price = Number(resp.data.datasets[0].data[0]);
      if (price > 0 && price < 200) return price;
    }
  } catch {}
  
  // 数据源3: 从官方ICE交易所(公开)
  try {
    const resp = await axios.get('https://www.theice.com/api/marketdata/commodities/eua', {
      timeout: 10000,
      headers: { 'Accept': 'application/json' },
    });
    if (resp.status === 200 && resp.data?.last) {
      return Number(resp.data.last);
    }
  } catch {}

  return null;
}

// 中国碳市场碳价 — 上海环境能源交易所公开价格
async function fetchChinaCarbonPrice(): Promise<number | null> {
  try {
    const resp = await axios.get('https://www.cneeex.com/api/market/data/trade-summary', {
      timeout: 15000,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    if (resp.status === 200 && resp.data?.averagePrice) {
      const cnyPrice = Number(resp.data.averagePrice);
      if (cnyPrice > 0) return cnyPrice;
    }
  } catch {}
  
  try {
    const resp = await axios.get('https://www.tanpaifang.com/api/market/dashboard', {
      timeout: 10000,
      headers: { 'Accept': 'application/json' },
    });
    if (resp.status === 200 && resp.data?.avgPrice) {
      const cnyPrice = Number(resp.data.avgPrice);
      if (cnyPrice > 0) return cnyPrice;
    }
  } catch {}

  return null;
}

// 欧元兑人民币汇率
async function fetchEurCnyRate(): Promise<number | null> {
  try {
    const resp = await axios.get('https://api.exchangerate-api.com/v4/latest/EUR', {
      timeout: 10000,
      headers: { 'Accept': 'application/json' },
    });
    if (resp.status === 200 && resp.data?.rates?.CNY) {
      return Number(resp.data.rates.CNY);
    }
  } catch {}
  
  try {
    const resp = await axios.get('https://open.er-api.com/v6/latest/EUR', {
      timeout: 10000,
    });
    if (resp.status === 200 && resp.data?.rates?.CNY) {
      return Number(resp.data.rates.CNY);
    }
  } catch {}

  return null;
}

// 默认碳价（当所有API不可用时使用）
function getDefaultCarbonPricing(): CarbonPricing {
  return {
    euEtsPrice: 78.5,
    chinaEtsPrice: 8.2,
    exchangeRate: 7.56,
    effectiveCarbonPrice: 70.3,
    updatedAt: new Date().toISOString().slice(0, 10),
  };
}

// 主入口：获取最新碳价
export async function fetchLatestCarbonPricing(): Promise<CarbonPricing> {
  const defaultPricing = getDefaultCarbonPricing();
  
  const [euPrice, chinaCnyPrice, eurCnyRate] = await Promise.all([
    fetchEuEtsPrice(),
    fetchChinaCarbonPrice(),
    fetchEurCnyRate(),
  ]);
  
  const euEtsPrice = euPrice ?? defaultPricing.euEtsPrice;
  const exchangeRate = eurCnyRate ?? defaultPricing.exchangeRate;
  
  // 中国碳市场美元价格 = CNY / 汇率
  const chinaCny = chinaCnyPrice ?? (defaultPricing.chinaEtsPrice * defaultPricing.exchangeRate);
  const chinaEtsPrice = Math.round((chinaCny / exchangeRate) * 100) / 100;
  
  const effectiveCarbonPrice = Math.round((euEtsPrice - chinaEtsPrice) * 100) / 100;

  const pricing: CarbonPricing = {
    euEtsPrice,
    chinaEtsPrice,
    exchangeRate,
    effectiveCarbonPrice,
    updatedAt: new Date().toISOString().slice(0, 10),
  };

  logger.info('[CBAMUpdater] \u78b3\u4ef7\u66f4\u65b0: EU ETS=' + euEtsPrice + ' EUR/t, \u4e2d\u56fd=' + chinaEtsPrice + ' EUR/t, \u6c47\u7387=' + exchangeRate);

  return pricing;
}

// 通知 CBAM 计算引擎使用最新价格
// 目前 cbamCalculator.ts 中 getCarbonPricing 返回硬编码值
// 这个函数未来可以替换掉硬编码逻辑
let _latestPricing: CarbonPricing | null = null;

export function getLatestCarbonPricing(): CarbonPricing {
  return _latestPricing ?? getDefaultCarbonPricing();
}

export async function updateCarbonPricing(): Promise<boolean> {
  try {
    _latestPricing = await fetchLatestCarbonPricing();
    logger.info('[CBAMUpdater] \u78b3\u4ef7\u5df2\u66f4\u65b0: ' + _latestPricing.updatedAt);
    return true;
  } catch (err: any) {
    logger.warn('[CBAMUpdater] \u78b3\u4ef7\u66f4\u65b0\u5931\u8d25', err.message);
    return false;
  }
}
