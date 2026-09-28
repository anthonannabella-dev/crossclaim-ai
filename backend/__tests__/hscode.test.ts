
import { inferCategory } from '../src/services/hsCodeUpdater';

describe('HS Code Category', () => {
  test('Chapter 01-24 should be 农产品', () => {
    expect(inferCategory(1)).toBe('农产品');
    expect(inferCategory(24)).toBe('农产品');
  });
  test('Chapter 72-83 should be 金属制品', () => {
    expect(inferCategory(72)).toBe('金属制品');
    expect(inferCategory(83)).toBe('金属制品');
  });
  test('Chapter 84-85 should be 机电产品', () => {
    expect(inferCategory(84)).toBe('机电产品');
    expect(inferCategory(85)).toBe('机电产品');
  });
  test('Chapter 71 should be 贵金属', () => {
    expect(inferCategory(71)).toBe('贵金属');
  });
  test('Chapter 77 (reserved) should be 工业品', () => {
    // 77 是保留章
  });
  test('Chapter beyond 97 should be 工业品', () => {
    expect(inferCategory(99)).toBe('工业品');
  });
});
