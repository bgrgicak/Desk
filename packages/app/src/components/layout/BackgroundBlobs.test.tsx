import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BackgroundBlobs, createPageLoadBlobs } from './BackgroundBlobs'

describe('BackgroundBlobs', () => {
  it('uses a static real blur without animated filtered pixels', () => {
    const markup = renderToStaticMarkup(<BackgroundBlobs />)

    expect(markup).toContain('backgroundBlobStage')
    expect(markup).toContain('filter: blur(120px)')
    expect(markup).toContain('backgroundBlobWash')
    expect(markup).toContain('backgroundBlob-5')

    expect(markup).not.toContain('<svg')
    expect(markup).not.toContain('<ellipse')
    expect(markup).not.toContain('backdrop-filter')
    expect(markup).not.toContain('backgroundBlobBlurLayer')
    expect(markup).not.toContain('animation:')
    expect(markup).not.toContain('@keyframes')
    expect(markup).not.toContain('backgroundBlobColor')
    expect(markup).not.toContain('fill:')
    expect(markup).not.toContain('will-change: transform, fill')
  })

  it('can vary colors per page load without changing layout or animating', () => {
    const firstLoad = createPageLoadBlobs(() => 0)
    const secondLoad = createPageLoadBlobs(() => 0.99)

    expect(firstLoad.map(blob => blob.color)).not.toEqual(secondLoad.map(blob => blob.color))
    expect(firstLoad.map(({ color: _color, ...layout }) => layout)).toEqual(
      secondLoad.map(({ color: _color, ...layout }) => layout),
    )
  })
})
