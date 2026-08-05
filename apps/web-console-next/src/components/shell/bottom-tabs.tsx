"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { Building2, Map, Plug, Receipt, Settings, User2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { isLinkActive } from "./nav-items";

interface Tab {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Mobile bottom tab bar (`md:hidden`) for the primary product destinations —
 * the single biggest "native-app feel" upgrade. Thumb-reachable, fixed to the
 * bottom edge with home-indicator safe-area padding. The hamburger drawer still
 * owns the full/contextual nav (org switching, settings sub-pages, account).
 */
export function BottomTabs() {
  const params = useParams<{ orgSlug?: string }>();
  const pathname = usePathname();
  const orgSlug = params?.orgSlug ?? null;

  const tabs: Tab[] = orgSlug
    ? [
        // The board leads on mobile for the same reason it leads in the
        // sidebar: it is the answer the seller opened the app for.
        { href: `/orgs/${orgSlug}/exposure`, label: "Exposure", icon: Map },
        { href: `/orgs/${orgSlug}/ledger`, label: "Ledger", icon: Receipt },
        { href: `/orgs/${orgSlug}/channels`, label: "Channels", icon: Plug },
        { href: `/orgs/${orgSlug}/settings`, label: "Settings", icon: Settings },
      ]
    : [
        { href: "/orgs", label: "Organizations", icon: Building2 },
        { href: "/account", label: "Account", icon: User2 },
      ];

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/90 backdrop-blur-md pb-safe md:hidden"
    >
      <div className="flex items-stretch">
        {tabs.map((tab) => {
          const active = isLinkActive(tab.href, pathname);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors active:bg-accent/60",
                active ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className={cn("h-5 w-5", active && "stroke-[2.25]")} />
              <span className="truncate">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
