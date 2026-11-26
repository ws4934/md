import type {
  MarketplaceItemDetail,
  MarketplaceItemType,
  MarketplaceListParams,
  MarketplaceListResponse,
  MyMarketplaceResponse,
  PublishComponentPayload,
  PublishThemePayload,
  UpdateMarketplacePayload,
} from './types'
import { t } from '@/i18n/translate'
import { ApiError, MdApiClient } from '@/services/account/client'
import { isAccountConfigured } from '@/services/account/config'

export function hasDesktopMarketplaceBridge(): boolean {
  return typeof window !== `undefined` && Boolean(window.mdDesktop?.marketplace)
}

export function isMarketplaceConfigured(): boolean {
  return isAccountConfigured() || hasDesktopMarketplaceBridge()
}

export function isMarketplaceUiEnabled(): boolean {
  const flag = import.meta.env.VITE_MARKETPLACE_UI_ENABLED
  if (flag === `false` || flag === `0`)
    return false
  return isMarketplaceConfigured()
}

const IPC_INVOKE_PREFIX_RE = /^Error invoking remote method '[^']+': (?:[\w$]*Error: )?/
const HTTP_STATUS_FALLBACK_RE = /^HTTP (\d{3})\b/

function inferStatusFromMessage(message: string): number {
  const httpMatch = HTTP_STATUS_FALLBACK_RE.exec(message)
  if (httpMatch)
    return Number(httpMatch[1])
  switch (message) {
    case `unauthorized`:
    case `invalid_token`:
      return 401
    case `forbidden`:
      return 403
    case `not_found`:
    case `Not Found`:
      return 404
    case `slug_taken`:
    case `Conflict`:
      return 409
    case `payload_too_large`:
      return 413
    case `rate_limited`:
      return 429
    default:
      return 500
  }
}

function normalizeDesktopBridgeError(error: unknown): ApiError {
  if (error instanceof ApiError)
    return error
  const raw = error instanceof Error ? error.message : String(error ?? ``)
  const message = raw.replace(IPC_INVOKE_PREFIX_RE, ``).trim()
  return new ApiError(inferStatusFromMessage(message), message)
}

function toMarketplaceApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError)
    return error
  if (error instanceof Error && IPC_INVOKE_PREFIX_RE.test(error.message))
    return normalizeDesktopBridgeError(error)
  return null
}

/** Map API error codes to localized user-facing messages. */
export function getMarketplaceErrorMessage(error: unknown, fallbackKey = `marketplace.publishFailed`): string {
  const apiError = toMarketplaceApiError(error)
  if (apiError) {
    switch (apiError.message) {
      case `slug_taken`:
        return t(`marketplace.validation.slugTaken`)
      case `rate_limited`: {
        const limit = typeof apiError.body?.limit === `number` ? apiError.body.limit : null
        return limit != null
          ? t(`marketplace.validation.rateLimitedWithLimit`, { limit })
          : t(`marketplace.validation.rateLimited`)
      }
      case `unauthorized`:
      case `invalid_token`:
        return t(`marketplace.validation.unauthorized`)
      case `forbidden`:
        return t(`marketplace.validation.forbidden`)
      case `payload_too_large`:
        return t(`marketplace.validation.payloadTooLarge`)
      case `css_import_forbidden`:
      case `css_external_url_forbidden`:
        return t(`marketplace.validation.cssUnsafe`)
      case `unsafe_component_template`:
        return t(`marketplace.validation.templateUnsafe`)
      case `invalid_slug`:
        return t(`marketplace.validation.slugInvalid`)
      case `invalid_name`:
        return t(`marketplace.validation.nameRequired`)
      case `invalid_css`:
        return t(`marketplace.validation.cssRequired`)
      case `invalid_component_name`:
        return t(`marketplace.validation.componentNameInvalid`)
      case `invalid_component_template`:
        return t(`marketplace.validation.templateRequired`)
      case `invalid_version`:
        return t(`marketplace.validation.versionInvalid`)
      case `version_not_increased`:
        return t(`marketplace.validation.versionNotIncreased`)
      case `version_required`:
        return t(`marketplace.validation.versionRequired`)
      default:
        if (
          apiError.message
          && apiError.message !== `Conflict`
          && apiError.message !== `Bad Request`
          && !/^HTTP \d{3}$/.test(apiError.message)
        ) {
          return apiError.message
        }
    }
  }
  return t(fallbackKey)
}

export function getMarketplaceErrorCode(error: unknown): string | null {
  const apiError = toMarketplaceApiError(error)
  if (apiError && typeof apiError.message === `string` && apiError.message)
    return apiError.message
  return null
}

function toQuery(params: MarketplaceListParams = {}): string {
  const search = new URLSearchParams()
  if (params.q)
    search.set(`q`, params.q)
  if (params.sort)
    search.set(`sort`, params.sort)
  if (params.page)
    search.set(`page`, String(params.page))
  if (params.pageSize)
    search.set(`pageSize`, String(params.pageSize))
  const qs = search.toString()
  return qs ? `?${qs}` : ``
}

export class MarketplaceClient extends MdApiClient {
  private async invokeDesktopBridge<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    }
    catch (error) {
      throw normalizeDesktopBridgeError(error)
    }
  }

  listThemes(params?: MarketplaceListParams): Promise<MarketplaceListResponse> {
    const bridge = window.mdDesktop?.marketplace
    if (!isAccountConfigured() && bridge)
      return this.invokeDesktopBridge(() => bridge.listThemes(params))
    return this.request<MarketplaceListResponse>(`GET`, `/marketplace/themes${toQuery(params)}`)
  }

  listComponents(params?: MarketplaceListParams): Promise<MarketplaceListResponse> {
    return this.request<MarketplaceListResponse>(`GET`, `/marketplace/components${toQuery(params)}`)
  }

  get(id: string): Promise<MarketplaceItemDetail> {
    const bridge = window.mdDesktop?.marketplace
    if (!isAccountConfigured() && bridge)
      return this.invokeDesktopBridge(() => bridge.getItem(id))
    return this.request<MarketplaceItemDetail>(`GET`, `/marketplace/${id}`)
  }

  install(id: string): Promise<MarketplaceItemDetail> {
    const bridge = window.mdDesktop?.marketplace
    if (!isAccountConfigured() && bridge)
      return this.invokeDesktopBridge(() => bridge.installItem(id))
    return this.request<MarketplaceItemDetail>(`POST`, `/marketplace/${id}/install`)
  }

  listMine(): Promise<MyMarketplaceResponse> {
    return this.request<MyMarketplaceResponse>(`GET`, `/marketplace/me`)
  }

  publishTheme(payload: PublishThemePayload): Promise<MarketplaceItemDetail> {
    return this.request<MarketplaceItemDetail>(`POST`, `/marketplace/themes`, payload)
  }

  publishComponent(payload: PublishComponentPayload): Promise<MarketplaceItemDetail> {
    return this.request<MarketplaceItemDetail>(`POST`, `/marketplace/components`, payload)
  }

  update(id: string, payload: UpdateMarketplacePayload): Promise<MarketplaceItemDetail> {
    return this.request<MarketplaceItemDetail>(`PATCH`, `/marketplace/${id}`, payload)
  }

  remove(id: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>(`DELETE`, `/marketplace/${id}`)
  }

  listPending(params?: MarketplaceListParams & { type?: MarketplaceItemType }): Promise<MarketplaceListResponse & { items: MarketplaceItemDetail[] }> {
    const search = new URLSearchParams()
    if (params?.type)
      search.set(`type`, params.type)
    if (params?.page)
      search.set(`page`, String(params.page))
    if (params?.pageSize)
      search.set(`pageSize`, String(params.pageSize))
    const qs = search.toString()
    return this.request(`GET`, `/marketplace/admin/pending${qs ? `?${qs}` : ``}`)
  }

  approve(id: string): Promise<MarketplaceItemDetail> {
    return this.request<MarketplaceItemDetail>(`POST`, `/marketplace/admin/${id}/approve`)
  }

  reject(id: string, reason?: string): Promise<MarketplaceItemDetail> {
    return this.request<MarketplaceItemDetail>(`POST`, `/marketplace/admin/${id}/reject`, { reason })
  }
}

export { ApiError as MarketplaceApiError }
