interface Res {
  data?: {
    cards?: {
      content?: {
        isTop?: boolean
        word: string
        rawUrl: string
        desc?: string
      }[]
    }[]
  }
}

export default defineSource(async () => {
  const rawData: string = await myFetch(`https://top.baidu.com/board?tab=realtime`)
  const jsonMatch = (rawData as string).match(/<!--s-data:(.*?)-->/s)

  if (!jsonMatch || !jsonMatch[1]) {
    console.warn("[baidu] Failed to parse JSON data from HTML, HTML structure may have changed")
    console.debug("[baidu] HTML snippet:", (rawData as string).slice(0, 500))
    return []
  }

  const data: Res = JSON.parse(jsonMatch[1])

  if (!data?.data?.cards?.[0]?.content) {
    console.warn("[baidu] Unexpected data structure from API")
    return []
  }

  return data.data.cards[0].content.filter(k => !k.isTop).map((k) => {
    return {
      id: k.rawUrl,
      title: k.word,
      url: k.rawUrl,
      extra: {
        hover: k.desc,
      },
    }
  })
})
