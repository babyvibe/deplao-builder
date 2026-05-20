"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isImageFile = exports.convertThreadType = exports.IMAGE_EXTENSION = void 0;
const zca_js_1 = require("zca-js");
const path_1 = __importDefault(require("path"));
exports.IMAGE_EXTENSION = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];
const convertThreadType = (type) => {
    return type && type == 1 ? zca_js_1.ThreadType.Group : zca_js_1.ThreadType.User;
};
exports.convertThreadType = convertThreadType;
const isImageFile = (filePath) => {
    const ext = path_1.default.extname(filePath).toLowerCase();
    return exports.IMAGE_EXTENSION.includes(ext);
};
exports.isImageFile = isImageFile;
//# sourceMappingURL=Utils.js.map