export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) {
    const word = parts[0]
    if (word.length === 1) return word[0].toUpperCase()
    // Single-word names render as title case ("Roomy" -> "De"), so they
    // read as a proper noun fragment rather than an acronym ("DE").
    return word[0].toUpperCase() + word[1].toLowerCase()
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
