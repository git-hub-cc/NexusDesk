import type { KeyboardEventHandler, ReactNode } from "react";

export function SettingsPage({ title, description, children, onKeyDown }: {
  title: string;
  description: string;
  children: ReactNode;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}) {
  return <div className="mx-auto w-full max-w-3xl p-5" onKeyDown={onKeyDown}>
    <header className="mb-6 border-b border-ide-panel-border pb-4">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-gray-400">{description}</p>
    </header>
    {children}
  </div>;
}
