import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-none border px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.06em] leading-none transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-line bg-raised text-dim",
        secondary:
          "border-line bg-raised text-text",
        destructive:
          "border-crit/25 bg-crit/10 text-crit",
        outline: "text-foreground",
        ready:
          "border-signal/25 bg-signal/10 text-signal",
        pending:
          "border-info/25 bg-info/10 text-info",
        success:
          "border-signal/25 bg-signal/10 text-signal",
        warning:
          "border-warn/25 bg-warn/10 text-warn",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
