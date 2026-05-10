import { ThreadType } from "zca-js";
import path from "path";

export const IMAGE_EXTENSION = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];

export const convertThreadType = (type?: ThreadType | number): ThreadType => {
    return type && type == 1 ? ThreadType.Group : ThreadType.User;
}

export const isImageFile = (filePath: string): boolean => {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSION.includes(ext);
}