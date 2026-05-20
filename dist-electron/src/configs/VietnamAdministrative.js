"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripAdministrativePrefix = stripAdministrativePrefix;
exports.getProvinces = getProvinces;
exports.getDistricts = getDistricts;
exports.getWards = getWards;
exports.getProvinceName = getProvinceName;
exports.getDistrictName = getDistrictName;
exports.getWardName = getWardName;
exports.getProvinceShortName = getProvinceShortName;
exports.getDistrictShortName = getDistrictShortName;
exports.getWardShortName = getWardShortName;
const tinh_tp_json_1 = __importDefault(require("./hanhchinhVN/tinh_tp.json"));
const quan_huyen_json_1 = __importDefault(require("./hanhchinhVN/quan_huyen.json"));
const xa_phuong_json_1 = __importDefault(require("./hanhchinhVN/xa_phuong.json"));
const provincesRaw = tinh_tp_json_1.default;
const districtsRaw = quan_huyen_json_1.default;
const wardsRaw = xa_phuong_json_1.default;
const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
function sortByCode(a, b) {
    const aCode = Number(a.id);
    const bCode = Number(b.id);
    if (Number.isFinite(aCode) && Number.isFinite(bCode) && aCode !== bCode) {
        return aCode - bCode;
    }
    return collator.compare(a.name, b.name);
}
function normalizeWhitespace(value) {
    return value.replace(/\s+/g, ' ').trim();
}
function toDivision(raw) {
    const id = String(raw?.code ?? '').trim();
    const shortName = normalizeWhitespace(String(raw?.name ?? '').trim());
    const fullName = normalizeWhitespace(String(raw?.name_with_type ?? shortName).trim());
    if (!id || !shortName)
        return null;
    return {
        id,
        name: fullName || shortName,
        shortName,
        type: raw?.type,
        slug: raw?.slug,
        parentId: raw?.parent_code,
    };
}
function buildList(source) {
    return Object.values(source)
        .map(toDivision)
        .filter((row) => !!row)
        .sort(sortByCode);
}
const provinces = buildList(provincesRaw);
const districts = buildList(districtsRaw);
const wards = buildList(wardsRaw);
const provinceById = new Map(provinces.map(row => [row.id, row]));
const districtById = new Map(districts.map(row => [row.id, row]));
const wardById = new Map(wards.map(row => [row.id, row]));
const districtsByProvince = new Map();
for (const district of districts) {
    const key = district.parentId || '';
    if (!key)
        continue;
    const bucket = districtsByProvince.get(key) || [];
    bucket.push(district);
    districtsByProvince.set(key, bucket);
}
const wardsByDistrict = new Map();
for (const ward of wards) {
    const key = ward.parentId || '';
    if (!key)
        continue;
    const bucket = wardsByDistrict.get(key) || [];
    bucket.push(ward);
    wardsByDistrict.set(key, bucket);
}
const PREFIX_PATTERNS = {
    province: /^(tỉnh|thành phố|tp\.?)\s+/i,
    district: /^(quận|huyện|thị xã|tx\.?|thành phố|tp\.?)\s+/i,
    ward: /^(phường|xã|thị trấn)\s+/i,
};
function stripAdministrativePrefix(value, level) {
    return normalizeWhitespace(String(value || '').trim()).replace(PREFIX_PATTERNS[level], '');
}
function getProvinces() {
    return provinces;
}
function getDistricts(provinceId) {
    return districtsByProvince.get(String(provinceId || '').trim()) || [];
}
function getWards(_provinceId, districtId) {
    return wardsByDistrict.get(String(districtId || '').trim()) || [];
}
function getProvinceName(id) {
    return provinceById.get(String(id || '').trim())?.name || '';
}
function getDistrictName(_provinceId, districtId) {
    return districtById.get(String(districtId || '').trim())?.name || '';
}
function getWardName(_provinceId, _districtId, wardId) {
    return wardById.get(String(wardId || '').trim())?.name || '';
}
function getProvinceShortName(id) {
    return provinceById.get(String(id || '').trim())?.shortName || '';
}
function getDistrictShortName(_provinceId, districtId) {
    return districtById.get(String(districtId || '').trim())?.shortName || '';
}
function getWardShortName(_provinceId, _districtId, wardId) {
    return wardById.get(String(wardId || '').trim())?.shortName || '';
}
//# sourceMappingURL=VietnamAdministrative.js.map