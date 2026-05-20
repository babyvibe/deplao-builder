"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PancakeAdapter = void 0;
const axios_1 = __importDefault(require("axios"));
const IntegrationAdapter_1 = require("../IntegrationAdapter");
const Logger_1 = __importDefault(require("../../../utils/Logger"));
/**
 * Pancake POS/OMS adapter.
 * Credentials required: api_key (or accessToken), shopId
 * Base URL is fixed: https://pos.pages.fm/api/v1
 */
class PancakeAdapter extends IntegrationAdapter_1.IntegrationAdapter {
    constructor(config) {
        super(config);
        this.type = 'pancake';
        this.name = 'Pancake POS';
    }
    getBaseUrl() {
        return 'https://pos.pages.fm/api/v1';
    }
    getShopId() {
        const shopId = this.config.credentials.shopId || this.config.settings?.shopId;
        if (!shopId)
            throw new Error('Thieu Shop ID Pancake');
        return String(shopId);
    }
    getApiKey() {
        const key = this.config.credentials.api_key ||
            this.config.credentials.apiKey ||
            this.config.credentials.accessToken ||
            this.config.credentials.token;
        if (!key)
            throw new Error('Thieu api_key Pancake');
        return String(key);
    }
    getHeaders() {
        return {
            'X-Access-Token': this.getApiKey(),
            'Content-Type': 'application/json',
        };
    }
    buildUrl(path) {
        if (/^https?:\/\//i.test(path))
            return path;
        const baseUrl = this.getBaseUrl();
        let normalizedPath = path.startsWith('/') ? path : `/${path}`;
        // Backward-compatible: old paths may still include /v1 prefix
        if (/\/api\/v1$/i.test(baseUrl) && /^\/v1\//i.test(normalizedPath)) {
            normalizedPath = normalizedPath.replace(/^\/v1/i, '');
        }
        return `${baseUrl}${normalizedPath}`;
    }
    stringifySafe(obj) {
        try {
            if (obj == null)
                return '';
            if (typeof obj === 'string')
                return obj;
            const s = JSON.stringify(obj);
            return s.length > 600 ? `${s.slice(0, 600)}...` : s;
        }
        catch {
            return String(obj ?? '');
        }
    }
    formatError(e) {
        const method = e?.config?.method ? String(e.config.method).toUpperCase() : 'REQ';
        const url = e?.config?.url || e?.__url || '';
        const status = e?.response?.status;
        const statusText = e?.response?.statusText || '';
        const dataText = this.stringifySafe(e?.response?.data || e?.message || e);
        if (status) {
            return `[${status}${statusText ? ` ${statusText}` : ''}] ${method} ${url} | ${dataText}`;
        }
        return `${method} ${url} | ${dataText}`;
    }
    async request(method, path, payload) {
        const apiKey = this.getApiKey();
        const queryAuth = { api_key: apiKey };
        const config = {
            method,
            url: this.buildUrl(path),
            headers: this.getHeaders(),
            timeout: 15000,
            params: queryAuth,
        };
        if (method === 'GET')
            config.params = { ...queryAuth, ...(payload || {}) };
        if (method === 'POST')
            config.data = payload || {};
        try {
            const res = await axios_1.default.request(config);
            return res.data;
        }
        catch (e) {
            e.__url = config.url;
            e.__method = method;
            throw e;
        }
    }
    async requestWithFallback(method, paths, payload) {
        let lastError = null;
        const allErrors = [];
        for (const p of paths) {
            try {
                return await this.request(method, p, payload);
            }
            catch (e) {
                lastError = e;
                allErrors.push(this.formatError(e));
            }
        }
        if (allErrors.length > 0) {
            throw new Error(`All endpoints failed:\n${allErrors.join('\n')}`);
        }
        throw lastError || new Error('Pancake request failed');
    }
    unwrapList(data) {
        const scopes = [
            data,
            data?.data,
            data?.result,
            data?.response,
            data?.payload,
            data?.payload?.data,
            data?.data?.data,
        ];
        for (const s of scopes) {
            if (Array.isArray(s))
                return s;
            if (!s || typeof s !== 'object')
                continue;
            if (Array.isArray(s.items))
                return s.items;
            if (Array.isArray(s.results))
                return s.results;
            if (Array.isArray(s.customers))
                return s.customers;
            if (Array.isArray(s.orders))
                return s.orders;
            if (Array.isArray(s.products))
                return s.products;
            if (Array.isArray(s.variations))
                return s.variations;
            if (Array.isArray(s.list))
                return s.list;
            if (Array.isArray(s.rows))
                return s.rows;
            if (Array.isArray(s.entries))
                return s.entries;
        }
        return [];
    }
    assertApiSuccess(data, fallback) {
        if (data?.success === false) {
            const msg = data?.message || data?.error || fallback;
            throw new Error(msg);
        }
    }
    buildPagedMeta(data, page, pageSize) {
        const raw = data?.paging ||
            data?.pagination ||
            data?.meta ||
            data?.data?.paging ||
            data?.data?.pagination ||
            data?.data?.meta ||
            {};
        const total = Number(raw?.total ??
            raw?.total_count ??
            raw?.count ??
            raw?.item_count ??
            data?.total ??
            data?.total_entries ??
            data?.data?.total ??
            data?.data?.total_entries ??
            0);
        const totalPages = Number(raw?.total_pages ?? data?.total_pages ?? data?.data?.total_pages ?? 0);
        const listCount = this.unwrapList(data).length;
        return {
            page,
            pageSize,
            total: total > 0 ? total : undefined,
            hasNext: totalPages > 0
                ? page < totalPages
                : total > 0
                    ? page * pageSize < total
                    : listCount >= pageSize && listCount > 0,
        };
    }
    normalizeSearchText(value) {
        return String(value ?? '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd')
            .replace(/Đ/g, 'D')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }
    buildSearchCandidates(rawSearch) {
        const trimmed = String(rawSearch || '').trim();
        if (!trimmed)
            return [];
        const compact = trimmed.replace(/\s+/g, ' ');
        const folded = this.normalizeSearchText(compact);
        const variants = [compact, folded].filter(Boolean);
        return Array.from(new Set(variants));
    }
    matchesProductKeyword(product, keyword) {
        const needle = this.normalizeSearchText(keyword);
        if (!needle)
            return true;
        const nested = product?.product_info || product?.product || product?.item || {};
        const haystacks = [
            product?.name,
            product?.title,
            product?.fullName,
            product?.productName,
            product?.product_name,
            product?.variation_name,
            product?.display_name,
            product?.code,
            product?.sku,
            product?.barcode,
            product?.variation_id,
            product?.id,
            nested?.name,
            nested?.title,
            nested?.fullName,
            nested?.product_name,
            nested?.code,
            nested?.sku,
            nested?.barcode,
            nested?.id,
        ];
        return haystacks.some(value => this.normalizeSearchText(value).includes(needle));
    }
    dedupeProducts(products) {
        const seen = new Set();
        const rows = [];
        for (const product of products) {
            const key = String(product?.variation_id ??
                product?.id ??
                product?.sku ??
                product?.code ??
                product?.barcode ??
                product?.product_info?.id ??
                product?.product?.id ??
                rows.length);
            if (seen.has(key))
                continue;
            seen.add(key);
            rows.push(product);
        }
        return rows;
    }
    async fallbackLookupProductsByLocalScan(shopId, keyword, baseQuery, page, pageSize) {
        const scanPageSize = Math.max(pageSize, PancakeAdapter.LOCAL_PRODUCT_SCAN_PAGE_SIZE);
        const matched = [];
        let currentPage = 1;
        let maxPages = PancakeAdapter.LOCAL_PRODUCT_SCAN_MAX_PAGES;
        while (currentPage <= maxPages) {
            const data = await this.requestWithFallback('GET', [`/shops/${shopId}/products/variations`], {
                ...baseQuery,
                page_number: currentPage,
                page_size: scanPageSize,
            });
            this.assertApiSuccess(data, 'Pancake local product scan failed');
            const pageRows = this.unwrapList(data);
            if (!pageRows.length)
                break;
            matched.push(...pageRows.filter(row => this.matchesProductKeyword(row, keyword)));
            const totalPages = Number(data?.total_pages ?? data?.data?.total_pages ?? 0);
            if (totalPages > 0)
                maxPages = Math.min(maxPages, totalPages);
            if (pageRows.length < scanPageSize)
                break;
            currentPage += 1;
        }
        const deduped = this.dedupeProducts(matched);
        const start = Math.max(0, (page - 1) * pageSize);
        const end = start + pageSize;
        return {
            products: deduped.slice(start, end),
            page,
            pageSize,
            total: deduped.length,
            hasNext: end < deduped.length,
            fallback: true,
        };
    }
    buildVariationListQuery(params, defaultPageSize) {
        const page = Number(params.page_number ?? params.page ?? 1) || 1;
        const pageSize = Number(params.page_size ?? params.pageSize ?? params.limit ?? defaultPageSize) || defaultPageSize;
        const search = String(params.search ?? params.keyword ?? params.query ?? '').trim();
        const sellingStatus = String(params.selling_status ?? '').trim();
        const productStatus = String(params.product_status ?? '').trim();
        const query = {
            page_size: pageSize,
            page_number: page,
        };
        if (search)
            query.search = search;
        if (PancakeAdapter.VALID_SELLING_STATUSES.has(sellingStatus))
            query.selling_status = sellingStatus;
        if (PancakeAdapter.VALID_PRODUCT_STATUSES.has(productStatus))
            query.product_status = productStatus;
        return { page, pageSize, query };
    }
    logActionRaw(action, params, raw) {
        Logger_1.default.info(`[PancakeAdapter] ${action} params=${this.stringifySafe(params)} raw=${this.stringifySafe(raw)}`);
    }
    async testConnection() {
        try {
            const shopId = this.getShopId();
            const paths = [`/shops/${shopId}/orders`, `/shops/${shopId}/customers`];
            const data = await this.requestWithFallback('GET', paths, { page_size: 1, page_number: 1 });
            this.assertApiSuccess(data, 'Pancake testConnection failed');
            const shopName = data?.name ||
                data?.shop?.name ||
                data?.data?.name ||
                data?.data?.shop_name ||
                `Shop #${shopId}`;
            return { success: true, message: `Ket noi Pancake thanh cong - shop: ${shopName}` };
        }
        catch (e) {
            return { success: false, message: `Loi ket noi Pancake: ${this.formatError(e)}` };
        }
    }
    async executeAction(action, params) {
        const shopId = this.getShopId();
        switch (action) {
            case 'lookupCustomer': {
                const page = Number(params.page || 1);
                const pageSize = Number(params.limit || 10);
                const data = await this.requestWithFallback('GET', [`/shops/${shopId}/customers`], {
                    search: params.phone || params.query || '',
                    page_size: pageSize,
                    page_number: page,
                });
                this.logActionRaw('lookupCustomer', params, data);
                this.assertApiSuccess(data, 'Pancake lookupCustomer failed');
                const customers = this.unwrapList(data);
                return {
                    customers,
                    found: customers.length > 0,
                    firstCustomer: customers[0] || null,
                    ...this.buildPagedMeta(data, page, pageSize),
                };
            }
            case 'lookupOrder': {
                const orderIdRaw = params.orderId != null ? String(params.orderId).trim() : '';
                if (orderIdRaw) {
                    try {
                        const order = await this.requestWithFallback('GET', [`/shops/${shopId}/orders/${encodeURIComponent(orderIdRaw)}`]);
                        this.logActionRaw('lookupOrderById', params, order);
                        this.assertApiSuccess(order, 'Pancake lookupOrderById failed');
                        return { order, orders: order ? [order] : [], found: !!order };
                    }
                    catch (detailError) {
                        Logger_1.default.warn(`[PancakeAdapter] lookupOrderById fallback to search for key=${orderIdRaw} error=${this.formatError(detailError)}`);
                    }
                }
                const searchText = params.phone || orderIdRaw || params.query || '';
                const page = Number(params.page || 1);
                const pageSize = Number(params.limit || 10);
                const data = await this.requestWithFallback('GET', [`/shops/${shopId}/orders`], {
                    search: searchText,
                    page_size: pageSize,
                    page_number: page,
                    include_removed: params.includeRemoved ?? 1,
                });
                this.logActionRaw('lookupOrder', { ...params, search: searchText }, data);
                this.assertApiSuccess(data, 'Pancake lookupOrder failed');
                const orders = this.unwrapList(data);
                return {
                    orders,
                    order: orders[0] || null,
                    found: orders.length > 0,
                    ...this.buildPagedMeta(data, page, pageSize),
                };
            }
            case 'lookupProduct': {
                if (params.code) {
                    const product = await this.requestWithFallback('GET', [`/shops/${shopId}/products/${encodeURIComponent(String(params.code))}`]);
                    this.logActionRaw('lookupProductBySku', params, product);
                    this.assertApiSuccess(product, 'Pancake lookupProductBySku failed');
                    return { products: product ? [product] : [], found: !!product };
                }
                const { page, pageSize, query } = this.buildVariationListQuery(params, 10);
                const baseQuery = { ...query };
                delete baseQuery.search;
                const searchCandidates = this.buildSearchCandidates(query.search || '');
                let lastData = null;
                let products = [];
                let usedSearch = query.search || '';
                if (searchCandidates.length > 0) {
                    for (const candidate of searchCandidates) {
                        usedSearch = candidate;
                        const candidateQuery = { ...baseQuery, search: candidate };
                        const data = await this.requestWithFallback('GET', [`/shops/${shopId}/products/variations`], candidateQuery);
                        this.logActionRaw('lookupProduct', { ...params, ...candidateQuery }, data);
                        this.assertApiSuccess(data, 'Pancake lookupProduct failed');
                        lastData = data;
                        products = this.unwrapList(data);
                        if (products.length > 0) {
                            return { products, found: true, ...this.buildPagedMeta(data, page, pageSize) };
                        }
                    }
                    const fallback = await this.fallbackLookupProductsByLocalScan(shopId, usedSearch, baseQuery, page, pageSize);
                    Logger_1.default.info(`[PancakeAdapter] lookupProduct fallback local-scan keyword=${this.stringifySafe(usedSearch)} total=${fallback.total}`);
                    return { ...fallback, found: fallback.products.length > 0 };
                }
                const data = await this.requestWithFallback('GET', [`/shops/${shopId}/products/variations`], query);
                this.logActionRaw('lookupProduct', { ...params, ...query }, data);
                this.assertApiSuccess(data, 'Pancake lookupProduct failed');
                lastData = data;
                products = this.unwrapList(data);
                return { products, found: products.length > 0, ...this.buildPagedMeta(lastData, page, pageSize) };
            }
            case 'getProducts': {
                const { page, pageSize, query } = this.buildVariationListQuery(params, 20);
                const data = await this.requestWithFallback('GET', [`/shops/${shopId}/products/variations`], query);
                this.logActionRaw('getProducts', { ...params, ...query }, data);
                this.assertApiSuccess(data, 'Pancake getProducts failed');
                const products = this.unwrapList(data);
                return { products, ...this.buildPagedMeta(data, page, pageSize) };
            }
            case 'createOrder': {
                const payload = { ...(params?.order ? params.order : params), shop_id: Number(shopId) };
                const data = await this.requestWithFallback('POST', [`/shops/${shopId}/orders`], payload);
                return { order: data?.data || data, success: data?.success !== false };
            }
            default:
                throw new Error(`Pancake khong ho tro action: ${action}`);
        }
    }
}
exports.PancakeAdapter = PancakeAdapter;
PancakeAdapter.VALID_SELLING_STATUSES = new Set(['none', 'bad', 'normal', 'star']);
PancakeAdapter.VALID_PRODUCT_STATUSES = new Set(['locked', 'not_locked']);
PancakeAdapter.LOCAL_PRODUCT_SCAN_MAX_PAGES = 5;
PancakeAdapter.LOCAL_PRODUCT_SCAN_PAGE_SIZE = 100;
//# sourceMappingURL=PancakeAdapter.js.map