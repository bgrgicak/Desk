import { useState } from 'react'
import { Button } from '@roomy-ai/ui'
import { getChatClient } from '../storage/client'
import type { Action, Item, OnClick } from './types'
import { isLinkAction, isLinkOnClick } from './types'

// Click handler that either opens a URL or fires `chat.sendMessage`. Used
// for both card-level onClick and per-action buttons. The bridge can throw
// when the chat capability is missing; we swallow + log so a partially-
// configured fragment still feels somewhat responsive.
function dispatch(target: Action | OnClick): void {
  if ('link' in target && typeof target.link === 'string') {
    if (typeof window !== 'undefined') {
      window.open(target.link, '_blank', 'noopener,noreferrer')
    }
    return
  }
  if ('reply' in target && typeof target.reply === 'string') {
    try {
      void getChatClient().sendMessage(target.reply)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('chat-cards: reply send failed', err)
    }
    return
  }
}

export function Card({ item }: { item: Item }) {
  const [pressedAction, setPressedAction] = useState<number | null>(null)
  const [submittedCardClick, setSubmittedCardClick] = useState(false)

  const hasOnClick = Boolean(item.onClick)
  const isOnClickReply = item.onClick && !isLinkOnClick(item.onClick)

  const onCardClick = () => {
    if (!item.onClick) return
    dispatch(item.onClick)
    // For reply-on-click, surface a confirmation so the user knows the
    // message went out. For link-on-click we don't — the new tab is its
    // own confirmation.
    if (isOnClickReply) setSubmittedCardClick(true)
  }

  const cardClasses = [
    'flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-sm',
    hasOnClick ? 'cursor-pointer transition-colors hover:bg-accent/40' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cardClasses}
      onClick={hasOnClick ? onCardClick : undefined}
      role={hasOnClick ? 'button' : undefined}
      tabIndex={hasOnClick ? 0 : undefined}
      onKeyDown={
        hasOnClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onCardClick()
              }
            }
          : undefined
      }
    >
      {item.image && (
        <img
          src={item.image}
          alt={item.title ?? ''}
          className="h-32 w-full rounded object-cover"
          loading="lazy"
        />
      )}

      {item.title && (
        <div className="text-base font-medium leading-snug">
          {item.link ? (
            <a
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2 hover:no-underline"
              onClick={(e) => e.stopPropagation()}
            >
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </div>
      )}

      {item.description && (
        <p className="text-sm text-muted-foreground">{item.description}</p>
      )}

      {item.actions && item.actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {item.actions.map((action, i) => (
            <Button
              key={i}
              type="button"
              size="sm"
              variant={isLinkAction(action) ? 'outline' : 'default'}
              disabled={pressedAction === i}
              onClick={(e) => {
                e.stopPropagation()
                dispatch(action)
                if (!isLinkAction(action)) setPressedAction(i)
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}

      {submittedCardClick && (
        <p className="text-xs text-muted-foreground">Sent.</p>
      )}
    </div>
  )
}
