import { SidebarTrigger } from '@/components/ui/sidebar'

interface PageHeaderProps {
  breadcrumb: React.ReactNode
  actions?: React.ReactNode
}

export function PageHeader({ breadcrumb, actions }: PageHeaderProps) {
  return (
    <div className="h-[52px] flex items-center gap-3 border-b px-4 shrink-0">
      <SidebarTrigger className="h-8 w-8 rounded-md shrink-0" />
      <div className="flex-1 min-w-0 self-stretch flex items-center">
        {breadcrumb}
      </div>
      {actions && (
        <div className="flex items-center gap-2 shrink-0">
          {actions}
        </div>
      )}
    </div>
  )
}
