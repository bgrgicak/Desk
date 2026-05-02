import { describe, it, expect } from 'vitest'
import { buildCron, parseCron } from './schedule-utils'

describe('buildCron', () => {
  it('minutes interval', () => {
    expect(buildCron({ n: 5,  unit: 'minutes', weekdays: [], day: 1, hour: 9, minute: 0 })).toBe('*/5 * * * *')
    expect(buildCron({ n: 30, unit: 'minutes', weekdays: [], day: 1, hour: 9, minute: 0 })).toBe('*/30 * * * *')
  })

  it('hours interval', () => {
    expect(buildCron({ n: 1,  unit: 'hours', weekdays: [], day: 1, hour: 9, minute: 0 })).toBe('0 */1 * * *')
    expect(buildCron({ n: 6,  unit: 'hours', weekdays: [], day: 1, hour: 9, minute: 0 })).toBe('0 */6 * * *')
  })

  it('days — every day at a time', () => {
    expect(buildCron({ n: 1, unit: 'days', weekdays: [], day: 1, hour: 9,  minute: 0  })).toBe('0 9 * * *')
    expect(buildCron({ n: 1, unit: 'days', weekdays: [], day: 1, hour: 14, minute: 30 })).toBe('30 14 * * *')
  })

  it('days — every N days', () => {
    expect(buildCron({ n: 3, unit: 'days', weekdays: [], day: 1, hour: 9, minute: 0 })).toBe('0 9 */3 * *')
  })

  it('weeks — single weekday', () => {
    expect(buildCron({ n: 1, unit: 'weeks', weekdays: [1], hour: 9, minute: 0, day: 1 })).toBe('0 9 * * 1')
  })

  it('weeks — multiple weekdays', () => {
    expect(buildCron({ n: 1, unit: 'weeks', weekdays: [1, 3, 5], hour: 9, minute: 0, day: 1 })).toBe('0 9 * * 1,3,5')
  })

  it('weeks — Mon–Fri stored as sorted list', () => {
    expect(buildCron({ n: 1, unit: 'weeks', weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0, day: 1 })).toBe('0 9 * * 1,2,3,4,5')
  })

  it('months', () => {
    expect(buildCron({ n: 1, unit: 'months', weekdays: [], day: 1,  hour: 9,  minute: 0  })).toBe('0 9 1 * *')
    expect(buildCron({ n: 1, unit: 'months', weekdays: [], day: 15, hour: 14, minute: 30 })).toBe('30 14 15 * *')
  })
})

describe('parseCron', () => {
  it('minutes', () => {
    expect(parseCron('*/5 * * * *')).toMatchObject({ unit: 'minutes', n: 5 })
    expect(parseCron('*/30 * * * *')).toMatchObject({ unit: 'minutes', n: 30 })
  })

  it('hours', () => {
    expect(parseCron('0 */1 * * *')).toMatchObject({ unit: 'hours', n: 1 })
    expect(parseCron('0 */6 * * *')).toMatchObject({ unit: 'hours', n: 6 })
  })

  it('days n=1', () => {
    expect(parseCron('0 9 * * *')).toMatchObject({ unit: 'days', n: 1, hour: 9, minute: 0 })
  })

  it('days n>1', () => {
    expect(parseCron('0 9 */3 * *')).toMatchObject({ unit: 'days', n: 3, hour: 9, minute: 0 })
  })

  it('weeks — single day', () => {
    expect(parseCron('0 9 * * 1')).toMatchObject({ unit: 'weeks', weekdays: [1], hour: 9, minute: 0 })
  })

  it('weeks — multiple days', () => {
    expect(parseCron('0 9 * * 1,3,5')).toMatchObject({ unit: 'weeks', weekdays: [1, 3, 5], hour: 9, minute: 0 })
  })

  it('weeks — range expands to list', () => {
    expect(parseCron('0 9 * * 1-5')).toMatchObject({ unit: 'weeks', weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0 })
  })

  it('months', () => {
    expect(parseCron('0 9 1 * *')).toMatchObject({ unit: 'months', day: 1, hour: 9, minute: 0 })
    expect(parseCron('30 14 15 * *')).toMatchObject({ unit: 'months', day: 15, hour: 14, minute: 30 })
  })

  it('returns null for unrecognized patterns', () => {
    expect(parseCron('0 0 1 1 *')).toBeNull()
    expect(parseCron('invalid')).toBeNull()
    expect(parseCron('')).toBeNull()
  })
})
