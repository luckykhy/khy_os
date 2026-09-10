'use strict';

const content = "expect(tryOr(() => 42, 'x')).toBe(42));";
console.log('Before:', content);
const fixed = content.replace(/\)\)\.(toBe|toEqual|toBeTruthy|toBeFalsy|toContain|toMatch|toThrow|toBeDefined|toBeNull|toBeGreaterThan|toBeLessThan|toBeCloseTo|toStrictEqual|toHaveLength|toReject)\(/g, ').${1}(');
console.log('After:', fixed);
