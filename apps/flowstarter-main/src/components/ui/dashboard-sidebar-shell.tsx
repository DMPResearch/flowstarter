'use client';

import type { ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { sidebarFooterToggleClass } from '@/lib/glass';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

type DashboardSidebarShellProps = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  isMobileOpen: boolean;
  setIsMobileOpen: (open: boolean) => void;
  renderContent: (showLabel: boolean) => ReactNode;
  mobileTopArea?: ReactNode;
  mobileTopOffsetClass?: string;
  desktopTopOffsetClass?: string;
  collapsedWidthClass?: string;
  expandedWidthClass?: string;
  mobileWidthClass?: string;
};

export function DashboardSidebarShell({
  collapsed,
  onToggleCollapsed,
  isMobileOpen,
  setIsMobileOpen,
  renderContent,
  mobileTopArea,
  mobileTopOffsetClass = 'top-16',
  desktopTopOffsetClass = 'top-16',
  collapsedWidthClass = 'w-[72px]',
  expandedWidthClass = 'w-52 lg:w-60',
  mobileWidthClass = 'w-72',
}: DashboardSidebarShellProps) {
  // The one glass surface, square and opaque-leaning: `.fs-glass--chrome`
  // reads the same `--fs-chrome-*` tokens this used to hand-roll, plus the
  // specular catch-light and refractive edge every other surface gets.
  const sidebarChromeClass = 'fs-glass fs-glass--chrome';

  return (
    <>
      {isMobileOpen && (
        <div
          className={cn(
            'md:hidden fixed inset-x-0 bottom-0 z-[150] bg-black/45 backdrop-blur-sm',
            mobileTopOffsetClass
          )}
          onClick={() => setIsMobileOpen(false)}
        />
      )}

      <aside
        // `.fs-glass--chrome` zeroes the radius (a header/sidebar is square);
        // the mobile drawer wants its outer right corners back, and the
        // inline style guarantees both that and `position: fixed` win the
        // cascade regardless of stylesheet import order. `position: fixed`
        // still gives the pseudo-elements a containing block to anchor to.
        style={{
          position: 'fixed',
          borderTopRightRadius: 'var(--fs-radius-xl)',
          borderBottomRightRadius: 'var(--fs-radius-xl)',
        }}
        className={cn(
          sidebarChromeClass,
          'md:hidden bottom-0 left-0 z-[160] border-r border-[var(--fs-chrome-border)]',
          mobileTopOffsetClass,
          mobileWidthClass,
          'transform transition-transform duration-300 ease-in-out',
          isMobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {mobileTopArea}
        <div className="h-full overflow-y-auto">{renderContent(true)}</div>
      </aside>

      <aside
        style={{ position: 'fixed' }}
        className={cn(
          sidebarChromeClass,
          'hidden md:flex left-0 bottom-0 z-40 flex-col border-r border-[var(--fs-chrome-border)] transition-all duration-300',
          desktopTopOffsetClass,
          collapsed ? collapsedWidthClass : expandedWidthClass
        )}
      >
        <div className="flex-1 min-h-0 overflow-y-auto">
          {renderContent(!collapsed)}
        </div>
        <div
          className={cn(
            'border-t border-[var(--fs-rule)] py-3',
            collapsed ? 'px-0 flex justify-center' : 'px-3'
          )}
        >
          {collapsed ? (
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onToggleCollapsed}
                  aria-label="Expand sidebar"
                  className={cn(
                    sidebarFooterToggleClass,
                    'justify-center !px-0 w-11 mx-auto'
                  )}
                >
                  <PanelLeftOpen className="h-4 w-4 shrink-0" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                Expand sidebar
              </TooltipContent>
            </Tooltip>
          ) : (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Collapse sidebar"
              className={sidebarFooterToggleClass}
            >
              <PanelLeftClose className="h-4 w-4 shrink-0" />
              <span className="truncate">Collapse sidebar</span>
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
