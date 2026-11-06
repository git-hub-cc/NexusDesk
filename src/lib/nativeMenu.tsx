import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openNativePopup } from "./nativePopup";

type Props = { onBeforeOpen?: () => Promise<void>; children?: React.ReactNode; asChild?: boolean; disabled?: boolean; align?: string; sideOffset?: number; collisionPadding?: number; checked?: boolean; onCheckedChange?: (checked: boolean) => void; onSelect?: (event: Event) => void; onCloseAutoFocus?: (event: Event) => void } & React.HTMLAttributes<HTMLElement>;
const Context = createContext<{ point: { x: number; y: number; target: HTMLElement } | null; setPoint: (point: { x: number; y: number; target: HTMLElement } | null) => void; dropdown: boolean; closedAt: React.MutableRefObject<number> }>({ point: null, setPoint: () => {}, dropdown: false, closedAt: { current: -Infinity } });
function MenuRoot({ children, dropdown = false }: Props & { dropdown?: boolean }) {
  const [point, setPoint] = useState<{ x: number; y: number; target: HTMLElement } | null>(null);
  const closedAt = useRef(-Infinity);
  useEffect(() => {
    if (!point) return;
    // The native popup is a separate window, so clicks in the owner webview
    // do not blur it. Close this menu before the next interaction is handled.
    const closeFromOwner = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 2) return;
      if (event.target instanceof Node && point.target.contains(event.target)) return;
      setPoint(null);
      closedAt.current = performance.now();
      void invoke("native_menu_close");
    };
    document.addEventListener("pointerdown", closeFromOwner, true);
    return () => document.removeEventListener("pointerdown", closeFromOwner, true);
  }, [point]);
  return <Context.Provider value={{ point, setPoint, dropdown, closedAt }}>{children}</Context.Provider>;
}
export const Root = (props: Props) => <MenuRoot {...props} />;
export const DropdownRoot = (props: Props) => <MenuRoot {...props} dropdown />;
export function Trigger({ children, asChild, disabled, onContextMenu, onClick, onBeforeOpen, ...props }: Props) {
  const context = useContext(Context);
  const open = async (event: React.MouseEvent<HTMLElement>) => {
    if (disabled) return;
    if (context.point || performance.now() - context.closedAt.current < 250) {
      event.preventDefault();
      context.setPoint(null);
      context.closedAt.current = -Infinity;
      await invoke("native_menu_close");
      return;
    }
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    event.preventDefault();
    await onBeforeOpen?.();
    context.setPoint({ x: context.dropdown ? rect.left : event.clientX, y: context.dropdown ? rect.bottom + 4 : event.clientY, target });
  };
  const handlers = { ...props, role: "button", tabIndex: disabled ? -1 : 0, "aria-haspopup": "menu" as const, "aria-expanded": !!context.point,
    onKeyDown: async (event: React.KeyboardEvent<HTMLElement>) => {
      props.onKeyDown?.(event);
      if (!disabled && !event.defaultPrevented && context.dropdown && (event.key === "Enter" || event.key === " " || event.key === "ArrowDown")) {
        event.preventDefault();
        if (context.point || performance.now() - context.closedAt.current < 250) {
          context.setPoint(null);
          context.closedAt.current = -Infinity;
          await invoke("native_menu_close");
          return;
        }
        const target = event.currentTarget;
        const rect = target.getBoundingClientRect();
        await onBeforeOpen?.();
        context.setPoint({ x: rect.left, y: rect.bottom + 4, target });
      }
    }, onClick: (event: React.MouseEvent<HTMLElement>) => { onClick?.(event); if (context.dropdown && !event.defaultPrevented) open(event); }, onContextMenu: (event: React.MouseEvent<HTMLElement>) => { onContextMenu?.(event); if (!context.dropdown && !event.defaultPrevented) open(event); } };
  if (asChild && React.isValidElement<Props>(children)) {
    const child = children;
    return React.cloneElement(child, { ...handlers, onKeyDown: event => { child.props.onKeyDown?.(event); if (!event.defaultPrevented) handlers.onKeyDown(event); }, onClick: event => { child.props.onClick?.(event); handlers.onClick(event); }, onContextMenu: event => { child.props.onContextMenu?.(event); handlers.onContextMenu(event); } });
  }
  return <button {...handlers as React.ButtonHTMLAttributes<HTMLButtonElement>} disabled={disabled}>{children}</button>;
}
export const Portal = ({ children }: Props) => <>{children}</>;
export function Content({ children, align, className, onCloseAutoFocus, ...props }: Props) {
  const { point, setPoint, closedAt } = useContext(Context);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!point || !ref.current) return;
    const container = ref.current;
    const nodes = [...container.querySelectorAll<HTMLElement>("button,input")];
    nodes.forEach((node, index) => node.dataset.action = String(index));
    const width = Number.parseFloat(getComputedStyle(container).width) || 224;
    let active = true;
    void openNativePopup(container.innerHTML, align === "end" ? point.target.getBoundingClientRect().right - width : point.x, point.y, width, (id, value) => {
      if (!active) return;
      const node = nodes[Number(id)];
      if (node instanceof HTMLInputElement && value) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(node, value);
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      } else node?.click();
    }, () => {
      if (!active) return;
      // Native blur can arrive before the owner receives the trigger click.
      closedAt.current = performance.now();
      setPoint(null);
      const event = new Event("close", { cancelable: true });
      onCloseAutoFocus?.(event);
      if (!event.defaultPrevented && point.target.isConnected) point.target.focus();
    });
    return () => { active = false; };
  }, [point]);
  if (!point) return null;
  // Never mount a DOM overlay over native browser children.
  return <div ref={ref} className={className} style={{ display: "none" }} onClick={event => event.stopPropagation()} aria-hidden="true" data-native-menu-source={props["aria-label"]}>{children}</div>;
}
export function Item({ children, disabled, onSelect, checked, onCheckedChange, className, ...props }: Props) {
  return <button {...props} className={className} type="button" role={onCheckedChange ? "menuitemcheckbox" : "menuitem"} aria-checked={onCheckedChange ? !!checked : undefined} disabled={disabled} onClick={() => { const event = new Event("select", { cancelable: true }); onSelect?.(event); onCheckedChange?.(!checked); }}>{checked ? "✓ " : null}{children}</button>;
}
export const CheckboxItem = Item;
export const ItemIndicator = (_props: Props) => null;
export const Separator = (_props: Props) => <hr />;
export const Sub = ({ children }: Props) => <div className="submenu">{children}</div>;
export const SubTrigger = ({ children }: Props) => <button type="button" className="submenu-trigger">{children}</button>;
export const SubContent = ({ children }: Props) => <div className="submenu-content">{children}</div>;
