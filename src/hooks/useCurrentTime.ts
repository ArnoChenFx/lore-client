import { useEffect, useState } from 'react'

/** 历史列表共用一个分钟级时钟，不为每一行创建定时器或重新读取仓库。 */
export function useCurrentTime(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}
