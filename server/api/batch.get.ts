import type { SourceID } from "@shared/types"
import { getters } from "#/getters"
import { getCacheTable } from "#/database/cache"
import type { CacheInfo } from "#/types"

/**
 * 批量聚合端点：GET /api/batch?ids=ifeng,baidu,weibo&latest=1
 *
 * 一次请求返回多个源的数据，供下游管道（newsnow-audio Worker）用单个子请求
 * 拿到全部内容源。每个源独立处理：失败只影响自己，不影响整批。
 *
 * 响应结构：
 * {
 *   updatedTime: number,
 *   sources: {
 *     [id]: { status: "success"|"cache", updatedTime, items: NewsItem[] }
 *          | { status: "error", message: string }
 *   }
 * }
 */

interface BatchSourceOK {
  status: "success" | "cache"
  updatedTime: number | string
  items: import("@shared/types").NewsItem[]
}
interface BatchSourceError {
  status: "error"
  message: string
}

export default defineEventHandler(async (event) => {
  try {
    const query = getQuery(event)
    const latest = query.latest !== undefined && query.latest !== "false"
    const idsParam = (query.ids as string | undefined)?.trim() ?? ""

    const requested = idsParam
      .split(",")
      .map(s => s.trim())
      .filter(Boolean) as SourceID[]

    // 不传 ids 就报错——批量端点明确指定源，避免被人无脑拉全量
    if (!requested.length) {
      throw createError({ statusCode: 400, message: "Missing ?ids=source1,source2" })
    }

    const cacheTable = await getCacheTable()
    const now = Date.now()
    const out: Record<string, BatchSourceOK | BatchSourceError> = {}

    await Promise.all(
      requested.map(async (rawId) => {
        try {
          let id = rawId
          const isValid = (x: SourceID) => !x || !sources[x] || !getters[x]
          if (isValid(id)) {
            const redirectID = sources?.[id]?.redirect
            if (redirectID) id = redirectID
            if (isValid(id)) throw new Error(`Invalid source id: ${rawId}`)
          }

          // 逻辑与 /api/s 一致：interval 内直接用缓存，TTL 内无 latest 也用缓存
          let cache: CacheInfo | undefined
          if (cacheTable) cache = await cacheTable.get(id)

          if (cache) {
            if (now - cache.updated < sources[id].interval) {
              out[rawId] = { status: "success", updatedTime: now, items: cache.items }
              return
            }
            if (now - cache.updated < TTL && (!latest || (!event.context.disabledLogin && !event.context.user))) {
              out[rawId] = { status: "cache", updatedTime: cache.updated, items: cache.items }
              return
            }
          }

          try {
            const newData = (await getters[id]()).slice(0, 30)
            if (cacheTable && newData.length) {
              if (event.context.waitUntil) event.context.waitUntil(cacheTable.set(id, newData))
              else await cacheTable.set(id, newData)
            }
            logger.success(`fetch ${id} latest (batch)`)
            out[rawId] = { status: "success", updatedTime: now, items: newData }
          } catch (e) {
            if (cache) {
              out[rawId] = { status: "cache", updatedTime: cache.updated, items: cache.items }
            } else {
              throw e
            }
          }
        } catch (e: any) {
          // 单源失败不拖垮整批：该源标记 error，下游自行兜底
          logger.error(`[batch] ${rawId}: ${e instanceof Error ? e.message : e}`)
          out[rawId] = {
            status: "error",
            message: e instanceof Error ? e.message : "Internal Server Error",
          }
        }
      }),
    )

    return {
      updatedTime: now,
      sources: out,
    }
  } catch (e: any) {
    logger.error(e)
    throw createError({
      statusCode: e?.statusCode ?? 500,
      message: e instanceof Error ? e.message : "Internal Server Error",
    })
  }
})
