"use strict";
// Integration adapter interface and shared types
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntegrationAdapter = void 0;
class IntegrationAdapter {
    constructor(config) {
        this.config = config;
    }
    updateConfig(config) {
        this.config = config;
    }
    isEnabled() {
        return this.config.enabled;
    }
}
exports.IntegrationAdapter = IntegrationAdapter;
//# sourceMappingURL=IntegrationAdapter.js.map