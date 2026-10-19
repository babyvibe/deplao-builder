/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  preset: 'ts-jest', // Sử dụng preset của ts-jest
  testEnvironment: 'node', // Môi trường chạy test là Node.js
  transform: {
    // tsconfig.jest.json bật isolatedModules → ts-jest chỉ transpile, không type-check từng file
    // (giảm RAM mỗi worker từ ~400 MB xuống ~100 MB, chạy nhanh hơn). Lỗi type bắt bằng `npx tsc --noEmit`.
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: 'tsconfig.jest.json' }],
  },
  testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'], // Đường dẫn đến các tệp test
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/ui/$1', // alias "@/..." của tsconfig.json (paths)
  },
  // Giới hạn tài nguyên: máy dev 32 GB dùng chung IDE/Chrome/Claude.
  // Mặc định Jest mở (số CPU − 1) = 15 worker → 5–7 GB RAM và treo máy.
  maxWorkers: 2,
  workerIdleMemoryLimit: '512MB', // Jest ≥ 29.4: tự khởi động lại worker khi phình quá mức
};
