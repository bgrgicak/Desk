export type Unit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months'

export interface ScheduleParams {
  n: number
  unit: Unit
  weekdays: number[]  // 0=Sun … 6=Sat, used when unit='weeks'
  day: number         // 1-28, used when unit='months'
  hour: number
  minute: number
}

export function buildCron(p: ScheduleParams): string {
  const { n, unit, weekdays, day, hour, minute: min } = p
  switch (unit) {
    case 'minutes': return `*/${n} * * * *`
    case 'hours':   return `0 */${n} * * *`
    case 'days':    return n === 1 ? `${min} ${hour} * * *` : `${min} ${hour} */${n} * *`
    case 'weeks': {
      const dow = weekdays.slice().sort((a, b) => a - b).join(',') || '*'
      return `${min} ${hour} * * ${dow}`
    }
    case 'months':  return `${min} ${hour} ${day} * *`
  }
}

export function parseCron(cron: string): ScheduleParams | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [m, h, dom, month, dow] = parts

  if (month !== '*') return null

  // minutes: */N * * * *
  if (/^\*\/\d+$/.test(m ?? '') && h === '*' && dom === '*' && dow === '*') {
    return base(parseInt((m ?? '').slice(2), 10), 'minutes', [], 1, 0, 0)
  }

  // hours: 0 */N * * *
  if (m === '0' && /^\*\/\d+$/.test(h ?? '') && dom === '*' && dow === '*') {
    return base(parseInt((h ?? '').slice(2), 10), 'hours', [], 1, 0, 0)
  }

  const minute = Number(m)
  const hour   = Number(h)
  if (Number.isNaN(minute) || Number.isNaN(hour) || h === '*') return null

  // months: min hour <plain-num> * *
  if (/^\d+$/.test(dom ?? '') && dow === '*') {
    return base(1, 'months', [], Number(dom), hour, minute)
  }

  // days: min hour * * *  OR  min hour */N * *
  if (dow === '*') {
    if (dom === '*') return base(1, 'days', [], 1, hour, minute)
    if (/^\*\/\d+$/.test(dom ?? '')) return base(parseInt((dom ?? '').slice(2), 10), 'days', [], 1, hour, minute)
    return null
  }

  // weeks: min hour * * <dow-spec>
  if (dom !== '*') return null
  const weekdays = expandDow(dow ?? '')
  if (!weekdays) return null
  return base(1, 'weeks', weekdays, 1, hour, minute)
}

function base(n: number, unit: Unit, weekdays: number[], day: number, hour: number, minute: number): ScheduleParams {
  return { n, unit, weekdays, day, hour, minute }
}

function expandDow(dow: string): number[] | null {
  // range: 1-5
  const range = dow.match(/^(\d)-(\d)$/)
  if (range) {
    const from = Number(range[1])
    const to   = Number(range[2])
    if (from > to) return null
    return Array.from({ length: to - from + 1 }, (_, i) => from + i)
  }
  // list: 1,3,5
  if (/^[\d,]+$/.test(dow)) {
    return dow.split(',').map(Number)
  }
  // single digit
  if (/^\d$/.test(dow)) return [Number(dow)]
  return null
}
