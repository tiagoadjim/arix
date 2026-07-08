import { cn } from '@/lib/utils';

/** The geometric mark alone (rounded badge with a "send" chevron cut out) — monochrome, `currentColor`. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={cn('h-6 w-6', className)} role="img" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10 2h12a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8H10a8 8 0 0 1-8-8V10a8 8 0 0 1 8-8Z M12 9l9 7-9 7V9Z"
      />
    </svg>
  );
}

/** Full lockup: mark + lowercase "arix" wordmark. Monochrome, `currentColor` — inherits text color from context. */
export function Logo({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark className={markClassName} />
      <span className="text-lg font-semibold tracking-tight">arix</span>
    </span>
  );
}
