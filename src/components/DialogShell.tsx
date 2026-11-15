import * as Dialog from "@radix-ui/react-dialog";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

type DialogShellProps = ComponentPropsWithoutRef<typeof Dialog.Content> & {
  purpose?: "form" | "confirmation" | "search" | "settings" | "detail";
  wide?: boolean;
};

export const DialogShell = forwardRef<HTMLDivElement, DialogShellProps>(function DialogShell(
  { purpose = "form", wide = false, className = "", onClick, onKeyDown, ...props }, ref,
) {
  return <Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content {...props} ref={ref} data-purpose={purpose} data-wide={wide || undefined}
      className={`dialog-shell ${className}`}
      onClick={event => { event.stopPropagation(); onClick?.(event); }}
      onKeyDown={event => { event.stopPropagation(); onKeyDown?.(event); }} />
  </Dialog.Portal>;
});
