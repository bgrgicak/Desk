import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

type SwitchSize = "default" | "sm"

const ROOT_SIZE: Record<SwitchSize, string> = {
  default: "h-5 w-9",
  sm:      "h-4 w-7",
}

const THUMB_SIZE: Record<SwitchSize, string> = {
  default: "size-4 data-[state=checked]:translate-x-4",
  sm:      "size-3 data-[state=checked]:translate-x-3",
}

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & { size?: SwitchSize }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        ROOT_SIZE[size],
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-background shadow-sm ring-0 transition-transform data-[state=unchecked]:translate-x-0",
          THUMB_SIZE[size],
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
