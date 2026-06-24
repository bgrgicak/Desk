export const GLOBAL_SEARCH_DEBOUNCE_MS = 250
export const MIN_GLOBAL_SEARCH_QUERY_LENGTH = 3

export function shouldRunGlobalSearch(query: string): boolean {
  return query.trim().length >= MIN_GLOBAL_SEARCH_QUERY_LENGTH
}
