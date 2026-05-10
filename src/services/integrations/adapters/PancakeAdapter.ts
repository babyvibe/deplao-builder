import axios, { AxiosRequestConfig } from 'axios';
import { IntegrationAdapter, IntegrationConfig, TestResult } from '../IntegrationAdapter';
import Logger from '../../../utils/Logger';

/**
 * Pancake POS/OMS adapter.
 * Credentials required: api_key (or accessToken), shopId
 * Base URL is fixed: https://pos.pages.fm/api/v1
 */
export class PancakeAdapter extends IntegrationAdapter {
  readonly type = 'pancake';
  readonly name = 'Pancake POS';
  private static readonly VALID_SELLING_STATUSES = new Set(['none', 'bad', 'normal', 'star']);
  private static readonly VALID_PRODUCT_STATUSES = new Set(['locked', 'not_locked']);
  private static readonly LOCAL_PRODUCT_SCAN_MAX_PAGES = 5;
  private static readonly LOCAL_PRODUCT_SCAN_PAGE_SIZE = 100;

  constructor(config: IntegrationConfig) {
    super(config);
  }

  private getBaseUrl(): string {
    return 'https://pos.pages.fm/api/v1';
  }

  private getShopId(): string {
    const shopId = this.config.credentials.shopId || this.config.settings?.shopId;
    if (!shopId) throw new Error('Thieu Shop ID Pancake');
    return String(shopId);
  }

  private getApiKey(): string {
    const key =
      this.config.credentials.api_key ||
      this.config.credentials.apiKey ||
      this.config.credentials.accessToken ||
      this.config.credentials.token;
    if (!key) throw new Error('Thieu api_key Pancake');
    return String(key);
  }

  private getHeaders() {
    return {
      'X-Access-Token': this.getApiKey(),
      'Content-Type': 'application/json',
    };
  }

  private buildUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const baseUrl = this.getBaseUrl();
    let normalizedPath = path.startsWith('/') ? path : `/${path}`;

    // Backward-compatible: old paths may still include /v1 prefix
    if (/\/api\/v1$/i.test(baseUrl) && /^\/v1\//i.test(normalizedPath)) {
      normalizedPath = normalizedPath.replace(/^\/v1/i, '');
    }

    return `${baseUrl}${normalizedPath}`;
  }

  private stringifySafe(obj: any): string {
    try {
      if (obj == null) return '';
      if (typeof obj === 'string') return obj;
      const s = JSON.stringify(obj);
      return s.length > 600 ? `${s.slice(0, 600)}...` : s;
    } catch {
      return String(obj ?? '');
    }
  }

  private formatError(e: any): string {
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

  private async request(method: 'GET' | 'POST', path: string, payload?: Record<string, any>): Promise<any> {
    const apiKey = this.getApiKey();
    const queryAuth = { api_key: apiKey };
    const config: AxiosRequestConfig = {
      method,
      url: this.buildUrl(path),
      headers: this.getHeaders(),
      timeout: 15000,
      params: queryAuth,
    };

    if (method === 'GET') config.params = { ...queryAuth, ...(payload || {}) };
    if (method === 'POST') config.data = payload || {};

    try {
      const res = await axios.request(config);
      return res.data;
    } catch (e: any) {
      e.__url = config.url;
      e.__method = method;
      throw e;
    }
  }

  private async requestWithFallback(
    method: 'GET' | 'POST',
    paths: string[],
    payload?: Record<string, any>,
  ): Promise<any> {
    let lastError: any = null;
    const allErrors: string[] = [];

    for (const p of paths) {
      try {
        return await this.request(method, p, payload);
      } catch (e: any) {
        lastError = e;
        allErrors.push(this.formatError(e));
      }
    }

    if (allErrors.length > 0) {
      throw new Error(`All endpoints failed:\n${allErrors.join('\n')}`);
    }

    throw lastError || new Error('Pancake request failed');
  }

  private unwrapList(data: any): any[] {
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
      if (Array.isArray(s)) return s;
      if (!s || typeof s !== 'object') continue;
      if (Array.isArray(s.items)) return s.items;
      if (Array.isArray(s.results)) return s.results;
      if (Array.isArray(s.customers)) return s.customers;
      if (Array.isArray(s.orders)) return s.orders;
      if (Array.isArray(s.products)) return s.products;
      if (Array.isArray(s.variations)) return s.variations;
      if (Array.isArray(s.list)) return s.list;
      if (Array.isArray(s.rows)) return s.rows;
      if (Array.isArray(s.entries)) return s.entries;
    }

    return [];
  }

  private assertApiSuccess(data: any, fallback: string): void {
    if (data?.success === false) {
      const msg = data?.message || data?.error || fallback;
      throw new Error(msg);
    }
  }

  private buildPagedMeta(data: any, page: number, pageSize: number) {
    const raw =
      data?.paging ||
      data?.pagination ||
      data?.meta ||
      data?.data?.paging ||
      data?.data?.pagination ||
      data?.data?.meta ||
      {};
    const total = Number(
      raw?.total ??
      raw?.total_count ??
      raw?.count ??
      raw?.item_count ??
      data?.total ??
      data?.total_entries ??
      data?.data?.total ??
      data?.data?.total_entries ??
      0,
    );
    const totalPages = Number(raw?.total_pages ?? data?.total_pages ?? data?.data?.total_pages ?? 0);
    const listCount = this.unwrapList(data).length;
    return {
      page,
      pageSize,
      total: total > 0 ? total : undefined,
      hasNext:
        totalPages > 0
          ? page < totalPages
          : total > 0
          ? page * pageSize < total
          : listCount >= pageSize && listCount > 0,
    };
  }

  private normalizeSearchText(value: any): string {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private buildSearchCandidates(rawSearch: string): string[] {
    const trimmed = String(rawSearch || '').trim();
    if (!trimmed) return [];

    const compact = trimmed.replace(/\s+/g, ' ');
    const folded = this.normalizeSearchText(compact);
    const variants = [compact, folded].filter(Boolean);

    return Array.from(new Set(variants));
  }

  private matchesProductKeyword(product: any, keyword: string): boolean {
    const needle = this.normalizeSearchText(keyword);
    if (!needle) return true;

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

  private dedupeProducts(products: any[]): any[] {
    const seen = new Set<string>();
    const rows: any[] = [];

    for (const product of products) {
      const key = String(
        product?.variation_id ??
        product?.id ??
        product?.sku ??
        product?.code ??
        product?.barcode ??
        product?.product_info?.id ??
        product?.product?.id ??
        rows.length,
      );
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(product);
    }

    return rows;
  }

  private async fallbackLookupProductsByLocalScan(
    shopId: string,
    keyword: string,
    baseQuery: Record<string, any>,
    page: number,
    pageSize: number,
  ): Promise<{ products: any[]; page: number; pageSize: number; total: number; hasNext: boolean; fallback: true }> {
    const scanPageSize = Math.max(pageSize, PancakeAdapter.LOCAL_PRODUCT_SCAN_PAGE_SIZE);
    const matched: any[] = [];
    let currentPage = 1;
    let maxPages = PancakeAdapter.LOCAL_PRODUCT_SCAN_MAX_PAGES;

    while (currentPage <= maxPages) {
      const data = await this.requestWithFallback(
        'GET',
        [`/shops/${shopId}/products/variations`],
        {
          ...baseQuery,
          page_number: currentPage,
          page_size: scanPageSize,
        },
      );
      this.assertApiSuccess(data, 'Pancake local product scan failed');
      const pageRows = this.unwrapList(data);
      if (!pageRows.length) break;

      matched.push(...pageRows.filter(row => this.matchesProductKeyword(row, keyword)));

      const totalPages = Number(data?.total_pages ?? data?.data?.total_pages ?? 0);
      if (totalPages > 0) maxPages = Math.min(maxPages, totalPages);
      if (pageRows.length < scanPageSize) break;
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

  private buildVariationListQuery(params: Record<string, any>, defaultPageSize: number) {
    const page = Number(params.page_number ?? params.page ?? 1) || 1;
    const pageSize = Number(params.page_size ?? params.pageSize ?? params.limit ?? defaultPageSize) || defaultPageSize;
    const search = String(params.search ?? params.keyword ?? params.query ?? '').trim();
    const sellingStatus = String(params.selling_status ?? '').trim();
    const productStatus = String(params.product_status ?? '').trim();

    const query: Record<string, any> = {
      page_size: pageSize,
      page_number: page,
    };

    if (search) query.search = search;
    if (PancakeAdapter.VALID_SELLING_STATUSES.has(sellingStatus)) query.selling_status = sellingStatus;
    if (PancakeAdapter.VALID_PRODUCT_STATUSES.has(productStatus)) query.product_status = productStatus;

    return { page, pageSize, query };
  }

  private logActionRaw(action: string, params: Record<string, any>, raw: any): void {
    Logger.info(
      `[PancakeAdapter] ${action} params=${this.stringifySafe(params)} raw=${this.stringifySafe(raw)}`,
    );
  }

  async testConnection(): Promise<TestResult> {
    try {
      const shopId = this.getShopId();
      const paths = [`/shops/${shopId}/orders`, `/shops/${shopId}/customers`];
      const data = await this.requestWithFallback('GET', paths, { page_size: 1, page_number: 1 });
      this.assertApiSuccess(data, 'Pancake testConnection failed');
      const shopName =
        data?.name ||
        data?.shop?.name ||
        data?.data?.name ||
        data?.data?.shop_name ||
        `Shop #${shopId}`;

      return { success: true, message: `Ket noi Pancake thanh cong - shop: ${shopName}` };
    } catch (e: any) {
      return { success: false, message: `Loi ket noi Pancake: ${this.formatError(e)}` };
    }
  }

  async executeAction(action: string, params: Record<string, any>): Promise<any> {
    const shopId = this.getShopId();

    switch (action) {
      case 'lookupCustomer': {
        const page = Number(params.page || 1);
        const pageSize = Number(params.limit || 10);
        const data = await this.requestWithFallback(
          'GET',
          [`/shops/${shopId}/customers`],
          {
            search: params.phone || params.query || '',
            page_size: pageSize,
            page_number: page,
          },
        );
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
            const order = await this.requestWithFallback(
              'GET',
              [`/shops/${shopId}/orders/${encodeURIComponent(orderIdRaw)}`],
            );
            this.logActionRaw('lookupOrderById', params, order);
            this.assertApiSuccess(order, 'Pancake lookupOrderById failed');
            return { order, orders: order ? [order] : [], found: !!order };
          } catch (detailError: any) {
            Logger.warn(
              `[PancakeAdapter] lookupOrderById fallback to search for key=${orderIdRaw} error=${this.formatError(detailError)}`,
            );
          }
        }

        const searchText = params.phone || orderIdRaw || params.query || '';
        const page = Number(params.page || 1);
        const pageSize = Number(params.limit || 10);
        const data = await this.requestWithFallback(
          'GET',
          [`/shops/${shopId}/orders`],
          {
            search: searchText,
            page_size: pageSize,
            page_number: page,
            include_removed: params.includeRemoved ?? 1,
          },
        );
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
          const product = await this.requestWithFallback(
            'GET',
            [`/shops/${shopId}/products/${encodeURIComponent(String(params.code))}`],
          );
          this.logActionRaw('lookupProductBySku', params, product);
          this.assertApiSuccess(product, 'Pancake lookupProductBySku failed');
          return { products: product ? [product] : [], found: !!product };
        }

        const { page, pageSize, query } = this.buildVariationListQuery(params, 10);
        const baseQuery = { ...query };
        delete baseQuery.search;

        const searchCandidates = this.buildSearchCandidates(query.search || '');
        let lastData: any = null;
        let products: any[] = [];
        let usedSearch = query.search || '';

        if (searchCandidates.length > 0) {
          for (const candidate of searchCandidates) {
            usedSearch = candidate;
            const candidateQuery = { ...baseQuery, search: candidate };
            const data = await this.requestWithFallback(
              'GET',
              [`/shops/${shopId}/products/variations`],
              candidateQuery,
            );
            this.logActionRaw('lookupProduct', { ...params, ...candidateQuery }, data);
            this.assertApiSuccess(data, 'Pancake lookupProduct failed');
            lastData = data;
            products = this.unwrapList(data);
            if (products.length > 0) {
              return { products, found: true, ...this.buildPagedMeta(data, page, pageSize) };
            }
          }

          const fallback = await this.fallbackLookupProductsByLocalScan(shopId, usedSearch, baseQuery, page, pageSize);
          Logger.info(
            `[PancakeAdapter] lookupProduct fallback local-scan keyword=${this.stringifySafe(usedSearch)} total=${fallback.total}`,
          );
          return { ...fallback, found: fallback.products.length > 0 };
        }

        const data = await this.requestWithFallback(
          'GET',
          [`/shops/${shopId}/products/variations`],
          query,
        );
        this.logActionRaw('lookupProduct', { ...params, ...query }, data);
        this.assertApiSuccess(data, 'Pancake lookupProduct failed');
        lastData = data;
        products = this.unwrapList(data);
        return { products, found: products.length > 0, ...this.buildPagedMeta(lastData, page, pageSize) };
      }

      case 'getProducts': {
        const { page, pageSize, query } = this.buildVariationListQuery(params, 20);
        const data = await this.requestWithFallback(
          'GET',
          [`/shops/${shopId}/products/variations`],
          query,
        );
        this.logActionRaw('getProducts', { ...params, ...query }, data);
        this.assertApiSuccess(data, 'Pancake getProducts failed');
        const products = this.unwrapList(data);
        return { products, ...this.buildPagedMeta(data, page, pageSize) };
      }

      case 'createOrder': {
        const payload = { ...(params?.order ? params.order : params), shop_id: Number(shopId) };
        const data = await this.requestWithFallback(
          'POST',
          [`/shops/${shopId}/orders`],
          payload,
        );
        return { order: data?.data || data, success: data?.success !== false };
      }

      default:
        throw new Error(`Pancake khong ho tro action: ${action}`);
    }
  }
}
