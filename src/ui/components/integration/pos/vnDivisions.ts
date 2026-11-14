import {
  getProvinces,
  getDistricts,
  getWards,
  getProvinceName,
  getDistrictName,
  getWardName,
  getProvinceShortName,
  getDistrictShortName,
  getWardShortName,
  stripAdministrativePrefix,
  type Division,
} from '../../../../configs/hanhchinhVN/VietnamAdministrative';
import {
  getProvincesV2,
  getWardsV2,
  getProvinceNameV2,
  getWardNameV2,
} from '../../../../configs/hanhchinhVN/VietnamAdministrativeV2';

export type { Division };
export {
  getProvinces,
  getDistricts,
  getWards,
  getProvinceName,
  getDistrictName,
  getWardName,
  getProvinceShortName,
  getDistrictShortName,
  getWardShortName,
  stripAdministrativePrefix,
  // 2-level units after 01/07/2025 (no district)
  getProvincesV2,
  getWardsV2,
  getProvinceNameV2,
  getWardNameV2,
};
