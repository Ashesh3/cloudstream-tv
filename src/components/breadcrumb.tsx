"use client";

import { useFocusable } from "@/lib/navigation";

interface BreadcrumbSegment {
  label: string;
  href: string;
}

interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
  onNavigate: (href: string) => void;
}

interface BreadcrumbItemProps {
  segment: BreadcrumbSegment;
  index: number;
  isLast: boolean;
  onNavigate: (href: string) => void;
}

function BreadcrumbItem({
  segment,
  index,
  isLast,
  onNavigate,
}: BreadcrumbItemProps) {
  const { ref, isFocused } = useFocusable({
    id: `breadcrumb-${index}`,
    row: 0,
    col: index,
    onSelect: () => onNavigate(segment.href),
  });

  return (
    <div
      ref={ref}
      data-focused={isFocused}
      className={`rounded-lg px-3 py-1 transition-all duration-focus ease-out cursor-pointer
        ${isLast ? "font-semibold text-tv-text" : "text-tv-text-dim"}
        ${isFocused ? "bg-tv-focus/20 text-white ring-2 ring-tv-focus" : ""}`}
    >
      {segment.label}
    </div>
  );
}

export function Breadcrumb({ segments, onNavigate }: BreadcrumbProps) {
  return (
    <nav className="flex items-center gap-2 px-tv-padding py-4">
      {segments.map((segment, index) => (
        <div key={segment.href} className="flex items-center gap-2">
          {index > 0 && (
            <span className="text-tv-text-dim" aria-hidden="true">
              /
            </span>
          )}
          <BreadcrumbItem
            segment={segment}
            index={index}
            isLast={index === segments.length - 1}
            onNavigate={onNavigate}
          />
        </div>
      ))}
    </nav>
  );
}
