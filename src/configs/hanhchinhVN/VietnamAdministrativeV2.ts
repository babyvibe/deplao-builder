/**
 * Vietnam administrative units after the 01/07/2025 reorganisation: 34 provinces, 3,321 commune-level units
 * (687 phường, 2,621 xã, 13 đặc khu), no district level.
 *
 * Data: v2/tinh_xa.json, compacted from https://provinces.open-api.vn/api/v2/?depth=2 (official statistics office codes),
 * fetched 2026-11-13. Format: [provinceCode, provinceName, [[wardCode, wardName], …]][], one province per line.
 * The old 3-level data (63 provinces / 705 districts / 10,599 wards) stays in VietnamAdministrative.ts for old addresses.
 */
import source from './v2/tinh_xa.json';
import type { Division } from './VietnamAdministrative';

type RawProvince = [number, string, Array<[number, string]>];

const PROVINCE_PREFIX = /^(tỉnh|thành phố)\s+/i;
const WARD_PREFIX = /^(phường|xã|đặc khu)\s+/i;
const WARD_TYPE: Array<[RegExp, string]> = [[/^phường\s/i, 'phuong'], [/^xã\s/i, 'xa'], [/^đặc khu\s/i, 'dac-khu']];

const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
const pad = (code: number, length: number): string => String(code).padStart(length, '0');

const provinces: Division[] = [];
const provinceById = new Map<string, Division>();
const wardsByProvince = new Map<string, Division[]>();
const wardById = new Map<string, Division>();

for (const [provinceCode, provinceName, wardRows] of source as RawProvince[]) {
  const province: Division = {
    id: pad(provinceCode, 2),
    name: provinceName,
    shortName: provinceName.replace(PROVINCE_PREFIX, ''),
    type: /^thành phố\s/i.test(provinceName) ? 'thanh-pho' : 'tinh',
  };
  provinces.push(province);
  provinceById.set(province.id, province);

  const wards = wardRows.map(([wardCode, wardName]): Division => ({
    id: pad(wardCode, 5),
    name: wardName,
    shortName: wardName.replace(WARD_PREFIX, ''),
    type: WARD_TYPE.find(([re]) => re.test(wardName))?.[1],
    parentId: province.id,
  }));
  // Alphabetical inside a province: 168 wards in Hồ Chí Minh are easier to find by name than by code
  wards.sort((a, b) => collator.compare(a.shortName, b.shortName));
  wardsByProvince.set(province.id, wards);
  for (const ward of wards) wardById.set(ward.id, ward);
}

/** The 34 provinces, in the official code order (Hà Nội … Cà Mau). */
export function getProvincesV2(): Division[] {
  return provinces;
}

/** Commune-level units (phường / xã / đặc khu) of a province, alphabetical. */
export function getWardsV2(provinceId: string): Division[] {
  return wardsByProvince.get(String(provinceId || '').trim()) || [];
}

export function getProvinceNameV2(id: string): string {
  return provinceById.get(String(id || '').trim())?.name || '';
}

export function getWardNameV2(id: string): string {
  return wardById.get(String(id || '').trim())?.name || '';
}
