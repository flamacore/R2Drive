import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "../../lib/utils"

const Checkbox = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> & { onCheckedChange?: (checked: boolean) => void }
>(({ className, onCheckedChange, ...props }, ref) => {
    
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onCheckedChange?.(e.target.checked);
  }

  return (
  <div className="relative flex items-center justify-center w-4 h-4">
      <input
        type="checkbox"
        className={cn(
          "peer appearance-none h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 checked:bg-primary checked:border-primary",
          className
        )}
        ref={ref}
        onChange={handleChange}
        {...props}
      />
      <Check className="h-3 w-3 absolute text-primary-foreground pointer-events-none opacity-0 peer-checked:opacity-100" />
  </div>
)})
Checkbox.displayName = "Checkbox"

export { Checkbox }
