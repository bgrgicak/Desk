import { SidebarTrigger } from '@roomy-ai/ui'

interface PageHeaderProps {
  breadcrumb: React.ReactNode
  actions?: React.ReactNode
}

export function PageHeader({ breadcrumb, actions }: PageHeaderProps) {
  return (
    <div className="flex min-h-[52px] flex-wrap items-center gap-2 border-b px-3 py-2 shrink-0 sm:h-[52px] sm:flex-nowrap sm:gap-3 sm:px-4 sm:py-0">
      <SidebarTrigger className="h-8 w-8 rounded-md shrink-0" />
      <div className="min-w-0 flex-1 self-stretch flex items-center">
        {breadcrumb}
      </div>
      {actions && (
        <div className="flex min-w-0 max-w-full items-center gap-1.5 overflow-x-auto sm:shrink-0 sm:gap-2">
          {actions}
        </div>
      )}
    </div>
  )
}
