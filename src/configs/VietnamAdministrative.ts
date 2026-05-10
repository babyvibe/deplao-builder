import provinceSource from './hanhchinhVN/tinh_tp.json';
import districtSource from './hanhchinhVN/quan_huyen.json';
import wardSource from './hanhchinhVN/xa_phuong.json';

export interface Division {
  id: string;
  name: string;
  shortName: string;
  type?: string;
  slug?: string;
  parentId?: string;
}

interface RawAdministrativeUnit {
  name?: string;
  name_with_type?: string;
  code?: string;
  type?: string;
  slug?: string;
  parent_code?: string;
}

type RawAdministrativeMap = Record<string, RawAdministrativeUnit>;
type DivisionLevel = 'province' | 'district' | 'ward';

const provincesRaw = provinceSource as RawAdministrativeMap;
const districtsRaw = districtSource as RawAdministrativeMap;
const wardsRaw = wardSource as RawAdministrativeMap;

const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });

function sortByCode(a: Division, b: Division): number {
  const aCode = Number(a.id);
  const bCode = Number(b.id);
  if (Number.isFinite(aCode) && Number.isFinite(bCode) && aCode !== bCode) {
    return aCode - bCode;
  }
  return collator.compare(a.name, b.name);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function toDivision(raw: RawAdministrativeUnit): Division | null {
  const id = String(raw?.code ?? '').trim();
  const shortName = normalizeWhitespace(String(raw?.name ?? '').trim());
  const fullName = normalizeWhitespace(String(raw?.name_with_type ?? shortName).trim());
  if (!id || !shortName) return null;

  return {
    id,
    name: fullName || shortName,
    shortName,
    type: raw?.type,
    slug: raw?.slug,
    parentId: raw?.parent_code,
  };
}

function buildList(source: RawAdministrativeMap): Division[] {
  return Object.values(source)
    .map(toDivision)
    .filter((row): row is Division => !!row)
    .sort(sortByCode);
}

const provinces = buildList(provincesRaw);
const districts = buildList(districtsRaw);
const wards = buildList(wardsRaw);

const provinceById = new Map(provinces.map(row => [row.id, row]));
const districtById = new Map(districts.map(row => [row.id, row]));
const wardById = new Map(wards.map(row => [row.id, row]));

const districtsByProvince = new Map<string, Division[]>();
for (const district of districts) {
  const key = district.parentId || '';
  if (!key) continue;
  const bucket = districtsByProvince.get(key) || [];
  bucket.push(district);
  districtsByProvince.set(key, bucket);
}

const wardsByDistrict = new Map<string, Division[]>();
for (const ward of wards) {
  const key = ward.parentId || '';
  if (!key) continue;
  const bucket = wardsByDistrict.get(key) || [];
  bucket.push(ward);
  wardsByDistrict.set(key, bucket);
}

const PREFIX_PATTERNS: Record<DivisionLevel, RegExp> = {
  province: /^(tỉnh|thành phố|tp\.?)\s+/i,
  district: /^(quận|huyện|thị xã|tx\.?|thành phố|tp\.?)\s+/i,
  ward: /^(phường|xã|thị trấn)\s+/i,
};

export function stripAdministrativePrefix(value: string, level: DivisionLevel): string {
  return normalizeWhitespace(String(value || '').trim()).replace(PREFIX_PATTERNS[level], '');
}

export function getProvinces(): Division[] {
  return provinces;
}

export function getDistricts(provinceId: string): Division[] {
  return districtsByProvince.get(String(provinceId || '').trim()) || [];
}

export function getWards(_provinceId: string, districtId: string): Division[] {
  return wardsByDistrict.get(String(districtId || '').trim()) || [];
}

export function getProvinceName(id: string): string {
  return provinceById.get(String(id || '').trim())?.name || '';
}

export function getDistrictName(_provinceId: string, districtId: string): string {
  return districtById.get(String(districtId || '').trim())?.name || '';
}

export function getWardName(_provinceId: string, _districtId: string, wardId: string): string {
  return wardById.get(String(wardId || '').trim())?.name || '';
}

export function getProvinceShortName(id: string): string {
  return provinceById.get(String(id || '').trim())?.shortName || '';
}

export function getDistrictShortName(_provinceId: string, districtId: string): string {
  return districtById.get(String(districtId || '').trim())?.shortName || '';
}

export function getWardShortName(_provinceId: string, _districtId: string, wardId: string): string {
  return wardById.get(String(wardId || '').trim())?.shortName || '';
}

